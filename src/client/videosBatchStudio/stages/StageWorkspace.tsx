import type { VideosBatchStageId, VideosBatchWorkflowState } from "../../../shared/videosBatchWorkflow";
import type { VideosBatchProductStepId } from "../stageModel";
import { LessonStage } from "./LessonStage";
import { IntroCandidatesStage } from "./IntroCandidatesStage";
import { StoryStage } from "./StoryStage";
import { AssetPlanStage } from "./AssetPlanStage";
import { AssetGalleryStage } from "./AssetGalleryStage";
import { ScreenplayStage } from "./ScreenplayStage";
import { StoryboardStage } from "./StoryboardStage";
import { ExecutionStage } from "./ExecutionStage";
import { FinalVideoStage } from "./FinalVideoStage";

export function StageWorkspace({
  sessionTitle,
  workflow,
  stepId,
  busy,
  onStart,
  onSelectIntro,
  onConfirmAssets,
  onOpenCanvas
}: {
  sessionTitle: string;
  workflow?: VideosBatchWorkflowState;
  stepId: VideosBatchProductStepId;
  busy?: boolean;
  onStart: (lessonText: string) => Promise<void> | void;
  onSelectIntro: (candidate: any) => Promise<void> | void;
  onConfirmAssets: () => Promise<void> | void;
  onOpenCanvas: () => void;
}) {
  const stage = (id: VideosBatchStageId) => workflow?.stages[id]?.artifact as any;
  switch (stepId) {
    case "lesson":
      return <LessonStage sessionTitle={sessionTitle} lessonText={stage("LESSON_INPUT")?.lessonText} busy={busy} started={Boolean(workflow)} onStart={onStart} />;
    case "intro":
      return <IntroCandidatesStage artifact={stage("COURSE_INTRO_CANDIDATES")} selectedIntroId={workflow?.selectedIntroId} busy={busy} onSelect={onSelectIntro} />;
    case "story":
      return <StoryStage artifact={stage("STORY_SCRIPT")} />;
    case "asset-plan":
      return <AssetPlanStage artifact={stage("ASSET_PLAN")} />;
    case "assets":
      return <AssetGalleryStage planArtifact={stage("ASSET_PLAN")} candidatesArtifact={stage("ASSET_CANDIDATES")} confirmationArtifact={stage("ASSET_CONFIRMATION")} busy={busy} onConfirmAll={onConfirmAssets} />;
    case "screenplay":
      return <ScreenplayStage artifact={stage("SCREENPLAY")} />;
    case "storyboard":
      return <StoryboardStage artifact={stage("FINAL_STORYBOARD")} />;
    case "execution":
      return <ExecutionStage quoteArtifact={stage("QUOTE")} executionArtifact={stage("EXECUTION")} onOpenCanvas={onOpenCanvas} />;
    case "final":
      return <FinalVideoStage artifact={stage("STITCH")} onOpenCanvas={onOpenCanvas} />;
    default:
      return null;
  }
}
