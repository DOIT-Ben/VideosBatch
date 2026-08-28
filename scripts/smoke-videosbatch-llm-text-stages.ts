import { strict as assert } from "node:assert";
import { createVideosBatchWorkflow } from "../src/shared/videosBatchWorkflow";
import type { Session } from "../src/shared/types";
import type { VideosBatchLlmExecutor, StructuredGenerationRequest } from "../src/server/videosBatchWorkflow/llmExecutor";
import { createVideosBatchLlmTextStageRegistry } from "../src/server/videosBatchWorkflow/llmTextStages";
import type { StageExecutionContext } from "../src/server/videosBatchWorkflow/stageContracts";

const calls: StructuredGenerationRequest[] = [];
const artifacts: Record<string, any> = {
  INTRO_GENERATION: {
    candidates: ["A1", "A2", "A3", "B1", "B2", "B3", "C1", "C2", "C3"].map((id) => ({
      id,
      name: `导入${id}`,
      creativeType: "测试",
      body: "字".repeat(220),
      endingQuestion: "到底应该怎样解决？",
      truthfulnessCategory: "完全虚构的故事化情境",
      truthfulnessNote: "用于课堂导入的虚构情境。"
    })),
    recommendations: [
      { id: "A1", reason: "吸引力强" },
      { id: "B1", reason: "知识连接强" },
      { id: "C1", reason: "适合视频化" }
    ]
  },
  STORY_EXPANSION: {
    stories: [1, 2, 3].map((index) => ({
      id: `story-${index}`,
      sourceIntroId: ["A1", "B1", "C1"][index - 1],
      title: `故事${index}`,
      type: "测试",
      truthfulnessNote: "完全虚构的故事化情境。",
      content: "故".repeat(650)
    }))
  },
  ASSET_PROMPT_GENERATION: {
    candidateAssets: ["小宇", "教室"],
    omissionCheck: "已按人物、场景、道具、生物四类完成二次核对。",
    assets: [
      { referenceId: "P001-A001", type: "character", name: "小宇", source: "主角", usage: "角色一致性", prompt: "角色设定" },
      { referenceId: "P001-A002", type: "scene", name: "教室", source: "主要场景", usage: "场景一致性", prompt: "场景空镜" }
    ]
  },
  SCREENPLAY_GENERATION: {
    scenes: [{
      id: "scene-1",
      title: "第一场",
      theme: "观察",
      audienceEmotion: "好奇",
      presentationModes: ["角色扮演"],
      soundEffects: { ambience: [], transition: [], action: [], voiceCue: [] },
      visuals: ["小宇走到观察台前"],
      dialogue: [{ speaker: "小宇", tone: "好奇", text: "为什么会不一样？" }],
      knowledgePackaging: []
    }]
  },
  STORYBOARD_GENERATION: {
    storyboardType: "story",
    shots: [{
      id: "shot-plan-1",
      chapter: "第1章",
      sequence: "1-1",
      title: "观察",
      scene: "教室",
      subjects: ["小宇"],
      props: [],
      durationSec: 10,
      prompt: "小宇在教室观察物体",
      subshots: [
        { startSec: 0, endSec: 3, durationSec: 3, visual: "画面1", camera: "中景", sound: "无", dialogue: "无" },
        { startSec: 3, endSec: 6, durationSec: 3, visual: "画面2", camera: "近景", sound: "无", dialogue: "无" },
        { startSec: 6, endSec: 10, durationSec: 4, visual: "画面3", camera: "特写", sound: "无", dialogue: "无" }
      ]
    }]
  }
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
assert.ok(registry.INTRO_GENERATION);
assert.ok(registry.STORY_EXPANSION);
assert.ok(registry.ASSET_PROMPT_GENERATION);
assert.ok(registry.SCREENPLAY_GENERATION);
assert.ok(registry.STORYBOARD_GENERATION);
assert.equal(registry.REFERENCE_BINDING, undefined, "REFERENCE_BINDING must not call the LLM adapter");

function session(workflow: any): Session {
  const now = new Date().toISOString();
  return {
    id: "ses_llm_stage",
    title: "LLM stages",
    logline: "",
    style: "test",
    targetDurationSec: 120,
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
const introResult = await registry.INTRO_GENERATION!.execute(ctx);
assert.equal(calls[0].operation, "INTRO_GENERATION");
assert.equal(calls[0].schemaName, "videosbatch_intro_generation");
assert.equal(registry.INTRO_GENERATION!.validate(introResult.artifact, ctx).ok, true);

const invalidIntro = structuredClone(artifacts.INTRO_GENERATION);
invalidIntro.candidates.pop();
const invalidIntroValidation = registry.INTRO_GENERATION!.validate(invalidIntro, ctx);
assert.equal(invalidIntroValidation.ok, false);
assert.ok(invalidIntroValidation.errors.some((error) => error.includes("9")));

workflow.stages.INTRO_GENERATION = { status: "ready", revision: 1, artifact: artifacts.INTRO_GENERATION };
ctx = context(workflow);
const storyResult = await registry.STORY_EXPANSION!.execute(ctx);
assert.equal(registry.STORY_EXPANSION!.validate(storyResult.artifact, ctx).ok, true);

workflow.stages.STORY_EXPANSION = { status: "ready", revision: 1, artifact: artifacts.STORY_EXPANSION };
workflow.selectedStoryId = "story-1";
ctx = context(workflow);
const assetResult = await registry.ASSET_PROMPT_GENERATION!.execute(ctx);
assert.equal(registry.ASSET_PROMPT_GENERATION!.validate(assetResult.artifact, ctx).ok, true);
const invalidAssets = structuredClone(artifacts.ASSET_PROMPT_GENERATION);
invalidAssets.assets[1].referenceId = "P001-A003";
const invalidAssetValidation = registry.ASSET_PROMPT_GENERATION!.validate(invalidAssets, ctx);
assert.equal(invalidAssetValidation.ok, false);
assert.ok(invalidAssetValidation.errors.some((error) => error.includes("P001-A002")));

const screenplayResult = await registry.SCREENPLAY_GENERATION!.execute(ctx);
assert.equal(registry.SCREENPLAY_GENERATION!.validate(screenplayResult.artifact, ctx).ok, true);
workflow.stages.SCREENPLAY_GENERATION = { status: "ready", revision: 1, artifact: artifacts.SCREENPLAY_GENERATION };
ctx = context(workflow);
const storyboardResult = await registry.STORYBOARD_GENERATION!.execute(ctx);
assert.equal(registry.STORYBOARD_GENERATION!.validate(storyboardResult.artifact, ctx).ok, true);
const invalidStoryboard = structuredClone(artifacts.STORYBOARD_GENERATION);
invalidStoryboard.shots[0].subshots[2].durationSec = 3;
invalidStoryboard.shots[0].subshots[2].endSec = 9;
const invalidStoryboardValidation = registry.STORYBOARD_GENERATION!.validate(invalidStoryboard, ctx);
assert.equal(invalidStoryboardValidation.ok, false);
assert.ok(invalidStoryboardValidation.errors.some((error) => error.includes("10")));

console.log("VideosBatch LLM text-stage adapter smoke passed");
