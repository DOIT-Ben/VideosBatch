export const VIDEOS_BATCH_STAGE_ORDER = [
  "LESSON_INPUT",
  "INTRO_GENERATION",
  "STORY_EXPANSION",
  "STORY_SELECTION",
  "ASSET_PROMPT_GENERATION",
  "ASSET_GENERATION",
  "SCREENPLAY_GENERATION",
  "STORYBOARD_GENERATION",
  "REFERENCE_BINDING",
  "VIDEO_GENERATION",
  "STITCH"
] as const;

export type VideosBatchStageId = (typeof VIDEOS_BATCH_STAGE_ORDER)[number];

export type VideosBatchStageStatus =
  | "pending"
  | "running"
  | "ready"
  | "failed"
  | "stale";

export interface VideosBatchLessonInputArtifact {
  projectId: string;
  lessonText: string;
}

export interface VideosBatchStageState<T = unknown> {
  status: VideosBatchStageStatus;
  revision: number;
  artifact?: T;
  error?: string;
  updatedAt?: string;
}

export interface VideosBatchWorkflowState {
  version: 1;
  currentStage: VideosBatchStageId;
  selectedStoryId?: string;
  stages: Partial<Record<VideosBatchStageId, VideosBatchStageState<any>>>;
  updatedAt: string;
}

export interface CreateVideosBatchWorkflowInput {
  projectId: string;
  lessonText: string;
}

export function createVideosBatchWorkflow(
  input: CreateVideosBatchWorkflowInput,
  now = new Date().toISOString()
): VideosBatchWorkflowState {
  const projectId = input.projectId.trim();
  const lessonText = input.lessonText.trim();

  if (!projectId) throw new Error("projectId is required");
  if (!lessonText) throw new Error("lessonText is required");

  const stages: Partial<Record<VideosBatchStageId, VideosBatchStageState<any>>> = {};
  for (const stageId of VIDEOS_BATCH_STAGE_ORDER) {
    stages[stageId] = {
      status: "pending",
      revision: 0
    };
  }

  stages.LESSON_INPUT = {
    status: "ready",
    revision: 1,
    artifact: {
      projectId,
      lessonText
    } satisfies VideosBatchLessonInputArtifact,
    updatedAt: now
  };

  return {
    version: 1,
    currentStage: "INTRO_GENERATION",
    stages,
    updatedAt: now
  };
}

declare module "./types" {
  interface Session {
    videosBatchWorkflow?: VideosBatchWorkflowState;
  }
}
