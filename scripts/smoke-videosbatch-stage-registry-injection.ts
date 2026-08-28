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
        candidates: ["A-01", "A-02", "A-03", "B-01", "B-02", "B-03", "C-01", "C-02", "C-03"].map((id) => ({
          id,
          name: id,
          creativeType: "test",
          body: "字".repeat(220),
          endingQuestion: "怎样解决？",
          truthfulnessCategory: "完全虚构的故事化情境",
          truthfulnessNote: "测试"
        })),
        recommendations: [
          { id: "A-01", reason: "test" },
          { id: "B-01", reason: "test" },
          { id: "C-01", reason: "test" }
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
assert.ok(fakeRegistry.ASSET_CANDIDATES, "default registry must preserve native/fake media stages");
assert.ok(injectedRegistry.ASSET_CANDIDATES, "injected registry must preserve media stages");
assert.ok(injectedRegistry.QUOTE, "canonical quote stage must remain present");
assert.ok(injectedRegistry.EXECUTION, "canonical execution stage must remain present");
assert.equal(injectedRegistry.COURSE_INTRO_SELECTION, undefined, "manual intro-selection gate must not become a hidden model executor");
assert.equal(injectedRegistry.ASSET_CONFIRMATION, undefined, "manual asset-confirmation gate must not become a hidden model executor");

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

await injectedRegistry.COURSE_INTRO_CANDIDATES!.execute({ session, workflow, assets: [], shots: [] });
assert.equal(calls.length, 1, "explicitly injected text executor must power canonical model stages");
assert.equal(calls[0].operation, "COURSE_INTRO_CANDIDATES");

await fakeRegistry.COURSE_INTRO_CANDIDATES!.execute({ session, workflow, assets: [], shots: [] });
assert.equal(calls.length, 1, "default fake registry must not call the injected/real LLM path");

console.log("VideosBatch canonical stage registry injection smoke passed");
