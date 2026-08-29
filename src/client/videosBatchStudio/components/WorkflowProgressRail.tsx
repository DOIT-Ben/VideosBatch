import { AlertCircle, Check, Circle, LoaderCircle, RefreshCw, XCircle } from "lucide-react";
import type { VideosBatchProductStatus, VideosBatchProductStep, VideosBatchProductStepId } from "../stageModel";

function StatusIcon({ status }: { status: VideosBatchProductStatus }) {
  if (status === "ready") return <Check size={12} strokeWidth={2.5} />;
  if (status === "running") return <LoaderCircle size={12} className="spin" />;
  if (status === "confirm") return <AlertCircle size={12} />;
  if (status === "stale") return <RefreshCw size={12} />;
  if (status === "failed") return <XCircle size={12} />;
  return <Circle size={9} />;
}

export function WorkflowProgressRail({
  steps,
  selectedStepId,
  currentStepId,
  getStatus,
  onSelectStep
}: {
  steps: readonly VideosBatchProductStep[];
  selectedStepId: VideosBatchProductStepId;
  currentStepId: VideosBatchProductStepId;
  getStatus: (step: VideosBatchProductStep) => VideosBatchProductStatus;
  onSelectStep: (stepId: VideosBatchProductStepId) => void;
}) {
  return (
    <nav className="vbs-v2-progress-wrap" aria-label="课程视频制作进度">
      <div className="vbs-v2-progress">
        {steps.map((step, index) => {
          const status = getStatus(step);
          const selected = step.id === selectedStepId;
          const current = step.id === currentStepId;
          return (
            <button
              type="button"
              key={step.id}
              className={`vbs-v2-progress-step ${status} ${selected ? "selected" : ""} ${current ? "current" : ""}`}
              aria-current={current ? "step" : undefined}
              aria-pressed={selected}
              aria-label={`${String(index + 1).padStart(2, "0")} ${step.label}，${status}`}
              onClick={() => onSelectStep(step.id)}
            >
              <span className="vbs-v2-progress-node" aria-hidden="true"><StatusIcon status={status} /></span>
              <span className="vbs-v2-progress-copy">
                <span className="vbs-v2-progress-index">{String(index + 1).padStart(2, "0")}</span>
                <span className="vbs-v2-progress-label">{step.label}</span>
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
