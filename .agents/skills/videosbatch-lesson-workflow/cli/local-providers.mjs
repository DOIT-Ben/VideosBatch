import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const STAGE_RANGES = {
  COURSE_INTRO_CANDIDATES: ["## 1 第一步：根据教案生成三类九套课程导入", "## 2    第二步："],
  STORY_SCRIPT: ["## 2    第二步：根据唯一选定的课程导入完善故事文稿", "## 3 第三步："],
  ASSET_PLAN: ["### 3.1 生成资产计划与图片提示词", "### 3.2 图片候选与资产确认门禁"],
  SCREENPLAY: ["### 3.3 根据故事文稿和已确认资产生成正式视频剧本", "## 4 第四步："],
  FINAL_STORYBOARD: ["## 4 第四步：根据正式视频剧本生成固定十秒最终分镜", "## 5 第五步："],
  COPYABLE_PROMPT: ["## 5 第五步：为最终分镜生成垫图可复制提示词", "## 6 Canonical Transport Schemas"]
};

export async function generateLocalTextStage(stageId, { artifacts, canonicalPath, env = process.env, runId }) {
  const config = resolveTextConfig(env);
  const systemPrompt = await canonicalPrompt(canonicalPath, stageId);
  const userPrompt = buildUserPrompt(stageId, artifacts);
  const schema = stageSchema(stageId);
  const candidates = [{ model: config.model, baseUrl: config.baseUrl, apiKey: config.apiKey }, ...config.fallbackModels.map((model) => ({ model, baseUrl: config.fallbackBaseUrl || config.baseUrl, apiKey: config.fallbackApiKey }))];
  const maxAttempts = Math.min(3, Math.max(1, config.maxAttempts));
  const records = [];
  let attempt = 0;
  let lastError;
  for (const candidate of candidates) {
    if (!candidate.apiKey) continue;
    for (let localAttempt = 0; localAttempt < maxAttempts && attempt < maxAttempts; localAttempt += 1) {
      attempt += 1;
      const idempotencyKey = `videosbatch-local-${runId}-${stageId}-${createHash("sha256").update(`${systemPrompt}\0${userPrompt}`).digest("hex").slice(0, 16)}`;
      const startedAt = Date.now();
      try {
        const response = await fetch(`${candidate.baseUrl.replace(/\/+$/u, "")}/responses`, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${candidate.apiKey}`, "Idempotency-Key": idempotencyKey },
          body: JSON.stringify({ model: candidate.model, input: [{ role: "system", content: [{ type: "input_text", text: systemPrompt }] }, { role: "user", content: [{ type: "input_text", text: userPrompt }] }], text: { format: { type: "json_schema", name: `videosbatch_local_${stageId.toLowerCase()}`, strict: true, schema } } }),
          signal: AbortSignal.timeout(config.timeoutMs)
        });
        const raw = await response.text();
        if (!response.ok) throw providerError(`HTTP_${response.status}`, response.status >= 500 || response.status === 408 || response.status === 429, raw);
        const payload = raw ? JSON.parse(raw) : {};
        const text = String(payload.output_text || payload.output?.flatMap((item) => item.content || []).map((item) => item.text || item.output_text || "").join("\n") || "").trim();
        if (!text) throw providerError("EMPTY_STRUCTURED_OUTPUT", true, "Provider 未返回结构化文本");
        const artifact = JSON.parse(stripCodeFence(text));
        records.push({ attempt, model: candidate.model, outcome: "success", durationMs: Date.now() - startedAt });
        return { artifact, attempts: attempt, attemptLog: records };
      } catch (error) {
        lastError = error;
        records.push({ attempt, model: candidate.model, outcome: "error", errorCode: error.code || "PROVIDER_ERROR", durationMs: Date.now() - startedAt });
        if (error.retryable !== true || attempt >= maxAttempts) break;
      }
    }
  }
  const error = lastError || providerError("PROVIDER_NOT_CONFIGURED", false, "未配置本地文本 Provider");
  error.attempts = attempt;
  error.attemptLog = records;
  throw error;
}

export async function generateLocalImage({ prompt, outPath, env = process.env }) {
  const apiKey = String(env.VIDEOSBATCH_IMAGE_API_KEY || "").trim();
  if (!apiKey) throw providerError("IMAGE_PROVIDER_NOT_CONFIGURED", false, "缺少 VIDEOSBATCH_IMAGE_API_KEY");
  const baseUrl = String(env.VIDEOSBATCH_IMAGE_BASE_URL || "https://api.lyaiapp.com/v1").trim().replace(/\/+$/u, "");
  const response = await fetch(`${baseUrl}/images/generations`, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model: String(env.VIDEOSBATCH_IMAGE_MODEL || "gpt-image-2-1k"), prompt: String(prompt || "").trim(), size: String(env.VIDEOSBATCH_IMAGE_SIZE || "16:9") }), signal: AbortSignal.timeout(numberEnv(env.VIDEOSBATCH_IMAGE_TIMEOUT_MS, 180000)) });
  const raw = await response.text();
  if (!response.ok) throw providerError(`IMAGE_HTTP_${response.status}`, response.status >= 500 || response.status === 408 || response.status === 429, raw);
  const first = JSON.parse(raw || "{}").data?.[0];
  if (!first?.url && !first?.b64_json) throw providerError("IMAGE_EMPTY_OUTPUT", false, "图片 Provider 未返回 URL 或 base64");
  await mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  if (first.b64_json) await writeFile(path.resolve(outPath), Buffer.from(first.b64_json, "base64"));
  else {
    const imageResponse = await fetch(first.url, { headers: { Accept: "image/png,image/jpeg,image/webp" }, signal: AbortSignal.timeout(120000) });
    if (!imageResponse.ok) throw providerError(`IMAGE_DOWNLOAD_HTTP_${imageResponse.status}`, imageResponse.status >= 500, `图片结果下载失败：HTTP ${imageResponse.status}`);
    await writeFile(path.resolve(outPath), new Uint8Array(await imageResponse.arrayBuffer()));
  }
  return { path: path.resolve(outPath), provider: "lyaiapp", model: String(env.VIDEOSBATCH_IMAGE_MODEL || "gpt-image-2-1k") };
}

export async function generateLocalH3Video({ prompt, referencePaths = [], outPath, idempotencyKey, env = process.env }) {
  const apiKey = String(env.VIDEOSBATCH_H3_API_KEY || "").trim();
  if (!apiKey) throw providerError("VIDEO_PROVIDER_NOT_CONFIGURED", false, "缺少 VIDEOSBATCH_H3_API_KEY");
  const baseUrl = String(env.VIDEOSBATCH_H3_BASE_URL || "http://122.228.216.60:3000/v1").trim().replace(/\/+$/u, "");
  if (baseUrl.startsWith("http://") && String(env.VIDEOSBATCH_H3_ALLOW_HTTP || "") !== "1") throw providerError("VIDEO_HTTP_NOT_ALLOWED", false, "HTTP 视频端点需要 VIDEOSBATCH_H3_ALLOW_HTTP=1");
  const form = new FormData();
  form.append("prompt", String(prompt || "").trim());
  form.append("duration", "10");
  form.append("ratio", String(env.SEEDANCE_RATIO || "16:9"));
  for (let index = 0; index < referencePaths.length; index += 1) {
    const filePath = path.resolve(referencePaths[index]);
    const bytes = await readFile(filePath);
    form.append("images", new Blob([bytes], { type: imageMime(filePath) }), `reference-${index + 1}${path.extname(filePath) || ".png"}`);
  }
  const response = await fetch(`${baseUrl}/videos`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Idempotency-Key": idempotencyKey || `videosbatch-local-${randomUUID()}` }, body: form, signal: AbortSignal.timeout(numberEnv(env.VIDEOSBATCH_H3_TIMEOUT_MS, 2700000)) });
  const payload = await responseJson(response);
  const taskId = String(payload.task_id || payload.id || payload.data?.task_id || payload.data?.id || "").trim();
  if (!response.ok && response.status !== 409) throw providerError(`VIDEO_HTTP_${response.status}`, response.status >= 500 || response.status === 408 || response.status === 429, payloadMessage(payload));
  if (!taskId) throw providerError("VIDEO_SUBMISSION_STATE_UNKNOWN", false, "视频提交响应没有任务号，停止重复提交");
  const pollMs = numberEnv(env.VIDEOSBATCH_H3_POLL_MS, 5000);
  const deadline = Date.now() + numberEnv(env.VIDEOSBATCH_H3_TIMEOUT_MS, 2700000);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const contentResponse = await fetch(`${baseUrl}/videos/${encodeURIComponent(taskId)}/content`, { headers: { Authorization: `Bearer ${apiKey}`, Accept: "video/mp4, application/json" }, signal: AbortSignal.timeout(Math.min(pollMs * 4, 120000)) });
    const contentType = (contentResponse.headers.get("content-type") || "").toLowerCase();
    if (contentResponse.ok && contentType.startsWith("video/mp4")) {
      const bytes = new Uint8Array(await contentResponse.arrayBuffer());
      if (!bytes.length) throw providerError("VIDEO_EMPTY_OUTPUT", false, "视频 Provider 返回空内容");
      await mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
      await writeFile(path.resolve(outPath), bytes);
      return { path: path.resolve(outPath), taskId, durationSec: 10 };
    }
    if ([202, 404].includes(contentResponse.status)) continue;
    const body = await responseJson(contentResponse);
    if (contentResponse.status === 400 || contentResponse.status === 409) {
      const message = payloadMessage(body);
      if (/IN_PROGRESS|not completed|处理中|processing/iu.test(message)) continue;
      throw providerError("VIDEO_TASK_FAILED", false, message);
    }
    if (contentResponse.status >= 500) continue;
    throw providerError(`VIDEO_POLL_HTTP_${contentResponse.status}`, false, payloadMessage(body));
  }
  throw providerError("VIDEO_POLL_TIMEOUT", true, "视频 Provider 轮询超时");
}

function resolveTextConfig(env) {
  const apiKey = String(env.VIDEOSBATCH_LLM_API_KEY || "").trim();
  const model = String(env.VIDEOSBATCH_LLM_MODEL || "gpt-5.6-terra").trim();
  const fallbackModels = String(env.VIDEOSBATCH_LLM_FALLBACK_MODELS || "deepseek-v4-flash").split(",").map((value) => value.trim()).filter(Boolean);
  return { apiKey, model, baseUrl: String(env.VIDEOSBATCH_LLM_BASE_URL || "https://api.openai.com/v1").trim(), fallbackModels, fallbackApiKey: String(env.VIDEOSBATCH_LLM_FALLBACK_API_KEY || "").trim(), fallbackBaseUrl: String(env.VIDEOSBATCH_LLM_FALLBACK_BASE_URL || "").trim(), maxAttempts: Math.min(3, Math.max(1, Number(env.VIDEOSBATCH_LLM_MAX_RETRIES || 3))), timeoutMs: numberEnv(env.VIDEOSBATCH_LLM_TIMEOUT_MS, 180000) };
}

async function canonicalPrompt(file, stageId) {
  const text = await readFile(file, "utf8");
  const range = STAGE_RANGES[stageId];
  if (!range) return text.slice(0, 12000);
  const start = text.indexOf(range[0]);
  const end = text.indexOf(range[1], start + range[0].length);
  if (start < 0 || end < 0) throw providerError("CANONICAL_PROMPT_SECTION_MISSING", false, `canonical spec 缺少 ${stageId} 提示词段`);
  return text.slice(start, end).slice(0, 48000);
}

function buildUserPrompt(stageId, artifacts) {
  const labels = { COURSE_INTRO_CANDIDATES: "教案内容", STORY_SCRIPT: "教案与唯一锁定导入", ASSET_PLAN: "已锁定故事文稿", SCREENPLAY: "唯一故事与已确认资产", FINAL_STORYBOARD: "正式视频剧本与已确认资产语义清单", COPYABLE_PROMPT: "正式分镜与已确认资产稳定 ID" };
  return `【${labels[stageId] || stageId}】\n${JSON.stringify(artifacts, null, 2)}\n\n只能生成当前阶段的结构化结果，不得跳阶段。`;
}

function stageSchema(stageId) {
  const schemas = {
    COURSE_INTRO_CANDIDATES: { type: "object", properties: { candidates: { type: "array", items: { type: "object", additionalProperties: true } }, recommendations: { type: "array", items: { type: "object", additionalProperties: true } } }, required: ["candidates", "recommendations"], additionalProperties: false },
    STORY_SCRIPT: { type: "object", properties: { schemaVersion: { type: "string" }, kind: { type: "string" }, title: { type: "string" }, storyType: { type: "string" }, truthfulnessNote: { type: "string" }, content: { type: "string" } }, required: ["schemaVersion", "kind", "title", "storyType", "truthfulnessNote", "content"], additionalProperties: false },
    ASSET_PLAN: { type: "object", properties: { schemaVersion: { type: "string" }, title: { type: "string" }, kind: { type: "string" }, subject: { type: "string" }, gradeBand: { type: "string" }, candidateAssets: { type: "array" }, candidateInventory: { type: "array" }, omissionCheck: { type: "string" }, styleSpec: { type: "string" }, negativePrompt: { type: "string" }, items: { type: "array" } }, required: ["schemaVersion", "title", "kind", "subject", "gradeBand", "candidateAssets", "candidateInventory", "omissionCheck", "styleSpec", "negativePrompt", "items"], additionalProperties: false },
    SCREENPLAY: { type: "object", properties: { schemaVersion: { type: "string" }, kind: { type: "string" }, title: { type: "string" }, subject: { type: "string" }, gradeBand: { type: "string" }, storyType: { type: "string" }, targetDurationSeconds: { type: "integer" }, scenes: { type: "array" } }, required: ["schemaVersion", "kind", "title", "subject", "gradeBand", "storyType", "targetDurationSeconds", "scenes"], additionalProperties: false },
    FINAL_STORYBOARD: { type: "object", properties: { schemaVersion: { type: "string" }, title: { type: "string" }, kind: { type: "string" }, targetDuration: { type: "integer" }, storyType: { type: "string" }, segments: { type: "array" } }, required: ["schemaVersion", "title", "kind", "targetDuration", "storyType", "segments"], additionalProperties: false },
    COPYABLE_PROMPT: { type: "object", properties: { schemaVersion: { type: "string" }, fullText: { type: "string" }, status: { type: "string" }, failedSegments: { type: "array" }, segments: { type: "array" } }, required: ["schemaVersion", "fullText", "status", "failedSegments", "segments"], additionalProperties: false }
  };
  return schemas[stageId] || { type: "object", additionalProperties: true };
}

function providerError(code, retryable, detail) { const error = new Error(String(detail || code).slice(0, 1000)); error.code = code; error.retryable = retryable; return error; }
function stripCodeFence(value) { return value.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim(); }
function numberEnv(value, fallback) { const number = Number(value); return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback; }
function imageMime(file) { const ext = path.extname(file).toLowerCase(); return ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png"; }
async function responseJson(response) { const text = await response.text().catch(() => ""); try { return text ? JSON.parse(text) : {}; } catch { return { message: text.slice(0, 300) }; } }
function payloadMessage(payload) { return String(payload?.error?.message || payload?.detail?.message || payload?.detail || payload?.message || JSON.stringify(payload)).slice(0, 1000); }
