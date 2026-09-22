import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createVideosBatchWorkflow } from "../src/shared/videosBatchWorkflow";
import { runNext, runAll, replaceStageArtifact } from "../src/server/videosBatchWorkflow/runner";
import { createPhase1FakeStageRegistry } from "../src/server/videosBatchWorkflow/stages";
import { FinalVideoStage } from "../src/client/videosBatchStudio/stages/FinalVideoStage";

const cwd = process.cwd();
const tmp = await mkdtemp(path.join(os.tmpdir(), "videosbatch-adr0003-recovery-"));
process.chdir(tmp);
try {
  const { CinemaStore, STORE_FILE } = await import("../src/server/store");
  const store = new CinemaStore(); await store.load();
  const session = await store.createSession({ title: "isolated", shotCount: 0 } as any);
  const workflow = createVideosBatchWorkflow({ projectId: "P001", lessonText: "合成教案" });
  await store.updateSession(session.id, { videosBatchWorkflow: workflow });
  const checkpoint = async (next: typeof workflow) => { await store.checkpointWorkflow(session.id, next); };
  const registry = createPhase1FakeStageRegistry();
  const original = registry.COURSE_INTRO_CANDIDATES!.execute;
  registry.COURSE_INTRO_CANDIDATES!.execute = async (ctx) => {
    const disk = JSON.parse(await readFile(STORE_FILE, "utf8"));
    assert.equal(disk.sessions.find((item: any) => item.id === ctx.session.id).videosBatchWorkflow.stages.COURSE_INTRO_CANDIDATES.status, "running");
    return original(ctx);
  };
  let ctx = { session, workflow, shots: [], assets: [], store, checkpoint };
  const save = store.save.bind(store);
  store.save = async () => { throw new Error("injected storage failure"); };
  let actualCalls = 0;
  const counted = registry.COURSE_INTRO_CANDIDATES!.execute;
  registry.COURSE_INTRO_CANDIDATES!.execute = async (input) => { actualCalls++; return counted(input); };
  await assert.rejects(runNext(ctx, registry), /injected storage failure/);
  assert.equal(actualCalls, 0);
  assert.equal(store.getSession(session.id)!.videosBatchWorkflow!.stages.COURSE_INTRO_CANDIDATES!.status, "pending");
  store.save = save;
  const intro = await runNext(ctx, registry);
  assert.equal(store.getSession(session.id)!.videosBatchWorkflow!.stages.COURSE_INTRO_CANDIDATES!.status, "ready");
  assert.equal(actualCalls, 1, "same process recovers after disk becomes available");
  const completedSession = await store.createSession({ title: "failed result save", shotCount: 0 } as any);
  await store.updateSession(completedSession.id, { videosBatchWorkflow: workflow });
  let writes = 0;
  store.save = async () => { if (++writes === 2) throw new Error("result save failed"); await save(); };
  await assert.rejects(runNext({ ...ctx, session: completedSession, checkpoint: async (next) => { await store.checkpointWorkflow(completedSession.id, next); } }, registry), /result save failed/);
  store.save = save;
  const uncertain = store.getSession(completedSession.id)!.videosBatchWorkflow!;
  assert(uncertain.stages.COURSE_INTRO_CANDIDATES!.artifact.candidates.length > 0, "completed result survives in RAM");
  const callsBefore = actualCalls;
  await runNext({ ...ctx, workflow: uncertain, checkpoint: undefined }, registry);
  assert.equal(actualCalls, callsBefore, "result-save failure cannot resubmit");
  const selected = replaceStageArtifact(intro, "COURSE_INTRO_SELECTION", {
    selectedIntroId: "A-01", selectionMode: "user_selected", selectionReason: "test", locked: true,
    confirmedEntry: intro.stages.COURSE_INTRO_CANDIDATES!.artifact.candidates[0]
  });
  ctx = { ...ctx, workflow: selected };
  let planCalls = 0;
  const plan = registry.ASSET_PLAN!.execute;
  registry.ASSET_PLAN!.execute = async (input) => { planCalls++; return plan(input); };
  await assert.rejects(runAll({ ...ctx, checkpoint: async (next) => {
    await checkpoint(next);
    if (next.stages.ASSET_PLAN?.status === "running") throw new Error("simulated process boundary");
  } }, registry), /simulated process boundary/);
  assert.equal(planCalls, 0, "checkpoint error must prevent external execute");
  const disk = JSON.parse(await readFile(STORE_FILE, "utf8"));
  assert.equal(disk.sessions.find((item: any) => item.id === session.id).videosBatchWorkflow.stages.STORY_SCRIPT.status, "ready", "preceding work must be durable");
  const reboot = new CinemaStore(); await reboot.load();
  const recovered = reboot.getSession(session.id)!.videosBatchWorkflow!;
  assert.equal(recovered.stages.ASSET_PLAN!.errorInfo!.code, "WORKFLOW_INTERRUPTED");
  assert.equal(recovered.stages.STORY_SCRIPT!.status, "ready");
  await runAll({ ...ctx, workflow: recovered, store: reboot, checkpoint: undefined }, registry);
  assert.equal(planCalls, 0, "interrupted work cannot automatically resubmit");
  const persisted = JSON.parse(await readFile(STORE_FILE, "utf8"));
  assert.equal(persisted.sessions.find((item: any) => item.id === session.id).videosBatchWorkflow.stages.ASSET_PLAN.errorInfo.code, "WORKFLOW_INTERRUPTED");

  const render = (session: any, artifact?: any) => renderToStaticMarkup(<FinalVideoStage session={session} artifact={artifact} onOpenCanvas={() => {}} />);
  const old = { id: "old", status: "ready", finalVideoUrl: "/media/old.mp4" };
  for (const status of ["running", "failed"]) {
    const markup = render({ stitchJobs: [old, { id: "new", status }] });
    assert(!markup.includes("课程视频已完成"));
    assert(markup.includes("下载上一版 MP4"));
  }
  assert(render({ stitchJobs: [old] }).includes("课程视频已完成"));
  assert(!render({ stitchJobs: [{ ...old, finalVideoStale: true }] }).includes("课程视频已完成"));
  assert(!render({ stitchJobs: [old], videosBatchWorkflow: workflow }).includes("课程视频已完成"));
  console.log("ADR0003 recovery smoke passed: checkpoints, restart, no resubmission, current/history delivery");
} finally {
  process.chdir(cwd);
  if (path.dirname(tmp) !== os.tmpdir() || !path.basename(tmp).startsWith("videosbatch-adr0003-recovery-")) throw new Error("Unexpected test directory");
  await rm(tmp, { recursive: true });
}
