export type BatchAction = "start" | "pause" | "resume" | "stop" | "retry" | "priority";
export interface BatchItem { sessionId: string; runId?: string; expectedVersion: string; eligible: boolean; reason?: string }
export interface BatchResult { sessionId: string; ok: boolean; reason: string; runId?: string }
