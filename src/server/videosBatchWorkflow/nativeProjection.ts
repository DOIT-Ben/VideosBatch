import type { Asset, AssetType, Shot } from "../../shared/types";
import "../../shared/videosBatchNativeProjection";
import type { CinemaStore } from "../store";

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

function publicAssetId(projectId: string, index: number) {
  return `${projectId}-A${String(index + 1).padStart(3, "0")}`;
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

  const existingByPublicId = new Map(
    store.snapshot().assets
      .filter((asset) => asset.ownerSessionId === sessionId && asset.workflowReferenceId)
      .map((asset) => [asset.workflowReferenceId!, asset])
  );

  const items: AssetCandidateItem[] = [];
  for (let index = 0; index < planned.length; index += 1) {
    const item = planned[index];
    const stableId = publicAssetId(projectId.trim(), index);
    const existing = existingByPublicId.get(stableId);
    const description = [
      item.description?.trim(),
      item.sourceEvidence?.trim(),
      item.continuityNotes?.trim()
    ].filter(Boolean).join(" · ");

    const asset = await store.upsertAsset({
      ...(existing ? { id: existing.id } : {}),
      workflowReferenceId: stableId,
      ownerSessionId: sessionId,
      name: item.name?.trim() || item.assetKey,
      type: mapAssetType(item.category),
      description,
      prompt: item.prompt?.trim() || "",
      ...(existing ? {} : { mediaKind: "none" as const, tags: ["videosbatch", item.assetKey] })
    });
    if (!asset) throw new Error(`Failed to project asset candidate ${stableId}`);

    items.push({
      assetKey: item.assetKey,
      publicAssetId: stableId,
      candidateAssetIds: [asset.id]
    });
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
  artifact: FinalStoryboardArtifact
): Promise<Shot[]> {
  const session = store.getSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const planned = artifact.segments || [];
  const existing = [...session.shots].sort((a, b) => a.index - b.index);
  const projected: Shot[] = [];

  for (let index = 0; index < planned.length; index += 1) {
    const segment = planned[index];
    const subshots = segment.subshots || [];
    const script = [segment.narration, ...subshots.map((item) => item.voice)]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join("\n");
    const camera = subshots
      .map((item) => String(item.camera || "").trim())
      .filter(Boolean)
      .join(" / ");
    const prompt = String(segment.visualPrompt || "").trim();

    const patch: Partial<Shot> = {
      title: `分镜 ${String(segment.sequence || index + 1).padStart(2, "0")}`,
      script,
      camera,
      durationSec: 10,
      assetIds: [],
      rawPrompt: prompt,
      prompt,
      status: "draft"
    };

    const shot = existing[index]
      ? await store.updateShot(existing[index].id, patch)
      : await store.appendShot(sessionId, patch);
    if (!shot) throw new Error(`Failed to project final storyboard segment ${index + 1}`);
    segment.nativeShotId = shot.id;
    projected.push(shot);
  }

  return projected;
}

/**
 * Resolve canonical public references to the user's confirmed native assets at
 * execution time. This updates native Shot.assetIds only; it never rewrites the
 * FINAL_STORYBOARD or derives execution truth from COPYABLE_PROMPT.
 */
export async function applyConfirmedReferencesToNativeShots(
  store: CinemaStore,
  sessionId: string,
  storyboard: FinalStoryboardArtifact,
  confirmation: AssetConfirmationArtifact
): Promise<Shot[]> {
  const session = store.getSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (confirmation.confirmed !== true) throw new Error("Assets must be confirmed before execution");

  const selectedByPublicId = new Map(
    (confirmation.items || []).map((item) => [String(item.publicAssetId || ""), String(item.selectedAssetId || "")])
  );
  const nativeShots = [...session.shots].sort((a, b) => a.index - b.index);
  const updated: Shot[] = [];

  for (let index = 0; index < (storyboard.segments || []).length; index += 1) {
    const segment = storyboard.segments![index];
    const nativeShot = segment.nativeShotId
      ? nativeShots.find((shot) => shot.id === segment.nativeShotId)
      : nativeShots[index];
    if (!nativeShot) throw new Error(`Native shot not found for final storyboard segment ${index + 1}`);

    const publicIds = (segment.references || [])
      .map((reference) => String(reference.publicAssetId || reference.assetId || "").trim())
      .filter(Boolean);
    const resolved = publicIds.map((stableId) => {
      const nativeAssetId = selectedByPublicId.get(stableId);
      if (!nativeAssetId) throw new Error(`No confirmed native asset for stable reference ${stableId}`);
      return nativeAssetId;
    });

    const shot = await store.updateShot(nativeShot.id, {
      assetIds: [...new Set(resolved)],
      rawPrompt: String(segment.visualPrompt || nativeShot.rawPrompt || "").trim(),
      prompt: String(segment.visualPrompt || nativeShot.prompt || "").trim()
    });
    if (!shot) throw new Error(`Failed to resolve references for native shot ${nativeShot.id}`);
    segment.nativeShotId = shot.id;
    updated.push(shot);
  }

  return updated;
}
