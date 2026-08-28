import {
  createVideosBatchLlmExecutor,
  resolveVideosBatchLlmConfig,
  type VideosBatchLlmConfig
} from "./llmExecutor";
import { createVideosBatchLlmTextStageRegistry } from "./llmTextStages";
import { createVideosBatchNativeMediaStageRegistry } from "./nativeMediaStages";
import { createPhase1FakeStageRegistry } from "./stages";
import type { StageRegistry } from "./stageContracts";

export type VideosBatchExecutorMode = "fake" | "llm";
export type VideosBatchMediaMode = "fake" | "native";
export type VideosBatchRuntimeEnv = Record<string, string | undefined>;

export interface VideosBatchRuntimeConfig {
  executorMode: VideosBatchExecutorMode;
  mediaMode: VideosBatchMediaMode;
  llm?: VideosBatchLlmConfig;
}

export interface VideosBatchProviderReadiness {
  executorMode: VideosBatchExecutorMode;
  mediaMode: VideosBatchMediaMode;
  text: {
    enabled: boolean;
    ready: boolean;
    provider?: string;
    model?: string;
    baseUrl?: string;
    keyConfigured: boolean;
  };
  media: {
    enabled: boolean;
    mode: VideosBatchMediaMode;
  };
}

function trimmed(env: VideosBatchRuntimeEnv, key: string) {
  return String(env[key] || "").trim();
}

/**
 * Runtime provider selection is intentionally explicit.
 *
 * Generic keys already present in the SeeReel process never auto-enable paid VideosBatch work.
 * Text and media are independent switches: missing modes always mean deterministic fake execution.
 * Real text requires a dedicated VideosBatch key/model. Native media intentionally reuses SeeReel's
 * existing Seedream / Seedance credential routing, but only after VIDEOSBATCH_MEDIA_MODE=native.
 */
export function resolveVideosBatchRuntimeConfig(
  env: VideosBatchRuntimeEnv = process.env
): VideosBatchRuntimeConfig {
  const executorMode = (trimmed(env, "VIDEOSBATCH_EXECUTOR_MODE").toLowerCase() || "fake") as VideosBatchExecutorMode;
  if (executorMode !== "fake" && executorMode !== "llm") {
    throw new Error(`VIDEOSBATCH_EXECUTOR_MODE must be one of: fake, llm (received: ${executorMode})`);
  }

  const mediaMode = (trimmed(env, "VIDEOSBATCH_MEDIA_MODE").toLowerCase() || "fake") as VideosBatchMediaMode;
  if (mediaMode !== "fake" && mediaMode !== "native") {
    throw new Error(`VIDEOSBATCH_MEDIA_MODE must be one of: fake, native (received: ${mediaMode})`);
  }

  if (executorMode === "fake") return { executorMode, mediaMode };

  const apiKey = trimmed(env, "VIDEOSBATCH_LLM_API_KEY");
  if (!apiKey) {
    throw new Error(
      "VIDEOSBATCH_EXECUTOR_MODE=llm requires VIDEOSBATCH_LLM_API_KEY. " +
      "VideosBatch does not automatically reuse OPENAI_API_KEY/OAI_KEY."
    );
  }

  const model = trimmed(env, "VIDEOSBATCH_LLM_MODEL");
  if (!model) {
    throw new Error("VIDEOSBATCH_EXECUTOR_MODE=llm requires an explicit VIDEOSBATCH_LLM_MODEL.");
  }

  const llm = resolveVideosBatchLlmConfig({
    VIDEOSBATCH_LLM_PROVIDER: trimmed(env, "VIDEOSBATCH_LLM_PROVIDER") || "openai-responses",
    VIDEOSBATCH_LLM_API_KEY: apiKey,
    VIDEOSBATCH_LLM_BASE_URL: trimmed(env, "VIDEOSBATCH_LLM_BASE_URL") || "https://api.openai.com/v1",
    VIDEOSBATCH_LLM_MODEL: model,
    VIDEOSBATCH_LLM_TIMEOUT_MS: trimmed(env, "VIDEOSBATCH_LLM_TIMEOUT_MS") || "120000"
  });

  return { executorMode, mediaMode, llm };
}

export function getVideosBatchProviderReadiness(
  config: VideosBatchRuntimeConfig
): VideosBatchProviderReadiness {
  const media = {
    enabled: config.mediaMode === "native",
    mode: config.mediaMode
  } as const;

  if (config.executorMode === "fake") {
    return {
      executorMode: "fake",
      mediaMode: config.mediaMode,
      text: {
        enabled: false,
        ready: true,
        keyConfigured: false
      },
      media
    };
  }

  const llm = config.llm;
  return {
    executorMode: "llm",
    mediaMode: config.mediaMode,
    text: {
      enabled: true,
      ready: Boolean(llm?.apiKey && llm?.model),
      provider: llm?.provider,
      model: llm?.model,
      baseUrl: llm?.baseUrl,
      keyConfigured: Boolean(llm?.apiKey)
    },
    media
  };
}

export function createVideosBatchRuntimeStageRegistry(
  env: VideosBatchRuntimeEnv = process.env
): StageRegistry {
  const config = resolveVideosBatchRuntimeConfig(env);
  let registry: StageRegistry = createPhase1FakeStageRegistry();

  if (config.executorMode === "llm") {
    if (!config.llm) throw new Error("VideosBatch llm runtime config was not resolved");
    const textExecutor = createVideosBatchLlmExecutor(config.llm);
    registry = {
      ...registry,
      ...createVideosBatchLlmTextStageRegistry(textExecutor)
    };
  }

  if (config.mediaMode === "native") {
    registry = {
      ...registry,
      ...createVideosBatchNativeMediaStageRegistry()
    };
  }

  return registry;
}
