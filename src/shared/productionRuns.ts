export type RunStatus = "queued" | "running" | "waiting_input" | "pause_requested" | "paused" | "cancel_requested" | "cancelled" | "reconciling" | "failed" | "succeeded";
export type RunMode = "next" | "all";
export interface ProductionRun {
  id: string;
  ownerId: string;
  sessionId: string;
  mode: RunMode;
  status: RunStatus;
  stageId: string;
  inputVersion: string;
  createdAt: string;
  updatedAt: string;
  priority: number;
  completedItems: number;
  selectedShotIds?: string[];
  message?: string;
  controlIntent?: "pause" | "stop";
  feedback?: { kind: "working" | "validating" | "saving" | "saved" | "preview"; itemId: string; completedWork: number; outputRevision?: number; previewRef?: string };
}
export interface RunEvent { sequence: number; run: ProductionRun }
export interface RunCursor { scope: string; offsets: Record<string, number> }
export type RunPacket = { kind: "snapshot"; cursor: RunCursor; runs: ProductionRun[] }
  | { kind: "delta"; previous: RunCursor; cursor: RunCursor; events: RunEvent[] };
export const terminalRun = (status: RunStatus) => ["succeeded", "failed", "cancelled"].includes(status);
export const runStatusLabel: Record<RunStatus, string> = {
  queued: "等待执行", running: "执行中", waiting_input: "待确认", pause_requested: "正在暂停",
  paused: "已暂停", cancel_requested: "正在停止", cancelled: "已停止", reconciling: "正在核对",
  failed: "失败", succeeded: "完成"
};
