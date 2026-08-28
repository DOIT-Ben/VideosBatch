import type { VideosBatchProductStatus } from "../stageModel";

const STATUS_LABELS: Record<VideosBatchProductStatus, string> = {
  pending: "未开始",
  running: "生成中",
  ready: "已完成",
  confirm: "需要确认",
  stale: "需要更新",
  failed: "失败"
};

const STATUS_SYMBOLS: Record<VideosBatchProductStatus, string> = {
  pending: "○",
  running: "●",
  ready: "✓",
  confirm: "!",
  stale: "↻",
  failed: "×"
};

export function StageStatus({ status, compact = false }: { status: VideosBatchProductStatus; compact?: boolean }) {
  return (
    <span className={`vbs-stage-status status-${status}`} data-status={status}>
      <span aria-hidden="true">{STATUS_SYMBOLS[status]}</span>
      {!compact && <span>{STATUS_LABELS[status]}</span>}
    </span>
  );
}
