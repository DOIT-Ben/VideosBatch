import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { Asset, Session, Shot, VideosBatchRuntimeSummary } from "../../shared/types";
import type {
  VideosBatchLessonSource,
  VideosBatchStageId,
  VideosBatchWorkflowState
} from "../../shared/videosBatchWorkflow";
import { VideosBatchHeader, type VideosBatchSessionOption } from "./VideosBatchHeader";
import { WorkflowFooter } from "./WorkflowFooter";
import { ArtifactDebugDrawer } from "./components/ArtifactDebugDrawer";
import { ModeBanner } from "./components/ModeBanner";
import { WorkflowProgressRail } from "./components/WorkflowProgressRail";
import { StageWorkspace } from "./stages/StageWorkspace";
import type { VideosBatchLessonDraft } from "./stages/LessonStage";
import { buildAssetCandidateGroups, buildAssetConfirmationArtifact, updateStoryArtifactContent } from "./contentModel";
import { parseLessonDocumentFile } from "./lessonDocumentClient";
import {
  VIDEOS_BATCH_PRODUCT_STEPS,
  deriveCurrentProductStep,
  deriveProductStepStatus,
  productStepById,
  type VideosBatchProductStepId
} from "./stageModel";

function retryableStageForStep(workflow: VideosBatchWorkflowState, step: ReturnType<typeof productStepById>) {
  return step.stages.find((stageId) => {
    const stage = workflow.stages[stageId];
    return stage?.status === "failed" && stage.errorInfo?.retryable !== false;
  });
}

type StartVideosBatchWithSource = (
  sessionId: string,
  payload: { projectId: string; lessonText: string; source?: VideosBatchLessonSource }
) => Promise<VideosBatchWorkflowState>;

const startVideosBatchWithSource = api.startVideosBatch as StartVideosBatchWithSource;

function debugStageForStep(workflow: VideosBatchWorkflowState | undefined, stepId: VideosBatchProductStepId): VideosBatchStageId {
  const stages = [...productStepById(stepId).stages];
  if (!workflow) return stages[0];
  for (let index = stages.length - 1; index >= 0; index -= 1) {
    if (workflow.stages[stages[index]]?.artifact !== undefined) return stages[index];
  }
  return stages[0];
}

function lessonDraftStorageKey(sessionId: string) {
  return `videosbatch:lesson-draft:${sessionId}`;
}

function readLessonDraft(sessionId: string): VideosBatchLessonDraft | undefined {
  if (typeof window === "undefined" || !sessionId) return undefined;
  try {
    const raw = window.sessionStorage.getItem(lessonDraftStorageKey(sessionId));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as VideosBatchLessonDraft;
    if (!parsed?.document?.text || typeof parsed.draftText !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function writeLessonDraft(sessionId: string, draft: VideosBatchLessonDraft | undefined) {
  if (typeof window === "undefined" || !sessionId) return;
  try {
    const key = lessonDraftStorageKey(sessionId);
    if (draft) window.sessionStorage.setItem(key, JSON.stringify(draft));
    else window.sessionStorage.removeItem(key);
  } catch {
    // Private browsing or a blocked storage policy should not prevent editing the lesson.
  }
}

export function VideosBatchStudio({
  sessionId,
  sessionTitle,
  session,
  nativeAssets = [],
  nativeShots = [],
  workflow,
  runtime,
  onWorkflowChange,
  onOpenCanvas,
  sessions = [],
  language = "zh",
  onBackToSessions,
  onSelectSession,
  onNewSession,
  onDownloadSession,
  onToggleUsage,
  onToggleLanguage
}: {
  sessionId: string;
  sessionTitle: string;
  session?: Session;
  nativeAssets?: Asset[];
  nativeShots?: Shot[];
  workflow?: VideosBatchWorkflowState;
  /** Resolved fake/native switches, so the studio can say when nothing is really generated. */
  runtime?: VideosBatchRuntimeSummary;
  onWorkflowChange: (workflow: VideosBatchWorkflowState) => void;
  onOpenCanvas: () => void;
  /** The studio hides SeeReel's sidebar, so it carries its own session list. */
  sessions?: VideosBatchSessionOption[];
  language?: "zh" | "en";
  onBackToSessions?: () => void;
  onSelectSession?: (sessionId: string) => void;
  onNewSession?: () => void;
  /** The studio hides SeeReel's topbar, so its actions are surfaced through the header instead. */
  onDownloadSession?: () => void;
  onToggleUsage?: () => void;
  onToggleLanguage?: () => void;
}) {
  const currentStepId = workflow ? deriveCurrentProductStep(workflow) : "lesson";
  const [selectedStepId, setSelectedStepId] = useState<VideosBatchProductStepId>(currentStepId);
  const [selectedAssetIds, setSelectedAssetIds] = useState<Record<string, string>>({});
  const [parsedLessonDraft, setParsedLessonDraft] = useState<VideosBatchLessonDraft | undefined>(() => readLessonDraft(sessionId));
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

  useEffect(() => {
    setParsedLessonDraft(readLessonDraft(sessionId));
  }, [sessionId]);

  const handleParsedLessonDraftChange = useCallback((draft: VideosBatchLessonDraft | undefined) => {
    setParsedLessonDraft(draft);
    writeLessonDraft(sessionId, draft);
  }, [sessionId]);

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
      const previousKeys = Object.keys(previous);
      const nextKeys = Object.keys(next);
      if (previousKeys.length === nextKeys.length && nextKeys.every((key) => previous[key] === next[key])) return previous;
      return next;
    });
  }, [assetGroups]);

  const selectedStep = productStepById(selectedStepId);
  const currentStep = productStepById(currentStepId);
  const debugStageId = debugStageForStep(workflow, selectedStepId);
  const debugArtifact = workflow?.stages[debugStageId]?.artifact;
  const retryStageId = workflow ? retryableStageForStep(workflow, selectedStep) : undefined;
  const selectedIndex = VIDEOS_BATCH_PRODUCT_STEPS.findIndex((step) => step.id === selectedStepId);
  const isAtCurrentStep = selectedStepId === currentStepId;
  const manualGate = workflow?.currentStage === "COURSE_INTRO_SELECTION" || workflow?.currentStage === "ASSET_CONFIRMATION";
  const completedCount = workflow
    ? VIDEOS_BATCH_PRODUCT_STEPS.filter((step) => deriveProductStepStatus(workflow, step) === "ready").length
    : 0;

  const statusForStep = (step: (typeof VIDEOS_BATCH_PRODUCT_STEPS)[number]) =>
    workflow ? deriveProductStepStatus(workflow, step) : "pending" as const;

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

  async function startWorkflow(lessonText: string, source?: VideosBatchLessonSource) {
    const next = await perform("start", () => startVideosBatchWithSource(sessionId, { projectId: "P001", lessonText, source }));
    if (next) {
      writeLessonDraft(sessionId, undefined);
      setParsedLessonDraft(undefined);
      setSelectedStepId(deriveCurrentProductStep(next));
    }
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

  async function saveStructuredArtifact(stageId: "SCREENPLAY" | "FINAL_STORYBOARD", artifact: any) {
    if (!workflow) return;
    await perform(stageId === "SCREENPLAY" ? "save-screenplay" : "save-storyboard", () =>
      api.saveVideosBatchArtifact(sessionId, stageId, artifact)
    );
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

  async function retrySelected() {
    if (!workflow || !retryStageId) return;
    const stage = workflow.stages[retryStageId];
    const sourceRevision = Number(stage?.sourceRevision);
    const sourceHash = String(stage?.sourceHash || "").trim();
    if (!Number.isFinite(sourceRevision) || sourceRevision <= 0 || !sourceHash) {
      setError("当前步骤还没有可重试的版本。");
      return;
    }
    const next = await perform("retry", () => api.retryVideosBatchStage(sessionId, retryStageId, {
      sourceRevision,
      sourceHash,
      ...(stage?.sourceHashes ? { sourceHashes: stage.sourceHashes } : {})
    }));
    if (next) setSelectedStepId(deriveCurrentProductStep(next));
  }

  const primaryLabel = !workflow
    ? "请先确认教案"
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
    <section className="videosbatch-studio videosbatch-studio-v2" aria-label="VideosBatch 流程制作">
      <VideosBatchHeader
        sessionTitle={sessionTitle}
        completedCount={completedCount}
        totalSteps={VIDEOS_BATCH_PRODUCT_STEPS.length}
        headline={!workflow ? "从一份教案，开始制作课程视频" : undefined}
        activeMode="workflow"
        sessions={sessions}
        sessionId={sessionId}
        language={language}
        onOpenCanvas={onOpenCanvas}
        onBackToSessions={onBackToSessions}
        onSelectSession={onSelectSession}
        onNewSession={onNewSession}
        onDownloadSession={onDownloadSession}
        onToggleUsage={onToggleUsage}
        onToggleLanguage={onToggleLanguage}
      />
      <ModeBanner runtime={runtime} />
      <WorkflowProgressRail
        steps={VIDEOS_BATCH_PRODUCT_STEPS}
        selectedStepId={selectedStepId}
        currentStepId={currentStepId}
        getStatus={statusForStep}
        onSelectStep={setSelectedStepId}
      />
      <main className="vbs-v2-workspace">
        {error && <div className="vbs-inline-error">{error}</div>}
        <div className="vbs-v2-stage-frame">
          <StageWorkspace
            sessionTitle={sessionTitle}
            session={session}
            nativeAssets={nativeAssets}
            nativeShots={nativeShots}
            selectedAssetIds={selectedAssetIds}
            workflow={workflow}
            stepId={selectedStepId}
            busy={Boolean(busy)}
            onParseLessonFile={(file) => parseLessonDocumentFile(sessionId, file)}
            parsedLessonDraft={parsedLessonDraft}
            onParsedLessonDraftChange={handleParsedLessonDraftChange}
            onSaveParsedLessonDraft={handleParsedLessonDraftChange}
            onStart={startWorkflow}
            onSelectIntro={selectIntro}
            onSaveStory={saveStoryContent}
            onSaveScreenplay={(artifact) => saveStructuredArtifact("SCREENPLAY", artifact)}
            onSaveStoryboard={(artifact) => saveStructuredArtifact("FINAL_STORYBOARD", artifact)}
            onSelectAsset={(assetKey, assetId) => setSelectedAssetIds((current) => ({ ...current, [assetKey]: assetId }))}
            onConfirmAssets={confirmAssets}
            onOpenCanvas={onOpenCanvas}
          />
        </div>
        <WorkflowFooter
          selectedStepId={selectedStepId}
          busy={Boolean(busy)}
          completed={Boolean(workflow?.completed)}
          canRetry={Boolean(retryStageId)}
          canDebug={debugArtifact !== undefined}
          primaryLabel={primaryLabel}
          primaryDisabled={primaryDisabled}
          onPrevious={previous}
          onPrimary={primaryAction}
          onRunAll={workflow ? () => void runAll() : undefined}
          onRestart={workflow ? () => void restartSelected() : undefined}
          onRetry={workflow ? () => void retrySelected() : undefined}
          onDebug={workflow ? () => setDebugOpen(true) : undefined}
        />
      </main>

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
