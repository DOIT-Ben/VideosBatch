import type { Asset, AssetType, Shot } from "../../shared/types";
import "../../shared/videosBatchNativeProjection";
import type { VideosBatchReferenceBinding } from "../../shared/videosBatchNativeProjection";
import type { CinemaStore } from "../store";
import {
  canonicalStoryboardBatchId,
  canonicalStoryboardSourceHash,
  contentHash as canonicalContentHash,
  normalizeStoryboardArtifact,
  semanticLabelText as canonicalSemanticLabelText,
  type CanonicalStoryboardSegment
} from "./canonicalStoryboard";
import {
  buildShotExecutionPackageFromStoryboard,
  type ShotExecutionReferenceBindingInput
} from "./shotExecutionPackage";
import {
  compileShotProviderPrompt,
  isCompiledShotPrompt,
  type CompiledShotPrompt
} from "./promptCompiler";
import { validateVideosBatchAssetPlan } from "./llmTextStages";
import type { ShotExecutionPackage, ShotExecutionPackageLineage } from "../../shared/videosBatchWorkflow";

type AssetPlanItem = {
  assetKey: string;
  category?: string;
  name?: string;
  description?: string;
  prompt?: string;
  continuityNotes?: string | null;
  sourceEvidence?: string;
};

type AssetPlanArtifact = {
  items?: AssetPlanItem[];
};

export type AssetCandidateItem = {
  assetKey: string;
  publicAssetId: string;
  candidateAssetIds: string[];
  status?: "ready" | "failed";
  error?: { code: string; message: string };
};

export type AssetCandidatesArtifact = {
  items: AssetCandidateItem[];
};

type StoryboardSubshot = {
  sequence?: number;
  duration?: number;
  visual?: string;
  action?: string;
  camera?: string;
  sound?: string;
  voice?: string;
};

type StoryboardReference = {
  assetId?: string;
  publicAssetId?: string;
  label?: string;
};

type StoryboardSegment = {
  sequence?: number;
  nativeShotId?: string;
  chapter?: string;
  scene?: string;
  characters?: string;
  keyProps?: string;
  subjectObjects?: string;
  coreImagery?: string;
  supportingElements?: string;
  visualEffects?: StoryboardSubshot[];
  screenplaySceneSequence?: number;
  evidence?: unknown[];
  duration?: number;
  visualPrompt?: string;
  narration?: string;
  subtitles?: string;
  teachingPurpose?: string;
  transition?: string;
  references?: StoryboardReference[];
  subshots?: StoryboardSubshot[];
};

type FinalStoryboardArtifact = {
  storyType?: string;
  segments?: StoryboardSegment[];
};

type ConfirmedAssetItem = {
  assetKey?: string;
  publicAssetId?: string;
  selectedAssetId?: string;
  candidateAssetIds?: string[];
};

type AssetConfirmationArtifact = {
  confirmed?: boolean;
  items?: ConfirmedAssetItem[];
};

const HASH_PATTERN = /^[a-f0-9]{64}$/u;

function mapAssetType(category: string | undefined): AssetType {
  switch ((category || "").trim().toUpperCase()) {
    case "CHARACTER": return "character";
    case "SCENE": return "scene";
    case "PROP": return "prop";
    default: return "other";
  }
}

export interface VideosBatchProjectionOptions {
  /** Revision of the current FINAL_STORYBOARD stage. */
  sourceRevision?: number;
  /** Canonical source hash that excludes native projection pointers. */
  sourceHash?: string;
  /** Explicit batch id for callers that already computed one. */
  batchId?: string;
  /** The current ready ASSET_PLAN stage wrapper. Raw artifacts are rejected. */
  assetPlan?: unknown;
  /** Current SCREENPLAY artifact used to fill teaching lineage. */
  screenplay?: unknown;
  /** Optional teaching fields supplied by the current workflow context. */
  teaching?: {
    goal?: unknown;
    knowledgeFocus?: unknown;
    evidence?: unknown;
  };
  /** Current confirmed assets; resolution remains inside the execution boundary. */
  assetConfirmation?: AssetConfirmationArtifact;
  /** Explicit ordered bindings for isolated callers and replay tests. */
  referenceBindings?: readonly ShotExecutionReferenceBindingInput[];
}

function assetKeyFromNativeAsset(asset: Asset): string {
  const explicit = String((asset as Asset & { videosBatchAssetKey?: unknown }).videosBatchAssetKey || "").trim();
  if (explicit) return explicit;
  const tags = Array.isArray(asset.tags) ? asset.tags.map((tag) => String(tag).trim()) : [];
  const tagged = tags.find((tag) => tag.startsWith("videosbatch:") && tag.length > "videosbatch:".length);
  if (tagged) return tagged.slice("videosbatch:".length).trim();
  return tags.find((tag) => tag && tag.toLowerCase() !== "videosbatch") || "";
}

function stableIdNumber(value: string, projectId: string): number | undefined {
  const prefix = `${projectId}-A`;
  if (!value.startsWith(prefix)) return undefined;
  const suffix = value.slice(prefix.length);
  return /^\d+$/u.test(suffix) ? Number(suffix) : undefined;
}

function projectionFailure(message: string, code = "FINAL_STORYBOARD_PROJECTION_INVALID") {
  return Object.assign(new Error(message), { code, retryable: false });
}

function projectionMetadata(artifact: FinalStoryboardArtifact, options: VideosBatchProjectionOptions = {}) {
  const sourceRevision = options.sourceRevision;
  if (typeof sourceRevision !== "number" || !Number.isInteger(sourceRevision) || sourceRevision < 1) {
    throw projectionFailure("FINAL_STORYBOARD sourceRevision must be a positive integer", "FINAL_STORYBOARD_LINEAGE_STALE");
  }
  const expectedSourceHash = canonicalStoryboardSourceHash(artifact);
  const sourceHash = typeof options.sourceHash === "string" ? options.sourceHash.trim() : "";
  if (!HASH_PATTERN.test(sourceHash) || !expectedSourceHash || sourceHash !== expectedSourceHash) {
    throw projectionFailure("FINAL_STORYBOARD sourceHash is missing or does not match the canonical artifact", "FINAL_STORYBOARD_LINEAGE_STALE");
  }
  const expectedBatchId = canonicalStoryboardBatchId(artifact, sourceRevision, sourceHash);
  if (!expectedBatchId) throw projectionFailure("FINAL_STORYBOARD source batch metadata is unavailable");
  const requestedBatchId = String(options.batchId || "").trim();
  if (requestedBatchId && requestedBatchId !== expectedBatchId) {
    throw projectionFailure("FINAL_STORYBOARD batchId does not match its source revision/hash", "FINAL_STORYBOARD_LINEAGE_STALE");
  }
  return { sourceRevision, sourceHash, batchId: expectedBatchId };
}

function canAdoptShotForBatch(shot: Shot, metadata: ReturnType<typeof projectionMetadata>) {
  return !shot.videosBatchBatchId
    || shot.videosBatchBatchId === metadata.batchId
    // A projection can run before the workflow revision is persisted. When
    // the canonical source hash is unchanged, upgrade that same Shot instead
    // of creating a duplicate; changed content gets a new batch.
    || Boolean(metadata.sourceHash && shot.videosBatchSourceHash === metadata.sourceHash);
}

function semanticLabelText(value: unknown) {
  return canonicalSemanticLabelText(value);
}

function semanticDisplayText(value: unknown) {
  return String(value ?? "")
    .replace(/^\s*【[^：:]+[：:]\s*/u, "")
    .replace(/】\s*$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function canonicalProjection(artifact: FinalStoryboardArtifact) {
  const normalized = normalizeStoryboardArtifact(artifact);
  if (!normalized) throw new Error("FINAL_STORYBOARD must be a canonical storyboard with a valid storyType");
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

type CurrentAssetPlan = {
  wrapper: Record<string, unknown>;
  revision: number;
  hash: string;
};

function currentAssetPlanForExecution(
  store: CinemaStore,
  sessionId: string,
  options: VideosBatchProjectionOptions
): CurrentAssetPlan {
  const persisted = store.getSession(sessionId)?.videosBatchWorkflow?.stages.ASSET_PLAN as unknown;
  const supplied = options.assetPlan;
  if (supplied !== undefined && isRecord(persisted) && isRecord(supplied)) {
    if (persisted.status !== supplied.status
      || persisted.revision !== supplied.revision
      || persisted.contentHash !== supplied.contentHash) {
      throw projectionFailure("当前 ASSET_PLAN wrapper 与持久化 workflow lineage 不一致", "ASSET_PLAN_LINEAGE_STALE");
    }
  }
  const candidate = supplied ?? persisted;
  if (!isRecord(candidate)
    || candidate.status !== "ready"
    || typeof candidate.revision !== "number"
    || !Number.isInteger(candidate.revision)
    || candidate.revision < 1
    || typeof candidate.contentHash !== "string"
    || !HASH_PATTERN.test(candidate.contentHash)
    || !isRecord(candidate.artifact)) {
    throw projectionFailure(
      "执行绑定必须接收当前 ready ASSET_PLAN stage wrapper（含 revision、contentHash 和 artifact）",
      "ASSET_PLAN_LINEAGE_STALE"
    );
  }
  const artifactHash = canonicalContentHash(candidate.artifact);
  if (candidate.contentHash !== artifactHash) {
    throw projectionFailure("当前 ASSET_PLAN wrapper contentHash 与 artifact 不一致", "ASSET_PLAN_LINEAGE_STALE");
  }
  const validation = validateVideosBatchAssetPlan(candidate.artifact);
  if (!validation.ok) {
    throw projectionFailure(
      `当前 ASSET_PLAN 业务校验失败：${validation.errors.join("；")}`,
      "ASSET_PLAN_INVALID"
    );
  }
  return {
    wrapper: candidate,
    revision: candidate.revision,
    hash: candidate.contentHash
  };
}

function shouldIgnoreRuntimePointerForNewBatch(
  shot: Shot,
  metadata: ReturnType<typeof projectionMetadata>
): boolean {
  return shot.videosBatchBatchId !== metadata.batchId
    && shot.videosBatchSourceHash !== metadata.sourceHash;
}

type SelectedConfirmedAsset = {
  stableId: string;
  selectedAssetId: string;
  assetKey: string;
  asset: Asset;
  /** Name-level identity: asset key, stable id, display name, tags. */
  labels: string[];
  /** Free-text description; only consulted when the name tier finds nothing. */
  descriptionLabels: string[];
};

function selectedConfirmedAssets(
  store: CinemaStore,
  sessionId: string,
  confirmation: AssetConfirmationArtifact
): SelectedConfirmedAsset[] {
  if (!confirmation || typeof confirmation !== "object" || confirmation.confirmed !== true) {
    throw projectionFailure("Assets must be confirmed before FINAL_STORYBOARD execution projection", "ASSET_CONFIRMATION_NOT_READY");
  }
  const session = store.getSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  const sessionShotIds = new Set(session.shots.map((shot) => shot.id));
  const snapshot = store.snapshot();
  const seenStableIds = new Set<string>();
  const seenSelectedAssetIds = new Set<string>();
  return (Array.isArray(confirmation.items) ? confirmation.items : [])
    .map((item) => {
      const selectedAssetId = String(item.selectedAssetId || "").trim();
      const stableId = String(item.publicAssetId || "").trim();
      const asset = snapshot.assets.find((candidate) => candidate.id === selectedAssetId);
      const userMatches = Boolean(asset && (!asset.ownerUserId || (session.ownerUserId && asset.ownerUserId === session.ownerUserId)));
      const ownedBySession = Boolean(asset && userMatches && (
        asset.ownerSessionId === sessionId
        || (asset.ownerShotId && sessionShotIds.has(asset.ownerShotId))
        || (!asset.ownerSessionId && !asset.ownerShotId && !asset.ownerUserId)
      ));
      if (!asset || !ownedBySession || !stableId || !selectedAssetId) return undefined;
      if (seenStableIds.has(stableId) || seenSelectedAssetIds.has(selectedAssetId)) {
        throw projectionFailure("ASSET_CONFIRMATION contains duplicate stable/native asset bindings", "FINAL_STORYBOARD_REFERENCE_INVALID");
      }
      seenStableIds.add(stableId);
      seenSelectedAssetIds.add(selectedAssetId);
      const assetKey = String(item.assetKey || assetKeyFromNativeAsset(asset) || asset.name || stableId).trim();
      return {
        stableId,
        selectedAssetId,
        assetKey,
        asset,
        labels: [item.assetKey, stableId, asset.name, ...(asset.tags || [])]
          .map(semanticLabelText)
          .filter(Boolean),
        descriptionLabels: [asset.description]
          .map(semanticLabelText)
          .filter(Boolean)
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
}

function resolveReferenceBindingsForSegment(
  segment: CanonicalStoryboardSegment,
  selectedAssets: readonly SelectedConfirmedAsset[]
): ShotExecutionReferenceBindingInput[] {
  const declared = Array.isArray(segment.references) ? segment.references : [];
  if (!declared.length) {
    throw projectionFailure(
      `FINAL_STORYBOARD segment ${segment.sequence} must declare at least one semantic reference`,
      "FINAL_STORYBOARD_REFERENCE_INVALID"
    );
  }
  const seenAssetIds = new Set<string>();
  return declared.map((rawReference, referenceIndex) => {
    const reference = rawReference as unknown as Record<string, unknown>;
    const explicitStableId = String(reference.publicAssetId || reference.assetId || "").trim();
    const label = semanticLabelText(reference.label);
    const matchLabelIn = (candidatesOf: (item: SelectedConfirmedAsset) => readonly string[]) =>
      selectedAssets.filter((item) => candidatesOf(item).some((candidate) => candidate === label || candidate.includes(label) || label.includes(candidate)));
    let matches: SelectedConfirmedAsset[];
    if (explicitStableId) {
      matches = selectedAssets.filter((item) => item.stableId === explicitStableId);
    } else if (label) {
      // Two-tier resolution. Name-level identity (asset key / stable id / name /
      // tags) wins outright; the free-text description is only consulted when
      // the name tier finds nothing. Descriptions routinely mention OTHER
      // assets (e.g. a classmate's outfit note that contains 「数学老师」), so a
      // flat substring pool mis-resolves one-of-many and kills projection
      // (found in the 2026-09-12 Tier 1 real-model acceptance).
      const nameTier = matchLabelIn((item) => item.labels);
      matches = nameTier.length === 1
        ? nameTier
        : nameTier.length === 0
          ? matchLabelIn((item) => item.descriptionLabels)
          : nameTier;
    } else {
      matches = [];
    }
    if (matches.length !== 1) {
      throw projectionFailure(
        `No unique confirmed native asset for semantic reference ${String(reference.label || explicitStableId || "<empty>")}`,
        "FINAL_STORYBOARD_REFERENCE_UNRESOLVED"
      );
    }
    const matched = matches[0];
    if (seenAssetIds.has(matched.selectedAssetId)) {
      throw projectionFailure(
        `FINAL_STORYBOARD segment ${segment.sequence} declares the same native asset more than once`,
        "FINAL_STORYBOARD_REFERENCE_INVALID"
      );
    }
    seenAssetIds.add(matched.selectedAssetId);
    const semanticLabel = String(reference.label || "").trim();
    return {
      referenceId: String(reference.referenceId || matched.assetKey || `reference-${referenceIndex + 1}`).trim(),
      ordinal: referenceIndex + 1,
      assetKey: matched.assetKey,
      semanticLabel,
      assetId: matched.selectedAssetId
    };
  });
}

function referenceBindingsFromExistingShot(
  segment: CanonicalStoryboardSegment,
  shot: Shot
): ShotExecutionReferenceBindingInput[] {
  const existing = Array.isArray(shot.videosBatchReferenceBindings)
    ? shot.videosBatchReferenceBindings
    : [];
  if (!existing.length) return [];
  const declared = Array.isArray(segment.references) ? segment.references : [];
  if (existing.length !== declared.length) {
    throw projectionFailure(
      `Native shot ${shot.id} reference binding count does not match FINAL_STORYBOARD`,
      "FINAL_STORYBOARD_REFERENCE_INVALID"
    );
  }
  return existing.map((binding, index) => {
    const declaredLabel = String((declared[index] as unknown as Record<string, unknown>).label || "").trim();
    const persistedLabel = String(binding.semanticLabel || "").trim();
    if (!persistedLabel || semanticDisplayText(persistedLabel) !== semanticDisplayText(declaredLabel)) {
      throw projectionFailure(
        `Native shot ${shot.id} persisted semantic binding is stale for FINAL_STORYBOARD`,
        "FINAL_STORYBOARD_REFERENCE_INVALID"
      );
    }
    return {
      referenceId: binding.referenceId,
      ordinal: binding.ordinal,
      assetKey: binding.assetKey,
      semanticLabel: declaredLabel,
      assetId: binding.assetId
    };
  });
}

function referenceInputsForSegment(
  segment: CanonicalStoryboardSegment,
  options: VideosBatchProjectionOptions,
  existingShot: Shot | undefined,
  selectedAssets?: readonly SelectedConfirmedAsset[]
): ShotExecutionReferenceBindingInput[] {
  if (options.referenceBindings !== undefined) return [...options.referenceBindings];
  if (selectedAssets) return resolveReferenceBindingsForSegment(segment, selectedAssets);
  if (existingShot) return referenceBindingsFromExistingShot(segment, existingShot);
  return [];
}

function packageLineage(
  executionPackage: ShotExecutionPackage,
  assetPlan: unknown
): ShotExecutionPackageLineage {
  const wrapper = assetPlan as Record<string, unknown>;
  return {
    sourceRevision: executionPackage.sourceRevision,
    sourceHash: executionPackage.sourceHash,
    assetPlanRevision: executionPackage.assetPlanRevision,
    assetPlanHash: executionPackage.assetPlanHash,
    assetPlanStatus: "ready",
    assetPlanArtifactHash: canonicalContentHash(wrapper.artifact),
    assetPlanStyleSpec: executionPackage.visual.styleSpec,
    assetPlanNegativePrompt: executionPackage.visual.negativePrompt,
    assetPlan: wrapper as ShotExecutionPackageLineage["assetPlan"]
  };
}

function compiledPromptOrThrow(
  executionPackage: ShotExecutionPackage,
  assetPlan: unknown
): CompiledShotPrompt {
  const compiled = compileShotProviderPrompt(executionPackage, { current: packageLineage(executionPackage, assetPlan) });
  if (!isCompiledShotPrompt(compiled)) {
    throw projectionFailure(`Shot Provider Prompt 编译失败：${compiled.code} ${compiled.message}`, compiled.code);
  }
  return compiled;
}

function promptRendering(compiled: CompiledShotPrompt): "full" | "compact" {
  const fullText = compiled.sections.map((section) => section.text).join("\n\n");
  return compiled.text === fullText ? "full" : "compact";
}

function projectionAudit(
  metadata: ReturnType<typeof projectionMetadata>,
  executionPackage: ShotExecutionPackage,
  compiled: CompiledShotPrompt
) {
  return {
    videosBatchBatchId: metadata.batchId,
    videosBatchSourceRevision: metadata.sourceRevision,
    videosBatchSourceHash: metadata.sourceHash,
    videosBatchAssetPlanRevision: executionPackage.assetPlanRevision,
    videosBatchAssetPlanHash: executionPackage.assetPlanHash,
    videosBatchPackageContentHash: executionPackage.contentHash,
    videosBatchPromptHash: compiled.promptHash,
    videosBatchPromptCompilerVersion: compiled.compilerVersion,
    videosBatchPromptRendering: promptRendering(compiled)
  };
}

function assertExistingBindingAndLineage(
  shot: Shot,
  executionPackage: ShotExecutionPackage,
  compiled: CompiledShotPrompt,
  metadata: ReturnType<typeof projectionMetadata>
) {
  const expectedAudit = {
    videosBatchBatchId: metadata.batchId,
    videosBatchSourceRevision: executionPackage.sourceRevision,
    videosBatchSourceHash: executionPackage.sourceHash,
    videosBatchAssetPlanRevision: executionPackage.assetPlanRevision,
    videosBatchAssetPlanHash: executionPackage.assetPlanHash,
    videosBatchPackageContentHash: executionPackage.contentHash,
    videosBatchPromptHash: compiled.promptHash,
    videosBatchPromptCompilerVersion: compiled.compilerVersion,
    videosBatchPromptRendering: promptRendering(compiled)
  } as const;
  for (const [field, expected] of Object.entries(expectedAudit) as Array<[keyof typeof expectedAudit, unknown]>) {
    const actual = shot[field as keyof Shot];
    if (actual !== undefined && actual !== expected) {
      throw projectionFailure(`Native shot ${shot.id} has stale ${String(field)} lineage`, "FINAL_STORYBOARD_LINEAGE_STALE");
    }
  }

  const expectedAssetIds = executionPackage.references.map((reference) => reference.assetId);
  const existingBindings = Array.isArray(shot.videosBatchReferenceBindings)
    ? shot.videosBatchReferenceBindings
    : [];
  if (existingBindings.length) {
    if (existingBindings.length !== executionPackage.references.length) {
      throw projectionFailure(`Native shot ${shot.id} has stale reference bindings`, "FINAL_STORYBOARD_REFERENCE_INVALID");
    }
    existingBindings.forEach((binding, index) => {
      const expected = executionPackage.references[index];
      if (binding.ordinal !== index + 1
        || binding.assetId !== expected.assetId
        || binding.assetKey !== expected.assetKey
        || binding.referenceId !== expected.referenceId) {
        throw projectionFailure(`Native shot ${shot.id} reference binding lineage is stale`, "FINAL_STORYBOARD_REFERENCE_INVALID");
      }
    });
  }
  const existingAssetIds = Array.isArray(shot.assetIds) ? shot.assetIds : [];
  if (existingBindings.length && existingAssetIds.length !== expectedAssetIds.length) {
    throw projectionFailure(`Native shot ${shot.id} assetIds are incomplete for its binding snapshot`, "FINAL_STORYBOARD_REFERENCE_INVALID");
  }
  if (existingAssetIds.length && existingAssetIds.join("|") !== expectedAssetIds.join("|")) {
    throw projectionFailure(`Native shot ${shot.id} assetIds no longer match FINAL_STORYBOARD.references`, "FINAL_STORYBOARD_REFERENCE_INVALID");
  }
}

function packageScript(executionPackage: ShotExecutionPackage): string {
  return executionPackage.audioIntent.voices.map((event) => event.text).join("\n");
}

function packageCamera(executionPackage: ShotExecutionPackage): string {
  return executionPackage.visual.effects.map((effect) => effect.camera).join(" / ");
}

function packageSoundTimeline(executionPackage: ShotExecutionPackage): string[] {
  return executionPackage.audioIntent.sounds.map((event) => `${event.startSec}-${event.endSec}秒：${event.text}`);
}

function projectionPatchChanged(shot: Shot, patch: Partial<Shot>): boolean {
  return Object.entries(patch).some(([field, value]) => {
    const current = shot[field as keyof Shot];
    if (Array.isArray(value) || (value && typeof value === "object")) {
      return JSON.stringify(current) !== JSON.stringify(value);
    }
    return current !== value;
  });
}

/**
 * Project the persisted semantic ASSET_PLAN into SeeReel's native Asset store.
 * The model owns assetKey. The server owns the stable Pxxx-Axxx identity and
 * the native SeeReel Asset.id candidate identity.
 */
export async function projectAssetCandidatesIntoSeeReel(
  store: CinemaStore,
  sessionId: string,
  projectId: string,
  artifact: AssetPlanArtifact
): Promise<AssetCandidatesArtifact> {
  if (!store.getSession(sessionId)) throw new Error(`Session not found: ${sessionId}`);
  if (!projectId.trim()) throw new Error("projectId is required for stable asset numbering");

  const planned = artifact.items || [];
  if (!planned.length) throw new Error("ASSET_PLAN requires at least one item before candidate generation");

  const keys = planned.map((item) => String(item.assetKey || "").trim());
  if (keys.some((key) => !key)) throw new Error("Every ASSET_PLAN item requires assetKey");
  if (new Set(keys).size !== keys.length) throw new Error("ASSET_PLAN assetKey values must be unique");

  const scopedAssets = store.snapshot().assets.filter((asset) => asset.ownerSessionId === sessionId);
  const existingByKey = new Map<string, Asset>();
  const usedPublicIds = new Set<string>();
  const claimedPublicIds = new Set<string>();
  let nextNumber = 0;
  for (const asset of scopedAssets) {
    const stableId = String(asset.workflowReferenceId || "").trim();
    if (stableId) {
      usedPublicIds.add(stableId);
      nextNumber = Math.max(nextNumber, stableIdNumber(stableId, projectId.trim()) || 0);
    }
    const assetKey = assetKeyFromNativeAsset(asset);
    if (assetKey && !existingByKey.has(assetKey.toLowerCase())) existingByKey.set(assetKey.toLowerCase(), asset);
  }

  const allocateStableId = () => {
    do { nextNumber += 1; } while (usedPublicIds.has(`${projectId.trim()}-A${String(nextNumber).padStart(3, "0")}`));
    const stableId = `${projectId.trim()}-A${String(nextNumber).padStart(3, "0")}`;
    usedPublicIds.add(stableId);
    return stableId;
  };

  const items: AssetCandidateItem[] = [];
  for (let index = 0; index < planned.length; index += 1) {
    const item = planned[index];
    const key = String(item.assetKey).trim();
    const existing = existingByKey.get(key.toLowerCase());
    const existingStableId = String(existing?.workflowReferenceId || "").trim();
    // `usedPublicIds` describes IDs already present in the session; it must not
    // be used as a per-run claim marker. A second plan item can otherwise force
    // a fresh ID (and the old implementation even referenced the value being
    // initialized). Keep the stable ID for its assetKey and claim it separately
    // for this projection pass.
    const reusableStableId = existingStableId
      && stableIdNumber(existingStableId, projectId.trim()) !== undefined
      && !claimedPublicIds.has(existingStableId)
      ? existingStableId
      : undefined;
    const stableId: string = reusableStableId || allocateStableId();
    claimedPublicIds.add(stableId);
    const description = [
      item.description?.trim(),
      item.sourceEvidence?.trim(),
      item.continuityNotes?.trim()
    ].filter(Boolean).join(" · ");

    try {
      const tags = [...new Set([
        "videosbatch",
        item.assetKey,
        `videosbatch:${item.assetKey}`,
        ...(existing?.tags || [])
      ])];
      const asset = await store.upsertAsset({
        ...(existing ? { id: existing.id } : {}),
        workflowReferenceId: stableId,
        videosBatchAssetKey: item.assetKey,
        ownerSessionId: sessionId,
        name: item.name?.trim() || item.assetKey,
        type: mapAssetType(item.category),
        description,
        prompt: item.prompt?.trim() || "",
        tags,
        ...(existing ? {} : { mediaKind: "none" as const })
      });
      if (!asset) throw new Error(`Failed to project asset candidate ${stableId}`);

      items.push({
        assetKey: item.assetKey,
        publicAssetId: stableId,
        candidateAssetIds: [asset.id],
        status: "ready"
      });
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, " ").slice(0, 1_000);
      items.push({
        assetKey: item.assetKey,
        publicAssetId: stableId,
        candidateAssetIds: [],
        status: "failed",
        error: { code: "ASSET_PROJECTION_FAILED", message }
      });
    }
  }

  return { items };
}

/**
 * Project the canonical FINAL_STORYBOARD into native SeeReel Shot rows. The
 * structured storyboard remains authoritative; the native Shot is the runtime
 * execution/inspection projection.
 */
export async function projectFinalStoryboardIntoSeeReel(
  store: CinemaStore,
  sessionId: string,
  artifact: FinalStoryboardArtifact,
  options: VideosBatchProjectionOptions = {}
): Promise<Shot[]> {
  const session = store.getSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const canonical = canonicalProjection(artifact);
  const metadata = projectionMetadata(canonical, options);
  if (options.assetPlan === undefined) {
    throw projectionFailure(
      "FINAL_STORYBOARD projection requires the current ready ASSET_PLAN stage wrapper",
      "ASSET_PLAN_LINEAGE_STALE"
    );
  }
  const planned = canonical.segments;
  if (!planned.length) {
    throw projectionFailure("FINAL_STORYBOARD must contain at least one canonical segment", "FINAL_STORYBOARD_INVALID");
  }
  const existing = [...session.shots].sort((a, b) => a.index - b.index);
  const existingBatch = existing.filter((shot) => shot.videosBatchBatchId === metadata.batchId);
  const selectedAssets = options.assetConfirmation
    ? selectedConfirmedAssets(store, sessionId, options.assetConfirmation)
    : undefined;
  const usedShotIds = new Set<string>();
  const prepared: Array<{
    segment: CanonicalStoryboardSegment;
    existingShot?: Shot;
    executionPackage: ShotExecutionPackage;
    compiled: CompiledShotPrompt;
  }> = [];

  // Compile every segment before touching the store. A malformed wrapper,
  // stale lineage, or unresolved binding must leave the existing native graph
  // unchanged instead of producing a partially projected batch.
  for (let index = 0; index < planned.length; index += 1) {
    const segment = planned[index];
    const runtimePointer = segment.nativeShotId
      ? existing.find((shot) => shot.id === segment.nativeShotId)
      : undefined;
    if (segment.nativeShotId && !runtimePointer) {
      throw projectionFailure(
        `FINAL_STORYBOARD segment ${segment.sequence} points to missing native Shot ${segment.nativeShotId}`,
        "FINAL_STORYBOARD_LINEAGE_STALE"
      );
    }
    const pointerIsOldBatch = Boolean(runtimePointer && shouldIgnoreRuntimePointerForNewBatch(runtimePointer, metadata));
    if (runtimePointer && !pointerIsOldBatch && !canAdoptShotForBatch(runtimePointer, metadata)) {
      throw projectionFailure(
        `FINAL_STORYBOARD segment ${segment.sequence} points to a native Shot from a different lineage`,
        "FINAL_STORYBOARD_LINEAGE_STALE"
      );
    }
    const explicitlyLinked = runtimePointer && !pointerIsOldBatch && canAdoptShotForBatch(runtimePointer, metadata)
      ? runtimePointer
      // `Shot.index` is session-global because native SeeReel also contains
      // non-VideosBatch shots and historical batches. Resolve an unlinked
      // re-projection by position inside the current batch instead of assuming
      // that every batch starts at index 1.
      : existingBatch[index];
    const existingShot = explicitlyLinked;
    if (existingShot && usedShotIds.has(existingShot.id)) {
      throw projectionFailure(
        `FINAL_STORYBOARD segments resolve to the same native Shot ${existingShot.id}`,
        "FINAL_STORYBOARD_LINEAGE_STALE"
      );
    }
    if (existingShot) usedShotIds.add(existingShot.id);

    const referenceBindings = referenceInputsForSegment(segment, options, existingShot, selectedAssets);
    const executionPackage = buildShotExecutionPackageFromStoryboard({
      finalStoryboard: canonical,
      segment,
      sourceRevision: metadata.sourceRevision,
      sourceHash: metadata.sourceHash,
      assetPlan: options.assetPlan,
      screenplay: options.screenplay,
      ...(options.teaching ? { teaching: options.teaching } : {}),
      referenceBindings
    });
    const compiled = compiledPromptOrThrow(executionPackage, options.assetPlan);
    if (existingShot) assertExistingBindingAndLineage(existingShot, executionPackage, compiled, metadata);
    prepared.push({ segment, existingShot, executionPackage, compiled });
  }

  const projected: Shot[] = [];
  for (const item of prepared) {
    const { segment, existingShot, executionPackage, compiled } = item;
    const script = packageScript(executionPackage);
    const camera = packageCamera(executionPackage);
    const soundTimeline = packageSoundTimeline(executionPackage);
    const audit = projectionAudit(metadata, executionPackage, compiled);
    const contentChanged = Boolean(existingShot && (
      existingShot.rawPrompt !== compiled.text
      || existingShot.prompt !== compiled.text
      || existingShot.script !== script
      || existingShot.camera !== camera
      || existingShot.durationSec !== 10
      || existingShot.videosBatchBatchId !== audit.videosBatchBatchId
      || existingShot.videosBatchSourceRevision !== audit.videosBatchSourceRevision
      || existingShot.videosBatchSourceHash !== audit.videosBatchSourceHash
      || existingShot.videosBatchAssetPlanRevision !== audit.videosBatchAssetPlanRevision
      || existingShot.videosBatchAssetPlanHash !== audit.videosBatchAssetPlanHash
      || existingShot.videosBatchPackageContentHash !== audit.videosBatchPackageContentHash
      || existingShot.videosBatchPromptHash !== audit.videosBatchPromptHash
      || existingShot.videosBatchPromptCompilerVersion !== audit.videosBatchPromptCompilerVersion
      || existingShot.videosBatchPromptRendering !== audit.videosBatchPromptRendering
    ));
    const patch: Partial<Shot> = {
      title: `分镜 ${String(segment.sequence || projected.length + 1).padStart(2, "0")}`,
      script,
      camera,
      durationSec: 10,
      rawPrompt: compiled.text,
      prompt: compiled.text,
      ...audit,
      ...(contentChanged || !existingShot?.videoUrl ? { status: "draft" as const } : {}),
      ...(soundTimeline.length ? { debugNote: `VideosBatch 音效时间线：${soundTimeline.join("；")}` } : {})
    };

    let shot = existingShot;
    if (!shot) {
      shot = await store.appendShot(sessionId, patch);
    } else if (projectionPatchChanged(shot, patch)) {
      shot = await store.updateShot(shot.id, patch);
    }
    if (!shot) throw new Error(`Failed to project final storyboard segment ${segment.sequence}`);
    // CinemaStore.appendShot intentionally carries only a conservative subset
    // of optional Shot fields. Ensure the audit fields are persisted on new rows
    // without changing existing ordered asset bindings.
    if (projectionPatchChanged(shot, patch)) {
      const annotated = await store.updateShot(shot.id, patch);
      if (!annotated) throw new Error(`Failed to persist execution audit for final storyboard segment ${segment.sequence}`);
      shot = annotated;
    }
    projected.push(shot);
  }

  const rawSegments = Array.isArray(artifact.segments) ? artifact.segments : [];
  projected.forEach((shot, index) => {
    const rawSegment = rawSegments[index];
    if (rawSegment && typeof rawSegment === "object") rawSegment.nativeShotId = shot.id;
  });
  return projected;
}

/**
 * Resolve canonical public references to the user's confirmed native assets at
 * execution time. This updates the ordered native asset ids and binding snapshot;
 * it never rewrites FINAL_STORYBOARD or derives execution truth from COPYABLE_PROMPT.
 */
export async function applyConfirmedReferencesToNativeShots(
  store: CinemaStore,
  sessionId: string,
  storyboard: FinalStoryboardArtifact,
  confirmation: AssetConfirmationArtifact,
  options: VideosBatchProjectionOptions = {}
): Promise<Shot[]> {
  const session = store.getSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const canonical = canonicalProjection(storyboard);
  const metadata = projectionMetadata(canonical, options);
  const currentAssetPlan = currentAssetPlanForExecution(store, sessionId, options);
  const selectedAssets = selectedConfirmedAssets(store, sessionId, confirmation);
  const nativeShots = [...session.shots].sort((a, b) => a.index - b.index);
  const currentBatchShots = nativeShots.filter((shot) => shot.videosBatchBatchId === metadata.batchId);
  const prepared: Array<{ segment: CanonicalStoryboardSegment; nativeShot: Shot; bindings: VideosBatchReferenceBinding[] }> = [];
  const usedShotIds = new Set<string>();

  // Resolve and validate the complete ordered binding plan before persisting
  // any Shot. This keeps a missing/foreign asset from partially rewiring a batch.
  for (let index = 0; index < canonical.segments.length; index += 1) {
    const segment = canonical.segments[index];
    const runtimePointer = segment.nativeShotId
      ? nativeShots.find((shot) => shot.id === segment.nativeShotId)
      : undefined;
    if (segment.nativeShotId && !runtimePointer) {
      throw projectionFailure(
        `FINAL_STORYBOARD segment ${segment.sequence} points to missing native Shot ${segment.nativeShotId}`,
        "FINAL_STORYBOARD_LINEAGE_STALE"
      );
    }
    const pointerIsOldBatch = Boolean(runtimePointer && shouldIgnoreRuntimePointerForNewBatch(runtimePointer, metadata));
    if (runtimePointer && !pointerIsOldBatch && !canAdoptShotForBatch(runtimePointer, metadata)) {
      throw projectionFailure(
        `FINAL_STORYBOARD segment ${segment.sequence} points to a native Shot from a different lineage`,
        "FINAL_STORYBOARD_LINEAGE_STALE"
      );
    }
    const explicitlyLinked = runtimePointer && !pointerIsOldBatch && canAdoptShotForBatch(runtimePointer, metadata)
      ? runtimePointer
      : currentBatchShots[index];
    const nativeShot = explicitlyLinked;
    if (!nativeShot) throw new Error(`Native shot not found for final storyboard segment ${index + 1}`);
    if (usedShotIds.has(nativeShot.id)) {
      throw projectionFailure(
        `FINAL_STORYBOARD segments resolve to the same native Shot ${nativeShot.id}`,
        "FINAL_STORYBOARD_LINEAGE_STALE"
      );
    }
    usedShotIds.add(nativeShot.id);
    if (nativeShot.videosBatchAssetPlanRevision !== currentAssetPlan.revision
      || nativeShot.videosBatchAssetPlanHash !== currentAssetPlan.hash) {
      throw projectionFailure(
        `Native shot ${nativeShot.id} ASSET_PLAN lineage is stale; reproject FINAL_STORYBOARD first`,
        "ASSET_PLAN_LINEAGE_STALE"
      );
    }
    if (nativeShot.videosBatchBatchId !== metadata.batchId
      || nativeShot.videosBatchSourceRevision !== metadata.sourceRevision
      || nativeShot.videosBatchSourceHash !== metadata.sourceHash
      || !Number.isInteger(nativeShot.videosBatchAssetPlanRevision)
      || !HASH_PATTERN.test(String(nativeShot.videosBatchAssetPlanHash || ""))
      || !HASH_PATTERN.test(String(nativeShot.videosBatchPackageContentHash || ""))
      || !HASH_PATTERN.test(String(nativeShot.videosBatchPromptHash || ""))
      || !nativeShot.videosBatchPromptCompilerVersion
      || !["full", "compact"].includes(nativeShot.videosBatchPromptRendering || "")) {
      throw projectionFailure(
        `Native shot ${nativeShot.id} has stale or incomplete ShotExecutionPackage/Provider Prompt lineage; reproject FINAL_STORYBOARD first`,
        "FINAL_STORYBOARD_LINEAGE_STALE"
      );
    }

    const previousBindings = new Map(
      (nativeShot.videosBatchReferenceBindings || []).map((binding) => [binding.assetId, binding])
    );
    const resolved = resolveReferenceBindingsForSegment(segment, selectedAssets);
    const bindings: VideosBatchReferenceBinding[] = resolved.map((binding) => {
      const previous = previousBindings.get(String(binding.assetId));
      return {
        referenceId: String(binding.referenceId),
        ordinal: Number(binding.ordinal),
        assetKey: String(binding.assetKey),
        assetId: String(binding.assetId),
        semanticLabel: semanticDisplayText(binding.semanticLabel),
        // Reprojection must not erase a resolved content address: the media stage
        // re-verifies it against the exact bytes before any paid submission.
        ...(previous?.imageUrlHash ? { imageUrlHash: previous.imageUrlHash } : {}),
        ...(previous?.bytesSha256 ? { bytesSha256: previous.bytesSha256 } : {}),
        ...(previous?.byteSize !== undefined ? { byteSize: previous.byteSize } : {}),
        ...(previous?.mimeType ? { mimeType: previous.mimeType } : {})
      };
    });
    if (!bindings.length) throw new Error(`Final storyboard segment ${index + 1} has no resolvable confirmed asset references`);
    prepared.push({ segment, nativeShot, bindings });
  }

  const updated: Shot[] = [];
  for (const item of prepared) {
    const { segment, nativeShot, bindings } = item;
    const patch: Partial<Shot> = {
      assetIds: bindings.map((binding) => binding.assetId),
      videosBatchReferenceBindings: bindings,
      videosBatchBatchId: metadata.batchId,
      videosBatchSourceRevision: metadata.sourceRevision,
      videosBatchSourceHash: metadata.sourceHash
    };
    const shot = projectionPatchChanged(nativeShot, patch)
      ? await store.updateShot(nativeShot.id, patch)
      : nativeShot;
    if (!shot) throw new Error(`Failed to resolve references for native shot ${nativeShot.id}`);
    segment.nativeShotId = shot.id;
    updated.push(shot);
  }

  return updated;
}
