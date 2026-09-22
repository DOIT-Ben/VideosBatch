import type { Session, Shot } from "../../shared/types";
import type { VideosBatchWorkflowState } from "../../shared/videosBatchWorkflow";
import { canonicalStoryboardBatchId, canonicalStoryboardSourceHash } from "../videosBatchWorkflow/canonicalStoryboard";

export function currentExecutionShots(session: Session & { shots: Shot[] }, workflow: VideosBatchWorkflowState) {
  const stage = workflow.stages.FINAL_STORYBOARD;
  if (!stage?.artifact) return [];
  const batchId = canonicalStoryboardBatchId(stage.artifact, stage.revision, canonicalStoryboardSourceHash(stage.artifact));
  return batchId ? session.shots.filter(shot => shot.videosBatchBatchId === batchId) : [];
}

export function hasUnknownExecution(shots: Shot[]) {
  return shots.some(shot => !shot.generationTaskId && Boolean(shot.generationStartedAt)
    && !shot.renders?.some(render => render.status === "ready" && render.videosBatchBatchId === shot.videosBatchBatchId));
}
