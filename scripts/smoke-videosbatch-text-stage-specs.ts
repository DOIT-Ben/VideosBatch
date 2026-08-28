import { strict as assert } from "node:assert";
import {
  VIDEOS_BATCH_TEXT_STAGE_IDS,
  getVideosBatchTextStageSpec
} from "../src/server/videosBatchWorkflow/textStageSpecs";

assert.deepEqual(VIDEOS_BATCH_TEXT_STAGE_IDS, [
  "INTRO_GENERATION",
  "STORY_EXPANSION",
  "ASSET_PROMPT_GENERATION",
  "SCREENPLAY_GENERATION",
  "STORYBOARD_GENERATION"
]);
assert.ok(!VIDEOS_BATCH_TEXT_STAGE_IDS.includes("REFERENCE_BINDING" as any), "stable-reference binding must remain deterministic");

const intro = getVideosBatchTextStageSpec("INTRO_GENERATION");
assert.equal((intro.jsonSchema as any).properties.candidates.minItems, 9);
assert.equal((intro.jsonSchema as any).properties.candidates.maxItems, 9);
assert.equal((intro.jsonSchema as any).properties.recommendations.minItems, 3);
const introPrompt = intro.buildUserPrompt({
  projectId: "P001",
  lessonText: "观察物体教案",
  selectedStoryId: undefined,
  stages: {}
} as any);
for (const token of ["A1", "A2", "A3", "B1", "B2", "B3", "C1", "C2", "C3", "200—300字"]) {
  assert.ok(introPrompt.includes(token), `intro prompt must preserve ${token}`);
}

const story = getVideosBatchTextStageSpec("STORY_EXPANSION");
assert.equal((story.jsonSchema as any).properties.stories.minItems, 3);
assert.equal((story.jsonSchema as any).properties.stories.maxItems, 3);
const storyPrompt = story.buildUserPrompt({
  projectId: "P001",
  lessonText: "观察物体教案",
  stages: {
    INTRO_GENERATION: {
      status: "ready",
      revision: 1,
      artifact: {
        candidates: [
          { id: "A1", name: "导入A1", body: "正文A1" },
          { id: "B1", name: "导入B1", body: "正文B1" },
          { id: "C1", name: "导入C1", body: "正文C1" }
        ],
        recommendations: [
          { id: "A1", reason: "推荐" },
          { id: "B1", reason: "推荐" },
          { id: "C1", reason: "推荐" }
        ]
      }
    }
  }
} as any);
assert.ok(storyPrompt.includes("600—800字"));
assert.ok(storyPrompt.includes("导入A1"));

const asset = getVideosBatchTextStageSpec("ASSET_PROMPT_GENERATION");
const assetPrompt = asset.buildUserPrompt({
  projectId: "P001",
  lessonText: "教案",
  selectedStoryId: "story-1",
  stages: {
    STORY_EXPANSION: {
      status: "ready",
      revision: 1,
      artifact: {
        stories: [{ id: "story-1", title: "故事1", content: "完整故事正文" }]
      }
    }
  }
} as any);
assert.ok(assetPrompt.includes("P001-A001"));
assert.ok(assetPrompt.includes("完整故事正文"));
assert.equal((asset.jsonSchema as any).properties.assets.items.properties.referenceId.type, "string");

const screenplay = getVideosBatchTextStageSpec("SCREENPLAY_GENERATION");
const screenplayPrompt = screenplay.buildUserPrompt({
  projectId: "P001",
  lessonText: "教案",
  selectedStoryId: "story-1",
  stages: {
    STORY_EXPANSION: {
      status: "ready",
      revision: 1,
      artifact: { stories: [{ id: "story-1", title: "故事1", content: "故事正文" }] }
    }
  }
} as any);
assert.ok(screenplayPrompt.includes("故事正文"));
assert.ok(screenplayPrompt.includes("画面与动作"));
assert.ok(screenplayPrompt.includes("对白/旁白"));

const storyboard = getVideosBatchTextStageSpec("STORYBOARD_GENERATION");
const shotSchema = (storyboard.jsonSchema as any).properties.shots.items;
assert.equal(shotSchema.properties.durationSec.const, 10);
assert.equal(shotSchema.properties.subshots.minItems, 3);
assert.equal(shotSchema.properties.subshots.maxItems, 5);
const storyboardPrompt = storyboard.buildUserPrompt({
  projectId: "P001",
  lessonText: "教案",
  stages: {
    SCREENPLAY_GENERATION: {
      status: "ready",
      revision: 1,
      artifact: { scenes: [{ id: "scene-1", title: "第一场", visual: "画面", dialogue: "台词" }] }
    }
  }
} as any);
assert.ok(storyboardPrompt.includes("固定10秒"));
assert.ok(storyboardPrompt.includes("3-5个连续子镜头"));

console.log("VideosBatch text stage specs smoke passed");
