import { strict as assert } from "node:assert";
import http from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  generateShotVideoViaNewApiH3,
  NewApiH3SubmissionStateUnknownError,
  NewApiH3ProviderError
} from "../src/server/videosBatchWorkflow/newApiH3Video";

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
  await assert.rejects(() => generateShotVideoViaNewApiH3(shot, assets), /VIDEOSBATCH_H3_API_KEY/);

  process.env.VIDEOSBATCH_H3_API_KEY = "test-only-key";
  process.env.VIDEOSBATCH_H3_BASE_URL = "http://127.0.0.1:4399/v1";
  delete process.env.VIDEOSBATCH_H3_ALLOW_HTTP;
  await assert.rejects(() => generateShotVideoViaNewApiH3(shot, assets), /ALLOW_HTTP=1/);

  process.env.VIDEOSBATCH_H3_ALLOW_HTTP = "1";
  await assert.rejects(() => generateShotVideoViaNewApiH3(shot, [{ id: "a1", sourceImageUrl: "https://example.com/a1.png" }] as any), /需要 2-9 张/);

  let postRequests = 0;
  let contentRequests = 0;
  let conflict = false;
  let timeoutMode = false;
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
      if (timeoutMode) {
        res.end(JSON.stringify({ task_id: "h3-timeout-task" }));
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
      const firstUrl = await generateShotVideoViaNewApiH3(
        { ...shot, generationStartedAt: "2026-08-31T00:00:00.000Z" },
        httpsOnlyAssets,
        { onTaskSubmitted: async (taskId) => { persistedTaskId = taskId; } }
      );
      assert.equal(persistedTaskId, "h3-task-1", "task id must be exposed for persistence before polling completes");
      assert.match(firstUrl, /^\/media\/videosbatch-h3-/);
      assert.equal(postRequests, 1);

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
      );
      timeoutMode = false;

      conflict = true;
      await assert.rejects(
        () => generateShotVideoViaNewApiH3(
          { ...shot, generationStartedAt: "2026-08-31T00:00:01.000Z" },
          httpsOnlyAssets
        ),
        (error: unknown) => error instanceof NewApiH3SubmissionStateUnknownError && error.code === "H3_SUBMISSION_STATE_UNKNOWN"
      );
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
