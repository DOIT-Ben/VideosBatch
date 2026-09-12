#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const home = await mkdtemp(path.join(os.tmpdir(), "videosbatch-worker-state-"));
process.env.VIDEOSBATCH_WORKER_HOME = home;
const state = await import(`../cli/worker-state.mjs?smoke=${Date.now()}`);

try {
  const plan = state.createWorkerPlan({
    sessionId: "session-smoke",
    stageId: "ASSET_CANDIDATES",
    units: ["asset-a", "asset-b"],
    maxConcurrentWorkers: 2,
    sourceRevision: 3,
    sourceHash: "hash-source",
    expectedOutput: "IMAGE_CANDIDATES"
  });
  assert.equal(state.nextWorkerUnits(plan).length, 2);
  const first = state.claimWorker(plan, { unitId: "asset-a", workerId: "worker-a" });
  const second = state.claimWorker(first.plan, { unitId: "asset-b", workerId: "worker-b" });
  assert.throws(() => state.claimWorker(second.plan, { unitId: "asset-a", workerId: "worker-c" }), /当前为 running/);
  const completed = state.completeWorker(second.plan, { unitId: "asset-a", workerId: "worker-a", leaseId: first.unit.leaseId, result: { candidate: "ok" } });
  const failed = state.failWorker(completed.plan, { unitId: "asset-b", workerId: "worker-b", leaseId: second.unit.leaseId, errorCode: "PROVIDER_FAILED", message: "temporary", retryable: true });
  assert.equal(state.summarizeWorkerPlan(failed.plan).counts.failed, 1);
  const reset = state.resetWorker(failed.plan, { unitId: "asset-b" });
  const retried = state.claimWorker(reset.plan, { unitId: "asset-b", workerId: "worker-b-retry" });
  const finished = state.completeWorker(retried.plan, { unitId: "asset-b", workerId: "worker-b-retry", leaseId: retried.unit.leaseId, result: { candidate: "ok" } });
  assert.equal(finished.plan.status, "complete");
  assert.equal(state.summarizeWorkerPlan(finished.plan).counts.ready, 2);
  console.log("VideosBatch Worker state smoke passed");
} finally {
  await rm(home, { recursive: true, force: true });
}
