import type { Asset, AssetType, Shot } from "../../shared/types";
import "../../shared/videosBatchNativeProjection";
import type { VideosBatchReferenceBinding } from "../../shared/videosBatchNativeProjection";
import type { CinemaStore } from "../store";
import {
  canonicalRoleField,
  canonicalSupportField,
  canonicalStoryboardBatchId,
  canonicalStoryboardSourceHash,
  normalizeStoryboardArtifact,
  segmentSoundText,
  segmentVoiceText,
  semanticLabelText as canonicalSemanticLabelText,
  type CanonicalStoryboardArtifact,
  type CanonicalStoryboardSegment
} from "./canonicalStoryboard";

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

function mapAssetType(category: string | undefined): AssetType {
  switch ((category || "").trim().toUpperCase()) {
    case "CHARACTER": return "character";
    case "SCENE": return "scene";
    case "PROP": return "prop";
    default: return "other";
  }
}

export interface VideosBatchProjectionOptions {
  /** Revision of the source FINAL_STORYBOARD stage (or 0 for direct legacy callers). */
  sourceRevision?: number;
  /** Canonical source hash that excludes native projection pointers. */
  sourceHash?: string;
  /** Explicit batch id for callers that already computed one. */
  batchId?: string;
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

function projectionMetadata(artifact: FinalStoryboardArtifact, options: VideosBatchProjectionOptions = {}) {
  const sourceRevision = Math.max(0, Number(options.sourceRevision) || 0);
  const sourceHash = String(options.sourceHash || "").trim() || canonicalStoryboardSourceHash(artifact);
  const batchId = String(options.batchId || "").trim() || canonicalStoryboardBatchId(artifact, sourceRevision, sourceHash);
  if (!batchId) throw new Error("FINAL_STORYBOARD source batch metadata is unavailable");
  return { sourceRevision, sourceHash, batchId };
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

function uniqueText(values: unknown[]) {
  const output: string[] = [];
  for (const value of values) {
    const item = String(value ?? "").trim();
    if (!item || item === "无" || output.includes(item)) continue;
    output.push(item);
  }
  return output;
}

function canonicalPromptParts(segment: CanonicalStoryboardSegment, type: CanonicalStoryboardArtifact["storyType"]) {
  const role = canonicalRoleField(type);
  const support = canonicalSupportField(type);
  const effects = Array.isArray(segment.visualEffects) ? segment.visualEffects : [];
  return [
    segment.scene,
    segment[role],
    segment[support],
    ...effects.flatMap((effect) => [effect.visual, effect.action])
  ].map((value) => String(value ?? "").trim()).filter(Boolean);
}

function canonicalProjection(artifact: FinalStoryboardArtifact) {
  const normalized = normalizeStoryboardArtifact(artifact);
  if (!normalized) throw new Error("FINAL_STORYBOARD must be a canonical storyboard with a valid storyType");
  return normalized;
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
  const planned = canonical.segments;
  const existing = [...session.shots].sort((a, b) => a.index - b.index);
  const existingBatch = existing.filter((shot) => shot.videosBatchBatchId === metadata.batchId);
  const projected: Shot[] = [];

  for (let index = 0; index < planned.length; index += 1) {
    const segment = planned[index];
    const effects = Array.isArray(segment.visualEffects) ? segment.visualEffects : [];
    const script = uniqueText(segmentVoiceText(segment).split("\n")).join("\n");
    const camera = uniqueText(effects.map((item) => item.camera)).join(" / ");
    const prompt = canonicalPromptParts(segment, canonical.storyType).join("\n");
    const soundTimeline = uniqueText(segmentSoundText(segment).split("；"));
    const explicitlyLinked = segment.nativeShotId
      ? existing.find((shot) => shot.id === segment.nativeShotId)
      : undefined;
    const existingShot = explicitlyLinked && canAdoptShotForBatch(explicitlyLinked, metadata)
      ? explicitlyLinked
      // `Shot.index` is session-global because native SeeReel also contains
      // non-VideosBatch shots and historical batches. Resolve an unlinked
      // re-projection by position inside the current batch instead of assuming
      // that every batch starts at index 1.
      : existingBatch[index];
    const contentChanged = Boolean(existingShot && (
      existingShot.rawPrompt !== prompt
      || existingShot.prompt !== prompt
      || existingShot.script !== script
      || existingShot.camera !== camera
      || existingShot.durationSec !== 10
    ));

    const patch: Partial<Shot> = {
      title: `分镜 ${String(segment.sequence || index + 1).padStart(2, "0")}`,
      script,
      camera,
      durationSec: 10,
      assetIds: [],
      videosBatchReferenceBindings: undefined,
      rawPrompt: prompt,
      prompt,
      videosBatchBatchId: metadata.batchId,
      videosBatchSourceRevision: metadata.sourceRevision,
      videosBatchSourceHash: metadata.sourceHash,
      ...(contentChanged || !existingShot?.videoUrl ? { status: "draft" as const } : {}),
      ...(soundTimeline.length ? { debugNote: `VideosBatch 音效时间线：${soundTimeline.join("；")}` } : {})
    };

    let shot = existingShot
      ? await store.updateShot(existingShot.id, patch)
      : await store.appendShot(sessionId, patch);
    if (!shot) throw new Error(`Failed to project final storyboard segment ${index + 1}`);
    // CinemaStore.appendShot intentionally constructs a conservative default
    // Shot shape and does not carry every optional field from `partial`. Stamp
    // projection metadata explicitly so a newly saved storyboard is immediately
    // associated with its own native batch, before media execution begins.
    if (shot.videosBatchBatchId !== metadata.batchId
      || shot.videosBatchSourceRevision !== metadata.sourceRevision
      || shot.videosBatchSourceHash !== metadata.sourceHash) {
      const annotated = await store.updateShot(shot.id, {
        videosBatchBatchId: metadata.batchId,
        videosBatchSourceRevision: metadata.sourceRevision,
        videosBatchSourceHash: metadata.sourceHash
      });
      if (!annotated) throw new Error(`Failed to persist VideosBatch batch metadata for final storyboard segment ${index + 1}`);
      shot = annotated;
    }
    const rawSegment = (artifact.segments || [])[index];
    if (rawSegment && typeof rawSegment === "object") rawSegment.nativeShotId = shot.id;
    projected.push(shot);
  }

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
  if (confirmation.confirmed !== true) throw new Error("Assets must be confirmed before execution");

  const canonical = canonicalProjection(storyboard);
  const metadata = projectionMetadata(canonical, options);
  const snapshot = store.snapshot();
  const sessionShotIds = new Set(session.shots.map((shot) => shot.id));
  const selectedAssets = (confirmation.items || [])
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
      if (!asset || !ownedBySession) return undefined;
      return {
        stableId,
        selectedAssetId,
        assetKey: String(item.assetKey || assetKeyFromNativeAsset(asset) || asset.name || stableId).trim(),
        asset,
        labels: [item.assetKey, stableId, asset?.name, asset?.description, ...(asset?.tags || [])]
          .map(semanticLabelText)
          .filter(Boolean)
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item && item.stableId && item.selectedAssetId));
  const nativeShots = [...session.shots].sort((a, b) => a.index - b.index);
  const currentBatchShots = nativeShots.filter((shot) => shot.videosBatchBatchId === metadata.batchId);
  const updated: Shot[] = [];

  for (let index = 0; index < canonical.segments.length; index += 1) {
    const segment = canonical.segments[index];
    const explicitlyLinked = segment.nativeShotId
      ? nativeShots.find((shot) => shot.id === segment.nativeShotId)
      : undefined;
    const nativeShot = explicitlyLinked && canAdoptShotForBatch(explicitlyLinked, metadata)
      ? explicitlyLinked
      : currentBatchShots[index];
    if (!nativeShot) throw new Error(`Native shot not found for final storyboard segment ${index + 1}`);

    const previousBindings = new Map(
      (nativeShot.videosBatchReferenceBindings || []).map((binding) => [binding.assetId, binding])
    );
    const bindings: VideosBatchReferenceBinding[] = [];
    const seenAssetIds = new Set<string>();
    for (const [referenceIndex, reference] of (segment.references || []).entries()) {
      const referenceRecord = reference as Record<string, unknown>;
      const explicitStableId = String(referenceRecord.publicAssetId || referenceRecord.assetId || "").trim();
      const label = semanticLabelText(reference.label);
      const matched = explicitStableId
        ? selectedAssets.find((item) => item.stableId === explicitStableId)
        : selectedAssets.find((item) => item.labels.some((candidate) => candidate === label || candidate.includes(label) || label.includes(candidate)));
      if (!matched) throw new Error(`No confirmed native asset for semantic reference ${String(reference.label || explicitStableId || "<empty>")}`);
      if (seenAssetIds.has(matched.selectedAssetId)) continue;
      seenAssetIds.add(matched.selectedAssetId);
      const semanticLabel = semanticDisplayText(reference.label) || matched.asset.name || matched.assetKey;
      const referenceId = String(referenceRecord.referenceId || matched.assetKey || semanticLabel || `reference-${referenceIndex + 1}`).trim();
      const previous = previousBindings.get(matched.selectedAssetId);
      bindings.push({
        referenceId,
        ordinal: bindings.length + 1,
        assetKey: matched.assetKey,
        assetId: matched.selectedAssetId,
        semanticLabel,
        ...(previous?.imageUrlHash ? { imageUrlHash: previous.imageUrlHash } : {})
      });
    }
    if (!bindings.length) throw new Error(`Final storyboard segment ${index + 1} has no resolvable confirmed asset references`);

    const prompt = canonicalPromptParts(segment, canonical.storyType).join("\n");

    const shot = await store.updateShot(nativeShot.id, {
      assetIds: bindings.map((binding) => binding.assetId),
      videosBatchReferenceBindings: bindings,
      rawPrompt: prompt,
      prompt,
      videosBatchBatchId: metadata.batchId,
      videosBatchSourceRevision: metadata.sourceRevision,
      videosBatchSourceHash: metadata.sourceHash
    });
    if (!shot) throw new Error(`Failed to resolve references for native shot ${nativeShot.id}`);
    segment.nativeShotId = shot.id;
    updated.push(shot);
  }

  return updated;
}
