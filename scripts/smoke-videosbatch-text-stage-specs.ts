import { strict as assert } from "node:assert";
import {
  COURSE_VIDEO_DURATION_SECONDS,
  VIDEOS_BATCH_TEXT_STAGE_IDS,
  getVideosBatchTextStageSpec
} from "../src/server/videosBatchWorkflow/textStageSpecs";

assert.deepEqual(VIDEOS_BATCH_TEXT_STAGE_IDS, [
  "COURSE_INTRO_CANDIDATES",
  "STORY_SCRIPT",
  "ASSET_PLAN",
  "SCREENPLAY",
  "FINAL_STORYBOARD",
  "COPYABLE_PROMPT"
]);
assert.deepEqual([...COURSE_VIDEO_DURATION_SECONDS], [90, 100, 110, 120, 130, 140, 150]);

const intro = getVideosBatchTextStageSpec("COURSE_INTRO_CANDIDATES");
assert.equal((intro.jsonSchema as any).properties.candidates.minItems, 9);
assert.equal((intro.jsonSchema as any).properties.candidates.maxItems, 9);
assert.equal((intro.jsonSchema as any).properties.recommendations.minItems, 3);
const introPrompt = intro.buildUserPrompt({
  stages: { LESSON_INPUT: { status: "ready", revision: 1, artifact: { projectId: "P001", lessonText: "观察物体教案" } } }
} as any);
for (const token of ["A-01", "B-01", "C-01", "200—300字", "不可信"]) assert.ok((intro.systemPrompt + introPrompt).includes(token));

const story = getVideosBatchTextStageSpec("STORY_SCRIPT");
const storyPrompt = story.buildUserPrompt({
  selectedIntroId: "A-01",
  selectionMode: "user_selected",
  selectionReason: "用户确认",
  introLocked: true,
  stages: {
    COURSE_INTRO_CANDIDATES: {
      status: "ready", revision: 1,
      artifact: { candidates: [{ id: "A-01", name: "导入", body: "正文", truthfulnessCategory: "完全虚构的故事化情境" }] }
    },
    COURSE_INTRO_SELECTION: { status: "ready", revision: 1, artifact: { selectedIntroId: "A-01", locked: true } }
  }
} as any);
assert.ok(storyPrompt.includes("600—800字"));
assert.ok(storyPrompt.includes("A-01"));
assert.ok(!storyPrompt.includes("三套导入分别扩写"));

const asset = getVideosBatchTextStageSpec("ASSET_PLAN");
const assetItem = (asset.jsonSchema as any).properties.items.items;
assert.ok(assetItem.properties.assetKey);
assert.equal(assetItem.properties.assetId, undefined);
assert.deepEqual(assetItem.properties.category.enum, ["CHARACTER", "SCENE", "PROP", "CREATURE"]);
for (const token of ["人物三视图", "统一负面提示词", "assetKey", "模型不得填写或覆盖"]) assert.ok(asset.systemPrompt.includes(token));

const screenplay = getVideosBatchTextStageSpec("SCREENPLAY");
assert.deepEqual((screenplay.jsonSchema as any).properties.targetDurationSeconds.enum, [90, 100, 110, 120, 130, 140, 150]);

const storyboard = getVideosBatchTextStageSpec("FINAL_STORYBOARD");
const segmentLayouts = (storyboard.jsonSchema as any).properties.segments.items.oneOf;
assert.equal(segmentLayouts.length, 3);
const segment = segmentLayouts.find((candidate: any) => candidate.properties.characters);
assert.ok(segment);
assert.equal(segment.properties.duration.const, 10);
assert.equal(segment.properties.visualEffects.minItems, 3);
assert.equal(segment.properties.visualEffects.maxItems, 5);
assert.equal((storyboard.jsonSchema as any).properties.segments.minItems, 9);
assert.equal((storyboard.jsonSchema as any).properties.segments.maxItems, 15);

const copyable = getVideosBatchTextStageSpec("COPYABLE_PROMPT");
assert.equal((copyable.jsonSchema as any).properties.segments.items.properties.referenceAssetIds.maxItems, 7);
assert.ok(copyable.systemPrompt.includes("派生"));
assert.ok(copyable.systemPrompt.includes("画面效果"));

console.log("VideosBatch canonical text stage specs smoke passed");
