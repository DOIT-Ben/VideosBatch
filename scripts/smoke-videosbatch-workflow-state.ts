import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createVideosBatchWorkflow, VIDEOS_BATCH_STAGE_ORDER } from "../src/shared/videosBatchWorkflow";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const repoRoot = process.cwd();
const tmp = path.join(os.tmpdir(), `videosbatch-workflow-${process.pid}-${Date.now()}`);
await rm(tmp, { recursive: true, force: true });
await mkdir(tmp, { recursive: true });
process.chdir(tmp);

const storeModule = await import(`${pathToFileURL(path.join(repoRoot, "src/server/store.ts")).href}?videosbatch=${Date.now()}`);
const { CinemaStore } = storeModule as typeof import("../src/server/store");

const store = new CinemaStore();
await store.load();

const plain = await store.createSession({
  title: "Plain SeeReel session",
  logline: "Must remain compatible",
  style: "default",
  targetDurationSec: 60,
  shotCount: 0
});
assert(plain.videosBatchWorkflow === undefined, "ordinary SeeReel sessions must not get a workflow implicitly");

const projectId = "P001";
const lessonText = "完整教案：观察物体。";
const workflow = createVideosBatchWorkflow({ projectId, lessonText });
assert(workflow.version === 1, "workflow version must be 1");
assert(workflow.currentStage === "COURSE_INTRO_CANDIDATES", "workflow must start at canonical course-intro candidates");
assert(workflow.introLocked === false, "new workflow must not preselect a course intro");
assert(workflow.selectedIntroId === undefined, "new workflow must not have selectedIntroId before confirmation");
assert(!("selectedStoryId" in workflow), "legacy selectedStoryId must not exist in canonical workflow state");
assert(workflow.stages.LESSON_INPUT?.status === "ready", "lesson input must be persisted as a ready artifact");
assert(workflow.stages.LESSON_INPUT?.artifact?.projectId === projectId, "lesson artifact must preserve project id");
assert(workflow.stages.LESSON_INPUT?.artifact?.lessonText === lessonText, "lesson artifact must preserve full lesson text");
assert(VIDEOS_BATCH_STAGE_ORDER.length === 13, "canonical VideosBatch rail must contain 13 visible stages including lesson input and stitch");
assert(workflow.stages.COURSE_INTRO_CANDIDATES?.status === "pending", "next stage must start pending");

const session = await store.createSession({
  title: "VideosBatch workflow",
  logline: "Canonical lesson-to-video chain",
  style: "影视级3D国漫CG风格",
  targetDurationSec: 120,
  shotCount: 0
});
const updated = await store.updateSession(session.id, { videosBatchWorkflow: workflow });
assert(updated?.videosBatchWorkflow?.currentStage === "COURSE_INTRO_CANDIDATES", "canonical workflow must persist through native updateSession");

const reloadedStore = new CinemaStore();
await reloadedStore.load();
const reloaded = reloadedStore.snapshot().sessions.find((item) => item.id === session.id);
assert(reloaded?.videosBatchWorkflow?.version === 1, "workflow must round-trip through the native SeeReel store");
assert(reloaded?.videosBatchWorkflow?.stages.LESSON_INPUT?.artifact?.lessonText === lessonText, "lesson artifact must survive reload");
assert(reloaded?.videosBatchWorkflow?.introLocked === false, "intro lock state must survive reload");

process.chdir(repoRoot);
await rm(tmp, { recursive: true, force: true });
console.log("VideosBatch canonical workflow state smoke passed");
