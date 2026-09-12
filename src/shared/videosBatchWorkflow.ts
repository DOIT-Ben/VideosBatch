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

/**
 * Frozen, server-auditable input shared by the prompt and media stages for a
 * single ten-second FINAL_STORYBOARD shot.  Provider-facing prompt text is a
 * later projection of this package; it is deliberately not stored here.
 */
export const SHOT_EXECUTION_PACKAGE_SCHEMA_VERSION = "1" as const;
export const SHOT_EXECUTION_STORY_TYPES = ["STORY", "SCIENCE", "KNOWLEDGE"] as const;
export type ShotExecutionStoryType = (typeof SHOT_EXECUTION_STORY_TYPES)[number];

export type ShotExecutionEvidence = {
  source: string;
  quote: string;
};

export type ShotExecutionEffect = {
  sequence: number;
  timeRange: string;
  duration: number;
  visual: string;
  action: string;
  camera: string;
};

export type ShotExecutionAudioIntentEvent = {
  id: string;
  text: string;
  startSec: number;
  endSec: number;
};

export type ShotExecutionReference = {
  referenceId: string;
  ordinal: number;
  assetKey: string;
  semanticLabel: string;
  /** Native/internal asset identity, retained only for server audit. */
  assetId: string;
  /** SHA-256 of the submitted image URL; the URL itself is never in the package. */
  imageUrlHash?: string;
};

export interface ShotExecutionPackage {
  schemaVersion: typeof SHOT_EXECUTION_PACKAGE_SCHEMA_VERSION;
  sourceStageId: "FINAL_STORYBOARD";
  sourceRevision: number;
  sourceHash: string;
  /** Revision of the confirmed ASSET_PLAN used for visual constraints. */
  assetPlanRevision: number;
  /** SHA-256 of the exact ASSET_PLAN artifact used for visual constraints. */
  assetPlanHash: string;
  /** SHA-256 of this package with the contentHash field omitted. */
  contentHash: string;
  shot: {
    sequence: number;
    chapter: string | null;
    screenplaySceneSequence: number;
    durationSec: 10;
    storyType: ShotExecutionStoryType;
  };
  teaching: {
    goal: string;
    knowledgeFocus: string;
    evidence: ShotExecutionEvidence[];
  };
  visual: {
    scene: string;
    roleLabel: "人物" | "主体" | "核心意象";
    role: string;
    supportLabel: "道具" | "辅助元素";
    support: string;
    effects: ShotExecutionEffect[];
    /** Global visual style inherited from the confirmed ASSET_PLAN. */
    styleSpec: string;
    /** Global negative constraints inherited from the confirmed ASSET_PLAN. */
    negativePrompt: string;
    globalContinuity: string;
  };
  audioIntent: {
    voices: ShotExecutionAudioIntentEvent[];
    sounds: ShotExecutionAudioIntentEvent[];
  };
  references: ShotExecutionReference[];
}

export type ShotExecutionPackageDraft = Omit<ShotExecutionPackage, "contentHash"> & {
  contentHash?: string;
};

/** The current FINAL_STORYBOARD lineage expected by a validator. */
export interface ShotExecutionPackageLineage {
  sourceRevision?: number;
  sourceHash?: string;
  /** Current confirmed ASSET_PLAN lineage and copied visual constraints. */
  assetPlanRevision?: number;
  assetPlanHash?: string;
  assetPlanStatus?: "ready" | "pending" | "running" | "failed" | "stale";
  assetPlanArtifactHash?: string;
  assetPlanStyleSpec?: string;
  assetPlanNegativePrompt?: string;
  assetPlan?: {
    revision?: number;
    hash?: string;
    contentHash?: string;
    status?: "ready" | "pending" | "running" | "failed" | "stale";
    styleSpec?: string;
    negativePrompt?: string;
    artifact?: unknown;
  };
  /** Friendly aliases accepted by local contract tests and migration callers. */
  revision?: number;
  hash?: string;
}

export interface ShotExecutionPackageValidationResult {
  ok: boolean;
  errors: string[];
  code?: string;
  retryable?: boolean;
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
