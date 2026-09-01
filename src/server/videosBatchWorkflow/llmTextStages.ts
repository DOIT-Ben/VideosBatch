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
  getVideosBatchTextStageSpec,
  type VideosBatchTextStageId
} from "./textStageSpecs";

const INTRO_IDS = ["A-01", "A-02", "A-03", "B-01", "B-02", "B-03", "C-01", "C-02", "C-03"] as const;
const TRUTHFULNESS = new Set(["真实史实", "真实背景下的合理改编", "完全虚构的故事化情境"]);
const STORY_TYPES = new Set(["故事叙事型", "现象科普型", "知识由来与应用型"]);
const ASSET_CATEGORIES = new Set(["CHARACTER", "SCENE", "PROP", "CREATURE"]);
const MAX_STAGE_ATTEMPTS = 3;
const OLD_STORYBOARD_FIELDS = ["visualPrompt", "narration", "subtitles", "teachingPurpose", "transition", "subshots"] as const;

function result(errors: string[]): ValidationResult { return { ok: errors.length === 0, errors }; }
function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
function text(value: unknown): string { return String(value ?? "").trim(); }
function textLength(value: unknown): number { return Array.from(text(value)).length; }
function hasAny(value: unknown, terms: readonly string[]): boolean { return hasAnyText(value, terms); }
function canonicalStoryType(value: unknown) { return normalizeStoryboardType(value); }

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
  if (!hasAny(value.omissionCheck, ["二次核对", "遗漏检查", "四类"])) errors.push("ASSET_PLAN omissionCheck must document the second pass across four asset classes");
  if (!hasAny(value.styleSpec, ["影视级3D国漫CG风格", "影视级 3D 国漫 CG 风格"])) errors.push("ASSET_PLAN styleSpec must lock the handbook visual style");
  const keys = items.map((item: any) => text(item.assetKey));
  if (new Set(keys).size !== keys.length) errors.push("ASSET_PLAN assetKey values must be unique");
  for (const category of ASSET_CATEGORIES) if (!items.some((item: any) => text(item.category) === category)) errors.push(`ASSET_PLAN must cover asset category ${category}`);
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
    const visualEnd = visualStart >= 0 ? (segmentText.indexOf("\n", visualStart + 5) >= 0 ? segmentText.length : segmentText.length) : -1;
    if (visualStart < 0) errors.push(`COPYABLE_PROMPT segment ${sequence} must preserve the handbook 画面效果 field`);
    for (const match of segmentText.matchAll(/【(P\d{3,}-A\d{3,})】/gu)) {
      const markerIndex = match.index ?? -1;
      if (visualStart < 0 || markerIndex < visualStart) errors.push(`COPYABLE_PROMPT segment ${sequence} stable markers may appear only in 画面效果`);
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
  const candidateMatch = errors.join(" ").match(/\b([ABC]-\d{2})\b/u)?.[1];
  if (candidateMatch && Array.isArray(source.candidates)) {
    const candidate = source.candidates.find((item: any) => text(item?.id) === candidateMatch);
    const fields = fieldNames.filter((field) => errors.some((error) => hasField(error, field)) && candidate && Object.hasOwn(candidate, field));
    if (candidate && fields.length) put(["candidates"], [Object.fromEntries([["id", candidateMatch], ...fields.map((field) => [field, candidate[field]])])]);
  }
  const sceneMatch = errors.join(" ").match(/scene(?:\s+|\s*#?)(\d+)/iu)?.[1];
  if (sceneMatch && Array.isArray(source.scenes)) {
    const scene = source.scenes.find((item: any) => Number(item?.sequence) === Number(sceneMatch));
    const fields = fieldNames.filter((field) => errors.some((error) => hasField(error, field)) && scene && Object.hasOwn(scene, field));
    if (scene && fields.length) put(["scenes"], [Object.fromEntries([["sequence", Number(sceneMatch)], ...fields.map((field) => [field, scene[field]])])]);
  }
  const segmentMatch = errors.join(" ").match(/segment\s+(\d+)/iu)?.[1];
  if (segmentMatch && Array.isArray(source.segments)) {
    const segment = source.segments.find((item: any) => Number(item?.sequence) === Number(segmentMatch));
    const subshotMatch = errors.join(" ").match(/(?:subshot|sub-?shot|visualEffects)\s+(?:\w+\s+)?(\d+)/iu)?.[1];
    const fields = fieldNames.filter((field) => errors.some((error) => hasField(error, field)) && field !== "sequence" && segment && Object.hasOwn(segment, field));
    const partial: Record<string, unknown> = { sequence: Number(segmentMatch) };
    if (segment) {
      for (const field of fields) partial[field] = segment[field];
      if (subshotMatch && Array.isArray(segment.visualEffects)) {
        const subshot = segment.visualEffects.find((item: any) => Number(item?.sequence) === Number(subshotMatch));
        const subFields = fieldNames.filter((field) => errors.some((error) => hasField(error, field)) && subshot && Object.hasOwn(subshot, field));
        if (subshot && subFields.length) partial.visualEffects = [Object.fromEntries([["sequence", Number(subshotMatch)], ...subFields.map((field) => [field, subshot[field]])])];
      }
    }
    if (Object.keys(partial).length > 1) put(["segments"], [partial]);
  }
  const itemMatch = errors.join(" ").match(/(?:ASSET_PLAN|asset)\s+(?:item\s+)?([A-Z]+-[A-Z0-9_-]+)/iu)?.[1];
  if (itemMatch && Array.isArray(source.items)) {
    const item = source.items.find((entry: any) => text(entry?.assetKey) === itemMatch);
    const fields = fieldNames.filter((field) => errors.some((error) => hasField(error, field)) && item && Object.hasOwn(item, field));
    if (item && fields.length) put(["items"], [Object.fromEntries([["assetKey", itemMatch], ...fields.map((field) => [field, item[field]])])]);
  }
  for (const field of fieldNames) {
    if (Object.hasOwn(selected, field)) continue;
    if (!errors.some((error) => hasField(error, field)) || !Object.hasOwn(source, field)) continue;
    put([field], source[field]);
  }
  return Object.keys(selected).length ? selected : { note: "只提供校验错误；未发送上一版完整结果。" };
}

function contractRepairPrompt(
  stageId: VideosBatchTextStageId,
  workflow: StageExecutionContext["workflow"],
  previousArtifact: unknown,
  errors: string[]
): string {
  const affected = pickAffectedFields(previousArtifact, errors);
  const spec = getVideosBatchTextStageSpec(stageId);
  // The original source material is rebuilt by the stage-specific prompt. The
  // prior artifact is intentionally reduced to affected paths only, so a
  // repair never echoes a potentially huge or stale JSON document.
  const sourcePrompt = spec.buildUserPrompt(workflow);
  return `${sourcePrompt}\n\n<contract_repair stage="${stageId}">\n上一版结构化结果未通过服务端业务合同校验。保留未涉及字段，只修复列出的字段；不要重新构思、不要解释、不要输出 Markdown。\n<validation_errors>\n${errors.map((error) => `- ${error}`).join("\n")}\n</validation_errors>\n<affected_fields>\n${renderPromptMaterial(affected, "", 8_000)}\n</affected_fields>\n请返回符合当前阶段专用 JSON Schema 的完整结果；除受影响字段外保持上一版语义不变。\n</contract_repair>`;
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

function stageIdempotencyKey(sessionId: string, stageId: VideosBatchTextStageId, userPrompt: string) {
  // The prompt is the logical submission payload. A contract repair or retry
  // notice therefore gets a new key, while executor-level network retries keep
  // this exact key and remain idempotent.
  return `videosbatch:${sessionId}:${stageId}:${contentHash(userPrompt)}`;
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
  let userPrompt = spec.buildUserPrompt(ctx.workflow);
  let lastArtifact: unknown;
  let lastProvider: string | undefined;
  let lastModel: string | undefined;
  let lastErrors: string[] = [];
  const budget = createVideosBatchLlmAttemptBudget(MAX_STAGE_ATTEMPTS);
  for (let attempt = 1; attempt <= MAX_STAGE_ATTEMPTS; attempt += 1) {
    if (budget.used >= budget.maxAttempts) break;
    const route: StructuredGenerationRequest["providerRoute"] = "auto";
    try {
      const response: StructuredGenerationResult<unknown> = await executor.generateStructured({
        operation: stageId,
        systemPrompt: spec.systemPrompt,
        userPrompt,
        schemaName: spec.schemaName,
        jsonSchema: spec.jsonSchema,
        ...(stageId === "FINAL_STORYBOARD" ? {
          model: process.env.VIDEOSBATCH_FINAL_STORYBOARD_MODEL?.trim() || "gpt-5.6-terra",
          reasoningEffort: (process.env.VIDEOSBATCH_FINAL_STORYBOARD_REASONING?.trim() || "medium") as "medium"
        } : {}),
        // The stage owns the three-submit budget. The executor must not add a
        // hidden provider/finalizer round when this marker is present.
        outputMode: "json_schema",
        providerRoute: route,
        budget,
        idempotencyKey: stageIdempotencyKey(ctx.session.id, stageId, userPrompt),
        metadata: {
          session_id: ctx.session.id,
          stage_id: stageId,
          attempt: String(attempt),
          max_attempts: String(MAX_STAGE_ATTEMPTS),
          provider_route: route || "auto",
          attempt_budget_remaining: String(Math.max(0, MAX_STAGE_ATTEMPTS - budget.used))
        }
      });
      lastArtifact = response.data;
      lastProvider = response.provider;
      lastModel = response.model;
      const validation = validationFor(stageId, response.data, ctx);
      if (validation.ok) return { artifact: response.data, attempts: budget.used || attempt, provider: response.provider, model: response.model, attemptLog: [...budget.records] };
      lastErrors = validation.errors;
      // Contract repair is still a retry on the current primary model. The
      // executor switches to the fallback only after the primary has consumed
      // its reserved share of the same three-submission budget.
      if (attempt < MAX_STAGE_ATTEMPTS && budget.used < budget.maxAttempts) userPrompt = contractRepairPrompt(stageId, ctx.workflow, response.data, validation.errors);
    } catch (error) {
      if (nonRetryableError(error) || attempt >= MAX_STAGE_ATTEMPTS) throw error;
      lastErrors = [error instanceof Error ? error.message : String(error)];
      userPrompt = `${spec.buildUserPrompt(ctx.workflow)}\n\n<retry_notice stage="${stageId}">\n上一次提交暂时失败，请在保持所有字段语义不变的前提下重新提交。原因：${lastErrors[0]}\n</retry_notice>`;
    }
  }
  if (lastArtifact !== undefined) return { artifact: lastArtifact, attempts: budget.used || MAX_STAGE_ATTEMPTS, provider: lastProvider, model: lastModel, attemptLog: [...budget.records] };
  throw new Error(lastErrors.join("\n") || `VideosBatch ${stageId} exhausted attempts`);
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
      const generated = await executeStructuredStage(stageId, ctx, spec, executor);
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
