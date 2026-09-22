import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const [mode, inputRoot, fault] = process.argv.slice(2);
const root = inputRoot || mkdtempSync(path.join(os.tmpdir(), "videosbatch-editing-"));
process.chdir(root);
const [{ CinemaStore }, { registerVideosBatchWorkflowApi }, { createPhase1FakeStageRegistry }, { createVideosBatchWorkflow }, { EditingService }] = await Promise.all([
  import("../src/server/store"), import("../src/server/videosBatchWorkflow/api"), import("../src/server/videosBatchWorkflow/stages"), import("../src/shared/videosBatchWorkflow"), import("../src/server/productionRuns/editingService")
]);
const store = new CinemaStore(); await store.load();
const registry = createPhase1FakeStageRegistry();
const app = express(); app.use(express.json({ limit: "1mb" }));
const engine = registerVideosBatchWorkflowApi(app, store, registry, { authorizeSession: (session, req) => session.ownerUserId === req.header("x-user") });
await engine.ready;
const service = new EditingService(engine);
const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
const origin = `http://127.0.0.1:${(server.address() as any).port}`;
const request = async (session: string, suffix: string, body?: unknown, method = "POST", user = "owner") => {
  const response = await fetch(`${origin}/api/sessions/${session}/videosbatch${suffix}`, { method, headers: { "content-type": "application/json", "x-user": user }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, value: await response.json() as any };
};
async function fixture() {
  const session = await store.createSession({ title: "编辑隔离测试", shotCount: 0 } as any, "owner");
  await store.updateSession(session.id, { videosBatchWorkflow: createVideosBatchWorkflow({ projectId: "P", lessonText: "合成教案：观察水的三态变化。" }) });
  await engine.wait((await engine.start(session.id, "next", "intro")).id);
  const workflow = store.getSession(session.id)!.videosBatchWorkflow!;
  const candidate = workflow.stages.COURSE_INTRO_CANDIDATES!.artifact.candidates[0];
  const confirmation = await service.publish(session.id, "owner", { requestId: "select", stageId: "COURSE_INTRO_SELECTION", expectedRevision: 0,
    artifact: { selectedIntroId: candidate.id, confirmedEntry: candidate, selectionMode: "user_selected", selectionReason: "测试人工选择", locked: true }, continue: true });
  await engine.wait(confirmation.continuation.runId!);
  assert.equal(store.getSession(session.id)!.videosBatchWorkflow!.stages.STORY_SCRIPT!.status, "ready");
  return session.id;
}
try {
  if (mode === "child") {
    const dataPath = path.join(root, "request.json");
    let data: any;
    if (!existsSync(dataPath)) {
      const session = await fixture(); const workflow = store.getSession(session)!.videosBatchWorkflow!;
      data = { session, request: { requestId: "crash-save", stageId: "STORY_SCRIPT", expectedRevision: workflow.stages.STORY_SCRIPT!.revision,
        artifact: { ...workflow.stages.STORY_SCRIPT!.artifact, content: workflow.stages.STORY_SCRIPT!.artifact.content + "持久保存测试。" }, continue: true } };
      writeFileSync(dataPath, JSON.stringify(data));
    } else data = JSON.parse(readFileSync(dataPath, "utf8"));
    if (fault === "prepared") {
      const project = engine.repository.journal.project.bind(engine.repository.journal);
      engine.repository.journal.project = async (id, apply) => { if (id.startsWith("edit_")) process.exit(73); await project(id, apply); };
    }
    if (fault === "json") {
      const apply = engine.host.apply;
      engine.host.apply = async (intent, value) => { await apply(intent, value); if (intent.operationId.startsWith("edit_")) process.exit(73); };
    }
    if (fault === "queue") {
      const create = engine.repository.create.bind(engine.repository);
      engine.repository.create = input => { const run = create(input); if (input.requestKey.startsWith("edit_")) process.exit(73); return run; };
    }
    const result = await service.publish(data.session, "owner", data.request);
    assert.equal(result.savedRevision, data.request.expectedRevision + 1);
    assert.equal(result.continuation.status, "queued");
    await engine.wait(result.continuation.runId!);
    const replay = await service.publish(data.session, "owner", data.request);
    assert.equal(replay.continuation.runId, result.continuation.runId);
    assert.equal(store.getSession(data.session)!.videosBatchWorkflow!.stages.STORY_SCRIPT!.revision, data.request.expectedRevision + 1);
    const runs = engine.repository.list(data.session).filter(run => run.id === result.continuation.runId);
    assert.equal(runs.length, 1);
    writeFileSync(path.join(root, "verified.json"), JSON.stringify({ fault, savedRevision: replay.savedRevision, runId: replay.continuation.runId }));
  } else {
    const session = await fixture();
    const before = structuredClone(store.getSession(session)!.videosBatchWorkflow!);
    const story = before.stages.STORY_SCRIPT!;
    const draft = { instanceId: "page-a", stageId: "STORY_SCRIPT", clientVersion: 1, baseRevision: story.revision, baseSignature: JSON.stringify(story.artifact.content), value: story.artifact.content + "草稿。" };
    assert.equal((await request(session, "/drafts/draft-a", draft, "PUT", "other")).status, 404);
    assert.equal((await request(session, "/drafts/draft-a", draft, "PUT")).status, 200);
    assert.equal((await request(session, "/drafts", undefined, "GET", "other")).status, 404);
    assert.equal((await request(session, "/drafts/draft-a", { ...draft, instanceId: "page-b" }, "PUT")).status, 409);
    assert.equal((await request(session, "/drafts/draft-a/release", { instanceId: "page-b", clientVersion: 1, discard: true })).status, 409);
    assert.equal((await request(session, "/drafts/draft-a", { ...draft, value: "out of order body" }, "PUT")).status, 409);
    engine.repository.editing.release("draft-a", "page-a", 1);
    assert.equal(engine.repository.editing.blocked(session, "ASSET_CONFIRMATION"), true, "expired/released lease does not resume unpublished work");
    assert.equal((await request(session, "/drafts/draft-a", { ...draft, instanceId: "page-b" }, "PUT")).status, 200, "offline draft can be recovered by another page");
    const edit = { requestId: "save-a", stageId: "STORY_SCRIPT", expectedRevision: story.revision, artifact: { ...story.artifact, content: draft.value }, draftId: "draft-a", instanceId: "page-b", clientVersion: 1, continue: false };
    const results = await Promise.all([request(session, "/edits", edit), request(session, "/edits", edit)]);
    assert.ok(results.every(result => result.status === 200));
    assert.equal(results[0].value.savedRevision, story.revision + 1);
    assert.equal(results[1].value.savedRevision, story.revision + 1);
    assert.equal(results[0].value.continuation.status, "none");
    assert.ok(engine.repository.list(session).every(run => run.status !== "queued" && run.status !== "running"), "save only never queues");
    assert.deepEqual(store.getSession(session)!.videosBatchWorkflow!.stages.ASSET_PLAN!.artifact, before.stages.ASSET_PLAN!.artifact, "stale descendants retain results");
    assert.equal((await request(session, "/edits", { ...edit, requestId: "stale-page", artifact: story.artifact })).status, 409);
    assert.equal((await request(session, "/edits", { ...edit, continue: true })).status, 409, "idempotency key pins complete request");
    assert.equal((await request(session, "/edits", { ...edit, requestId: "quote", stageId: "QUOTE" })).status, 400, "quote is outside editing contract");
    assert.equal((await request(session, "/drafts/draft-a", { ...draft, instanceId: "page-b" }, "PUT")).status, 409, "late heartbeat cannot reopen published draft");

    const current = store.getSession(session)!.videosBatchWorkflow!;
    const newer = { ...draft, instanceId: "page-b", clientVersion: 2, baseRevision: current.stages.STORY_SCRIPT!.revision, value: draft.value + "新修改" };
    await request(session, "/drafts/draft-a", newer, "PUT");
    engine.repository.editing.published("draft-a", "page-b", 1);
    assert.equal(engine.repository.editing.draft("draft-a")!.active, true, "late save does not release newer typing");
    engine.repository.editing.release("draft-a", "page-b", 2, true);
    await request(session, "/drafts/discard-window", { ...newer, clientVersion: 1 }, "PUT");
    assert.equal((await request(session, "/drafts/discard-window/release", { instanceId: "page-b", clientVersion: 2, discard: true })).status, 200, "discard may close acknowledged v1 while local v2 awaits debounce");
    assert.equal((await request(session, "/drafts/discard-window", { ...newer, clientVersion: 2 }, "PUT")).status, 409, "late PUT at discarded version stays closed");
    const enqueue = engine.start.bind(engine); let failed = false;
    engine.start = async (...args) => { failed = true; throw new Error("queue unavailable"); };
    const pendingRequest = { requestId: "queue-retry", stageId: "STORY_SCRIPT" as const, expectedRevision: current.stages.STORY_SCRIPT!.revision, artifact: current.stages.STORY_SCRIPT!.artifact, continue: true };
    const pending = await service.publish(session, "owner", pendingRequest);
    assert.equal(pending.continuation.status, "pending"); assert.ok(failed);
    engine.start = enqueue;
    const resumed = await service.publish(session, "owner", pendingRequest);
    assert.equal(resumed.savedRevision, pending.savedRevision); assert.equal(resumed.continuation.status, "queued");
    await engine.wait(resumed.continuation.runId!);
    const latestStory = store.getSession(session)!.videosBatchWorkflow!.stages.STORY_SCRIPT!;
    await service.publish(session, "owner", { requestId: "prepare-inflight", stageId: "STORY_SCRIPT", expectedRevision: latestStory.revision, artifact: latestStory.artifact, continue: false });
    const originalAssetPlan = registry.ASSET_PLAN!.execute;
    let releaseFlight: () => void = () => {};
    let startedFlight: () => void = () => {};
    const started = new Promise<void>(resolve => startedFlight = resolve);
    registry.ASSET_PLAN!.execute = async ctx => { startedFlight(); await new Promise<void>(resolve => releaseFlight = resolve); return originalAssetPlan(ctx); };
    const inflight = await engine.start(session, "all", "frozen-old-input");
    await started;
    const frozenStory = store.getSession(session)!.videosBatchWorkflow!.stages.STORY_SCRIPT!;
    const newContent = frozenStory.artifact.content + "新稿不能被旧结果覆盖。";
    let editResolved = false;
    const editDuringFlight = service.publish(session, "owner", { requestId: "save-during-flight", stageId: "STORY_SCRIPT", expectedRevision: frozenStory.revision, artifact: { ...frozenStory.artifact, content: newContent }, continue: false }).then(result => { editResolved = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(editResolved, false, "publishing waits for the already frozen work");
    releaseFlight(); await editDuringFlight; await engine.wait(inflight.id);
    assert.equal(store.getSession(session)!.videosBatchWorkflow!.stages.STORY_SCRIPT!.artifact.content, newContent);
    assert.equal(store.getSession(session)!.videosBatchWorkflow!.stages.ASSET_PLAN!.status, "stale", "old result is retained but cannot feed the new version");
    registry.ASSET_PLAN!.execute = originalAssetPlan;
    console.log("P4 editing API: isolation, leases, CAS, replay, retained results, enqueue compensation passed", root);
  }
} finally { server.closeAllConnections(); server.close(); await new Promise(resolve => setTimeout(resolve, 100)); engine.close(); }
if (mode !== "child") {
  for (const point of ["prepared", "json", "queue"]) {
    const directory = mkdtempSync(path.join(os.tmpdir(), `videosbatch-edit-crash-${point}-`));
    const script = fileURLToPath(import.meta.url);
    const crashed = spawnSync(process.execPath, [...process.execArgv, script, "child", directory, point], { encoding: "utf8", timeout: 30000, cwd: path.dirname(path.dirname(script)) });
    assert.equal(crashed.status, 73, crashed.stderr + crashed.stdout);
    const recovered = spawnSync(process.execPath, [...process.execArgv, script, "child", directory, "recover"], { encoding: "utf8", timeout: 30000, cwd: path.dirname(path.dirname(script)) });
    assert.equal(recovered.status, 0, recovered.stderr + recovered.stdout);
    assert.ok(existsSync(path.join(directory, "verified.json")));
    console.log("P4 true child crash/recovery passed", point, directory);
  }
}
