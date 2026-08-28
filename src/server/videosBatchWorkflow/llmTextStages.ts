import type { VideosBatchStageId } from "../../shared/videosBatchWorkflow";
import type { VideosBatchLlmExecutor } from "./llmExecutor";
import { projectStoryboardIntoSeeReel } from "./nativeProjection";
import type { StageDefinition, StageExecutionContext, StageRegistry, ValidationResult } from "./stageContracts";
import {
  VIDEOS_BATCH_TEXT_STAGE_IDS,
  getVideosBatchTextStageSpec,
  type VideosBatchTextStageId
} from "./textStageSpecs";

function result(errors: string[]): ValidationResult {
  return { ok: errors.length === 0, errors };
}

function textLength(value: unknown) {
  return Array.from(String(value || "").trim()).length;
}

function validateIntro(artifact: any): ValidationResult {
  const errors: string[] = [];
  const expectedIds = ["A1", "A2", "A3", "B1", "B2", "B3", "C1", "C2", "C3"];
  const candidates = Array.isArray(artifact?.candidates) ? artifact.candidates : [];
  const recommendations = Array.isArray(artifact?.recommendations) ? artifact.recommendations : [];
  if (candidates.length !== 9) errors.push(`INTRO_GENERATION expected 9 candidates, got ${candidates.length}`);
  const ids = candidates.map((item: any) => String(item?.id || ""));
  for (const id of expectedIds) if (!ids.includes(id)) errors.push(`INTRO_GENERATION missing candidate ${id}`);
  if (new Set(ids).size !== ids.length) errors.push("INTRO_GENERATION candidate ids must be unique");
  for (const candidate of candidates) {
    const length = textLength(candidate?.body);
    if (length < 200 || length > 300) errors.push(`INTRO_GENERATION ${candidate?.id || "candidate"} body must be 200-300 characters, got ${length}`);
    if (!String(candidate?.endingQuestion || "").trim()) errors.push(`INTRO_GENERATION ${candidate?.id || "candidate"} requires endingQuestion`);
  }
  if (recommendations.length !== 3) errors.push(`INTRO_GENERATION expected 3 recommendations, got ${recommendations.length}`);
  const recommendationIds = recommendations.map((item: any) => String(item?.id || ""));
  if (new Set(recommendationIds).size !== recommendationIds.length) errors.push("INTRO_GENERATION recommendation ids must be unique");
  for (const id of recommendationIds) if (!ids.includes(id)) errors.push(`INTRO_GENERATION recommendation references unknown candidate ${id}`);
  return result(errors);
}

function validateStories(artifact: any): ValidationResult {
  const errors: string[] = [];
  const stories = Array.isArray(artifact?.stories) ? artifact.stories : [];
  if (stories.length !== 3) errors.push(`STORY_EXPANSION expected 3 stories, got ${stories.length}`);
  const ids = stories.map((item: any) => String(item?.id || ""));
  if (new Set(ids).size !== ids.length) errors.push("STORY_EXPANSION story ids must be unique");
  for (const story of stories) {
    const length = textLength(story?.content);
    if (length < 600 || length > 800) errors.push(`STORY_EXPANSION ${story?.id || "story"} content must be 600-800 characters, got ${length}`);
    if (!String(story?.sourceIntroId || "").trim()) errors.push(`STORY_EXPANSION ${story?.id || "story"} requires sourceIntroId`);
  }
  return result(errors);
}

function workflowProjectId(ctx: StageExecutionContext) {
  return String(ctx.workflow.stages.LESSON_INPUT?.artifact?.projectId || "").trim();
}

function validateAssets(artifact: any, ctx: StageExecutionContext): ValidationResult {
  const errors: string[] = [];
  const projectId = workflowProjectId(ctx);
  const assets = Array.isArray(artifact?.assets) ? artifact.assets : [];
  if (!assets.length) errors.push("ASSET_PROMPT_GENERATION requires at least one asset");
  const seen = new Set<string>();
  assets.forEach((asset: any, index: number) => {
    const expected = `${projectId}-A${String(index + 1).padStart(3, "0")}`;
    const actual = String(asset?.referenceId || "").trim();
    if (actual !== expected) errors.push(`ASSET_PROMPT_GENERATION expected ${expected} at position ${index + 1}, got ${actual || "<empty>"}`);
    if (seen.has(actual)) errors.push(`ASSET_PROMPT_GENERATION duplicate referenceId ${actual}`);
    seen.add(actual);
    if (!String(asset?.name || "").trim()) errors.push(`ASSET_PROMPT_GENERATION ${actual || expected} requires name`);
    if (!String(asset?.prompt || "").trim()) errors.push(`ASSET_PROMPT_GENERATION ${actual || expected} requires prompt`);
  });
  return result(errors);
}

function validateScreenplay(artifact: any): ValidationResult {
  const errors: string[] = [];
  const scenes = Array.isArray(artifact?.scenes) ? artifact.scenes : [];
  if (!scenes.length) errors.push("SCREENPLAY_GENERATION requires at least one scene");
  for (const [index, scene] of scenes.entries()) {
    if (!String(scene?.id || "").trim()) errors.push(`SCREENPLAY_GENERATION scene ${index + 1} requires id`);
    if (!Array.isArray(scene?.visuals) || !scene.visuals.length) errors.push(`SCREENPLAY_GENERATION scene ${scene?.id || index + 1} requires visual/action description`);
    if (!Array.isArray(scene?.presentationModes) || !scene.presentationModes.length) errors.push(`SCREENPLAY_GENERATION scene ${scene?.id || index + 1} requires presentationModes`);
  }
  return result(errors);
}

function validateStoryboard(artifact: any): ValidationResult {
  const errors: string[] = [];
  const shots = Array.isArray(artifact?.shots) ? artifact.shots : [];
  if (!shots.length) errors.push("STORYBOARD_GENERATION requires at least one shot");
  const ids = shots.map((shot: any) => String(shot?.id || ""));
  if (new Set(ids).size !== ids.length) errors.push("STORYBOARD_GENERATION shot ids must be unique");
  for (const [index, shot] of shots.entries()) {
    const label = shot?.id || `shot ${index + 1}`;
    if (Number(shot?.durationSec) !== 10) errors.push(`STORYBOARD_GENERATION ${label} duration must be 10 seconds`);
    const subshots = Array.isArray(shot?.subshots) ? shot.subshots : [];
    if (subshots.length < 3 || subshots.length > 5) errors.push(`STORYBOARD_GENERATION ${label} must contain 3-5 subshots`);
    const sum = subshots.reduce((total: number, subshot: any) => total + Number(subshot?.durationSec || 0), 0);
    if (Math.abs(sum - 10) > 1e-6) errors.push(`STORYBOARD_GENERATION ${label} subshot durations must sum to 10 seconds, got ${sum}`);
    let cursor = 0;
    for (const [subIndex, subshot] of subshots.entries()) {
      const start = Number(subshot?.startSec);
      const end = Number(subshot?.endSec);
      const duration = Number(subshot?.durationSec);
      if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(duration) || end <= start) {
        errors.push(`STORYBOARD_GENERATION ${label} subshot ${subIndex + 1} has invalid timing`);
        continue;
      }
      if (Math.abs(start - cursor) > 1e-6) errors.push(`STORYBOARD_GENERATION ${label} subshot ${subIndex + 1} must start at ${cursor}`);
      if (Math.abs((end - start) - duration) > 1e-6) errors.push(`STORYBOARD_GENERATION ${label} subshot ${subIndex + 1} duration does not match its time range`);
      cursor = end;
    }
    if (subshots.length && Math.abs(cursor - 10) > 1e-6) errors.push(`STORYBOARD_GENERATION ${label} timeline must end at 10 seconds, got ${cursor}`);
  }
  return result(errors);
}

export function validateVideosBatchTextStage(
  stageId: VideosBatchTextStageId,
  artifact: unknown,
  ctx: StageExecutionContext
): ValidationResult {
  switch (stageId) {
    case "INTRO_GENERATION":
      return validateIntro(artifact);
    case "STORY_EXPANSION":
      return validateStories(artifact);
    case "ASSET_PROMPT_GENERATION":
      return validateAssets(artifact, ctx);
    case "SCREENPLAY_GENERATION":
      return validateScreenplay(artifact);
    case "STORYBOARD_GENERATION":
      return validateStoryboard(artifact);
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
    ...(stageId === "STORYBOARD_GENERATION"
      ? {
          async project(artifact: any, ctx: StageExecutionContext) {
            if (!ctx.store) return;
            const projectionArtifact = {
              shots: (artifact?.shots || []).map((shot: any) => ({
                ...shot,
                script: (shot.subshots || [])
                  .map((subshot: any) => String(subshot?.dialogue || "").trim())
                  .filter(Boolean)
                  .join("\n"),
                camera: (shot.subshots || [])
                  .map((subshot: any) => String(subshot?.camera || "").trim())
                  .filter(Boolean)
                  .join(" / ")
              }))
            };
            await projectStoryboardIntoSeeReel(ctx.store, ctx.session.id, projectionArtifact);
            projectionArtifact.shots.forEach((projected: any, index: number) => {
              if (artifact?.shots?.[index]) artifact.shots[index].nativeShotId = projected.nativeShotId;
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
