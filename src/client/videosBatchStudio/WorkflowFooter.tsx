import type { VideosBatchProductStepId } from "./stageModel";
import { VIDEOS_BATCH_PRODUCT_STEPS } from "./stageModel";

export function WorkflowFooter({
  selectedStepId,
  busy,
  primaryLabel,
  primaryDisabled,
  onPrevious,
  onPrimary
}: {
  selectedStepId: VideosBatchProductStepId;
  busy?: boolean;
  primaryLabel: string;
  primaryDisabled?: boolean;
  onPrevious: () => void;
  onPrimary: () => void;
}) {
  const index = VIDEOS_BATCH_PRODUCT_STEPS.findIndex((step) => step.id === selectedStepId);
  return (
    <footer className="vbs-footer">
      <button type="button" className="vbs-secondary" disabled={busy || index <= 0} onClick={onPrevious}>
        ← 上一步
      </button>
      <div className="vbs-footer-spacer" />
      <button type="button" className="vbs-primary" disabled={busy || primaryDisabled} onClick={onPrimary}>
        {busy ? "处理中…" : primaryLabel}
      </button>
    </footer>
  );
}
