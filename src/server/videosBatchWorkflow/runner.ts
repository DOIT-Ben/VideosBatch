import {
  VIDEOS_BATCH_STAGE_DEPENDENCIES,
  VIDEOS_BATCH_STAGE_ORDER,
  type VideosBatchAttemptRecord,
  type VideosBatchIntroSelectionMode,
  type VideosBatchStageError,
  type VideosBatchStageId,
  type VideosBatchStageState,
  type VideosBatchWorkflowState
} from "../../shared/videosBatchWorkflow";
import { contentHash } from "./canonicalStoryboard";
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

function contextWithWorkflow(ctx: StageExecutionContext, workflow: VideosBatchWorkflowState): StageExecutionContext {
  return { ...ctx, workflow, session: { ...ctx.session, videosBatchWorkflow: workflow } };
}

function isIntroSelectionMode(value: unknown): value is VideosBatchIntroSelectionMode {
  return value === "user_selected" || value === "system_recommended" || value === "custom";
}

function artifactHash(artifact: unknown): string | undefined {
  return artifact === undefined ? undefined : contentHash(artifact);
}

function hydrateArtifactHashes(workflow: VideosBatchWorkflowState) {
  for (const stage of Object.values(workflow.stages)) {
    if (!stage || stage.artifact === undefined) continue;
    const calculated = artifactHash(stage.artifact);
    if (!stage.contentHash || stage.contentHash !== calculated) stage.contentHash = calculated;
  }
}

function dependencySnapshot(workflow: VideosBatchWorkflowState, stageId: VideosBatchStageId) {
  const dependencies = VIDEOS_BATCH_STAGE_DEPENDENCIES[stageId] || [];
  const sourceHashes: Partial<Record<VideosBatchStageId, string>> = {};
  const sourceRevisions: Partial<Record<VideosBatchStageId, number>> = {};
  for (const dependency of dependencies) {
    const stage = workflow.stages[dependency];
    if (stage?.artifact !== undefined) {
      const hash = stage.contentHash || artifactHash(stage.artifact);
      if (hash) sourceHashes[dependency] = hash;
      if (typeof stage.revision === "number") sourceRevisions[dependency] = stage.revision;
    }
  }
  const first = dependencies[0] ? workflow.stages[dependencies[0]] : undefined;
  return {
    ...(dependencies[0] ? {
      sourceStageId: dependencies[0],
      sourceRevision: first?.revision || 0,
      ...(sourceHashes[dependencies[0]] ? { sourceHash: sourceHashes[dependencies[0]] } : {})
    } : {}),
    ...(Object.keys(sourceHashes).length ? { sourceHashes } : {}),
    ...(Object.keys(sourceRevisions).length ? { sourceRevisions } : {})
  };
}

function markDescendantsStale(workflow: VideosBatchWorkflowState, stageId: VideosBatchStageId, reason = "上游版本已变化") {
  const pending: VideosBatchStageId[] = [stageId];
  const visited = new Set<VideosBatchStageId>();
  while (pending.length) {
    const source = pending.shift()!;
    if (visited.has(source)) continue;
    visited.add(source);
    for (const candidate of VIDEOS_BATCH_STAGE_ORDER) {
      if (!(VIDEOS_BATCH_STAGE_DEPENDENCIES[candidate] || []).includes(source)) continue;
      const downstream = workflow.stages[candidate];
      if (downstream && candidate !== stageId) {
        workflow.stages[candidate] = {
          ...downstream,
          status: downstream.artifact === undefined ? "pending" : "stale",
          staleReason: reason,
          error: undefined,
          errorInfo: undefined
        };
      }
      pending.push(candidate);
    }
  }
}

function dependencyIssues(workflow: VideosBatchWorkflowState, stageId: VideosBatchStageId): string[] {
  const issues: string[] = [];
  const current = workflow.stages[stageId];
  const requiresLineage = Boolean(current && !["pending", "running"].includes(current.status));
  for (const dependency of VIDEOS_BATCH_STAGE_DEPENDENCIES[stageId] || []) {
    const source = workflow.stages[dependency];
    if (!source || source.status !== "ready" || source.artifact === undefined) {
      issues.push(`${stageId} requires current ready stage ${dependency}`);
      continue;
    }
    const calculated = artifactHash(source.artifact)!;
    if (source.contentHash && source.contentHash !== calculated) issues.push(`${dependency} contentHash is stale`);
    const recorded = current?.sourceHashes?.[dependency];
    if (requiresLineage && !recorded) issues.push(`${stageId} has no recorded source hash for ${dependency}`);
    if (recorded && recorded !== calculated) issues.push(`${stageId} was produced from an older ${dependency} revision`);
    const recordedRevision = current?.sourceRevisions?.[dependency]
      ?? (dependency === VIDEOS_BATCH_STAGE_DEPENDENCIES[stageId]?.[0] ? current?.sourceRevision : undefined);
    if (requiresLineage && typeof recordedRevision !== "number") issues.push(`${stageId} has no recorded source revision for ${dependency}`);
    if (typeof recordedRevision === "number" && recordedRevision !== source.revision) {
      issues.push(`${stageId} was produced from an older ${dependency} revision`);
    }
  }
  return issues;
}

function assetBelongsToSession(asset: any, sessionId: string, sessionShotIds: Set<string>, ownerUserId?: string) {
  if (!asset) return false;
  if (asset.ownerUserId && (!ownerUserId || asset.ownerUserId !== ownerUserId)) return false;
  if (asset.ownerSessionId === sessionId) return true;
  if (asset.ownerShotId && sessionShotIds.has(asset.ownerShotId)) return true;
  if (!asset.ownerSessionId && !asset.ownerShotId) return !asset.ownerUserId || Boolean(ownerUserId && asset.ownerUserId === ownerUserId);
  return Boolean(ownerUserId && asset.ownerUserId === ownerUserId && !asset.ownerShotId);
}

function assetReadableAndVerified(asset: any) {
  if (!asset) return false;
  // Fake mode deliberately has no media URL; native mode must have a readable image.
  if (asset.mediaKind === "image" && !String(asset.imageUrl || asset.mediaUrl || asset.thumbnailUrl || "").trim()) return false;
  if (asset.imageReviewStatus && asset.imageReviewStatus !== "ready") return false;
  if (asset.imageReview && asset.imageReview.ok === false) return false;
  return true;
}

function assetConfirmationReady(workflow: VideosBatchWorkflowState, ctx?: StageExecutionContext) {
  const plan = workflow.stages.ASSET_PLAN?.artifact as any;
  const candidates = workflow.stages.ASSET_CANDIDATES?.artifact as any;
  const confirmation = workflow.stages.ASSET_CONFIRMATION?.artifact as any;
  if (confirmation?.confirmed !== true) return false;
  const planItems = Array.isArray(plan?.items) ? plan.items : [];
  const candidateItems = Array.isArray(candidates?.items) ? candidates.items : [];
  const confirmedItems = Array.isArray(confirmation?.items) ? confirmation.items : [];
  const requiredPlanItems = planItems.filter((item: any) => item?.required !== false);
  if (!planItems.length || !requiredPlanItems.length) return false;
  if (candidateItems.length !== planItems.length) return false;
  const planKeys = planItems.map((item: any) => String(item?.assetKey || ""));
  const candidateKeys = candidateItems.map((item: any) => String(item?.assetKey || ""));
  const confirmedKeys = confirmedItems.map((item: any) => String(item?.assetKey || ""));
  if ([planKeys, candidateKeys].some((keys: string[]) => keys.some((key: string) => !key) || new Set(keys).size !== keys.length)) return false;
  if (confirmedKeys.some((key: string) => !key) || new Set(confirmedKeys).size !== confirmedKeys.length) return false;
  const candidateByKey = new Map(candidateItems.map((item: any) => [String(item?.assetKey || ""), item]));
  const confirmedByKey = new Map(confirmedItems.map((item: any) => [String(item?.assetKey || ""), item]));
  const sessionShotIds = new Set((ctx?.shots || []).map((shot) => shot.id));
  const nativeAssets = ctx?.store?.snapshot().assets || [];
  return requiredPlanItems.every((item: any) => {
    const key = String(item?.assetKey || "");
    const candidate = candidateByKey.get(key) as any;
    const confirmed = confirmedByKey.get(key) as any;
    const ids = Array.isArray(candidate?.candidateAssetIds) ? candidate.candidateAssetIds.map(String) : [];
    const confirmedIds = Array.isArray(confirmed?.candidateAssetIds) ? confirmed.candidateAssetIds.map(String) : [];
    if (!candidate || candidate.status === "failed" || !confirmed || !/^P\d{3,}-A\d{3,}$/.test(String(candidate.publicAssetId || ""))) return false;
    if (confirmed.publicAssetId !== candidate.publicAssetId || !confirmed.selectedAssetId) return false;
    if (!ids.length || !ids.includes(String(confirmed.selectedAssetId)) || confirmedIds.length !== ids.length || !ids.every((id: string) => confirmedIds.includes(id))) return false;
    if (!ctx) return true;
    const selected = nativeAssets.find((asset: any) => asset.id === String(confirmed.selectedAssetId));
    return assetBelongsToSession(selected, ctx.session.id, sessionShotIds, ctx.session.ownerUserId) && assetReadableAndVerified(selected);
  });
}

function introSelectionReady(workflow: VideosBatchWorkflowState) {
  return Boolean(workflow.introLocked && workflow.selectedIntroId && workflow.selectionMode && workflow.stages.COURSE_INTRO_SELECTION?.status === "ready");
}

function isManualGateReady(workflow: VideosBatchWorkflowState, stageId: VideosBatchStageId, ctx?: StageExecutionContext) {
  if (stageId === "COURSE_INTRO_SELECTION") return introSelectionReady(workflow);
  if (stageId === "ASSET_CONFIRMATION") return assetConfirmationReady(workflow, ctx);
  return true;
}

function clearIntroSelection(workflow: VideosBatchWorkflowState) {
  workflow.selectedIntroId = undefined;
  workflow.selectionMode = undefined;
  workflow.selectionReason = undefined;
  workflow.introLocked = false;
}

function stageErrorInfo(error: unknown): VideosBatchStageError {
  const value = error as Partial<{ code: string; retryable: boolean; attempt: number; attempts: number; provider: string | null; model: string | null }> | undefined;
  const attempt = typeof value?.attempt === "number" && value.attempt > 0
    ? value.attempt
    : typeof value?.attempts === "number" ? value.attempts : 0;
  return {
    code: typeof value?.code === "string" && value.code ? value.code : "STAGE_EXECUTION_FAILED",
    message: error instanceof Error ? error.message : String(error),
    retryable: typeof value?.retryable === "boolean" ? value.retryable : true,
    attempt,
    provider: typeof value?.provider === "string" ? value.provider : null,
    ...(typeof value?.model === "string" ? { model: value.model } : {})
  };
}

function resultAttemptLog(result: any): VideosBatchAttemptRecord[] | undefined {
  if (!Array.isArray(result?.attemptLog)) return undefined;
  return result.attemptLog.map((item: any) => ({
    attempt: Number(item.attempt) || 0,
    provider: typeof item.provider === "string" ? item.provider : null,
    ...(typeof item.model === "string" ? { model: item.model } : {}),
    outcome: item.outcome === "success" ? "success" : "error",
    ...(typeof item.errorCode === "string" ? { errorCode: item.errorCode } : {}),
    ...(typeof item.status === "number" ? { status: item.status } : {}),
    ...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}),
    ...(item.metadata && typeof item.metadata === "object" ? { metadata: structuredClone(item.metadata) } : {})
  }));
}

function stateWithResultMeta<T extends VideosBatchStageState<any>>(state: T, result: any): T {
  const attemptLog = resultAttemptLog(result);
  return {
    ...state,
    ...(typeof result?.attempts === "number" ? { attempts: result.attempts } : {}),
    ...(result?.provider !== undefined ? { provider: result.provider || null } : {}),
    ...(result?.model !== undefined ? { model: result.model || null } : {}),
    ...(attemptLog ? { attemptLog } : {})
  } as T;
}

function stateWithErrorMeta<T extends VideosBatchStageState<any>>(state: T, error: any): T {
  const attemptLog = resultAttemptLog(error);
  return {
    ...state,
    ...(typeof error?.attempts === "number" ? { attempts: error.attempts } : {}),
    ...(error?.provider !== undefined ? { provider: error.provider || null } : {}),
    ...(error?.model !== undefined ? { model: error.model || null } : {}),
    ...(attemptLog ? { attemptLog } : {})
  } as T;
}

/**
 * Media stages can return a useful partial artifact while one or more items
 * failed. Keep that artifact inspectable, but leave the stage retryable (or
 * explicitly blocked for an unknown provider submission) instead of marking
 * the stage ready and making the retry endpoint unreachable.
 */
function mediaArtifactFailure(stageId: VideosBatchStageId, artifact: any): VideosBatchStageError | undefined {
  if (stageId !== "ASSET_CANDIDATES" && stageId !== "EXECUTION") return undefined;
  const artifactStatus = String(artifact?.status || "");
  // Legacy/fake fixtures predate the media status field; absence is not a
  // failure. Only an explicit partial/failed result needs retry semantics.
  if (artifactStatus !== "PARTIAL" && artifactStatus !== "FAILED") return undefined;

  const failedItems = stageId === "ASSET_CANDIDATES"
    ? (Array.isArray(artifact?.failedItems) ? artifact.failedItems : [])
    : (Array.isArray(artifact?.failedShots) ? artifact.failedShots : []);
  const firstError = failedItems.find((item: any) => item?.error)?.error;
  const blocked = failedItems.some((item: any) => item?.status === "blocked" || item?.error?.code === "H3_SUBMISSION_STATE_UNKNOWN");
  const retryable = !blocked && failedItems.some((item: any) => item?.error?.retryable !== false);
  const code = String(firstError?.code || (blocked ? "H3_SUBMISSION_STATE_UNKNOWN" : "MEDIA_ITEMS_FAILED"));
  const message = String(firstError?.message || `${stageId} contains failed media items`);
  return {
    code,
    message,
    retryable,
    attempt: Number(firstError?.attempt || 0),
    provider: typeof firstError?.provider === "string" ? firstError.provider : null,
    ...(typeof firstError?.model === "string" ? { model: firstError.model } : {})
  };
}

export async function runNext(ctx: StageExecutionContext, registry: StageRegistry): Promise<VideosBatchWorkflowState> {
  const workflow = cloneWorkflow(ctx.workflow);
  hydrateArtifactHashes(workflow);
  if (workflow.completed) return workflow;
  const stageId = workflow.currentStage;
  const current = workflow.stages[stageId] || { status: "pending" as const, revision: 0 };

  if (stageId === "LESSON_INPUT") {
    if (current.artifact === undefined) {
      const updatedAt = nowIso();
      workflow.stages.LESSON_INPUT = { ...current, status: "failed", error: "LESSON_INPUT artifact is missing", errorInfo: { code: "LESSON_INPUT_MISSING", message: "LESSON_INPUT artifact is missing", retryable: false, attempt: 0, provider: null }, updatedAt };
      workflow.updatedAt = updatedAt;
      return workflow;
    }
    const updatedAt = nowIso();
    workflow.stages.LESSON_INPUT = { ...current, status: "ready", contentHash: artifactHash(current.artifact), updatedAt };
    workflow.currentStage = nextStage(stageId) || stageId;
    workflow.updatedAt = updatedAt;
    return workflow;
  }

  if (stageId === "COURSE_INTRO_SELECTION" || stageId === "ASSET_CONFIRMATION") {
    if (!isManualGateReady(workflow, stageId, ctx)) return workflow;
    const next = nextStage(stageId);
    if (next) workflow.currentStage = next;
    else workflow.completed = true;
    workflow.updatedAt = nowIso();
    return workflow;
  }

  const definition = registry[stageId];
  if (!definition) {
    const updatedAt = nowIso();
    workflow.stages[stageId] = {
      ...current,
      status: "failed",
      error: `No executor registered for ${stageId}`,
      errorInfo: { code: "STAGE_NOT_REGISTERED", message: `No executor registered for ${stageId}`, retryable: false, attempt: 0, provider: null },
      updatedAt
    };
    workflow.updatedAt = updatedAt;
    return workflow;
  }

  const issues = dependencyIssues(workflow, stageId);
  if (issues.length) {
    const updatedAt = nowIso();
    workflow.stages[stageId] = {
      ...current,
      status: current.artifact === undefined ? "failed" : "stale",
      error: issues.join("\n"),
      staleReason: "上游产物未确认或版本已变化",
      errorInfo: { code: "UPSTREAM_NOT_CURRENT", message: issues.join("\n"), retryable: false, attempt: 0, provider: null },
      updatedAt
    };
    workflow.updatedAt = updatedAt;
    return workflow;
  }

  const startedAt = nowIso();
  workflow.stages[stageId] = { ...current, status: "running", error: undefined, errorInfo: undefined, staleReason: undefined, updatedAt: startedAt };
  const runningCtx = contextWithWorkflow(ctx, workflow);

  let stageResult: any;
  let failedResultState: VideosBatchStageState<any> | undefined;
  try {
    stageResult = await definition.execute(runningCtx);
    const validation = definition.validate(stageResult.artifact, runningCtx);
    const withMeta = stateWithResultMeta({ ...current, artifact: stageResult.artifact }, stageResult);
    failedResultState = withMeta;
    const mediaFailure = validation.ok ? mediaArtifactFailure(stageId, stageResult.artifact) : undefined;
    if (!validation.ok || mediaFailure) {
      const updatedAt = nowIso();
      const info = mediaFailure || {
        code: "CONTRACT_VALIDATION_FAILED",
        message: validation.errors.join("\n"),
        retryable: true,
        attempt: stageResult.attempts || 0,
        provider: stageResult.provider || null,
        ...(stageResult.model ? { model: stageResult.model } : {})
      } satisfies VideosBatchStageError;
      workflow.stages[stageId] = {
        ...withMeta,
        status: "failed",
        artifact: stageResult.artifact,
        contentHash: artifactHash(stageResult.artifact),
        ...dependencySnapshot(workflow, stageId),
        error: info.message,
        errorInfo: info,
        updatedAt
      };
      workflow.updatedAt = updatedAt;
      return workflow;
    }

    if (definition.project) {
      // Projection code needs the revision that is about to be committed. The
      // executor still sees the running state, so provide a short-lived view
      // with the proposed stage state; this keeps native Shot batch metadata
      // aligned with the persisted canonical artifact on the first run.
      const projectionWorkflow = cloneWorkflow(workflow);
      projectionWorkflow.stages[stageId] = {
        ...withMeta,
        status: "ready",
        revision: current.revision + 1,
        artifact: stageResult.artifact,
        contentHash: artifactHash(stageResult.artifact),
        ...dependencySnapshot(projectionWorkflow, stageId),
        updatedAt: startedAt
      };
      await definition.project(stageResult.artifact, contextWithWorkflow(ctx, projectionWorkflow));
    }
    const completedAt = nowIso();
    const completedState = stateWithResultMeta({
      status: "ready",
      revision: current.revision + 1,
      artifact: stageResult.artifact,
      contentHash: artifactHash(stageResult.artifact),
      ...dependencySnapshot(workflow, stageId),
      updatedAt: completedAt
    }, stageResult);
    workflow.stages[stageId] = completedState;
    markDescendantsStale(workflow, stageId, `上游 ${stageId} 已生成新 revision`);
    workflow.updatedAt = completedAt;
    const next = nextStage(stageId);
    if (next) workflow.currentStage = next;
    else workflow.completed = true;
    return workflow;
  } catch (error) {
    const updatedAt = nowIso();
    const info = stageErrorInfo(error);
    const errorBase = stageResult?.artifact !== undefined
      ? stateWithErrorMeta(failedResultState || { ...current, artifact: stageResult.artifact }, stageResult)
      : stateWithErrorMeta(current, error);
    workflow.stages[stageId] = {
      ...errorBase,
      status: "failed",
      ...(stageResult?.artifact !== undefined ? { artifact: stageResult.artifact, contentHash: artifactHash(stageResult.artifact) } : {}),
      ...dependencySnapshot(workflow, stageId),
      error: info.message,
      errorInfo: info,
      updatedAt
    };
    workflow.updatedAt = updatedAt;
    return workflow;
  }
}

export async function runAll(ctx: StageExecutionContext, registry: StageRegistry): Promise<VideosBatchWorkflowState> {
  let workflow = cloneWorkflow(ctx.workflow);
  for (let step = 0; step < VIDEOS_BATCH_STAGE_ORDER.length + 4; step += 1) {
    if (workflow.completed) return workflow;
    if (workflow.currentStage === "COURSE_INTRO_SELECTION" || workflow.currentStage === "ASSET_CONFIRMATION") return workflow;
    const beforeStage = workflow.currentStage;
    workflow = await runNext(contextWithWorkflow(ctx, workflow), registry);
    if (workflow.stages[beforeStage]?.status === "failed" || workflow.stages[beforeStage]?.status === "stale") return workflow;
    if (!workflow.completed && workflow.currentStage === beforeStage) return workflow;
  }
  throw new Error("VideosBatch workflow exceeded the maximum canonical stage count");
}

function validateManualSelection(workflow: VideosBatchWorkflowState, artifact: any) {
  const selectedIntroId = String(artifact?.selectedIntroId || "").trim();
  const selectionMode = artifact?.selectionMode;
  const selectionReason = String(artifact?.selectionReason || "").trim();
  if (!selectedIntroId) throw new Error("COURSE_INTRO_SELECTION requires selectedIntroId");
  if (!isIntroSelectionMode(selectionMode)) throw new Error("COURSE_INTRO_SELECTION requires a valid selectionMode");
  if (!selectionReason) throw new Error("COURSE_INTRO_SELECTION requires selectionReason");
  if (artifact?.locked !== true) throw new Error("COURSE_INTRO_SELECTION must explicitly set locked=true");
  if (selectedIntroId === "CUSTOM") {
    if (!artifact?.confirmedEntry?.body) throw new Error("CUSTOM course intro requires confirmedEntry.body");
    return;
  }
  const candidates = Array.isArray((workflow.stages.COURSE_INTRO_CANDIDATES?.artifact as any)?.candidates)
    ? (workflow.stages.COURSE_INTRO_CANDIDATES?.artifact as any).candidates
    : [];
  if (!candidates.some((candidate: any) => candidate?.id === selectedIntroId)) throw new Error(`Unknown course intro selection: ${selectedIntroId}`);
}

function projectAssetConfirmationIntoPlan(_workflow: VideosBatchWorkflowState, _artifact: any) {
  // Stable IDs and native candidate IDs remain in ASSET_CANDIDATES/
  // ASSET_CONFIRMATION. The model-owned ASSET_PLAN stays free of server IDs.
}

export function replaceStageArtifact(
  source: VideosBatchWorkflowState,
  stageId: VideosBatchStageId,
  artifact: any,
  updatedAt = nowIso(),
  registry?: StageRegistry,
  context?: StageExecutionContext
): VideosBatchWorkflowState {
  const workflow = cloneWorkflow(source);
  hydrateArtifactHashes(workflow);
  const previousCurrentStage = source.currentStage;
  const previousCompleted = source.completed;
  const current = workflow.stages[stageId] || { status: "pending" as const, revision: 0 };

  if (stageId === "COURSE_INTRO_SELECTION") validateManualSelection(workflow, artifact);
  if (stageId === "ASSET_CONFIRMATION") {
    const candidateState = workflow.stages.ASSET_CANDIDATES;
    workflow.stages.ASSET_CONFIRMATION = { ...current, status: "ready", revision: current.revision + 1, artifact, contentHash: artifactHash(artifact), ...dependencySnapshot(workflow, stageId), updatedAt };
    if (!assetConfirmationReady(workflow, context)) throw new Error("ASSET_CONFIRMATION requires one confirmed selected image for every current asset-plan candidate");
    if (!candidateState || candidateState.status !== "ready") throw new Error("ASSET_CONFIRMATION requires current ASSET_CANDIDATES");
  }

  if (registry?.[stageId] && stageId !== "ASSET_CONFIRMATION" && stageId !== "COURSE_INTRO_SELECTION" && context) {
    const validation = registry[stageId]!.validate(artifact, contextWithWorkflow(context, workflow));
    if (!validation.ok) throw new Error(`CONTRACT_VALIDATION_FAILED: ${validation.errors.join("\n")}`);
  }

  workflow.stages[stageId] = {
    ...current,
    status: "ready",
    revision: current.revision + 1,
    artifact,
    contentHash: artifactHash(artifact),
    ...dependencySnapshot(workflow, stageId),
    error: undefined,
    errorInfo: undefined,
    staleReason: undefined,
    updatedAt
  };

  if (stageId === "COURSE_INTRO_SELECTION") {
    workflow.selectedIntroId = String(artifact.selectedIntroId).trim();
    workflow.selectionMode = artifact.selectionMode;
    workflow.selectionReason = String(artifact.selectionReason).trim();
    workflow.introLocked = true;
  }
  projectAssetConfirmationIntoPlan(workflow, artifact);
  markDescendantsStale(workflow, stageId, `上游 ${stageId} 已被人工确认/编辑`);

  const stageIndex = VIDEOS_BATCH_STAGE_ORDER.indexOf(stageId);
  const previousCurrentIndex = VIDEOS_BATCH_STAGE_ORDER.indexOf(previousCurrentStage);
  const introSelectionIndex = VIDEOS_BATCH_STAGE_ORDER.indexOf("COURSE_INTRO_SELECTION");
  if (stageIndex < introSelectionIndex) clearIntroSelection(workflow);

  const next = nextStage(stageId);
  if (previousCurrentStage === stageId) {
    if (next) {
      workflow.currentStage = next;
      workflow.completed = false;
    } else workflow.completed = true;
  } else if (next && (previousCompleted || (previousCurrentIndex >= 0 && stageIndex < previousCurrentIndex))) {
    workflow.currentStage = next;
    workflow.completed = false;
  }
  workflow.updatedAt = updatedAt;
  return workflow;
}

export function restartFrom(source: VideosBatchWorkflowState, stageId: VideosBatchStageId, updatedAt = nowIso()): VideosBatchWorkflowState {
  const workflow = cloneWorkflow(source);
  hydrateArtifactHashes(workflow);
  const current = workflow.stages[stageId] || { status: "pending" as const, revision: 0 };
  workflow.currentStage = stageId;
  workflow.completed = false;
  workflow.stages[stageId] = { ...current, status: "pending", error: undefined, errorInfo: undefined, staleReason: undefined, updatedAt };
  markDescendantsStale(workflow, stageId, `从 ${stageId} 重新开始`);
  if (VIDEOS_BATCH_STAGE_ORDER.indexOf(stageId) <= VIDEOS_BATCH_STAGE_ORDER.indexOf("COURSE_INTRO_SELECTION")) clearIntroSelection(workflow);
  workflow.updatedAt = updatedAt;
  return workflow;
}

export function retryLineageIssues(
  workflow: VideosBatchWorkflowState,
  stageId: VideosBatchStageId,
  input: { sourceRevision?: unknown; sourceHash?: unknown; sourceHashes?: unknown } = {}
): string[] {
  const issues: string[] = [];
  const stage = workflow.stages[stageId];
  const dependencies = VIDEOS_BATCH_STAGE_DEPENDENCIES[stageId] || [];
  if (!stage) return [`Unknown stage ${stageId}`];
  if (stage.status !== "failed") issues.push(`${stageId} is not currently failed`);
  if (stage.errorInfo && stage.errorInfo.retryable !== true) issues.push(`${stageId} failure is not retryable`);
  const suppliedHashes = input.sourceHashes && typeof input.sourceHashes === "object" ? input.sourceHashes as Record<string, unknown> : {};
  for (let index = 0; index < dependencies.length; index += 1) {
    const dependency = dependencies[index];
    const source = workflow.stages[dependency];
    if (!source || source.status !== "ready" || source.artifact === undefined) {
      issues.push(`${stageId} requires current ready stage ${dependency}`);
      continue;
    }
    const actualHash = artifactHash(source.artifact)!;
    const recordedHash = stage.sourceHashes?.[dependency]
      ?? (index === 0 ? stage.sourceHash : undefined);
    const recordedRevision = stage.sourceRevisions?.[dependency]
      ?? (index === 0 ? stage.sourceRevision : undefined);
    if (!recordedHash || recordedHash !== actualHash) issues.push(`${stageId} source hash for ${dependency} is missing or stale`);
    if (typeof recordedRevision !== "number" || recordedRevision !== source.revision) issues.push(`${stageId} source revision for ${dependency} is missing or stale`);
    const suppliedHash = index === 0 ? input.sourceHash : suppliedHashes[dependency];
    const suppliedRevision = index === 0 ? input.sourceRevision : undefined;
    if (typeof suppliedHash !== "string" || suppliedHash !== actualHash) issues.push(`retry request must provide current ${dependency} sourceHash`);
    if (index === 0 && (typeof suppliedRevision !== "number" || suppliedRevision !== source.revision)) issues.push(`retry request must provide current ${dependency} sourceRevision`);
    if (index > 0 && (typeof suppliedHashes[dependency] !== "string" || suppliedHashes[dependency] !== actualHash)) issues.push(`retry request must provide current ${dependency} sourceHashes entry`);
  }
  return issues;
}

export { assetConfirmationReady };
