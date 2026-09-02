import { strict as assert } from "node:assert";
import {
  VIDEOS_BATCH_STAGE_ORDER,
  createVideosBatchWorkflow
} from "../src/shared/videosBatchWorkflow";
import {
  VIDEOS_BATCH_TEXT_STAGE_IDS,
  getVideosBatchTextStageSpec
} from "../src/server/videosBatchWorkflow/textStageSpecs";

const expectedStageOrder = [
  "LESSON_INPUT",
  "COURSE_INTRO_CANDIDATES",
  "COURSE_INTRO_SELECTION",
  "STORY_SCRIPT",
  "ASSET_PLAN",
  "ASSET_CANDIDATES",
  "ASSET_CONFIRMATION",
  "SCREENPLAY",
  "FINAL_STORYBOARD",
  "COPYABLE_PROMPT",
  "QUOTE",
  "EXECUTION",
  "STITCH"
];
assert.deepEqual(
  [...VIDEOS_BATCH_STAGE_ORDER],
  expectedStageOrder,
  "VideosBatch stage order must mirror VIDEOSBATCH_WORKFLOW_CANONICAL plus explicit local selection/stitch gates"
);

const workflow = createVideosBatchWorkflow({ projectId: "P001", lessonText: "观察物体完整教案" }) as any;
assert.equal(workflow.currentStage, "COURSE_INTRO_CANDIDATES");
assert.equal(workflow.selectedIntroId, undefined);
assert.equal(workflow.introLocked, false);
assert.equal("selectedStoryId" in workflow, false, "latest canonical flow selects the intro before story generation; there is no three-story selection stage");

assert.deepEqual(VIDEOS_BATCH_TEXT_STAGE_IDS, [
  "COURSE_INTRO_CANDIDATES",
  "STORY_SCRIPT",
  "ASSET_PLAN",
  "SCREENPLAY",
  "FINAL_STORYBOARD",
  "COPYABLE_PROMPT"
]);

const intro = getVideosBatchTextStageSpec("COURSE_INTRO_CANDIDATES" as any);
for (const token of [
  "A-01", "A-02", "A-03", "B-01", "B-02", "B-03", "C-01", "C-02", "C-03",
  "200—300字",
  "穿越、神秘任务、系统故障、打不开门、算不出来",
  "不可信",
  "推荐最值得继续制作的3套"
]) {
  assert.ok((intro.systemPrompt + intro.buildUserPrompt(workflow)).includes(token), `intro prompt must preserve canonical requirement: ${token}`);
}

workflow.selectedIntroId = "A-01";
workflow.introLocked = true;
workflow.selectionMode = "user_selected";
workflow.selectionReason = "用户确认";
workflow.stages.COURSE_INTRO_CANDIDATES = {
  status: "ready",
  revision: 1,
  artifact: {
    candidates: [{
      id: "A-01",
      name: "蒙眼侦探",
      creativeType: "推理挑战",
      body: "字".repeat(220),
      endingQuestion: "怎样判断？",
      truthfulnessCategory: "完全虚构的故事化情境",
      truthfulnessNote: "虚构课堂情境"
    }],
    recommendations: [{ id: "A-01", reason: "适合课堂和视频" }]
  }
};
const story = getVideosBatchTextStageSpec("STORY_SCRIPT" as any);
const storyPrompt = story.buildUserPrompt(workflow);
assert.ok(storyPrompt.includes("唯一"), "story prompt must use exactly one locked intro");
assert.ok(storyPrompt.includes("600—800字"));
assert.ok(!storyPrompt.includes("三套导入分别扩写"), "latest canonical story stage must not generate three stories");

workflow.stages.STORY_SCRIPT = {
  status: "ready",
  revision: 1,
  artifact: {
    schemaVersion: "2",
    kind: "LESSON_INTRO_VIDEO_SCRIPT",
    title: "蒙眼侦探",
    storyType: "故事叙事型",
    truthfulnessNote: "完全虚构的故事化情境",
    content: "故".repeat(650)
  }
};
const asset = getVideosBatchTextStageSpec("ASSET_PLAN" as any);
const assetPrompt = asset.systemPrompt + asset.buildUserPrompt(workflow);
for (const token of [
  "影视级 3D 国漫 CG 风格",
  "人物/拟人动物",
  "场景/空间环境",
  "兵器/法宝/道具",
  "神兽/灵宠/非拟人生物",
  "人物三视图",
  "统一负面提示词",
  "assetKey",
  "模型不得填写或覆盖"
]) assert.ok(assetPrompt.includes(token), `asset prompt must preserve canonical requirement: ${token}`);
const assetItemSchema = (asset.jsonSchema as any).properties.items.items;
assert.ok(assetItemSchema.properties.assetKey, "asset plan model output must use assetKey");
assert.equal(assetItemSchema.properties.assetId, undefined, "public Pxxx-Axxx asset IDs are server-owned and must not be model output");

workflow.stages.ASSET_PLAN = {
  status: "ready",
  revision: 1,
  artifact: {
    schemaVersion: "1",
    kind: "VIDEO_ASSET_PLAN",
    title: "资产计划",
    subject: "数学",
    gradeBand: "小学",
    items: [{
      assetKey: "CHARACTER-HERO",
      category: "CHARACTER",
      name: "小宇",
      description: "主角",
      prompt: "人物三视图提示词",
      aspectRatio: "16:9",
      sourceEvidence: "故事主角",
      assetId: "P001-A001",
      candidateAssetIds: ["asset_candidate_1"],
      selectedAssetId: "asset_candidate_1"
    }]
  }
};
workflow.stages.ASSET_CONFIRMATION = {
  status: "ready",
  revision: 1,
  artifact: { confirmed: true, selectedAssetIds: ["asset_candidate_1"] }
};
const screenplay = getVideosBatchTextStageSpec("SCREENPLAY" as any);
const screenplaySchema = screenplay.jsonSchema as any;
assert.deepEqual(screenplaySchema.properties.targetDurationSeconds.enum, [90, 100, 110, 120, 130, 140, 150]);
for (const field of ["knowledgeFocus", "emotionalPurpose", "visualPresentation", "ambientSound", "effectSound", "interactionSound", "voice", "visualAction", "dialogue", "evidence"]) {
  assert.ok(screenplaySchema.properties.scenes.items.properties[field], `screenplay scene must preserve ${field}`);
}

workflow.stages.SCREENPLAY = {
  status: "ready",
  revision: 1,
  artifact: {
    schemaVersion: "1",
    kind: "VIDEO_SCREENPLAY",
    title: "正式剧本",
    subject: "数学",
    gradeBand: "小学",
    storyType: "STORY",
    targetDurationSeconds: 120,
    scenes: [{ sequence: 1, title: "第一场" }]
  }
};
const storyboard = getVideosBatchTextStageSpec("FINAL_STORYBOARD" as any, workflow as any);
const storyboardPrompt = storyboard.systemPrompt + storyboard.buildUserPrompt(workflow);
assert.ok(storyboardPrompt.includes("必须返回恰好"));
assert.ok(storyboardPrompt.includes("必须返回恰好"));
const segmentSchema = (storyboard.jsonSchema as any).properties.segments.items;
assert.equal(segmentSchema.oneOf, undefined, "provider schema must not use unsupported oneOf");
assert.ok(segmentSchema.properties.characters, "STORY storyboard role field must be present");
assert.match(segmentSchema.properties.references.items.properties.label.pattern, /人物/);
assert.equal(segmentSchema.properties.duration.const, 10);
assert.equal(segmentSchema.properties.visualEffects.minItems, 3);
assert.equal(segmentSchema.properties.visualEffects.maxItems, 3);
assert.equal((storyboard.jsonSchema as any).properties.segments.minItems, 12);
assert.equal((storyboard.jsonSchema as any).properties.segments.maxItems, 12);
for (const field of ["sequence", "timeRange", "duration", "visual", "action", "camera", "sound", "voice"]) {
  assert.ok(segmentSchema.properties.visualEffects.items.properties[field], `visualEffects subshot must preserve ${field}`);
}

const copyable = getVideosBatchTextStageSpec("COPYABLE_PROMPT" as any);
const copyablePrompt = copyable.systemPrompt + copyable.buildUserPrompt({
  ...workflow,
  stages: {
    ...workflow.stages,
    FINAL_STORYBOARD: {
      status: "ready",
      revision: 1,
      artifact: { targetDuration: 120, segments: [] }
    }
  }
} as any);
for (const token of ["画面效果", "最多标注7个资产ID", "禁止使用", "派生", "不新增或删除"]) {
  assert.ok(copyablePrompt.includes(token), `copyable prompt must preserve canonical requirement: ${token}`);
}
const copyableSegmentSchema = (copyable.jsonSchema as any).properties.segments.items;
assert.equal(copyableSegmentSchema.properties.referenceAssetIds.maxItems, 7);

console.log("VideosBatch FrameFlow canonical alignment smoke passed");
