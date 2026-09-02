import { createHash } from "node:crypto";

export type VideosBatchLlmProvider = "openai-responses";
/** @deprecated VideosBatch requests are always sent as json_schema. */
export type VideosBatchLlmOutputMode = "json_schema" | "json_object";

export type JsonSchema = Record<string, unknown>;

export interface VideosBatchProviderAttempt {
  attempt: number;
  provider: VideosBatchLlmProvider;
  model: string;
  idempotencyKey?: string;
  outcome: "success" | "error";
  errorCode?: string;
  status?: number;
  durationMs?: number;
  /** Non-secret request diagnostics retained locally, never sent as body metadata. */
  metadata?: Record<string, string>;
}

/**
 * A mutable budget is created for one bounded submission class. Network
 * retries and provider switches in that class share the same ceiling. The
 * text-stage adapter may create a second, explicitly labelled budget for
 * contract repair; that budget is intentionally independent of the initial
 * provider-generation budget and is still bounded.
 */
export interface VideosBatchLlmAttemptBudget {
  maxAttempts: number;
  used: number;
  records: VideosBatchProviderAttempt[];
  primaryExhausted: boolean;
  fallbackStarted: boolean;
}

export function createVideosBatchLlmAttemptBudget(maxAttempts = 3): VideosBatchLlmAttemptBudget {
  const normalized = Number.isFinite(maxAttempts) ? Math.max(1, Math.floor(maxAttempts)) : 3;
  return {
    maxAttempts: normalized,
    used: 0,
    records: [],
    primaryExhausted: false,
    fallbackStarted: false
  };
}

export class VideosBatchLlmError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly attempt: number;
  readonly provider: VideosBatchLlmProvider | null;
  readonly model: string | null;
  readonly status?: number;
  /** Provider attempts consumed before this error was surfaced to the runner. */
  attempts?: number;
  attemptLog?: VideosBatchProviderAttempt[];

  constructor(input: {
    code: string;
    message: string;
    retryable: boolean;
    attempt?: number;
    provider?: VideosBatchLlmProvider | null;
    model?: string | null;
    status?: number;
  }) {
    super(input.message);
    this.name = "VideosBatchLlmError";
    this.code = input.code;
    this.retryable = input.retryable;
    this.attempt = input.attempt ?? 0;
    this.provider = input.provider ?? null;
    this.model = input.model ?? null;
    this.status = input.status;
  }
}

export interface StructuredGenerationRequest {
  operation: string;
  systemPrompt: string;
  userPrompt: string;
  schemaName: string;
  jsonSchema: JsonSchema;
  model?: string;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  outputMode?: VideosBatchLlmOutputMode;
  temperature?: number;
  /** Optional provider output cap; prevents unbounded structured generations. */
  maxOutputTokens?: number;
  /** Optional per-request timeout override, in milliseconds. */
  timeoutMs?: number;
  metadata?: Record<string, string>;
  providerRoute?: "auto" | "fallback-only";
  /** Budget for one bounded submission class. Omit only for a standalone call. */
  budget?: VideosBatchLlmAttemptBudget;
  /** Stable key reused for network retries of the same logical submission. */
  idempotencyKey?: string;
}

export interface StructuredGenerationUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  raw?: unknown;
}

export interface StructuredGenerationResult<T> {
  data: T;
  provider: VideosBatchLlmProvider;
  model: string;
  responseId?: string;
  rawText: string;
  usage?: StructuredGenerationUsage;
  attempt?: number;
  attempts?: number;
  attemptLog?: VideosBatchProviderAttempt[];
}

export interface VideosBatchLlmExecutor {
  generateStructured<T>(request: StructuredGenerationRequest): Promise<StructuredGenerationResult<T>>;
}

export interface VideosBatchLlmConfig {
  provider: VideosBatchLlmProvider;
  apiKey?: string;
  baseUrl: string;
  model: string;
  fallbackModels: string[];
  fallbackApiKey?: string;
  fallbackBaseUrl?: string;
  fallbackOutputMode?: VideosBatchLlmOutputMode;
  fallbackReasoningEffort?: StructuredGenerationRequest["reasoningEffort"];
  timeoutMs: number;
  maxRetries: number;
  retryDelaysMs: number[];
  outputMode: VideosBatchLlmOutputMode;
}

type EnvLike = Record<string, string | undefined>;

function clean(value: string | undefined) {
  return value?.trim() || undefined;
}

function normalizeBaseUrl(value: string | undefined) {
  return (clean(value) || "https://api.openai.com/v1").replace(/\/+$/, "");
}

const DEFAULT_RETRY_DELAYS_MS = [2_000, 5_000, 10_000];

function retryDelays(env: EnvLike) {
  const raw = clean(env.VIDEOSBATCH_LLM_RETRY_DELAYS_MS);
  if (!raw) return DEFAULT_RETRY_DELAYS_MS;
  const parsed = raw.split(",").map((value) => Number(value.trim())).filter((value) => Number.isFinite(value) && value >= 0);
  return parsed.length ? parsed.slice(0, 5) : DEFAULT_RETRY_DELAYS_MS;
}

function configuredModels(value: string | undefined) {
  return (value || "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean)
    .filter((model, index, models) => models.indexOf(model) === index);
}

export function resolveVideosBatchLlmConfig(env: EnvLike = process.env): VideosBatchLlmConfig {
  const providerRaw = clean(env.VIDEOSBATCH_LLM_PROVIDER)?.toLowerCase() || "openai-responses";
  if (providerRaw !== "openai-responses") {
    throw new Error(`Unsupported VIDEOSBATCH_LLM_PROVIDER: ${providerRaw}`);
  }

  const timeoutRaw = Number(clean(env.VIDEOSBATCH_LLM_TIMEOUT_MS) || 120_000);
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 120_000;
  const retryDelaysMs = retryDelays(env);
  const retryRaw = Number(clean(env.VIDEOSBATCH_LLM_MAX_RETRIES) || retryDelaysMs.length);
  // Three provider submissions is the hard per-operation ceiling.  The
  // executor may use at most two retries after the initial submission.
  const maxRetries = Number.isFinite(retryRaw) && retryRaw >= 0 ? Math.min(2, Math.floor(retryRaw)) : 2;
  const outputMode = clean(env.VIDEOSBATCH_LLM_OUTPUT_MODE)?.toLowerCase() || "json_schema";
  if (outputMode !== "json_schema") {
    throw new Error(`VideosBatch requires VIDEOSBATCH_LLM_OUTPUT_MODE=json_schema (received: ${outputMode})`);
  }

  const apiKey = clean(env.VIDEOSBATCH_LLM_API_KEY) || clean(env.OAI_KEY) || clean(env.OPENAI_API_KEY);
  const baseUrl = normalizeBaseUrl(env.VIDEOSBATCH_LLM_BASE_URL);
  const fallbackModels = configuredModels(env.VIDEOSBATCH_LLM_FALLBACK_MODELS);
  const configuredFallbackBaseUrl = clean(env.VIDEOSBATCH_LLM_FALLBACK_BASE_URL);
  const fallbackBaseUrl = normalizeBaseUrl(configuredFallbackBaseUrl || baseUrl);
  const fallbackApiKey = clean(env.VIDEOSBATCH_LLM_FALLBACK_API_KEY) || (fallbackBaseUrl === baseUrl ? apiKey : undefined);
  const fallbackOutputModeRaw = clean(env.VIDEOSBATCH_LLM_FALLBACK_OUTPUT_MODE)?.toLowerCase();
  if (fallbackOutputModeRaw && fallbackOutputModeRaw !== "json_schema") {
    throw new Error(`VideosBatch requires VIDEOSBATCH_LLM_FALLBACK_OUTPUT_MODE=json_schema (received: ${fallbackOutputModeRaw})`);
  }
  const fallbackReasoningEffortRaw = clean(env.VIDEOSBATCH_LLM_FALLBACK_REASONING)?.toLowerCase();
  const validReasoningEfforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
  if (fallbackReasoningEffortRaw && !validReasoningEfforts.has(fallbackReasoningEffortRaw)) {
    throw new Error(`VIDEOSBATCH_LLM_FALLBACK_REASONING is invalid (received: ${fallbackReasoningEffortRaw})`);
  }
  if (fallbackModels.length && fallbackBaseUrl !== baseUrl && !fallbackApiKey) {
    throw new Error("VIDEOSBATCH_LLM_FALLBACK_MODELS with a different base URL requires VIDEOSBATCH_LLM_FALLBACK_API_KEY.");
  }
  return {
    provider: "openai-responses",
    apiKey,
    baseUrl,
    model: clean(env.VIDEOSBATCH_LLM_MODEL) || clean(env.OPENAI_TEXT_MODEL) || "gpt-4.1-mini",
    fallbackModels,
    fallbackApiKey,
    fallbackBaseUrl,
    fallbackOutputMode: fallbackOutputModeRaw as VideosBatchLlmOutputMode | undefined,
    fallbackReasoningEffort: fallbackReasoningEffortRaw as StructuredGenerationRequest["reasoningEffort"] | undefined,
    timeoutMs,
    maxRetries,
    retryDelaysMs,
    outputMode: outputMode as VideosBatchLlmOutputMode
  };
}

function missingKeyError() {
  return new VideosBatchLlmError({
    code: "PROVIDER_NOT_CONFIGURED",
    message: "VideosBatch LLM is configured but no API key is available (VIDEOSBATCH_LLM_API_KEY/OPENAI_API_KEY).",
    retryable: false
  });
}

function providerScopedIdempotencyKey(baseKey: string | undefined, candidate: ProviderCandidate) {
  const normalized = baseKey?.trim();
  if (!normalized) return undefined;
  // Keep the caller's key for the primary route. A fallback model is a
  // different upstream submission and must not collide with the primary key;
  // retries on that same fallback reuse this derived value.
  if (!candidate.fallback) return normalized;
  const scope = createHash("sha256")
    .update(`${candidate.model}\0${candidate.baseUrl}`)
    .digest("hex")
    .slice(0, 16);
  return `${normalized}:fallback-${scope}`;
}

function extractOutputText(payload: any): string | undefined {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) return payload.output_text;
  if (!Array.isArray(payload?.output)) return undefined;

  const outputTextChunks: string[] = [];
  const genericTextChunks: string[] = [];
  for (const item of payload.output) {
    if (!Array.isArray(item?.content)) continue;
    for (const content of item.content) {
      if (typeof content?.text !== "string") continue;
      if (content.type === "output_text") outputTextChunks.push(content.text);
      else if (content.type !== "reasoning_text") genericTextChunks.push(content.text);
    }
  }
  const joined = (outputTextChunks.length ? outputTextChunks : genericTextChunks).join("").trim();
  return joined || undefined;
}

function escapeControlCharactersInJsonString(value: string) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (!inString) {
      output += character;
      if (character === '"') inString = true;
      continue;
    }
    if (escaped) {
      if (code < 0x20) {
        output += code === 0x0a ? "\\n" : code === 0x0d ? "\\r" : code === 0x09 ? "\\t" : `\\u${code.toString(16).padStart(4, "0")}`;
      } else {
        output += character;
      }
      escaped = false;
      continue;
    }
    if (character === "\\") {
      output += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      output += character;
      inString = false;
      continue;
    }
    if (code < 0x20) {
      output += code === 0x0a ? "\\n" : code === 0x0d ? "\\r" : code === 0x09 ? "\\t" : `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    output += character;
  }
  return output;
}

/** Parse provider JSON while tolerating one outer Markdown code fence only. */
function parseStructuredJson<T>(rawText: string): T {
  const trimmed = rawText.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  const candidate = (fenced ? fenced[1] : trimmed).trim();
  try {
    return JSON.parse(candidate) as T;
  } catch (firstError) {
    try {
      return JSON.parse(escapeControlCharactersInJsonString(candidate)) as T;
    } catch {
      throw firstError;
    }
  }
}

function parseUsage(rawUsage: any): StructuredGenerationUsage | undefined {
  if (!rawUsage || typeof rawUsage !== "object") return undefined;
  return {
    inputTokens: typeof rawUsage.input_tokens === "number" ? rawUsage.input_tokens : undefined,
    outputTokens: typeof rawUsage.output_tokens === "number" ? rawUsage.output_tokens : undefined,
    totalTokens: typeof rawUsage.total_tokens === "number" ? rawUsage.total_tokens : undefined,
    raw: rawUsage
  };
}

function isRetryableNetworkError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(error.message);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function normalizedTimeout(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function withAttemptEvidence(error: VideosBatchLlmError, budget: VideosBatchLlmAttemptBudget) {
  error.attempts = budget.used;
  error.attemptLog = [...budget.records];
  return error;
}

function retryableStatus(status: number) {
  // Include proxy/CDN timeout variants such as Cloudflare 524. These are
  // definitive pre-response transport failures and are safe to retry within
  // the shared bounded submission budget; client/auth errors remain terminal.
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

function safeProviderDetail(value: string) {
  return value
    .replace(/Bearer\s+[^\s]+/giu, "Bearer [redacted]")
    .replace(/(?:api[_-]?key|token|secret)\s*[:=]\s*[^,\s}]+/giu, "$1=[redacted]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 240);
}

function safeAttemptMetadata(metadata: Record<string, string> | undefined) {
  if (!metadata) return undefined;
  const entries = Object.entries(metadata)
    .filter(([key]) => key !== "session_id")
    .filter(([, value]) => typeof value === "string" && value.length <= 120);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function errorCode(error: unknown) {
  return error instanceof VideosBatchLlmError ? error.code : "PROVIDER_ERROR";
}

function normalizeError(error: unknown, operation: string, model: string, attempt: number): VideosBatchLlmError {
  if (error instanceof VideosBatchLlmError) {
    return new VideosBatchLlmError({
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      attempt: error.attempt || attempt,
      provider: error.provider,
      model: error.model || model,
      status: error.status
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new VideosBatchLlmError({
    code: "PROVIDER_ERROR",
    message: `VideosBatch ${operation} provider request failed on ${model}.`,
    retryable: isRetryableNetworkError(error),
    attempt,
    provider: "openai-responses",
    model
  });
}

type ProviderCandidate = {
  model: string;
  apiKey?: string;
  baseUrl: string;
  fallback: boolean;
  reasoningEffort?: StructuredGenerationRequest["reasoningEffort"];
};

class OpenAIResponsesLlmExecutor implements VideosBatchLlmExecutor {
  constructor(private readonly config: VideosBatchLlmConfig) {}

  async generateStructured<T>(request: StructuredGenerationRequest): Promise<StructuredGenerationResult<T>> {
    const configuredOutputMode = this.config.outputMode || "json_schema";
    if (configuredOutputMode !== "json_schema" || (request.outputMode && request.outputMode !== "json_schema")) {
      throw new VideosBatchLlmError({
        code: "SCHEMA_MODE_UNSUPPORTED",
        message: "VideosBatch structured requests require json_schema output.",
        retryable: false
      });
    }

    const budget = request.budget || createVideosBatchLlmAttemptBudget(3);
    if (budget.used >= budget.maxAttempts) {
      const error = new VideosBatchLlmError({
        code: "ATTEMPT_BUDGET_EXHAUSTED",
        message: `VideosBatch ${request.operation} exhausted its bounded ${budget.maxAttempts}-submission budget.`,
        retryable: false,
        attempt: budget.used
      });
      throw withAttemptEvidence(error, budget);
    }

    const primaryModel = request.model?.trim() || this.config.model;
    const fallbackModels = (this.config.fallbackModels || [])
      .map((model) => model.trim())
      .filter(Boolean)
      .filter((model, index, candidates) => candidates.indexOf(model) === index);
    const fallbackCandidates: ProviderCandidate[] = fallbackModels
      .filter((model) => model !== primaryModel)
      .map((model) => ({
        model,
        apiKey: this.config.fallbackApiKey,
        baseUrl: this.config.fallbackBaseUrl || this.config.baseUrl,
        fallback: true,
        reasoningEffort: this.config.fallbackReasoningEffort
      }));

    if (request.providerRoute === "fallback-only" && !fallbackCandidates.length) {
      throw new VideosBatchLlmError({
        code: "FALLBACK_NOT_CONFIGURED",
        message: `VideosBatch ${request.operation} has no configured fallback model.`,
        retryable: false
      });
    }
    if (request.providerRoute !== "fallback-only" && !this.config.apiKey) throw missingKeyError();

    const primary: ProviderCandidate = {
      model: primaryModel,
      apiKey: this.config.apiKey,
      baseUrl: this.config.baseUrl,
      fallback: false
    };
    const candidates = request.providerRoute === "fallback-only"
      ? fallbackCandidates
      : (budget.primaryExhausted || budget.fallbackStarted) && fallbackCandidates.length
        ? fallbackCandidates
        : [primary, ...fallbackCandidates];
    let lastError: unknown;
    for (const candidate of candidates) {
      const { model, apiKey } = candidate;
      if (!apiKey) {
        lastError = new VideosBatchLlmError({
          code: "FALLBACK_NOT_CONFIGURED",
          message: `VideosBatch fallback model ${model} has no API key configured.`,
          retryable: false,
          provider: "openai-responses",
          model
        });
        continue;
      }
      try {
        const result = await this.generateForModel<T>(request, candidate, budget, Boolean(!candidate.fallback && fallbackCandidates.length));
        if (candidate.fallback) budget.fallbackStarted = true;
        return result;
      } catch (error) {
        const normalized = normalizeError(error, request.operation, model, budget.used);
        lastError = normalized;
        if (!candidate.fallback) budget.primaryExhausted = true;
        if (!normalized.retryable || budget.used >= budget.maxAttempts) throw withAttemptEvidence(normalized, budget);
        const next = candidates[candidates.indexOf(candidate) + 1];
        if (next) console.warn(`[videosbatch-llm] ${request.operation} failed on ${model}; trying configured fallback ${next.model}`);
      }
    }
    if (lastError instanceof VideosBatchLlmError) throw withAttemptEvidence(lastError, budget);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async generateForModel<T>(
    request: StructuredGenerationRequest,
    candidate: ProviderCandidate,
    budget: VideosBatchLlmAttemptBudget,
    reserveForFallback: boolean
  ): Promise<StructuredGenerationResult<T>> {
    const { model, apiKey, baseUrl, reasoningEffort: fallbackReasoningEffort } = candidate;
    if (!apiKey) throw new VideosBatchLlmError({ code: "PROVIDER_NOT_CONFIGURED", message: `VideosBatch model ${model} has no API key configured.`, retryable: false, provider: "openai-responses", model });
    const body: Record<string, unknown> = {
      model,
      store: false,
      input: [
        { role: "system", content: request.systemPrompt },
        { role: "user", content: request.userPrompt }
      ],
      text: {
        format: { type: "json_schema", name: request.schemaName, strict: true, schema: request.jsonSchema }
      },
    };
    if (typeof request.temperature === "number") body.temperature = request.temperature;
    if (Number.isFinite(request.maxOutputTokens) && Number(request.maxOutputTokens) > 0) {
      body.max_output_tokens = Math.floor(Number(request.maxOutputTokens));
    }
    // A fallback route may declare its own reasoning policy. This lets the
    // primary storyboard request keep medium reasoning while the DeepSeek
    // fallback explicitly disables thinking; omission is not equivalent and
    // can consume the whole output budget before JSON is emitted.
    const reasoningEffort = candidate.fallback && fallbackReasoningEffort !== undefined
      ? fallbackReasoningEffort
      : request.reasoningEffort !== undefined
        ? request.reasoningEffort
        : fallbackReasoningEffort;
    if (reasoningEffort !== undefined) body.reasoning = { effort: reasoningEffort };

    const maxRetries = Math.min(2, Math.max(0, Math.floor(this.config.maxRetries ?? 0)));
    const timeoutMs = normalizedTimeout(request.timeoutMs, this.config.timeoutMs);
    let localAttempt = 0;
    while (localAttempt <= maxRetries) {
      if (budget.used >= budget.maxAttempts) {
        throw new VideosBatchLlmError({
          code: "ATTEMPT_BUDGET_EXHAUSTED",
          message: `VideosBatch ${request.operation} exhausted its bounded ${budget.maxAttempts}-submission budget.`,
          retryable: false,
          attempt: budget.used,
          provider: "openai-responses",
          model
        });
      }
      if (reserveForFallback && budget.used >= budget.maxAttempts - 1) {
        throw new VideosBatchLlmError({
          code: "PRIMARY_ATTEMPT_LIMIT",
          message: `VideosBatch ${request.operation} left no reserved submission for the configured fallback provider.`,
          retryable: true,
          attempt: budget.used,
          provider: "openai-responses",
          model
        });
      }
      const attempt = budget.used + 1;
      budget.used = attempt;
      localAttempt += 1;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const startedAt = Date.now();
      const idempotencyKey = providerScopedIdempotencyKey(
        request.idempotencyKey?.trim() || request.metadata?.idempotency_key?.trim(),
        candidate
      );
      const requestMetadata = {
        ...(request.metadata || {}),
        attempt: String(attempt),
        attempt_budget_used: String(attempt),
        attempt_budget_max: String(budget.maxAttempts)
      };
      try {
        const response = await fetch(`${baseUrl}/responses`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
            "X-VideosBatch-Operation": request.operation,
            "X-VideosBatch-Attempt": String(attempt),
            ...(request.metadata?.attempt_kind ? { "X-VideosBatch-Attempt-Kind": request.metadata.attempt_kind } : {})
          },
          body: JSON.stringify(body),
          signal: controller.signal
        });

        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          const error = new VideosBatchLlmError({
            code: `HTTP_${response.status}`,
            message: `VideosBatch LLM request failed for ${request.operation}: HTTP ${response.status}${detail ? ` ${safeProviderDetail(detail)}` : ""}`,
            retryable: retryableStatus(response.status),
            attempt,
            provider: "openai-responses",
            model,
            status: response.status
          });
          budget.records.push({ attempt, provider: "openai-responses", model, idempotencyKey, outcome: "error", errorCode: error.code, status: response.status, durationMs: Date.now() - startedAt, metadata: safeAttemptMetadata(requestMetadata) });
          if (!error.retryable || localAttempt > maxRetries || budget.used >= budget.maxAttempts || (reserveForFallback && budget.used >= budget.maxAttempts - 1)) throw error;
          console.warn(`[videosbatch-llm] retrying ${request.operation} after HTTP ${response.status} (attempt ${attempt}/${budget.maxAttempts})`);
          await sleep(this.config.retryDelaysMs?.[localAttempt - 1] ?? this.config.retryDelaysMs?.at(-1) ?? 0);
          continue;
        }

         const payload = await response.json() as any;
         if (typeof payload?.status === "string" && payload.status !== "completed") {
           const reason = typeof payload?.incomplete_details?.reason === "string"
             ? ` (${payload.incomplete_details.reason})`
             : "";
           throw new VideosBatchLlmError({
             code: "INCOMPLETE_STRUCTURED_OUTPUT",
             message: `VideosBatch LLM returned an incomplete response for ${request.operation}${reason}.`,
             retryable: true,
             attempt,
             provider: "openai-responses",
             model
           });
         }
         const rawText = extractOutputText(payload);
        if (!rawText) {
          throw new VideosBatchLlmError({ code: "EMPTY_STRUCTURED_OUTPUT", message: `VideosBatch LLM returned no structured text for ${request.operation}.`, retryable: true, attempt, provider: "openai-responses", model });
        }

        let data: T;
        try {
           data = parseStructuredJson<T>(rawText);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new VideosBatchLlmError({ code: "INVALID_JSON", message: `VideosBatch LLM returned invalid JSON for ${request.operation}: ${message.slice(0, 180)}`, retryable: true, attempt, provider: "openai-responses", model });
        }

        budget.records.push({ attempt, provider: "openai-responses", model, idempotencyKey, outcome: "success", durationMs: Date.now() - startedAt, metadata: safeAttemptMetadata(requestMetadata) });
        return {
          data,
          provider: "openai-responses",
          model: typeof payload?.model === "string" && payload.model ? payload.model : model,
          responseId: typeof payload?.id === "string" ? payload.id : undefined,
          rawText,
          usage: parseUsage(payload?.usage),
          attempt,
          attempts: budget.used,
          attemptLog: [...budget.records]
        };
      } catch (error) {
        const normalized = error instanceof VideosBatchLlmError
          ? error
          : error instanceof Error && error.name === "AbortError"
          ? new VideosBatchLlmError({ code: "TIMEOUT", message: `VideosBatch LLM request timed out after ${timeoutMs}ms for ${request.operation} on ${model}.`, retryable: true, attempt, provider: "openai-responses", model })
            : new VideosBatchLlmError({ code: "NETWORK_ERROR", message: `VideosBatch LLM network request failed for ${request.operation} on ${model}.`, retryable: isRetryableNetworkError(error), attempt, provider: "openai-responses", model });
        const alreadyRecorded = budget.records.some((record) => record.attempt === attempt && record.model === model);
        if (!alreadyRecorded) budget.records.push({ attempt, provider: "openai-responses", model, idempotencyKey, outcome: "error", errorCode: normalized.code, durationMs: Date.now() - startedAt, metadata: safeAttemptMetadata(requestMetadata) });
        if (!normalized.retryable || localAttempt > maxRetries || budget.used >= budget.maxAttempts || (reserveForFallback && budget.used >= budget.maxAttempts - 1)) throw normalized;
        console.warn(`[videosbatch-llm] retrying ${request.operation} after ${normalized.code} (attempt ${attempt}/${budget.maxAttempts})`);
        await sleep(this.config.retryDelaysMs?.[localAttempt - 1] ?? this.config.retryDelaysMs?.at(-1) ?? 0);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new VideosBatchLlmError({ code: "RETRY_EXHAUSTED", message: `VideosBatch LLM request exhausted retries for ${request.operation}.`, retryable: false, attempt: budget.used, provider: "openai-responses", model });
  }
}

export function createVideosBatchLlmExecutor(
  config: VideosBatchLlmConfig = resolveVideosBatchLlmConfig()
): VideosBatchLlmExecutor {
  if (config.provider === "openai-responses") return new OpenAIResponsesLlmExecutor(config);
  throw new Error(`Unsupported VideosBatch LLM provider: ${String((config as any).provider)}`);
}
