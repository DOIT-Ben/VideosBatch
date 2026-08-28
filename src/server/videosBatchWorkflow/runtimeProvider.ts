import {
  createVideosBatchLlmExecutor,
  resolveVideosBatchLlmConfig,
  type VideosBatchLlmConfig
} from "./llmExecutor";
import { createVideosBatchLlmTextStageRegistry } from "./llmTextStages";
import { createPhase1FakeStageRegistry } from "./stages";
import type { StageRegistry } from "./stageContracts";

export type VideosBatchExecutorMode = "fake" | "llm";
export type VideosBatchRuntimeEnv = Record<string, string | undefined>;

export interface VideosBatchRuntimeConfig {
  executorMode: VideosBatchExecutorMode;
  llm?: VideosBatchLlmConfig;
}

export interface VideosBatchProviderReadiness {
  executorMode: VideosBatchExecutorMode;
  text: {
    enabled: boolean;
    ready: boolean;
    provider?: string;
    model?: string;
    baseUrl?: string;
    keyConfigured: boolean;
  };
}

function trimmed(env: VideosBatchRuntimeEnv, key: string) {
  return String(env[key] || "").trim();
}

/**
 * Runtime provider selection is intentionally explicit.
 *
 * A key already present elsewhere in the SeeReel process must never make VideosBatch start
 * spending provider credits. Missing mode always means deterministic fake execution. Real text
 * generation requires BOTH an explicit llm mode and VideosBatch-specific key/model variables.
 */
export function resolveVideosBatchRuntimeConfig(
  env: VideosBatchRuntimeEnv = process.env
): VideosBatchRuntimeConfig {
  const rawMode = trimmed(env, "VIDEOSBATCH_EXECUTOR_MODE").toLowerCase() || "fake";
  if (rawMode !== "fake" && rawMode !== "llm") {
    throw new Error(`VIDEOSBATCH_EXECUTOR_MODE must be one of: fake, llm (received: ${rawMode})`);
  }

  if (rawMode === "fake") return { executorMode: "fake" };

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

  return { executorMode: "llm", llm };
}

export function getVideosBatchProviderReadiness(
  config: VideosBatchRuntimeConfig
): VideosBatchProviderReadiness {
  if (config.executorMode === "fake") {
    return {
      executorMode: "fake",
      text: {
        enabled: false,
        ready: true,
        keyConfigured: false
      }
    };
  }

  const llm = config.llm;
  return {
    executorMode: "llm",
    text: {
      enabled: true,
      ready: Boolean(llm?.apiKey && llm?.model),
      provider: llm?.provider,
      model: llm?.model,
      baseUrl: llm?.baseUrl,
      keyConfigured: Boolean(llm?.apiKey)
    }
  };
}

export function createVideosBatchRuntimeStageRegistry(
  env: VideosBatchRuntimeEnv = process.env
): StageRegistry {
  const config = resolveVideosBatchRuntimeConfig(env);
  const registry = createPhase1FakeStageRegistry();
  if (config.executorMode === "fake") return registry;

  if (!config.llm) throw new Error("VideosBatch llm runtime config was not resolved");
  const textExecutor = createVideosBatchLlmExecutor(config.llm);
  return {
    ...registry,
    ...createVideosBatchLlmTextStageRegistry(textExecutor)
  };
}
