import type { VideosBatchWorkflowState } from "../../shared/videosBatchWorkflow";
import {
  VIDEOS_BATCH_PRODUCT_STEPS,
  deriveCurrentProductStep,
  deriveProductStepStatus,
  type VideosBatchProductStepId
} from "./stageModel";
import { StageStatus } from "./components/StageStatus";

export function WorkflowSidebar({
  workflow,
  selectedStepId,
  onSelectStep
}: {
  workflow?: VideosBatchWorkflowState;
  selectedStepId: VideosBatchProductStepId;
  onSelectStep: (stepId: VideosBatchProductStepId) => void;
}) {
  const currentStepId = workflow ? deriveCurrentProductStep(workflow) : "lesson";

  return (
    <nav className="vbs-sidebar" aria-label="课程视频制作流程">
      <div className="vbs-sidebar-heading">
        <span>制作流程</span>
        <small>{workflow?.completed ? "已完成" : "分步确认"}</small>
      </div>
      <div className="vbs-step-list">
        {VIDEOS_BATCH_PRODUCT_STEPS.map((step, index) => {
          const status = workflow ? deriveProductStepStatus(workflow, step) : "pending";
          const isSelected = selectedStepId === step.id;
          const isCurrent = currentStepId === step.id;
          return (
            <button
              key={step.id}
              type="button"
              className={`vbs-step ${isSelected ? "selected" : ""} ${isCurrent ? "current" : ""}`}
              data-step-id={step.id}
              data-status={status}
              aria-current={isCurrent ? "step" : undefined}
              onClick={() => onSelectStep(step.id)}
            >
              <span className="vbs-step-number">{String(index + 1).padStart(2, "0")}</span>
              <span className="vbs-step-copy">
                <strong>{step.label}</strong>
                <StageStatus status={status} />
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
