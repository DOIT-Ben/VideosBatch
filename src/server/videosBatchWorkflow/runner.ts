import {
  VIDEOS_BATCH_STAGE_ORDER,
  type VideosBatchStageId,
  type VideosBatchWorkflowState
} from "../../shared/videosBatchWorkflow";
import type { StageExecutionContext, StageRegistry } from "./stageContracts";

const nowIso = () => new Date().toISOString();

function nextStage(stageId: VideosBatchStageId): VideosBatchStageId | undefined {
  const index = VIDEOS_BATCH_STAGE_ORDER.indexOf(stageId);
  if (index < 0 || index >= VIDEOS_BATCH_STAGE_ORDER.length - 1) return undefined;
  return VIDEOS_BATCH_STAGE_ORDER[index + 1];
}

function cloneWorkflow(workflow: VideosBatchWorkflowState): VideosBatchWorkflowState {
  return {
    ...workflow,
    stages: Object.fromEntries(
      Object.entries(workflow.stages).map(([stageId, stage]) => [
        stageId,
        stage ? { ...stage } : stage
      ])
    ) as VideosBatchWorkflowState["stages"]
  };
}

function contextWithWorkflow(
  ctx: StageExecutionContext,
  workflow: VideosBatchWorkflowState
): StageExecutionContext {
  return {
    ...ctx,
    workflow,
    session: {
      ...ctx.session,
      videosBatchWorkflow: workflow
    }
  };
}

export async function runNext(
  ctx: StageExecutionContext,
  registry: StageRegistry
): Promise<VideosBatchWorkflowState> {
  const workflow = cloneWorkflow(ctx.workflow);
  if (workflow.completed) return workflow;

  const stageId = workflow.currentStage;
  if (stageId === "LESSON_INPUT") {
    workflow.currentStage = "INTRO_GENERATION";
    workflow.updatedAt = nowIso();
    return workflow;
  }

  if (stageId === "STORY_SELECTION" && !workflow.selectedStoryId) {
    return workflow;
  }

  const definition = registry[stageId];
  const current = workflow.stages[stageId] || { status: "pending" as const, revision: 0 };
  if (!definition) {
    workflow.stages[stageId] = {
      ...current,
      status: "failed",
      error: `No executor registered for ${stageId}`,
      updatedAt: nowIso()
    };
    workflow.updatedAt = nowIso();
    return workflow;
  }

  workflow.stages[stageId] = {
    ...current,
    status: "running",
    error: undefined,
    updatedAt: nowIso()
  };

  const runningCtx = contextWithWorkflow(ctx, workflow);

  try {
    const result = await definition.execute(runningCtx);
    const validation = definition.validate(result.artifact, runningCtx);

    if (!validation.ok) {
      workflow.stages[stageId] = {
        ...current,
        status: "failed",
        artifact: result.artifact,
        error: validation.errors.join("\n"),
        updatedAt: nowIso()
      };
      workflow.updatedAt = nowIso();
      return workflow;
    }

    if (definition.project) {
      await definition.project(result.artifact, runningCtx);
    }

    const completedAt = nowIso();
    workflow.stages[stageId] = {
      status: "ready",
      revision: current.revision + 1,
      artifact: result.artifact,
      updatedAt: completedAt
    };
    workflow.updatedAt = completedAt;

    const next = nextStage(stageId);
    if (next) {
      workflow.currentStage = next;
    } else {
      workflow.completed = true;
    }

    return workflow;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    workflow.stages[stageId] = {
      ...current,
      status: "failed",
      error: message,
      updatedAt: nowIso()
    };
    workflow.updatedAt = nowIso();
    return workflow;
  }
}

export async function runAll(
  ctx: StageExecutionContext,
  registry: StageRegistry
): Promise<VideosBatchWorkflowState> {
  let workflow = cloneWorkflow(ctx.workflow);

  for (let step = 0; step < VIDEOS_BATCH_STAGE_ORDER.length + 2; step += 1) {
    if (workflow.completed) return workflow;
    if (workflow.currentStage === "STORY_SELECTION" && !workflow.selectedStoryId) {
      return workflow;
    }

    const beforeStage = workflow.currentStage;
    const next = await runNext(contextWithWorkflow(ctx, workflow), registry);
    workflow = next;

    if (workflow.stages[workflow.currentStage]?.status === "failed") {
      return workflow;
    }
    if (!workflow.completed && workflow.currentStage === beforeStage) {
      return workflow;
    }
  }

  throw new Error("VideosBatch workflow exceeded the maximum linear stage count");
}

export function replaceStageArtifact(
  source: VideosBatchWorkflowState,
  stageId: VideosBatchStageId,
  artifact: any,
  updatedAt = nowIso()
): VideosBatchWorkflowState {
  const workflow = cloneWorkflow(source);
  const stageIndex = VIDEOS_BATCH_STAGE_ORDER.indexOf(stageId);
  const current = workflow.stages[stageId] || { status: "pending" as const, revision: 0 };

  workflow.stages[stageId] = {
    status: "ready",
    revision: current.revision + 1,
    artifact,
    updatedAt
  };

  for (let index = stageIndex + 1; index < VIDEOS_BATCH_STAGE_ORDER.length; index += 1) {
    const downstreamId = VIDEOS_BATCH_STAGE_ORDER[index];
    const downstream = workflow.stages[downstreamId];
    if (downstream?.status === "ready") {
      workflow.stages[downstreamId] = {
        ...downstream,
        status: "stale"
      };
    }
  }

  if (stageIndex < VIDEOS_BATCH_STAGE_ORDER.indexOf("STORY_SELECTION")) {
    workflow.selectedStoryId = undefined;
  }

  if (stageId === "STORY_SELECTION") {
    const selectedStoryId = typeof artifact?.selectedStoryId === "string"
      ? artifact.selectedStoryId.trim()
      : "";
    workflow.selectedStoryId = selectedStoryId || undefined;
  }

  if (workflow.currentStage === stageId) {
    const next = nextStage(stageId);
    if (next) {
      workflow.currentStage = next;
    } else {
      workflow.completed = true;
    }
  }

  workflow.updatedAt = updatedAt;
  return workflow;
}

export function restartFrom(
  source: VideosBatchWorkflowState,
  stageId: VideosBatchStageId,
  updatedAt = nowIso()
): VideosBatchWorkflowState {
  const workflow = cloneWorkflow(source);
  const stageIndex = VIDEOS_BATCH_STAGE_ORDER.indexOf(stageId);
  const current = workflow.stages[stageId] || { status: "pending" as const, revision: 0 };

  workflow.currentStage = stageId;
  workflow.completed = false;
  workflow.stages[stageId] = {
    ...current,
    status: "pending",
    error: undefined,
    updatedAt
  };

  for (let index = stageIndex + 1; index < VIDEOS_BATCH_STAGE_ORDER.length; index += 1) {
    const downstreamId = VIDEOS_BATCH_STAGE_ORDER[index];
    const downstream = workflow.stages[downstreamId];
    if (downstream?.status === "ready") {
      workflow.stages[downstreamId] = {
        ...downstream,
        status: "stale"
      };
    }
  }

  if (stageIndex <= VIDEOS_BATCH_STAGE_ORDER.indexOf("STORY_SELECTION")) {
    workflow.selectedStoryId = undefined;
  }

  workflow.updatedAt = updatedAt;
  return workflow;
}
