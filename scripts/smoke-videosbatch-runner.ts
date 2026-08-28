import type { Session } from "../src/shared/types";
import {
  VIDEOS_BATCH_STAGE_ORDER,
  createVideosBatchWorkflow,
  type VideosBatchStageId,
  type VideosBatchWorkflowState
} from "../src/shared/videosBatchWorkflow";
import type { StageDefinition, StageExecutionContext, StageRegistry } from "../src/server/videosBatchWorkflow/stageContracts";
import { replaceStageArtifact, runAll, runNext } from "../src/server/videosBatchWorkflow/runner";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function makeSession(workflow: VideosBatchWorkflowState): Session {
  const now = new Date().toISOString();
  return {
    id: "ses_runner",
    title: "Runner smoke",
    logline: "",
    style: "default",
    targetDurationSec: 120,
    videosBatchWorkflow: workflow,
    createdAt: now,
    updatedAt: now
  };
}

function context(workflow: VideosBatchWorkflowState): StageExecutionContext {
  return {
    session: makeSession(workflow),
    workflow,
    assets: [],
    shots: []
  };
}

function passingStage(id: VideosBatchStageId): StageDefinition {
  return {
    id,
    async execute() {
      return { artifact: { stage: id, value: `artifact:${id}` } };
    },
    validate() {
      return { ok: true, errors: [] };
    }
  };
}

const executableStages = VIDEOS_BATCH_STAGE_ORDER.filter(
  (stageId) => stageId !== "LESSON_INPUT" && stageId !== "STORY_SELECTION"
);
const registry: StageRegistry = Object.fromEntries(
  executableStages.map((stageId) => [stageId, passingStage(stageId)])
);

// runNext executes exactly one stage.
let workflow = createVideosBatchWorkflow({ projectId: "P001", lessonText: "完整教案" }, "2026-08-28T00:00:00.000Z");
workflow = await runNext(context(workflow), registry);
assert(workflow.stages.INTRO_GENERATION?.status === "ready", "runNext must complete the current stage");
assert(workflow.currentStage === "STORY_EXPANSION", "runNext must advance by exactly one stage");
assert(workflow.stages.STORY_EXPANSION?.status === "pending", "runNext must not execute the next stage");

// runAll advances until the manual STORY_SELECTION gate.
workflow = await runAll(context(workflow), registry);
assert(workflow.stages.STORY_EXPANSION?.status === "ready", "runAll must execute automatic stages");
assert(workflow.currentStage === "STORY_SELECTION", "runAll must stop at manual story selection");
assert(workflow.completed !== true, "workflow must not complete before story selection");

// Selecting one story is a visible artifact and lets runAll resume to completion.
workflow = replaceStageArtifact(workflow, "STORY_SELECTION", { selectedStoryId: "story-1" }, "2026-08-28T00:01:00.000Z");
assert(workflow.selectedStoryId === "story-1", "story selection must persist selectedStoryId");
assert(workflow.stages.STORY_SELECTION?.status === "ready", "story selection artifact must be ready");
assert(workflow.currentStage === "ASSET_PROMPT_GENERATION", "selecting the current story must advance to the next stage");
workflow = await runAll(context(workflow), registry);
assert(workflow.stages.STITCH?.status === "ready", "runAll must reach stitch after selection");
assert(workflow.completed === true, "workflow must become completed after stitch succeeds");

// Validation failure fails only the current stage and does not advance.
let invalidWorkflow = createVideosBatchWorkflow({ projectId: "P002", lessonText: "另一份教案" });
const invalidIntro: StageDefinition = {
  id: "INTRO_GENERATION",
  async execute() {
    return { artifact: { candidates: [] } };
  },
  validate() {
    return { ok: false, errors: ["expected 9 intro candidates"] };
  }
};
invalidWorkflow = await runNext(context(invalidWorkflow), {
  ...registry,
  INTRO_GENERATION: invalidIntro
});
assert(invalidWorkflow.stages.INTRO_GENERATION?.status === "failed", "validator failure must fail the current stage");
assert(invalidWorkflow.currentStage === "INTRO_GENERATION", "validator failure must not advance the cursor");
assert(invalidWorkflow.stages.STORY_EXPANSION?.status === "pending", "validator failure must not mutate unrelated stages");
assert(invalidWorkflow.stages.INTRO_GENERATION?.error?.includes("expected 9"), "validator errors must be visible on the stage");

// Editing an upstream artifact marks completed downstream stages stale but keeps old artifacts.
let editedWorkflow = createVideosBatchWorkflow({ projectId: "P003", lessonText: "第三份教案" });
editedWorkflow.stages.INTRO_GENERATION = { status: "ready", revision: 1, artifact: { old: "intro" } };
editedWorkflow.stages.STORY_EXPANSION = { status: "ready", revision: 1, artifact: { old: "stories" } };
editedWorkflow.stages.STORY_SELECTION = { status: "ready", revision: 1, artifact: { selectedStoryId: "story-old" } };
editedWorkflow.stages.ASSET_PROMPT_GENERATION = { status: "ready", revision: 1, artifact: { old: "assets" } };
const oldStories = editedWorkflow.stages.STORY_EXPANSION.artifact;
const oldAssets = editedWorkflow.stages.ASSET_PROMPT_GENERATION.artifact;
editedWorkflow = replaceStageArtifact(editedWorkflow, "INTRO_GENERATION", { new: "intro" });
assert(editedWorkflow.stages.INTRO_GENERATION?.status === "ready", "edited stage remains ready");
assert(editedWorkflow.stages.INTRO_GENERATION?.revision === 2, "editing increments revision");
assert(editedWorkflow.stages.STORY_EXPANSION?.status === "stale", "completed downstream stage must become stale");
assert(editedWorkflow.stages.STORY_SELECTION?.status === "stale", "manual downstream stage must become stale");
assert(editedWorkflow.stages.ASSET_PROMPT_GENERATION?.status === "stale", "later completed stage must become stale");
assert(editedWorkflow.stages.STORY_EXPANSION?.artifact === oldStories, "stale propagation must preserve old story artifact");
assert(editedWorkflow.stages.ASSET_PROMPT_GENERATION?.artifact === oldAssets, "stale propagation must preserve old asset artifact");

console.log("VideosBatch linear runner smoke passed");
