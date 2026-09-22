import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const root = mkdtempSync(path.join(os.tmpdir(), "videosbatch-batch-")); process.chdir(root);
const [{ CinemaStore }, { registerVideosBatchWorkflowApi }, { createPhase1FakeStageRegistry }, { createVideosBatchWorkflow }] = await Promise.all([
  import("../src/server/store"), import("../src/server/videosBatchWorkflow/api"), import("../src/server/videosBatchWorkflow/stages"), import("../src/shared/videosBatchWorkflow")
]);
const store = new CinemaStore(); await store.load();
const registry = createPhase1FakeStageRegistry();
const app = express(); app.use(express.json());
const engine = registerVideosBatchWorkflowApi(app, store, registry, { authorizeSession: (session, req) => session.ownerUserId === req.header("x-user") });
const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
const url = `http://127.0.0.1:${(server.address() as any).port}/api/production/batch`;
const post = async (suffix: string, body: any) => { const response = await fetch(url + suffix, { method: "POST", headers: { "content-type": "application/json", "x-user": "owner" }, body: JSON.stringify(body) }); return { status: response.status, value: await response.json() as any }; };
try {
  const ids: string[] = [];
  for (let index = 0; index < 5; index++) {
    const session = await store.createSession({ title: `项目${index}`, shotCount: 0 } as any, index === 4 ? "private" : "owner"); ids.push(session.id);
    if (index === 3) continue;
    const workflow = createVideosBatchWorkflow({ projectId: "P", lessonText: "合成教案" });
    if (index === 2) { workflow.currentStage = "STORY_SCRIPT"; engine.repository.editing.sync({ id: "hold", ownerId: "owner", sessionId: session.id, stageId: "STORY_SCRIPT", instanceId: "editor", clientVersion: 1, baseRevision: 0, baseSignature: "", value: "未发布" }); }
    await store.updateSession(session.id, { videosBatchWorkflow: workflow });
  }
  const preview = await post("/preview", { action: "start", sessionIds: ids });
  assert.deepEqual(preview.value.map((item: any) => item.eligible), [true, true, false, false, false]);
  const start = engine.start.bind(engine); let calls = 0;
  engine.start = async (...args) => { calls++; if (args[0] === ids[1]) throw new Error("synthetic failure"); return start(...args); };
  const body = { action: "start", items: preview.value, requestId: "batch-one" };
  const result = await post("", body);
  assert.deepEqual(result.value.map((item: any) => item.ok), [true, false, false, false, false]);
  assert.equal(calls, 2);
  const replay = await post("", body); assert.deepEqual(replay.value, result.value); assert.equal(calls, 2);
  await engine.wait(result.value[0].runId);
  const pause = await post("/preview", { action: "pause", sessionIds: [ids[0]] });
  const paused = await post("", { action: "pause", items: pause.value, requestId: "pause" }); assert.equal(paused.value[0].ok, true);
  assert.equal(engine.repository.get(result.value[0].runId)!.status, "paused");
  const resume = await post("/preview", { action: "resume", sessionIds: [ids[0]] }); assert.equal(resume.value[0].eligible, false, "manual gate remains required");
  engine.start = start;
  const beforeChange = await post("/preview", { action: "start", sessionIds: [ids[1]] });
  const changed = structuredClone(store.getSession(ids[1])!.videosBatchWorkflow!); changed.stages.LESSON_INPUT!.revision++;
  await store.checkpointWorkflow(ids[1], changed);
  const stale = await post("", { action: "start", items: beforeChange.value, requestId: "stale" }); assert.equal(stale.value[0].ok, false);
  assert.match(stale.value[0].reason, /变化/);
  const beforeRace = await post("/preview", { action: "start", sessionIds: [ids[1]] });
  let release!: () => void;
  let entered!: () => void;
  const acquired = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const saving = engine.host.exclusive(ids[1], "test-save", async () => {
    entered(); await gate;
    const next = structuredClone(store.getSession(ids[1])!.videosBatchWorkflow!);
    next.stages.LESSON_INPUT!.revision++;
    await store.checkpointWorkflow(ids[1], next);
  });
  await acquired;
  const racing = post("", { action: "start", items: beforeRace.value, requestId: "race" });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(engine.repository.list(ids[1]).length, 0, "batch cannot dispatch while save owns barrier");
  release(); await saving;
  const raced = await racing;
  assert.equal(raced.value[0].ok, false); assert.match(raced.value[0].reason, /变化/);
  assert.equal(engine.repository.list(ids[1]).length, 0, "new unpreviewed version never dispatched");
  assert.equal(engine.repository.list(ids[4]).length, 0, "unauthorized item never starts");
  assert.equal((await post("/preview", { action: "start", sessionIds: Array.from({ length: 101 }, (_, i) => `${i}`) })).status, 400);
  console.log("batch controls passed: five-project eligibility, partial failure, replay, manual gate, stale preview and owner isolation", root);
} finally { server.closeAllConnections(); server.close(); await new Promise(resolve => setTimeout(resolve, 100)); engine.close(); }
