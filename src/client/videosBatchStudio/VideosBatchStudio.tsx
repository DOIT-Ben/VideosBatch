import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { Asset, Session, Shot } from "../../shared/types";
import type { VideosBatchStageId, VideosBatchWorkflowState } from "../../shared/videosBatchWorkflow";
import { VideosBatchHeader } from "./VideosBatchHeader";
import { WorkflowSidebar } from "./WorkflowSidebar";
import { WorkflowFooter } from "./WorkflowFooter";
import { ArtifactDebugDrawer } from "./components/ArtifactDebugDrawer";
import { StageStatus } from "./components/StageStatus";
import { StageWorkspace } from "./stages/StageWorkspace";
import { buildAssetCandidateGroups, buildAssetConfirmationArtifact, updateStoryArtifactContent } from "./contentModel";
import {
  VIDEOS_BATCH_PRODUCT_STEPS,
  deriveCurrentProductStep,
  deriveProductStepStatus,
  productStepById,
  type VideosBatchProductStepId
} from "./stageModel";

function debugStageForStep(workflow: VideosBatchWorkflowState | undefined, stepId: VideosBatchProductStepId): VideosBatchStageId {
  const stages = [...productStepById(stepId).stages];
  if (!workflow) return stages[0];
  for (let index = stages.length - 1; index >= 0; index -= 1) {
    if (workflow.stages[stages[index]]?.artifact !== undefined) return stages[index];
  }
  return stages[0];
}

export function VideosBatchStudio({
  sessionId,
  sessionTitle,
  session,
  nativeAssets = [],
  nativeShots = [],
  workflow,
  onWorkflowChange,
  onOpenCanvas
}: {
  sessionId: string;
  sessionTitle: string;
  session?: Session;
  nativeAssets?: Asset[];
  nativeShots?: Shot[];
  workflow?: VideosBatchWorkflowState;
  onWorkflowChange: (workflow: VideosBatchWorkflowState) => void;
  onOpenCanvas: () => void;
}) {
  const currentStepId = workflow ? deriveCurrentProductStep(workflow) : "lesson";
  const [selectedStepId, setSelectedStepId] = useState<VideosBatchProductStepId>(currentStepId);
  const [selectedAssetIds, setSelectedAssetIds] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [debugOpen, setDebugOpen] = useState(false);

  useEffect(() => {
    if (!workflow) {
      setSelectedStepId("lesson");
      setSelectedAssetIds({});
      return;
    }
    if (workflow.stages[workflow.currentStage]?.status === "running") setSelectedStepId(deriveCurrentProductStep(workflow));
  }, [workflow?.currentStage, workflow?.completed]);

  const assetGroups = useMemo(() => buildAssetCandidateGroups(
    workflow?.stages.ASSET_PLAN?.artifact,
    workflow?.stages.ASSET_CANDIDATES?.artifact,
    workflow?.stages.ASSET_CONFIRMATION?.artifact,
    nativeAssets
  ), [
    workflow?.stages.ASSET_PLAN?.revision,
    workflow?.stages.ASSET_CANDIDATES?.revision,
    workflow?.stages.ASSET_CONFIRMATION?.revision,
    nativeAssets
  ]);

  useEffect(() => {
    setSelectedAssetIds((previous) => {
      const next: Record<string, string> = {};
      for (const group of assetGroups) {
        const previousSelection = previous[group.assetKey];
        if (previousSelection && group.candidateAssetIds.includes(previousSelection)) next[group.assetKey] = previousSelection;
        else if (group.selectedAssetId) next[group.assetKey] = group.selectedAssetId;
      }
      return next;
    });
  }, [assetGroups]);

  const selectedStep = productStepById(selectedStepId);
  const selectedStatus = workflow ? deriveProductStepStatus(workflow, selectedStep) : "pending";
  const currentStep = productStepById(currentStepId);
  const debugStageId = debugStageForStep(workflow, selectedStepId);
  const debugArtifact = workflow?.stages[debugStageId]?.artifact;
  const selectedIndex = VIDEOS_BATCH_PRODUCT_STEPS.findIndex((step) => step.id === selectedStepId);
  const isAtCurrentStep = selectedStepId === currentStepId;
  const manualGate = workflow?.currentStage === "COURSE_INTRO_SELECTION" || workflow?.currentStage === "ASSET_CONFIRMATION";

  const contextFacts = useMemo(() => {
    if (!workflow) return [{ label: "状态", value: "尚未启动" }, { label: "模式", value: "分步确认" }];
    return [
      { label: "当前步骤", value: currentStep.label },
      { label: "项目状态", value: workflow.completed ? "已完成" : selectedStatus === "confirm" ? "需要确认" : "制作中" },
      { label: "已完成步骤", value: `${VIDEOS_BATCH_PRODUCT_STEPS.filter((step) => deriveProductStepStatus(workflow, step) === "ready").length} / ${VIDEOS_BATCH_PRODUCT_STEPS.length}` }
    ];
  }, [workflow, currentStep.label, selectedStatus]);

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

  async function startWorkflow(lessonText: string) {
    const next = await perform("start", () => api.startVideosBatch(sessionId, { projectId: "P001", lessonText }));
    if (next) setSelectedStepId(deriveCurrentProductStep(next));
  }

  async function selectIntro(candidate: any) {
    if (!workflow) return;
    const next = await perform("select-intro", () => api.saveVideosBatchArtifact(sessionId, "COURSE_INTRO_SELECTION", {
      selectedIntroId: candidate.id,
      selectionMode: "user_selected",
      selectionReason: "用户在流程制作界面确认此课程导入方案。",
      locked: true,
      confirmedEntry: candidate
    }));
    if (next) setSelectedStepId(deriveCurrentProductStep(next));
  }

  async function saveStoryContent(content: string) {
    if (!workflow) return;
    const current = workflow.stages.STORY_SCRIPT?.artifact as Record<string, any> | undefined;
    if (!current) return;
    await perform("save-story", () => api.saveVideosBatchArtifact(
      sessionId,
      "STORY_SCRIPT",
      updateStoryArtifactContent(current, content)
    ));
  }

  async function confirmAssets() {
    if (!workflow) return;
    let artifact: ReturnType<typeof buildAssetConfirmationArtifact>;
    try {
      artifact = buildAssetConfirmationArtifact(assetGroups, selectedAssetIds);
    } catch (err) {
      setError(err instanceof Error ? err.message : "每个资产都需要选择一张候选图后才能确认。");
      return;
    }
    const next = await perform("confirm-assets", () => api.saveVideosBatchArtifact(sessionId, "ASSET_CONFIRMATION", artifact));
    if (next) setSelectedStepId(deriveCurrentProductStep(next));
  }

  async function runNext() {
    if (!workflow) return;
    const next = await perform("next", () => api.runNextVideosBatch(sessionId));
    if (next) setSelectedStepId(deriveCurrentProductStep(next));
  }

  async function runAll() {
    if (!workflow) return;
    const next = await perform("all", () => api.runAllVideosBatch(sessionId));
    if (next) setSelectedStepId(deriveCurrentProductStep(next));
  }

  async function restartSelected() {
    if (!workflow) return;
    const stageId = selectedStep.stages[0];
    const next = await perform("restart", () => api.restartVideosBatchFrom(sessionId, stageId));
    if (next) setSelectedStepId(selectedStepId);
  }

  const primaryLabel = !workflow
    ? "开始生成课程导入"
    : !isAtCurrentStep
      ? `回到 ${currentStep.label}`
      : workflow.completed
        ? "流程已完成"
        : manualGate
          ? "请完成当前确认"
          : "生成下一步 →";

  const primaryDisabled = !workflow || (isAtCurrentStep && (workflow.completed || manualGate));

  const primaryAction = () => {
    if (!workflow) return;
    if (!isAtCurrentStep) {
      setSelectedStepId(currentStepId);
      return;
    }
    void runNext();
  };

  const previous = () => {
    if (selectedIndex <= 0) return;
    setSelectedStepId(VIDEOS_BATCH_PRODUCT_STEPS[selectedIndex - 1].id);
  };

  return (
    <section className="videosbatch-studio" aria-label="VideosBatch 流程制作">
      <VideosBatchHeader sessionTitle={sessionTitle} stepLabel={selectedStep.label} status={selectedStatus} onOpenCanvas={onOpenCanvas} />
      <div className="videosbatch-studio-body">
        <WorkflowSidebar workflow={workflow} selectedStepId={selectedStepId} onSelectStep={setSelectedStepId} />
        <main className="vbs-workspace">
          {error && <div className="vbs-inline-error">{error}</div>}
          <StageWorkspace
            sessionTitle={sessionTitle}
            session={session}
            nativeAssets={nativeAssets}
            nativeShots={nativeShots}
            selectedAssetIds={selectedAssetIds}
            workflow={workflow}
            stepId={selectedStepId}
            busy={Boolean(busy)}
            onStart={startWorkflow}
            onSelectIntro={selectIntro}
            onSaveStory={saveStoryContent}
            onSelectAsset={(assetKey, assetId) => setSelectedAssetIds((current) => ({ ...current, [assetKey]: assetId }))}
            onConfirmAssets={confirmAssets}
            onOpenCanvas={onOpenCanvas}
          />
          <WorkflowFooter
            selectedStepId={selectedStepId}
            busy={Boolean(busy)}
            primaryLabel={primaryLabel}
            primaryDisabled={primaryDisabled}
            onPrevious={previous}
            onPrimary={primaryAction}
          />
        </main>
        <aside className="vbs-context" aria-label="当前步骤信息">
          <div className="vbs-context-heading"><small>当前步骤</small><strong>{selectedStep.label}</strong><StageStatus status={selectedStatus} /></div>
          <div className="vbs-context-facts">
            {contextFacts.map((fact) => <div key={fact.label}><span>{fact.label}</span><strong>{fact.value}</strong></div>)}
          </div>
          {workflow && (
            <div className="vbs-context-actions">
              <button type="button" className="vbs-primary" disabled={Boolean(busy) || workflow.completed} onClick={() => void runAll()}>自动运行到确认点</button>
              <button type="button" className="vbs-secondary" disabled={Boolean(busy)} onClick={() => void restartSelected()}>重新生成本步骤</button>
              <button type="button" className="vbs-link-button" disabled={debugArtifact === undefined} onClick={() => setDebugOpen(true)}>查看原始数据</button>
            </div>
          )}
        </aside>
      </div>
      <ArtifactDebugDrawer
        open={debugOpen}
        title={selectedStep.label}
        artifact={debugArtifact}
        onClose={() => setDebugOpen(false)}
        onSave={workflow ? async (artifact) => {
          const next = await perform("save-debug", () => api.saveVideosBatchArtifact(sessionId, debugStageId, artifact));
          if (next) setDebugOpen(false);
        } : undefined}
      />
    </section>
  );
}
