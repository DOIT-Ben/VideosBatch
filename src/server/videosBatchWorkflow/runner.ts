import {
  VIDEOS_BATCH_STAGE_ORDER,
  type VideosBatchIntroSelectionMode,
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
        stage ? { ...stage, artifact: stage.artifact === undefined ? undefined : structuredClone(stage.artifact) } : stage
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

function isIntroSelectionMode(value: unknown): value is VideosBatchIntroSelectionMode {
  return value === "user_selected" || value === "system_recommended" || value === "custom";
}

function introSelectionReady(workflow: VideosBatchWorkflowState) {
  return Boolean(workflow.introLocked && workflow.selectedIntroId && workflow.selectionMode);
}

function assetConfirmationReady(workflow: VideosBatchWorkflowState) {
  const artifact = workflow.stages.ASSET_CONFIRMATION?.artifact as any;
  if (artifact?.confirmed !== true) return false;
  const planItems = Array.isArray((workflow.stages.ASSET_PLAN?.artifact as any)?.items)
    ? (workflow.stages.ASSET_PLAN?.artifact as any).items
    : [];
  const confirmedItems = Array.isArray(artifact?.items) ? artifact.items : [];
  if (!planItems.length || confirmedItems.length !== planItems.length) return false;
  const byKey = new Map(confirmedItems.map((item: any) => [String(item?.assetKey || ""), item]));
  return planItems.every((item: any) => {
    const confirmed = byKey.get(String(item?.assetKey || "")) as any;
    return Boolean(confirmed?.publicAssetId && confirmed?.selectedAssetId);
  });
}

function isManualGateReady(workflow: VideosBatchWorkflowState, stageId: VideosBatchStageId) {
  if (stageId === "COURSE_INTRO_SELECTION") return introSelectionReady(workflow);
  if (stageId === "ASSET_CONFIRMATION") return assetConfirmationReady(workflow);
  return true;
}

function clearIntroSelection(workflow: VideosBatchWorkflowState) {
  workflow.selectedIntroId = undefined;
  workflow.selectionMode = undefined;
  workflow.selectionReason = undefined;
  workflow.introLocked = false;
}

function markDownstreamStale(workflow: VideosBatchWorkflowState, stageId: VideosBatchStageId) {
  const stageIndex = VIDEOS_BATCH_STAGE_ORDER.indexOf(stageId);
  for (let index = stageIndex + 1; index < VIDEOS_BATCH_STAGE_ORDER.length; index += 1) {
    const downstreamId = VIDEOS_BATCH_STAGE_ORDER[index];
    const downstream = workflow.stages[downstreamId];
    if (downstream?.status === "ready") {
      workflow.stages[downstreamId] = { ...downstream, status: "stale" };
    }
  }
}

/**
 * Server-owned confirmation fields are projected back into ASSET_PLAN only after
 * the user confirms candidates. Model output owns assetKey/prompt semantics;
 * it never owns publicAssetId or selected native Asset.id values.
 */
function projectAssetConfirmationIntoPlan(workflow: VideosBatchWorkflowState, artifact: any) {
  if (artifact?.confirmed !== true || !Array.isArray(artifact?.items)) return;
  const planState = workflow.stages.ASSET_PLAN;
  const plan = planState?.artifact as any;
  if (!planState || !plan || !Array.isArray(plan.items)) return;

  const byKey = new Map(artifact.items.map((item: any) => [String(item?.assetKey || ""), item]));
  planState.artifact = {
    ...plan,
    items: plan.items.map((item: any) => {
      const confirmed = byKey.get(String(item?.assetKey || "")) as any;
      if (!confirmed) return item;
      return {
        ...item,
        assetId: confirmed.publicAssetId,
        candidateAssetIds: Array.isArray(confirmed.candidateAssetIds) ? confirmed.candidateAssetIds : undefined,
        selectedAssetId: confirmed.selectedAssetId
      };
    })
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
    // restartFrom can leave LESSON_INPUT pending; the lesson artifact itself is
    // still the confirmed input, so advance out of pending instead of stalling.
    const lessonStage = workflow.stages.LESSON_INPUT;
    if (!lessonStage || lessonStage.status !== "ready") {
      workflow.stages.LESSON_INPUT = {
        status: "ready",
        revision: lessonStage?.revision || 0,
        artifact: lessonStage?.artifact,
        updatedAt: nowIso()
      };
    }
    workflow.currentStage = "COURSE_INTRO_CANDIDATES";
    workflow.updatedAt = nowIso();
    return workflow;
  }

  // Manual gates are completed only through an explicit artifact save/confirm action.
  if (stageId === "COURSE_INTRO_SELECTION" || stageId === "ASSET_CONFIRMATION") {
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

    if (definition.project) await definition.project(result.artifact, runningCtx);

    const completedAt = nowIso();
    workflow.stages[stageId] = {
      status: "ready",
      revision: current.revision + 1,
      artifact: result.artifact,
      updatedAt: completedAt
    };
    workflow.updatedAt = completedAt;

    const next = nextStage(stageId);
    if (next) workflow.currentStage = next;
    else workflow.completed = true;

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

  for (let step = 0; step < VIDEOS_BATCH_STAGE_ORDER.length + 4; step += 1) {
    if (workflow.completed) return workflow;
    if (!isManualGateReady(workflow, workflow.currentStage)) return workflow;
    if (workflow.currentStage === "COURSE_INTRO_SELECTION" || workflow.currentStage === "ASSET_CONFIRMATION") return workflow;

    const beforeStage = workflow.currentStage;
    const next = await runNext(contextWithWorkflow(ctx, workflow), registry);
    workflow = next;

    if (workflow.stages[beforeStage]?.status === "failed") return workflow;
    if (!workflow.completed && workflow.currentStage === beforeStage) return workflow;
  }

  throw new Error("VideosBatch workflow exceeded the maximum canonical stage count");
}

export function replaceStageArtifact(
  source: VideosBatchWorkflowState,
  stageId: VideosBatchStageId,
  artifact: any,
  updatedAt = nowIso()
): VideosBatchWorkflowState {
  const workflow = cloneWorkflow(source);
  const previousCurrentStage = source.currentStage;
  const previousCompleted = source.completed;
  const current = workflow.stages[stageId] || { status: "pending" as const, revision: 0 };

  if (stageId === "COURSE_INTRO_SELECTION") {
    const selectedIntroId = String(artifact?.selectedIntroId || "").trim();
    const selectionMode = artifact?.selectionMode;
    const selectionReason = String(artifact?.selectionReason || "").trim();
    if (!selectedIntroId) throw new Error("COURSE_INTRO_SELECTION requires selectedIntroId");
    if (!isIntroSelectionMode(selectionMode)) throw new Error("COURSE_INTRO_SELECTION requires a valid selectionMode");
    if (!selectionReason) throw new Error("COURSE_INTRO_SELECTION requires selectionReason");
    if (artifact?.locked !== true) throw new Error("COURSE_INTRO_SELECTION must explicitly set locked=true");

    if (selectedIntroId !== "CUSTOM") {
      const candidates = Array.isArray((workflow.stages.COURSE_INTRO_CANDIDATES?.artifact as any)?.candidates)
        ? (workflow.stages.COURSE_INTRO_CANDIDATES?.artifact as any).candidates
        : [];
      if (!candidates.some((candidate: any) => candidate?.id === selectedIntroId)) {
        throw new Error(`Unknown course intro selection: ${selectedIntroId}`);
      }
    } else if (!artifact?.confirmedEntry?.body) {
      throw new Error("CUSTOM course intro requires confirmedEntry.body");
    }

    workflow.selectedIntroId = selectedIntroId;
    workflow.selectionMode = selectionMode;
    workflow.selectionReason = selectionReason;
    workflow.introLocked = true;
  }

  workflow.stages[stageId] = {
    status: "ready",
    revision: current.revision + 1,
    artifact,
    updatedAt
  };

  if (stageId === "ASSET_CONFIRMATION") {
    projectAssetConfirmationIntoPlan(workflow, artifact);
    if (!assetConfirmationReady(workflow)) {
      throw new Error("ASSET_CONFIRMATION requires one confirmed selected image for every asset-plan item");
    }
  }

  markDownstreamStale(workflow, stageId);

  const stageIndex = VIDEOS_BATCH_STAGE_ORDER.indexOf(stageId);
  const previousCurrentIndex = VIDEOS_BATCH_STAGE_ORDER.indexOf(previousCurrentStage);
  const introSelectionIndex = VIDEOS_BATCH_STAGE_ORDER.indexOf("COURSE_INTRO_SELECTION");
  if (stageIndex < introSelectionIndex) clearIntroSelection(workflow);

  const next = nextStage(stageId);
  if (previousCurrentStage === stageId) {
    if (next) {
      workflow.currentStage = next;
      workflow.completed = false;
    } else {
      workflow.completed = true;
    }
  } else if (next && (previousCompleted || (previousCurrentIndex >= 0 && stageIndex < previousCurrentIndex))) {
    // Editing an artifact that the workflow has already passed invalidates every downstream result.
    // Resume from the immediate downstream stage so the canonical chain is recalculated in order.
    workflow.currentStage = next;
    workflow.completed = false;
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

  markDownstreamStale(workflow, stageId);

  if (stageIndex <= VIDEOS_BATCH_STAGE_ORDER.indexOf("COURSE_INTRO_SELECTION")) {
    clearIntroSelection(workflow);
  }

  if (stageIndex <= VIDEOS_BATCH_STAGE_ORDER.indexOf("ASSET_CONFIRMATION")) {
    const confirmation = workflow.stages.ASSET_CONFIRMATION;
    if (confirmation && stageId !== "ASSET_CONFIRMATION") {
      workflow.stages.ASSET_CONFIRMATION = { ...confirmation, status: "stale" };
    }
  }

  workflow.updatedAt = updatedAt;
  return workflow;
}
