import type {
  VideosBatchStageId,
  VideosBatchStageStatus,
  VideosBatchWorkflowState
} from "../../shared/videosBatchWorkflow";

export type VideosBatchProductStepId =
  | "lesson"
  | "intro"
  | "story"
  | "asset-plan"
  | "assets"
  | "screenplay"
  | "storyboard"
  | "execution"
  | "final";

export type VideosBatchProductStatus =
  | "pending"
  | "running"
  | "ready"
  | "confirm"
  | "stale"
  | "failed";

export type VideosBatchProductStep = {
  id: VideosBatchProductStepId;
  label: string;
  stages: readonly VideosBatchStageId[];
};

export const VIDEOS_BATCH_PRODUCT_STEPS: readonly VideosBatchProductStep[] = [
  { id: "lesson", label: "教案", stages: ["LESSON_INPUT"] },
  { id: "intro", label: "课程导入", stages: ["COURSE_INTRO_CANDIDATES", "COURSE_INTRO_SELECTION"] },
  { id: "story", label: "故事文稿", stages: ["STORY_SCRIPT"] },
  { id: "asset-plan", label: "资产计划", stages: ["ASSET_PLAN"] },
  { id: "assets", label: "资产图片", stages: ["ASSET_CANDIDATES", "ASSET_CONFIRMATION"] },
  { id: "screenplay", label: "视频剧本", stages: ["SCREENPLAY"] },
  { id: "storyboard", label: "视频分镜", stages: ["FINAL_STORYBOARD", "COPYABLE_PROMPT"] },
  { id: "execution", label: "视频生成", stages: ["QUOTE", "EXECUTION"] },
  { id: "final", label: "最终成片", stages: ["STITCH"] }
] as const;

const STEP_BY_STAGE = new Map<VideosBatchStageId, VideosBatchProductStepId>(
  VIDEOS_BATCH_PRODUCT_STEPS.flatMap((step) => step.stages.map((stageId) => [stageId, step.id] as const))
);

export function productStepForStage(stageId: VideosBatchStageId): VideosBatchProductStepId {
  const stepId = STEP_BY_STAGE.get(stageId);
  if (!stepId) throw new Error(`No product step configured for VideosBatch stage ${stageId}`);
  return stepId;
}

function stageStatuses(workflow: VideosBatchWorkflowState, step: VideosBatchProductStep): VideosBatchStageStatus[] {
  return step.stages.map((stageId) => workflow.stages[stageId]?.status || "pending");
}

function introNeedsConfirmation(workflow: VideosBatchWorkflowState) {
  return workflow.currentStage === "COURSE_INTRO_SELECTION" &&
    !(workflow.introLocked && workflow.selectedIntroId && workflow.selectionMode);
}

function assetsNeedConfirmation(workflow: VideosBatchWorkflowState) {
  if (workflow.currentStage !== "ASSET_CONFIRMATION") return false;
  const artifact = workflow.stages.ASSET_CONFIRMATION?.artifact as any;
  if (artifact?.confirmed !== true) return true;
  const planItems = Array.isArray((workflow.stages.ASSET_PLAN?.artifact as any)?.items)
    ? (workflow.stages.ASSET_PLAN?.artifact as any).items
    : [];
  const confirmedItems = Array.isArray(artifact?.items) ? artifact.items : [];
  if (!planItems.length || confirmedItems.length !== planItems.length) return true;
  const byKey = new Map(confirmedItems.map((item: any) => [String(item?.assetKey || ""), item]));
  return !planItems.every((item: any) => {
    const confirmed = byKey.get(String(item?.assetKey || "")) as any;
    return Boolean(confirmed?.publicAssetId && confirmed?.selectedAssetId);
  });
}

export function deriveProductStepStatus(
  workflow: VideosBatchWorkflowState,
  step: VideosBatchProductStep
): VideosBatchProductStatus {
  const statuses = stageStatuses(workflow, step);
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("running")) return "running";
  if (statuses.includes("stale")) return "stale";
  if (step.id === "intro" && introNeedsConfirmation(workflow)) return "confirm";
  if (step.id === "assets" && assetsNeedConfirmation(workflow)) return "confirm";
  if (statuses.every((status) => status === "ready")) return "ready";
  return "pending";
}

export function deriveCurrentProductStep(workflow: VideosBatchWorkflowState): VideosBatchProductStepId {
  if (workflow.completed) return "final";
  return productStepForStage(workflow.currentStage);
}

export function productStepById(stepId: VideosBatchProductStepId): VideosBatchProductStep {
  const step = VIDEOS_BATCH_PRODUCT_STEPS.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error(`Unknown VideosBatch product step ${stepId}`);
  return step;
}
