import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Asset, Shot } from "../../shared/types";
import type { VideosBatchReferenceBinding } from "../../shared/videosBatchNativeProjection";

const H3_MODEL = "minimax_h3";
const MAX_REFERENCE_IMAGES = 9;
const MIN_REFERENCE_IMAGES = 2;
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const STABLE_PUBLIC_ASSET_ID_PATTERN = /\bP\d{3,}-A\d{3,}\b/u;
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
  /** Called after the exact reference URLs are resolved, before the paid POST. */
  onReferenceBindingsPrepared?(bindings: VideosBatchReferenceBinding[]): Promise<void> | void;
  /** Called with the exact H3 prompt text, before the paid POST. */
  onPromptPrepared?(prompt: string): Promise<void> | void;
}

type H3ReferenceEntry = {
  asset: Asset;
  binding: VideosBatchReferenceBinding;
  candidates: string[];
  file?: File;
  submittedUrl?: string;
};

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
  /** Known provider task id, retained so a poll timeout can be resumed safely. */
  readonly taskId?: string;

  constructor(message: string, code: string, retryable: boolean, status?: number, taskId?: string) {
    super(message);
    this.name = "NewApiH3ProviderError";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
    this.taskId = taskId?.trim() || undefined;
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

function assetKeyFor(asset: Asset, binding?: Partial<VideosBatchReferenceBinding>) {
  return String(
    binding?.assetKey
      || (asset as Asset & { videosBatchAssetKey?: unknown }).videosBatchAssetKey
      || asset.workflowReferenceId
      || asset.name
      || asset.id
  ).trim();
}

function safeSemanticLabel(value: unknown, fallback: string) {
  const cleaned = String(value ?? "")
    .replace(/^\s*【[^：:]+[：:]\s*/u, "")
    .replace(/】\s*$/u, "")
    .replace(/\bP\d{3,}-A\d{3,}\b/gu, "")
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 160);
  const safeFallback = String(fallback)
    .replace(/\bP\d{3,}-A\d{3,}\b/gu, "")
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 160);
  return cleaned || safeFallback || "参考图";
}

function referenceIdFor(asset: Asset, index: number, binding?: Partial<VideosBatchReferenceBinding>) {
  return String(binding?.referenceId || assetKeyFor(asset, binding) || `reference-${index + 1}`).trim();
}

/**
 * Build the one ordered list shared by prompt compilation, file resolution and
 * the audit snapshot. Existing snapshots take precedence over caller array
 * order so a retry cannot silently follow the mutable global asset table.
 */
export function buildNewApiH3ReferencePlan(shot: Shot, assets: Asset[]): H3ReferenceEntry[] {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const snapshot = Array.isArray(shot.videosBatchReferenceBindings)
    ? [...shot.videosBatchReferenceBindings].sort((left, right) => left.ordinal - right.ordinal)
    : [];
  const entries: H3ReferenceEntry[] = [];

  if (snapshot.length) {
    const declaredAssetIds = new Set(shot.assetIds || []);
    const seenOrdinals = new Set<number>();
    const seenAssetIds = new Set<string>();
    for (const [index, binding] of snapshot.entries()) {
      const expectedOrdinal = index + 1;
      if (binding.ordinal !== expectedOrdinal || seenOrdinals.has(binding.ordinal)) {
        throw new Error("VideosBatch H3 参考图 ordinal 必须从 1 连续编号");
      }
      if (seenAssetIds.has(binding.assetId)) throw new Error("VideosBatch H3 参考图不能重复绑定同一资产");
      if (declaredAssetIds.size && !declaredAssetIds.has(binding.assetId)) {
        throw new Error(`VideosBatch H3 绑定资产不在 Shot.assetIds 声明中：${binding.assetId}`);
      }
      const asset = byId.get(binding.assetId);
      if (!asset) throw new Error(`VideosBatch H3 绑定资产不可读取：${binding.assetId}`);
      seenOrdinals.add(binding.ordinal);
      seenAssetIds.add(binding.assetId);
      entries.push({
        asset,
        binding: {
          ...binding,
          referenceId: referenceIdFor(asset, index, binding),
          assetKey: assetKeyFor(asset, binding),
          semanticLabel: safeSemanticLabel(binding.semanticLabel, asset.name || `参考图 ${expectedOrdinal}`)
        },
        candidates: referenceCandidates(asset)
      });
    }
  } else {
    for (const [index, asset] of assets.entries()) {
      const ordinal = index + 1;
      entries.push({
        asset,
        binding: {
          referenceId: referenceIdFor(asset, index),
          ordinal,
          assetKey: assetKeyFor(asset),
          assetId: asset.id,
          semanticLabel: safeSemanticLabel(asset.name, `参考图 ${ordinal}`)
        },
        candidates: referenceCandidates(asset)
      });
    }
  }

  if (entries.length > MAX_REFERENCE_IMAGES) {
    throw new Error(`NewAPI H3 最多支持 ${MAX_REFERENCE_IMAGES} 张参考图，当前绑定 ${entries.length} 张`);
  }
  if (entries.length < MIN_REFERENCE_IMAGES) {
    throw new Error(`NewAPI H3 多参考图模式需要 2-${MAX_REFERENCE_IMAGES} 张参考图，当前只有 ${entries.length} 张`);
  }
  if (entries.some((entry) => entry.candidates.length === 0)) {
    const missing = entries.findIndex((entry) => entry.candidates.length === 0) + 1;
    throw new Error(`NewAPI H3 第 ${missing} 张绑定参考图没有可用的 HTTPS 或本地图片 URL`);
  }
  return entries;
}

export function compileNewApiH3Prompt(basePrompt: string, bindings: readonly VideosBatchReferenceBinding[]) {
  const body = basePrompt.trim();
  if (STABLE_PUBLIC_ASSET_ID_PATTERN.test(body)) {
    throw new Error("NewAPI H3 prompt 不得包含稳定公开资产编号，请使用语义资产名称");
  }
  const lines = bindings.map((binding) => `Image ${binding.ordinal} = ${safeSemanticLabel(binding.semanticLabel, `参考图 ${binding.ordinal}`)}`);
  const mapping = [
    "Reference image bindings (strict):",
    ...lines,
    "Strictly follow the Image N mapping above. Do not swap characters, scenes, props, or any reference images.",
    "严格按 Image N 对应图片，不得交换人物、场景和道具。"
  ].join("\n");
  return [body, mapping].filter(Boolean).join("\n\n").trim();
}

function imageUrlHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function auditBindings(entries: readonly H3ReferenceEntry[]) {
  return entries.map((entry) => ({
    ordinal: entry.binding.ordinal,
    assetKey: entry.binding.assetKey,
    assetId: entry.binding.assetId,
    imageUrlHash: imageUrlHash(entry.submittedUrl || entry.candidates[0] || "")
  }));
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
      const references = buildNewApiH3ReferencePlan(shot, assets);
      for (const [index, reference] of references.entries()) {
        let file: File | undefined;
        let submittedUrl = "";
        let lastError: unknown;
        for (const candidate of reference.candidates) {
          try {
            file = await imageFile(candidate, index + 1, controller.signal);
            submittedUrl = candidate;
            break;
          } catch (error) {
            lastError = error;
          }
        }
        if (!file) throw lastError instanceof Error ? lastError : new Error(`NewAPI H3 第 ${index + 1} 张参考图不可读取`);
        const submittedHash = imageUrlHash(submittedUrl);
        if (reference.binding.imageUrlHash && reference.binding.imageUrlHash !== submittedHash) {
          throw new Error(`NewAPI H3 第 ${index + 1} 张参考图与已保存快照不一致，请重新确认资产后再试`);
        }
        reference.file = file;
        reference.submittedUrl = submittedUrl;
      }
      const preparedBindings = references.map((reference) => ({
        ...reference.binding,
        imageUrlHash: imageUrlHash(reference.submittedUrl || reference.candidates[0] || "")
      }));
      await options.onReferenceBindingsPrepared?.(preparedBindings);
      console.info(`[videosbatch-h3] reference bindings ${JSON.stringify(auditBindings(references))}`);
      const compiledPrompt = compileNewApiH3Prompt(shot.rawPrompt || shot.prompt || "", preparedBindings);
      await options.onPromptPrepared?.(compiledPrompt);
      const form = new FormData();
      form.set("model", H3_MODEL);
      form.set("prompt", compiledPrompt);
      form.set("seconds", String(Math.min(15, Math.max(4, Math.round(shot.durationSec || 10)))));
      form.set("workflow_id", "multi-reference");
      form.set("size", size);
      form.set("prompt_enhance", "false");
      for (const reference of references) {
        if (!reference.file) throw new Error(`NewAPI H3 第 ${reference.binding.ordinal} 张参考图未准备完成`);
        form.append("images", reference.file, reference.file.name);
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
        if (controller.signal.aborted) throw new NewApiH3ProviderError("NewAPI H3 视频生成超时", "H3_POLL_TIMEOUT", true, undefined, taskId);
        throw new NewApiH3ProviderError(
          `NewAPI H3 查询失败：${error instanceof Error ? error.message : String(error)}`,
          "H3_POLL_FAILED",
          true,
          undefined,
          taskId
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
        throw new NewApiH3ProviderError(`NewAPI H3 任务失败：${message}`, "H3_TASK_FAILED", false, contentResponse.status, taskId);
      }
      if (contentResponse.status === 202 || contentResponse.status === 404) continue;
      throw new NewApiH3ProviderError(`NewAPI H3 查询失败：HTTP ${contentResponse.status}`, "H3_POLL_FAILED", contentResponse.status >= 500, contentResponse.status, taskId);
    }
    throw new NewApiH3ProviderError("NewAPI H3 视频生成超时", "H3_POLL_TIMEOUT", true, undefined, taskId);
  } finally {
    clearTimeout(timer);
  }
}
