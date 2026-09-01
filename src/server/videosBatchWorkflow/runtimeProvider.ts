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
  videoProvider: "seedance" | "newapi-h3";
  imageProvider: "seedream" | "lyaiapp";
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

  const videoProvider = (trimmed(env, "VIDEOSBATCH_VIDEO_PROVIDER").toLowerCase() || "seedance") as VideosBatchRuntimeConfig["videoProvider"];
  if (videoProvider !== "seedance" && videoProvider !== "newapi-h3") {
    throw new Error(`VIDEOSBATCH_VIDEO_PROVIDER must be one of: seedance, newapi-h3 (received: ${videoProvider})`);
  }
  if (mediaMode === "native" && videoProvider === "newapi-h3") {
    if (!trimmed(env, "VIDEOSBATCH_H3_API_KEY")) {
      throw new Error("VIDEOSBATCH_VIDEO_PROVIDER=newapi-h3 requires VIDEOSBATCH_H3_API_KEY.");
    }
    const baseUrl = trimmed(env, "VIDEOSBATCH_H3_BASE_URL") || "http://122.228.216.60:3000/v1";
    if (baseUrl.startsWith("http://") && trimmed(env, "VIDEOSBATCH_H3_ALLOW_HTTP") !== "1") {
      throw new Error("NewAPI H3 HTTP endpoint requires VIDEOSBATCH_H3_ALLOW_HTTP=1.");
    }
  }

  const imageProvider = (trimmed(env, "VIDEOSBATCH_IMAGE_PROVIDER").toLowerCase() || "seedream") as VideosBatchRuntimeConfig["imageProvider"];
  if (imageProvider !== "seedream" && imageProvider !== "lyaiapp") {
    throw new Error(`VIDEOSBATCH_IMAGE_PROVIDER must be one of: seedream, lyaiapp (received: ${imageProvider})`);
  }
  if (mediaMode === "native" && imageProvider === "lyaiapp" && !trimmed(env, "VIDEOSBATCH_IMAGE_API_KEY")) {
    throw new Error("VIDEOSBATCH_IMAGE_PROVIDER=lyaiapp requires VIDEOSBATCH_IMAGE_API_KEY.");
  }

  if (executorMode === "fake") return { executorMode, mediaMode, videoProvider, imageProvider };

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
    VIDEOSBATCH_LLM_TIMEOUT_MS: trimmed(env, "VIDEOSBATCH_LLM_TIMEOUT_MS") || "120000",
    VIDEOSBATCH_LLM_MAX_RETRIES: trimmed(env, "VIDEOSBATCH_LLM_MAX_RETRIES"),
    VIDEOSBATCH_LLM_RETRY_DELAYS_MS: trimmed(env, "VIDEOSBATCH_LLM_RETRY_DELAYS_MS"),
    VIDEOSBATCH_LLM_OUTPUT_MODE: trimmed(env, "VIDEOSBATCH_LLM_OUTPUT_MODE"),
    VIDEOSBATCH_LLM_FALLBACK_MODELS: trimmed(env, "VIDEOSBATCH_LLM_FALLBACK_MODELS"),
    VIDEOSBATCH_LLM_FALLBACK_API_KEY: trimmed(env, "VIDEOSBATCH_LLM_FALLBACK_API_KEY"),
    VIDEOSBATCH_LLM_FALLBACK_BASE_URL: trimmed(env, "VIDEOSBATCH_LLM_FALLBACK_BASE_URL"),
    VIDEOSBATCH_LLM_FALLBACK_OUTPUT_MODE: trimmed(env, "VIDEOSBATCH_LLM_FALLBACK_OUTPUT_MODE"),
    VIDEOSBATCH_LLM_FALLBACK_REASONING: trimmed(env, "VIDEOSBATCH_LLM_FALLBACK_REASONING")
  });

  return { executorMode, mediaMode, videoProvider, imageProvider, llm };
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
