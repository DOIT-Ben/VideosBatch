import type { Asset, Session, Shot } from "../../shared/types";
import type { VideosBatchStageId, VideosBatchWorkflowState } from "../../shared/videosBatchWorkflow";
import type { CinemaStore } from "../store";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  /** Optional stable machine code for a failed contract gate. */
  code?: string;
  /** Whether the caller may retry after preserving the failed artifact. */
  retryable?: boolean;
}

export interface StageExecutionContext {
  session: Session;
  workflow: VideosBatchWorkflowState;
  assets: Asset[];
  shots: Shot[];
  /** Present on the real API execution path; omitted by pure runner tests. */
  store?: CinemaStore;
  /** Durable stage boundary; failures must stop execution before external side effects. */
  checkpoint?: (workflow: VideosBatchWorkflowState) => Promise<void>;
  /** Persist a returned result before validation/native projection can fail. */
  resultCheckpoint?: (result: StageResult) => Promise<void>;
  /** Optional bounded work scheduler; absent in pure runner callers. */
  scheduleWork?: <T>(provider: string, operation: () => Promise<T>) => Promise<T>;
  workConcurrency?: number;
  shouldStopWork?: () => boolean;
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
