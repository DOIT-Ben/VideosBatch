import { randomUUID } from "node:crypto";
import type { Asset, AssetImageModel, AssetPromptAdaptation, Shot, ShotRender } from "../../shared/types";
import type { VideosBatchReferenceBinding } from "../../shared/videosBatchNativeProjection";
import type {
  VideosBatchAudioDeliveryArtifact,
  VideosBatchAudioDeliveryItem,
  VideosBatchAudioEvent,
  VideosBatchAudioTimeline,
  VideosBatchMediaError,
  VideosBatchMediaItemStatus,
  VideosBatchStageId
} from "../../shared/videosBatchWorkflow";
import {
  cacheGeneratedImage,
  cacheGeneratedVideo,
  defaultSeedreamAssetImageModel,
  generateAssetImage,
  generateShotVideo,
  localMediaPathFromMediaUrl,
  probeMediaDurationSec,
  stitchShotVideos
} from "../generators";
import type { CinemaStore } from "../store";
import type { StageDefinition, StageExecutionContext, StageRegistry } from "./stageContracts";
import {
  canonicalStoryboardBatchId,
  canonicalStoryboardSourceHash,
  contentHash,
  normalizeStoryboardArtifact
} from "./canonicalStoryboard";
import {
  applyConfirmedReferencesToNativeShots,
  projectAssetCandidatesIntoSeeReel
} from "./nativeProjection";
import {
  VIDEOS_BATCH_FAKE_AUDIO_PROVIDER,
  materializeFakeSoundEffect,
  mixFakeAudioTimeline,
  probeLocalAudioDuration,
  synthesizeFakeSpeech
} from "./audioDelivery";

export interface NativeAssetImageResult {
  url: string;
  composedPrompt?: string;
  model: AssetImageModel;
  credentialSource?: "standard" | "agent-plan" | "missing";
  promptAdaptation?: AssetPromptAdaptation;
  rawUsage?: unknown;
}

export interface NativeCachedImageResult {
  imageUrl?: string;
  thumbnailUrl?: string;
  sourceImageUrl?: string;
}

export interface NativeCachedVideoResult {
  videoUrl?: string;
  remoteVideoUrl?: string;
}

export interface NativeAssetCandidateItem {
  assetKey: string;
  publicAssetId: string;
  candidateAssetIds: string[];
  required: boolean;
  status: Extract<VideosBatchMediaItemStatus, "ready" | "failed">;
  attempt: number;
  error?: VideosBatchMediaError;
}

export interface NativeAssetCandidatesArtifact {
  schemaVersion: "1";
  status: "READY" | "PARTIAL" | "FAILED";
  items: NativeAssetCandidateItem[];
  failedItems: Array<NativeAssetCandidateItem & { error: VideosBatchMediaError }>;
  sourceStageId: "ASSET_PLAN";
  sourceRevision: number;
  sourceHash: string;
}

export interface NativeExecutionItem {
  shotId: string;
  sequence: number;
  status: Extract<VideosBatchMediaItemStatus, "ready" | "failed" | "blocked">;
  renderId?: string;
  videoUrl?: string;
  durationSec?: number;
  durationVerified?: boolean;
  generationTaskId?: string | null;
  attempt: number;
  error?: VideosBatchMediaError;
}

export interface NativeExecutionArtifact {
  schemaVersion: "1";
  executionId: string;
  batchId: string;
  status: "READY" | "PARTIAL" | "FAILED";
  renderIds: string[];
  nativeShotIds: string[];
  renderMap: NativeExecutionItem[];
  items: NativeExecutionItem[];
  failedShots: NativeExecutionItem[];
  audioTimeline: VideosBatchAudioTimeline;
  sourceStageId: "FINAL_STORYBOARD";
  sourceRevision: number;
  sourceHash: string;
  sourceHashes: Record<string, string>;
  sourceRevisions: Record<string, number>;
}

export interface VideosBatchNativeMediaDeps {
  defaultAssetImageModel(): AssetImageModel;
  generateAssetImage(asset: Asset, model: AssetImageModel): Promise<NativeAssetImageResult>;
  cacheGeneratedImage(url: string, assetId: string): Promise<NativeCachedImageResult>;
  generateShotVideo(
    shot: Shot,
    assets: Asset[],
    options?: {
      /** Resume an already accepted provider task instead of submitting again. */
      taskId?: string | null;
      onProviderTaskSubmitted?(taskId: string): Promise<void> | void;
      /** Persist the exact ordered reference list before a provider POST. */
      onProviderReferenceBindingsPrepared?(bindings: VideosBatchReferenceBinding[]): Promise<void> | void;
      /** Capture the exact compiled provider prompt before a provider POST. */
      onProviderPromptPrepared?(prompt: string): Promise<void> | void;
    }
  ): Promise<string>;
  cacheGeneratedVideo(url: string, renderId: string): Promise<NativeCachedVideoResult>;
  /** Probe the locally cached media; undefined means the URL could not be measured locally. */
  probeVideoDuration?(url: string): Promise<number | undefined>;
  stitchShotVideos(
    sessionId: string,
    shots: Shot[],
    options?: { audioTimeline?: VideosBatchAudioTimeline }
  ): Promise<{ finalVideoUrl: string; signature: string }>;
  /**
   * AUDIO_DELIVERY dependencies. TTS and sound effects are synthesized per
   * timeline event; the mix is the final deliverable track. The default deps
   * are deterministic fakes so the offline gate can run without a provider.
   */
  synthesizeSpeech?(event: VideosBatchAudioEvent, sessionId: string): Promise<string>;
  materializeSoundEffect?(event: VideosBatchAudioEvent, sessionId: string): Promise<string>;
  mixAudioTimeline?(
    timeline: VideosBatchAudioTimeline,
    sessionId: string
  ): Promise<{ mixAudioUrl: string; durationSec: number }>;
  /** Local probe for a synthesized audio file; undefined means unmeasurable. */
  probeAudioDuration?(url: string): Promise<number | undefined>;
}

export const defaultVideosBatchNativeMediaDeps: VideosBatchNativeMediaDeps = {
  defaultAssetImageModel: () => (process.env.VIDEOSBATCH_IMAGE_PROVIDER || "").trim().toLowerCase() === "lyaiapp" ? "gpt-image-2-1k" : defaultSeedreamAssetImageModel(),
  generateAssetImage: async (asset, model) => generateAssetImage(asset, model),
  cacheGeneratedImage,
  generateShotVideo: async (shot, assets, options) => generateShotVideo(shot, assets, {
    taskId: options?.taskId,
    onProviderTaskSubmitted: options?.onProviderTaskSubmitted,
    onProviderReferenceBindingsPrepared: options?.onProviderReferenceBindingsPrepared,
    onProviderPromptPrepared: options?.onProviderPromptPrepared
  }),
  cacheGeneratedVideo,
  probeVideoDuration: async (url) => {
    const localPath = localMediaPathFromMediaUrl(url);
    if (!localPath) return undefined;
    return probeMediaDurationSec(localPath);
  },
  stitchShotVideos: async (sessionId, shots, options) => stitchShotVideos(sessionId, shots, {
    audioTimeline: options?.audioTimeline
  }),
  synthesizeSpeech: synthesizeFakeSpeech,
  materializeSoundEffect: materializeFakeSoundEffect,
  mixAudioTimeline: mixFakeAudioTimeline,
  probeAudioDuration: probeLocalAudioDuration
};

function requireStore(ctx: StageExecutionContext): CinemaStore {
  if (!ctx.store) throw new Error("Native VideosBatch media execution requires CinemaStore");
  return ctx.store;
}

function projectIdFromWorkflow(ctx: StageExecutionContext) {
  const projectId = String(ctx.workflow.stages.LESSON_INPUT?.artifact?.projectId || "").trim();
  if (!projectId) throw new Error("LESSON_INPUT.projectId is required for native media execution");
  return projectId;
}

function storyboardBatchMetadata(workflow: any, storyboard: any) {
  const sourceRevision = Number(workflow?.stages?.FINAL_STORYBOARD?.revision) || 0;
  const sourceHash = canonicalStoryboardSourceHash(storyboard);
  const batchId = canonicalStoryboardBatchId(storyboard, sourceRevision, sourceHash);
  if (!batchId) throw new Error("FINAL_STORYBOARD source batch metadata is unavailable");
  return { batchId, sourceRevision, sourceHash };
}

function canAdoptShotForBatch(shot: Shot, metadata: ReturnType<typeof storyboardBatchMetadata>) {
  return !shot.videosBatchBatchId
    || shot.videosBatchBatchId === metadata.batchId
    // A projection may have been created before its stage revision was
    // persisted. Same canonical hash means it is the same content and can be
    // upgraded to the current revision; a changed hash remains isolated.
    || Boolean(metadata.sourceHash && shot.videosBatchSourceHash === metadata.sourceHash);
}

/** Return only shots projected from the current storyboard revision. */
async function currentBatchShots(
  store: CinemaStore,
  session: ReturnType<CinemaStore["getSession"]>,
  storyboard: any,
  metadata: ReturnType<typeof storyboardBatchMetadata>
) {
  if (!session) return [] as Shot[];
  const canonical = normalizeStoryboardArtifact(storyboard);
  const linkedIds = new Set((canonical?.segments || []).map((segment) => text(segment.nativeShotId)).filter(Boolean));
  const expectedCount = canonical?.segments.length || 0;
  const hasCompleteLinkedIds = expectedCount > 0 && linkedIds.size === expectedCount;
  const byId = new Map(session.shots.map((shot) => [shot.id, shot]));
  const candidates = hasCompleteLinkedIds
    // Preserve the canonical segment order when runtime pointers are present;
    // session-global Shot.index is not a batch-local sequence.
    ? (canonical?.segments || [])
      .map((segment) => byId.get(text(segment.nativeShotId)))
      .filter((shot): shot is Shot => Boolean(shot && canAdoptShotForBatch(shot, metadata)))
    // When pointers are absent (for example after a model round-trip), use the
    // first expected rows from this batch only. Never fall back to another
    // storyboard batch or to the session-global index starting at one.
    : session.shots
      .filter((shot) => shot.videosBatchBatchId === metadata.batchId)
      .sort((left, right) => left.index - right.index)
      .slice(0, expectedCount);
  const refreshed: Shot[] = [];
  for (const shot of candidates) {
    if (shot.videosBatchBatchId === metadata.batchId
      && shot.videosBatchSourceRevision === metadata.sourceRevision
      && shot.videosBatchSourceHash === metadata.sourceHash) {
      refreshed.push(shot);
      continue;
    }
    const updated = await store.updateShot(shot.id, {
      videosBatchBatchId: metadata.batchId,
      videosBatchSourceRevision: metadata.sourceRevision,
      videosBatchSourceHash: metadata.sourceHash
    });
    refreshed.push(updated || shot);
  }
  return refreshed.sort((a, b) => a.index - b.index);
}

function isPlaceholderUrl(value: unknown) {
  return typeof value === "string" && value.includes("placehold.co");
}

function assertRealMediaUrl(value: unknown, label: string) {
  const url = String(value || "").trim();
  if (!url) throw new Error(`${label} did not return a media URL`);
  if (isPlaceholderUrl(url)) {
    throw new Error(`${label} returned a placeholder URL. Configure the real SeeReel provider credentials before enabling native VideosBatch media mode.`);
  }
  return url;
}

const EXPECTED_SHOT_DURATION_SEC = 10;
const DURATION_TOLERANCE_SEC = 0.25;

function text(value: unknown) {
  return String(value ?? "").trim();
}

function finiteNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function errorCode(error: unknown, fallback: string) {
  const code = error && typeof error === "object" && "code" in error
    ? text((error as { code?: unknown }).code)
    : "";
  return code || fallback;
}

function errorRetryable(error: unknown, code: string) {
  if (code === "H3_SUBMISSION_STATE_UNKNOWN" || code === "H3_UNKNOWN_SUBMISSION") return false;
  const message = text(error instanceof Error ? error.message : error);
  if (/(?:401|403|unauthori[sz]ed|forbidden|余额不足|权限不足|配置缺失|必须配置)/iu.test(message)) return false;
  if (error && typeof error === "object" && "retryable" in error && typeof (error as { retryable?: unknown }).retryable === "boolean") {
    return Boolean((error as { retryable: boolean }).retryable);
  }
  return true;
}

function mediaError(error: unknown, fallbackCode: string, attempt: number): VideosBatchMediaError {
  const code = errorCode(error, fallbackCode);
  const rawMessage = text(error instanceof Error ? error.message : error) || fallbackCode;
  const message = rawMessage
    .replace(/Bearer\s+[^\s]+/giu, "Bearer [redacted]")
    .replace(/(?:api[_-]?key|token|secret)\s*[:=]\s*[^,\s}]+/giu, "$1=[redacted]")
    .slice(0, 2_000);
  const provider = error && typeof error === "object" && "provider" in error
    ? text((error as { provider?: unknown }).provider) || null
    : null;
  const model = error && typeof error === "object" && "model" in error
    ? text((error as { model?: unknown }).model) || null
    : undefined;
  const taskId = error && typeof error === "object" && "taskId" in error
    ? text((error as { taskId?: unknown }).taskId)
    : "";
  return {
    code,
    message,
    retryable: errorRetryable(error, code),
    attempt: Math.max(1, attempt),
    provider,
    ...(model ? { model } : {}),
    ...(taskId ? { taskId } : {})
  };
}

function stageSource(workflow: any, stageId: string) {
  const state = workflow?.stages?.[stageId];
  const artifact = state?.artifact;
  const hash = text(state?.contentHash) || (artifact === undefined ? "" : contentHash(artifact));
  return {
    revision: Number(state?.revision) || 0,
    hash
  };
}

function stageSources(workflow: any, stageIds: readonly string[]) {
  return Object.fromEntries(stageIds.map((stageId) => {
    const source = stageSource(workflow, stageId);
    return [stageId, source];
  }));
}

function isUnknownSubmission(error: unknown) {
  const code = errorCode(error, "");
  const message = text(error instanceof Error ? error.message : error);
  return code === "H3_SUBMISSION_STATE_UNKNOWN" || message.startsWith("H3_SUBMISSION_STATE_UNKNOWN:") || message.includes("幂等冲突且响应未返回原任务号");
}

function durationIsValid(value: unknown) {
  const duration = finiteNumber(value);
  return duration !== undefined && Math.abs(duration - EXPECTED_SHOT_DURATION_SEC) <= DURATION_TOLERANCE_SEC;
}

async function probeDuration(
  deps: VideosBatchNativeMediaDeps,
  url: string,
  knownDuration?: unknown,
  knownVerified?: unknown
) {
  if (knownVerified === true && durationIsValid(knownDuration)) return finiteNumber(knownDuration);
  const measured = await deps.probeVideoDuration?.(url);
  if (measured === undefined) return undefined;
  if (!durationIsValid(measured)) {
    throw Object.assign(new Error(`视频时长必须为 ${EXPECTED_SHOT_DURATION_SEC} 秒，实际为 ${measured} 秒`), { code: "VIDEO_DURATION_INVALID", retryable: true });
  }
  return measured;
}

function voiceStream(voice: string): "narration" | "dialogue" {
  return /旁白|内心独白|\b(?:OS|V\.?O\.?)\b/iu.test(voice) ? "narration" : "dialogue";
}

function buildAudioTimeline(workflow: any, storyboard: any): VideosBatchAudioTimeline {
  const canonical = normalizeStoryboardArtifact(storyboard);
  if (!canonical) throw new Error("FINAL_STORYBOARD must be canonical before building the audio timeline");
  const source = stageSource(workflow, "FINAL_STORYBOARD");
  const narration: VideosBatchAudioEvent[] = [];
  const dialogue: VideosBatchAudioEvent[] = [];
  const soundEffects: VideosBatchAudioEvent[] = [];
  const seenVoice = new Set<string>();
  canonical.segments.forEach((segment, segmentIndex) => {
    let cursor = segmentIndex * EXPECTED_SHOT_DURATION_SEC;
    segment.visualEffects.forEach((effect, effectIndex) => {
      const duration = Number(effect.duration) || 0;
      const startSec = cursor;
      const endSec = cursor + duration;
      cursor = endSec;
      const voice = text(effect.voice);
      if (voice && voice !== "无") {
        const dedupeKey = `${segment.sequence}:${voice}`;
        if (!seenVoice.has(dedupeKey)) {
          seenVoice.add(dedupeKey);
          const event: VideosBatchAudioEvent = {
            id: `shot-${segment.sequence}-voice-${effectIndex + 1}`,
            startSec,
            endSec,
            text: voice,
            source: "FINAL_STORYBOARD"
          };
          (voiceStream(voice) === "narration" ? narration : dialogue).push(event);
        }
      }
      const sound = text(effect.sound);
      if (sound && sound !== "无") {
        soundEffects.push({
          id: `shot-${segment.sequence}-sound-${effectIndex + 1}`,
          startSec,
          endSec,
          text: sound,
          source: "FINAL_STORYBOARD"
        });
      }
    });
  });
  return {
    schemaVersion: "1",
    durationSec: Number(canonical.targetDuration) || canonical.segments.length * EXPECTED_SHOT_DURATION_SEC,
    sourceStageId: "FINAL_STORYBOARD",
    sourceRevision: source.revision,
    sourceHash: source.hash,
    streams: {
      narration,
      dialogue,
      soundEffects,
      tts: [],
      mix: { status: "pending" }
    }
  };
}

type AudioTimelineValidationMode = "structural" | "delivery";

function isUsableAudioUrl(value: unknown) {
  const url = text(value);
  return /^https?:\/\//iu.test(url) || /^\/media\//u.test(url);
}

/**
 * The canonical fake chain declares `fake://` audio so the delivery artifact
 * stays inspectable without a media backend. Accept those only where the
 * caller has opted in, and keep every other scheme rejected so a placeholder
 * can never reach a real render.
 */
function isUsableFakeAudioUrl(value: unknown) {
  return /^fake:\/\//iu.test(text(value));
}

function sameAudioRange(left: any, right: any) {
  return Math.abs(Number(left?.startSec) - Number(right?.startSec)) <= DURATION_TOLERANCE_SEC
    && Math.abs(Number(left?.endSec) - Number(right?.endSec)) <= DURATION_TOLERANCE_SEC;
}

function validateAudioTimeline(
  timeline: any,
  expectedDuration: number,
  source: { revision: number; hash: string },
  errors: string[],
  mode: AudioTimelineValidationMode = "structural",
  options: { allowFakeAudio?: boolean } = {}
) {
  const usableAudioUrl = options.allowFakeAudio
    ? (value: unknown) => isUsableAudioUrl(value) || isUsableFakeAudioUrl(value)
    : isUsableAudioUrl;
  const pushTimelineError = (message: string) => {
    errors.push(mode === "delivery" ? `AUDIO_TIMELINE_NOT_READY: ${message}` : message);
  };
  if (!timeline || typeof timeline !== "object") {
    pushTimelineError("STITCH requires an independent audio timeline");
    return;
  }
  if (timeline.schemaVersion !== "1") pushTimelineError("audioTimeline schemaVersion must be 1");
  if (Math.abs(Number(timeline.durationSec) - expectedDuration) > DURATION_TOLERANCE_SEC) pushTimelineError("audioTimeline duration must match storyboard target duration");
  if (timeline.sourceStageId !== "FINAL_STORYBOARD") pushTimelineError("audioTimeline must be sourced from FINAL_STORYBOARD");
  if (Number(timeline.sourceRevision) !== source.revision) pushTimelineError("audioTimeline source revision is stale");
  if (text(timeline.sourceHash) !== source.hash) pushTimelineError("audioTimeline source hash is stale");
  const streams = timeline.streams;
  if (!streams || typeof streams !== "object") {
    pushTimelineError("audioTimeline streams are required");
    return;
  }
  for (const streamName of ["narration", "dialogue", "soundEffects", "tts"] as const) {
    if (!Array.isArray(streams[streamName])) {
      pushTimelineError(`audioTimeline ${streamName} stream must be an array`);
      continue;
    }
    for (const event of streams[streamName]) {
      const start = finiteNumber(event?.startSec);
      const end = finiteNumber(event?.endSec);
      if (start === undefined || end === undefined || start < 0 || end <= start || end > expectedDuration + DURATION_TOLERANCE_SEC) {
        pushTimelineError(`audioTimeline ${streamName} contains an invalid time range`);
      }
      if (!text(event?.id)) pushTimelineError(`audioTimeline ${streamName} event requires id`);
      if (!text(event?.text) && !text(event?.audioUrl)) pushTimelineError(`audioTimeline ${streamName} event requires text or audioUrl`);
    }
  }
  if (!streams.mix || !["pending", "ready"].includes(streams.mix.status)) pushTimelineError("audioTimeline mix status must be pending or ready");

  if (mode !== "delivery") return;

  const voiceEvents = [
    ...(Array.isArray(streams.narration) ? streams.narration : []),
    ...(Array.isArray(streams.dialogue) ? streams.dialogue : [])
  ];
  const ttsEvents = Array.isArray(streams.tts) ? streams.tts : [];
  const usedTts = new Set<number>();
  for (const voiceEvent of voiceEvents) {
    const matchIndex = ttsEvents.findIndex((candidate: any, index: number) => {
      if (usedTts.has(index)) return false;
      const sameId = text(candidate?.id) === text(voiceEvent?.id)
        || text(candidate?.id) === `tts-${text(voiceEvent?.id)}`;
      const sameTextAndRange = text(candidate?.text) === text(voiceEvent?.text) && sameAudioRange(candidate, voiceEvent);
      return sameId || sameTextAndRange;
    });
    if (matchIndex < 0) {
      pushTimelineError(`缺少语音事件 ${text(voiceEvent?.id) || "<empty>"} 的 TTS 音频`);
      continue;
    }
    usedTts.add(matchIndex);
    if (!usableAudioUrl(ttsEvents[matchIndex]?.audioUrl)) {
      pushTimelineError(`TTS 事件 ${text(voiceEvent?.id) || "<empty>"} 缺少可读取 audioUrl`);
    }
  }

  for (const soundEvent of (Array.isArray(streams.soundEffects) ? streams.soundEffects : [])) {
    if (!usableAudioUrl(soundEvent?.audioUrl)) {
      pushTimelineError(`音效事件 ${text(soundEvent?.id) || "<empty>"} 缺少可读取 audioUrl`);
    }
  }

  if (streams.mix?.status !== "ready") {
    pushTimelineError("audioTimeline mix.status 必须为 ready");
  } else if (!usableAudioUrl(streams.mix?.audioUrl)) {
    pushTimelineError("audioTimeline mix.audioUrl 缺失或不可读取");
  }
}

/**
 * AUDIO_DELIVERY materializes the structural audio timeline that EXECUTION
 * produced.  It synthesizes one audio file per declared voice/effect event,
 * builds the independent TTS stream and finishes with a mixed deliverable
 * track.  Only after this stage is the timeline acceptable to the STITCH
 * delivery gate.
 */
interface AudioDeliveryBuildResult {
  artifact: VideosBatchAudioDeliveryArtifact;
  attempts: number;
}

async function buildAudioDelivery(
  ctx: StageExecutionContext,
  deps: VideosBatchNativeMediaDeps,
  execution: NativeExecutionArtifact
): Promise<AudioDeliveryBuildResult> {
  const lineage = sourceLineage(ctx.workflow, ["EXECUTION", "FINAL_STORYBOARD"]);
  const previous = ctx.workflow.stages.AUDIO_DELIVERY?.artifact as Partial<VideosBatchAudioDeliveryArtifact> | undefined;
  const previousByEvent = new Map(
    (Array.isArray(previous?.items) ? previous.items : []).map((item: any) => [text(item?.eventId), item])
  );

  const timeline = execution.audioTimeline;
  if (!timeline || typeof timeline !== "object") {
    throw Object.assign(new Error("AUDIO_DELIVERY requires the EXECUTION audio timeline"), {
      code: "AUDIO_TIMELINE_MISSING",
      retryable: false
    });
  }

  const items: VideosBatchAudioDeliveryItem[] = [];
  const failedItems: VideosBatchAudioDeliveryItem[] = [];
  let maxAttempt = 0;

  const synthesize = async (
    event: VideosBatchAudioEvent,
    stream: VideosBatchAudioDeliveryItem["stream"]
  ): Promise<VideosBatchAudioDeliveryItem> => {
    const previousItem = previousByEvent.get(text(event.id)) as any;
    const attempt = Math.max(1, Number(previousItem?.attempt) || 0) + 1;
    maxAttempt = Math.max(maxAttempt, attempt);
    try {
      const reused = stream === "soundEffects" || stream === "mix"
        ? undefined
        : previousItem?.status === "ready" && isUsableAudioUrl(previousItem?.audioUrl)
          ? text(previousItem.audioUrl)
          : undefined;
      const audioUrl = reused || (stream === "narration" || stream === "dialogue"
        ? await deps.synthesizeSpeech?.(event, ctx.session.id)
        : await deps.materializeSoundEffect?.(event, ctx.session.id));
      if (!isUsableAudioUrl(audioUrl)) throw new Error(`${stream} 事件 ${text(event.id)} 未返回可读取的音频 URL`);
      const durationSec = await deps.probeAudioDuration?.(String(audioUrl));
      return {
        eventId: text(event.id),
        stream,
        status: "ready",
        audioUrl: String(audioUrl),
        ...(durationSec === undefined ? {} : { durationSec }),
        attempt
      };
    } catch (error) {
      const item: VideosBatchAudioDeliveryItem = {
        eventId: text(event.id),
        stream,
        status: "failed",
        attempt,
        error: mediaError(error, "AUDIO_SYNTHESIS_FAILED", attempt)
      };
      failedItems.push(item);
      return item;
    }
  };

  const voiceEvents = [...timeline.streams.narration, ...timeline.streams.dialogue];
  const voiceStreamByEventId = new Map<string, VideosBatchAudioDeliveryItem["stream"]>();
  timeline.streams.narration.forEach((event) => voiceStreamByEventId.set(text(event.id), "narration"));
  timeline.streams.dialogue.forEach((event) => voiceStreamByEventId.set(text(event.id), "dialogue"));

  const nextTimeline: VideosBatchAudioTimeline = structuredClone(timeline);
  nextTimeline.streams.tts = [];
  nextTimeline.streams.soundEffects = [...timeline.streams.soundEffects];

  // Synthesize speech: one TTS file per declared voice event, keyed to the
  // source event id so the delivery gate can match them one-to-one.
  for (const voiceEvent of voiceEvents) {
    const item = await synthesize(voiceEvent, voiceStreamByEventId.get(text(voiceEvent.id)) || "dialogue");
    items.push(item);
    if (item.status !== "ready") continue;
    nextTimeline.streams.tts.push({
      id: `tts-${text(voiceEvent.id)}`,
      startSec: Number(voiceEvent.startSec),
      endSec: Number(voiceEvent.endSec),
      text: text(voiceEvent.text),
      audioUrl: item.audioUrl,
      source: "TTS"
    });
  }

  // Materialize sound effects in place so the timeline carries readable URLs.
  for (const [index, soundEvent] of timeline.streams.soundEffects.entries()) {
    const item = await synthesize(soundEvent, "soundEffects");
    items.push(item);
    if (item.status === "ready") nextTimeline.streams.soundEffects[index] = { ...soundEvent, audioUrl: item.audioUrl };
  }

  // Only mix when every required event produced audio; a partial mix would let
  // the STITCH gate see `mix.status=ready` while speech is still missing.
  const synthesisFailed = failedItems.length > 0;
  if (synthesisFailed) {
    nextTimeline.streams.mix = { status: "pending" };
    const requiredFailed = failedItems.some((item) => item.stream !== "soundEffects");
    const status: VideosBatchAudioDeliveryArtifact["status"] = requiredFailed
      ? (items.some((item) => item.status === "ready") ? "PARTIAL" : "FAILED")
      : "PARTIAL";
    return {
      artifact: {
        schemaVersion: "1",
        status,
        provider: VIDEOS_BATCH_FAKE_AUDIO_PROVIDER,
        audioTimeline: nextTimeline,
        items,
        failedItems,
        ...lineage
      },
      attempts: maxAttempt
    };
  }

  try {
    const mixed = await deps.mixAudioTimeline?.(nextTimeline, ctx.session.id);
    if (!mixed || !isUsableAudioUrl(mixed.mixAudioUrl)) {
      throw Object.assign(new Error("混音未返回可读取的 audioUrl"), { code: "AUDIO_MIX_FAILED", retryable: true });
    }
    nextTimeline.streams.mix = {
      status: "ready",
      audioUrl: mixed.mixAudioUrl,
      generatedAt: new Date().toISOString()
    };
    items.push({
      eventId: "mix",
      stream: "mix",
      status: "ready",
      audioUrl: mixed.mixAudioUrl,
      durationSec: mixed.durationSec,
      attempt: Math.max(1, Number((previousByEvent.get("mix") as any)?.attempt) || 0) + 1
    });
    return {
      artifact: {
        schemaVersion: "1",
        status: "READY",
        provider: VIDEOS_BATCH_FAKE_AUDIO_PROVIDER,
        audioTimeline: nextTimeline,
        items,
        failedItems: [],
        ...lineage
      },
      attempts: maxAttempt
    };
  } catch (error) {
    const info = mediaError(error, "AUDIO_MIX_FAILED", Math.max(1, maxAttempt));
    nextTimeline.streams.mix = { status: "pending" };
    failedItems.push({ eventId: "mix", stream: "mix", status: "failed", attempt: info.attempt, error: info });
    items.push({ eventId: "mix", stream: "mix", status: "failed", attempt: info.attempt, error: info });
    return {
      artifact: {
        schemaVersion: "1",
        status: "PARTIAL",
        provider: VIDEOS_BATCH_FAKE_AUDIO_PROVIDER,
        audioTimeline: nextTimeline,
        items,
        failedItems,
        ...lineage
      },
      attempts: maxAttempt
    };
  }
}

/**
 * Delivery-mode timeline gate, shared with the fake registry so that "is this
 * audio ready to ship" has exactly one definition. Returns only the audio
 * errors, already prefixed with the canonical code.
 */
export function validateAudioTimelineDeliverable(
  timeline: any,
  expectedDuration: number,
  source: { revision: number; hash: string },
  options: { allowFakeAudio?: boolean } = {}
): string[] {
  const errors: string[] = [];
  validateAudioTimeline(timeline, expectedDuration, source, errors, "delivery", options);
  return errors;
}

function validateAudioDelivery(artifact: any, ctx: StageExecutionContext) {
  const errors: string[] = [];
  if (!artifact || typeof artifact !== "object") {
    errors.push("AUDIO_DELIVERY requires an artifact");
    return { ok: false, errors, code: "AUDIO_TIMELINE_NOT_READY", retryable: true };
  }
  if (artifact.schemaVersion !== "1") errors.push("AUDIO_DELIVERY schemaVersion must be 1");
  if (!["READY", "PARTIAL", "FAILED"].includes(String(artifact.status || ""))) errors.push("AUDIO_DELIVERY has an invalid status");
  if (!text(artifact.provider)) errors.push("AUDIO_DELIVERY requires a provider id");

  const source = stageSource(ctx.workflow, "EXECUTION");
  if (Number(artifact.sourceRevision) !== source.revision) errors.push("AUDIO_DELIVERY source revision is stale");
  if (text(artifact.sourceHash) !== source.hash) errors.push("AUDIO_DELIVERY source hash is stale");

  const execution = ctx.workflow.stages.EXECUTION?.artifact as Partial<NativeExecutionArtifact> | undefined;
  const expectedDuration = Number(execution?.audioTimeline?.durationSec)
    || Number((ctx.workflow.stages.FINAL_STORYBOARD?.artifact as any)?.targetDuration)
    || 0;
  const audioErrorStart = errors.length;
  validateAudioTimeline(artifact.audioTimeline, expectedDuration, stageSource(ctx.workflow, "FINAL_STORYBOARD"), errors, "delivery");
  const audioNotReady = errors.slice(audioErrorStart).some((message) => message.startsWith("AUDIO_TIMELINE_NOT_READY:"));

  if (artifact.status === "READY" && audioNotReady) {
    errors.push("AUDIO_DELIVERY READY requires a delivery-ready audio timeline");
  }
  if (artifact.status !== "READY" && !Array.isArray(artifact.failedItems)) {
    errors.push("AUDIO_DELIVERY non-ready status requires failedItems");
  }
  if (artifact.status === "READY" && Array.isArray(artifact.failedItems) && artifact.failedItems.length) {
    errors.push("AUDIO_DELIVERY READY cannot carry failed items");
  }

  const ok = errors.length === 0;
  return {
    ok,
    errors,
    ...(ok ? {} : { code: audioNotReady ? "AUDIO_TIMELINE_NOT_READY" : "AUDIO_DELIVERY_INVALID", retryable: audioNotReady || artifact.status !== "READY" })
  };
}

function validateAssetCandidates(artifact: any) {
  const errors: string[] = [];
  const items = Array.isArray(artifact?.items) ? artifact.items : [];
  const failedItems = Array.isArray(artifact?.failedItems) ? artifact.failedItems : [];
  if (!items.length) errors.push("ASSET_CANDIDATES requires at least one planned asset item");
  if (!['READY', 'PARTIAL', 'FAILED'].includes(String(artifact?.status || "READY"))) errors.push("ASSET_CANDIDATES has an invalid status");
  const keys = new Set<string>();
  for (const item of items) {
    const key = text(item?.assetKey);
    if (!key) errors.push("ASSET_CANDIDATES item requires assetKey");
    if (keys.has(key)) errors.push(`ASSET_CANDIDATES contains duplicate assetKey ${key}`);
    keys.add(key);
    if (!/^P\d{3,}-A\d{3,}$/.test(text(item?.publicAssetId))) {
      errors.push(`ASSET_CANDIDATES ${key || "item"} requires a server-owned stable publicAssetId`);
    }
    const status = item?.status || (Array.isArray(item?.candidateAssetIds) && item.candidateAssetIds.length ? "ready" : "failed");
    if (!['ready', 'failed'].includes(status)) errors.push(`ASSET_CANDIDATES ${key || "item"} has an invalid item status`);
    if (status === "ready" && (!Array.isArray(item?.candidateAssetIds) || !item.candidateAssetIds.length)) {
      errors.push(`ASSET_CANDIDATES ${key || "item"} requires at least one generated native candidate`);
    }
    if (status === "failed") {
      if (!item?.error || !text(item.error.code) || !text(item.error.message)) errors.push(`ASSET_CANDIDATES ${key || "item"} failed item requires structured error`);
      if (item?.required === true && artifact?.status === "READY") errors.push(`ASSET_CANDIDATES required item ${key || "item"} cannot fail in READY status`);
    }
  }
  const failedKeys = new Set<string>();
  for (const item of failedItems) {
    const key = text(item?.assetKey);
    if (!key || failedKeys.has(key)) errors.push("ASSET_CANDIDATES failedItems must contain unique assetKey values");
    failedKeys.add(key);
    if (!items.some((candidate: any) => text(candidate?.assetKey) === key && candidate?.status === "failed")) {
      errors.push(`ASSET_CANDIDATES failedItems entry ${key || "item"} is not represented in items`);
    }
  }
  const requiredFailures = items.filter((item: any) => item?.required !== false && (item?.status || "ready") === "failed");
  if (requiredFailures.length && String(artifact?.status || "") === "READY") errors.push("ASSET_CANDIDATES READY status requires every required asset to be ready");
  if (!requiredFailures.length && String(artifact?.status || "READY") === "PARTIAL") errors.push("ASSET_CANDIDATES PARTIAL status requires a failed required asset");
  return { ok: errors.length === 0, errors };
}

function modelForShot(shot: Shot) {
  if ((process.env.VIDEOSBATCH_VIDEO_PROVIDER || "").trim().toLowerCase() === "newapi-h3") return "minimax_h3";
  return shot.seedanceVariant === "fast" ? "seedance-2-0-fast" : "seedance-2-0";
}

function newestReadyRenderId(shot: Shot, batchId?: string) {
  const renders = shot.renders || [];
  const current = renders.find((render) => render.status === "ready"
    && (!batchId || render.videosBatchBatchId === batchId)
    && (render.videoUrl || render.remoteVideoUrl));
  if (current) return current.id;
  if (!batchId) return undefined;
  // Renders created before batch metadata was introduced can still be adopted
  // when their URL is the shot's current top-level video. The caller stamps
  // the batch before reusing it, so old renders cannot silently cross batches.
  return renders.find((render) => render.status === "ready"
    && !render.videosBatchBatchId
    && (render.videoUrl || render.remoteVideoUrl)
    && renderVideoUrl(shot, render) === text(shot.videoUrl))?.id;
}

function renderForShot(shot: Shot, renderId?: string, batchId?: string) {
  const renders = shot.renders || [];
  const exact = renders.find((render) => render.id === renderId
    && (!batchId || render.videosBatchBatchId === batchId))
  if (exact) return exact;
  if (batchId && renderId) {
    const legacy = renders.find((render) => render.id === renderId
      && !render.videosBatchBatchId
      && (render.videoUrl || render.remoteVideoUrl)
      && renderVideoUrl(shot, render) === text(shot.videoUrl));
    if (legacy) return legacy;
  }
  return renders.find((render) => render.status === "ready"
      && (!batchId || render.videosBatchBatchId === batchId)
      && (render.videoUrl || render.remoteVideoUrl))
    || (batchId ? renders.find((render) => render.status === "ready"
      && !render.videosBatchBatchId
      && (render.videoUrl || render.remoteVideoUrl)
      && renderVideoUrl(shot, render) === text(shot.videoUrl)) : undefined);
}

function renderVideoUrl(shot: Shot, render?: ShotRender) {
  return text(render?.videoUrl || render?.remoteVideoUrl || shot.videoUrl);
}

async function adoptRenderForBatch(
  store: CinemaStore,
  shot: Shot,
  render: ShotRender,
  batchId: string
) {
  if (render.videosBatchBatchId === batchId) return { shot, render };
  const renders = (shot.renders || []).map((candidate) => candidate.id === render.id
    ? { ...candidate, videosBatchBatchId: batchId }
    : candidate);
  const updated = await store.updateShot(shot.id, { renders });
  if (!updated) throw new Error(`Failed to adopt legacy render ${render.id} into VideosBatch batch ${batchId}`);
  const adopted = updated.renders?.find((candidate) => candidate.id === render.id);
  if (!adopted || adopted.videosBatchBatchId !== batchId) {
    throw new Error(`Legacy render ${render.id} did not persist VideosBatch batch metadata`);
  }
  return { shot: updated, render: adopted };
}

/**
 * Build the full source lineage for a stage from its declared inputs.  The
 * primary `sourceStageId` is the first entry, which callers rely on as a
 * literal type, so the function stays generic over the id list.
 */
function sourceLineage<const T extends readonly VideosBatchStageId[]>(
  workflow: any,
  stageIds: T
): {
  sourceStageId: T[0];
  sourceRevision: number;
  sourceHash: string;
  sourceHashes: Record<string, string>;
  sourceRevisions: Record<string, number>;
} {
  const sources = stageSources(workflow, stageIds);
  const first = stageIds[0] || "FINAL_STORYBOARD";
  return {
    sourceStageId: first as T[0],
    sourceRevision: sources[first]?.revision || 0,
    sourceHash: sources[first]?.hash || "",
    sourceHashes: Object.fromEntries(stageIds.map((id) => [id, sources[id]?.hash || ""])),
    sourceRevisions: Object.fromEntries(stageIds.map((id) => [id, sources[id]?.revision || 0]))
  };
}

function itemErrorFromShot(shot: Shot, fallbackAttempt: number) {
  if (!shot.videosBatchError && !shot.error) return undefined;
  return shot.videosBatchError || mediaError(new Error(text(shot.error)), "SHOT_FAILED", fallbackAttempt);
}

function executionStatus(items: NativeExecutionItem[]): NativeExecutionArtifact["status"] {
  const failed = items.filter((item) => item.status !== "ready");
  if (!failed.length) return "READY";
  return items.some((item) => item.status === "ready") ? "PARTIAL" : "FAILED";
}

/**
 * STITCH consumes the delivery-ready timeline owned by AUDIO_DELIVERY, not the
 * structural timeline EXECUTION produced.  Both are checked so a forged or
 * stale AUDIO_DELIVERY artifact cannot skip the audio gate.
 */
function deliveryAudioTimeline(ctx: StageExecutionContext) {
  const deliveryState = ctx.workflow.stages.AUDIO_DELIVERY;
  const delivery = deliveryState?.artifact as Partial<VideosBatchAudioDeliveryArtifact> | undefined;
  return {
    state: deliveryState,
    timeline: delivery?.audioTimeline as VideosBatchAudioTimeline | undefined
  };
}

async function stitchGateErrors(
  ctx: StageExecutionContext,
  deps: VideosBatchNativeMediaDeps,
  session: ReturnType<CinemaStore["getSession"]>
) {
  const errors: string[] = [];
  if (!session) return ["Session not found"];
  const storyboardState = ctx.workflow.stages.FINAL_STORYBOARD;
  const storyboard = storyboardState?.artifact as any;
  const canonical = normalizeStoryboardArtifact(storyboard);
  if (!canonical) {
    errors.push("STITCH requires a canonical FINAL_STORYBOARD");
    return errors;
  }
  let batch: ReturnType<typeof storyboardBatchMetadata> | undefined;
  try {
    batch = storyboardBatchMetadata(ctx.workflow, storyboard);
  } catch {
    errors.push("STITCH FINAL_STORYBOARD source batch metadata is unavailable");
    return errors;
  }
  const expectedDuration = Number(canonical.targetDuration) || canonical.segments.length * EXPECTED_SHOT_DURATION_SEC;
  const store = ctx.store;
  if (!store) {
    errors.push("STITCH requires CinemaStore for current batch verification");
    return errors;
  }
  const shots = await currentBatchShots(store, session, storyboard, batch);
  if (shots.length !== canonical.segments.length) errors.push(`STITCH requires ${canonical.segments.length} shots, got ${shots.length}`);
  shots.forEach((shot) => {
    if (shot.videosBatchBatchId !== batch!.batchId
      || shot.videosBatchSourceRevision !== batch!.sourceRevision
      || shot.videosBatchSourceHash !== batch!.sourceHash) errors.push(`STITCH shot ${shot.id} does not belong to the current storyboard batch`);
    if (Number(shot.durationSec) !== EXPECTED_SHOT_DURATION_SEC) errors.push(`STITCH shot ${shot.id} duration must be 10 seconds`);
    if (shot.status !== "ready" || !text(shot.videoUrl)) errors.push(`STITCH shot ${shot.id} is not ready with a video URL`);
  });

  const executionState = ctx.workflow.stages.EXECUTION;
  const execution = executionState?.artifact as Partial<NativeExecutionArtifact> | undefined;
  if (executionState?.status !== "ready" || execution?.status !== "READY") errors.push("STITCH requires a current READY EXECUTION artifact");
  if (text(execution?.batchId) !== batch.batchId) errors.push("STITCH EXECUTION batchId does not match the current storyboard batch");
  const renderMap = Array.isArray(execution?.renderMap) ? execution.renderMap : [];
  const renderByShot = new Map(renderMap.map((item: any) => [text(item?.shotId), item]));
  if (renderMap.length !== shots.length) errors.push("STITCH execution renderMap must contain exactly one entry per shot");
  const seenRenderIds = new Set<string>();
  for (const shot of shots) {
    const mapped = renderByShot.get(shot.id) as any;
    if (!mapped || mapped.status !== "ready" || !text(mapped.renderId)) {
      errors.push(`STITCH is missing a ready render mapping for shot ${shot.id}`);
      continue;
    }
    if (seenRenderIds.has(text(mapped.renderId))) errors.push(`STITCH render ${mapped.renderId} is mapped more than once`);
    seenRenderIds.add(text(mapped.renderId));
    const render = renderForShot(shot, text(mapped.renderId), batch.batchId);
    if (!render || render.status !== "ready") {
      errors.push(`STITCH render ${mapped.renderId} is not present and ready on shot ${shot.id}`);
      continue;
    }
    if (render.videosBatchBatchId !== batch.batchId) errors.push(`STITCH render ${mapped.renderId} does not belong to the current storyboard batch`);
    const url = renderVideoUrl(shot, render);
    if (!url || url !== text(shot.videoUrl)) errors.push(`STITCH render/video mapping is inconsistent for shot ${shot.id}`);
    try {
      const duration = await probeDuration(deps, url, render.videoDurationSec ?? shot.videoDurationSec, render.videoDurationVerified ?? shot.videoDurationVerified);
      if (duration === undefined) errors.push(`STITCH shot ${shot.id} video duration is not verifiable`);
    } catch (error) {
      errors.push(`STITCH shot ${shot.id} duration check failed: ${text(error instanceof Error ? error.message : error)}`);
    }
  }

  const expectedSources = sourceLineage(ctx.workflow, ["FINAL_STORYBOARD", "ASSET_CONFIRMATION", "QUOTE"]);
  for (const sourceId of ["FINAL_STORYBOARD", "ASSET_CONFIRMATION", "QUOTE"]) {
    if (text(execution?.sourceHashes?.[sourceId]) !== expectedSources.sourceHashes[sourceId]) errors.push(`STITCH EXECUTION source hash for ${sourceId} is stale or missing`);
    if (Number(execution?.sourceRevisions?.[sourceId]) !== expectedSources.sourceRevisions[sourceId]) errors.push(`STITCH EXECUTION source revision for ${sourceId} is stale or missing`);
  }
  const quote = ctx.workflow.stages.QUOTE?.artifact as any;
  if (quote?.current !== true) errors.push("STITCH requires a current QUOTE snapshot");
  if (Number(quote?.sourceStageRevision) !== storyboardState?.revision) errors.push("STITCH QUOTE storyboard revision is stale");
  if (text(quote?.sourceHash) !== expectedSources.sourceHashes.FINAL_STORYBOARD) errors.push("STITCH QUOTE storyboard hash is stale or missing");
  const confirmation = ctx.workflow.stages.ASSET_CONFIRMATION?.artifact as any;
  const confirmedOrder = Array.isArray(confirmation?.items) ? confirmation.items.map((item: any) => text(item?.publicAssetId)).filter(Boolean) : [];
  if (!Array.isArray(quote?.assetOrder) || quote.assetOrder.map(text).join("|") !== confirmedOrder.join("|")) errors.push("STITCH QUOTE asset order is stale or inconsistent");

  const { state: audioDeliveryState, timeline: audioTimeline } = deliveryAudioTimeline(ctx);
  if (audioDeliveryState?.status !== "ready") {
    errors.push("AUDIO_TIMELINE_NOT_READY: STITCH requires a current READY AUDIO_DELIVERY artifact");
  }
  validateAudioTimeline(audioTimeline, expectedDuration, stageSource(ctx.workflow, "FINAL_STORYBOARD"), errors, "delivery");
  return errors;
}

export function createVideosBatchNativeMediaStageRegistry(
  deps: VideosBatchNativeMediaDeps = defaultVideosBatchNativeMediaDeps
): StageRegistry {
  const assetCandidates: StageDefinition<any> = {
    id: "ASSET_CANDIDATES",
    async execute(ctx) {
      const store = requireStore(ctx);
      const plan = ctx.workflow.stages.ASSET_PLAN?.artifact as any;
      const items = Array.isArray(plan?.items) ? plan.items : [];
      if (!items.length) throw new Error("ASSET_PLAN must contain items before native image generation");
      const projectId = projectIdFromWorkflow(ctx);
      const previousArtifact = ctx.workflow.stages.ASSET_CANDIDATES?.artifact as Partial<NativeAssetCandidatesArtifact> | undefined;
      const previousByKey = new Map((Array.isArray(previousArtifact?.items) ? previousArtifact.items : []).map((item: any) => [text(item?.assetKey), item]));

      const beforeByStable = new Map<string, Asset>(
        store.snapshot().assets
          .filter((asset) => asset.ownerSessionId === ctx.session.id && asset.workflowReferenceId)
          .map((asset) => [asset.workflowReferenceId!, asset] as [string, Asset])
      );

      const projected = await projectAssetCandidatesIntoSeeReel(store, ctx.session.id, projectId, plan);
      const projectedItems = projected.items;
      const projectedByKey = new Map(projectedItems.map((item) => [text(item.assetKey), item]));

      const resultItems: NativeAssetCandidateItem[] = [];
      const failedItems: Array<NativeAssetCandidateItem & { error: VideosBatchMediaError }> = [];
      let maxAttempt = 0;
      for (let index = 0; index < items.length; index += 1) {
        const planned = items[index] as any;
        const key = text(planned?.assetKey);
        const projected = projectedByKey.get(key);
        const publicId = text(projected?.publicAssetId) || `${projectId}-A${String(index + 1).padStart(3, "0")}`;
        const required = planned?.required !== false;
        const previous = previousByKey.get(key) as any;
        const attempt = Math.max(1, Number(previous?.attempt) || 0) + 1;
        maxAttempt = Math.max(maxAttempt, attempt);
        let asset = projected?.candidateAssetIds?.[0]
          ? store.snapshot().assets.find((candidate) => candidate.id === projected.candidateAssetIds[0])
          : undefined;
        try {
          if (projected?.status === "failed" || projected?.error) {
            throw Object.assign(new Error(projected.error?.message || `Failed to project native asset ${publicId}`), {
              code: projected.error?.code || "ASSET_PROJECTION_FAILED",
              retryable: true
            });
          }
          if (!projected?.candidateAssetIds?.[0] || !asset) throw new Error(`Projected native asset not found: ${publicId}`);
          const previousAsset = beforeByStable.get(publicId);
          const usableExisting = Boolean(asset.imageUrl && !isPlaceholderUrl(asset.imageUrl));
          const promptUnchanged = Boolean(usableExisting && previousAsset?.prompt === text(planned?.prompt));
          if (!promptUnchanged) {
            const model = deps.defaultAssetImageModel();
            const generated = await deps.generateAssetImage(asset, model);
            const sourceUrl = assertRealMediaUrl(generated.url, `Asset ${publicId}`);
            const cached = await deps.cacheGeneratedImage(sourceUrl, asset.id);
            const imageUrl = assertRealMediaUrl(cached.imageUrl || sourceUrl, `Cached asset ${publicId}`);
            const generatedAt = new Date().toISOString();
            const updated = await store.upsertAsset({
              id: asset.id,
              mediaKind: "image",
              mediaUrl: imageUrl,
              imageUrl,
              thumbnailUrl: cached.thumbnailUrl || imageUrl,
              sourceImageUrl: cached.sourceImageUrl || sourceUrl,
              generatedAt,
              generationModel: generated.model,
              generationModelActual: generated.model,
              generationCredentialSource: generated.credentialSource,
              generationPromptAdaptation: generated.promptAdaptation,
              composedPrompt: generated.composedPrompt || asset.prompt,
              videosBatchError: undefined
            });
            if (!updated) throw new Error(`Failed to persist generated asset ${publicId}`);
            asset = updated;
          }
          const item: NativeAssetCandidateItem = {
            assetKey: key,
            publicAssetId: publicId,
            candidateAssetIds: [asset.id],
            required,
            status: "ready",
            attempt
          };
          resultItems.push(item);
        } catch (error) {
          const info = mediaError(error, "ASSET_CANDIDATE_FAILED", attempt);
          if (asset) await store.upsertAsset({ id: asset.id, videosBatchError: info }).catch(() => undefined);
          const item: NativeAssetCandidateItem = {
            assetKey: key,
            publicAssetId: publicId,
            candidateAssetIds: [],
            required,
            status: "failed",
            attempt,
            error: info
          };
          resultItems.push(item);
          failedItems.push({ ...item, error: info });
        }
      }

      const requiredFailures = resultItems.filter((item) => item.required && item.status === "failed");
      const status: NativeAssetCandidatesArtifact["status"] = requiredFailures.length
        ? (resultItems.some((item) => item.status === "ready") ? "PARTIAL" : "FAILED")
        : "READY";
      return {
        artifact: {
          schemaVersion: "1",
          status,
          items: resultItems,
          failedItems,
          sourceStageId: "ASSET_PLAN",
          sourceRevision: stageSource(ctx.workflow, "ASSET_PLAN").revision,
          sourceHash: stageSource(ctx.workflow, "ASSET_PLAN").hash
        } satisfies NativeAssetCandidatesArtifact,
        attempts: maxAttempt
      };
    },
    validate(artifact) {
      return validateAssetCandidates(artifact);
    }
  };

  const execution: StageDefinition<NativeExecutionArtifact> = {
    id: "EXECUTION",
    async execute(ctx) {
      const store = requireStore(ctx);
      const storyboard = ctx.workflow.stages.FINAL_STORYBOARD?.artifact as any;
      const confirmation = ctx.workflow.stages.ASSET_CONFIRMATION?.artifact as any;
      if (!storyboard?.segments?.length) throw new Error("FINAL_STORYBOARD is required before native execution");
      if (confirmation?.confirmed !== true) throw new Error("ASSET_CONFIRMATION must be confirmed before native execution");

      const batch = storyboardBatchMetadata(ctx.workflow, storyboard);
      const audioTimeline = buildAudioTimeline(ctx.workflow, storyboard);
      const lineage = sourceLineage(ctx.workflow, ["FINAL_STORYBOARD", "ASSET_CONFIRMATION", "QUOTE"]);
      await applyConfirmedReferencesToNativeShots(store, ctx.session.id, storyboard, confirmation, batch);
      const nativeSession = store.getSession(ctx.session.id);
      if (!nativeSession) throw new Error(`Session not found: ${ctx.session.id}`);
      const batchShots = await currentBatchShots(store, nativeSession, storyboard, batch);
      const canonical = normalizeStoryboardArtifact(storyboard);
      if (!canonical || batchShots.length !== canonical.segments.length) {
        throw new Error(`FINAL_STORYBOARD 当前批次需要 ${canonical?.segments.length || 0} 个 native Shot，实际找到 ${batchShots.length}`);
      }

      const previousArtifact = ctx.workflow.stages.EXECUTION?.artifact as Partial<NativeExecutionArtifact> | undefined;
      const previousByShot = new Map(
        (previousArtifact?.batchId === batch.batchId && Array.isArray(previousArtifact?.items) ? previousArtifact.items : [])
          .map((item: any) => [text(item?.shotId), item])
      );
      const items: NativeExecutionItem[] = [];
      const renderIds: string[] = [];
      const nativeShotIds: string[] = [];
      let maxAttempt = 0;

      for (const [batchIndex, initial] of batchShots.entries()) {
        const sequence = batchIndex + 1;
        let current = initial;
        nativeShotIds.push(current.id);
        const previous = previousByShot.get(current.id) as any;
        const attempt = Math.max(1, Number(previous?.attempt) || 0) + 1;
        maxAttempt = Math.max(maxAttempt, attempt);
        try {
          const reusable = current.videoUrl ? newestReadyRenderId(current, batch.batchId) : undefined;
          if (reusable) {
            let render = renderForShot(current, reusable, batch.batchId);
            if (!render) throw new Error(`Shot ${current.index} ready render ${reusable} could not be loaded`);
            if (render.videosBatchBatchId !== batch.batchId) {
              const adopted = await adoptRenderForBatch(store, current, render, batch.batchId);
              current = adopted.shot;
              render = adopted.render;
            }
            const videoUrl = renderVideoUrl(current, render);
            const duration = await probeDuration(deps, videoUrl, render?.videoDurationSec ?? current.videoDurationSec, render?.videoDurationVerified ?? current.videoDurationVerified);
            if (duration === undefined) throw Object.assign(new Error(`Shot ${current.index} 视频时长无法验证`), { code: "VIDEO_DURATION_UNVERIFIED", retryable: true });
            if (current.status !== "ready" || current.videoDurationVerified !== true) {
              const refreshed = await store.updateShot(current.id, {
                status: "ready",
                error: undefined,
                videosBatchError: undefined,
                videoDurationSec: duration,
                videoDurationVerified: true
              });
              if (refreshed) current = refreshed;
            }
            const item: NativeExecutionItem = {
              shotId: current.id,
              sequence,
              status: "ready",
              renderId: reusable,
              videoUrl,
              durationSec: duration,
              durationVerified: true,
              generationTaskId: current.generationTaskId,
              attempt
            };
            items.push(item);
            renderIds.push(reusable);
            continue;
          }

          if (!current.generationTaskId && isUnknownSubmission(current.error || current.videosBatchError)) {
            throw Object.assign(new Error(`${text(current.error) || "H3_SUBMISSION_STATE_UNKNOWN"} 请先人工对账原任务，或显式开始一次新的生成尝试。`), {
              code: "H3_SUBMISSION_STATE_UNKNOWN",
              retryable: false
            });
          }

          const generationStartedAt = current.generationStartedAt || new Date().toISOString();
          const generating = await store.updateShot(current.id, {
            generationStartedAt,
            status: "generating",
            error: undefined,
            videosBatchError: undefined
          });
          if (!generating) throw new Error(`Failed to mark native shot ${current.id} as generating`);
          current = generating;

          const activeAssets = store.getAssetsForShot(current);
          let submittedPrompt: string | undefined;
          const remoteUrl = assertRealMediaUrl(
            await deps.generateShotVideo(current, activeAssets, {
              taskId: current.generationTaskId,
              onProviderReferenceBindingsPrepared: async (bindings) => {
                const persisted = await store.updateShot(current.id, {
                  videosBatchReferenceBindings: structuredClone(bindings)
                });
                if (!persisted) throw new Error(`Failed to persist reference bindings for native shot ${current.id}`);
                current = persisted;
              },
              onProviderPromptPrepared: (prompt) => {
                submittedPrompt = prompt;
              },
              onProviderTaskSubmitted: async (taskId) => {
                const persisted = await store.updateShot(current.id, {
                  generationTaskId: taskId,
                  generationStartedAt,
                  status: "generating",
                  error: undefined,
                  videosBatchError: undefined
                });
                if (!persisted) throw new Error(`Failed to persist provider task id for native shot ${current.id}`);
                current = persisted;
              }
            }),
            `Shot ${current.index}`
          );
          const renderId = `render_vb_${randomUUID().slice(0, 8)}`;
          const cached = await deps.cacheGeneratedVideo(remoteUrl, renderId);
          const videoUrl = assertRealMediaUrl(cached.videoUrl || remoteUrl, `Cached shot ${current.index}`);
          const duration = await probeDuration(deps, videoUrl);
          if (duration === undefined) throw Object.assign(new Error(`Shot ${current.index} 视频时长无法验证`), { code: "VIDEO_DURATION_UNVERIFIED", retryable: true });
          const generatedAt = new Date().toISOString();
          const model = modelForShot(current);
          const render: ShotRender = {
            id: renderId,
            model,
            prompt: current.prompt,
            rawPrompt: current.rawPrompt,
            status: "ready",
            title: current.title,
            durationSec: current.durationSec,
            videoDurationSec: duration,
            videoDurationVerified: true,
            seedanceVariant: current.seedanceVariant,
            assetIds: [...(current.assetIds || [])],
            videosBatchReferenceBindings: current.videosBatchReferenceBindings
              ? structuredClone(current.videosBatchReferenceBindings)
              : undefined,
            composedPrompt: submittedPrompt || current.rawPrompt || current.prompt,
            generationTaskId: current.generationTaskId,
            generationStartedAt,
            videosBatchBatchId: batch.batchId,
            videoUrl,
            remoteVideoUrl: cached.remoteVideoUrl || remoteUrl,
            videoGeneratedAt: generatedAt,
            createdAt: generatedAt
          };

          const updated = await store.updateShot(current.id, {
            renders: [render, ...(current.renders || [])],
            videoUrl,
            playbackVideoUrl: videoUrl,
            downloadVideoUrl: videoUrl,
            videoGeneratedAt: generatedAt,
            videoDurationSec: duration,
            videoDurationVerified: true,
            generationModel: model,
            generationTaskId: undefined,
            generationStartedAt: undefined,
            status: "ready",
            error: undefined,
            videosBatchError: undefined
          });
          if (!updated) throw new Error(`Failed to persist native render for shot ${current.id}`);
          current = updated;
          const item: NativeExecutionItem = {
            shotId: current.id,
            sequence,
            status: "ready",
            renderId,
            videoUrl,
            durationSec: duration,
            durationVerified: true,
            generationTaskId: render.generationTaskId,
            attempt
          };
          items.push(item);
          renderIds.push(renderId);
        } catch (error) {
          const info = mediaError(error, "SHOT_EXECUTION_FAILED", attempt);
          const unknown = isUnknownSubmission(error);
          const retainedTaskId = current.generationTaskId || info.taskId || undefined;
          const patch: Partial<Shot> = {
            status: "error",
            error: `${info.code}: ${info.message}`,
            videosBatchError: info
          };
          // A pre-submit failure has no remote task to resume; clear its timestamp so an
          // explicit retry gets a fresh idempotency key. Unknown submission state is retained.
          if (!retainedTaskId && !unknown) patch.generationStartedAt = undefined;
          if (retainedTaskId) patch.generationTaskId = retainedTaskId;
          await store.updateShot(current.id, patch).catch(() => undefined);
          const item: NativeExecutionItem = {
            shotId: current.id,
            sequence,
            status: unknown ? "blocked" : "failed",
            generationTaskId: retainedTaskId,
            attempt,
            error: info
          };
          items.push(item);
        }
      }

      const status = executionStatus(items);
      return {
        artifact: {
          schemaVersion: "1",
          executionId: `execution_${ctx.session.id}`,
          batchId: batch.batchId,
          status,
          renderIds,
          nativeShotIds,
          renderMap: items,
          items,
          failedShots: items.filter((item) => item.status !== "ready"),
          audioTimeline,
          ...lineage
        },
        attempts: maxAttempt
      };
    },
    validate(artifact, ctx) {
      const errors: string[] = [];
      if (!text(artifact?.executionId)) errors.push("EXECUTION requires executionId");
      if (!["READY", "PARTIAL", "FAILED"].includes(String(artifact?.status || ""))) errors.push("EXECUTION has an invalid status");
      const nativeShotIds = Array.isArray(artifact?.nativeShotIds) ? artifact.nativeShotIds.map(text) : [];
      const renderIds = Array.isArray(artifact?.renderIds) ? artifact.renderIds.map(text) : [];
      const items = Array.isArray(artifact?.items) ? artifact.items : [];
      const renderMap = Array.isArray(artifact?.renderMap) ? artifact.renderMap : [];
      const storyboard = ctx.workflow.stages.FINAL_STORYBOARD?.artifact as any;
      const canonical = normalizeStoryboardArtifact(storyboard);
      let expectedBatch: ReturnType<typeof storyboardBatchMetadata> | undefined;
      if (!canonical) {
        errors.push("EXECUTION requires a canonical FINAL_STORYBOARD");
      } else {
        try {
          expectedBatch = storyboardBatchMetadata(ctx.workflow, storyboard);
        } catch {
          errors.push("EXECUTION FINAL_STORYBOARD source batch metadata is unavailable");
        }
      }
      if (!text(artifact?.batchId)) errors.push("EXECUTION requires batchId");
      if (expectedBatch && text(artifact?.batchId) !== expectedBatch.batchId) errors.push("EXECUTION batchId does not match the current FINAL_STORYBOARD batch");
      if (!nativeShotIds.length || items.length !== nativeShotIds.length) errors.push("EXECUTION requires one item for every native shot");
      if (renderMap.length !== items.length) errors.push("EXECUTION renderMap must mirror items exactly");
      if (artifact?.status === "READY" && items.some((item: any) => item?.status !== "ready")) errors.push("EXECUTION READY cannot contain failed shots");
      if (artifact?.status !== "READY" && !items.some((item: any) => item?.status !== "ready")) errors.push("EXECUTION partial status requires failed shots");
      const seen = new Set<string>();
      const nativeShotSet = new Set(nativeShotIds);
      const session = ctx.store?.getSession(ctx.session.id);
      const sessionShots = session?.shots || [];
      const shotsById = new Map(sessionShots.map((shot) => [shot.id, shot]));
      if (ctx.store && expectedBatch && canonical) {
        const currentBatch = sessionShots.filter((shot) => shot.videosBatchBatchId === expectedBatch!.batchId
          && shot.videosBatchSourceRevision === expectedBatch!.sourceRevision
          && shot.videosBatchSourceHash === expectedBatch!.sourceHash);
        if (currentBatch.length !== canonical.segments.length) {
          errors.push(`EXECUTION current batch requires ${canonical.segments.length} native shots, got ${currentBatch.length}`);
        }
      }
      if (ctx.store && expectedBatch) {
        for (const shotId of nativeShotIds) {
          const shot = shotsById.get(shotId);
          if (!shot) {
            errors.push(`EXECUTION contains a native shot id outside the current session: ${shotId}`);
          } else if (shot.videosBatchBatchId !== expectedBatch.batchId
            || shot.videosBatchSourceRevision !== expectedBatch.sourceRevision
            || shot.videosBatchSourceHash !== expectedBatch.sourceHash) {
            errors.push(`EXECUTION shot ${shotId} does not belong to the current storyboard batch`);
          }
        }
      }
      for (const item of items) {
        const shotId = text(item?.shotId);
        if (!shotId || seen.has(shotId)) errors.push("EXECUTION renderMap shot ids must be unique");
        seen.add(shotId);
        if (shotId && !nativeShotSet.has(shotId)) errors.push(`EXECUTION item ${shotId} is not listed in nativeShotIds`);
        if (!["ready", "failed", "blocked"].includes(String(item?.status || ""))) errors.push(`EXECUTION ${shotId || "shot"} has an invalid item status`);
        if (item?.status === "ready") {
          if (!text(item?.renderId) || !text(item?.videoUrl) || item?.durationVerified !== true || !durationIsValid(item?.durationSec)) {
            errors.push(`EXECUTION ${shotId || "shot"} ready item requires render, URL and verified 10 second duration`);
          }
          const shot = shotsById.get(shotId);
          if (shot && expectedBatch) {
            const render = shot.renders?.find((candidate) => candidate.id === text(item?.renderId));
            if (!render || render.status !== "ready") {
              errors.push(`EXECUTION render ${text(item?.renderId) || "<empty>"} is missing or not ready on shot ${shotId}`);
            } else {
              if (render.videosBatchBatchId !== expectedBatch.batchId) errors.push(`EXECUTION render ${render.id} does not belong to the current storyboard batch`);
              if (renderVideoUrl(shot, render) !== text(item?.videoUrl)) errors.push(`EXECUTION render/video URL mismatch for shot ${shotId}`);
            }
          }
        } else if (!item?.error || !text(item.error.code) || !text(item.error.message)) {
          errors.push(`EXECUTION ${shotId || "shot"} failed item requires structured error`);
        }
      }
      if (Array.isArray(artifact?.failedShots)) {
        const failedIds = artifact.failedShots.map((item: any) => text(item?.shotId));
        const expectedFailedIds = items.filter((item: any) => item?.status !== "ready").map((item: any) => text(item?.shotId));
        if (failedIds.join("|") !== expectedFailedIds.join("|")) errors.push("EXECUTION failedShots must mirror non-ready items");
      } else {
        errors.push("EXECUTION requires failedShots");
      }
      if (artifact?.status === "READY" && (!renderIds.length || renderIds.length !== nativeShotIds.length)) {
        errors.push("EXECUTION READY requires exactly one renderId for every nativeShotId");
      }
      const expectedDuration = Number(storyboard?.targetDuration) || nativeShotIds.length * EXPECTED_SHOT_DURATION_SEC;
      validateAudioTimeline(artifact?.audioTimeline, expectedDuration, stageSource(ctx.workflow, "FINAL_STORYBOARD"), errors);
      const sources = sourceLineage(ctx.workflow, ["FINAL_STORYBOARD", "ASSET_CONFIRMATION", "QUOTE"]);
      for (const sourceId of ["FINAL_STORYBOARD", "ASSET_CONFIRMATION", "QUOTE"]) {
        if (text(artifact?.sourceHashes?.[sourceId]) !== sources.sourceHashes[sourceId]) errors.push(`EXECUTION source hash for ${sourceId} is stale or missing`);
        if (Number(artifact?.sourceRevisions?.[sourceId]) !== sources.sourceRevisions[sourceId]) errors.push(`EXECUTION source revision for ${sourceId} is stale or missing`);
      }
      return { ok: errors.length === 0, errors };
    }
  };

  const audioDelivery: StageDefinition<VideosBatchAudioDeliveryArtifact> = {
    id: "AUDIO_DELIVERY",
    async execute(ctx) {
      const executionState = ctx.workflow.stages.EXECUTION;
      const execution = executionState?.artifact as NativeExecutionArtifact | undefined;
      if (executionState?.status !== "ready" || execution?.status !== "READY") {
        throw Object.assign(new Error("AUDIO_DELIVERY requires a current READY EXECUTION artifact"), {
          code: "AUDIO_TIMELINE_MISSING",
          retryable: false
        });
      }
      const result = await buildAudioDelivery(ctx, deps, execution);
      if (result.artifact.status !== "READY") {
        const firstError = result.artifact.failedItems[0]?.error;
        throw Object.assign(
          new Error(firstError ? `${firstError.code}: ${firstError.message}` : "AUDIO_TIMELINE_NOT_READY: 音频交付未完成"),
          {
            code: firstError?.code || "AUDIO_TIMELINE_NOT_READY",
            retryable: true,
            provider: VIDEOS_BATCH_FAKE_AUDIO_PROVIDER,
            model: null
          }
        );
      }
      return { artifact: result.artifact, attempts: result.attempts, provider: result.artifact.provider };
    },
    validate(artifact, ctx) {
      return validateAudioDelivery(artifact, ctx);
    }
  };

  const stitch: StageDefinition<any> = {
    id: "STITCH",
    async execute(ctx) {
      const store = requireStore(ctx);
      const session = store.getSession(ctx.session.id);
      if (!session) throw new Error(`Session not found: ${ctx.session.id}`);
      const gateErrors = await stitchGateErrors(ctx, deps, session);
      if (gateErrors.length) {
        const audioNotReady = gateErrors.some((message) => message.startsWith("AUDIO_TIMELINE_NOT_READY:"));
        const error = Object.assign(new Error(gateErrors.join("\n")), {
          code: audioNotReady ? "AUDIO_TIMELINE_NOT_READY" : "STITCH_INPUT_INVALID",
          retryable: audioNotReady
        });
        throw error;
      }
      const storyboard = ctx.workflow.stages.FINAL_STORYBOARD?.artifact as any;
      const batch = storyboardBatchMetadata(ctx.workflow, storyboard);
      const currentSession = store.getSession(ctx.session.id);
      if (!currentSession) throw new Error(`Session not found: ${ctx.session.id}`);
      const shots = await currentBatchShots(store, currentSession, storyboard, batch);
      const audioTimeline = deliveryAudioTimeline(ctx).timeline;
      if (!audioTimeline) throw new Error("STITCH requires a delivery-ready audio timeline from AUDIO_DELIVERY");
      const stitchJobId = `stitch_vb_${randomUUID().slice(0, 8)}`;
      const startedAt = new Date().toISOString();
      const created = await store.createStitchJob(ctx.session.id, {
        id: stitchJobId,
        name: "VideosBatch final",
        shotIds: shots.map((shot) => shot.id),
        status: "running",
        startedAt,
        progress: "stitching",
        videosBatchBatchId: batch.batchId,
        videosBatchSourceHash: stageSource(ctx.workflow, "FINAL_STORYBOARD").hash,
        videosBatchAudioTimelineHash: contentHash(audioTimeline)
      });
      if (!created) throw new Error("Failed to create native SeeReel StitchJob");

      try {
        const result = await deps.stitchShotVideos(ctx.session.id, shots, { audioTimeline });
        const finalVideoUrl = assertRealMediaUrl(result.finalVideoUrl, "STITCH");
        const generatedAt = new Date().toISOString();
        await store.updateStitchJob(ctx.session.id, stitchJobId, {
          status: "ready",
          finalVideoUrl,
          finalVideoPlaybackUrl: finalVideoUrl,
          finalVideoDownloadUrl: finalVideoUrl,
          finalVideoSignature: result.signature,
          finalVideoGeneratedAt: generatedAt,
          progress: "ready",
          error: undefined,
          runningSignature: undefined,
          videosBatchBatchId: batch.batchId,
          videosBatchSourceHash: stageSource(ctx.workflow, "FINAL_STORYBOARD").hash,
          videosBatchAudioTimelineHash: contentHash(audioTimeline)
        });
        await store.updateSession(ctx.session.id, {
          stitchStatus: "ready",
          stitchShotIds: shots.map((shot) => shot.id),
          finalVideoUrl,
          finalVideoSignature: result.signature,
          finalVideoGeneratedAt: generatedAt,
          stitchError: undefined,
          stitchProgress: "ready",
          stitchRunningSignature: undefined
        });
        return {
          artifact: {
            schemaVersion: "1",
            stitchJobId,
            finalVideoUrl,
            signature: result.signature,
            status: "READY",
            batchId: batch.batchId,
            shotIds: shots.map((shot) => shot.id),
            audioTimelineHash: contentHash(audioTimeline),
            sourceStageId: "FINAL_STORYBOARD",
            sourceRevision: stageSource(ctx.workflow, "FINAL_STORYBOARD").revision,
            sourceHash: stageSource(ctx.workflow, "FINAL_STORYBOARD").hash
          }
        };
      } catch (error) {
        await store.updateStitchJob(ctx.session.id, stitchJobId, {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
          progress: "error",
          runningSignature: undefined
        });
        throw error;
      }
    },
    validate(artifact, ctx) {
      const errors: string[] = [];
      if (!text(artifact?.stitchJobId)) errors.push("STITCH requires stitchJobId");
      if (!text(artifact?.finalVideoUrl)) errors.push("STITCH requires finalVideoUrl");
      if (!text(artifact?.signature)) errors.push("STITCH requires signature");
      if (artifact?.status !== "READY") errors.push("STITCH must finish READY");
      const source = stageSource(ctx.workflow, "FINAL_STORYBOARD");
      if (text(artifact?.sourceHash) !== source.hash || Number(artifact?.sourceRevision) !== source.revision) errors.push("STITCH artifact source version is stale or missing");
      const storyboard = ctx.workflow.stages.FINAL_STORYBOARD?.artifact as any;
      try {
        const batch = storyboardBatchMetadata(ctx.workflow, storyboard);
        if (text(artifact?.batchId) !== batch.batchId) errors.push("STITCH artifact batchId does not match the current storyboard batch");
        if (ctx.store) {
          const job = ctx.store.getSession(ctx.session.id)?.stitchJobs?.find((item) => item.id === text(artifact?.stitchJobId));
          if (!job || job.videosBatchBatchId !== batch.batchId) errors.push("STITCH job does not belong to the current storyboard batch");
        }
      } catch {
        errors.push("STITCH FINAL_STORYBOARD source batch metadata is unavailable");
      }
      const execution = ctx.workflow.stages.EXECUTION?.artifact as Partial<NativeExecutionArtifact>;
      if (text(execution?.batchId) !== text(artifact?.batchId)) errors.push("STITCH artifact batchId does not match EXECUTION batchId");
      const { state: deliveryState, timeline: deliveryTimeline } = deliveryAudioTimeline(ctx);
      if (deliveryState?.status !== "ready") {
        errors.push("AUDIO_TIMELINE_NOT_READY: STITCH requires a current READY AUDIO_DELIVERY artifact");
      }
      if (!deliveryTimeline) {
        errors.push("AUDIO_TIMELINE_NOT_READY: STITCH requires an independent delivery audio timeline");
      } else if (text(artifact?.audioTimelineHash) !== contentHash(deliveryTimeline)) {
        errors.push("STITCH artifact audio timeline hash is stale or missing");
      }
      const audioErrorStart = errors.length;
      const expectedDuration = Number(storyboard?.targetDuration) || Number(deliveryTimeline?.durationSec) || 0;
      validateAudioTimeline(deliveryTimeline, expectedDuration, stageSource(ctx.workflow, "FINAL_STORYBOARD"), errors, "delivery");
      const audioNotReady = errors.slice(audioErrorStart).some((message) => message.startsWith("AUDIO_TIMELINE_NOT_READY:"));
      return {
        ok: errors.length === 0,
        errors,
        ...(audioNotReady ? { code: "AUDIO_TIMELINE_NOT_READY", retryable: true } : {})
      };
    }
  };

  return {
    ASSET_CANDIDATES: assetCandidates,
    EXECUTION: execution,
    AUDIO_DELIVERY: audioDelivery,
    STITCH: stitch
  };
}
