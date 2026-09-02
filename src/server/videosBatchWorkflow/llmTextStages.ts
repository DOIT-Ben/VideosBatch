import type { VideosBatchStageId } from "../../shared/videosBatchWorkflow";
import {
  createVideosBatchLlmAttemptBudget,
  type VideosBatchLlmAttemptBudget,
  type VideosBatchLlmExecutor,
  type StructuredGenerationRequest,
  type StructuredGenerationResult,
  VideosBatchLlmError
} from "./llmExecutor";
import {
  CANONICAL_STORYBOARD_SCHEMA_VERSION,
  CANONICAL_STORYBOARD_TYPES,
  POSITIONAL_ASSET_REFERENCE_PATTERN,
  STABLE_ASSET_ID_PATTERN,
  canonicalRoleField,
  canonicalSupportField,
  canonicalStoryboardSourceHash,
  contentHash,
  hasAnyText,
  nonPunctuationLength,
  normalizeStoryboardArtifact,
  normalizeStoryboardType,
  renderCanonicalSegmentText,
  sentenceCount,
  semanticLabelText
} from "./canonicalStoryboard";
import { PromptMaterialTooLargeError, renderPromptMaterial } from "./promptMaterial";
import type { StageDefinition, StageExecutionContext, StageRegistry, ValidationResult } from "./stageContracts";
import {
  COURSE_VIDEO_DURATION_SECONDS,
  VIDEOS_BATCH_TEXT_STAGE_IDS,
  getVideosBatchStoryboardSegmentRepairSpec,
  getVideosBatchTextStageSpec,
  type VideosBatchTextStageSpec,
  type VideosBatchTextStageId
} from "./textStageSpecs";

const INTRO_IDS = ["A-01", "A-02", "A-03", "B-01", "B-02", "B-03", "C-01", "C-02", "C-03"] as const;
const TRUTHFULNESS = new Set(["真实史实", "真实背景下的合理改编", "完全虚构的故事化情境"]);
const STORY_TYPES = new Set(["故事叙事型", "现象科普型", "知识由来与应用型"]);
const ASSET_CATEGORIES = new Set(["CHARACTER", "SCENE", "PROP", "CREATURE"]);
const MAX_STAGE_ATTEMPTS = 3;
// Contract repair is a separate, bounded operation. It must remain available
// even when the initial provider sequence consumed all three submissions.
const MAX_CONTRACT_REPAIR_ATTEMPTS = 2;
const OLD_STORYBOARD_FIELDS = ["visualPrompt", "narration", "subtitles", "teachingPurpose", "transition", "subshots"] as const;

function result(errors: string[]): ValidationResult { return { ok: errors.length === 0, errors }; }
function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
function text(value: unknown): string { return String(value ?? "").trim(); }
function textLength(value: unknown): number { return Array.from(text(value)).length; }
function hasAny(value: unknown, terms: readonly string[]): boolean { return hasAnyText(value, terms); }
function canonicalStoryType(value: unknown) { return normalizeStoryboardType(value); }

function explicitlyOmittedCategory(value: unknown, category: string) {
  const omission = text(value);
  const terms: Record<string, string[]> = {
    CHARACTER: ["人物", "角色", "拟人动物"],
    SCENE: ["场景", "空间环境", "地点"],
    PROP: ["道具", "器物", "工具"],
    CREATURE: ["神兽", "灵宠", "非拟人生物", "生物", "动物"]
  };
  return (terms[category] || []).some((term) => new RegExp(`(?:不存在|没有|无|未(?:发现|出现|建立|创建|纳入)|不含)[^。；;，,]{0,32}${term}`, "u").test(omission));
}

function stageReasoningEffort(stageId: VideosBatchTextStageId): StructuredGenerationRequest["reasoningEffort"] | undefined {
  if (stageId !== "ASSET_PLAN") return undefined;
  const configured = text(process.env.VIDEOSBATCH_ASSET_PLAN_REASONING).toLowerCase();
  const allowed = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
  // Asset decomposition is a deterministic extraction task by default. Keep
  // an explicit override for providers that need a reasoning pass.
  return (allowed.has(configured) ? configured : "none") as StructuredGenerationRequest["reasoningEffort"];
}

function stageTimeoutMs(stageId: VideosBatchTextStageId): number | undefined {
  const defaults: Partial<Record<VideosBatchTextStageId, number>> = {
    // Asset plans contain long per-asset prompts. Keep their budget separate
    // from short text stages so a normal 120s timeout does not cut off a valid
    // structured response and trigger needless provider failover.
    ASSET_PLAN: 180_000,
    // A complete 90-150 second storyboard has many nested subshots and can
    // legitimately take longer than the ordinary text-stage window.
    FINAL_STORYBOARD: 300_000
  };
  const defaultTimeout = defaults[stageId];
  if (!defaultTimeout) return undefined;
  const envKey = stageId === "ASSET_PLAN"
    ? "VIDEOSBATCH_ASSET_PLAN_TIMEOUT_MS"
    : "VIDEOSBATCH_FINAL_STORYBOARD_TIMEOUT_MS";
  const configured = Number(text(process.env[envKey]));
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : defaultTimeout;
}

function stageMaxOutputTokens(stageId: VideosBatchTextStageId): number | undefined {
  const defaults: Partial<Record<VideosBatchTextStageId, number>> = {
    ASSET_PLAN: 12_000,
    FINAL_STORYBOARD: 24_000
  };
  const defaultLimit = defaults[stageId];
  if (!defaultLimit) return undefined;
  const envKey = stageId === "ASSET_PLAN"
    ? "VIDEOSBATCH_ASSET_PLAN_MAX_OUTPUT_TOKENS"
    : "VIDEOSBATCH_FINAL_STORYBOARD_MAX_OUTPUT_TOKENS";
  const configured = Number(text(process.env[envKey]));
  // Keep enough room for the full nested contract while preventing an
  // accidental unbounded response from holding the provider connection.
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : defaultLimit;
}

function promptStats(systemPrompt: string, userPrompt: string, jsonSchema: Record<string, unknown>) {
  const systemChars = Array.from(systemPrompt).length;
  const userChars = Array.from(userPrompt).length;
  const schemaChars = JSON.stringify(jsonSchema).length;
  return {
    system_prompt_chars: String(systemChars),
    user_prompt_chars: String(userChars),
    schema_chars: String(schemaChars),
    prompt_chars_total: String(systemChars + userChars + schemaChars)
  };
}

function confirmedPublicAssetIds(ctx: StageExecutionContext): Set<string> {
  const confirmation = record(ctx.workflow.stages.ASSET_CONFIRMATION?.artifact);
  const plan = record(ctx.workflow.stages.ASSET_PLAN?.artifact);
  const planByKey = new Map((Array.isArray(plan.items) ? plan.items : []).map((item: any) => [text(item.assetKey), item]));
  const ids = new Set<string>();
  for (const item of Array.isArray(confirmation.items) ? confirmation.items : []) {
    const candidate = planByKey.get(text(item?.assetKey));
    const id = text(item?.publicAssetId || candidate?.publicAssetId || candidate?.assetId);
    if (id) ids.add(id);
  }
  return ids;
}

function validateIntro(artifact: unknown): ValidationResult {
  const value = record(artifact);
  const errors: string[] = [];
  const candidates = Array.isArray(value.candidates) ? value.candidates : [];
  const recommendations = Array.isArray(value.recommendations) ? value.recommendations : [];
  if (candidates.length !== 9) errors.push(`COURSE_INTRO_CANDIDATES expected exactly 9 candidates, got ${candidates.length}`);
  const ids = candidates.map((item: any) => text(item.id));
  for (const id of INTRO_IDS) if (!ids.includes(id)) errors.push(`COURSE_INTRO_CANDIDATES missing ${id}`);
  for (const id of ids) if (!(INTRO_IDS as readonly string[]).includes(id)) errors.push(`COURSE_INTRO_CANDIDATES contains unknown id ${id || "<empty>"}`);
  if (new Set(ids).size !== ids.length) errors.push("COURSE_INTRO_CANDIDATES candidate ids must be unique");
  for (const candidate of candidates) {
    const id = text(candidate?.id || "candidate");
    const bodySize = textLength(candidate?.body);
    if (bodySize < 200 || bodySize > 300) errors.push(`${id} body must be 200-300 characters, got ${bodySize}`);
    for (const field of ["name", "creativeType", "body", "endingQuestion", "truthfulnessCategory", "truthfulnessNote"]) {
      if (!text(candidate?.[field])) errors.push(`${id} requires ${field}`);
    }
    if (!TRUTHFULNESS.has(text(candidate?.truthfulnessCategory))) errors.push(`${id} has invalid truthfulnessCategory`);
    if (!hasAny(candidate?.endingQuestion, ["？", "?", "为什么", "怎么", "怎样", "如何", "能否"])) errors.push(`${id} endingQuestion must remain an open question`);
    if (hasAny(candidate?.body, ["分镜", "旁白清单", "字幕清单", "正式视频剧本", "图片资产建议"])) errors.push(`${id} body must not jump to a later workflow stage`);
  }
  const creativeTypes = new Set(candidates.map((item: any) => text(item.creativeType)).filter(Boolean));
  if (creativeTypes.size < 6) errors.push("COURSE_INTRO_CANDIDATES must contain at least 6 materially different creativeType values");
  if (new Set(candidates.map((item: any) => text(item.body))).size !== candidates.length) errors.push("COURSE_INTRO_CANDIDATES bodies must not be duplicated");
  const directionTerms: Record<string, string[]> = {
    "A-01": ["原始问题", "产生", "为什么"],
    "A-02": ["史实", "时代", "背景"],
    "A-03": ["工具", "方法", "演变"],
    "B-01": ["古代", "需求"],
    "B-02": ["古今", "对照"],
    "B-03": ["工程", "科技", "应用"],
    "C-01": ["生活", "错误", "冲突"],
    "C-02": ["推理", "挑战", "游戏"],
    "C-03": ["异常", "自然", "科技"]
  };
  for (const candidate of candidates) {
    const expected = directionTerms[text(candidate.id)] || [];
    if (expected.length && !expected.some((term) => hasAny(candidate.creativeType, [term]) || hasAny(candidate.body, [term]))) {
      errors.push(`${text(candidate.id)} does not identify its canonical direction`);
    }
  }
  if (recommendations.length !== 3) errors.push(`COURSE_INTRO_CANDIDATES expected exactly 3 recommendations, got ${recommendations.length}`);
  const recommendationIds = recommendations.map((item: any) => text(item.id));
  if (new Set(recommendationIds).size !== recommendationIds.length) errors.push("COURSE_INTRO_CANDIDATES recommendation ids must be unique");
  for (const recommendation of recommendations) {
    const id = text(recommendation?.id);
    if (!ids.includes(id)) errors.push(`Recommendation references unknown candidate ${id}`);
    const reason = text(recommendation?.reason);
    if (!reason) errors.push(`Recommendation ${id} requires reason`);
    if (textLength(reason) > 80) errors.push(`Recommendation ${id} reason must be at most 80 characters`);
    if (!hasAny(reason, ["课堂", "知识", "视频", "制作", "吸引", "可行"])) errors.push(`Recommendation ${id} reason must cover classroom, knowledge, or production value`);
  }
  return result(errors);
}

function validateStoryScript(artifact: unknown, ctx: StageExecutionContext): ValidationResult {
  const value = record(artifact);
  const errors: string[] = [];
  if (!ctx.workflow.introLocked || !ctx.workflow.selectedIntroId) errors.push("STORY_SCRIPT requires one locked course intro");
  if (value.schemaVersion !== "2") errors.push("STORY_SCRIPT schemaVersion must be 2");
  if (value.kind !== "LESSON_INTRO_VIDEO_SCRIPT") errors.push("STORY_SCRIPT kind must be LESSON_INTRO_VIDEO_SCRIPT");
  if (!text(value.title)) errors.push("STORY_SCRIPT requires title");
  if (!STORY_TYPES.has(text(value.storyType))) errors.push("STORY_SCRIPT storyType must be one of the handbook story types");
  if (!TRUTHFULNESS.has(text(value.truthfulnessNote).split(/[。；;]/u)[0])) {
    if (!hasAny(value.truthfulnessNote, [...TRUTHFULNESS])) errors.push("STORY_SCRIPT truthfulnessNote must identify one handbook truthfulness category");
  }
  const length = textLength(value.content);
  if (length < 600 || length > 800) errors.push(`STORY_SCRIPT content must be 600-800 characters, got ${length}`);
  if (Array.isArray(value.stories)) errors.push("STORY_SCRIPT must contain one story document, not a stories array");
  if (hasAny(value.content, ["分镜", "镜头表", "旁白清单", "字幕清单", "图片资产", "正式视频剧本"])) errors.push("STORY_SCRIPT content must not contain storyboard, narration list, or asset planning");
  const storyContent = text(value.content);
  if (!hasAny(storyContent, ["？", "?", "为什么", "怎么", "怎样", "如何"])) errors.push("STORY_SCRIPT must end with an unresolved question");
  if (storyContent && !/[？?。！!]$/u.test(storyContent)) errors.push("STORY_SCRIPT content must end at a complete unresolved question or sentence");
  return result(errors);
}

function validateAssetPlan(artifact: unknown): ValidationResult {
  const value = record(artifact);
  const errors: string[] = [];
  if (value.schemaVersion !== "1") errors.push("ASSET_PLAN schemaVersion must be 1");
  if (value.kind !== "VIDEO_ASSET_PLAN") errors.push("ASSET_PLAN kind must be VIDEO_ASSET_PLAN");
  for (const field of ["title", "subject", "gradeBand", "omissionCheck", "styleSpec", "negativePrompt"]) if (!text(value[field])) errors.push(`ASSET_PLAN requires ${field}`);
  const items = Array.isArray(value.items) ? value.items : [];
  const inventory = Array.isArray(value.candidateInventory) ? value.candidateInventory : [];
  const candidateAssets = Array.isArray(value.candidateAssets) ? value.candidateAssets : [];
  if (!items.length) errors.push("ASSET_PLAN requires at least one item");
  if (!inventory.length) errors.push("ASSET_PLAN requires a candidateInventory containing required and optional objects");
  if (!candidateAssets.length) errors.push("ASSET_PLAN requires a complete candidateAssets inventory");
  if (!hasAny(value.omissionCheck, ["二次核对", "遗漏检查", "四类", "逐段回看", "逐句回看", "再次回看", "再次核对", "完整回看", "全面核对"])) {
    errors.push("ASSET_PLAN omissionCheck must document the second pass across four asset classes");
  }
  if (!hasAny(value.styleSpec, ["影视级3D国漫CG风格", "影视级 3D 国漫 CG 风格"])) errors.push("ASSET_PLAN styleSpec must lock the handbook visual style");
  const inventoryKeys = new Set<string>();
  for (const entry of inventory) {
    const key = text(entry?.assetKey);
    if (!key || inventoryKeys.has(key)) errors.push(`ASSET_PLAN candidateInventory assetKey must be unique: ${key || "<empty>"}`);
    inventoryKeys.add(key);
    if (!ASSET_CATEGORIES.has(text(entry?.category))) errors.push(`ASSET_PLAN candidateInventory ${key || "<empty>"} has invalid category`);
    for (const field of ["name", "sourceEvidence"]) if (!text(entry?.[field])) errors.push(`ASSET_PLAN candidateInventory ${key || "<empty>"} requires ${field}`);
    if (entry?.required !== true && entry?.required !== false) errors.push(`ASSET_PLAN candidateInventory ${key || "<empty>"} requires boolean required status`);
    if (!["required", "optional", "omitted"].includes(text(entry?.decision))) errors.push(`ASSET_PLAN candidateInventory ${key || "<empty>"} has invalid decision`);
    if (text(entry?.decision) === "omitted" && entry?.required === true) errors.push(`ASSET_PLAN omitted inventory item ${key || "<empty>"} cannot be required`);
  }
  for (const candidate of candidateAssets) if (!text(candidate)) errors.push("ASSET_PLAN candidateAssets entries must be non-empty");
  const keys = items.map((item: any) => text(item.assetKey));
  if (new Set(keys).size !== keys.length) errors.push("ASSET_PLAN assetKey values must be unique");
  for (const category of ASSET_CATEGORIES) {
    if (items.some((item: any) => text(item.category) === category)) continue;
    const explicitlyOmitted = inventory.some((item: any) => text(item?.category) === category && text(item?.decision) === "omitted");
    if (!explicitlyOmitted && !explicitlyOmittedCategory(value.omissionCheck, category)) {
      errors.push(`ASSET_PLAN must cover asset category ${category} or explicitly record that it is absent`);
    }
  }
  for (const item of items) {
    const key = text(item.assetKey);
    const category = text(item.category);
    if (!/^(CHARACTER|PROP|SCENE|CREATURE)-[A-Z0-9][A-Z0-9_-]{1,63}$/.test(key)) errors.push(`ASSET_PLAN invalid assetKey ${key || "<empty>"}`);
    if (!ASSET_CATEGORIES.has(category)) errors.push(`ASSET_PLAN ${key} has invalid category ${category}`);
    if (key && category && !key.startsWith(`${category}-`)) errors.push(`ASSET_PLAN ${key} must use ${category}- prefix`);
    for (const field of ["name", "description", "sourceEvidence", "usage", "prompt", "negativePrompt"]) if (!text(item[field])) errors.push(`ASSET_PLAN ${key} requires ${field}`);
    if (item.required !== true && item.required !== false) errors.push(`ASSET_PLAN ${key} requires boolean required status`);
    if (text(item.aspectRatio) !== "16:9") errors.push(`ASSET_PLAN ${key} aspectRatio must be 16:9`);
    if (!hasAny(item.prompt, ["影视级3D国漫CG风格", "影视级 3D 国漫 CG 风格"])) errors.push(`ASSET_PLAN ${key} prompt must preserve the canonical 3D Chinese animation style`);
    const negativeText = `${text(item.negativePrompt)} ${text(item.prompt)}`.replace(/\s+/gu, "");
    for (const negative of ["不要文字", "不要水印", "不要logo", "不要主体裁切", "不要主体缺失", "不要多余人物", "不要复杂背景", "不要畸形肢体", "不要低清模糊"]) {
      if (!negativeText.includes(negative)) errors.push(`ASSET_PLAN ${key} must include negative constraint: ${negative}`);
    }
    for (const forbidden of ["assetId", "selectedAssetId", "generationIds", "candidateAssetIds", "referenceId", "publicAssetId"]) if (Object.hasOwn(item, forbidden)) errors.push(`ASSET_PLAN model output must not own ${forbidden}`);
  }
  const inventoryByKey = new Map(inventory.map((item: any) => [text(item.assetKey), item]));
  for (const item of items) {
    const inventoryItem = inventoryByKey.get(text(item.assetKey));
    if (!inventoryItem) errors.push(`ASSET_PLAN ${text(item.assetKey)} must appear in candidateInventory`);
    else if (Boolean(inventoryItem.required) !== Boolean(item.required)) errors.push(`ASSET_PLAN ${text(item.assetKey)} required status must match candidateInventory`);
  }
  return result(errors);
}

function screenplayAssetsConfirmed(ctx: StageExecutionContext) {
  const confirmation = record(ctx.workflow.stages.ASSET_CONFIRMATION?.artifact);
  if (confirmation.confirmed !== true) return false;
  const plan = record(ctx.workflow.stages.ASSET_PLAN?.artifact);
  const planItems = Array.isArray(plan.items) ? plan.items : [];
  const byKey = new Map((Array.isArray(confirmation.items) ? confirmation.items : []).map((item: any) => [text(item.assetKey), item]));
  const available = new Set(ctx.assets.map((asset) => asset.id));
  // The API context carries the persisted session asset snapshot. An empty
  // snapshot there means the selected native image is missing, not that the
  // confirmation can be trusted. Pure contract fixtures may omit `store` and
  // continue to validate their model-owned IDs without a native store.
  const requiresPersistedAssets = Boolean(ctx.store);
  const requiredPlanItems = planItems.filter((item: any) => item?.required !== false);
  return requiredPlanItems.length > 0 && requiredPlanItems.every((item: any) => {
    const confirmed = byKey.get(text(item.assetKey));
    const selected = text(confirmed?.selectedAssetId);
    const candidates = Array.isArray(confirmed?.candidateAssetIds) ? confirmed.candidateAssetIds.map(text) : [];
    return Boolean(text(confirmed?.publicAssetId) && selected && candidates.includes(selected) && (!requiresPersistedAssets || available.has(selected)));
  });
}

function validateScreenplay(artifact: unknown, ctx: StageExecutionContext): ValidationResult {
  const value = record(artifact);
  const errors: string[] = [];
  if (!screenplayAssetsConfirmed(ctx)) errors.push("SCREENPLAY requires confirmed assets");
  if (value.schemaVersion !== "1") errors.push("SCREENPLAY schemaVersion must be 1");
  if (value.kind !== "VIDEO_SCREENPLAY") errors.push("SCREENPLAY kind must be VIDEO_SCREENPLAY");
  if (!text(value.title) || !text(value.subject) || !text(value.gradeBand)) errors.push("SCREENPLAY requires title, subject, and gradeBand");
  if (!canonicalStoryType(value.storyType)) errors.push("SCREENPLAY storyType must be STORY, SCIENCE, or KNOWLEDGE");
  const duration = Number(value.targetDurationSeconds);
  if (!(COURSE_VIDEO_DURATION_SECONDS as readonly number[]).includes(duration)) errors.push(`SCREENPLAY targetDurationSeconds must be one of ${COURSE_VIDEO_DURATION_SECONDS.join(", ")}`);
  const scenes = Array.isArray(value.scenes) ? value.scenes : [];
  if (!scenes.length) errors.push("SCREENPLAY requires at least one scene");
  scenes.forEach((scene: any, index: number) => {
    const expected = index + 1;
    if (Number(scene.sequence) !== expected) errors.push(`SCREENPLAY scene sequence must be continuous; expected ${expected}`);
    for (const field of ["title", "knowledgeFocus", "emotionalPurpose", "visualPresentation", "ambientSound", "effectSound", "interactionSound", "voice", "visualAction", "dialogue"]) if (!text(scene[field])) errors.push(`SCREENPLAY scene ${expected} requires ${field}`);
    if (!Array.isArray(scene.evidence)) errors.push(`SCREENPLAY scene ${expected} evidence must be an array`);
    const all = [scene.title, scene.knowledgeFocus, scene.emotionalPurpose, scene.visualPresentation, scene.ambientSound, scene.effectSound, scene.interactionSound, scene.voice, scene.visualAction, scene.dialogue].join(" ");
    if (STABLE_ASSET_ID_PATTERN.test(all)) errors.push(`SCREENPLAY scene ${expected} must not contain stable asset IDs`);
  });
  return result(errors);
}

function semanticLabelValid(label: string, type: string): boolean {
  if (!label || STABLE_ASSET_ID_PATTERN.test(label) || POSITIONAL_ASSET_REFERENCE_PATTERN.test(label)) return false;
  const prefixes = type === "STORY" ? ["人物", "场景", "道具"] : type === "SCIENCE" ? ["主体", "场景", "辅助元素"] : ["核心意象", "场景", "辅助元素"];
  return prefixes.some((prefix) => label.startsWith(`【${prefix}：`) && label.endsWith("】") && semanticLabelText(label).length > 0);
}

/** Normalize a provider's plain `人物：...` label without changing its meaning. */
function normalizeStoryboardProviderArtifact(value: unknown, ctx: StageExecutionContext): any {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const copy = structuredClone(value) as Record<string, any>;
  const type = canonicalStoryType(copy.storyType || (ctx.workflow.stages.SCREENPLAY?.artifact as any)?.storyType);
  if (!type || !Array.isArray(copy.segments)) return copy;
  const prefixes = type === "STORY" ? ["人物", "场景", "道具"] : type === "SCIENCE" ? ["主体", "场景", "辅助元素"] : ["核心意象", "场景", "辅助元素"];
  const facts = confirmedAssetFacts(ctx.workflow);
  const normalizedFact = (fact: any) => [fact?.name, fact?.assetKey, fact?.description]
    .map((item) => semanticLabelText(item))
    .filter(Boolean);
  const prefixForFact = (fact: any) => {
    if (text(fact?.category) === "SCENE") return "场景";
    if (text(fact?.category) === "CHARACTER" || text(fact?.category) === "CREATURE") return type === "STORY" ? "人物" : type === "SCIENCE" ? "主体" : "核心意象";
    return type === "STORY" ? "道具" : "辅助元素";
  };
  const appendVoiceCue = (effect: any, cue: string) => {
    const current = text(effect?.voice);
    if (!current || current === "无") {
      effect.voice = cue;
      return;
    }
    if (sentenceCount(current) < 2 && !current.includes(cue)) effect.voice = `${current.replace(/[。！？!?]+$/u, "")}；${cue}`;
  };
  const removePositionalImageWording = (value: unknown) => text(value)
    .replace(/第\s*[一二三四五六七八九十百\d]+\s*张\s*(?:图|图片)/gu, "对应视图")
    .replace(/(?:图片|图像|参考图)\s*(?:第\s*)?[一二三四五六七八九十百\d]+\s*(?:张)?/gu, "对应视图");
  for (const [segmentIndex, segment] of copy.segments.entries()) {
    if (!segment || typeof segment !== "object") continue;
    const sceneSequence = Number(segment.screenplaySceneSequence) || segmentIndex + 1;
    const previousSceneSequence = segmentIndex > 0 ? Number(copy.segments[segmentIndex - 1]?.screenplaySceneSequence) : undefined;
    if (segmentIndex === 0 || previousSceneSequence !== sceneSequence) segment.chapter = `第${sceneSequence}章`;
    else segment.chapter = null;
    if (Array.isArray(segment.visualEffects)) {
      for (const effect of segment.visualEffects) {
        if (!effect || typeof effect.timeRange !== "string") continue;
        const range = effect.timeRange.trim().match(/^(\d+)(?::(\d{1,2}))?\s*[-至]\s*(\d+)(?::(\d{1,2}))?\s*(?:秒|s)?$/iu);
        if (range) {
          const start = Number(range[1]) * (range[2] ? 60 : 1) + (range[2] ? Number(range[2]) : 0);
          const end = Number(range[3]) * (range[4] ? 60 : 1) + (range[4] ? Number(range[4]) : 0);
          effect.timeRange = `${start}-${end}秒`;
        }
        for (const field of ["visual", "action", "camera", "sound", "voice"] as const) {
          if (typeof effect[field] === "string") effect[field] = removePositionalImageWording(effect[field]);
        }
      }
      const first = segment.visualEffects[0];
      const last = segment.visualEffects[segment.visualEffects.length - 1];
      if (first && !hasAny([first.visual, first.action, first.voice].join(" "), ["？", "?", "为什么", "怎么", "怎样", "如何", "突然", "异常", "问题", "争议", "发现", "出错", "停住"])) {
        if (sentenceCount(text(first.voice)) < 2) appendVoiceCue(first, "问题：接下来会怎样");
        else first.visual = `${text(first.visual)}；问题：接下来会怎样`;
      }
      if (last && !hasAny([last.visual, last.action, last.voice].join(" "), ["？", "?", "为什么", "怎么", "怎样", "如何", "悬念", "问题", "待解决", "思考", "接下来"])) {
        if (sentenceCount(text(last.voice)) < 2) appendVoiceCue(last, "悬念：接下来如何判断");
        else last.visual = `${text(last.visual)}；悬念：接下来如何判断`;
      }
    }
    if (!Array.isArray(segment.references)) continue;
    for (const reference of segment.references) {
      if (!reference || typeof reference.label !== "string") continue;
      const label = reference.label.trim();
      const match = label.match(new RegExp(`^【?(${prefixes.join("|")}|人物|道具|主体)[：:]\\s*(.+?)】?$`, "u"));
      const semantic = match?.[2]?.trim() || label.replace(/^【[^：:]+[：:]/u, "").replace(/】$/u, "").trim();
      const semanticKey = semanticLabelText(semantic);
      const fact = facts.find((candidate: any) => normalizedFact(candidate).some((known) => known === semanticKey || known.includes(semanticKey) || semanticKey.includes(known)));
      if (fact) {
        reference.label = `【${prefixForFact(fact)}：${text(fact.name)}】`;
      } else if (match) {
        reference.label = `【${match[1]}：${semantic}】`;
      }
    }
  }
  return copy;
}

function storyboardSegmentFieldsValid(segment: Record<string, any>, type: string, sequence: number, errors: string[], ctx: StageExecutionContext) {
  const role = canonicalRoleField(type as any);
  const support = canonicalSupportField(type as any);
  for (const oldField of OLD_STORYBOARD_FIELDS) if (Object.hasOwn(segment, oldField)) errors.push(`FINAL_STORYBOARD segment ${sequence} must not use legacy field ${oldField}`);
  for (const [field, label] of [["scene", "scene"], [role, role], [support, support]] as const) if (!text(segment[field])) errors.push(`FINAL_STORYBOARD segment ${sequence} requires ${label}`);
  if (Number(segment.duration) !== 10) errors.push(`FINAL_STORYBOARD segment ${sequence} duration must be 10 seconds`);
  const effects = Array.isArray(segment.visualEffects) ? segment.visualEffects : [];
  if (effects.length < 3 || effects.length > 5) errors.push(`FINAL_STORYBOARD segment ${sequence} must contain 3-5 visualEffects subshots`);
  const sum = effects.reduce((total: number, item: any) => total + Number(item?.duration || 0), 0);
  if (sum !== 10) errors.push(`FINAL_STORYBOARD segment ${sequence} visualEffects durations must sum to 10, got ${sum}`);
  effects.forEach((subshot: any, index: number) => {
    const subSequence = index + 1;
    if (Number(subshot?.sequence) !== subSequence) errors.push(`FINAL_STORYBOARD segment ${sequence} visualEffects must be continuously sequenced`);
    const timeMatch = text(subshot?.timeRange).match(/^\s*(\d+)\s*[-至]\s*(\d+)\s*(?:秒|s)?\s*$/iu);
    if (!timeMatch) errors.push(`FINAL_STORYBOARD segment ${sequence} subshot ${subSequence} requires a handbook timeRange`);
    else {
      const expectedStart = effects.slice(0, index).reduce((total: number, item: any) => total + Number(item?.duration || 0), 0);
      const expectedEnd = expectedStart + Number(subshot?.duration || 0);
      if (Number(timeMatch[1]) !== expectedStart || Number(timeMatch[2]) !== expectedEnd) {
        errors.push(`FINAL_STORYBOARD segment ${sequence} subshot ${subSequence} timeRange must be ${expectedStart}-${expectedEnd}秒`);
      }
    }
    for (const field of ["visual", "action", "camera", "sound", "voice"]) if (!text(subshot?.[field])) errors.push(`FINAL_STORYBOARD segment ${sequence} subshot ${subSequence} requires ${field}`);
    if (nonPunctuationLength(subshot?.sound) > 10) errors.push(`FINAL_STORYBOARD segment ${sequence} subshot ${subSequence} sound must be at most 10 non-punctuation characters`);
    if (sentenceCount(subshot?.voice) > 2) errors.push(`FINAL_STORYBOARD segment ${sequence} subshot ${subSequence} voice must contain at most 2 sentences`);
    const subshotText = [subshot?.visual, subshot?.action, subshot?.camera, subshot?.sound, subshot?.voice].join(" ");
    if (STABLE_ASSET_ID_PATTERN.test(subshotText) || POSITIONAL_ASSET_REFERENCE_PATTERN.test(subshotText)) errors.push(`FINAL_STORYBOARD segment ${sequence} subshot ${subSequence} must use semantic labels instead of image IDs or positions`);
  });
  const references = Array.isArray(segment.references) ? segment.references : [];
  if (!references.length) errors.push(`FINAL_STORYBOARD segment ${sequence} requires semantic references`);
  if (references.length > 7) errors.push(`FINAL_STORYBOARD segment ${sequence} exceeds 7 references`);
  const labels = references.map((reference: any) => text(reference?.label));
  if (new Set(labels).size !== labels.length) errors.push(`FINAL_STORYBOARD segment ${sequence} references must be unique`);
  for (const label of labels) if (!semanticLabelValid(label, type)) errors.push(`FINAL_STORYBOARD segment ${sequence} reference ${label || "<empty>"} must use a type-specific semantic label`);
  const knownLabels = new Set<string>(confirmedAssetFacts(ctx.workflow)
    .flatMap((fact: any) => [text(fact.name), text(fact.assetKey)]
      .filter(Boolean)
      .map((item: string) => item.toLowerCase())));
  for (const label of labels) {
    const normalized = semanticLabelText(label);
    if (knownLabels.size && ![...knownLabels].some((candidate: string) => candidate === normalized || candidate.includes(normalized) || normalized.includes(candidate))) {
      errors.push(`FINAL_STORYBOARD segment ${sequence} reference ${label} is not present in confirmed asset facts`);
    }
  }
  const allText = [segment.scene, segment[role], segment[support], ...effects.flatMap((item: any) => [item.visual, item.action, item.camera, item.sound, item.voice])].join(" ");
  if (STABLE_ASSET_ID_PATTERN.test(allText) || POSITIONAL_ASSET_REFERENCE_PATTERN.test(allText)) errors.push(`FINAL_STORYBOARD segment ${sequence} contains a stable or positional asset reference`);
  const first = effects[0];
  const firstText = first ? [first.visual, first.action, first.voice].join(" ") : "";
  if (first && Number(first.duration) > 2) errors.push(`FINAL_STORYBOARD segment ${sequence} hook must fit within first 2 seconds`);
  if (first && !hasAny(firstText, ["？", "?", "为什么", "怎么", "怎样", "如何", "突然", "异常", "问题", "争议", "发现", "出错", "停住"])) errors.push(`FINAL_STORYBOARD segment ${sequence} first 2 seconds must establish a hook, anomaly, or question`);
  const last = effects[effects.length - 1];
  const lastText = last ? [last.visual, last.action, last.voice].join(" ") : "";
  if (last && Number(last.duration) < 2) errors.push(`FINAL_STORYBOARD segment ${sequence} ending subshot must reserve at least 2 seconds for suspense`);
  if (last && !hasAny(lastText, ["？", "?", "为什么", "怎么", "怎样", "如何", "悬念", "问题", "待解决", "思考", "接下来"])) errors.push(`FINAL_STORYBOARD segment ${sequence} ending must leave a question or suspense`);
  const voices = effects.map((item: any) => text(item.voice)).filter((item: string) => item && item !== "无");
  if (!voices.length) errors.push(`FINAL_STORYBOARD segment ${sequence} requires 1-2 narration/dialogue lines`);
  const voiceSentenceTotal = voices.reduce((total, voice) => total + Math.max(1, sentenceCount(voice)), 0);
  if (voiceSentenceTotal > 2) errors.push(`FINAL_STORYBOARD segment ${sequence} must contain only 1-2 narration/dialogue sentences`);
}

function validateFinalStoryboard(artifact: unknown, ctx: StageExecutionContext): ValidationResult {
  const value = record(artifact);
  const errors: string[] = [];
  const screenplay = record(ctx.workflow.stages.SCREENPLAY?.artifact);
  const type = canonicalStoryType(value.storyType);
  const screenplayType = canonicalStoryType(screenplay.storyType);
  if (value.schemaVersion !== CANONICAL_STORYBOARD_SCHEMA_VERSION) errors.push(`FINAL_STORYBOARD schemaVersion must be ${CANONICAL_STORYBOARD_SCHEMA_VERSION}`);
  if (value.kind !== "VIDEO_STORYBOARD") errors.push("FINAL_STORYBOARD kind must be VIDEO_STORYBOARD");
  if (value.format !== "FINAL_10_SECOND") errors.push("FINAL_STORYBOARD format must be FINAL_10_SECOND");
  if (value.aspectRatio !== "16:9") errors.push("FINAL_STORYBOARD aspectRatio must be 16:9");
  if (value.deliveryMode !== "SEGMENTED_MP4") errors.push("FINAL_STORYBOARD deliveryMode must be SEGMENTED_MP4");
  if (!type || !CANONICAL_STORYBOARD_TYPES.includes(type)) errors.push("FINAL_STORYBOARD storyType must be STORY, SCIENCE, or KNOWLEDGE");
  if (type && screenplayType && type !== screenplayType) errors.push(`FINAL_STORYBOARD storyType must remain ${screenplayType}`);
  for (const field of ["title", "goal", "overallScript", "visualContinuity"]) if (!text(value[field])) errors.push(`FINAL_STORYBOARD requires ${field}`);
  const duration = Number(value.targetDuration);
  const lockedDuration = Number(screenplay.targetDurationSeconds);
  if (!(COURSE_VIDEO_DURATION_SECONDS as readonly number[]).includes(duration)) errors.push("FINAL_STORYBOARD targetDuration is outside the canonical duration set");
  if (duration !== lockedDuration) errors.push(`FINAL_STORYBOARD targetDuration ${duration} must equal screenplay duration ${lockedDuration}`);
  const segments = Array.isArray(value.segments) ? value.segments : [];
  const expectedCount = Number.isFinite(duration) ? duration / 10 : 0;
  if (segments.length !== expectedCount) errors.push(`FINAL_STORYBOARD expected ${expectedCount} segments for ${duration}s, got ${segments.length}`);
  const screenplayScenes = new Set((Array.isArray(screenplay.scenes) ? screenplay.scenes : []).map((scene: any) => Number(scene.sequence)).filter(Number.isFinite));
  const covered = new Set<number>();
  segments.forEach((rawSegment: unknown, index: number) => {
    const segment = record(rawSegment);
    const sequence = index + 1;
    if (Number(segment.sequence) !== sequence) errors.push(`FINAL_STORYBOARD segment sequence must be continuous; expected ${sequence}`);
    const sceneSequence = Number(segment.screenplaySceneSequence);
    if (!screenplayScenes.has(sceneSequence)) errors.push(`FINAL_STORYBOARD segment ${sequence} references missing screenplay scene ${sceneSequence}`);
    else covered.add(sceneSequence);
    if (index === 0 && !text(segment.chapter)) errors.push("FINAL_STORYBOARD first segment requires chapter");
    if (index > 0 && Number(segments[index - 1]?.screenplaySceneSequence) !== sceneSequence && !text(segment.chapter)) errors.push(`FINAL_STORYBOARD segment ${sequence} requires chapter when screenplay scene changes`);
    if (index > 0 && Number(segments[index - 1]?.screenplaySceneSequence) === sceneSequence && text(segment.chapter)) errors.push(`FINAL_STORYBOARD segment ${sequence} must omit repeated chapter within one screenplay scene`);
    if (text(segment.chapter) && !/^第\s*\d+\s*章$/u.test(text(segment.chapter))) errors.push(`FINAL_STORYBOARD segment ${sequence} chapter must use 第N章 format`);
    if (type) storyboardSegmentFieldsValid(segment, type, sequence, errors, ctx);
  });
  for (const scene of screenplayScenes) if (!covered.has(scene)) errors.push(`FINAL_STORYBOARD must cover screenplay scene ${scene}`);
  return result(errors);
}

function copyableBaseline(ctx: StageExecutionContext, sequence: number): string {
  const storyboard = normalizeStoryboardArtifact(ctx.workflow.stages.FINAL_STORYBOARD?.artifact, ctx.workflow.stages.SCREENPLAY?.artifact);
  if (!storyboard) return "";
  const segment = storyboard.segments.find((item) => Number(item.sequence) === sequence);
  return segment ? renderCanonicalSegmentText(segment, storyboard.storyType) : "";
}

function markerIds(textValue: string): string[] { return [...textValue.matchAll(/【(P\d{3,}-A\d{3,})】/gu)].map((match) => match[1]); }

function validateCopyablePrompt(artifact: unknown, ctx: StageExecutionContext): ValidationResult {
  const value = record(artifact);
  const errors: string[] = [];
  const storyboard = record(ctx.workflow.stages.FINAL_STORYBOARD?.artifact);
  const storyboardSegments = Array.isArray(storyboard.segments) ? storyboard.segments : [];
  const segments = Array.isArray(value.segments) ? value.segments : [];
  const status = text(value.status);
  if (!["READY", "PARTIAL", "FAILED"].includes(status)) errors.push("COPYABLE_PROMPT status must be READY, PARTIAL, or FAILED");
  if (segments.length > storyboardSegments.length) errors.push("COPYABLE_PROMPT cannot contain segments absent from FINAL_STORYBOARD");
  const confirmed = confirmedPublicAssetIds(ctx);
  const failed = new Set((Array.isArray(value.failedSegments) ? value.failedSegments : []).map((item: any) => Number(item)));
  segments.forEach((segment: any, index: number) => {
    const sequence = index + 1;
    const segmentText = text(segment?.text);
    const refs = Array.isArray(segment?.referenceAssetIds) ? segment.referenceAssetIds.map(String) : [];
    if (Number(segment?.sequence) !== sequence) errors.push(`COPYABLE_PROMPT segment sequence must be continuous; expected ${sequence}`);
    if (refs.length > 7) errors.push(`COPYABLE_PROMPT segment ${sequence} exceeds 7 references`);
    if (new Set(refs).size !== refs.length) errors.push(`COPYABLE_PROMPT segment ${sequence} referenceAssetIds must be unique`);
    for (const id of refs) {
      if (!/^P\d{3,}-A\d{3,}$/.test(id)) errors.push(`COPYABLE_PROMPT segment ${sequence} invalid stable id ${id}`);
      if (!confirmed.has(id)) errors.push(`COPYABLE_PROMPT segment ${sequence} references unconfirmed asset ${id}`);
    }
    const markers = markerIds(segmentText);
    if (new Set(markers).size !== markers.length) errors.push(`COPYABLE_PROMPT segment ${sequence} repeats a stable asset marker`);
    if (markers.some((id) => !refs.includes(id)) || refs.some((id: string) => !markers.includes(id))) errors.push(`COPYABLE_PROMPT segment ${sequence} marker list and referenceAssetIds must match`);
    const visualStart = segmentText.indexOf("画面效果：");
    if (visualStart < 0) errors.push(`COPYABLE_PROMPT segment ${sequence} must preserve the handbook 画面效果 field`);
    for (const match of segmentText.matchAll(/【(P\d{3,}-A\d{3,})】/gu)) {
      const markerIndex = match.index ?? -1;
      if (visualStart < 0 || markerIndex < visualStart) errors.push(`COPYABLE_PROMPT segment ${sequence} stable markers may appear only in 画面效果`);
      if (visualStart >= 0 && markerIndex >= visualStart) {
        const lineStart = segmentText.lastIndexOf("\n", markerIndex - 1) + 1;
        const lineEnd = segmentText.indexOf("\n", markerIndex);
        const line = segmentText.slice(lineStart, lineEnd < 0 ? segmentText.length : lineEnd);
        const visualFieldEnd = line.indexOf("；动作：");
        if (visualFieldEnd >= 0 && markerIndex - lineStart > visualFieldEnd) {
          errors.push(`COPYABLE_PROMPT segment ${sequence} stable markers may appear only in visual text within 画面效果`);
        }
      }
    }
    const stripped = segmentText.replace(/【P\d{3,}-A\d{3,}】/gu, "");
    const baseline = copyableBaseline(ctx, sequence);
    if (baseline && stripped !== baseline) errors.push(`COPYABLE_PROMPT segment ${sequence} changed FINAL_STORYBOARD text outside asset markers`);
    if (POSITIONAL_ASSET_REFERENCE_PATTERN.test(segmentText)) errors.push(`COPYABLE_PROMPT segment ${sequence} must not use positional image labels`);
  });
  if (status === "READY" && failed.size) errors.push("COPYABLE_PROMPT READY cannot contain failedSegments");
  if (status === "PARTIAL" && !failed.size) errors.push("COPYABLE_PROMPT PARTIAL must identify failedSegments");
  const fullText = text(value.fullText);
  for (const segment of segments) if (!fullText.includes(text(segment?.text))) errors.push("COPYABLE_PROMPT fullText must contain every segment text");
  return result(errors);
}

function renderLabeledMaterial(label: string, value: unknown): string { return `【${label}】\n${renderPromptMaterial(value)}`; }

function stageArtifact(workflow: any, stageId: VideosBatchStageId): any { return workflow?.stages?.[stageId]?.artifact; }
function lockedIntro(workflow: any) {
  const selectedIntroId = text(workflow?.selectedIntroId);
  if (!workflow?.introLocked || !selectedIntroId) throw new Error("VideosBatch requires exactly one locked course intro before STORY_SCRIPT");
  const selection = stageArtifact(workflow, "COURSE_INTRO_SELECTION") || {};
  if (selectedIntroId === "CUSTOM" && selection.confirmedEntry) return selection.confirmedEntry;
  const candidates = Array.isArray(stageArtifact(workflow, "COURSE_INTRO_CANDIDATES")?.candidates) ? stageArtifact(workflow, "COURSE_INTRO_CANDIDATES").candidates : [];
  const selected = candidates.find((candidate: any) => text(candidate.id) === selectedIntroId);
  if (!selected) throw new Error(`Locked course intro ${selectedIntroId} is not present in the current candidate artifact`);
  return selected;
}
function storyScript(workflow: any) { const value = stageArtifact(workflow, "STORY_SCRIPT"); if (!value) throw new Error("VideosBatch STORY_SCRIPT artifact is required"); return value; }
function assetPlan(workflow: any) { const value = stageArtifact(workflow, "ASSET_PLAN"); if (!value) throw new Error("VideosBatch ASSET_PLAN artifact is required"); return value; }
function confirmedAssetFacts(workflow: any) {
  const plan = assetPlan(workflow);
  const confirmation = stageArtifact(workflow, "ASSET_CONFIRMATION") || {};
  if (confirmation.confirmed !== true) throw new Error("VideosBatch requires confirmed image assets before SCREENPLAY");
  const byKey = new Map((Array.isArray(confirmation.items) ? confirmation.items : []).map((item: any) => [text(item.assetKey), item]));
  return (Array.isArray(plan.items) ? plan.items : []).map((item: any) => {
    const confirmed = byKey.get(text(item.assetKey)) as Record<string, any> | undefined;
    return { assetKey: item.assetKey, category: item.category, name: item.name, description: item.description, continuityNotes: item.continuityNotes || "无", publicAssetId: confirmed?.publicAssetId, selectedAssetId: confirmed?.selectedAssetId };
  }).filter((item: any) => text(item.publicAssetId) && text(item.selectedAssetId));
}

function pickAffectedFields(value: unknown, errors: string[]): Record<string, unknown> {
  const source = record(value);
  const selected: Record<string, unknown> = {};
  const put = (path: string[], item: unknown) => {
    let cursor = selected;
    for (let index = 0; index < path.length - 1; index += 1) {
      const key = path[index];
      if (!cursor[key] || typeof cursor[key] !== "object") cursor[key] = {};
      cursor = cursor[key] as Record<string, unknown>;
    }
    if (path.length) cursor[path[path.length - 1]] = item;
  };
  const fieldNames = [
    "body", "content", "name", "creativeType", "endingQuestion", "truthfulnessCategory", "truthfulnessNote",
    "reason", "candidateAssets", "candidateInventory", "omissionCheck", "styleSpec", "negativePrompt", "items",
    "targetDurationSeconds", "title", "knowledgeFocus", "emotionalPurpose", "visualPresentation", "ambientSound",
    "effectSound", "interactionSound", "voice", "visualAction", "dialogue", "evidence", "scene", "characters",
    "keyProps", "subjectObjects", "coreImagery", "supportingElements", "visualEffects", "references", "timeRange",
    "visual", "action", "camera", "sound", "sequence", "chapter", "duration"
  ] as const;
  const hasField = (error: string, field: string) => error.toLocaleLowerCase().includes(field.toLocaleLowerCase());
  const unique = (values: string[]) => [...new Set(values.filter(Boolean))];
  const allErrors = errors.join(" ");
  const errorsFor = (identifier: string) => {
    const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const boundary = new RegExp(`(?:^|[^A-Za-z0-9_-])${escaped}(?:$|[^A-Za-z0-9_-])`, "iu");
    return errors.filter((error) => boundary.test(error));
  };
  const fieldsFor = (item: any, relevantErrors: string[]) => fieldNames
    .filter((field) => relevantErrors.some((error) => hasField(error, field)) && item && Object.hasOwn(item, field));

  // A single provider response can violate several entries at once. Collect
  // every referenced entry instead of silently repairing only the first one.
  if (Array.isArray(source.candidates)) {
    const candidateIds = unique([...allErrors.matchAll(/\b([ABC]-\d{2})\b/gu)].map((match) => match[1]))
      .filter((id) => source.candidates.some((item: any) => text(item?.id) === id));
    const patches = candidateIds.map((id) => {
      const candidate = source.candidates.find((item: any) => text(item?.id) === id);
      const fields = fieldsFor(candidate, errorsFor(id));
      return candidate && fields.length ? Object.fromEntries([["id", id], ...fields.map((field) => [field, candidate[field]])]) : undefined;
    }).filter(Boolean);
    if (patches.length) put(["candidates"], patches);
  }
  if (Array.isArray(source.recommendations)) {
    const recommendationIds = unique([...allErrors.matchAll(/(?:Recommendation|推荐(?:项|理由)?)\s*([ABC]-\d{2})/giu)].map((match) => match[1]))
      .filter((id) => source.recommendations.some((item: any) => text(item?.id) === id));
    const patches = recommendationIds.map((id) => {
      const recommendation = source.recommendations.find((item: any) => text(item?.id) === id);
      const fields = fieldsFor(recommendation, errorsFor(id));
      return recommendation && fields.length ? Object.fromEntries([["id", id], ...fields.map((field) => [field, recommendation[field]])]) : undefined;
    }).filter(Boolean);
    if (patches.length) put(["recommendations"], patches);
  }
  if (Array.isArray(source.scenes)) {
    const sceneIds = unique([...allErrors.matchAll(/(?:scene|场次)(?:\s+|\s*#?)(\d+)/giu)].map((match) => match[1]));
    const patches = sceneIds.map((id) => {
      const scene = source.scenes.find((item: any) => Number(item?.sequence) === Number(id));
      const fields = fieldsFor(scene, errorsFor(id));
      return scene && fields.length ? Object.fromEntries([["sequence", Number(id)], ...fields.map((field) => [field, scene[field]])]) : undefined;
    }).filter(Boolean);
    if (patches.length) put(["scenes"], patches);
  }
  if (Array.isArray(source.segments)) {
    const fullStoryboardRepair = errors.some((error) => /expected\s+\d+\s+segments|reference .*semantic label|contains a stable|hook|ending must leave|only 1-2 narration|sound must be at most/iu.test(error));
    if (fullStoryboardRepair) {
      const expectedCount = allErrors.match(/expected\s+(\d+)\s+segments/iu)?.[1];
      // Array-level errors cannot be repaired by merging same-sequence rows:
      // a count mismatch needs the provider to return a brand-new complete
      // array, while the surrounding artifact fields remain reusable.
      put(["segments"], {
        __replace: true,
        ...(expectedCount ? { expectedCount: Number(expectedCount) } : {}),
        instruction: "重新生成完整 segments 数组；保留正式剧本语义，修复列出的每条门禁，不要返回子集。"
      });
    }
    const segmentIds = unique([...allErrors.matchAll(/(?:segment|分镜)(?:\s+|\s*#?)(\d+)/giu)].map((match) => match[1]));
    const patches = segmentIds.map((id) => {
      const segment = source.segments.find((item: any) => Number(item?.sequence) === Number(id));
      const relevantErrors = errorsFor(id);
      const fields = fieldsFor(segment, relevantErrors).filter((field) => field !== "sequence");
      const partial: Record<string, unknown> = { sequence: Number(id) };
      if (segment) {
        for (const field of fields) partial[field] = segment[field];
        const subshotIds = unique([...relevantErrors.join(" ").matchAll(/(?:subshot|sub-?shot|子镜头)(?:\s+|\s*#?)(\d+)/giu)].map((match) => match[1]));
        if (subshotIds.length && Array.isArray(segment.visualEffects)) {
          const subshots = subshotIds.map((subshotId) => {
            const subshot = segment.visualEffects.find((item: any) => Number(item?.sequence) === Number(subshotId));
            const subFields = fieldsFor(subshot, relevantErrors);
            return subshot && subFields.length
              ? Object.fromEntries([["sequence", Number(subshotId)], ...subFields.map((field) => [field, subshot[field]])])
              : undefined;
          }).filter(Boolean);
          if (subshots.length) partial.visualEffects = subshots;
        }
      }
      return Object.keys(partial).length > 1 ? partial : undefined;
    }).filter(Boolean);
    if (patches.length && !fullStoryboardRepair) put(["segments"], patches);
  }
  if (Array.isArray(source.items)) {
    const itemKeys = unique([...allErrors.matchAll(/(?:ASSET_PLAN|asset)\s+(?:item\s+)?([A-Z]+-[A-Z0-9_-]+)/giu)].map((match) => match[1]))
      .filter((key) => source.items.some((item: any) => text(item?.assetKey) === key));
    const patches = itemKeys.map((key) => {
      const item = source.items.find((entry: any) => text(entry?.assetKey) === key);
      const fields = fieldsFor(item, errorsFor(key));
      return item && fields.length ? Object.fromEntries([["assetKey", key], ...fields.map((field) => [field, item[field]])]) : undefined;
    }).filter(Boolean);
    if (patches.length) put(["items"], patches);
  }
  for (const field of fieldNames) {
    if (Object.hasOwn(selected, field)) continue;
    if (!errors.some((error) => hasField(error, field)) || !Object.hasOwn(source, field)) continue;
    put([field], source[field]);
  }
  return Object.keys(selected).length ? selected : { note: "只提供校验错误；未发送上一版完整结果。" };
}

function mergeRepairArtifact(previous: unknown, candidate: unknown, scope: Record<string, unknown>): unknown {
  const hasTargets = Object.keys(scope).some((key) => key !== "note");
  if (!hasTargets) return candidate;

  const identity = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const item = value as Record<string, unknown>;
    for (const key of ["id", "assetKey", "sequence"]) {
      if (item[key] !== undefined && item[key] !== null && String(item[key]).trim()) return `${key}:${String(item[key])}`;
    }
    return undefined;
  };

  const mergeNode = (base: any, next: any, selected: any): any => {
    if (Array.isArray(selected)) {
      if (!Array.isArray(base) || !Array.isArray(next)) return next;
      if (!selected.some((item) => identity(item))) return structuredClone(next);
      const output = structuredClone(base);
      for (const selectedItem of selected) {
        const key = identity(selectedItem);
        if (!key) continue;
        const baseIndex = base.findIndex((item: unknown) => identity(item) === key);
        const nextItem = next.find((item: unknown) => identity(item) === key);
        if (baseIndex >= 0 && nextItem !== undefined) output[baseIndex] = mergeNode(base[baseIndex], nextItem, selectedItem);
      }
      return output;
    }
    if (selected && typeof selected === "object") {
      if ((selected as Record<string, unknown>).__replace === true) return structuredClone(next);
      if ((selected as Record<string, unknown>).__append === true) {
        if (!Array.isArray(base) || !Array.isArray(next)) return base;
        return [...structuredClone(base), ...structuredClone(next)].sort((left: any, right: any) => Number(left?.sequence || 0) - Number(right?.sequence || 0));
      }
      if (!next || typeof next !== "object" || Array.isArray(next)) return base;
      const output = base && typeof base === "object" && !Array.isArray(base) ? structuredClone(base) : {};
      for (const [key, selectedValue] of Object.entries(selected)) {
        if (key === "note") continue;
        output[key] = mergeNode(base?.[key], next?.[key], selectedValue);
      }
      return output;
    }
    return next;
  };

  return mergeNode(previous, candidate, scope);
}

function contractRepairPrompt(
  stageId: VideosBatchTextStageId,
  workflow: StageExecutionContext["workflow"],
  previousArtifact: unknown,
  errors: string[],
  options: { spec?: VideosBatchTextStageSpec; partial?: { startSequence: number; count: number } } = {}
): string {
  const affected = pickAffectedFields(previousArtifact, errors);
  const spec = options.spec || getVideosBatchTextStageSpec(stageId, workflow);
  // The original source material is rebuilt by the stage-specific prompt. The
  // prior artifact is intentionally reduced to affected paths only, so a
  // repair never echoes a potentially huge or stale JSON document.
  const sourcePrompt = spec.buildUserPrompt(workflow);
  const storyboardRepairChecklist = stageId === "FINAL_STORYBOARD"
    ? (() => {
      const screenplay = record(workflow.stages.SCREENPLAY?.artifact);
      const type = canonicalStoryType(screenplay.storyType) || "STORY";
      const target = Number(screenplay.targetDurationSeconds) || 0;
      const count = target > 0 ? target / 10 : "targetDuration/10";
      const rolePrefix = type === "STORY" ? "人物" : type === "SCIENCE" ? "主体" : "核心意象";
      const supportPrefix = type === "STORY" ? "道具" : "辅助元素";
      const labels = confirmedAssetFacts(workflow)
        .map((fact: any) => `【${text(fact.category) === "SCENE" ? "场景" : text(fact.category) === "CHARACTER" || text(fact.category) === "CREATURE" ? rolePrefix : supportPrefix}：${text(fact.name)}】`)
        .filter(Boolean)
        .join("、");
      return `\n<repair_checklist>\nFINAL_STORYBOARD 本次必须返回恰好 ${count} 条 segments（targetDuration=${target} 秒），sequence 从1连续到${count}，不能返回9条或子集；每条只保留3个 visualEffects，duration 固定为2、4、4，timeRange 固定为0-2秒、2-6秒、6-10秒；每条全部 voice 合计1句（其余 voice 填“无”），sound 每项不超过10个非标点字符；首个子镜头 duration 不超过2秒且包含问题/异常/发现，末个子镜头保留悬念问题；chapter 只用第N章或 null。references 只能从以下确认资产标签中选择，并使用 ${rolePrefix}/${supportPrefix}/场景前缀：${labels || "确认资产清单"}。\n</repair_checklist>`;
    })()
    : "";
  const partialInstruction = options.partial
    ? `\n<partial_response_contract>本次是局部补段请求，只返回 JSON 对象 {"segments":[...]}，必须包含 sequence=${options.partial.startSequence} 到 ${options.partial.startSequence + options.partial.count - 1} 共 ${options.partial.count} 条；不要返回其他顶层字段或已有序号。</partial_response_contract>`
    : "";
  return `${sourcePrompt}\n\n<contract_repair stage="${stageId}">\n上一版结构化结果未通过服务端业务合同校验。保留未涉及字段，只修复列出的字段；不要重新构思、不要解释、不要输出 Markdown。\n<validation_errors>\n${errors.map((error) => `- ${error}`).join("\n")}\n</validation_errors>\n<affected_fields>\n${renderPromptMaterial(affected, "", 8_000)}\n</affected_fields>${storyboardRepairChecklist}${partialInstruction}\n请返回符合当前阶段专用 JSON Schema 的${options.partial ? "局部" : "完整"}结果；除受影响字段外保持上一版语义不变。\n</contract_repair>`;
}

function nonRetryableError(error: unknown): boolean {
  if (error instanceof VideosBatchLlmError) return !error.retryable;
  if (error instanceof PromptMaterialTooLargeError) return true;
  if (error && typeof error === "object" && "retryable" in error && typeof (error as { retryable?: unknown }).retryable === "boolean") {
    return (error as { retryable: boolean }).retryable === false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:400|401|403)\b|permission|unauthori[sz]ed|forbidden|invalid api key|configuration|not configured|state unknown|version conflict|PROMPT_CONTEXT_TOO_LARGE/i.test(message);
}

function semanticReferenceMap(ctx: StageExecutionContext): Map<string, string> {
  const facts = confirmedAssetFacts(ctx.workflow);
  const map = new Map<string, string>();
  for (const fact of facts) {
    const id = text(fact.publicAssetId);
    if (!id) continue;
    for (const candidate of [fact.assetKey, fact.name, fact.description]) {
      const normalized = semanticLabelText(candidate);
      if (normalized) map.set(normalized, id);
    }
  }
  return map;
}

type ResolvedSemanticReference = { id?: string; label: string; semanticText: string };

function resolveSemanticReferences(ctx: StageExecutionContext, references: unknown): ResolvedSemanticReference[] {
  const map = semanticReferenceMap(ctx);
  const resolved: ResolvedSemanticReference[] = [];
  for (const reference of Array.isArray(references) ? references : []) {
    const rawLabel = text(record(reference).label);
    const semanticText = semanticLabelText(rawLabel);
    if (!semanticText) continue;
    const exact = map.get(semanticText) || [...map.entries()].find(([candidate]) => candidate === semanticText || candidate.includes(semanticText) || semanticText.includes(candidate))?.[1];
    if (exact && resolved.some((item) => item.id === exact)) continue;
    resolved.push({ id: exact, label: rawLabel, semanticText });
  }
  return resolved.slice(0, 7);
}

function firstSemanticOccurrence(value: string, reference: ResolvedSemanticReference): number {
  const candidates = [reference.label, reference.semanticText]
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  const lowerValue = value.toLocaleLowerCase();
  for (const candidate of candidates) {
    const index = lowerValue.indexOf(candidate.toLocaleLowerCase());
    if (index >= 0) return index;
  }
  return -1;
}

export function deriveCopyablePrompt(ctx: StageExecutionContext) {
  const storyboard = normalizeStoryboardArtifact(ctx.workflow.stages.FINAL_STORYBOARD?.artifact, ctx.workflow.stages.SCREENPLAY?.artifact);
  if (!storyboard) throw new Error("FINAL_STORYBOARD must be canonical before COPYABLE_PROMPT");
  const failedSegments: number[] = [];
  const segments = storyboard.segments.map((segment) => {
    const references = resolveSemanticReferences(ctx, segment.references);
    const markedSegment = structuredClone(segment) as Record<string, any>;
    const effects = Array.isArray(markedSegment.visualEffects) ? markedSegment.visualEffects : [];
    const ids: string[] = [];
    for (const reference of references) {
      if (!reference.id) {
        if (!failedSegments.includes(segment.sequence)) failedSegments.push(segment.sequence);
        continue;
      }
      let placed = false;
      for (const effect of effects) {
        const visual = text(effect?.visual);
        const index = firstSemanticOccurrence(visual, reference);
        if (index < 0) continue;
        effect.visual = `${visual.slice(0, index)}【${reference.id}】${visual.slice(index)}`;
        ids.push(reference.id);
        placed = true;
        break;
      }
      if (!placed && !failedSegments.includes(segment.sequence)) failedSegments.push(segment.sequence);
    }
    // Markers are inserted into the first matching visual subshot only. The
    // rendered copy therefore remains byte-identical to FINAL_STORYBOARD once
    // stable markers are stripped by the contract validator.
    const textValue = renderCanonicalSegmentText(markedSegment, storyboard.storyType);
    return { sequence: segment.sequence, text: textValue, referenceAssetIds: ids };
  });
  const status = failedSegments.length ? "PARTIAL" : "READY";
  const artifact = { schemaVersion: "1", fullText: segments.map((segment) => segment.text).join("\n\n"), status, failedSegments, segments };
  return artifact;
}

function stageIdempotencyKey(sessionId: string, stageId: VideosBatchTextStageId, userPrompt: string, logicalScope = "provider") {
  // Network retries reuse the same key. A new contract-repair operation gets a
  // separate scope so a provider cannot replay the invalid generation forever.
  const keyMaterial = logicalScope === "provider" ? userPrompt : `${logicalScope}\n${userPrompt}`;
  return `videosbatch:${sessionId}:${stageId}:${contentHash(keyMaterial)}`;
}

type AttemptRecord = VideosBatchLlmAttemptBudget["records"][number];

function mergeAttemptRecords(...groups: Array<readonly AttemptRecord[] | undefined>): AttemptRecord[] {
  const merged: AttemptRecord[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const item of group || []) {
      const key = [
        item.attempt,
        item.provider,
        item.model,
        item.idempotencyKey || "",
        item.outcome,
        item.errorCode || "",
        item.status ?? ""
      ].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }
  return merged;
}

function validationFor(stageId: VideosBatchTextStageId, artifact: unknown, ctx: StageExecutionContext): ValidationResult {
  switch (stageId) {
    case "COURSE_INTRO_CANDIDATES": return validateIntro(artifact);
    case "STORY_SCRIPT": return validateStoryScript(artifact, ctx);
    case "ASSET_PLAN": return validateAssetPlan(artifact);
    case "SCREENPLAY": return validateScreenplay(artifact, ctx);
    case "FINAL_STORYBOARD": return validateFinalStoryboard(artifact, ctx);
    case "COPYABLE_PROMPT": return validateCopyablePrompt(artifact, ctx);
  }
}

async function executeStructuredStage(
  stageId: VideosBatchTextStageId,
  ctx: StageExecutionContext,
  spec: ReturnType<typeof getVideosBatchTextStageSpec>,
  executor: VideosBatchLlmExecutor
): Promise<{ artifact: unknown; attempts: number; provider?: string; model?: string; attemptLog?: VideosBatchLlmAttemptBudget["records"] }> {
  const basePrompt = spec.buildUserPrompt(ctx.workflow);
  let userPrompt = basePrompt;
  let lastArtifact: unknown;
  let lastProvider: string | undefined;
  let lastModel: string | undefined;
  let lastErrors: string[] = [];
  let lastError: unknown;
  const providerBudget = createVideosBatchLlmAttemptBudget(MAX_STAGE_ATTEMPTS);
  const responses: StructuredGenerationResult<unknown>[] = [];
  let logicalAttempt = 0;
  let requestCount = 0;

  const resultWithEvidence = (artifact: unknown, providerBudgetForResult: VideosBatchLlmAttemptBudget, repairBudget?: VideosBatchLlmAttemptBudget) => {
    const providerAttempts = providerBudgetForResult.used;
    const repairAttempts = repairBudget?.used || 0;
    return {
      artifact,
      attempts: Math.max(providerAttempts + repairAttempts, requestCount),
      provider: lastProvider,
      model: lastModel,
      attemptLog: mergeAttemptRecords(
        providerBudgetForResult.records,
        repairBudget?.records,
        ...responses.map((response) => response.attemptLog)
      )
    };
  };

  const requestFor = (
    prompt: string,
    budget: VideosBatchLlmAttemptBudget,
    metadata: Record<string, string>,
    scope: string,
    requestSpec: VideosBatchTextStageSpec = spec
  ): StructuredGenerationRequest => {
    const route: StructuredGenerationRequest["providerRoute"] = "auto";
    const reasoningEffort = stageReasoningEffort(stageId);
    const timeoutMs = stageTimeoutMs(stageId);
    const maxOutputTokens = stageMaxOutputTokens(stageId);
    const plannedAttempt = Math.min(budget.maxAttempts, budget.used + 1);
    return {
      operation: stageId,
      systemPrompt: requestSpec.systemPrompt,
      userPrompt: prompt,
      schemaName: requestSpec.schemaName,
      jsonSchema: requestSpec.jsonSchema,
      ...(stageId === "FINAL_STORYBOARD" ? {
        model: process.env.VIDEOSBATCH_FINAL_STORYBOARD_MODEL?.trim() || "gpt-5.6-terra",
        reasoningEffort: (process.env.VIDEOSBATCH_FINAL_STORYBOARD_REASONING?.trim() || "medium") as "medium"
      } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      outputMode: "json_schema",
      providerRoute: route,
      budget,
      idempotencyKey: stageIdempotencyKey(ctx.session.id, stageId, prompt, scope),
      metadata: {
        session_id: ctx.session.id,
        stage_id: stageId,
        provider_route: route || "auto",
        ...promptStats(requestSpec.systemPrompt, prompt, requestSpec.jsonSchema),
        ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
        ...(maxOutputTokens !== undefined ? { max_output_tokens: String(maxOutputTokens) } : {}),
        ...(timeoutMs !== undefined ? { timeout_ms: String(timeoutMs) } : {}),
        ...metadata,
        attempt_budget_used: String(plannedAttempt),
        attempt_budget_max: String(budget.maxAttempts),
        attempt_budget_remaining: String(Math.max(0, budget.maxAttempts - plannedAttempt))
      }
    };
  };

  // Provider/network retries and provider switching share this three-submit
  // budget. A business-contract failure leaves this loop and enters the
  // independent repair budget below; it is never counted as a provider retry.
  for (let providerAttempt = 1; providerAttempt <= MAX_STAGE_ATTEMPTS; providerAttempt += 1) {
    if (providerBudget.used >= providerBudget.maxAttempts) break;
    logicalAttempt += 1;
    try {
      requestCount += 1;
      const response = await executor.generateStructured<unknown>(requestFor(
        userPrompt,
        providerBudget,
        {
          attempt: String(logicalAttempt),
          max_attempts: String(MAX_STAGE_ATTEMPTS),
          attempt_kind: "provider",
          contract_repair: "0",
          contract_repair_attempt: "0"
        },
        "provider"
      ));
      responses.push(response);
      lastArtifact = stageId === "FINAL_STORYBOARD"
        ? normalizeStoryboardProviderArtifact(response.data, ctx)
        : response.data;
      lastProvider = response.provider;
      lastModel = response.model;
      const validation = validationFor(stageId, lastArtifact, ctx);
      if (validation.ok) return resultWithEvidence(lastArtifact, providerBudget);
      lastErrors = validation.errors;
      break;
    } catch (error) {
      lastError = error;
      if (nonRetryableError(error)) throw error;
      lastErrors = [error instanceof Error ? error.message : String(error)];
      if (providerAttempt >= MAX_STAGE_ATTEMPTS || providerBudget.used >= providerBudget.maxAttempts) break;
      userPrompt = `${basePrompt}\n\n<retry_notice stage="${stageId}">\n上一次提交暂时失败，请在保持所有字段语义不变的前提下重新提交。原因：${lastErrors[0]}\n</retry_notice>`;
    }
  }

  if (lastArtifact === undefined) {
    if (lastError instanceof Error) throw lastError;
    throw new Error(lastErrors.join("\n") || `VideosBatch ${stageId} exhausted attempts`);
  }

  // Contract repair is deliberately independent from providerBudget. This
  // allows a C-02/field-length failure to receive a targeted correction even
  // when the original provider sequence already used all three submissions.
  const repairBudget = createVideosBatchLlmAttemptBudget(MAX_CONTRACT_REPAIR_ATTEMPTS);
  let repairSpec: VideosBatchTextStageSpec = spec;
  let partialRange: { startSequence: number; count: number } | undefined;
  if (stageId === "FINAL_STORYBOARD") {
    const target = Number((ctx.workflow.stages.SCREENPLAY?.artifact as any)?.targetDurationSeconds);
    const currentCount = Array.isArray((lastArtifact as any)?.segments) ? (lastArtifact as any).segments.length : 0;
    const expectedCount = target > 0 ? target / 10 : 0;
    if (expectedCount > currentCount && expectedCount <= 15) {
      partialRange = { startSequence: currentCount + 1, count: expectedCount - currentCount };
      repairSpec = getVideosBatchStoryboardSegmentRepairSpec(ctx.workflow, partialRange.count, partialRange.startSequence);
    }
  }
  let repairPrompt = contractRepairPrompt(stageId, ctx.workflow, lastArtifact, lastErrors, {
    spec: repairSpec,
    partial: partialRange
  });
  let repairScope = partialRange
    ? { segments: { __append: true, startSequence: partialRange.startSequence, count: partialRange.count } }
    : pickAffectedFields(lastArtifact, lastErrors);
  for (let repairAttempt = 1; repairAttempt <= MAX_CONTRACT_REPAIR_ATTEMPTS; repairAttempt += 1) {
    if (repairBudget.used >= repairBudget.maxAttempts) break;
    logicalAttempt += 1;
    try {
      requestCount += 1;
      const response = await executor.generateStructured<unknown>(requestFor(
        repairPrompt,
        repairBudget,
        {
          attempt: String(logicalAttempt),
          max_attempts: String(MAX_CONTRACT_REPAIR_ATTEMPTS),
          attempt_kind: "contract_repair",
          contract_repair: "1",
          contract_repair_attempt: String(repairAttempt),
          ...(partialRange ? { repair_mode: "append_segments" } : {})
        },
        `contract-repair-${repairAttempt}`,
        repairSpec
      ));
      responses.push(response);
      const repairedArtifact = stageId === "FINAL_STORYBOARD"
        ? normalizeStoryboardProviderArtifact(response.data, ctx)
        : response.data;
      lastArtifact = mergeRepairArtifact(lastArtifact, repairedArtifact, repairScope);
      lastProvider = response.provider;
      lastModel = response.model;
      const validation = validationFor(stageId, lastArtifact, ctx);
      if (validation.ok) return resultWithEvidence(lastArtifact, providerBudget, repairBudget);
      lastErrors = validation.errors;
      if (partialRange) {
        // Once the missing range is present, use the second repair slot for
        // any remaining global semantic errors against the full contract.
        partialRange = undefined;
        repairSpec = spec;
      }
      repairScope = pickAffectedFields(lastArtifact, validation.errors);
      repairPrompt = contractRepairPrompt(stageId, ctx.workflow, lastArtifact, validation.errors, { spec: repairSpec });
    } catch (error) {
      if (nonRetryableError(error)) throw error;
      lastErrors = [error instanceof Error ? error.message : String(error)];
      if (repairAttempt >= MAX_CONTRACT_REPAIR_ATTEMPTS || repairBudget.used >= repairBudget.maxAttempts) break;
      repairScope = pickAffectedFields(lastArtifact, lastErrors);
      repairPrompt = `${contractRepairPrompt(stageId, ctx.workflow, lastArtifact, lastErrors, { spec: repairSpec, partial: partialRange })}\n\n<retry_notice stage="${stageId}" kind="contract_repair">\n合同修复请求暂时失败，请继续只修复受影响字段。原因：${lastErrors[0]}\n</retry_notice>`;
    }
  }

  // Preserve the last invalid artifact for runner-level diagnostics and an
  // explicit retry endpoint. The runner will mark the stage failed with the
  // remaining contract errors instead of discarding the provider result.
  return resultWithEvidence(lastArtifact, providerBudget, repairBudget);
}

export function validateVideosBatchTextStage(stageId: VideosBatchTextStageId, artifact: unknown, ctx: StageExecutionContext): ValidationResult {
  return validationFor(stageId, artifact, ctx);
}

function createStage(stageId: VideosBatchTextStageId, executor: VideosBatchLlmExecutor): StageDefinition<any> {
  const spec = getVideosBatchTextStageSpec(stageId);
  return {
    id: stageId,
    async execute(ctx) {
      // COPYABLE_PROMPT is a lossless server-owned derivative. Calling an LLM
      // here would permit it to rewrite the handbook fields, so it is never a
      // provider submission.
      if (stageId === "COPYABLE_PROMPT") return { artifact: deriveCopyablePrompt(ctx) };
      const executionSpec = stageId === "FINAL_STORYBOARD"
        ? getVideosBatchTextStageSpec(stageId, ctx.workflow)
        : spec;
      const generated = await executeStructuredStage(stageId, ctx, executionSpec, executor);
      return { artifact: generated.artifact, attempts: generated.attempts, provider: generated.provider, model: generated.model, attemptLog: generated.attemptLog } as any;
    },
    validate(artifact, ctx) { return validationFor(stageId, artifact, ctx); },
    ...(stageId === "FINAL_STORYBOARD" ? {
      async project(artifact: any, ctx: StageExecutionContext) {
        if (!ctx.store) return;
        const { projectFinalStoryboardIntoSeeReel } = await import("./nativeProjection");
        const sourceRevision = Number(ctx.workflow.stages.FINAL_STORYBOARD?.revision) || 0;
        const projected = await projectFinalStoryboardIntoSeeReel(ctx.store, ctx.session.id, artifact, {
          sourceRevision,
          sourceHash: canonicalStoryboardSourceHash(artifact)
        });
        (artifact?.segments || []).forEach((segment: any, index: number) => { if (projected[index]) segment.nativeShotId = projected[index].id; });
      }
    } : {})
  };
}

export function createVideosBatchLlmTextStageRegistry(executor: VideosBatchLlmExecutor): StageRegistry {
  const registry: StageRegistry = {};
  for (const stageId of VIDEOS_BATCH_TEXT_STAGE_IDS) registry[stageId] = createStage(stageId, executor);
  return registry;
}

export function isVideosBatchTextStage(stageId: VideosBatchStageId): stageId is VideosBatchTextStageId {
  return VIDEOS_BATCH_TEXT_STAGE_IDS.includes(stageId as VideosBatchTextStageId);
}

export { contentHash };
