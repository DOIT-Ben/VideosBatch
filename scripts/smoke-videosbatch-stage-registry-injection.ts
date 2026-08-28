import { strict as assert } from "node:assert";
import { createVideosBatchWorkflow } from "../src/shared/videosBatchWorkflow";
import type { Session } from "../src/shared/types";
import type { StructuredGenerationRequest, VideosBatchLlmExecutor } from "../src/server/videosBatchWorkflow/llmExecutor";
import { createVideosBatchStageRegistry } from "../src/server/videosBatchWorkflow/stages";

const calls: StructuredGenerationRequest[] = [];
const executor: VideosBatchLlmExecutor = {
  async generateStructured<T>(request: StructuredGenerationRequest) {
    calls.push(request);
    return {
      data: {
        candidates: ["A1", "A2", "A3", "B1", "B2", "B3", "C1", "C2", "C3"].map((id) => ({
          id,
          name: id,
          creativeType: "test",
          body: "字".repeat(220),
          endingQuestion: "怎样解决？",
          truthfulnessCategory: "完全虚构的故事化情境",
          truthfulnessNote: "测试"
        })),
        recommendations: [
          { id: "A1", reason: "test" },
          { id: "B1", reason: "test" },
          { id: "C1", reason: "test" }
        ]
      } as T,
      provider: "openai-responses",
      model: "injected-test",
      rawText: "{}"
    };
  }
};

const fakeRegistry = createVideosBatchStageRegistry();
const injectedRegistry = createVideosBatchStageRegistry({ textExecutor: executor });
assert.ok(fakeRegistry.ASSET_GENERATION, "default registry must preserve fake media stages");
assert.ok(injectedRegistry.ASSET_GENERATION, "injected registry must preserve media stages");
assert.ok(injectedRegistry.REFERENCE_BINDING, "injected registry must preserve deterministic/reference stage");

const workflow = createVideosBatchWorkflow({ projectId: "P001", lessonText: "观察物体教案" });
const now = new Date().toISOString();
const session: Session = {
  id: "ses_registry_injection",
  title: "registry injection",
  logline: "",
  style: "test",
  targetDurationSec: 120,
  videosBatchWorkflow: workflow,
  createdAt: now,
  updatedAt: now
} as Session;

await injectedRegistry.INTRO_GENERATION!.execute({ session, workflow, assets: [], shots: [] });
assert.equal(calls.length, 1, "explicitly injected text executor must power text stages");
assert.equal(calls[0].operation, "INTRO_GENERATION");

await fakeRegistry.INTRO_GENERATION!.execute({ session, workflow, assets: [], shots: [] });
assert.equal(calls.length, 1, "default registry must not call the injected/real LLM path");

console.log("VideosBatch stage registry injection smoke passed");
