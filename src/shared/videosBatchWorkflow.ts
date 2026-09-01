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

/**
 * One machine stage may only consume the confirmed, current output of these
 * upstream stages.  Keeping the graph in the shared contract prevents the
 * API, runner and UI from growing separate dependency interpretations.
 */
export const VIDEOS_BATCH_STAGE_DEPENDENCIES: Readonly<Record<VideosBatchStageId, readonly VideosBatchStageId[]>> = {
  LESSON_INPUT: [],
  COURSE_INTRO_CANDIDATES: ["LESSON_INPUT"],
  COURSE_INTRO_SELECTION: ["COURSE_INTRO_CANDIDATES"],
  STORY_SCRIPT: ["COURSE_INTRO_CANDIDATES", "COURSE_INTRO_SELECTION"],
  ASSET_PLAN: ["STORY_SCRIPT"],
  ASSET_CANDIDATES: ["ASSET_PLAN"],
  ASSET_CONFIRMATION: ["ASSET_PLAN", "ASSET_CANDIDATES"],
  SCREENPLAY: ["STORY_SCRIPT", "ASSET_PLAN", "ASSET_CONFIRMATION"],
  FINAL_STORYBOARD: ["SCREENPLAY", "ASSET_CONFIRMATION"],
  COPYABLE_PROMPT: ["FINAL_STORYBOARD", "ASSET_CONFIRMATION"],
  QUOTE: ["FINAL_STORYBOARD", "ASSET_CONFIRMATION", "COPYABLE_PROMPT"],
  EXECUTION: ["FINAL_STORYBOARD", "ASSET_CONFIRMATION", "QUOTE"],
  STITCH: ["EXECUTION", "FINAL_STORYBOARD", "QUOTE"]
};

export interface VideosBatchStageError {
  code: string;
  message: string;
  retryable: boolean;
  attempt: number;
  provider: string | null;
  model?: string | null;
}

export interface VideosBatchAttemptRecord {
  attempt: number;
  provider: string | null;
  model?: string | null;
  outcome: "success" | "error";
  errorCode?: string;
  status?: number;
  durationMs?: number;
}

/** A per-item media result is deliberately more granular than the stage state. */
export type VideosBatchMediaItemStatus = "pending" | "running" | "ready" | "failed" | "blocked";

export interface VideosBatchMediaError {
  code: string;
  message: string;
  retryable: boolean;
  attempt: number;
  provider?: string | null;
  model?: string | null;
  /** Provider task id, retained when submission succeeded but local persistence failed. */
  taskId?: string;
}

export interface VideosBatchAudioEvent {
  id: string;
  startSec: number;
  endSec: number;
  text?: string;
  audioUrl?: string;
  source: "FINAL_STORYBOARD" | "TTS" | "ASSET";
}

/**
 * Audio is a first-class input to the final media gate.  The timeline keeps
 * narration/dialogue, sound effects, TTS files and the eventual mix separate;
 * no visual prompt or storyboard text is implicitly treated as audio.
 */
export interface VideosBatchAudioTimeline {
  schemaVersion: "1";
  durationSec: number;
  sourceStageId: "FINAL_STORYBOARD";
  sourceRevision: number;
  sourceHash: string;
  streams: {
    narration: VideosBatchAudioEvent[];
    dialogue: VideosBatchAudioEvent[];
    soundEffects: VideosBatchAudioEvent[];
    tts: VideosBatchAudioEvent[];
    mix: {
      status: "pending" | "ready";
      audioUrl?: string;
      generatedAt?: string;
    };
  };
}

export type VideosBatchIntroSelectionMode =
  | "user_selected"
  | "system_recommended"
  | "custom";

export type VideosBatchLessonFileType = "doc" | "docx" | "pdf";

export interface VideosBatchLessonSource {
  kind: "file" | "pasted_text";
  fileName?: string;
  fileType?: VideosBatchLessonFileType;
  sizeBytes?: number;
}

export interface VideosBatchParsedLessonDocument {
  sourceKind: "file";
  fileName: string;
  fileType: VideosBatchLessonFileType;
  mimeType: string;
  sizeBytes: number;
  text: string;
  characterCount: number;
  paragraphCount: number;
  pageCount?: number;
  warnings: string[];
}

export interface VideosBatchLessonInputArtifact {
  projectId: string;
  lessonText: string;
  source?: VideosBatchLessonSource;
}

export interface VideosBatchStageState<T = unknown> {
  status: VideosBatchStageStatus;
  revision: number;
  artifact?: T;
  error?: string;
  /** Hash of the persisted artifact, independent of its display projection. */
  contentHash?: string;
  /** Immediate canonical source used for the artifact. */
  sourceStageId?: VideosBatchStageId;
  sourceRevision?: number;
  sourceHash?: string;
  /** Full dependency snapshot for stages with more than one input. */
  sourceHashes?: Partial<Record<VideosBatchStageId, string>>;
  /** Revision counterpart for every entry in sourceHashes. */
  sourceRevisions?: Partial<Record<VideosBatchStageId, number>>;
  attempts?: number;
  provider?: string | null;
  model?: string | null;
  attemptLog?: VideosBatchAttemptRecord[];
  errorInfo?: VideosBatchStageError;
  staleReason?: string;
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
  source?: VideosBatchLessonSource;
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
      lessonText,
      ...(input.source ? { source: input.source } : {})
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
