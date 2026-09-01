import type { Asset, Session, Shot } from "../../shared/types";
import type { VideosBatchStageId, VideosBatchWorkflowState } from "../../shared/videosBatchWorkflow";
import type { CinemaStore } from "../store";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export interface StageExecutionContext {
  session: Session;
  workflow: VideosBatchWorkflowState;
  assets: Asset[];
  shots: Shot[];
  /** Present on the real API execution path; omitted by pure runner tests. */
  store?: CinemaStore;
}

export interface StageResult<T = unknown> {
  artifact: T;
  /** Optional execution evidence persisted by the runner with the artifact. */
  attempts?: number;
  provider?: string | null;
  model?: string | null;
  attemptLog?: Array<{
    attempt: number;
    provider: string;
    model: string;
    outcome: "success" | "error";
    errorCode?: string;
    status?: number;
    durationMs?: number;
  }>;
}

export interface StageDefinition<T = unknown> {
  id: VideosBatchStageId;
  execute(ctx: StageExecutionContext): Promise<StageResult<T>>;
  validate(artifact: T, ctx: StageExecutionContext): ValidationResult;
  project?(artifact: T, ctx: StageExecutionContext): Promise<void>;
}

export type StageRegistry = Partial<Record<VideosBatchStageId, StageDefinition<any>>>;
