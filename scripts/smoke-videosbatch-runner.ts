import { strict as assert } from "node:assert";
import { createVideosBatchWorkflow } from "../src/shared/videosBatchWorkflow";
import type { Session } from "../src/shared/types";
import { replaceStageArtifact, restartFrom, runAll } from "../src/server/videosBatchWorkflow/runner";
import { createPhase1FakeStageRegistry } from "../src/server/videosBatchWorkflow/stages";

function context(workflow: any): any {
  const now = new Date().toISOString();
  const session: Session = {
    id: "ses_runner",
    title: "canonical runner",
    logline: "",
    style: "test",
    targetDurationSec: 120,
    shots: [],
    videosBatchWorkflow: workflow,
    createdAt: now,
    updatedAt: now
  } as Session;
  return { session, workflow, assets: [], shots: [] };
}

const registry = createPhase1FakeStageRegistry();
let workflow = createVideosBatchWorkflow({ projectId: "P001", lessonText: "观察物体完整教案" });

workflow = await runAll(context(workflow), registry);
assert.equal(workflow.currentStage, "COURSE_INTRO_SELECTION", "runAll must stop at the first manual confirmation gate");
assert.equal(workflow.stages.COURSE_INTRO_CANDIDATES?.status, "ready");
assert.equal(workflow.introLocked, false);
assert.equal(workflow.stages.STORY_SCRIPT?.status, "pending", "story generation must not run before one intro is locked");

workflow = replaceStageArtifact(workflow, "COURSE_INTRO_SELECTION", {
  selectedIntroId: "A-01",
  selectionMode: "user_selected",
  selectionReason: "用户确认课堂吸引力与知识连接最合适",
  locked: true
});
assert.equal(workflow.selectedIntroId, "A-01");
assert.equal(workflow.introLocked, true);
assert.equal(workflow.currentStage, "STORY_SCRIPT");

workflow = await runAll(context(workflow), registry);
assert.equal(workflow.currentStage, "ASSET_CONFIRMATION", "runAll must stop until every required image asset is confirmed");
assert.equal(workflow.stages.STORY_SCRIPT?.status, "ready");
assert.equal(workflow.stages.ASSET_PLAN?.status, "ready");
assert.equal(workflow.stages.ASSET_CANDIDATES?.status, "ready");
assert.equal(workflow.stages.SCREENPLAY?.status, "pending", "formal screenplay must not run before asset confirmation");

const candidateItems = (workflow.stages.ASSET_CANDIDATES?.artifact as any)?.items || [];
assert.ok(candidateItems.length > 0, "asset candidate stage must expose candidates");
workflow = replaceStageArtifact(workflow, "ASSET_CONFIRMATION", {
  confirmed: true,
  items: candidateItems.map((item: any) => ({
    assetKey: item.assetKey,
    publicAssetId: item.publicAssetId,
    candidateAssetIds: item.candidateAssetIds,
    selectedAssetId: item.candidateAssetIds[0]
  }))
});
assert.equal(workflow.currentStage, "SCREENPLAY");

workflow = await runAll(context(workflow), registry);
assert.equal(workflow.completed, true, "canonical fake chain must reach DONE after both manual gates are confirmed");
assert.equal(workflow.stages.SCREENPLAY?.status, "ready");
assert.equal((workflow.stages.SCREENPLAY?.artifact as any)?.targetDurationSeconds, 120);
assert.equal((workflow.stages.FINAL_STORYBOARD?.artifact as any)?.segments?.length, 12, "120-second screenplay must produce exactly 12 ten-second segments");
assert.equal(workflow.stages.COPYABLE_PROMPT?.status, "ready");
assert.equal(workflow.stages.QUOTE?.status, "ready");
assert.equal(workflow.stages.EXECUTION?.status, "ready");
assert.equal(workflow.stages.STITCH?.status, "ready");

const editedStory = replaceStageArtifact(workflow, "STORY_SCRIPT", {
  ...(workflow.stages.STORY_SCRIPT?.artifact as any),
  content: `${(workflow.stages.STORY_SCRIPT?.artifact as any)?.content || ""}\n用户编辑`
});
assert.equal(editedStory.completed, false, "editing an upstream story after completion must reopen the workflow");
assert.equal(editedStory.currentStage, "ASSET_PLAN", "editing STORY_SCRIPT must resume from the immediate downstream generation stage");
assert.equal(editedStory.stages.ASSET_PLAN?.status, "stale");
assert.equal(editedStory.stages.SCREENPLAY?.status, "stale");

const editedScreenplay = replaceStageArtifact(workflow, "SCREENPLAY", {
  ...(workflow.stages.SCREENPLAY?.artifact as any),
  title: "用户编辑后的正式视频剧本"
});
assert.equal(editedScreenplay.completed, false, "editing screenplay after completion must reopen the workflow");
assert.equal(editedScreenplay.currentStage, "FINAL_STORYBOARD", "editing SCREENPLAY must resume from FINAL_STORYBOARD");
assert.equal(editedScreenplay.stages.FINAL_STORYBOARD?.status, "stale");
assert.equal(editedScreenplay.stages.STITCH?.status, "stale");

const editedStoryboard = replaceStageArtifact(workflow, "FINAL_STORYBOARD", {
  ...(workflow.stages.FINAL_STORYBOARD?.artifact as any),
  title: "用户编辑后的最终分镜"
});
assert.equal(editedStoryboard.completed, false, "editing storyboard after completion must reopen the workflow");
assert.equal(editedStoryboard.currentStage, "COPYABLE_PROMPT", "editing FINAL_STORYBOARD must resume from prompt compilation");
assert.equal(editedStoryboard.stages.COPYABLE_PROMPT?.status, "stale");
assert.equal(editedStoryboard.stages.EXECUTION?.status, "stale");

const restarted = restartFrom(workflow, "COURSE_INTRO_SELECTION");
assert.equal(restarted.completed, false);
assert.equal(restarted.currentStage, "COURSE_INTRO_SELECTION");
assert.equal(restarted.introLocked, false, "restarting from intro selection must clear the old lock");
assert.equal(restarted.selectedIntroId, undefined);
assert.equal(restarted.stages.STORY_SCRIPT?.status, "stale", "downstream artifacts must be visibly stale after upstream restart");

console.log("VideosBatch canonical linear runner smoke passed");
