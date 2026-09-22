import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import express from "express";
import { runDependencyTasks, WorkLimiter, shotDependencies } from "../src/server/productionRuns/scheduling";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await sleep(5); } assert.fail("condition timed out"); }
const order: string[] = []; let active = 0; let peak = 0;
const task = (id: string, dependencies: string[] = [], ok = true) => ({ id, dependencies,
  execute: async () => { active++; peak = Math.max(peak, active); order.push(`start:${id}`); await sleep(15); order.push(`end:${id}`); active--; return ok; },
  blocked: async () => { order.push(`blocked:${id}`); }
});
await runDependencyTasks([task("a"), task("b"), task("c", ["a"]), task("d", [], false), task("e", ["d"]), task("cycle", ["cycle"])], 2);
assert.equal(peak, 2); assert.ok(order.indexOf("start:c") > order.indexOf("end:a"));
assert.ok(order.includes("blocked:e")); assert.ok(order.includes("blocked:cycle")); assert.ok(!order.includes("start:e"));
order.length = 0;
await runDependencyTasks([{ ...task("remote-in-flight"), inFlight: true }, task("not-submitted")], 2, () => true);
assert.ok(order.includes("end:remote-in-flight")); assert.ok(order.includes("blocked:not-submitted"));
assert.ok(!order.includes("start:not-submitted"));
const limiter = new WorkLimiter(2, 1, 1, 2); active = 0; peak = 0;
await Promise.all(["a", "a", "b", "b"].map((owner, i) => limiter.run({ owner, session: String(i), provider: "model" }, async () => { active++; peak = Math.max(peak, active); await sleep(10); active--; })));
assert.equal(peak, 2);
assert.deepEqual(shotDependencies({ id: "b", index: 2, usePreviousShotClip: true, referenceVideoFromShotId: "a" } as any, [{ id: "a", index: 1 }] as any, []), ["a"]);

const originalCwd = process.cwd();
const root = await mkdtemp(path.join(os.tmpdir(), "videosbatch-scheduler-")); process.chdir(root);
const { CinemaStore } = await import("../src/server/store");
const { registerVideosBatchWorkflowApi } = await import("../src/server/videosBatchWorkflow/api");
const { createPhase1FakeStageRegistry } = await import("../src/server/videosBatchWorkflow/stages");
const { createVideosBatchWorkflow } = await import("../src/shared/videosBatchWorkflow");
const store = new CinemaStore(); await store.load(); const registry = createPhase1FakeStageRegistry();
const original = registry.COURSE_INTRO_CANDIDATES!.execute;
const entered = new Set<string>(); const releases = new Map<string, () => void>(); let running = 0; let concurrent = 0;
registry.COURSE_INTRO_CANDIDATES!.execute = async ctx => {
  running++; concurrent = Math.max(concurrent, running); entered.add(ctx.session.id);
  await new Promise<void>(resolve => releases.set(ctx.session.id, resolve)); running--;
  if (ctx.session.title === "failure") throw Object.assign(new Error("synthetic failure"), { retryable: true });
  return original(ctx);
};
const engine = registerVideosBatchWorkflowApi(express(), store, registry);
try {
  const sessions = [];
  for (const title of ["pause", "failure", "independent", "stop", "last"]) {
    const session = await store.createSession({ title, shotCount: 0 } as any, title === "failure" ? "b" : "a");
    await store.updateSession(session.id, { videosBatchWorkflow: createVideosBatchWorkflow({ projectId: title, lessonText: "教案" }) }); sessions.push(session);
  }
  const runs = [];
  for (const session of sessions) runs.push(await engine.start(session.id, "all", `start:${session.id}`));
  await engine.control(runs[4].id, "resume", "noop-resume");
  await engine.control(runs[4].id, "pause", "pause-after-noop");
  await engine.control(runs[4].id, "resume", "noop-resume");
  assert.equal(engine.repository.get(runs[4].id)?.status, "paused", "no-op receipt must prevent a late replay from resuming");
  await engine.control(runs[4].id, "resume", "fresh-resume");
  await until(() => entered.size === 2); assert.equal(concurrent, 2);
  await engine.control(runs[0].id, "pause", "pause-once");
  await engine.control(runs[3].id, "stop", "stop-once");
  releases.get(sessions[0].id)!(); releases.get(sessions[1].id)!();
  await until(() => engine.repository.get(runs[0].id)?.status === "paused");
  await until(() => engine.repository.get(runs[1].id)?.status === "failed");
  await until(() => entered.has(sessions[2].id));
  assert.ok(!entered.has(sessions[3].id)); assert.equal(engine.repository.get(runs[3].id)?.status, "cancelled");
  // Replayed pause returns the original receipt and never changes a later resume.
  await engine.control(runs[0].id, "resume", "resume-once");
  await engine.control(runs[0].id, "pause", "pause-once");
  assert.notEqual(engine.repository.get(runs[0].id)?.status, "pause_requested");
  releases.get(sessions[2].id)!(); await until(() => entered.has(sessions[4].id)); releases.get(sessions[4].id)!();
  await Promise.all(runs.map(run => engine.wait(run.id)));
  assert.equal(entered.size, 4); assert.equal(concurrent, 2); assert.equal(engine.repository.get(runs[0].id)?.status, "waiting_input");
  const limited = engine.repository;
  const parked = limited.create({ ownerId: "queue-owner", sessionId: "parked", requestKey: "q", mode: "next", inputVersion: "v", stageId: "TEST" });
  limited.update(parked.id, { status: "paused" });
  for (let i = 0; i < 50; i++) limited.create({ ownerId: "queue-owner", sessionId: `isolated-${i}`, requestKey: "q", mode: "next", inputVersion: "v", stageId: "TEST" });
  assert.throws(() => limited.create({ ownerId: "queue-owner", sessionId: "overflow", requestKey: "q", mode: "next", inputVersion: "v", stageId: "TEST" }), /队列已满/);
  assert.throws(() => limited.applyControl(parked.id, "resume-full", "resume:0", { status: "queued" }), /队列已满/);
  assert.equal(limited.get(parked.id)?.status, "paused");
  for (const run of limited.list().filter(run => run.ownerId === "queue-owner")) limited.update(run.id, { status: "cancelled" });
  // A completed pause survives reopening the control store.
  await engine.control(runs[4].id, "pause", "persist-pause");
  const pausedId = runs[4].id;
  engine.close();
  const restarted = registerVideosBatchWorkflowApi(express(), store, registry); await restarted.ready;
  assert.equal(restarted.repository.get(pausedId)?.status, "paused"); restarted.close();
  console.log(`production scheduling passed: parallel=2, dependency failure/cycle, limits, pause/resume/stop/replay/restart; ${root}`);
} finally { for (const release of releases.values()) release(); process.chdir(originalCwd); }
