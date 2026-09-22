import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import express from "express";

const [mode, directory, fault] = process.argv.slice(2);
const cwd = process.cwd();
const root = mode === "child" ? directory : await mkdtemp(path.join(os.tmpdir(), "videosbatch-runs-api-"));
process.chdir(root);
const { CinemaStore } = await import("../src/server/store");
const { registerVideosBatchWorkflowApi } = await import("../src/server/videosBatchWorkflow/api");
const { createPhase1FakeStageRegistry } = await import("../src/server/videosBatchWorkflow/stages");
const { createVideosBatchWorkflow } = await import("../src/shared/videosBatchWorkflow");
const store = new CinemaStore(); await store.load();
const registry = createPhase1FakeStageRegistry();
const original = registry.COURSE_INTRO_CANDIDATES!.execute;
let count = 0;
registry.COURSE_INTRO_CANDIDATES!.execute = async ctx => {
  count++;
  if (mode === "child") appendFileSync(path.join(root, "calls.txt"), "submitted\n");
  if (fault === "unknown") process.exit(73);
  await new Promise(resolve => setTimeout(resolve, 80));
  return original(ctx);
};
const app = express(); app.use(express.json());
const engine = registerVideosBatchWorkflowApi(app, store, registry, { authorizeSession: (session, req) => session.ownerUserId === req.header("x-user") });
await engine.ready;
if (mode === "child") {
  if (fault === "result") {
    const save = engine.repository.result.bind(engine.repository);
    engine.repository.result = (item, value) => { save(item, value); process.exit(73); };
  }
  if (fault === "projection") {
    const apply = engine.host.apply;
    engine.host.apply = async (intent, value) => { await apply(intent, value); process.exit(73); };
  }
  let session = store.snapshot().sessions[0];
  if (!session) {
    session = await store.createSession({ title: "crash", shotCount: 0 } as any, "owner");
    await store.updateSession(session.id, { videosBatchWorkflow: createVideosBatchWorkflow({ projectId: "P", lessonText: "合成教案" }) });
  }
  const run = await engine.start(session.id, "next", "one-request");
  const alias = await engine.start(session.id, "next", "second-request");
  assert.equal(alias.id, run.id);
  const done = await engine.wait(run.id);
  assert.equal((await engine.start(session.id, "next", "second-request")).id, run.id);
  writeFileSync(path.join(root, "outcome.json"), JSON.stringify({ run: done, workflow: store.getSession(session.id)?.videosBatchWorkflow }));
  engine.close();
} else {
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const session = await store.createSession({ title: "test", shotCount: 0 } as any, "owner");
  await store.updateSession(session.id, { videosBatchWorkflow: createVideosBatchWorkflow({ projectId: "P", lessonText: "合成教案" }) });
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/sessions/${session.id}/videosbatch`;
  const request = async (suffix: string, body?: unknown, owner = "owner") => {
    const res = await fetch(base + suffix, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-user": owner }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() as any };
  };
  try {
    assert.equal((await request("/runs", { mode: "next", requestId: "x" }, "intruder")).status, 404);
    assert.equal((await request("/runs", undefined, "intruder")).status, 404);
    assert.equal((await request("/runs", { mode: "oops", requestId: "x" })).status, 400);
    const first = await request("/runs", { mode: "next", requestId: "x" });
    assert.equal(first.status, 202);
    assert.equal(first.body.status, "queued");
    const duplicate = await request("/runs", { mode: "next", requestId: "x" });
    assert.equal(duplicate.body.id, first.body.id);
    const alias = await request("/runs", { mode: "next", requestId: "alias" }); assert.equal(alias.body.id, first.body.id);
    assert.equal((await request("/runs", { mode: "all", requestId: "different-mode" })).status, 409);
    const compat = await request("/run-next", {}); assert.equal(compat.status, 200);
    assert.equal(count, 1, "async and legacy must share one execution");
    const replay = await request("/runs", { mode: "next", requestId: "x" }); assert.equal(replay.body.id, first.body.id);
    assert.equal(count, 1);
    assert.equal((await request("/runs", { mode: "next", requestId: "alias" })).body.id, first.body.id);
    assert.equal((await request("/runs", { mode: "all", requestId: "x" })).status, 409);
    assert.equal(engine.repository.items(first.body.id).length, 1);
    assert.equal(engine.repository.journal.pending().length, 0);
    // An unknown attempt stays blocked for ordinary requests, but an explicit
    // restart/new workflow must not remain trapped by its historical run.
    engine.repository.update(first.body.id, { status: "reconciling" });
    assert.equal((await request("/runs", { mode: "next", requestId: "ordinary" })).body.id, first.body.id);
    const restarted = await request("/restart-from/COURSE_INTRO_CANDIDATES", {}); assert.equal(restarted.status, 200);
    assert.equal(engine.repository.get(first.body.id)?.status, "cancelled");
    const fresh = await request("/runs", { mode: "next", requestId: "explicit-new" });
    assert.notEqual(fresh.body.id, first.body.id); await engine.wait(fresh.body.id); assert.equal(count, 2);
    engine.repository.update(fresh.body.id, { status: "reconciling" });
    const reset = await request("/start", { projectId: "P", lessonText: "合成教案" }); assert.equal(reset.status, 200);
    const afterReset = await request("/run-next", {}); assert.equal(afterReset.status, 200); assert.equal(count, 3);
    engine.retireForNewIntent(session.id);
    let entered!: () => void; let release!: () => void;
    const enteredSave = new Promise<void>(resolve => { entered = resolve; });
    const releaseSave = new Promise<void>(resolve => { release = resolve; });
    // Hold the real session flight exactly where a slow reset's save can wait.
    const resetFlight = engine.host.exclusive(session.id, "test-reset-save-barrier", async () => {
      entered(); await releaseSave;
      const next = createVideosBatchWorkflow({ projectId: "P", lessonText: "合成教案" });
      next.productionIntentId = crypto.randomUUID();
      await store.updateSession(session.id, { videosBatchWorkflow: next });
      engine.retireForNewIntent(session.id);
    });
    await enteredSave;
    const old = await engine.start(session.id, "next", "race-old");
    for (let tries = 0; tries < 100 && engine.repository.get(old.id)?.status !== "running"; tries++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(engine.repository.get(old.id)?.status, "running", "old execution must be waiting behind reset");
    release(); await resetFlight;
    // Let the old host acquire the flight, reject changed input, and unwind.
    await engine.host.exclusive(session.id, "test-after-old", async () => undefined);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(engine.repository.get(old.id)?.status, "cancelled", "late error cannot revive cancelled run");
    const afterRace = await engine.start(session.id, "next", "after-race");
    assert.notEqual(afterRace.id, old.id); await engine.wait(afterRace.id); assert.equal(count, 4);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); engine.close(); process.chdir(cwd); }
  const evidence = mkdtempSync(path.join(os.tmpdir(), "videosbatch-runs-crash-"));
  for (const point of ["unknown", "result", "projection"]) {
    const dir = mkdtempSync(path.join(evidence, point));
    const child = (at: string) => spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "child", dir, at], { cwd, encoding: "utf8", timeout: 15_000, windowsHide: true });
    const crash = child(point); assert.equal(crash.status, 73, crash.stderr);
    const restored = child("recover"); assert.equal(restored.status, 0, restored.stderr);
    const outcome = JSON.parse(readFileSync(path.join(dir, "outcome.json"), "utf8"));
    assert.equal(readFileSync(path.join(dir, "calls.txt"), "utf8").trim().split("\n").length, 1, "recovery must not submit again");
    if (point === "unknown") assert.equal(outcome.run.status, "reconciling");
    else {
      assert.ok(["succeeded", "waiting_input"].includes(outcome.run.status), outcome.run.status);
      assert.equal(outcome.workflow.stages.COURSE_INTRO_CANDIDATES.revision, 1);
    }
  }
  console.log(`production runs passed: async/compat dedup, owner isolation, 3 crash boundaries without resubmit; ${evidence}`);
}
