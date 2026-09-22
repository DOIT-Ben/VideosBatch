import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunCursor, RunPacket } from "../src/shared/productionRuns";
import { ProductionRunStore } from "../src/client/productionCenter/runStore";
import { engineTracksShot, managedExecutionSessions, readRunStream, ViewSyncQueue } from "../src/client/productionCenter/synchronization";
let idleCancelled = false;
await assert.rejects(readRunStream(new ReadableStream({ cancel() { idleCancelled = true; } }), new AbortController().signal, () => assert.fail("no packet expected"), () => assert.fail("headers alone are not activity"), 25), /HEARTBEAT_TIMEOUT/);
assert.ok(idleCancelled, "half-open stream must release the reader for reconnect/fallback");
let readAttempts = 0; let applied = ""; let clock = 0;
const retryViews = new ViewSyncQueue(async () => { if (++readAttempts === 1) throw new Error("temporary read failure"); return "saved result"; }, (_id, result) => applied = result, () => true, () => clock, 10);
retryViews.mark("a"); retryViews.pump(); await new Promise(resolve => setTimeout(resolve, 0));
retryViews.pump(); assert.equal(readAttempts, 1, "failed reads use bounded backoff");
clock = 11; retryViews.pump(); await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(applied, "saved result", "terminal result retries without any newer event"); retryViews.stop();
const trackingSession = { id: "s", videosBatchWorkflow: { stages: { FINAL_STORYBOARD: { artifact: { segments: [{ nativeShotId: "managed" }] } } } } } as any;
const trackingRun = { sessionId: "s", stageId: "EXECUTION", status: "running" } as any;
const managed = managedExecutionSessions([trackingRun]);
assert.equal(engineTracksShot({ id: "managed", sessionId: "s" } as any, [trackingSession], managed), true);
assert.equal(engineTracksShot({ id: "manual-old-batch", sessionId: "s", videosBatchBatchId: "old" } as any, [trackingSession], managed), false);
assert.equal(engineTracksShot({ id: "managed", sessionId: "s", videosBatchBatchId: "current" } as any, [trackingSession], managedExecutionSessions([{ ...trackingRun, status: "succeeded" }])), false, "manual generation after a run still needs pollShot");
assert.equal(engineTracksShot({ id: "managed", sessionId: "s", videosBatchBatchId: "current", generationTaskId: "manual-known-task" } as any, [trackingSession], managedExecutionSessions([{ ...trackingRun, status: "reconciling" }])), false, "a reconciling engine does not poll a manually submitted known task");
const cwd = process.cwd(); const directory = await mkdtemp(path.join(os.tmpdir(), "videosbatch-events-")); process.chdir(directory);
const [{ CinemaStore }, { registerVideosBatchWorkflowApi }, { createPhase1FakeStageRegistry }, { createVideosBatchWorkflow }] = await Promise.all([
  import("../src/server/store"), import("../src/server/videosBatchWorkflow/api"), import("../src/server/videosBatchWorkflow/stages"), import("../src/shared/videosBatchWorkflow")
]);
const store = new CinemaStore(); await store.load(); const registry = createPhase1FakeStageRegistry();
let release: () => void = () => {}; let calls = 0; let previewed = false;
const original = registry.COURSE_INTRO_CANDIDATES!.execute;
registry.COURSE_INTRO_CANDIDATES!.validatePreview = block => block.text.endsWith("。");
registry.COURSE_INTRO_CANDIDATES!.execute = async ctx => {
  calls++;
  await ctx.previewCheckpoint?.({ id: "one", text: "第一段完整预览。" });
  await ctx.previewCheckpoint?.({ id: "broken", text: '{"unfinished":' });
  await ctx.previewCheckpoint?.({ id: "two", text: "第二段完整预览。" });
  previewed = true; await new Promise<void>(resolve => release = resolve);
  return original(ctx);
};
const app = express(); app.use(express.json());
const engine = registerVideosBatchWorkflowApi(app, store, registry, { authorizeSession: (session, req) => session.ownerUserId === req.header("x-user") });
const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
const url = `http://127.0.0.1:${(server.address() as any).port}`;
const get = async (suffix: string, user = "a") => { const response = await fetch(url + suffix, { headers: { "x-user": user } }); return { status: response.status, value: await response.json() as any }; };
const packet = async (cursor?: RunCursor, user = "a") => {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(`${url}/api/production/events${cursor ? `?cursor=${encodeURIComponent(JSON.stringify(cursor))}` : ""}`, { headers: { "x-user": user, "Accept-Encoding": "gzip" }, signal: controller.signal });
    assert.match(response.headers.get("cache-control") || "", /no-transform/);
    const reader = response.body!.getReader(); let text = "";
    while (!text.split("\n\n").slice(0, -1).some(frame => frame.startsWith("data: "))) { const part = await reader.read(); text += new TextDecoder().decode(part.value); }
    return JSON.parse(text.split("\n\n").find(frame => frame.startsWith("data: "))!.slice(6)) as RunPacket;
  } finally { controller.abort(); clearTimeout(timer); }
};
try {
  const a = await store.createSession({ title: "a", shotCount: 0 } as any, "a");
  const b = await store.createSession({ title: "b", shotCount: 0 } as any, "b");
  for (const session of [a, b]) await store.updateSession(session.id, { videosBatchWorkflow: createVideosBatchWorkflow({ projectId: session.id, lessonText: "test" }) });
  const before = (await get("/api/production/snapshot")).value as RunPacket;
  const run = await engine.start(a.id, "next", "start");
  for (let i = 0; !previewed && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(previewed); assert.equal(store.getSession(a.id)?.videosBatchWorkflow?.stages.COURSE_INTRO_CANDIDATES?.status, "running");
  const previewRef = engine.repository.get(run.id)!.feedback!.previewRef!;
  const preview = await get(`/api/sessions/${a.id}/videosbatch/previews/${previewRef}`);
  assert.deepEqual(preview.value.blocks.map((block: any) => block.id), ["one", "two"]);
  assert.equal((await get(`/api/sessions/${a.id}/videosbatch/previews/${previewRef}`, "b")).status, 404);
  const delta = await packet(before.cursor); assert.equal(delta.kind, "delta");
  const client = new ProductionRunStore(); client.apply(before); assert.notEqual(client.apply(delta), false);
  assert.deepEqual(client.apply(delta), [], "duplicate packet must not trigger refetch");
  const alien = await packet(before.cursor, "b"); assert.equal(alien.kind, "snapshot");
  assert.equal(alien.kind === "snapshot" ? alien.runs.length : -1, 0);
  release(); await engine.wait(run.id);
  await engine.control(run.id, "stop", "stop-plan");
  const terminal = await packet(client.cursor); assert.notEqual(client.apply(terminal), false);
  assert.equal(client.latest(a.id)?.status, "cancelled"); assert.equal(calls, 1);
  assert.equal(client.apply(delta), false, "old/out-of-order packet requires a resync");
  const snapshot = (await get("/api/production/snapshot")).value; client.apply(snapshot);
  engine.repository.update(run.id, { priority: 1 });
  const missing = await packet(client.cursor);
  engine.repository.update(run.id, { priority: 2 });
  const afterGap = await packet(missing.cursor);
  assert.equal(client.apply(afterGap), false, "missing packet must not silently replace current state");
  const current = engine.repository.cursor("a");
  engine.repository.journal.db.prepare("DELETE FROM run_events WHERE ownerId=? AND sequence<?").run("a", current);
  assert.equal((await packet(before.cursor)).kind, "snapshot", "expired cursor must resync");
  assert.equal((await get(`/api/sessions/${a.id}/videosbatch/view`, "b")).status, 404);
  assert.equal(calls, 1, "reconnect and snapshot are read-only");
  console.log(`production events passed: SSE race, owner isolation, duplicate/order/gap/expiry/terminal reconnect, validated previews; ${directory}`);
} finally { release(); engine.close(); server.closeAllConnections(); server.close(); process.chdir(cwd); }
