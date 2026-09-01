import { strict as assert } from "node:assert";
import { createVideosBatchWorkflow } from "../src/shared/videosBatchWorkflow";
import type { Session } from "../src/shared/types";
import type { VideosBatchLlmExecutor, StructuredGenerationRequest } from "../src/server/videosBatchWorkflow/llmExecutor";
import { createVideosBatchLlmTextStageRegistry, deriveCopyablePrompt } from "../src/server/videosBatchWorkflow/llmTextStages";
import type { StageExecutionContext } from "../src/server/videosBatchWorkflow/stageContracts";
import { renderCanonicalSegmentText } from "../src/server/videosBatchWorkflow/canonicalStoryboard";
import { PromptMaterialTooLargeError, renderPromptMaterial } from "../src/server/videosBatchWorkflow/promptMaterial";

const calls: StructuredGenerationRequest[] = [];

const introDirections = [
  "原始问题与知识产生",
  "可靠史实与时代背景",
  "方法工具演变",
  "古代真实需求",
  "古今对照",
  "现代工程科技应用",
  "生活冲突与错误现场",
  "推理游戏挑战",
  "科技或自然异常"
];

const introArtifact = {
  candidates: ["A-01", "A-02", "A-03", "B-01", "B-02", "B-03", "C-01", "C-02", "C-03"].map((id, index) => ({
    id,
    name: `导入${id}`,
    creativeType: introDirections[index],
    body: `${id}：${introDirections[index]}。${"学生围绕一个真实问题观察、比较和推理，冲突逐步升级，本课知识成为关键线索，但此处不提前揭示结论。".repeat(5)}`.slice(0, 280),
    endingQuestion: "到底应该怎样解决？",
    truthfulnessCategory: "完全虚构的故事化情境",
    truthfulnessNote: "用于课堂导入的虚构情境。"
  })),
  recommendations: [
    { id: "A-01", reason: "课堂吸引力强，知识连接清晰，适合视频制作。" },
    { id: "B-01", reason: "课堂真实需求明确，便于自然引出知识。" },
    { id: "C-01", reason: "冲突直观，学生容易代入，适合视频化。" }
  ]
};

const storyText = "故事从一个明确的问题开始，学生发现仅凭眼前看到的现象无法直接作出结论，于是不断提出新的猜测并寻找证据。随着不同观察角度和条件逐步出现，原先看似确定的判断开始产生冲突，大家必须依靠本课的数学知识来重新组织线索。人物通过观察、比较、讨论和验证推进情节，但故事始终不提前给出课堂要学习的最终规律。最后，所有线索汇聚到一个尚未解决的问题上：怎样才能用更可靠的方法完成判断？";
const storyArtifact = {
  schemaVersion: "2",
  kind: "LESSON_INTRO_VIDEO_SCRIPT",
  title: "蒙眼侦探",
  storyType: "故事叙事型",
  truthfulnessNote: "完全虚构的故事化情境。",
  content: storyText.repeat(4)
};

const assetNegative = "不要文字，不要水印，不要 logo，不要乱码，不要主体裁切，不要主体缺失，不要多余人物，不要复杂背景，不要比例错误，不要结构混乱，不要畸形肢体，不要多手多指，不要脸部崩坏，不要风格混乱，不要低清模糊。";
const assetSpecs = [
  { assetKey: "CHARACTER-HERO", category: "CHARACTER", name: "小宇", description: "主要观察者", usage: "跨镜头保持主角一致", sourceEvidence: "故事主角", required: true, continuityNotes: "保持脸型、五官、发色和服装一致。", variantNotes: null, prompt: "高级影视级 3D 国漫 CG 风格人物三视图，正面、侧面、背面和面部特写，纯白背景，16:9。" },
  { assetKey: "SCENE-CLASSROOM", category: "SCENE", name: "课堂观察区", description: "故事发生的课堂空间", usage: "建立连续课堂空间", sourceEvidence: "故事场景", required: true, continuityNotes: "空间结构和光线保持一致。", variantNotes: null, prompt: "高级影视级 3D 国漫 CG 风格纯环境空镜，课堂观察区，16:9。" },
  { assetKey: "PROP-RULER", category: "PROP", name: "观察尺", description: "推动观察冲突的关键道具", usage: "提供可追踪的测量线索", sourceEvidence: "故事关键道具", required: true, continuityNotes: "比例和刻度保持一致。", variantNotes: null, prompt: "高级影视级 3D 国漫 CG 风格单体道具设定图，观察尺居中，纯白背景，16:9。" },
  { assetKey: "CREATURE-BIRD", category: "CREATURE", name: "课堂小鸟", description: "窗外出现的非拟人生物", usage: "作为一次性环境线索", sourceEvidence: "故事生物", required: false, continuityNotes: "外观保持一致。", variantNotes: null, prompt: "高级影视级 3D 国漫 CG 风格非拟人生物完整设定图，课堂小鸟居中，纯白背景，16:9。" }
];
const assetPlanArtifact = {
  schemaVersion: "1",
  title: "资产计划",
  kind: "VIDEO_ASSET_PLAN",
  subject: "数学",
  gradeBand: "小学",
  candidateAssets: assetSpecs.map((item) => item.name),
  candidateInventory: assetSpecs.map((item) => ({ assetKey: item.assetKey, name: item.name, category: item.category, required: item.required, sourceEvidence: item.sourceEvidence, decision: item.required ? "required" : "optional" })),
  omissionCheck: "已逐段回看并完成四类资产遗漏检查。",
  styleSpec: "影视级 3D 国漫 CG 风格，所有资产统一 16:9。",
  negativePrompt: assetNegative,
  items: assetSpecs.map((item) => ({ ...item, negativePrompt: assetNegative, aspectRatio: "16:9" }))
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

const confirmedItems = assetSpecs.map((item, index) => ({
  assetKey: item.assetKey,
  publicAssetId: `P001-A00${index + 1}`,
  candidateAssetIds: [`asset_candidate_${index + 1}`],
  selectedAssetId: `asset_candidate_${index + 1}`
}));

const finalStoryboardArtifact = {
  schemaVersion: "2",
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
    ...(index === 0 ? { chapter: "第1章" } : {}),
    scene: `课堂观察区出现第${index + 1}个新的观察问题，角色继续推理。`,
    characters: "【人物：小宇】",
    keyProps: "【道具：观察尺】",
    evidence: [],
    references: [{ label: "【人物：小宇】" }, { label: "【场景：课堂观察区】" }],
    visualEffects: [
      { sequence: 1, timeRange: "0-2秒", duration: 2, visual: "【人物：小宇】画面出现异常", action: "角色发现问题", camera: "中景", sound: "环境声", voice: "为什么会这样？" },
      { sequence: 2, timeRange: "2-6秒", duration: 4, visual: "【道具：观察尺】呈现观察细节", action: "角色比较并记录变化", camera: "近景推近", sound: "轻响", voice: "无" },
      { sequence: 3, timeRange: "6-10秒", duration: 4, visual: "【场景：课堂观察区】画面停住", action: "角色留下悬念", camera: "稳定跟随", sound: "提示音", voice: "这个问题该怎么解决？" }
    ]
  }))
};

const copyableArtifact = {
  schemaVersion: "1",
  status: "READY",
  failedSegments: [],
  segments: finalStoryboardArtifact.segments.map((segment) => ({
    sequence: segment.sequence,
    text: renderCanonicalSegmentText(segment, "STORY").replace("画面效果：\n", "画面效果：【P001-A001】\n"),
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

let repairCalls = 0;
const repairKeys: string[] = [];
const repairPrimaryExhausted: boolean[] = [];
const repairExecutor: VideosBatchLlmExecutor = {
  async generateStructured<T>(request: StructuredGenerationRequest) {
    repairCalls += 1;
    repairKeys.push(String(request.idempotencyKey || ""));
    repairPrimaryExhausted.push(Boolean(request.budget?.primaryExhausted));
    if (repairCalls === 1) {
      const invalid = structuredClone(introArtifact);
      invalid.candidates[0].body = "字".repeat(199);
      return { data: invalid as T, provider: "openai-responses", model: "fake-model", rawText: JSON.stringify(invalid) };
    }
    assert.match(request.userPrompt, /A-01 body must be 200-300 characters/);
    assert.match(request.userPrompt, /<affected_fields>/);
    assert.doesNotMatch(request.userPrompt, /<previous_artifact_json>/);
    assert.match(request.userPrompt, /字{199}/);
    assert.equal(request.metadata?.attempt, "2");
    return { data: structuredClone(introArtifact) as T, provider: "openai-responses", model: "fake-model", rawText: JSON.stringify(introArtifact) };
  }
};
const repairRegistry = createVideosBatchLlmTextStageRegistry(repairExecutor);
const repairedIntro = await repairRegistry.COURSE_INTRO_CANDIDATES!.execute(ctx);
assert.equal(repairCalls, 2, "validation failure should trigger one bounded repair call");
assert.ok(repairKeys[0] && repairKeys[1] && repairKeys[0] !== repairKeys[1], "contract repair must derive a new idempotency key from the changed prompt");
assert.deepEqual(repairPrimaryExhausted, [false, false], "contract repair must let the primary model use its shared retry budget before fallback");
assert.equal(repairRegistry.COURSE_INTRO_CANDIDATES!.validate(repairedIntro.artifact, ctx).ok, true);

const compactMaterial = renderPromptMaterial({ first: "完整字段值", second: "另一个完整字段值" }, "", 64);
assert.ok(compactMaterial.length <= 64, "prompt material must stay within its budget");
assert.match(compactMaterial, /完整字段值/);
assert.match(compactMaterial, /另一个完整字段值/);
assert.doesNotMatch(compactMaterial, /已省略/);
assert.throws(
  () => renderPromptMaterial({ first: "完整字段值", second: "另一个完整字段值" }, "", 14),
  (error: unknown) => error instanceof PromptMaterialTooLargeError && error.code === "PROMPT_CONTEXT_TOO_LARGE"
);
assert.throws(
  () => renderPromptMaterial("不可截断的完整字段值", "", 4),
  (error: unknown) => error instanceof PromptMaterialTooLargeError && error.code === "PROMPT_CONTEXT_TOO_LARGE"
);

let exhaustedCalls = 0;
const exhaustedRoutes: Array<StructuredGenerationRequest["providerRoute"]> = [];
const exhaustedExecutor: VideosBatchLlmExecutor = {
  async generateStructured<T>(request) {
    exhaustedCalls += 1;
    exhaustedRoutes.push(request.providerRoute);
    const invalid = structuredClone(introArtifact);
    invalid.candidates[0].body = "字".repeat(199);
    return { data: invalid as T, provider: "openai-responses", model: "fake-model", rawText: JSON.stringify(invalid) };
  }
};
const exhaustedRegistry = createVideosBatchLlmTextStageRegistry(exhaustedExecutor);
const exhaustedIntro = await exhaustedRegistry.COURSE_INTRO_CANDIDATES!.execute(ctx);
assert.equal(exhaustedCalls, 3, "contract repair must share one three-submission budget");
assert.deepEqual(exhaustedRoutes, ["auto", "auto", "auto"]);
assert.equal(exhaustedRegistry.COURSE_INTRO_CANDIDATES!.validate(exhaustedIntro.artifact, ctx).ok, false);

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
  artifact: assetPlanArtifact
};
workflow.stages.ASSET_CONFIRMATION = { status: "ready", revision: 1, artifact: { confirmed: true, items: confirmedItems } };
ctx = context(workflow);
const screenplayResult = await registry.SCREENPLAY!.execute(ctx);
assert.equal(registry.SCREENPLAY!.validate(screenplayResult.artifact, ctx).ok, true);
assert.equal(registry.SCREENPLAY!.validate(screenplayArtifact, { ...ctx, store: {} as any }).ok, false, "API-backed screenplay validation must reject missing persisted selected assets");
const invalidDuration = { ...screenplayArtifact, targetDurationSeconds: 95 };
assert.equal(registry.SCREENPLAY!.validate(invalidDuration, ctx).ok, false);

workflow.stages.SCREENPLAY = { status: "ready", revision: 1, artifact: screenplayArtifact };
ctx = context(workflow);
const storyboardResult = await registry.FINAL_STORYBOARD!.execute(ctx);
assert.equal(registry.FINAL_STORYBOARD!.validate(storyboardResult.artifact, ctx).ok, true);
const storyboardRequest = calls.find((request) => request.operation === "FINAL_STORYBOARD");
assert.equal(storyboardRequest?.model, "gpt-5.6-terra");
assert.equal(storyboardRequest?.reasoningEffort, "medium");

const previousChunked = process.env.VIDEOSBATCH_FINAL_STORYBOARD_CHUNKED;
const previousChunkCount = process.env.VIDEOSBATCH_FINAL_STORYBOARD_CHUNK_COUNT;
const previousChunkSize = process.env.VIDEOSBATCH_FINAL_STORYBOARD_CHUNK_SEGMENTS;
process.env.VIDEOSBATCH_FINAL_STORYBOARD_CHUNKED = "1";
process.env.VIDEOSBATCH_FINAL_STORYBOARD_CHUNK_COUNT = "2";
delete process.env.VIDEOSBATCH_FINAL_STORYBOARD_CHUNK_SEGMENTS;
try {
  const chunkCalls: StructuredGenerationRequest[] = [];
  const chunkExecutor: VideosBatchLlmExecutor = {
    async generateStructured<T>(request: StructuredGenerationRequest) {
      chunkCalls.push(request);
      const start = Number(request.metadata?.chunk_start || 1);
      const end = Number(request.metadata?.chunk_end || finalStoryboardArtifact.segments.length);
      const data = { ...finalStoryboardArtifact, segments: finalStoryboardArtifact.segments.slice(start - 1, end) };
      return { data: data as T, provider: "openai-responses", model: "fake-model", rawText: JSON.stringify(data) };
    }
  };
  const chunkRegistry = createVideosBatchLlmTextStageRegistry(chunkExecutor);
  const chunkedStoryboard = await chunkRegistry.FINAL_STORYBOARD!.execute(ctx);
  assert.equal(chunkCalls.length, 1, "hidden storyboard chunking must be disabled");
  assert.equal(chunkCalls[0].metadata?.chunk_start, undefined);
  assert.equal(chunkCalls[0].metadata?.chunk_end, undefined);
  assert.equal(chunkedStoryboard.artifact.segments.length, 9);
  assert.equal(chunkRegistry.FINAL_STORYBOARD!.validate(chunkedStoryboard.artifact, ctx).ok, true);
} finally {
  if (previousChunked === undefined) delete process.env.VIDEOSBATCH_FINAL_STORYBOARD_CHUNKED;
  else process.env.VIDEOSBATCH_FINAL_STORYBOARD_CHUNKED = previousChunked;
  if (previousChunkCount === undefined) delete process.env.VIDEOSBATCH_FINAL_STORYBOARD_CHUNK_COUNT;
  else process.env.VIDEOSBATCH_FINAL_STORYBOARD_CHUNK_COUNT = previousChunkCount;
  if (previousChunkSize === undefined) delete process.env.VIDEOSBATCH_FINAL_STORYBOARD_CHUNK_SEGMENTS;
  else process.env.VIDEOSBATCH_FINAL_STORYBOARD_CHUNK_SEGMENTS = previousChunkSize;
}

const invalidStoryboard = structuredClone(finalStoryboardArtifact);
invalidStoryboard.segments.pop();
assert.equal(registry.FINAL_STORYBOARD!.validate(invalidStoryboard, ctx).ok, false, "storyboard segment count must match locked duration");

workflow.stages.FINAL_STORYBOARD = { status: "ready", revision: 1, artifact: finalStoryboardArtifact };
ctx = context(workflow);
const copyResult = await registry.COPYABLE_PROMPT!.execute(ctx);
assert.equal(registry.COPYABLE_PROMPT!.validate(copyResult.artifact, ctx).ok, true);
assert.match(copyResult.artifact.segments[0].text, /0-2秒：.*【P001-A001】【人物：小宇】/u);
assert.match(copyResult.artifact.segments[0].text, /6-10秒：.*【P001-A002】【场景：课堂观察区】/u);
assert.doesNotMatch(copyResult.artifact.segments[0].text.slice(0, copyResult.artifact.segments[0].text.indexOf("画面效果：")), /P001-A/u, "stable markers must not be placed in handbook fields before 画面效果");
const repeatedStoryboard = structuredClone(finalStoryboardArtifact);
repeatedStoryboard.segments[0].visualEffects[1].visual = "【人物：小宇】再次观察【道具：观察尺】";
const repeatedWorkflow = structuredClone(workflow);
repeatedWorkflow.stages.FINAL_STORYBOARD = { status: "ready", revision: 1, artifact: repeatedStoryboard };
const repeatedCopy = deriveCopyablePrompt(context(repeatedWorkflow));
const repeatedPersonMarkers = [...repeatedCopy.segments[0].text.matchAll(/【P001-A001】/gu)].length;
assert.equal(repeatedPersonMarkers, 1, "the same asset must be marked only at its first visual occurrence within a segment");
const invalidCopy = structuredClone(copyResult.artifact);
invalidCopy.segments[0].text = invalidCopy.segments[0].text.replace("【P001-A001】", "图片1");
assert.equal(registry.COPYABLE_PROMPT!.validate(invalidCopy, ctx).ok, false, "copyable visual text must reject positional image references");

console.log("VideosBatch canonical LLM text-stage adapter smoke passed");
