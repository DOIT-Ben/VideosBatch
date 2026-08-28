export type VideosBatchLlmProvider = "openai-responses";

export type JsonSchema = Record<string, unknown>;

export interface StructuredGenerationRequest {
  operation: string;
  systemPrompt: string;
  userPrompt: string;
  schemaName: string;
  jsonSchema: JsonSchema;
  model?: string;
  temperature?: number;
  metadata?: Record<string, string>;
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
}

export interface VideosBatchLlmExecutor {
  generateStructured<T>(request: StructuredGenerationRequest): Promise<StructuredGenerationResult<T>>;
}

export interface VideosBatchLlmConfig {
  provider: VideosBatchLlmProvider;
  apiKey?: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

type EnvLike = Record<string, string | undefined>;

function clean(value: string | undefined) {
  return value?.trim() || undefined;
}

function normalizeBaseUrl(value: string | undefined) {
  return (clean(value) || "https://api.openai.com/v1").replace(/\/+$/, "");
}

export function resolveVideosBatchLlmConfig(env: EnvLike = process.env): VideosBatchLlmConfig {
  const providerRaw = clean(env.VIDEOSBATCH_LLM_PROVIDER)?.toLowerCase() || "openai-responses";
  if (providerRaw !== "openai-responses") {
    throw new Error(`Unsupported VIDEOSBATCH_LLM_PROVIDER: ${providerRaw}`);
  }

  const timeoutRaw = Number(clean(env.VIDEOSBATCH_LLM_TIMEOUT_MS) || 120_000);
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 120_000;

  return {
    provider: "openai-responses",
    apiKey: clean(env.VIDEOSBATCH_LLM_API_KEY) || clean(env.OAI_KEY) || clean(env.OPENAI_API_KEY),
    baseUrl: normalizeBaseUrl(env.VIDEOSBATCH_LLM_BASE_URL),
    model: clean(env.VIDEOSBATCH_LLM_MODEL) || clean(env.OPENAI_TEXT_MODEL) || "gpt-4.1-mini",
    timeoutMs
  };
}

function missingKeyError() {
  return new Error(
    "VideosBatch LLM is configured but no API key is available. Set VIDEOSBATCH_LLM_API_KEY (preferred) or reuse OAI_KEY / OPENAI_API_KEY when you are ready to enable real model calls."
  );
}

function extractOutputText(payload: any): string | undefined {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) return payload.output_text;
  if (!Array.isArray(payload?.output)) return undefined;

  const chunks: string[] = [];
  for (const item of payload.output) {
    if (!Array.isArray(item?.content)) continue;
    for (const content of item.content) {
      if (typeof content?.text === "string") chunks.push(content.text);
    }
  }
  const joined = chunks.join("").trim();
  return joined || undefined;
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

class OpenAIResponsesLlmExecutor implements VideosBatchLlmExecutor {
  constructor(private readonly config: VideosBatchLlmConfig) {}

  async generateStructured<T>(request: StructuredGenerationRequest): Promise<StructuredGenerationResult<T>> {
    if (!this.config.apiKey) throw missingKeyError();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const model = request.model?.trim() || this.config.model;

    const body: Record<string, unknown> = {
      model,
      store: false,
      input: [
        { role: "system", content: request.systemPrompt },
        { role: "user", content: request.userPrompt }
      ],
      text: {
        format: {
          type: "json_schema",
          name: request.schemaName,
          strict: true,
          schema: request.jsonSchema
        }
      },
      metadata: {
        operation: request.operation,
        ...(request.metadata || {})
      }
    };
    if (typeof request.temperature === "number") body.temperature = request.temperature;

    try {
      const response = await fetch(`${this.config.baseUrl}/responses`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `VideosBatch LLM request failed for ${request.operation}: ${response.status} ${response.statusText}${detail ? ` ${detail.slice(0, 600)}` : ""}`
        );
      }

      const payload = await response.json() as any;
      const rawText = extractOutputText(payload);
      if (!rawText) {
        throw new Error(`VideosBatch LLM returned no structured text for ${request.operation}`);
      }

      let data: T;
      try {
        data = JSON.parse(rawText) as T;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`VideosBatch LLM returned invalid JSON for ${request.operation}: ${message}`);
      }

      return {
        data,
        provider: "openai-responses",
        model: typeof payload?.model === "string" && payload.model ? payload.model : model,
        responseId: typeof payload?.id === "string" ? payload.id : undefined,
        rawText,
        usage: parseUsage(payload?.usage)
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`VideosBatch LLM request timed out after ${this.config.timeoutMs}ms for ${request.operation}`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createVideosBatchLlmExecutor(
  config: VideosBatchLlmConfig = resolveVideosBatchLlmConfig()
): VideosBatchLlmExecutor {
  if (config.provider === "openai-responses") return new OpenAIResponsesLlmExecutor(config);
  throw new Error(`Unsupported VideosBatch LLM provider: ${String((config as any).provider)}`);
}
