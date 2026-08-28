import assert from "node:assert/strict";
import { VIDEOS_BATCH_PRODUCT_STEPS, productStepForStage } from "../src/client/videosBatchStudio/stageModel";

assert.equal(VIDEOS_BATCH_PRODUCT_STEPS.length, 9, "product UI must group the canonical workflow into 9 user-facing steps");
assert.deepEqual(
  VIDEOS_BATCH_PRODUCT_STEPS.map((step) => step.label),
  ["教案", "课程导入", "故事文稿", "资产计划", "资产图片", "视频剧本", "视频分镜", "视频生成", "最终成片"]
);
assert.equal(productStepForStage("COURSE_INTRO_CANDIDATES"), "intro");
assert.equal(productStepForStage("COURSE_INTRO_SELECTION"), "intro");
assert.equal(productStepForStage("ASSET_CANDIDATES"), "assets");
assert.equal(productStepForStage("ASSET_CONFIRMATION"), "assets");
assert.equal(productStepForStage("FINAL_STORYBOARD"), "storyboard");
assert.equal(productStepForStage("COPYABLE_PROMPT"), "storyboard");
assert.equal(productStepForStage("QUOTE"), "execution");
assert.equal(productStepForStage("EXECUTION"), "execution");
assert.equal(productStepForStage("STITCH"), "final");

console.log("VideosBatch product UI foundation smoke: PASS");
