import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Asset, Shot } from "../../shared/types";

const H3_MODEL = "minimax_h3";
const MAX_REFERENCE_IMAGES = 9;
const MIN_REFERENCE_IMAGES = 2;
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const SIZE_BY_RATIO: Record<string, string> = {
  "16:9": "1376x768",
  "9:16": "768x1376",
  "1:1": "1024x1024",
  "2:3": "832x1248",
  "3:2": "1248x832",
  "3:4": "896x1184",
  "4:3": "1184x896",
  "21:9": "1568x672"
};

export interface NewApiH3GenerationOptions {
  taskId?: string | null;
  idempotencyKey?: string;
  onTaskSubmitted?(taskId: string): Promise<void> | void;
}

export class NewApiH3SubmissionStateUnknownError extends Error {
  readonly code = "H3_SUBMISSION_STATE_UNKNOWN";
  readonly retryable = false;
  /** Present when the provider accepted a task but the local checkpoint failed. */
  readonly taskId?: string;

  constructor(message: string, taskId?: string) {
    super(message);
    this.name = "NewApiH3SubmissionStateUnknownError";
    this.taskId = taskId?.trim() || undefined;
  }
}

export class NewApiH3ProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, code: string, retryable: boolean, status?: number) {
    super(message);
    this.name = "NewApiH3ProviderError";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

function config() {
  const apiKey = process.env.VIDEOSBATCH_H3_API_KEY?.trim();
  const baseUrl = (process.env.VIDEOSBATCH_H3_BASE_URL?.trim() || "http://122.228.216.60:3000/v1").replace(/\/+$/, "");
  if (!apiKey) throw new Error("NewAPI H3 视频需要配置 VIDEOSBATCH_H3_API_KEY");
  if (new URL(baseUrl).protocol !== "https:" && process.env.VIDEOSBATCH_H3_ALLOW_HTTP !== "1") {
    throw new Error("NewAPI H3 使用 HTTP 地址时必须显式设置 VIDEOSBATCH_H3_ALLOW_HTTP=1");
  }
  return { apiKey, baseUrl };
}

function referenceCandidates(asset: Asset) {
  const candidates = [asset.sourceImageUrl, asset.referenceImageUrl, asset.imageUrl, asset.mediaUrl];
  return candidates
    .filter((value): value is string => typeof value === "string" && (/^https:\/\//i.test(value) || value.startsWith("/media/")))
    .map((value) => value.trim())
    .filter((value, index, values) => values.indexOf(value) === index);
}

async function imageFile(url: string, index: number, signal: AbortSignal) {
  if (url.startsWith("/media/")) {
    const mediaRoot = path.resolve(process.cwd(), "data", "media");
    const relative = decodeURIComponent(url.slice("/media/".length));
    const localPath = path.resolve(mediaRoot, relative);
    if (!relative || (localPath !== mediaRoot && !localPath.startsWith(`${mediaRoot}${path.sep}`))) {
      throw new Error("NewAPI H3 本地参考图路径不合法");
    }
    const extension = path.extname(localPath).toLowerCase();
    const contentType = extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : [".jpg", ".jpeg"].includes(extension) ? "image/jpeg" : "";
    if (!contentType) throw new Error("NewAPI H3 本地参考图必须是 PNG/JPEG/WebP");
    const bytes = new Uint8Array(await readFile(localPath));
    if (!bytes.length || bytes.length > MAX_REFERENCE_BYTES) throw new Error("NewAPI H3 参考图不能超过 20MB");
    return new File([bytes], `reference-${index}${extension}`, { type: contentType });
  }
  const response = await fetch(url, { signal, headers: { Accept: "image/png,image/jpeg,image/webp" } });
  if (!response.ok) throw new Error(`NewAPI H3 参考图读取失败（HTTP ${response.status}）`);
  const contentType = (response.headers.get("content-type") || "image/jpeg").split(";", 1)[0];
  if (!/^image\/(png|jpeg|jpg|webp)$/i.test(contentType)) throw new Error("NewAPI H3 参考图必须是 PNG/JPEG/WebP");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_REFERENCE_BYTES) throw new Error("NewAPI H3 参考图不能超过 20MB");
  const extension = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
  return new File([bytes], `reference-${index}.${extension}`, { type: contentType });
}

async function responseMessage(response: Response) {
  const text = await response.text().catch(() => "");
  try {
    const payload = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown };
    const message = payload.error?.message ?? payload.message;
    return typeof message === "string" ? message : text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

async function responsePayload(response: Response) {
  const text = await response.text().catch(() => "");
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    return { message: text.slice(0, 300) };
  }
}

function payloadMessage(payload: Record<string, any>) {
  const message = payload.error?.message ?? payload.detail?.message ?? payload.detail ?? payload.message;
  return typeof message === "string" ? message : JSON.stringify(payload).slice(0, 300);
}

function payloadTaskId(payload: Record<string, any>) {
  return String(payload.task_id || payload.id || payload.data?.task_id || payload.data?.id || "").trim();
}

function idempotencyKeyForShot(shot: Shot) {
  const attempt = shot.generationStartedAt || "initial";
  const digest = createHash("sha256").update(`${shot.id}\0${attempt}`).digest("hex").slice(0, 24);
  return `videosbatch-${shot.id}-${digest}`;
}

export async function generateShotVideoViaNewApiH3(
  shot: Shot,
  assets: Asset[],
  options: NewApiH3GenerationOptions = {}
) {
  const { apiKey, baseUrl } = config();
  const ratio = process.env.SEEDANCE_RATIO?.trim() || "16:9";
  const size = SIZE_BY_RATIO[ratio];
  if (!size) throw new Error(`NewAPI H3 不支持画面比例：${ratio}`);
  const controller = new AbortController();
  const timeoutMs = Number(process.env.VIDEOSBATCH_H3_TIMEOUT_MS || 2_700_000);
  const timer = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 2_700_000);
  try {
    let taskId = String(options.taskId || "").trim();
    if (!taskId) {
      const referenceSets = assets.map(referenceCandidates).filter((candidates) => candidates.length).slice(0, MAX_REFERENCE_IMAGES);
      if (referenceSets.length < MIN_REFERENCE_IMAGES) {
        throw new Error(`NewAPI H3 多参考图模式需要 2-${MAX_REFERENCE_IMAGES} 张参考图，当前只有 ${referenceSets.length} 张`);
      }
      const form = new FormData();
      form.set("model", H3_MODEL);
      form.set("prompt", (shot.rawPrompt || shot.prompt || "").trim());
      form.set("seconds", String(Math.min(15, Math.max(4, Math.round(shot.durationSec || 10)))));
      form.set("workflow_id", "multi-reference");
      form.set("size", size);
      form.set("prompt_enhance", "false");
      for (const [index, candidates] of referenceSets.entries()) {
        let file: File | undefined;
        let lastError: unknown;
        for (const candidate of candidates) {
          try {
            file = await imageFile(candidate, index + 1, controller.signal);
            break;
          } catch (error) {
            lastError = error;
          }
        }
        if (!file) throw lastError instanceof Error ? lastError : new Error(`NewAPI H3 第 ${index + 1} 张参考图不可读取`);
        form.append("images", file);
      }

      let createResponse: Response;
      try {
        createResponse = await fetch(`${baseUrl}/videos`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Idempotency-Key": options.idempotencyKey?.trim() || idempotencyKeyForShot(shot)
          },
          body: form,
          signal: controller.signal
        });
      } catch (error) {
        // A POST that timed out or lost its connection may have been accepted upstream.
        // Without a task id it is unsafe to submit the same paid request again.
        throw new NewApiH3SubmissionStateUnknownError(
          `NewAPI H3 提交状态未知：${error instanceof Error ? error.message : String(error)}。为避免重复计费，已停止自动重提。`
        );
      }
      const created = await responsePayload(createResponse);
      const returnedTaskId = payloadTaskId(created);
      if (!createResponse.ok && createResponse.status !== 409) {
        throw new NewApiH3ProviderError(
          `NewAPI H3 提交失败：${payloadMessage(created)}`,
          "H3_SUBMISSION_REJECTED",
          createResponse.status >= 500,
          createResponse.status
        );
      }
      if (!returnedTaskId) {
        if (createResponse.status === 409) {
          throw new NewApiH3SubmissionStateUnknownError(
            `NewAPI H3 幂等冲突且响应未返回原任务号：${payloadMessage(created)}。为避免重复计费，已停止自动重提。`
          );
        }
        throw new NewApiH3SubmissionStateUnknownError("NewAPI H3 提交响应缺少任务号；上游是否已创建任务无法确认，已停止自动重提");
      }
      taskId = returnedTaskId;
      try {
        await options.onTaskSubmitted?.(taskId);
      } catch (error) {
        // The paid task is already accepted. Preserve its id on the error so
        // the caller can checkpoint and resume polling without a second POST.
        throw new NewApiH3SubmissionStateUnknownError(
          `NewAPI H3 已受理任务 ${taskId}，但本地任务号保存失败：${error instanceof Error ? error.message : String(error)}。已停止自动重提，请使用该任务号继续查询。`,
          taskId
        );
      }
    }

    const pollMs = Number(process.env.VIDEOSBATCH_H3_POLL_MS || 5000);
    while (!controller.signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 5000));
      let contentResponse: Response;
      try {
        contentResponse = await fetch(`${baseUrl}/videos/${encodeURIComponent(taskId)}/content`, {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: "video/mp4, application/json" },
          signal: controller.signal
        });
      } catch (error) {
        if (controller.signal.aborted) throw new NewApiH3ProviderError("NewAPI H3 视频生成超时", "H3_POLL_TIMEOUT", true);
        throw new NewApiH3ProviderError(
          `NewAPI H3 查询失败：${error instanceof Error ? error.message : String(error)}`,
          "H3_POLL_FAILED",
          true
        );
      }
      const contentType = (contentResponse.headers.get("content-type") || "").toLowerCase();
      if (contentResponse.ok && contentType.startsWith("video/mp4")) {
        const bytes = new Uint8Array(await contentResponse.arrayBuffer());
        if (!bytes.length) throw new Error("NewAPI H3 返回了空视频");
        const mediaDir = path.resolve(process.cwd(), "data", "media");
        await mkdir(mediaDir, { recursive: true });
        const filename = `videosbatch-h3-${shot.id}-${Date.now()}.mp4`;
        await writeFile(path.join(mediaDir, filename), bytes, { mode: 0o600 });
        return `/media/${filename}`;
      }
      if (contentResponse.status === 400 || contentResponse.status === 409) {
        const message = await responseMessage(contentResponse);
        if (/IN_PROGRESS|not completed|处理中|processing/i.test(message)) continue;
        throw new NewApiH3ProviderError(`NewAPI H3 任务失败：${message}`, "H3_TASK_FAILED", false, contentResponse.status);
      }
      if (contentResponse.status === 202 || contentResponse.status === 404) continue;
      throw new NewApiH3ProviderError(`NewAPI H3 查询失败：HTTP ${contentResponse.status}`, "H3_POLL_FAILED", contentResponse.status >= 500, contentResponse.status);
    }
    throw new NewApiH3ProviderError("NewAPI H3 视频生成超时", "H3_POLL_TIMEOUT", true);
  } finally {
    clearTimeout(timer);
  }
}
