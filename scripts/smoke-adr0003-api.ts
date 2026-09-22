import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import express from "express";
import { allowLocalSessionReview } from "../src/server/localSessionReview";

const local = (headers: Record<string, string> = {}, peer = "127.0.0.1", env = {}) => allowLocalSessionReview({
  header: (key: string) => ({ host: "localhost:5174", ...headers })[key], socket: { remoteAddress: peer }
} as any, env);
assert.equal(local(), true);
assert.equal(local({}, "::1"), true);
assert.equal(local({}, "203.0.113.1"), false);
assert.equal(local({ "x-forwarded-host": "localhost" }), false);
assert.equal(local({ forwarded: "for=127.0.0.1" }), false);
assert.equal(local({ host: "external.example" }), false);
assert.equal(local({}, "127.0.0.1", { NODE_ENV: "production" }), false);
assert.equal(local({}, "127.0.0.1", { APP_PUBLIC_URL: "https://external.example" }), false);
assert.equal(local({}, "127.0.0.1", { APP_PUBLIC_URL: "invalid" }), false);

const cwd = process.cwd();
const tmp = await mkdtemp(path.join(os.tmpdir(), "videosbatch-adr0003-api-"));
process.chdir(tmp);
const timeout = setTimeout(() => { console.error("ADR0003 API timeout"); process.exit(1); }, 25_000);
const { CinemaStore } = await import("../src/server/store");
const { registerVideosBatchWorkflowApi } = await import("../src/server/videosBatchWorkflow/api");
const { createPhase1FakeStageRegistry } = await import("../src/server/videosBatchWorkflow/stages");
const store = new CinemaStore(); await store.load();
const registry = createPhase1FakeStageRegistry();
const execute = registry.COURSE_INTRO_CANDIDATES!.execute;
let enter!: () => void; let release!: () => void;
const entered = new Promise<void>((r) => { enter = r; });
const gate = new Promise<void>((r) => { release = r; });
registry.COURSE_INTRO_CANDIDATES!.execute = async (ctx) => { enter(); await gate; return execute(ctx); };
const app = express(); app.use(express.json());
const productionEngine = registerVideosBatchWorkflowApi(app, store, registry, { authorizeSession: (session, req) => session.ownerUserId === req.header("x-test-user") || allowLocalSessionReview(req, {}) });
const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
const address = server.address() as { port: number };
const session = await store.createSession({ title: "isolated", shotCount: 0 } as any, "owner-a");
const base = `http://127.0.0.1:${address.port}/api/sessions/${session.id}/videosbatch`;
async function request(suffix: string, body?: unknown, method = "POST", headers = {}) {
  const response = await fetch(base + suffix, { method, headers: { "content-type": "application/json", "x-test-user": "owner-a", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
}
try {
  const a = { projectId: "P001", lessonText: "lesson A" };
  const b = { projectId: "P001", lessonText: "lesson B" };
  assert.equal((await request("/start", a)).status, 200);
  const denied = await request("", undefined, "GET", { "x-test-user": "owner-b", "x-forwarded-host": "localhost" });
  assert.equal(denied.status, 404, "forwarded header must not grant access to another owner");
  const running = request("/run-next", {}); await entered;
  assert.equal((await request("", undefined, "GET")).body.stages.COURSE_INTRO_CANDIDATES.status, "running");
  const first = request("/start", a);
  await new Promise((r) => setTimeout(r, 60));
  const second = request("/start", b);
  await new Promise((r) => setTimeout(r, 60)); release();
  await running;
  assert.equal((await first).body.stages.LESSON_INPUT.artifact.lessonText, a.lessonText);
  assert.equal((await second).body.stages.LESSON_INPUT.artifact.lessonText, b.lessonText);
  assert.equal(store.getSession(session.id)!.videosBatchWorkflow!.stages.LESSON_INPUT!.artifact.lessonText, b.lessonText);
  for (const artifact of [{}, null, { projectId: "P001", lessonText: " " }, { projectId: 1, lessonText: "valid" }]) {
    assert.equal((await request("/stages/LESSON_INPUT/artifact", { artifact }, "PUT")).status, 400);
    assert.equal(store.getSession(session.id)!.videosBatchWorkflow!.stages.LESSON_INPUT!.artifact.lessonText, b.lessonText);
  }
  assert.equal((await request("/stages/LESSON_INPUT/artifact", { artifact: a }, "PUT")).status, 200);
  const revision = store.getSession(session.id)!.videosBatchWorkflow!.stages.LESSON_INPUT!.revision;
  assert.equal((await request("/stages/LESSON_INPUT/artifact", { artifact: b, expectedRevision: revision - 1 }, "PUT")).status, 409);
  assert.equal(store.getSession(session.id)!.videosBatchWorkflow!.stages.LESSON_INPUT!.artifact.lessonText, a.lessonText);
  assert.equal((await request("/stages/LESSON_INPUT/artifact", { artifact: b, expectedRevision: revision }, "PUT")).status, 200);
  const same = await Promise.all([request("/start", a), request("/start", a)]);
  assert(same.every((r) => r.status === 200 && r.body.stages.LESSON_INPUT.artifact.lessonText === a.lessonText));
  const legacy = store.getSession(session.id)!.videosBatchWorkflow!;
  legacy.stages.LESSON_INPUT!.artifact = {};
  await store.updateSession(session.id, { videosBatchWorkflow: legacy });
  let forbiddenCalls = 0;
  registry.COURSE_INTRO_CANDIDATES!.execute = async (ctx) => { forbiddenCalls++; return execute(ctx); };
  const repaired = await request("/run-next", {});
  assert.equal(forbiddenCalls, 0);
  assert.equal(repaired.body.stages.LESSON_INPUT.status, "failed");
  assert.deepEqual(repaired.body.stages.LESSON_INPUT.artifact, {});
  assert.equal(repaired.body.currentStage, "LESSON_INPUT");
  console.log("ADR0003 API smoke passed: trust boundary, distinct starts, invalid lesson preservation");
} finally {
  release(); server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r()));
  productionEngine.close();
  clearTimeout(timeout); process.chdir(cwd);
  if (path.dirname(tmp) !== os.tmpdir() || !path.basename(tmp).startsWith("videosbatch-adr0003-api-")) throw new Error("Unexpected test directory");
  await rm(tmp, { recursive: true });
}
