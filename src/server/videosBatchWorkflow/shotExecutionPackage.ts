import { createHash } from "node:crypto";
import {
  canonicalStoryboardSourceHash,
  normalizeStoryboardType,
  contentHash as canonicalContentHash
} from "./canonicalStoryboard";
import {
  SHOT_EXECUTION_PACKAGE_SCHEMA_VERSION,
  SHOT_EXECUTION_STORY_TYPES,
  type ShotExecutionAudioIntentEvent,
  type ShotExecutionEffect,
  type ShotExecutionPackage,
  type ShotExecutionPackageDraft,
  type ShotExecutionPackageLineage,
  type ShotExecutionPackageValidationResult,
  type ShotExecutionReference,
  type ShotExecutionStoryType
} from "../../shared/videosBatchWorkflow";

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const CHAPTER_PATTERN = /^第\d+章$/u;
const DURATION_TOLERANCE_SEC = 1e-6;

const ROLE_LABELS: Record<ShotExecutionStoryType, "人物" | "主体" | "核心意象"> = {
  STORY: "人物",
  SCIENCE: "主体",
  KNOWLEDGE: "核心意象"
};

const SUPPORT_LABELS: Record<ShotExecutionStoryType, "道具" | "辅助元素"> = {
  STORY: "道具",
  SCIENCE: "辅助元素",
  KNOWLEDGE: "辅助元素"
};

const ROLE_FIELDS: Record<ShotExecutionStoryType, "characters" | "subjectObjects" | "coreImagery"> = {
  STORY: "characters",
  SCIENCE: "subjectObjects",
  KNOWLEDGE: "coreImagery"
};

const SUPPORT_FIELDS: Record<ShotExecutionStoryType, "keyProps" | "supportingElements"> = {
  STORY: "keyProps",
  SCIENCE: "supportingElements",
  KNOWLEDGE: "supportingElements"
};

export interface ShotExecutionReferenceBindingInput {
  referenceId?: unknown;
  ordinal?: unknown;
  assetKey?: unknown;
  semanticLabel?: unknown;
  label?: unknown;
  assetId?: unknown;
  selectedAssetId?: unknown;
  imageUrlHash?: unknown;
  /** Accepted only to derive imageUrlHash; the URL is never persisted. */
  imageUrl?: unknown;
}

export interface ShotExecutionPackageTeachingInput {
  goal?: unknown;
  knowledgeFocus?: unknown;
  evidence?: unknown;
}

export interface BuildShotExecutionPackageFromStoryboardInput {
  finalStoryboard?: unknown;
  storyboard?: unknown;
  sourceStoryboard?: unknown;
  /** A segment object or its 1-based sequence number. */
  segment?: unknown;
  sequence?: number;
  sourceRevision?: number;
  sourceHash?: string;
  /** Friendly aliases used by migration callers. */
  revision?: number;
  hash?: string;
  screenplay?: unknown;
  teaching?: ShotExecutionPackageTeachingInput;
  goal?: unknown;
  knowledgeFocus?: unknown;
  globalContinuity?: unknown;
  referenceBindings?: readonly ShotExecutionReferenceBindingInput[];
  references?: readonly ShotExecutionReferenceBindingInput[];
  expectedLineage?: ShotExecutionPackageLineage;
}

export type ShotExecutionPackageExpectedLineage = ShotExecutionPackageLineage;

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(record: AnyRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function semanticDisplayText(value: unknown): string {
  return text(value)
    .replace(/^\s*【[^：:]+[：:]\s*/u, "")
    .replace(/】\s*$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function hashRawText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object") return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  Object.freeze(object);
  for (const child of Object.values(value as AnyRecord)) deepFreeze(child, seen);
  return value;
}

/**
 * Hash only the stable package payload.  `contentHash` is intentionally
 * removed first so computing a hash is not recursive and is safe to repeat.
 */
export function shotExecutionPackageContentHash(value: unknown): string {
  const payload = isRecord(value) ? { ...value } : {};
  delete payload.contentHash;
  return canonicalContentHash(payload);
}

export const hashShotExecutionPackage = shotExecutionPackageContentHash;
export const stableShotExecutionPackageHash = shotExecutionPackageContentHash;
export const contentHashForShotExecutionPackage = shotExecutionPackageContentHash;

const CODE_PRIORITY: Record<string, number> = {
  SHOT_EXECUTION_PACKAGE_INVALID: 1,
  SHOT_EXECUTION_PACKAGE_HASH_MISMATCH: 2,
  SHOT_EXECUTION_PACKAGE_LINEAGE_STALE: 3,
  SHOT_EXECUTION_PACKAGE_DUPLICATE_VOICE: 4
};

function makeValidationResult(errors: string[], code: string): ShotExecutionPackageValidationResult {
  if (!errors.length) return { ok: true, errors: [] };
  return {
    ok: false,
    errors,
    code,
    retryable: code === "SHOT_EXECUTION_PACKAGE_LINEAGE_STALE"
  };
}

function expectedLineage(
  value: unknown,
  expectedHash?: string
): ShotExecutionPackageLineage | undefined {
  if (typeof value === "number") return { sourceRevision: value, sourceHash: expectedHash };
  if (!isRecord(value)) return undefined;
  return {
    sourceRevision: typeof value.sourceRevision === "number"
      ? value.sourceRevision
      : typeof value.revision === "number"
        ? value.revision
        : undefined,
    sourceHash: typeof value.sourceHash === "string"
      ? value.sourceHash
      : typeof value.hash === "string"
        ? value.hash
        : expectedHash
  };
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validate both structure and lineage of a frozen package.  The optional
 * second argument represents the currently selected FINAL_STORYBOARD source;
 * a mismatch is a stale package, not a new package to silently accept.
 */
export function validateShotExecutionPackage(
  value: unknown,
  current?: ShotExecutionPackageLineage | number,
  currentHash?: string
): ShotExecutionPackageValidationResult {
  const errors: string[] = [];
  let code = "SHOT_EXECUTION_PACKAGE_INVALID";
  const push = (message: string, nextCode = "SHOT_EXECUTION_PACKAGE_INVALID") => {
    errors.push(message);
    if ((CODE_PRIORITY[nextCode] || 0) > (CODE_PRIORITY[code] || 0)) code = nextCode;
  };

  if (!isRecord(value)) return makeValidationResult(["ShotExecutionPackage must be an object"], code);

  if (value.schemaVersion !== SHOT_EXECUTION_PACKAGE_SCHEMA_VERSION) {
    push(`schemaVersion must be ${SHOT_EXECUTION_PACKAGE_SCHEMA_VERSION}`);
  }
  if (value.sourceStageId !== "FINAL_STORYBOARD") push("sourceStageId must be FINAL_STORYBOARD");

  let sourceRevision: number | undefined;
  if (!Number.isInteger(value.sourceRevision) || Number(value.sourceRevision) < 1) {
    push("sourceRevision must be a positive integer");
  } else {
    sourceRevision = value.sourceRevision as number;
  }

  const sourceHash = text(value.sourceHash);
  if (typeof value.sourceHash !== "string" || !sourceHash) {
    push("sourceHash is required and must be a string");
  } else if (!HASH_PATTERN.test(sourceHash)) {
    push("sourceHash must be a lowercase SHA-256 hash");
  }

  const packageHash = text(value.contentHash);
  if (typeof value.contentHash !== "string" || !packageHash) {
    push("contentHash is required and must be a string");
  } else if (!HASH_PATTERN.test(packageHash)) {
    push("contentHash must be a lowercase SHA-256 hash");
  } else if (shotExecutionPackageContentHash(value) !== packageHash) {
    push("contentHash does not match the canonical package payload", "SHOT_EXECUTION_PACKAGE_HASH_MISMATCH");
  }

  const lineage = expectedLineage(current, currentHash);
  if (lineage?.sourceRevision !== undefined && sourceRevision !== undefined && sourceRevision !== lineage.sourceRevision) {
    push("sourceRevision is stale", "SHOT_EXECUTION_PACKAGE_LINEAGE_STALE");
  }
  if (lineage?.sourceHash !== undefined && sourceHash && sourceHash !== lineage.sourceHash) {
    push("sourceHash is stale", "SHOT_EXECUTION_PACKAGE_LINEAGE_STALE");
  }

  const shot = isRecord(value.shot) ? value.shot : undefined;
  if (!shot) {
    push("shot is required and must be an object");
  } else {
    if (!Number.isInteger(shot.sequence) || Number(shot.sequence) < 1) push("shot.sequence must be a positive integer");
    if (!(shot.chapter === null || (typeof shot.chapter === "string" && CHAPTER_PATTERN.test(text(shot.chapter))))) {
      push("shot.chapter must match 第N章 or be null");
    }
    if (!Number.isInteger(shot.screenplaySceneSequence) || Number(shot.screenplaySceneSequence) < 1) {
      push("shot.screenplaySceneSequence must be a positive integer");
    }
    if (shot.durationSec !== 10) push("shot.durationSec must be 10");
    if (!SHOT_EXECUTION_STORY_TYPES.includes(shot.storyType as ShotExecutionStoryType)) {
      push("shot.storyType must be STORY, SCIENCE, or KNOWLEDGE");
    }
  }

  const teaching = isRecord(value.teaching) ? value.teaching : undefined;
  if (!teaching) {
    push("teaching is required and must be an object");
  } else {
    if (typeof teaching.goal !== "string" || !text(teaching.goal)) push("teaching.goal is required");
    if (typeof teaching.knowledgeFocus !== "string" || !text(teaching.knowledgeFocus)) push("teaching.knowledgeFocus is required");
    if (!Array.isArray(teaching.evidence)) {
      push("teaching.evidence must be an array");
    } else {
      teaching.evidence.forEach((entry, index) => {
        if (!isRecord(entry)) {
          push(`teaching.evidence[${index}] must be an object`);
          return;
        }
        if (typeof entry.source !== "string" || !text(entry.source)) push(`teaching.evidence[${index}].source is required`);
        if (typeof entry.quote !== "string" || !text(entry.quote)) push(`teaching.evidence[${index}].quote is required`);
      });
    }
  }

  const visual = isRecord(value.visual) ? value.visual : undefined;
  if (!visual) {
    push("visual is required and must be an object");
  } else {
    for (const field of ["scene", "role", "support", "globalContinuity"] as const) {
      if (typeof visual[field] !== "string" || !text(visual[field])) push(`visual.${field} is required`);
    }
    if (!(["人物", "主体", "核心意象"] as readonly string[]).includes(String(visual.roleLabel))) push("visual.roleLabel is invalid");
    if (!(["道具", "辅助元素"] as readonly string[]).includes(String(visual.supportLabel))) push("visual.supportLabel is invalid");
    if (shot && SHOT_EXECUTION_STORY_TYPES.includes(shot.storyType as ShotExecutionStoryType)) {
      const storyType = shot.storyType as ShotExecutionStoryType;
      if (visual.roleLabel !== ROLE_LABELS[storyType]) push(`visual.roleLabel must be ${ROLE_LABELS[storyType]}`);
      if (visual.supportLabel !== SUPPORT_LABELS[storyType]) push(`visual.supportLabel must be ${SUPPORT_LABELS[storyType]}`);
    }

    if (!Array.isArray(visual.effects)) {
      push("visual.effects must be an array");
    } else {
      if (visual.effects.length < 3 || visual.effects.length > 5) push("visual.effects must contain 3 to 5 subshots");
      let totalDuration = 0;
      visual.effects.forEach((effect, index) => {
        if (!isRecord(effect)) {
          push(`visual.effects[${index}] must be an object`);
          return;
        }
        if (effect.sequence !== index + 1) push(`visual.effects[${index}].sequence must be ${index + 1}`);
        if (typeof effect.timeRange !== "string" || !text(effect.timeRange)) push(`visual.effects[${index}].timeRange is required`);
        if (!finiteNumber(effect.duration) || effect.duration <= 0) {
          push(`visual.effects[${index}].duration must be positive`);
        } else {
          totalDuration += effect.duration;
        }
        for (const field of ["visual", "action", "camera"] as const) {
          if (typeof effect[field] !== "string" || !text(effect[field])) push(`visual.effects[${index}].${field} is required`);
        }
      });
      if (Math.abs(totalDuration - 10) > DURATION_TOLERANCE_SEC) push("visual.effects durations must total 10 seconds");
    }
  }

  const validateAudioEvents = (events: unknown, field: "voices" | "sounds") => {
    if (!Array.isArray(events)) {
      push(`audioIntent.${field} must be an array`);
      return;
    }
    const ids = new Set<string>();
    const tuples = new Set<string>();
    events.forEach((event, index) => {
      if (!isRecord(event)) {
        push(`audioIntent.${field}[${index}] must be an object`);
        return;
      }
      const id = text(event.id);
      if (typeof event.id !== "string" || !id) push(`audioIntent.${field}[${index}].id is required`);
      if (id && ids.has(id)) push(`audioIntent.${field} contains duplicate id ${id}`, field === "voices" ? "SHOT_EXECUTION_PACKAGE_DUPLICATE_VOICE" : undefined);
      if (id) ids.add(id);
      if (typeof event.text !== "string" || !text(event.text)) push(`audioIntent.${field}[${index}].text is required`);
      if (!finiteNumber(event.startSec) || event.startSec < 0) push(`audioIntent.${field}[${index}].startSec is invalid`);
      if (!finiteNumber(event.endSec) || event.endSec <= Number(event.startSec) || event.endSec > 10 + DURATION_TOLERANCE_SEC) {
        push(`audioIntent.${field}[${index}].endSec is invalid`);
      }
      if (field === "voices" && finiteNumber(event.startSec) && finiteNumber(event.endSec) && typeof event.text === "string") {
        const tuple = `${event.text.trim()}\u0000${event.startSec}\u0000${event.endSec}`;
        if (tuples.has(tuple)) push(`audioIntent.voices contains duplicate event ${id || index + 1}`, "SHOT_EXECUTION_PACKAGE_DUPLICATE_VOICE");
        tuples.add(tuple);
      }
    });
  };

  const audioIntent = isRecord(value.audioIntent) ? value.audioIntent : undefined;
  if (!audioIntent) {
    push("audioIntent is required and must be an object");
  } else {
    validateAudioEvents(audioIntent.voices, "voices");
    validateAudioEvents(audioIntent.sounds, "sounds");
  }

  if (!Array.isArray(value.references)) {
    push("references must be an array");
  } else {
    if (value.references.length < 1 || value.references.length > 7) push("references must contain 1 to 7 entries");
    const referenceIds = new Set<string>();
    const assetIds = new Set<string>();
    value.references.forEach((reference, index) => {
      if (!isRecord(reference)) {
        push(`references[${index}] must be an object`);
        return;
      }
      if (reference.ordinal !== index + 1) push(`references[${index}].ordinal must be ${index + 1}`);
      for (const field of ["referenceId", "assetKey", "semanticLabel", "assetId"] as const) {
        if (typeof reference[field] !== "string" || !text(reference[field])) push(`references[${index}].${field} is required`);
      }
      const referenceId = text(reference.referenceId);
      const assetId = text(reference.assetId);
      if (referenceId && referenceIds.has(referenceId)) push(`references contains duplicate referenceId ${referenceId}`);
      if (assetId && assetIds.has(assetId)) push(`references contains duplicate assetId ${assetId}`);
      if (referenceId) referenceIds.add(referenceId);
      if (assetId) assetIds.add(assetId);
      if (reference.imageUrlHash !== undefined && (typeof reference.imageUrlHash !== "string" || !HASH_PATTERN.test(text(reference.imageUrlHash)))) {
        push(`references[${index}].imageUrlHash must be a lowercase SHA-256 hash when present`);
      }
    });
  }

  return makeValidationResult(errors, code);
}

export class ShotExecutionPackageContractError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly validation: ShotExecutionPackageValidationResult;

  constructor(validation: ShotExecutionPackageValidationResult) {
    super(validation.errors.join("; ") || "ShotExecutionPackage contract validation failed");
    this.name = "ShotExecutionPackageContractError";
    this.code = validation.code || "SHOT_EXECUTION_PACKAGE_INVALID";
    this.retryable = Boolean(validation.retryable);
    this.validation = validation;
  }
}

export { ShotExecutionPackageContractError as ShotExecutionPackageValidationError };

function throwContract(validation: ShotExecutionPackageValidationResult): never {
  throw new ShotExecutionPackageContractError(validation);
}

function createFromDraft(
  draft: unknown,
  current?: ShotExecutionPackageLineage | number,
  currentHash?: string
): ShotExecutionPackage {
  if (!isRecord(draft)) return throwContract(makeValidationResult(["ShotExecutionPackage draft must be an object"], "SHOT_EXECUTION_PACKAGE_INVALID"));

  let cloned: AnyRecord;
  try {
    cloned = structuredClone(draft) as AnyRecord;
  } catch {
    return throwContract(makeValidationResult(["ShotExecutionPackage draft must be structured-cloneable"], "SHOT_EXECUTION_PACKAGE_INVALID"));
  }

  const suppliedContentHash = cloned.contentHash;
  const suppliedHashIsPresent = hasOwn(cloned, "contentHash") && suppliedContentHash !== undefined;
  if (suppliedHashIsPresent && typeof suppliedContentHash !== "string") {
    return throwContract(makeValidationResult(["contentHash must be a string when supplied"], "SHOT_EXECUTION_PACKAGE_INVALID"));
  }
  delete cloned.contentHash;
  const computedHash = shotExecutionPackageContentHash(cloned);
  if (typeof suppliedContentHash === "string" && suppliedContentHash !== computedHash) {
    return throwContract(makeValidationResult(["contentHash does not match the canonical package payload"], "SHOT_EXECUTION_PACKAGE_HASH_MISMATCH"));
  }

  const candidate = { ...cloned, contentHash: computedHash } as ShotExecutionPackage;
  const validation = validateShotExecutionPackage(candidate, current, currentHash);
  if (!validation.ok) return throwContract(validation);
  return deepFreeze(candidate);
}

function rawSegmentFromInput(storyboard: AnyRecord, input: BuildShotExecutionPackageFromStoryboardInput): AnyRecord {
  if (!Array.isArray(storyboard.segments)) return {};
  const requested = input.segment !== undefined ? input.segment : input.sequence;
  if (isRecord(requested)) {
    // The storyboard is authoritative.  A caller may pass a cloned segment for
    // convenience, but it must resolve to a segment that actually belongs to
    // this FINAL_STORYBOARD; otherwise the source hash could be forged.
    const requestedSequence = requested.sequence;
    if (!Number.isInteger(requestedSequence)) return {};
    return (storyboard.segments.find((segment) => isRecord(segment) && segment.sequence === requestedSequence) as AnyRecord | undefined) || {};
  }
  if (typeof requested === "number") {
    return (storyboard.segments.find((segment) => isRecord(segment) && segment.sequence === requested) as AnyRecord | undefined) || {};
  }
  if (storyboard.segments.length === 1 && isRecord(storyboard.segments[0])) return storyboard.segments[0];
  return {};
}

function referenceBindingFor(
  reference: unknown,
  provided: readonly ShotExecutionReferenceBindingInput[],
  usedIndexes: Set<number>
): { binding: AnyRecord; index: number } {
  const ref = isRecord(reference) ? reference : {};
  const refId = text(ref.referenceId);
  const refKey = text(ref.assetKey);
  const refLabel = semanticDisplayText(ref.label ?? ref.semanticLabel);
  const index = provided.findIndex((candidate, candidateIndex) => {
    if (usedIndexes.has(candidateIndex)) return false;
    const item = isRecord(candidate) ? candidate : {};
    return (refId && text(item.referenceId) === refId)
      || (refKey && text(item.assetKey) === refKey)
      || (refLabel && semanticDisplayText(item.semanticLabel ?? item.label) === refLabel);
  });
  if (index < 0) return { binding: {}, index: -1 };
  usedIndexes.add(index);
  const match = provided[index];
  return { binding: isRecord(match) ? match : {}, index };
}

function buildReferences(
  segment: AnyRecord,
  input: BuildShotExecutionPackageFromStoryboardInput
): ShotExecutionReference[] {
  const declared = Array.isArray(segment.references) ? segment.references : [];
  const provided = Array.isArray(input.referenceBindings)
    ? input.referenceBindings
    : Array.isArray(input.references)
      ? input.references
      : [];
  if (provided.length > declared.length) {
    return throwContract(makeValidationResult(
      ["referenceBindings contains entries not declared by FINAL_STORYBOARD.references"],
      "SHOT_EXECUTION_PACKAGE_INVALID"
    ));
  }
  const usedIndexes = new Set<number>();
  const result: ShotExecutionReference[] = [];
  for (let index = 0; index < declared.length; index += 1) {
    const rawReference = declared[index];
    const reference = isRecord(rawReference) ? rawReference : {};
    const resolved = referenceBindingFor(rawReference, provided, usedIndexes);
    const binding = resolved.binding;
    const imageUrlHash = hasOwn(binding, "imageUrlHash")
      ? binding.imageUrlHash
      : typeof binding.imageUrl === "string" && text(binding.imageUrl)
        ? hashRawText(text(binding.imageUrl))
        : undefined;
    result.push({
      referenceId: (hasOwn(binding, "referenceId") ? binding.referenceId : reference.referenceId) as string,
      ordinal: (hasOwn(binding, "ordinal") ? binding.ordinal : index + 1) as number,
      assetKey: (hasOwn(binding, "assetKey") ? binding.assetKey : reference.assetKey) as string,
      semanticLabel: (hasOwn(binding, "semanticLabel") ? binding.semanticLabel : binding.label ?? reference.label) as string,
      assetId: (hasOwn(binding, "assetId") ? binding.assetId : binding.selectedAssetId ?? reference.assetId) as string,
      ...(imageUrlHash !== undefined ? { imageUrlHash: imageUrlHash as string } : {})
    });
  }
  if (usedIndexes.size !== provided.length) {
    return throwContract(makeValidationResult(
      ["referenceBindings contains an entry that does not match a declared FINAL_STORYBOARD reference"],
      "SHOT_EXECUTION_PACKAGE_INVALID"
    ));
  }
  return result;
}

function buildAudioIntent(segment: AnyRecord): {
  voices: ShotExecutionAudioIntentEvent[];
  sounds: ShotExecutionAudioIntentEvent[];
} {
  const effects = Array.isArray(segment.visualEffects)
    ? segment.visualEffects
    : Array.isArray(segment.subshots)
      ? segment.subshots
      : [];
  const voices: ShotExecutionAudioIntentEvent[] = [];
  const sounds: ShotExecutionAudioIntentEvent[] = [];
  let cursor = 0;
  let voiceOrdinal = 0;
  let soundOrdinal = 0;
  for (const rawEffect of effects) {
    const effect = isRecord(rawEffect) ? rawEffect : {};
    const rawDuration = effect.duration;
    const duration = finiteNumber(rawDuration) ? rawDuration : Number(rawDuration);
    const startSec = cursor;
    const endSec = cursor + duration;
    const voice = typeof effect.voice === "string" ? effect.voice.trim() : effect.voice;
    if (voice !== undefined && voice !== null && voice !== "" && voice !== "无") {
      voiceOrdinal += 1;
      voices.push({
        id: `shot-${String(segment.sequence)}-voice-${voiceOrdinal}`,
        text: voice as string,
        startSec,
        endSec
      });
    }
    const sound = typeof effect.sound === "string" ? effect.sound.trim() : effect.sound;
    if (sound !== undefined && sound !== null && sound !== "" && sound !== "无") {
      soundOrdinal += 1;
      sounds.push({
        id: `shot-${String(segment.sequence)}-sound-${soundOrdinal}`,
        text: sound as string,
        startSec,
        endSec
      });
    }
    cursor = endSec;
  }
  return { voices, sounds };
}

function buildEffects(segment: AnyRecord): ShotExecutionEffect[] {
  const effects = Array.isArray(segment.visualEffects)
    ? segment.visualEffects
    : Array.isArray(segment.subshots)
      ? segment.subshots
      : [];
  return effects.map((rawEffect, index) => {
    const effect = isRecord(rawEffect) ? rawEffect : {};
    return {
      sequence: (hasOwn(effect, "sequence") ? effect.sequence : index + 1) as number,
      timeRange: effect.timeRange as string,
      duration: effect.duration as number,
      visual: effect.visual as string,
      action: effect.action as string,
      camera: effect.camera as string
    };
  });
}

function screenplaySceneFor(segment: AnyRecord, screenplay: unknown): AnyRecord {
  if (!isRecord(screenplay) || !Array.isArray(screenplay.scenes)) return {};
  return (screenplay.scenes.find((scene) => isRecord(scene) && scene.sequence === segment.screenplaySceneSequence) as AnyRecord | undefined) || {};
}

/** Build a package from one current FINAL_STORYBOARD segment and its audit bindings. */
export function buildShotExecutionPackageFromStoryboard(
  input: BuildShotExecutionPackageFromStoryboardInput
): ShotExecutionPackage {
  if (!isRecord(input)) return throwContract(makeValidationResult(["FINAL_STORYBOARD package input must be an object"], "SHOT_EXECUTION_PACKAGE_INVALID"));
  const storyboard = (input.finalStoryboard ?? input.storyboard ?? input.sourceStoryboard) as unknown;
  if (!isRecord(storyboard)) return throwContract(makeValidationResult(["finalStoryboard is required"], "SHOT_EXECUTION_PACKAGE_INVALID"));
  const segment = rawSegmentFromInput(storyboard, input);
  if (!Object.keys(segment).length) return throwContract(makeValidationResult(["FINAL_STORYBOARD segment is required"], "SHOT_EXECUTION_PACKAGE_INVALID"));

  const storyType = normalizeStoryboardType(storyboard.storyType ?? segment.storyType);
  if (!storyType || !SHOT_EXECUTION_STORY_TYPES.includes(storyType as ShotExecutionStoryType)) {
    return throwContract(makeValidationResult(["FINAL_STORYBOARD storyType must be STORY, SCIENCE, or KNOWLEDGE"], "SHOT_EXECUTION_PACKAGE_INVALID"));
  }
  const typedStoryType = storyType as ShotExecutionStoryType;
  const segmentStoryType = normalizeStoryboardType(segment.storyType);
  if (segmentStoryType && segmentStoryType !== typedStoryType) {
    return throwContract(makeValidationResult(["FINAL_STORYBOARD segment storyType does not match the artifact storyType"], "SHOT_EXECUTION_PACKAGE_INVALID"));
  }
  if (segment.duration !== 10) {
    return throwContract(makeValidationResult(["FINAL_STORYBOARD segment duration must be 10 seconds"], "SHOT_EXECUTION_PACKAGE_INVALID"));
  }
  const rawSourceRevision = input.sourceRevision ?? input.revision;
  if (!Number.isInteger(rawSourceRevision) || Number(rawSourceRevision) < 1) {
    return throwContract(makeValidationResult(["sourceRevision must be a positive integer"], "SHOT_EXECUTION_PACKAGE_INVALID"));
  }
  const sourceRevision = rawSourceRevision as number;
  const computedSourceHash = canonicalStoryboardSourceHash(storyboard);
  if (!computedSourceHash || !HASH_PATTERN.test(computedSourceHash)) {
    return throwContract(makeValidationResult(["FINAL_STORYBOARD source hash is unavailable"], "SHOT_EXECUTION_PACKAGE_INVALID"));
  }
  const sourceHash = input.sourceHash ?? input.hash ?? computedSourceHash;
  if (typeof sourceHash !== "string" || !HASH_PATTERN.test(sourceHash)) {
    return throwContract(makeValidationResult(["sourceHash must be a lowercase SHA-256 hash"], "SHOT_EXECUTION_PACKAGE_INVALID"));
  }
  if (sourceHash !== computedSourceHash) {
    return throwContract(makeValidationResult(["sourceHash does not match FINAL_STORYBOARD"], "SHOT_EXECUTION_PACKAGE_LINEAGE_STALE"));
  }

  const screenplayScene = screenplaySceneFor(segment, input.screenplay);
  const teaching = isRecord(input.teaching) ? input.teaching : {};
  const evidence = hasOwn(teaching, "evidence")
    ? teaching.evidence
    : Array.isArray(segment.evidence)
      ? segment.evidence
      : screenplayScene.evidence;
  const draft: ShotExecutionPackageDraft = {
    schemaVersion: SHOT_EXECUTION_PACKAGE_SCHEMA_VERSION,
    sourceStageId: "FINAL_STORYBOARD",
    sourceRevision,
    sourceHash,
    shot: {
      sequence: segment.sequence as number,
      chapter: segment.chapter === undefined ? null : segment.chapter as string | null,
      screenplaySceneSequence: segment.screenplaySceneSequence as number,
      durationSec: 10,
      storyType: typedStoryType
    },
    teaching: {
      goal: (hasOwn(teaching, "goal") ? teaching.goal : input.goal ?? storyboard.goal) as string,
      knowledgeFocus: (hasOwn(teaching, "knowledgeFocus") ? teaching.knowledgeFocus : input.knowledgeFocus ?? segment.knowledgeFocus ?? screenplayScene.knowledgeFocus) as string,
      evidence: evidence as any
    },
    visual: {
      scene: segment.scene as string,
      roleLabel: ROLE_LABELS[typedStoryType],
      role: segment[ROLE_FIELDS[typedStoryType]] as string,
      supportLabel: SUPPORT_LABELS[typedStoryType],
      support: segment[SUPPORT_FIELDS[typedStoryType]] as string,
      effects: buildEffects(segment),
      globalContinuity: (input.globalContinuity ?? storyboard.visualContinuity) as string
    },
    audioIntent: buildAudioIntent(segment),
    references: buildReferences(segment, input)
  };
  return createFromDraft(draft, input.expectedLineage as ShotExecutionPackageLineage | undefined);
}

function looksLikeStoryboardInput(value: unknown): boolean {
  return isRecord(value) && (
    hasOwn(value, "finalStoryboard")
    || hasOwn(value, "storyboard")
    || hasOwn(value, "sourceStoryboard")
    || Array.isArray(value.segments)
  );
}

/**
 * Build either a direct package draft or a package from a storyboard input.
 * Keeping both forms here gives later projection code one stable constructor.
 */
export function buildShotExecutionPackage(
  input: unknown,
  current?: ShotExecutionPackageLineage | number,
  currentHash?: string
): ShotExecutionPackage {
  if (looksLikeStoryboardInput(input)) {
    const sourceInput = (isRecord(input) && Array.isArray(input.segments)
      ? { finalStoryboard: input }
      : { ...(input as BuildShotExecutionPackageFromStoryboardInput) }) as BuildShotExecutionPackageFromStoryboardInput;
    if (typeof current === "number" && sourceInput.sourceRevision === undefined) sourceInput.sourceRevision = current;
    if (currentHash !== undefined && sourceInput.sourceHash === undefined) sourceInput.sourceHash = currentHash;
    if (isRecord(current) && sourceInput.expectedLineage === undefined) sourceInput.expectedLineage = current as ShotExecutionPackageLineage;
    return buildShotExecutionPackageFromStoryboard(sourceInput);
  }
  return createFromDraft(input, current, currentHash);
}

export const createShotExecutionPackage = buildShotExecutionPackage;
export const constructShotExecutionPackage = buildShotExecutionPackage;
export const makeShotExecutionPackage = buildShotExecutionPackage;

export function assertValidShotExecutionPackage(
  value: unknown,
  current?: ShotExecutionPackageLineage | number,
  currentHash?: string
): asserts value is ShotExecutionPackage {
  const validation = validateShotExecutionPackage(value, current, currentHash);
  if (!validation.ok) throw new ShotExecutionPackageContractError(validation);
}

export const assertShotExecutionPackage = assertValidShotExecutionPackage;
