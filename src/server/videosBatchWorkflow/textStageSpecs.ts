import type { VideosBatchStageId, VideosBatchWorkflowState } from "../../shared/videosBatchWorkflow";
import type { JsonSchema } from "./llmExecutor";
import {
  CANONICAL_STORYBOARD_SCHEMA_VERSION,
  CANONICAL_STORYBOARD_TYPES,
  canonicalSegmentSchema,
  canonicalStoryboardSegmentsSchema,
  normalizeStoryboardType
} from "./canonicalStoryboard";
import { renderPromptMaterial } from "./promptMaterial";
import { loadPromptTemplate } from "../prompts/promptTemplates";

export type VideosBatchTextStageId =
  | "COURSE_INTRO_CANDIDATES"
  | "STORY_SCRIPT"
  | "ASSET_PLAN"
  | "SCREENPLAY"
  | "FINAL_STORYBOARD"
  | "COPYABLE_PROMPT";

export const VIDEOS_BATCH_TEXT_STAGE_IDS: VideosBatchTextStageId[] = [
  "COURSE_INTRO_CANDIDATES",
  "STORY_SCRIPT",
  "ASSET_PLAN",
  "SCREENPLAY",
  "FINAL_STORYBOARD",
  "COPYABLE_PROMPT"
];

export const COURSE_VIDEO_DURATION_SECONDS = [90, 100, 110, 120, 130, 140, 150] as const;

export interface VideosBatchTextStageSpec {
  id: VideosBatchTextStageId;
  schemaName: string;
  systemPrompt: string;
  jsonSchema: JsonSchema;
  buildUserPrompt(workflow: VideosBatchWorkflowState): string;
}

const INTRO_IDS = ["A-01", "A-02", "A-03", "B-01", "B-02", "B-03", "C-01", "C-02", "C-03"] as const;
const TRUTHFULNESS = ["真实史实", "真实背景下的合理改编", "完全虚构的故事化情境"] as const;
const STORY_TYPES = ["故事叙事型", "现象科普型", "知识由来与应用型"] as const;
const ASSET_CATEGORIES = ["CHARACTER", "SCENE", "PROP", "CREATURE"] as const;
const STORYBOARD_TYPES = CANONICAL_STORYBOARD_TYPES;

function stageArtifact(workflow: any, stageId: VideosBatchStageId): any {
  return workflow?.stages?.[stageId]?.artifact;
}

function lessonInput(workflow: any) {
  const artifact = stageArtifact(workflow, "LESSON_INPUT") || {};
  return {
    projectId: String(artifact.projectId || "").trim(),
    lessonText: String(artifact.lessonText || "").trim()
  };
}

function lockedIntro(workflow: any) {
  const selectedIntroId = String(workflow?.selectedIntroId || "").trim();
  if (!workflow?.introLocked || !selectedIntroId) throw new Error("VideosBatch requires exactly one locked course intro before STORY_SCRIPT");
  const selection = stageArtifact(workflow, "COURSE_INTRO_SELECTION") || {};
  if (selectedIntroId === "CUSTOM" && selection.confirmedEntry) return selection.confirmedEntry;
  const intro = stageArtifact(workflow, "COURSE_INTRO_CANDIDATES") || {};
  const candidates = Array.isArray(intro.candidates) ? intro.candidates : [];
  const selected = candidates.find((candidate: any) => String(candidate?.id || "") === selectedIntroId);
  if (!selected) throw new Error(`Locked course intro ${selectedIntroId} is not present in the current candidate artifact`);
  return selected;
}

function storyScript(workflow: any) {
  const story = stageArtifact(workflow, "STORY_SCRIPT");
  if (!story) throw new Error("VideosBatch STORY_SCRIPT artifact is required");
  return story;
}

function assetPlan(workflow: any) {
  const plan = stageArtifact(workflow, "ASSET_PLAN");
  if (!plan) throw new Error("VideosBatch ASSET_PLAN artifact is required");
  return plan;
}

function confirmedAssets(workflow: any) {
  const plan = assetPlan(workflow);
  const confirmation = stageArtifact(workflow, "ASSET_CONFIRMATION") || {};
  if (confirmation.confirmed !== true) throw new Error("VideosBatch requires confirmed image assets before SCREENPLAY");
  const items = Array.isArray(plan.items) ? plan.items : [];
  const confirmedByKey = new Map(
    (Array.isArray(confirmation.items) ? confirmation.items : [])
      .map((item: any) => [String(item?.assetKey || "").trim(), item] as const)
  );
  return items.map((item: any) => {
    const confirmed = confirmedByKey.get(String(item?.assetKey || "").trim()) as any;
    return {
      assetKey: item.assetKey,
      publicAssetId: confirmed?.publicAssetId,
      category: item.category,
      name: item.name,
      description: item.description,
      continuityNotes: item.continuityNotes || "无",
      selectedAssetId: confirmed?.selectedAssetId
    };
  }).filter((item: any) => item.publicAssetId && item.selectedAssetId);
}

function labeledPromptMaterial(label: string, value: unknown): string {
  return `【${label}】\n${renderPromptMaterial(value)}`;
}

function screenplay(workflow: any) {
  const value = stageArtifact(workflow, "SCREENPLAY");
  if (!value) throw new Error("VideosBatch SCREENPLAY artifact is required");
  return value;
}

function finalStoryboard(workflow: any) {
  const value = stageArtifact(workflow, "FINAL_STORYBOARD");
  if (!value) throw new Error("VideosBatch FINAL_STORYBOARD artifact is required");
  return value;
}

const introSchema: JsonSchema = {
  type: "object", additionalProperties: false,
  properties: {
    candidates: { type: "array", minItems: 9, maxItems: 9, items: { type: "object", additionalProperties: false, properties: {
      id: { type: "string", enum: [...INTRO_IDS] }, name: { type: "string" }, creativeType: { type: "string" }, body: { type: "string" }, endingQuestion: { type: "string" }, truthfulnessCategory: { type: "string", enum: [...TRUTHFULNESS] }, truthfulnessNote: { type: "string" }
    }, required: ["id", "name", "creativeType", "body", "endingQuestion", "truthfulnessCategory", "truthfulnessNote"] } },
    recommendations: { type: "array", minItems: 3, maxItems: 3, items: { type: "object", additionalProperties: false, properties: { id: { type: "string", enum: [...INTRO_IDS] }, reason: { type: "string" } }, required: ["id", "reason"] } }
  }, required: ["candidates", "recommendations"]
};

const storySchema: JsonSchema = {
  type: "object", additionalProperties: false,
  properties: { schemaVersion: { type: "string", const: "2" }, kind: { type: "string", const: "LESSON_INTRO_VIDEO_SCRIPT" }, title: { type: "string" }, storyType: { type: "string", enum: [...STORY_TYPES] }, truthfulnessNote: { type: "string" }, content: { type: "string" } },
  required: ["schemaVersion", "kind", "title", "storyType", "truthfulnessNote", "content"]
};

const assetItemSchema: JsonSchema = {
  type: "object", additionalProperties: false,
  properties: {
    assetKey: { type: "string", pattern: "^(CHARACTER|PROP|SCENE|CREATURE)-[A-Z0-9][A-Z0-9_-]{1,63}$" },
    category: { type: "string", enum: [...ASSET_CATEGORIES] },
    name: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
    sourceEvidence: { type: "string", minLength: 1 },
    required: { type: "boolean" },
    usage: { type: "string", minLength: 1 },
    prompt: { type: "string", minLength: 1 },
    negativePrompt: { type: "string", minLength: 1 },
    aspectRatio: { type: "string", const: "16:9" },
    continuityNotes: { type: ["string", "null"] },
    variantNotes: { type: ["string", "null"] }
  },
  required: ["assetKey", "category", "name", "description", "sourceEvidence", "required", "usage", "prompt", "negativePrompt", "aspectRatio", "continuityNotes", "variantNotes"]
};

const candidateInventoryItemSchema: JsonSchema = {
  type: "object", additionalProperties: false,
  properties: {
    assetKey: { type: "string", pattern: "^(CHARACTER|PROP|SCENE|CREATURE)-[A-Z0-9][A-Z0-9_-]{1,63}$" },
    name: { type: "string", minLength: 1 },
    category: { type: "string", enum: [...ASSET_CATEGORIES] },
    required: { type: "boolean" },
    sourceEvidence: { type: "string", minLength: 1 },
    decision: { type: "string", enum: ["required", "optional", "omitted"] }
  },
  required: ["assetKey", "name", "category", "required", "sourceEvidence", "decision"]
};

const assetSchema: JsonSchema = {
  type: "object", additionalProperties: false,
  properties: {
    schemaVersion: { type: "string", const: "1" }, title: { type: "string", minLength: 1 },
    kind: { type: "string", const: "VIDEO_ASSET_PLAN" }, subject: { type: "string", minLength: 1 }, gradeBand: { type: "string", minLength: 1 },
    candidateAssets: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    candidateInventory: { type: "array", minItems: 1, items: candidateInventoryItemSchema },
    omissionCheck: { type: "string", minLength: 1 },
    styleSpec: { type: "string", minLength: 1 },
    negativePrompt: { type: "string", minLength: 1 },
    items: { type: "array", minItems: 1, items: assetItemSchema }
  },
  required: ["schemaVersion", "title", "kind", "subject", "gradeBand", "candidateAssets", "candidateInventory", "omissionCheck", "styleSpec", "negativePrompt", "items"]
};

const evidenceSchema: JsonSchema = { type: "object", additionalProperties: false, properties: { source: { type: "string" }, quote: { type: "string" } }, required: ["source", "quote"] };

const screenplaySceneSchema: JsonSchema = {
  type: "object", additionalProperties: false,
  properties: { sequence: { type: "integer", minimum: 1, maximum: 48 }, title: { type: "string" }, knowledgeFocus: { type: "string" }, emotionalPurpose: { type: "string" }, visualPresentation: { type: "string" }, ambientSound: { type: "string" }, effectSound: { type: "string" }, interactionSound: { type: "string" }, voice: { type: "string" }, visualAction: { type: "string" }, dialogue: { type: "string" }, evidence: { type: "array", items: evidenceSchema } },
  required: ["sequence", "title", "knowledgeFocus", "emotionalPurpose", "visualPresentation", "ambientSound", "effectSound", "interactionSound", "voice", "visualAction", "dialogue", "evidence"]
};

const screenplaySchema: JsonSchema = {
  type: "object", additionalProperties: false,
  properties: { schemaVersion: { type: "string", const: "1" }, kind: { type: "string", const: "VIDEO_SCREENPLAY" }, title: { type: "string" }, subject: { type: "string" }, gradeBand: { type: "string" }, storyType: { type: "string", enum: [...STORYBOARD_TYPES] }, targetDurationSeconds: { type: "integer", enum: [...COURSE_VIDEO_DURATION_SECONDS] }, scenes: { type: "array", minItems: 1, maxItems: 48, items: screenplaySceneSchema } },
  required: ["schemaVersion", "kind", "title", "subject", "gradeBand", "storyType", "targetDurationSeconds", "scenes"]
};

// FINAL_STORYBOARD carries semantic labels only. Stable public IDs are
// server-owned and are introduced by the derived COPYABLE_PROMPT stage.
const storyboardSchema: JsonSchema = {
  type: "object", additionalProperties: false,
  properties: { schemaVersion: { type: "string", const: CANONICAL_STORYBOARD_SCHEMA_VERSION }, title: { type: "string", minLength: 1 }, kind: { type: "string", const: "VIDEO_STORYBOARD" }, goal: { type: "string", minLength: 1 }, overallScript: { type: "string", minLength: 1 }, visualContinuity: { type: "string", minLength: 1 }, targetDuration: { type: "integer", enum: [...COURSE_VIDEO_DURATION_SECONDS] }, aspectRatio: { type: "string", const: "16:9" }, deliveryMode: { type: "string", const: "SEGMENTED_MP4" }, format: { type: "string", const: "FINAL_10_SECOND" }, storyType: { type: "string", enum: [...STORYBOARD_TYPES] }, segments: canonicalStoryboardSegmentsSchema() },
  required: ["schemaVersion", "title", "kind", "goal", "overallScript", "visualContinuity", "targetDuration", "aspectRatio", "deliveryMode", "format", "storyType", "segments"]
};

function storyboardSchemaForWorkflow(workflow?: VideosBatchWorkflowState): JsonSchema {
  const screenplay = workflow?.stages?.SCREENPLAY?.artifact as Record<string, unknown> | undefined;
  const type = normalizeStoryboardType(screenplay?.storyType);
  if (!type) return storyboardSchema;
  const properties = storyboardSchema.properties as Record<string, unknown>;
  const targetDuration = Number(screenplay?.targetDurationSeconds);
  const expectedSegments = Number.isInteger(targetDuration) ? targetDuration / 10 : undefined;
  return {
    ...storyboardSchema,
    properties: {
      ...properties,
      // Once the screenplay is known, use one handbook layout only. This is
      // provider-compatible and keeps the mutual-exclusion rule explicit.
      storyType: { type: "string", const: type },
      targetDuration: Number.isInteger(targetDuration) && targetDuration > 0
        ? { type: "integer", const: targetDuration }
        : properties.targetDuration,
      segments: canonicalStoryboardSegmentsSchema(type, expectedSegments, 3)
    }
  };
}

const copyableSegmentSchema: JsonSchema = { type: "object", additionalProperties: false, properties: { sequence: { type: "integer", minimum: 1, maximum: 15 }, text: { type: "string" }, referenceAssetIds: { type: "array", maxItems: 7, items: { type: "string", pattern: "^P\\d{3,}-A\\d{3,}$" } } }, required: ["sequence", "text", "referenceAssetIds"] };
const copyableSchema: JsonSchema = { type: "object", additionalProperties: false, properties: { schemaVersion: { type: "string", const: "1" }, fullText: { type: "string" }, status: { type: "string", enum: ["READY", "PARTIAL", "FAILED"] }, failedSegments: { type: "array", items: { type: "integer", minimum: 1, maximum: 15 } }, segments: { type: "array", maxItems: 15, items: copyableSegmentSchema } }, required: ["schemaVersion", "fullText", "status", "failedSegments", "segments"] };

const INTRO_SYSTEM = loadPromptTemplate("videosbatch-intro-candidates");

const STORY_SYSTEM = loadPromptTemplate("videosbatch-story-script");

const ASSET_SYSTEM = loadPromptTemplate("videosbatch-asset-plan");

const SCREENPLAY_SYSTEM = loadPromptTemplate("videosbatch-screenplay");

const STORYBOARD_SYSTEM = loadPromptTemplate("videosbatch-final-storyboard");

const COPYABLE_SYSTEM = loadPromptTemplate("videosbatch-copyable-prompt");

const specs: Record<VideosBatchTextStageId, VideosBatchTextStageSpec> = {
  COURSE_INTRO_CANDIDATES: { id: "COURSE_INTRO_CANDIDATES", schemaName: "videosbatch_course_intro_candidates", systemPrompt: INTRO_SYSTEM, jsonSchema: introSchema, buildUserPrompt(workflow) { const { lessonText } = lessonInput(workflow); return `<uploaded_lesson_material>\n${lessonText}\n</uploaded_lesson_material>\n\n请严格生成 A-01、A-02、A-03、B-01、B-02、B-03、C-01、C-02、C-03 共9套课程导入。方向覆盖：A1知识产生要解决的原始问题、A2可靠史实/时代背景、A3方法工具演变；B1古代真实需求、B2古今对照、B3现代工程科技应用；C1生活冲突/错误现场、C2推理游戏挑战、C3科技或自然异常。每套正文200—300字，必须有明确情境、人物需求/问题、冲突升级、数学知识成为关键线索的原因和停止位置；结尾只留悬问。完成后输出“推荐最值得继续制作的3套”对应的3条推荐理由。`; } },
  STORY_SCRIPT: { id: "STORY_SCRIPT", schemaName: "videosbatch_story_script", systemPrompt: STORY_SYSTEM, jsonSchema: storySchema, buildUserPrompt(workflow) { const { lessonText } = lessonInput(workflow); return `${labeledPromptMaterial("教案内容", lessonText)}\n\n${labeledPromptMaterial("唯一锁定的课程导入", lockedIntro(workflow))}\n\n只能围绕这一套课程导入扩写一个故事。完整故事600—800字，保持课题、知识点、故事方向和真实性等级；开头有悬念/真实需求，冲突升级，数学知识是关键线索，结尾只留问题，不给答案。`; } },
  ASSET_PLAN: { id: "ASSET_PLAN", schemaName: "videosbatch_video_asset_plan", systemPrompt: ASSET_SYSTEM, jsonSchema: assetSchema, buildUserPrompt(workflow) { return `${labeledPromptMaterial("已锁定故事文稿", storyScript(workflow))}\n\n先逐段扫描并列候选资产，再按四类归类、去重、做遗漏检查，最后输出 items。items 使用 assetKey，不得输出 P001-A001 或任何真实 assetId。所有确定资产必须使用影视级 3D 国漫 CG 风格及对应人物三视图/场景/道具/生物模板和统一负面提示词。`; } },
  SCREENPLAY: { id: "SCREENPLAY", schemaName: "videosbatch_video_screenplay", systemPrompt: SCREENPLAY_SYSTEM, jsonSchema: screenplaySchema, buildUserPrompt(workflow) { return `<video_asset_plan_material>\n${labeledPromptMaterial("唯一故事文稿", storyScript(workflow))}\n\n${labeledPromptMaterial("当前已确认资产", confirmedAssets(workflow))}\n</video_asset_plan_material>\n\n生成正式 VIDEO_SCREENPLAY；targetDurationSeconds 必须从90/100/110/120/130/140/150中选择；完整覆盖故事开头到结尾。`; } },
  FINAL_STORYBOARD: { id: "FINAL_STORYBOARD", schemaName: "videosbatch_final_storyboard", systemPrompt: STORYBOARD_SYSTEM, jsonSchema: storyboardSchema, buildUserPrompt(workflow) { const script = screenplay(workflow); const targetDuration = Number(script.targetDurationSeconds) || 0; const expectedSegments = targetDuration > 0 ? targetDuration / 10 : "targetDuration/10"; const semanticAssets = confirmedAssets(workflow).map((asset: any) => { const { publicAssetId: _publicAssetId, selectedAssetId: _selectedAssetId, ...rest } = asset; return rest; }); const type = normalizeStoryboardType(script.storyType) || "STORY"; const labelExamples = type === "STORY" ? "【人物：资产原名】、【场景：资产原名】、【道具：资产原名】" : type === "SCIENCE" ? "【主体：资产原名】、【场景：资产原名】、【辅助元素：资产原名】" : "【核心意象：资产原名】、【场景：资产原名】、【辅助元素：资产原名】"; return `<video_screenplay_material>\n${labeledPromptMaterial("正式视频剧本", script)}\n\n${labeledPromptMaterial("已确认资产的语义清单（只能使用名称/类别标签，不得输出稳定编号）", semanticAssets)}\n</video_screenplay_material>\n\n本次 storyType 必须是 ${type}；本次 targetDuration 必须严格等于 ${targetDuration || "正式剧本时长"} 秒，必须返回恰好 ${expectedSegments} 条 segments，不能返回9条或截断子集。第一条/场景切换处 chapter 使用“第N章”，同一场次后续条目 chapter 为 null。每个 timeRange 使用“起始-结束秒”（如0-2秒），每个主分镜首个子镜头不超过2秒，全部 voice 合计1—2句。references 只允许使用确认清单中的原名，并使用 ${labelExamples}；不要创造清单外的标签。`; } },
  COPYABLE_PROMPT: { id: "COPYABLE_PROMPT", schemaName: "videosbatch_copyable_storyboard_prompt", systemPrompt: COPYABLE_SYSTEM, jsonSchema: copyableSchema, buildUserPrompt(workflow) { return `${labeledPromptMaterial("正式分镜，事实源，不得改写", finalStoryboard(workflow))}\n\n${labeledPromptMaterial("当前已确认资产", confirmedAssets(workflow))}\n\n只生成派生垫图副本：资产编号只能插入画面效果子镜头；同一分镜同一资产只标一次；每条最多标注7个资产ID；禁止使用按位置命名的图片引用；不新增或删除任何原分镜内容。`; } }
};

export function getVideosBatchTextStageSpec(stageId: VideosBatchTextStageId, workflow?: VideosBatchWorkflowState): VideosBatchTextStageSpec {
  const spec = specs[stageId];
  if (!spec) throw new Error(`No VideosBatch text-stage spec registered for ${stageId}`);
  if (stageId === "FINAL_STORYBOARD") return { ...spec, jsonSchema: storyboardSchemaForWorkflow(workflow) };
  return spec;
}

/**
 * Contract-repair schema for an explicitly missing storyboard range. The
 * response contains only the requested segment rows; the stage adapter
 * appends them to the previously validated rows before running full gates.
 */
export function getVideosBatchStoryboardSegmentRepairSpec(
  workflow: VideosBatchWorkflowState,
  count: number,
  startSequence: number
): VideosBatchTextStageSpec {
  const base = getVideosBatchTextStageSpec("FINAL_STORYBOARD", workflow);
  const screenplay = workflow.stages.SCREENPLAY?.artifact as Record<string, unknown> | undefined;
  const type = normalizeStoryboardType(screenplay?.storyType) || "STORY";
  const boundedCount = Math.max(1, Math.min(15, Math.floor(Number(count) || 1)));
  const boundedStart = Math.max(1, Math.floor(Number(startSequence) || 1));
  return {
    ...base,
    schemaName: "videosbatch_final_storyboard_segment_repair",
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        segments: {
          type: "array",
          minItems: boundedCount,
          maxItems: boundedCount,
          items: canonicalSegmentSchema(type, 3)
        }
      },
      required: ["segments"]
    },
    buildUserPrompt(currentWorkflow) {
      return `${base.buildUserPrompt(currentWorkflow)}\n\n<partial_storyboard_repair>只返回 segments 数组，不返回其他顶层字段。本次只补齐 sequence=${boundedStart} 到 ${boundedStart + boundedCount - 1} 的缺失主分镜，共 ${boundedCount} 条；每条严格使用当前 storyType=${type} 的字段结构、3个子镜头（2/4/4秒）和确认资产标签。不要重复返回已有 sequence，也不要返回9条默认结果。</partial_storyboard_repair>`;
    }
  };
}
