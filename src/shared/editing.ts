import type { VideosBatchStageId, VideosBatchWorkflowState } from "./videosBatchWorkflow";
export interface EditResponse {
  workflow: VideosBatchWorkflowState; operationId: string; savedRevision: number; savedArtifact: unknown;
  continuation: { status: "none" | "queued" | "pending" | "blocked"; runId?: string; reason?: string };
}
export interface ServerDraft {
  id: string; sessionId: string; ownerId: string; stageId: VideosBatchStageId; instanceId: string;
  clientVersion: number; baseRevision: number; baseSignature: string; value: unknown;
  leaseUntil: number; active: boolean; updatedAt: string;
}
export interface EditRequest {
  requestId: string; stageId: VideosBatchStageId; expectedRevision: number; artifact: unknown;
  draftId?: string; instanceId?: string; clientVersion?: number; continue: boolean;
}
export interface EditOperation {
  id: string; sessionId: string; ownerId: string; requestHash: string; request: EditRequest;
  state: "prepared" | "ready" | "queued" | "conflict"; resultHash: string; expectedVersion: string;
  savedRevision: number; resultVersion?: string; publishedHash?: string; runId?: string; error?: string;
}
