import type { VideosBatchStageId } from "../../shared/videosBatchWorkflow";
import type { VideosBatchLlmExecutor } from "./llmExecutor";
import { projectFinalStoryboardIntoSeeReel } from "./nativeProjection";
import type { StageDefinition, StageExecutionContext, StageRegistry, ValidationResult } from "./stageContracts";
import {
  COURSE_VIDEO_DURATION_SECONDS,
  VIDEOS_BATCH_TEXT_STAGE_IDS,
  getVideosBatchTextStageSpec,
  type VideosBatchTextStageId
} from "./textStageSpecs";

const INTRO_IDS = ["A-01", "A-02", "A-03", "B-01", "B-02", "B-03", "C-01", "C-02", "C-03"] as const;
const TRUTHFULNESS = new Set(["真实史实", "真实背景下的合理改编", "完全虚构的故事化情境"]);
const ASSET_CATEGORIES = new Set(["CHARACTER", "SCENE", "PROP", "CREATURE"]);
const POSITIONAL_REFERENCE = /(?:第\s*(?:\d+|[一二三四五六七八九十百]+)\s*张\s*(?:图|图片)|(?:图片|图像|参考图)\s*(?:第\s*)?(?:\d+|[一二三四五六七八九十百]+)\s*(?:张)?|(?:图|参考图)\s*(?:\d+|[一二三四五六七八九十百]+))/u;
const STABLE_ID = /^P\d{3,}-A\d{3,}$/;

function result(errors: string[]): ValidationResult {
  return { ok: errors.length === 0, errors };
}

function textLength(value: unknown) {
  return Array.from(String(value || "").trim()).length;
}

function confirmedPublicAssetIds(ctx: StageExecutionContext) {
  const artifact = ctx.workflow.stages.ASSET_CONFIRMATION?.artifact as any;
  return new Set(
    (Array.isArray(artifact?.items) ? artifact.items : [])
      .map((item: any) => String(item?.publicAssetId || "").trim())
      .filter(Boolean)
  );
}

function validateIntro(artifact: any): ValidationResult {
  const errors: string[] = [];
  const candidates = Array.isArray(artifact?.candidates) ? artifact.candidates : [];
  const recommendations = Array.isArray(artifact?.recommendations) ? artifact.recommendations : [];
  if (candidates.length !== 9) errors.push(`COURSE_INTRO_CANDIDATES expected exactly 9 candidates, got ${candidates.length}`);

  const ids = candidates.map((item: any) => String(item?.id || ""));
  for (const id of INTRO_IDS) if (!ids.includes(id)) errors.push(`COURSE_INTRO_CANDIDATES missing ${id}`);
  if (new Set(ids).size !== ids.length) errors.push("COURSE_INTRO_CANDIDATES candidate ids must be unique");

  for (const candidate of candidates) {
    const id = String(candidate?.id || "candidate");
    const length = textLength(candidate?.body);
    if (length < 200 || length > 300) errors.push(`${id} body must be 200-300 characters, got ${length}`);
    if (!String(candidate?.name || "").trim()) errors.push(`${id} requires name`);
    if (!String(candidate?.creativeType || "").trim()) errors.push(`${id} requires creativeType`);
    if (!String(candidate?.endingQuestion || "").trim()) errors.push(`${id} requires endingQuestion`);
    if (!TRUTHFULNESS.has(String(candidate?.truthfulnessCategory || ""))) errors.push(`${id} has invalid truthfulnessCategory`);
    if (!String(candidate?.truthfulnessNote || "").trim()) errors.push(`${id} requires truthfulnessNote`);
  }

  if (recommendations.length !== 3) errors.push(`COURSE_INTRO_CANDIDATES expected exactly 3 recommendations, got ${recommendations.length}`);
  const recommendationIds = recommendations.map((item: any) => String(item?.id || ""));
  if (new Set(recommendationIds).size !== recommendationIds.length) errors.push("COURSE_INTRO_CANDIDATES recommendation ids must be unique");
  for (const recommendation of recommendations) {
    const id = String(recommendation?.id || "");
    if (!ids.includes(id)) errors.push(`Recommendation references unknown candidate ${id}`);
    if (!String(recommendation?.reason || "").trim()) errors.push(`Recommendation ${id} requires reason`);
  }
  return result(errors);
}

function validateStoryScript(artifact: any, ctx: StageExecutionContext): ValidationResult {
  const errors: string[] = [];
  if (!ctx.workflow.introLocked || !ctx.workflow.selectedIntroId) errors.push("STORY_SCRIPT requires one locked course intro");
  if (artifact?.schemaVersion !== "2") errors.push("STORY_SCRIPT schemaVersion must be 2");
  if (artifact?.kind !== "LESSON_INTRO_VIDEO_SCRIPT") errors.push("STORY_SCRIPT kind must be LESSON_INTRO_VIDEO_SCRIPT");
  if (!String(artifact?.title || "").trim()) errors.push("STORY_SCRIPT requires title");
  if (!String(artifact?.storyType || "").trim()) errors.push("STORY_SCRIPT requires storyType");
  if (!String(artifact?.truthfulnessNote || "").trim()) errors.push("STORY_SCRIPT requires truthfulnessNote");
  const length = textLength(artifact?.content);
  if (length < 600 || length > 800) errors.push(`STORY_SCRIPT content must be 600-800 characters, got ${length}`);
  if (Array.isArray(artifact?.stories)) errors.push("STORY_SCRIPT must contain one story document, not a stories array");
  return result(errors);
}

function validateAssetPlan(artifact: any): ValidationResult {
  const errors: string[] = [];
  if (artifact?.kind !== "VIDEO_ASSET_PLAN") errors.push("ASSET_PLAN kind must be VIDEO_ASSET_PLAN");
  const items = Array.isArray(artifact?.items) ? artifact.items : [];
  if (!items.length) errors.push("ASSET_PLAN requires at least one item");

  const keys = items.map((item: any) => String(item?.assetKey || ""));
  if (new Set(keys).size !== keys.length) errors.push("ASSET_PLAN assetKey values must be unique");
  for (const item of items) {
    const key = String(item?.assetKey || "");
    const category = String(item?.category || "");
    if (!/^(CHARACTER|PROP|SCENE|CREATURE)-[A-Z0-9][A-Z0-9_-]{1,63}$/.test(key)) errors.push(`ASSET_PLAN invalid assetKey ${key || "<empty>"}`);
    if (!ASSET_CATEGORIES.has(category)) errors.push(`ASSET_PLAN ${key} has invalid category ${category}`);
    if (key && category && !key.startsWith(`${category}-`)) errors.push(`ASSET_PLAN ${key} must use ${category}- prefix`);
    if (!String(item?.name || "").trim()) errors.push(`ASSET_PLAN ${key} requires name`);
    if (!String(item?.description || "").trim()) errors.push(`ASSET_PLAN ${key} requires description`);
    if (textLength(item?.prompt) < 8) errors.push(`ASSET_PLAN ${key} prompt must contain at least 8 characters`);
    if (!String(item?.sourceEvidence || "").trim()) errors.push(`ASSET_PLAN ${key} requires sourceEvidence`);
    if (!["16:9", "9:16", "1:1"].includes(String(item?.aspectRatio || ""))) errors.push(`ASSET_PLAN ${key} has invalid aspectRatio`);
    for (const forbidden of ["assetId", "selectedAssetId", "generationIds", "candidateAssetIds", "referenceId"]) {
      if (Object.hasOwn(item || {}, forbidden)) errors.push(`ASSET_PLAN model output must not own ${forbidden}`);
    }
  }
  return result(errors);
}

function validateScreenplay(artifact: any, ctx: StageExecutionContext): ValidationResult {
  const errors: string[] = [];
  if ((ctx.workflow.stages.ASSET_CONFIRMATION?.artifact as any)?.confirmed !== true) errors.push("SCREENPLAY requires confirmed assets");
  if (artifact?.kind !== "VIDEO_SCREENPLAY") errors.push("SCREENPLAY kind must be VIDEO_SCREENPLAY");
  const duration = Number(artifact?.targetDurationSeconds);
  if (!(COURSE_VIDEO_DURATION_SECONDS as readonly number[]).includes(duration)) {
    errors.push(`SCREENPLAY targetDurationSeconds must be one of ${COURSE_VIDEO_DURATION_SECONDS.join(", ")}`);
  }
  const scenes = Array.isArray(artifact?.scenes) ? artifact.scenes : [];
  if (!scenes.length) errors.push("SCREENPLAY requires at least one scene");
  scenes.forEach((scene: any, index: number) => {
    const expected = index + 1;
    if (Number(scene?.sequence) !== expected) errors.push(`SCREENPLAY scene sequence must be continuous; expected ${expected}`);
    for (const field of ["title", "knowledgeFocus", "emotionalPurpose", "visualPresentation", "ambientSound", "effectSound", "interactionSound", "voice", "visualAction", "dialogue"]) {
      if (!String(scene?.[field] || "").trim()) errors.push(`SCREENPLAY scene ${expected} requires ${field}`);
    }
    if (!Array.isArray(scene?.evidence)) errors.push(`SCREENPLAY scene ${expected} evidence must be an array`);
  });
  return result(errors);
}

function validateFinalStoryboard(artifact: any, ctx: StageExecutionContext): ValidationResult {
  const errors: string[] = [];
  const screenplay = ctx.workflow.stages.SCREENPLAY?.artifact as any;
  const lockedDuration = Number(screenplay?.targetDurationSeconds);
  const duration = Number(artifact?.targetDuration);
  if (artifact?.kind !== "VIDEO_STORYBOARD") errors.push("FINAL_STORYBOARD kind must be VIDEO_STORYBOARD");
  if (artifact?.format !== "FINAL_10_SECOND") errors.push("FINAL_STORYBOARD format must be FINAL_10_SECOND");
  if (duration !== lockedDuration) errors.push(`FINAL_STORYBOARD targetDuration ${duration} must equal screenplay duration ${lockedDuration}`);
  if (!(COURSE_VIDEO_DURATION_SECONDS as readonly number[]).includes(duration)) errors.push("FINAL_STORYBOARD targetDuration is outside the canonical duration set");

  const segments = Array.isArray(artifact?.segments) ? artifact.segments : [];
  const expectedCount = Number.isFinite(duration) ? duration / 10 : 0;
  if (segments.length !== expectedCount) errors.push(`FINAL_STORYBOARD expected ${expectedCount} segments for ${duration}s, got ${segments.length}`);

  const confirmed = confirmedPublicAssetIds(ctx);
  segments.forEach((segment: any, index: number) => {
    const sequence = index + 1;
    if (Number(segment?.sequence) !== sequence) errors.push(`FINAL_STORYBOARD segment sequence must be continuous; expected ${sequence}`);
    if (Number(segment?.duration) !== 10) errors.push(`FINAL_STORYBOARD segment ${sequence} duration must be 10 seconds`);
    const subshots = Array.isArray(segment?.subshots) ? segment.subshots : [];
    if (subshots.length < 3 || subshots.length > 5) errors.push(`FINAL_STORYBOARD segment ${sequence} must contain 3-5 subshots`);
    const sum = subshots.reduce((total: number, subshot: any) => total + Number(subshot?.duration || 0), 0);
    if (sum !== 10) errors.push(`FINAL_STORYBOARD segment ${sequence} subshot durations must sum to 10, got ${sum}`);
    subshots.forEach((subshot: any, subIndex: number) => {
      if (Number(subshot?.sequence) !== subIndex + 1) errors.push(`FINAL_STORYBOARD segment ${sequence} subshots must be continuously sequenced`);
      for (const field of ["visual", "action", "camera", "sound", "voice"]) {
        if (!String(subshot?.[field] || "").trim()) errors.push(`FINAL_STORYBOARD segment ${sequence} subshot ${subIndex + 1} requires ${field}`);
      }
    });
    const references = Array.isArray(segment?.references) ? segment.references : [];
    if (references.length > 7) errors.push(`FINAL_STORYBOARD segment ${sequence} exceeds 7 references`);
    const ids = references.map((reference: any) => String(reference?.publicAssetId || reference?.assetId || "").trim());
    if (new Set(ids).size !== ids.length) errors.push(`FINAL_STORYBOARD segment ${sequence} references must be unique`);
    for (const id of ids) {
      if (!STABLE_ID.test(id)) errors.push(`FINAL_STORYBOARD segment ${sequence} has invalid stable asset id ${id}`);
      if (!confirmed.has(id)) errors.push(`FINAL_STORYBOARD segment ${sequence} references unconfirmed asset ${id}`);
    }
  });
  return result(errors);
}

function validateCopyablePrompt(artifact: any, ctx: StageExecutionContext): ValidationResult {
  const errors: string[] = [];
  const storyboardSegments = Array.isArray((ctx.workflow.stages.FINAL_STORYBOARD?.artifact as any)?.segments)
    ? (ctx.workflow.stages.FINAL_STORYBOARD?.artifact as any).segments
    : [];
  const segments = Array.isArray(artifact?.segments) ? artifact.segments : [];
  if (artifact?.status !== "READY") errors.push("COPYABLE_PROMPT Phase 1 output must be READY");
  if (segments.length !== storyboardSegments.length) errors.push("COPYABLE_PROMPT must contain one derived segment for every final storyboard segment");
  const confirmed = confirmedPublicAssetIds(ctx);

  segments.forEach((segment: any, index: number) => {
    const sequence = index + 1;
    if (Number(segment?.sequence) !== sequence) errors.push(`COPYABLE_PROMPT segment sequence must be continuous; expected ${sequence}`);
    const text = String(segment?.text || "");
    const refs = Array.isArray(segment?.referenceAssetIds) ? segment.referenceAssetIds.map(String) : [];
    if (refs.length > 7) errors.push(`COPYABLE_PROMPT segment ${sequence} exceeds 7 references`);
    if (new Set(refs).size !== refs.length) errors.push(`COPYABLE_PROMPT segment ${sequence} referenceAssetIds must be unique`);
    refs.forEach((id: string) => {
      if (!STABLE_ID.test(id)) errors.push(`COPYABLE_PROMPT segment ${sequence} invalid stable id ${id}`);
      if (!confirmed.has(id)) errors.push(`COPYABLE_PROMPT segment ${sequence} references unconfirmed asset ${id}`);
    });

    const markers = [...text.matchAll(/【(P\d{3,}-A\d{3,})】/g)].map((match) => match[1]);
    if (new Set(markers).size !== markers.length) errors.push(`COPYABLE_PROMPT segment ${sequence} repeats a stable asset marker`);
    if (markers.some((id) => !refs.includes(id))) errors.push(`COPYABLE_PROMPT segment ${sequence} contains a marker missing from referenceAssetIds`);
    if (refs.some((id: string) => !markers.includes(id))) errors.push(`COPYABLE_PROMPT segment ${sequence} referenceAssetIds must all appear in text`);

    const visualStart = text.indexOf("画面效果：");
    const visualEnd = visualStart >= 0
      ? (text.indexOf("\n教师旁白：", visualStart) >= 0 ? text.indexOf("\n教师旁白：", visualStart) : text.length)
      : -1;
    const visualText = visualStart >= 0 ? text.slice(visualStart, visualEnd) : "";
    for (const match of text.matchAll(/【(P\d{3,}-A\d{3,})】/g)) {
      const markerIndex = match.index ?? -1;
      if (visualStart < 0 || markerIndex < visualStart || markerIndex >= visualEnd) {
        errors.push(`COPYABLE_PROMPT segment ${sequence} stable asset markers may appear only in 画面效果`);
        break;
      }
    }
    if (POSITIONAL_REFERENCE.test(visualText)) errors.push(`COPYABLE_PROMPT segment ${sequence} must not use positional image labels`);
  });

  const fullText = String(artifact?.fullText || "");
  for (const segment of segments) if (!fullText.includes(String(segment?.text || ""))) errors.push("COPYABLE_PROMPT fullText must contain every segment text");
  return result(errors);
}

export function validateVideosBatchTextStage(
  stageId: VideosBatchTextStageId,
  artifact: unknown,
  ctx: StageExecutionContext
): ValidationResult {
  switch (stageId) {
    case "COURSE_INTRO_CANDIDATES": return validateIntro(artifact);
    case "STORY_SCRIPT": return validateStoryScript(artifact, ctx);
    case "ASSET_PLAN": return validateAssetPlan(artifact);
    case "SCREENPLAY": return validateScreenplay(artifact, ctx);
    case "FINAL_STORYBOARD": return validateFinalStoryboard(artifact, ctx);
    case "COPYABLE_PROMPT": return validateCopyablePrompt(artifact, ctx);
  }
}

function createStage(stageId: VideosBatchTextStageId, executor: VideosBatchLlmExecutor): StageDefinition<any> {
  const spec = getVideosBatchTextStageSpec(stageId);
  return {
    id: stageId,
    async execute(ctx) {
      const response = await executor.generateStructured({
        operation: stageId,
        systemPrompt: spec.systemPrompt,
        userPrompt: spec.buildUserPrompt(ctx.workflow),
        schemaName: spec.schemaName,
        jsonSchema: spec.jsonSchema,
        metadata: {
          session_id: ctx.session.id,
          stage_id: stageId
        }
      });
      return { artifact: response.data };
    },
    validate(artifact, ctx) {
      return validateVideosBatchTextStage(stageId, artifact, ctx);
    },
    ...(stageId === "FINAL_STORYBOARD"
      ? {
          async project(artifact: any, ctx: StageExecutionContext) {
            if (!ctx.store) return;
            const projected = await projectFinalStoryboardIntoSeeReel(ctx.store, ctx.session.id, artifact);
            (artifact?.segments || []).forEach((segment: any, index: number) => {
              if (projected[index]) segment.nativeShotId = projected[index].id;
            });
          }
        }
      : {})
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
