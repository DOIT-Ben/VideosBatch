#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  dispatchLocalWorker,
  finalizeLocalRun,
  loadLocalRun,
  localRunNext,
  prepareLocalRun,
  persistLocalWorkerDispatch,
  recordLocalWorker,
  saveLocalStageArtifact
} from "../cli/local-runtime.mjs";

const runDir = await mkdtemp(path.join(os.tmpdir(), "videosbatch-local-runtime-"));
try {
  await prepareLocalRun({ lessonText: "小学数学教案：观察、比较和判断。", outDir: runDir, maxConcurrentWorkers: 2, executorMode: "fake", mediaMode: "fake" });
  assert.equal((await localRunNext(runDir)).nextStage, "COURSE_INTRO_SELECTION");
  await saveLocalStageArtifact(runDir, "COURSE_INTRO_SELECTION", { selectedIntroId: "A-01", selectionMode: "user_selected", selectionReason: "Smoke", locked: true });
  await localRunNext(runDir);
  await localRunNext(runDir);
  const dispatchStage = await localRunNext(runDir);
  assert.equal(dispatchStage.status, "dispatch");
  const state = await loadLocalRun(runDir);
  const stage = state.jobs.stages.ASSET_CANDIDATES;
  for (const unit of stage.units) {
    const dispatch = dispatchLocalWorker(state, { unitId: unit.unitId, workerId: `smoke-${unit.unitId}` });
    await persistLocalWorkerDispatch(state, dispatch);
    const result = { status: "ready", candidateAssetId: `asset_${unit.unitId}`, sourceRevision: state.manifest.stages.ASSET_PLAN.revision, sourceHash: state.manifest.stages.ASSET_PLAN.contentHash };
    recordLocalWorker(state, { unitId: unit.unitId, workerId: dispatch.unit.workerId, leaseId: dispatch.unit.leaseId, result });
    await writeFile(path.join(runDir, "worker_jobs.json"), `${JSON.stringify(state.jobs, null, 2)}\n`, "utf8");
  }
  await localRunNext(runDir);
  const candidates = await loadLocalRun(runDir);
  const candidateItems = candidates.manifest.stages.ASSET_CANDIDATES;
  const candidateArtifact = JSON.parse(await readFile(path.join(runDir, candidateItems.artifactPath), "utf8"));
  await saveLocalStageArtifact(runDir, "ASSET_CONFIRMATION", { confirmed: true, items: candidateArtifact.items.map((item) => ({ assetKey: item.assetKey, selectedAssetId: item.candidateAssetIds[0], publicAssetId: item.publicAssetId })) });
  let result;
  for (let index = 0; index < 20; index += 1) {
    result = await localRunNext(runDir, { autoWorkers: true, autoFake: true });
    if (result.status === "complete") break;
  }
  assert.equal(result?.status, "complete");
  const final = await finalizeLocalRun(runDir);
  assert.match(final.finalPath, /FINAL_DELIVERY\.json$/u);
  console.log("VideosBatch local runtime smoke passed");
} finally {
  await rm(runDir, { recursive: true, force: true });
}
