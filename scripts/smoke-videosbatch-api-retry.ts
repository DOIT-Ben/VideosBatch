import { strict as assert } from "node:assert";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";

const originalCwd = process.cwd();
const tmp = await mkdtemp(path.join(os.tmpdir(), "videosbatch-api-retry-"));
process.chdir(tmp);

try {
  const [{ CinemaStore }, workflowModule, runnerModule, stageModule, apiModule, textStages] = await Promise.all([
    import("../src/server/store"),
    import("../src/shared/videosBatchWorkflow"),
    import("../src/server/videosBatchWorkflow/runner"),
    import("../src/server/videosBatchWorkflow/stages"),
    import("../src/server/videosBatchWorkflow/api"),
    import("../src/server/videosBatchWorkflow/llmTextStages")
  ]);

  const store = new CinemaStore();
  await store.load();
  const validIntro = {
    candidates: ["A-01", "A-02", "A-03", "B-01", "B-02", "B-03", "C-01", "C-02", "C-03"].map((id, index) => {
      const directions = [
        "原始问题与知识产生", "可靠史实与时代背景", "方法工具演变", "古代真实需求", "古今对照",
        "现代工程科技应用", "生活冲突与错误现场", "推理游戏挑战", "科技或自然异常"
      ];
      return {
        id,
        name: `导入${id}`,
        creativeType: directions[index],
        body: `${directions[index]}：学生围绕真实问题观察、比较和推理，冲突逐步升级，本课数学知识成为关键线索，但导入阶段不提前揭示结论。`.repeat(4).slice(0, 260),
        endingQuestion: "究竟应该怎样解决这个问题？",
        truthfulnessCategory: "完全虚构的故事化情境",
        truthfulnessNote: "用于 API 重试契约测试的虚构教学情境。"
      };
    }),
    recommendations: [
      { id: "A-01", reason: "课堂吸引力强，知识连接清晰，适合视频制作。" },
      { id: "B-01", reason: "课堂真实需求明确，便于自然引出知识。" },
      { id: "C-01", reason: "冲突直观，学生容易代入，适合视频制作。" }
    ]
  };

  let executeCalls = 0;
  let concurrentSessionId = "";
  let concurrentCalls = 0;
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const registry = stageModule.createPhase1FakeStageRegistry();
  registry.COURSE_INTRO_CANDIDATES = {
    id: "COURSE_INTRO_CANDIDATES",
    async execute(ctx) {
      if (ctx.session.id === concurrentSessionId) {
        concurrentCalls += 1;
        await delay(100);
        return { artifact: structuredClone(validIntro) };
      }
      executeCalls += 1;
      if (executeCalls === 1) return { artifact: { ...validIntro, candidates: validIntro.candidates.slice(0, 8) } };
      return { artifact: structuredClone(validIntro) };
    },
    validate(artifact, ctx) {
      return textStages.validateVideosBatchTextStage("COURSE_INTRO_CANDIDATES", artifact, ctx);
    }
  };

  // Keep a deliberately failing projection definition so this smoke can prove
  // the API's two-phase save contract: the canonical edit is persisted before
  // a native projection is attempted, and remains inspectable when projection
  // fails.
  registry.FINAL_STORYBOARD = {
    id: "FINAL_STORYBOARD",
    async execute() {
      return { artifact: {} };
    },
    validate() {
      return { ok: true, errors: [] };
    },
    async project() {
      throw Object.assign(new Error("injected native projection failure"), {
        code: "INJECTED_PROJECTION_FAILURE",
        retryable: true
      });
    }
  };

  const app = express();
  app.use(express.json());
  apiModule.registerVideosBatchWorkflowApi(app, store, registry, {
    authorizeSession: (session, req) => !session.ownerUserId || session.ownerUserId === req.header("x-test-user")
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("retry API smoke server did not expose a TCP port");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function request<T>(url: string, init?: RequestInit) {
    const response = await fetch(`${baseUrl}${url}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers || {}) }
    });
    const body = await response.json().catch(() => undefined);
    return { response, body: body as T };
  }

  try {
    const created = await store.createSession({ title: "VideosBatch retry API smoke", logline: "retry", style: "test", targetDurationSec: 90, shotCount: 0 });
    const started = await request<any>(`/api/sessions/${created.id}/videosbatch/start`, {
      method: "POST",
      body: JSON.stringify({ projectId: "P001", lessonText: "完整教案：观察物体。" })
    });
    assert.equal(started.response.status, 200);

    const failed = await request<any>(`/api/sessions/${created.id}/videosbatch/run-next`, { method: "POST", body: "{}" });
    assert.equal(failed.response.status, 200);
    assert.equal(failed.body.stages.COURSE_INTRO_CANDIDATES.status, "failed");
    const failedStage = failed.body.stages.COURSE_INTRO_CANDIDATES;
    assert.equal(typeof failedStage.sourceRevision, "number");
    assert.match(String(failedStage.sourceHash), /^[a-f0-9]{64}$/);
    assert.match(String(failedStage.sourceRevisions.LESSON_INPUT), /^\d+$/);

    const missingLineage = await request<any>(`/api/sessions/${created.id}/videosbatch/retry/COURSE_INTRO_CANDIDATES`, {
      method: "POST",
      body: JSON.stringify({})
    });
    assert.equal(missingLineage.response.status, 409);
    assert.equal(missingLineage.body.error.code, "RETRY_LINEAGE_CONFLICT");
    assert.equal(missingLineage.body.error.retryable, false);
    assert.equal(typeof missingLineage.body.error.attempt, "number");

    const retried = await request<any>(`/api/sessions/${created.id}/videosbatch/retry/COURSE_INTRO_CANDIDATES`, {
      method: "POST",
      body: JSON.stringify({
        sourceRevision: failedStage.sourceRevision,
        sourceHash: failedStage.sourceHash,
        sourceHashes: failedStage.sourceHashes
      })
    });
    assert.equal(retried.response.status, 200);
    assert.equal(retried.body.stages.COURSE_INTRO_CANDIDATES.status, "ready");
    assert.equal(retried.body.currentStage, "COURSE_INTRO_SELECTION");
    assert.equal(executeCalls, 2);

    const manualSave = await request<any>(`/api/sessions/${created.id}/videosbatch/stages/COURSE_INTRO_SELECTION/artifact`, {
      method: "PUT",
      body: JSON.stringify({
        artifact: {
          selectedIntroId: "A-01",
          selectionMode: "user_selected",
          selectionReason: "人工保存 API 合同验证",
          locked: true
        }
      })
    });
    assert.equal(manualSave.response.status, 200);
    assert.equal(manualSave.body.stages.COURSE_INTRO_SELECTION.status, "ready");
    assert.equal(manualSave.body.stages.COURSE_INTRO_SELECTION.artifact.selectionReason, "人工保存 API 合同验证");
    assert.match(String(manualSave.body.stages.COURSE_INTRO_SELECTION.contentHash), /^[a-f0-9]{64}$/);

    const canonicalEdit = {
      schemaVersion: "2",
      kind: "VIDEO_STORYBOARD",
      title: "投影失败仍应保留的最终分镜",
      goal: "canonical edit sentinel",
      storyType: "STORY",
      targetDuration: 90,
      segments: []
    };
    const failedProjection = await request<any>(`/api/sessions/${created.id}/videosbatch/stages/FINAL_STORYBOARD/artifact`, {
      method: "PUT",
      body: JSON.stringify({ artifact: canonicalEdit })
    });
    assert.equal(failedProjection.response.status, 500);
    assert.equal(failedProjection.body.error.code, "FINAL_STORYBOARD_PROJECTION_FAILED");
    assert.equal(failedProjection.body.error.retryable, true);

    const afterProjectionFailure = await request<any>(`/api/sessions/${created.id}/videosbatch`);
    assert.equal(afterProjectionFailure.response.status, 200);
    assert.equal(afterProjectionFailure.body.stages.FINAL_STORYBOARD.status, "ready");
    assert.equal(afterProjectionFailure.body.stages.FINAL_STORYBOARD.artifact.goal, "canonical edit sentinel");
    assert.match(String(afterProjectionFailure.body.stages.FINAL_STORYBOARD.contentHash), /^[a-f0-9]{64}$/);

    const manualRetry = await request<any>(`/api/sessions/${created.id}/videosbatch/retry/COURSE_INTRO_SELECTION`, {
      method: "POST",
      body: JSON.stringify({})
    });
    assert.equal(manualRetry.response.status, 409);
    assert.equal(manualRetry.body.error.code, "STAGE_RETRY_NOT_ALLOWED");

    const owned = await store.createSession({ title: "Owned session", logline: "", style: "test", targetDurationSec: 90, shotCount: 0 }, "owner-a");
    const denied = await request<any>(`/api/sessions/${owned.id}/videosbatch/start`, {
      method: "POST",
      body: JSON.stringify({ projectId: "P001", lessonText: "不应被其他用户读取" }),
      headers: { "x-test-user": "owner-b" }
    });
    assert.equal(denied.response.status, 404, "owned workflow must reject another user's request");
    const allowed = await request<any>(`/api/sessions/${owned.id}/videosbatch/start`, {
      method: "POST",
      body: JSON.stringify({ projectId: "P001", lessonText: "归属校验" }),
      headers: { "x-test-user": "owner-a" }
    });
    assert.equal(allowed.response.status, 200);

    const concurrent = await store.createSession({ title: "Concurrent session", logline: "", style: "test", targetDurationSec: 90, shotCount: 0 });
    concurrentSessionId = concurrent.id;
    const concurrentStart = await request<any>(`/api/sessions/${concurrent.id}/videosbatch/start`, {
      method: "POST",
      body: JSON.stringify({ projectId: "P001", lessonText: "并发单飞" })
    });
    assert.equal(concurrentStart.response.status, 200);
    const concurrentResults = await Promise.all([
      request<any>(`/api/sessions/${concurrent.id}/videosbatch/run-next`, { method: "POST", body: "{}" }),
      request<any>(`/api/sessions/${concurrent.id}/videosbatch/run-next`, { method: "POST", body: "{}" })
    ]);
    assert.deepEqual(concurrentResults.map((item) => item.response.status), [200, 200]);
    assert.equal(concurrentCalls, 1, "concurrent run-next requests must share one in-flight execution");
    assert.ok(concurrentResults.every((item) => item.body.currentStage === "COURSE_INTRO_SELECTION"));

    const persisted = store.getSession(created.id)?.videosBatchWorkflow;
    assert.equal(persisted?.stages.COURSE_INTRO_CANDIDATES?.status, "ready");

    const projectionWorkflow = workflowModule.createVideosBatchWorkflow({ projectId: "P001", lessonText: "投影错误保留产物" });
    projectionWorkflow.currentStage = "FINAL_STORYBOARD";
    projectionWorkflow.stages.SCREENPLAY = { status: "ready", revision: 1, artifact: {} };
    projectionWorkflow.stages.ASSET_CONFIRMATION = { status: "ready", revision: 1, artifact: {} };
    const projectionRegistry: any = {
      FINAL_STORYBOARD: {
        id: "FINAL_STORYBOARD",
        async execute() { return { artifact: { sentinel: "keep-me" } }; },
        validate() { return { ok: true, errors: [] }; },
        async project() { throw Object.assign(new Error("projection failed"), { code: "PROJECTION_FAILED", retryable: true }); }
      }
    };
    const projectionSession: any = { id: "ses_projection", shots: [], videosBatchWorkflow: projectionWorkflow };
    const projectionResult = await runnerModule.runNext({ session: projectionSession, workflow: projectionWorkflow, assets: [], shots: [] }, projectionRegistry);
    assert.equal(projectionResult.stages.FINAL_STORYBOARD.status, "failed");
    assert.equal(projectionResult.stages.FINAL_STORYBOARD.artifact.sentinel, "keep-me", "projection failure must retain generated artifact");

    const telemetryWorkflow = workflowModule.createVideosBatchWorkflow({ projectId: "P001", lessonText: "错误证据保留" });
    const telemetryError = Object.assign(new Error("provider timeout"), {
      code: "TIMEOUT",
      retryable: true,
      attempt: 3,
      attempts: 3,
      provider: "openai-responses",
      model: "test-model",
      attemptLog: [
        { attempt: 1, provider: "openai-responses", model: "test-model", outcome: "error", errorCode: "TIMEOUT" },
        { attempt: 2, provider: "openai-responses", model: "test-model", outcome: "error", errorCode: "TIMEOUT" },
        { attempt: 3, provider: "openai-responses", model: "test-model", outcome: "error", errorCode: "TIMEOUT" }
      ]
    });
    const telemetryResult = await runnerModule.runNext(
      { session: { id: "ses_telemetry", shots: [], videosBatchWorkflow: telemetryWorkflow }, workflow: telemetryWorkflow, assets: [], shots: [] },
      { COURSE_INTRO_CANDIDATES: { id: "COURSE_INTRO_CANDIDATES", async execute() { throw telemetryError; }, validate() { return { ok: true, errors: [] }; } } }
    );
    assert.equal(telemetryResult.stages.COURSE_INTRO_CANDIDATES.status, "failed");
    assert.equal(telemetryResult.stages.COURSE_INTRO_CANDIDATES.attempts, 3);
    assert.equal(telemetryResult.stages.COURSE_INTRO_CANDIDATES.attemptLog.length, 3);
  } finally {
    server.close();
    await once(server, "close");
  }

  console.log("VideosBatch retry API smoke passed");
} finally {
  process.chdir(originalCwd);
  await rm(tmp, { recursive: true, force: true });
}
