import { useMemo, useState } from "react";
import { api } from "../api";
import {
  VIDEOS_BATCH_STAGE_ORDER,
  type VideosBatchStageId,
  type VideosBatchWorkflowState
} from "../../shared/videosBatchWorkflow";
import { WorkflowArtifactPanel } from "./WorkflowArtifactPanel";
import { WORKFLOW_LABELS, WORKFLOW_STATUS_LABELS } from "./workflowLabels";

function initialSelectedStage(workflow: VideosBatchWorkflowState): VideosBatchStageId {
  const currentIndex = VIDEOS_BATCH_STAGE_ORDER.indexOf(workflow.currentStage);
  for (let index = currentIndex; index >= 0; index -= 1) {
    const stageId = VIDEOS_BATCH_STAGE_ORDER[index];
    if (workflow.stages[stageId]?.artifact !== undefined) return stageId;
  }
  return "LESSON_INPUT";
}

export function WorkflowRail({
  sessionId,
  workflow,
  onWorkflowChange
}: {
  sessionId: string;
  workflow?: VideosBatchWorkflowState;
  onWorkflowChange: (workflow: VideosBatchWorkflowState) => void;
}) {
  const [selectedStageId, setSelectedStageId] = useState<VideosBatchStageId>(() =>
    workflow ? initialSelectedStage(workflow) : "LESSON_INPUT"
  );
  const [projectId, setProjectId] = useState("P001");
  const [lessonText, setLessonText] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const selectedStage = workflow?.stages[selectedStageId];
  const completedCount = useMemo(
    () => workflow
      ? VIDEOS_BATCH_STAGE_ORDER.filter((stageId) => workflow.stages[stageId]?.status === "ready").length
      : 0,
    [workflow]
  );

  async function perform(label: string, operation: () => Promise<VideosBatchWorkflowState>) {
    setBusy(label);
    setError("");
    try {
      const next = await operation();
      onWorkflowChange(next);
      return next;
    } catch (err) {
      setError(err instanceof Error ? err.message : "VideosBatch 操作失败");
      return undefined;
    } finally {
      setBusy("");
    }
  }

  if (!workflow) {
    return (
      <section className="videosbatch-workflow-shell videosbatch-workflow-start" aria-label="VideosBatch 工作流">
        <div className="videosbatch-workflow-heading">
          <div>
            <strong>VideosBatch</strong>
            <small>教案 → 课程导入 → 故事 → 资产 → 剧本 → 分镜 → 视频 → 拼接</small>
          </div>
        </div>
        <div className="videosbatch-start-fields">
          <input
            aria-label="项目ID"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            placeholder="P001"
          />
          <textarea
            aria-label="完整教案"
            value={lessonText}
            onChange={(event) => setLessonText(event.target.value)}
            placeholder="粘贴完整教案，启动固定链式工作流"
            rows={3}
          />
          <button
            type="button"
            className="primary"
            disabled={Boolean(busy) || !projectId.trim() || !lessonText.trim()}
            onClick={() => perform("start", () => api.startVideosBatch(sessionId, { projectId, lessonText }))}
          >
            启动 VideosBatch
          </button>
        </div>
        {error && <div className="videosbatch-workflow-error">{error}</div>}
      </section>
    );
  }

  const continueFrom = async (stageId: VideosBatchStageId) => {
    const restarted = await perform(`restart:${stageId}`, () => api.restartVideosBatchFrom(sessionId, stageId));
    if (!restarted) return;
    setSelectedStageId(stageId);
    await perform(`runall:${stageId}`, () => api.runAllVideosBatch(sessionId));
  };

  return (
    <section className="videosbatch-workflow-shell" aria-label="VideosBatch 工作流">
      <div className="videosbatch-workflow-heading">
        <div>
          <strong>VideosBatch</strong>
          <small>{workflow.completed ? "流程已完成" : `当前：${WORKFLOW_LABELS[workflow.currentStage]}`} · {completedCount}/{VIDEOS_BATCH_STAGE_ORDER.length}</small>
        </div>
        <div className="videosbatch-workflow-controls">
          <button
            type="button"
            disabled={Boolean(busy) || workflow.completed}
            onClick={() => perform("next", () => api.runNextVideosBatch(sessionId))}
          >
            下一步
          </button>
          <button
            type="button"
            className="primary"
            disabled={Boolean(busy) || workflow.completed}
            onClick={() => perform("all", () => api.runAllVideosBatch(sessionId))}
          >
            自动运行
          </button>
        </div>
      </div>

      <div className="videosbatch-stage-rail" role="list" aria-label="工作流阶段">
        {VIDEOS_BATCH_STAGE_ORDER.map((stageId, index) => {
          const stage = workflow.stages[stageId];
          const status = stage?.status || "pending";
          const isCurrent = workflow.currentStage === stageId && !workflow.completed;
          const hasArtifact = stage?.artifact !== undefined;
          return (
            <div
              key={stageId}
              className={`videosbatch-stage-card ${isCurrent ? "current" : ""} status-${status}`}
              data-current={isCurrent ? "true" : "false"}
              data-status={status}
              role="listitem"
            >
              <div className="videosbatch-stage-index">{String(index + 1).padStart(2, "0")}</div>
              <button
                type="button"
                className="videosbatch-stage-main"
                onClick={() => setSelectedStageId(stageId)}
              >
                <span>{WORKFLOW_LABELS[stageId]}</span>
                <small>{WORKFLOW_STATUS_LABELS[status]}</small>
              </button>
              <div className="videosbatch-stage-actions">
                <button type="button" onClick={() => setSelectedStageId(stageId)}>查看</button>
                {hasArtifact && (
                  <button
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() => perform(`restart:${stageId}`, () => api.restartVideosBatchFrom(sessionId, stageId))}
                  >
                    重新生成
                  </button>
                )}
                <button type="button" disabled={Boolean(busy)} onClick={() => continueFrom(stageId)}>
                  从这里继续
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {error && <div className="videosbatch-workflow-error">{error}</div>}

      <WorkflowArtifactPanel
        stageId={selectedStageId}
        stage={selectedStage}
        onSave={(artifact) => perform(
          `save:${selectedStageId}`,
          () => api.saveVideosBatchArtifact(sessionId, selectedStageId, artifact)
        ).then(() => undefined)}
      />
    </section>
  );
}
