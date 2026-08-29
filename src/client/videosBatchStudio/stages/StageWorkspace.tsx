import type { Asset, Session, Shot } from "../../../shared/types";
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
  session,
  nativeAssets = [],
  nativeShots = [],
  selectedAssetIds = {},
  workflow,
  stepId,
  busy,
  onStart,
  onSelectIntro,
  onSaveStory,
  onSaveScreenplay,
  onSaveStoryboard,
  onSelectAsset,
  onConfirmAssets,
  onOpenCanvas
}: {
  sessionTitle: string;
  session?: Session;
  nativeAssets?: Asset[];
  nativeShots?: Shot[];
  selectedAssetIds?: Record<string, string>;
  workflow?: VideosBatchWorkflowState;
  stepId: VideosBatchProductStepId;
  busy?: boolean;
  onStart: (lessonText: string) => Promise<void> | void;
  onSelectIntro: (candidate: any) => Promise<void> | void;
  onSaveStory?: (content: string) => Promise<void> | void;
  onSaveScreenplay?: (artifact: any) => Promise<void> | void;
  onSaveStoryboard?: (artifact: any) => Promise<void> | void;
  onSelectAsset?: (assetKey: string, assetId: string) => Promise<void> | void;
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
      return <StoryStage artifact={stage("STORY_SCRIPT")} busy={busy} onSaveContent={onSaveStory} />;
    case "asset-plan":
      return <AssetPlanStage artifact={stage("ASSET_PLAN")} />;
    case "assets":
      return (
        <AssetGalleryStage
          planArtifact={stage("ASSET_PLAN")}
          candidatesArtifact={stage("ASSET_CANDIDATES")}
          confirmationArtifact={stage("ASSET_CONFIRMATION")}
          nativeAssets={nativeAssets}
          selectedAssetIds={selectedAssetIds}
          onSelectAsset={onSelectAsset}
          busy={busy}
          onConfirmAll={onConfirmAssets}
        />
      );
    case "screenplay":
      return <ScreenplayStage artifact={stage("SCREENPLAY")} busy={busy} onSaveArtifact={onSaveScreenplay} />;
    case "storyboard":
      return (
        <StoryboardStage
          artifact={stage("FINAL_STORYBOARD")}
          copyablePromptArtifact={stage("COPYABLE_PROMPT")}
          copyablePromptStatus={workflow?.stages.COPYABLE_PROMPT?.status}
          busy={busy}
          onSaveArtifact={onSaveStoryboard}
        />
      );
    case "execution":
      return <ExecutionStage quoteArtifact={stage("QUOTE")} executionArtifact={stage("EXECUTION")} shots={nativeShots} onOpenCanvas={onOpenCanvas} />;
    case "final":
      return <FinalVideoStage artifact={stage("STITCH")} session={session} onOpenCanvas={onOpenCanvas} />;
    default:
      return null;
  }
}
