import { strict as assert } from "node:assert";
import { createVideosBatchWorkflow } from "../src/shared/videosBatchWorkflow";
import type { Session } from "../src/shared/types";
import type { VideosBatchLlmExecutor, StructuredGenerationRequest } from "../src/server/videosBatchWorkflow/llmExecutor";
import { createVideosBatchLlmTextStageRegistry } from "../src/server/videosBatchWorkflow/llmTextStages";
import type { StageExecutionContext } from "../src/server/videosBatchWorkflow/stageContracts";

const calls: StructuredGenerationRequest[] = [];

const introArtifact = {
  candidates: ["A-01", "A-02", "A-03", "B-01", "B-02", "B-03", "C-01", "C-02", "C-03"].map((id) => ({
    id,
    name: `导入${id}`,
    creativeType: "测试",
    body: "字".repeat(220),
    endingQuestion: "到底应该怎样解决？",
    truthfulnessCategory: "完全虚构的故事化情境",
    truthfulnessNote: "用于课堂导入的虚构情境。"
  })),
  recommendations: [
    { id: "A-01", reason: "吸引力强" },
    { id: "B-01", reason: "知识连接强" },
    { id: "C-01", reason: "适合视频化" }
  ]
};

const storyArtifact = {
  schemaVersion: "2",
  kind: "LESSON_INTRO_VIDEO_SCRIPT",
  title: "蒙眼侦探",
  storyType: "故事叙事型",
  truthfulnessNote: "完全虚构的故事化情境。",
  content: "故".repeat(650)
};

const assetPlanArtifact = {
  schemaVersion: "1",
  title: "资产计划",
  kind: "VIDEO_ASSET_PLAN",
  subject: "数学",
  gradeBand: "小学",
  candidateAssets: ["小宇"],
  omissionCheck: "已逐段回看并完成四类资产遗漏检查。",
  items: [
    {
      assetKey: "CHARACTER-HERO",
      category: "CHARACTER",
      name: "小宇",
      description: "主要观察者",
      prompt: "高级影视级3D国漫CG人物三视图提示词",
      aspectRatio: "16:9",
      continuityNotes: "保持脸型、五官、发色和服装一致",
      sourceEvidence: "故事主角"
    }
  ]
};

const screenplayArtifact = {
  schemaVersion: "1",
  kind: "VIDEO_SCREENPLAY",
  title: "正式剧本",
  subject: "数学",
  gradeBand: "小学",
  storyType: "STORY",
  targetDurationSeconds: 90,
  scenes: [{
    sequence: 1,
    title: "第一场",
    knowledgeFocus: "观察与判断",
    emotionalPurpose: "产生好奇和冲突",
    visualPresentation: "角色故事",
    ambientSound: "环境声",
    effectSound: "提示音",
    interactionSound: "轻响",
    voice: "自然对白",
    visualAction: "角色观察并比较",
    dialogue: "为什么会不一样？",
    evidence: []
  }]
};

const confirmedItem = {
  assetKey: "CHARACTER-HERO",
  publicAssetId: "P001-A001",
  candidateAssetIds: ["asset_candidate_1"],
  selectedAssetId: "asset_candidate_1"
};

const finalStoryboardArtifact = {
  schemaVersion: "1",
  title: "最终分镜",
  kind: "VIDEO_STORYBOARD",
  goal: "完整呈现课程导入",
  overallScript: "连续覆盖正式剧本",
  visualContinuity: "角色连续一致",
  targetDuration: 90,
  aspectRatio: "16:9",
  deliveryMode: "SEGMENTED_MP4",
  format: "FINAL_10_SECOND",
  storyType: "STORY",
  segments: Array.from({ length: 9 }, (_, index) => ({
    sequence: index + 1,
    screenplaySceneSequence: 1,
    duration: 10,
    visualPrompt: `第${index + 1}条画面`,
    narration: `第${index + 1}条旁白`,
    subtitles: `第${index + 1}条字幕`,
    teachingPurpose: "推进问题",
    transition: "自然转场",
    evidence: [],
    references: [{ assetId: "P001-A001", publicAssetId: "P001-A001", label: "小宇" }],
    subshots: [
      { sequence: 1, duration: 3, visual: "画面1", action: "动作1", camera: "中景", sound: "环境声", voice: "旁白1" },
      { sequence: 2, duration: 3, visual: "画面2", action: "动作2", camera: "近景", sound: "轻响", voice: "对白2" },
      { sequence: 3, duration: 4, visual: "画面3", action: "动作3", camera: "稳定", sound: "提示音", voice: "悬问3" }
    ]
  }))
};

const copyableArtifact = {
  schemaVersion: "1",
  status: "READY",
  failedSegments: [],
  segments: finalStoryboardArtifact.segments.map((segment) => ({
    sequence: segment.sequence,
    text: `分镜${segment.sequence}\n画面效果：【P001-A001】 ${segment.visualPrompt}\n教师旁白：${segment.narration}\n字幕：${segment.subtitles}`,
    referenceAssetIds: ["P001-A001"]
  }))
};
(copyableArtifact as any).fullText = copyableArtifact.segments.map((segment) => segment.text).join("\n\n");

const artifacts: Record<string, any> = {
  COURSE_INTRO_CANDIDATES: introArtifact,
  STORY_SCRIPT: storyArtifact,
  ASSET_PLAN: assetPlanArtifact,
  SCREENPLAY: screenplayArtifact,
  FINAL_STORYBOARD: finalStoryboardArtifact,
  COPYABLE_PROMPT: copyableArtifact
};

const executor: VideosBatchLlmExecutor = {
  async generateStructured<T>(request: StructuredGenerationRequest) {
    calls.push(request);
    return {
      data: structuredClone(artifacts[request.operation]) as T,
      provider: "openai-responses",
      model: "fake-model",
      responseId: `resp_${request.operation}`,
      rawText: JSON.stringify(artifacts[request.operation])
    };
  }
};

const registry = createVideosBatchLlmTextStageRegistry(executor);
for (const stageId of ["COURSE_INTRO_CANDIDATES", "STORY_SCRIPT", "ASSET_PLAN", "SCREENPLAY", "FINAL_STORYBOARD", "COPYABLE_PROMPT"] as const) {
  assert.ok(registry[stageId], `missing canonical LLM stage ${stageId}`);
}
assert.equal(registry.COURSE_INTRO_SELECTION, undefined, "manual selection gate must not call the LLM adapter");
assert.equal(registry.ASSET_CONFIRMATION, undefined, "manual asset gate must not call the LLM adapter");

function session(workflow: any): Session {
  const now = new Date().toISOString();
  return {
    id: "ses_llm_stage",
    title: "Canonical LLM stages",
    logline: "",
    style: "test",
    targetDurationSec: 90,
    videosBatchWorkflow: workflow,
    createdAt: now,
    updatedAt: now
  } as Session;
}

function context(workflow: any): StageExecutionContext {
  return { session: session(workflow), workflow, assets: [], shots: [] };
}

const workflow = createVideosBatchWorkflow({ projectId: "P001", lessonText: "观察物体完整教案" });
let ctx = context(workflow);
const introResult = await registry.COURSE_INTRO_CANDIDATES!.execute(ctx);
assert.equal(calls[0].operation, "COURSE_INTRO_CANDIDATES");
assert.equal(registry.COURSE_INTRO_CANDIDATES!.validate(introResult.artifact, ctx).ok, true);
const invalidIntro = structuredClone(introArtifact);
invalidIntro.candidates.pop();
assert.equal(registry.COURSE_INTRO_CANDIDATES!.validate(invalidIntro, ctx).ok, false);

workflow.stages.COURSE_INTRO_CANDIDATES = { status: "ready", revision: 1, artifact: introArtifact };
workflow.stages.COURSE_INTRO_SELECTION = {
  status: "ready",
  revision: 1,
  artifact: { selectedIntroId: "A-01", selectionMode: "user_selected", selectionReason: "用户确认", locked: true }
};
workflow.selectedIntroId = "A-01";
workflow.selectionMode = "user_selected";
workflow.selectionReason = "用户确认";
workflow.introLocked = true;
ctx = context(workflow);
const storyResult = await registry.STORY_SCRIPT!.execute(ctx);
assert.equal(registry.STORY_SCRIPT!.validate(storyResult.artifact, ctx).ok, true);
const invalidStory = { ...storyArtifact, content: "太短" };
assert.equal(registry.STORY_SCRIPT!.validate(invalidStory, ctx).ok, false);

workflow.stages.STORY_SCRIPT = { status: "ready", revision: 1, artifact: storyArtifact };
ctx = context(workflow);
const assetResult = await registry.ASSET_PLAN!.execute(ctx);
assert.equal(registry.ASSET_PLAN!.validate(assetResult.artifact, ctx).ok, true);
const invalidAsset = structuredClone(assetPlanArtifact) as any;
invalidAsset.items[0].assetId = "P001-A001";
const invalidAssetValidation = registry.ASSET_PLAN!.validate(invalidAsset, ctx);
assert.equal(invalidAssetValidation.ok, false);
assert.ok(invalidAssetValidation.errors.some((error) => error.includes("must not own assetId")));

workflow.stages.ASSET_PLAN = {
  status: "ready",
  revision: 1,
  artifact: {
    ...assetPlanArtifact,
    items: [{ ...assetPlanArtifact.items[0], assetId: "P001-A001", candidateAssetIds: ["asset_candidate_1"], selectedAssetId: "asset_candidate_1" }]
  }
};
workflow.stages.ASSET_CONFIRMATION = { status: "ready", revision: 1, artifact: { confirmed: true, items: [confirmedItem] } };
ctx = context(workflow);
const screenplayResult = await registry.SCREENPLAY!.execute(ctx);
assert.equal(registry.SCREENPLAY!.validate(screenplayResult.artifact, ctx).ok, true);
const invalidDuration = { ...screenplayArtifact, targetDurationSeconds: 95 };
assert.equal(registry.SCREENPLAY!.validate(invalidDuration, ctx).ok, false);

workflow.stages.SCREENPLAY = { status: "ready", revision: 1, artifact: screenplayArtifact };
ctx = context(workflow);
const storyboardResult = await registry.FINAL_STORYBOARD!.execute(ctx);
assert.equal(registry.FINAL_STORYBOARD!.validate(storyboardResult.artifact, ctx).ok, true);
const invalidStoryboard = structuredClone(finalStoryboardArtifact);
invalidStoryboard.segments.pop();
assert.equal(registry.FINAL_STORYBOARD!.validate(invalidStoryboard, ctx).ok, false, "storyboard segment count must match locked duration");

workflow.stages.FINAL_STORYBOARD = { status: "ready", revision: 1, artifact: finalStoryboardArtifact };
ctx = context(workflow);
const copyResult = await registry.COPYABLE_PROMPT!.execute(ctx);
assert.equal(registry.COPYABLE_PROMPT!.validate(copyResult.artifact, ctx).ok, true);
const invalidCopy = structuredClone(copyableArtifact);
invalidCopy.segments[0].text = invalidCopy.segments[0].text.replace("【P001-A001】", "图片1");
assert.equal(registry.COPYABLE_PROMPT!.validate(invalidCopy, ctx).ok, false, "copyable visual text must reject positional image references");

console.log("VideosBatch canonical LLM text-stage adapter smoke passed");
