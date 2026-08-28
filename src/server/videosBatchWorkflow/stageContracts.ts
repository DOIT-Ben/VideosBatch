import type { Asset, Session, Shot } from "../../shared/types";
import type { VideosBatchStageId, VideosBatchWorkflowState } from "../../shared/videosBatchWorkflow";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export interface StageExecutionContext {
  session: Session;
  workflow: VideosBatchWorkflowState;
  assets: Asset[];
  shots: Shot[];
}

export interface StageResult<T = unknown> {
  artifact: T;
}

export interface StageDefinition<T = unknown> {
  id: VideosBatchStageId;
  execute(ctx: StageExecutionContext): Promise<StageResult<T>>;
  validate(artifact: T, ctx: StageExecutionContext): ValidationResult;
  project?(artifact: T, ctx: StageExecutionContext): Promise<void>;
}

export type StageRegistry = Partial<Record<VideosBatchStageId, StageDefinition<any>>>;
