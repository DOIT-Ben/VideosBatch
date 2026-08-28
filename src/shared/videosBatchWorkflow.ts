export const VIDEOS_BATCH_STAGE_ORDER = [
  "LESSON_INPUT",
  "COURSE_INTRO_CANDIDATES",
  "COURSE_INTRO_SELECTION",
  "STORY_SCRIPT",
  "ASSET_PLAN",
  "ASSET_CANDIDATES",
  "ASSET_CONFIRMATION",
  "SCREENPLAY",
  "FINAL_STORYBOARD",
  "COPYABLE_PROMPT",
  "QUOTE",
  "EXECUTION",
  "STITCH"
] as const;

export type VideosBatchStageId = (typeof VIDEOS_BATCH_STAGE_ORDER)[number];

export type VideosBatchStageStatus =
  | "pending"
  | "running"
  | "ready"
  | "failed"
  | "stale";

export type VideosBatchIntroSelectionMode =
  | "user_selected"
  | "system_recommended"
  | "custom";

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
  completed: boolean;
  /** The canonical flow locks exactly one course intro before story generation. */
  selectedIntroId?: string;
  selectionMode?: VideosBatchIntroSelectionMode;
  selectionReason?: string;
  introLocked: boolean;
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
    currentStage: "COURSE_INTRO_CANDIDATES",
    completed: false,
    introLocked: false,
    stages,
    updatedAt: now
  };
}

declare module "./types" {
  interface Session {
    videosBatchWorkflow?: VideosBatchWorkflowState;
  }
}
