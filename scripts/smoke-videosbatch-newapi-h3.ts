import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import http from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildNewApiH3ReferencePlan,
  compileNewApiH3Prompt,
  generateShotVideoViaNewApiH3,
  NewApiH3SubmissionStateUnknownError,
  NewApiH3ProviderError
} from "../src/server/videosBatchWorkflow/newApiH3Video";
import {
  MAX_BOUNDED_RESPONSE_TEXT_BYTES,
  readBoundedResponseBytes,
  readBoundedResponseText,
  ResponseBodyLimitError
} from "../src/server/videosBatchWorkflow/boundedResponse";
import { h3DeclaredBillingResult } from "../src/server/videosBatchWorkflow/h3ProviderErrors";
import {
  H3_MAX_REFERENCE_BYTES,
  H3_REFERENCE_FETCH_CONCURRENCY,
  H3_REFERENCE_FETCH_TIMEOUT_MS,
  h3ReferenceFile
} from "../src/server/videosBatchWorkflow/h3ReferenceMedia";

const old = {
  key: process.env.VIDEOSBATCH_H3_API_KEY,
  base: process.env.VIDEOSBATCH_H3_BASE_URL,
  allowHttp: process.env.VIDEOSBATCH_H3_ALLOW_HTTP,
  poll: process.env.VIDEOSBATCH_H3_POLL_MS,
  timeout: process.env.VIDEOSBATCH_H3_TIMEOUT_MS
};
const originalCwd = process.cwd();
const tmp = await mkdtemp(path.join(os.tmpdir(), "videosbatch-h3-smoke-"));

const shot = { id: "shot_h3_smoke", index: 1, prompt: "测试镜头", durationSec: 10 } as any;
const assets = [
  { id: "a1", sourceImageUrl: "https://example.com/a1.png" },
  { id: "a2", sourceImageUrl: "https://example.com/a2.png" }
] as any;

try {
  delete process.env.VIDEOSBATCH_H3_API_KEY;
  await assert.rejects(
    () => generateShotVideoViaNewApiH3(shot, assets),
    (error: unknown) => error instanceof NewApiH3ProviderError
      && /VIDEOSBATCH_H3_API_KEY/u.test(error.message)
      && error.code === "H3_CONFIG_INVALID"
      && error.retryable === false
      && error.billingResult === "NOT_CHARGED",
    "a missing API key must surface as an uncharged structured provider error"
  );

  process.env.VIDEOSBATCH_H3_API_KEY = "test-only-key";
  process.env.VIDEOSBATCH_H3_BASE_URL = "http://127.0.0.1:4399/v1";
  delete process.env.VIDEOSBATCH_H3_ALLOW_HTTP;
  await assert.rejects(
    () => generateShotVideoViaNewApiH3(shot, assets),
    (error: unknown) => error instanceof NewApiH3ProviderError
      && /ALLOW_HTTP=1/u.test(error.message)
      && error.code === "H3_CONFIG_INVALID"
      && error.billingResult === "NOT_CHARGED"
  );

  process.env.VIDEOSBATCH_H3_ALLOW_HTTP = "1";
  await assert.rejects(
    () => generateShotVideoViaNewApiH3(shot, [{ id: "a1", sourceImageUrl: "https://example.com/a1.png" }] as any),
    (error: unknown) => error instanceof NewApiH3ProviderError
      && /需要 2-9 张/u.test(error.message)
      && error.code === "H3_REFERENCE_PLAN_INVALID"
      && error.retryable === false
      && error.billingResult === "NOT_CHARGED",
    "reference-plan violations must be structured and provably uncharged"
  );

  // Reference-media discipline, aligned with FrameFlow's reference-media adapter:
  // a per-fetch timeout independent of the job budget, bounded parallelism, an
  // HTTPS-only URL contract, and buffering bounded by actual decoded bytes.
  assert.equal(H3_REFERENCE_FETCH_TIMEOUT_MS, 30_000, "each reference fetch must carry its own 30s timeout");
  assert.equal(H3_REFERENCE_FETCH_CONCURRENCY, 2, "reference fetches must be bounded to two in flight");
  assert.equal(H3_MAX_REFERENCE_BYTES, 20 * 1024 * 1024);
  for (const insecure of [
    "http://insecure.test/a1.png",
    "https://user:secret@credentialed.test/a1.png"
  ]) {
    await assert.rejects(
      () => h3ReferenceFile(insecure, 1),
      (error: unknown) => error instanceof NewApiH3ProviderError
        && error.code === "INVALID_REFERENCE_IMAGE"
        && error.retryable === false
        && error.billingResult === "NOT_CHARGED",
      `reference URL must be rejected before any paid work: ${insecure}`
    );
  }
  assert.equal(
    (await readBoundedResponseBytes(new Response(new Uint8Array([1, 2, 3])), 8)).length,
    3,
    "bounded reads must pass through bodies inside the limit"
  );
  await assert.rejects(
    () => readBoundedResponseBytes(new Response(new Uint8Array(16)), 8),
    (error: unknown) => error instanceof ResponseBodyLimitError,
    "bounded reads must reject by actual decoded byte count instead of buffering first"
  );
  assert.equal(await readBoundedResponseText(new Response("小错误体")), "小错误体");
  assert.equal(
    await readBoundedResponseText(new Response("x".repeat(MAX_BOUNDED_RESPONSE_TEXT_BYTES + 1))),
    null,
    "an oversized diagnostic body must degrade to null instead of buffering unbounded text"
  );

  // Billing conclusions parse from the provider's own field, in both the bare body and
  // its data wrapper. An unrecognised value must be ignored rather than coerced, so a
  // malformed field can never be read as "not charged".
  assert.equal(h3DeclaredBillingResult({ billing_result: "NOT_CHARGED" }), "NOT_CHARGED");
  assert.equal(h3DeclaredBillingResult({ data: { billingResult: "charged" } }), "CHARGED");
  assert.equal(h3DeclaredBillingResult({ billing_result: "maybe" }), undefined);
  assert.equal(h3DeclaredBillingResult({}), undefined);
  assert.equal(h3DeclaredBillingResult(null), undefined);

  let postRequests = 0;
  let contentRequests = 0;
  let conflict = false;
  let timeoutMode = false;
  let rejectedMode = false;
  let unavailableMode = false;
  let taskFailedMode = false;
  let taskFailedDeclaredMode = false;
  let hugeErrorMode = false;
  const provider = http.createServer(async (req, res) => {
    if (req.url === "/a1.png" || req.url === "/a2.png") {
      res.setHeader("content-type", "image/png");
      res.end(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/videos") {
      postRequests += 1;
      assert.match(String(req.headers["idempotency-key"]), /^videosbatch-shot_h3_/);
      for await (const _chunk of req) { /* consume multipart body */ }
      res.setHeader("content-type", "application/json");
      if (rejectedMode) {
        res.statusCode = 422;
        res.end(JSON.stringify({ error: { message: "参考图数量不合法" } }));
        return;
      }
      if (unavailableMode) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: { message: "服务暂时不可用" } }));
        return;
      }
      if (timeoutMode) {
        res.end(JSON.stringify({ task_id: "h3-timeout-task" }));
      } else if (taskFailedMode) {
        res.end(JSON.stringify({ task_id: "h3-failed-task" }));
      } else if (taskFailedDeclaredMode) {
        res.end(JSON.stringify({ task_id: "h3-failed-declared-task" }));
      } else if (hugeErrorMode) {
        res.end(JSON.stringify({ task_id: "h3-huge-error-task" }));
      } else if (conflict) {
        res.statusCode = 409;
        res.end(JSON.stringify({ detail: "idempotency_key 与其他请求冲突" }));
      } else {
        res.end(JSON.stringify({ task_id: "h3-task-1" }));
      }
      return;
    }
    if (req.method === "GET" && req.url === "/v1/videos/h3-task-1/content") {
      contentRequests += 1;
      if (contentRequests === 1) {
        res.statusCode = 202;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ status: "processing" }));
      } else {
        res.setHeader("content-type", "video/mp4");
        res.end(Buffer.from("fake-mp4-for-contract-smoke"));
      }
      return;
    }
    if (req.method === "GET" && req.url === "/v1/videos/h3-timeout-task/content") {
      res.statusCode = 202;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "processing" }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/videos/h3-failed-task/content") {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: "任务执行失败" } }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/videos/h3-failed-declared-task/content") {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: "上游已拒绝且未计费" }, billing_result: "NOT_CHARGED" }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/videos/h3-huge-error-task/content") {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: "x".repeat(70 * 1024) } }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("H3 smoke provider did not expose a TCP port");
  try {
    process.chdir(tmp);
    await mkdir(path.join(tmp, "data", "media"), { recursive: true });
    await writeFile(path.join(tmp, "data", "media", "a1.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    process.env.VIDEOSBATCH_H3_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
    process.env.VIDEOSBATCH_H3_POLL_MS = "1";
    process.env.VIDEOSBATCH_H3_TIMEOUT_MS = "5000";
    const bindingShot = {
      ...shot,
      rawPrompt: "乐乐走进展厅，镜头保持人物与场景关系。",
      assetIds: ["a2", "a1"],
      videosBatchReferenceBindings: [
        { referenceId: "CHARACTER-LELE", ordinal: 1, assetKey: "CHARACTER-LELE", assetId: "a2", semanticLabel: "乐乐" },
        { referenceId: "SCENE-MUSEUM", ordinal: 2, assetKey: "SCENE-MUSEUM", assetId: "a1", semanticLabel: "展厅" }
      ]
    } as any;
    const bindingAssets = [
      { id: "a1", name: "展厅", sourceImageUrl: "https://binding.test/scene.png" },
      { id: "a2", name: "乐乐", sourceImageUrl: "https://binding.test/character.png" }
    ] as any;
    const referencePlan = buildNewApiH3ReferencePlan(bindingShot, bindingAssets);
    assert.deepEqual(referencePlan.map((entry: any) => entry.asset.id), ["a2", "a1"], "H3 plan must honor persisted ordinal order over caller asset order");
    assert.equal(
      compileNewApiH3Prompt(bindingShot.rawPrompt, referencePlan.map((entry: any) => entry.binding)),
      "乐乐走进展厅，镜头保持人物与场景关系。\n\nReference image bindings (strict):\nImage 1 = 乐乐\nImage 2 = 展厅\nStrictly follow the Image N mapping above. Do not swap characters, scenes, props, or any reference images.\n严格按 Image N 对应图片，不得交换人物、场景和道具。"
    );
    assert.match(
      compileNewApiH3Prompt("基础提示", [{ ...referencePlan[0].binding, semanticLabel: "【人物：乐乐】" }]),
      /Image 1 = 乐乐/u,
      "H3 aliases must use the semantic name without the canonical label wrapper"
    );
    assert.throws(
      () => compileNewApiH3Prompt("基础提示 P001-A001", referencePlan.map((entry: any) => entry.binding)),
      /不得包含稳定公开资产编号/u,
      "H3 prompt must reject stable public asset ids"
    );
    const bindingOldBase = process.env.VIDEOSBATCH_H3_BASE_URL;
    const bindingOldPoll = process.env.VIDEOSBATCH_H3_POLL_MS;
    const bindingOldTimeout = process.env.VIDEOSBATCH_H3_TIMEOUT_MS;
    const bindingOriginalFetch = globalThis.fetch;
    let bindingPrompt = "";
    let bindingNames: string[] = [];
    let bindingHashes: string[] = [];
    let preparedBindings: any[] = [];
    let preparedPrompt = "";
    const bindingEvents: string[] = [];
    process.env.VIDEOSBATCH_H3_BASE_URL = "https://binding.test/v1";
    process.env.VIDEOSBATCH_H3_POLL_MS = "1";
    process.env.VIDEOSBATCH_H3_TIMEOUT_MS = "5000";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://binding.test/character.png" || url === "https://binding.test/scene.png") {
        return new Response(url.endsWith("character.png") ? new Uint8Array([2, 2, 2]) : new Uint8Array([1, 1, 1]), {
          status: 200,
          headers: { "content-type": "image/png" }
        });
      }
      if (url === "https://binding.test/v1/videos") {
        bindingEvents.push("post");
        const form = init?.body as FormData;
        bindingPrompt = String(form.get("prompt") || "");
        const files = form.getAll("images") as File[];
        bindingNames = files.map((file) => file.name);
        bindingHashes = await Promise.all(files.map(async (file) => createHash("sha256").update(Buffer.from(await file.arrayBuffer())).digest("hex")));
        return new Response(JSON.stringify({ task_id: "binding-task" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://binding.test/v1/videos/binding-task/content") {
        return new Response(Buffer.from("fake-binding-mp4"), { status: 200, headers: { "content-type": "video/mp4" } });
      }
      throw new Error(`unexpected H3 binding test URL: ${url}`);
    }) as typeof fetch;
    try {
      const bindingUrl = await generateShotVideoViaNewApiH3(bindingShot, bindingAssets, {
        onReferenceBindingsPrepared: (bindings) => {
          bindingEvents.push("prepared");
          preparedBindings = bindings;
        },
        onPromptPrepared: (prompt) => {
          preparedPrompt = prompt;
        }
      });
      assert.match(bindingUrl, /^\/media\/videosbatch-h3-/);
      assert.deepEqual(bindingEvents, ["prepared", "post"], "binding snapshot must be prepared before H3 POST");
      assert.match(bindingPrompt, /Image 1 = 乐乐\nImage 2 = 展厅/u);
      assert.equal(preparedPrompt, bindingPrompt, "the persisted provider prompt must equal the prompt sent in FormData");
      assert.doesNotMatch(bindingPrompt, /P\d{3,}-A\d{3,}/u, "stable public ids must stay out of H3 prompt");
      assert.deepEqual(bindingNames, ["reference-1.png", "reference-2.png"]);
      assert.deepEqual(bindingHashes, [
        createHash("sha256").update(Buffer.from([2, 2, 2])).digest("hex"),
        createHash("sha256").update(Buffer.from([1, 1, 1])).digest("hex")
      ], "multipart files must follow the same ordinal list as the prompt");
      assert.deepEqual(preparedBindings.map((binding) => binding.ordinal), [1, 2]);
      assert.ok(preparedBindings.every((binding) => /^[a-f0-9]{64}$/u.test(binding.imageUrlHash || "")));
      assert.deepEqual(
        preparedBindings.map((binding) => ({
          byteSize: binding.byteSize,
          mimeType: binding.mimeType,
          bytesSha256: binding.bytesSha256
        })),
        [
          { byteSize: 3, mimeType: "image/png", bytesSha256: createHash("sha256").update(Buffer.from([2, 2, 2])).digest("hex") },
          { byteSize: 3, mimeType: "image/png", bytesSha256: createHash("sha256").update(Buffer.from([1, 1, 1])).digest("hex") }
        ],
        "the persisted snapshot must content-address the exact submitted bytes"
      );
      // Once the bytes are on disk the attempt is paid for: a bookkeeping failure must
      // not read as an ordinary error, or the retry would bill a second time.
      await assert.rejects(
        () => generateShotVideoViaNewApiH3(bindingShot, bindingAssets, {
          onCharged: () => { throw new Error("billing ledger unavailable"); }
        }),
        (error: unknown) => error instanceof NewApiH3ProviderError
          && error.code === "H3_BILLING_RECORD_FAILED"
          && error.retryable === false
          && error.billingResult === "CHARGED"
          && error.taskId === "binding-task"
          && /已生成并保存/u.test(error.message),
        "a failed billing record must stay charged and non-retryable once the bytes exist"
      );
      // A URL whose bytes changed must be refused before the POST rather than silently
      // regenerating with new content; this is what the byte fingerprint is for.
      await assert.rejects(
        () => generateShotVideoViaNewApiH3(
          {
            ...bindingShot,
            videosBatchReferenceBindings: [
              { ...bindingShot.videosBatchReferenceBindings[0], bytesSha256: "0".repeat(64) },
              bindingShot.videosBatchReferenceBindings[1]
            ]
          },
          bindingAssets
        ),
        (error: unknown) => error instanceof NewApiH3ProviderError
          && error.code === "H3_REFERENCE_SNAPSHOT_MISMATCH"
          && error.retryable === false
          && error.billingResult === "NOT_CHARGED",
        "a changed byte fingerprint must fail uncharged before the paid POST"
      );
    } finally {
      globalThis.fetch = bindingOriginalFetch;
      if (bindingOldBase === undefined) delete process.env.VIDEOSBATCH_H3_BASE_URL;
      else process.env.VIDEOSBATCH_H3_BASE_URL = bindingOldBase;
      if (bindingOldPoll === undefined) delete process.env.VIDEOSBATCH_H3_POLL_MS;
      else process.env.VIDEOSBATCH_H3_POLL_MS = bindingOldPoll;
      if (bindingOldTimeout === undefined) delete process.env.VIDEOSBATCH_H3_TIMEOUT_MS;
      else process.env.VIDEOSBATCH_H3_TIMEOUT_MS = bindingOldTimeout;
    }
    const localAssets = [
      { id: "a1", sourceImageUrl: `https://invalid.example/a1.png`, imageUrl: "/media/a1.png" },
      { id: "a2", sourceImageUrl: `https://invalid.example/a2.png` }
    ] as any;
    const httpsOnlyAssets = localAssets.map((asset: any, index: number) => ({
      ...asset,
      sourceImageUrl: `https://placeholder.invalid/${index}.png`
    }));
    // The production adapter intentionally accepts only HTTPS references. Route those URLs to the local fixture.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://placeholder.invalid/")) {
        const suffix = url.endsWith("0.png") ? "missing.png" : "a2.png";
        return originalFetch(`http://127.0.0.1:${address.port}/${suffix}`, init);
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      let persistedTaskId = "";
      let chargedEvidence: { taskId?: string; billingResult?: string; byteSize?: number; mediaUrl?: string } | undefined;
      const firstUrl = await generateShotVideoViaNewApiH3(
        { ...shot, generationStartedAt: "2026-08-31T00:00:00.000Z" },
        httpsOnlyAssets,
        {
          onTaskSubmitted: async (taskId) => { persistedTaskId = taskId; },
          onCharged: (evidence) => { chargedEvidence = evidence; }
        }
      );
      assert.equal(persistedTaskId, "h3-task-1", "task id must be exposed for persistence before polling completes");
      assert.match(firstUrl, /^\/media\/videosbatch-h3-/);
      assert.equal(postRequests, 1);
      // A successful generation is a charged one. Without this the only billing
      // evidence a session produced would be its failures.
      assert.deepEqual(
        {
          taskId: chargedEvidence?.taskId,
          billingResult: chargedEvidence?.billingResult,
          mediaUrl: chargedEvidence?.mediaUrl
        },
        { taskId: "h3-task-1", billingResult: "CHARGED", mediaUrl: firstUrl },
        "a paid success must report its billing conclusion"
      );
      assert.ok((chargedEvidence?.byteSize || 0) > 0, "charged evidence must carry the submitted byte size");

      const resumedUrl = await generateShotVideoViaNewApiH3(
        { ...shot, generationTaskId: persistedTaskId, generationStartedAt: "2026-08-31T00:00:00.000Z" },
        [],
        { taskId: persistedTaskId }
      );
      assert.match(resumedUrl, /^\/media\/videosbatch-h3-/);
      assert.equal(postRequests, 1, "resuming a persisted H3 task must not submit another POST");

      // The provider may acknowledge a paid task while the local checkpoint
      // fails. The error must carry that task id so recovery can poll it rather
      // than issuing a second POST.
      let checkpointTaskId = "";
      await assert.rejects(
        () => generateShotVideoViaNewApiH3(
          { ...shot, generationStartedAt: "2026-08-31T00:00:02.000Z" },
          httpsOnlyAssets,
          {
            onTaskSubmitted: async (taskId) => {
              checkpointTaskId = taskId;
              throw new Error("local checkpoint unavailable");
            }
          }
        ),
        (error: unknown) => error instanceof NewApiH3SubmissionStateUnknownError
          && error.code === "H3_SUBMISSION_STATE_UNKNOWN"
          && error.taskId === "h3-task-1"
      );
      assert.equal(checkpointTaskId, "h3-task-1");
      assert.equal(postRequests, 2);
      const resumedAfterCheckpoint = await generateShotVideoViaNewApiH3(
        { ...shot, generationTaskId: checkpointTaskId },
        [],
        { taskId: checkpointTaskId }
      );
      assert.match(resumedAfterCheckpoint, /^\/media\/videosbatch-h3-/);
      assert.equal(postRequests, 2, "checkpoint recovery must poll the known task without a second POST");

      timeoutMode = true;
      process.env.VIDEOSBATCH_H3_TIMEOUT_MS = "500";
      await assert.rejects(
        () => generateShotVideoViaNewApiH3(
          { ...shot, generationStartedAt: "2026-08-31T00:00:03.000Z" },
          httpsOnlyAssets
        ),
        (error: unknown) => error instanceof NewApiH3ProviderError
          && error.code === "H3_POLL_TIMEOUT"
          && error.taskId === "h3-timeout-task"
          && error.retryable === true
          && error.billingResult === "UNKNOWN",
        "a poll timeout with a known task id must stay retryable and report an unknown billing outcome"
      );
      timeoutMode = false;

      // A rejected submission must prove it was not charged; a 5xx may have been
      // accepted upstream, so it must stay retryable with an unknown outcome.
      rejectedMode = true;
      await assert.rejects(
        () => generateShotVideoViaNewApiH3(
          { ...shot, generationStartedAt: "2026-08-31T00:00:04.000Z" },
          httpsOnlyAssets
        ),
        (error: unknown) => error instanceof NewApiH3ProviderError
          && error.code === "H3_SUBMISSION_REJECTED"
          && error.status === 422
          && error.retryable === false
          && error.billingResult === "NOT_CHARGED"
      );
      rejectedMode = false;

      unavailableMode = true;
      await assert.rejects(
        () => generateShotVideoViaNewApiH3(
          { ...shot, generationStartedAt: "2026-08-31T00:00:05.000Z" },
          httpsOnlyAssets
        ),
        (error: unknown) => error instanceof NewApiH3ProviderError
          && error.code === "H3_SUBMISSION_REJECTED"
          && error.status === 503
          && error.retryable === true
          && error.billingResult === "UNKNOWN",
        "a 5xx submission response cannot claim the attempt was uncharged"
      );
      unavailableMode = false;

      conflict = true;
      await assert.rejects(
        () => generateShotVideoViaNewApiH3(
          { ...shot, generationStartedAt: "2026-08-31T00:00:01.000Z" },
          httpsOnlyAssets
        ),
        (error: unknown) => error instanceof NewApiH3SubmissionStateUnknownError && error.code === "H3_SUBMISSION_STATE_UNKNOWN"
      );
      conflict = false;

      // A failure reported after the task id exists can never prove the attempt was
      // uncharged: the submission was already accepted upstream. Claiming NOT_CHARGED
      // here would authorize a duplicate paid submission, so it must stay UNKNOWN.
      taskFailedMode = true;
      await assert.rejects(
        () => generateShotVideoViaNewApiH3(
          { ...shot, generationStartedAt: "2026-08-31T00:00:06.000Z" },
          httpsOnlyAssets
        ),
        (error: unknown) => error instanceof NewApiH3ProviderError
          && error.code === "H3_TASK_FAILED"
          && error.status === 400
          && error.taskId === "h3-failed-task"
          && error.retryable === false
          && error.billingResult === "UNKNOWN"
          && error.responseMetadata?.status === 400,
        "a post-submission failure must report an unknown billing outcome, never NOT_CHARGED"
      );
      taskFailedMode = false;

      // The provider's own verdict is authoritative when it publishes one, and it only
      // ever affects accounting: it must not by itself re-open automatic retries.
      taskFailedDeclaredMode = true;
      await assert.rejects(
        () => generateShotVideoViaNewApiH3(
          { ...shot, generationStartedAt: "2026-08-31T00:00:07.000Z" },
          httpsOnlyAssets
        ),
        (error: unknown) => error instanceof NewApiH3ProviderError
          && error.code === "H3_TASK_FAILED"
          && error.billingResult === "NOT_CHARGED"
          && error.retryable === false,
        "an explicit provider billing verdict must override the local inference without loosening retry"
      );
      taskFailedDeclaredMode = false;

      // A provider streaming an oversized diagnostic body must not be able to force
      // unbounded buffering; the message degrades to the status instead.
      hugeErrorMode = true;
      await assert.rejects(
        () => generateShotVideoViaNewApiH3(
          { ...shot, generationStartedAt: "2026-08-31T00:00:08.000Z" },
          httpsOnlyAssets
        ),
        (error: unknown) => error instanceof NewApiH3ProviderError
          && error.code === "H3_TASK_FAILED"
          && /HTTP 400/u.test(error.message)
          && error.billingResult === "UNKNOWN",
        "an oversized error body must degrade to a status-derived message"
      );
      hugeErrorMode = false;
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    provider.close();
    await once(provider, "close");
  }

  console.log("VideosBatch NewAPI H3 config and recovery smoke passed");
} finally {
  process.chdir(originalCwd);
  await rm(tmp, { recursive: true, force: true });
  if (old.key === undefined) delete process.env.VIDEOSBATCH_H3_API_KEY;
  else process.env.VIDEOSBATCH_H3_API_KEY = old.key;
  if (old.base === undefined) delete process.env.VIDEOSBATCH_H3_BASE_URL;
  else process.env.VIDEOSBATCH_H3_BASE_URL = old.base;
  if (old.allowHttp === undefined) delete process.env.VIDEOSBATCH_H3_ALLOW_HTTP;
  else process.env.VIDEOSBATCH_H3_ALLOW_HTTP = old.allowHttp;
  if (old.poll === undefined) delete process.env.VIDEOSBATCH_H3_POLL_MS;
  else process.env.VIDEOSBATCH_H3_POLL_MS = old.poll;
  if (old.timeout === undefined) delete process.env.VIDEOSBATCH_H3_TIMEOUT_MS;
  else process.env.VIDEOSBATCH_H3_TIMEOUT_MS = old.timeout;
}
