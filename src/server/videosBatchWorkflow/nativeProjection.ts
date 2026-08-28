import type { Asset, AssetType, Shot } from "../../shared/types";
import "../../shared/videosBatchNativeProjection";
import type { CinemaStore } from "../store";

type AssetPlanItem = {
  referenceId: string;
  type?: string;
  name?: string;
  source?: string;
  usage?: string;
  prompt?: string;
};

type AssetPlanArtifact = {
  assets?: AssetPlanItem[];
};

type StoryboardPlanItem = {
  id?: string;
  nativeShotId?: string;
  title?: string;
  script?: string;
  camera?: string;
  durationSec?: number;
  prompt?: string;
};

type StoryboardArtifact = {
  shots?: StoryboardPlanItem[];
};

type BoundShotItem = {
  id?: string;
  nativeShotId?: string;
  assetIds?: string[];
  prompt?: string;
};

type ReferenceBindingArtifact = {
  shots?: BoundShotItem[];
};

function mapAssetType(type: string | undefined): AssetType {
  switch ((type || "").trim().toLowerCase()) {
    case "character":
      return "character";
    case "scene":
      return "scene";
    case "prop":
      return "prop";
    default:
      return "other";
  }
}

function stableRef(value: string | undefined) {
  return (value || "").trim();
}

export async function projectAssetsIntoSeeReel(
  store: CinemaStore,
  sessionId: string,
  artifact: AssetPlanArtifact
): Promise<Asset[]> {
  if (!store.getSession(sessionId)) throw new Error(`Session not found: ${sessionId}`);

  const planned = artifact.assets || [];
  const refs = planned.map((item) => stableRef(item.referenceId));
  if (refs.some((ref) => !ref)) throw new Error("Every planned asset requires referenceId");
  if (new Set(refs).size !== refs.length) throw new Error("Planned asset referenceId values must be unique");

  const existingByRef = new Map(
    store.snapshot().assets
      .filter((asset) => asset.ownerSessionId === sessionId && asset.workflowReferenceId)
      .map((asset) => [asset.workflowReferenceId!, asset])
  );

  const projected: Asset[] = [];
  for (const item of planned) {
    const referenceId = stableRef(item.referenceId);
    const existing = existingByRef.get(referenceId);
    const description = [item.source?.trim(), item.usage?.trim()].filter(Boolean).join(" · ");
    const patch: Partial<Asset> = {
      ...(existing ? { id: existing.id } : {}),
      workflowReferenceId: referenceId,
      ownerSessionId: sessionId,
      name: item.name?.trim() || referenceId,
      type: mapAssetType(item.type),
      description,
      prompt: item.prompt?.trim() || "",
      ...(existing ? {} : { mediaKind: "none" as const, tags: ["videosbatch"] })
    };
    const asset = await store.upsertAsset(patch);
    if (!asset) throw new Error(`Failed to project asset ${referenceId}`);
    projected.push(asset);
  }

  return projected;
}

export async function projectStoryboardIntoSeeReel(
  store: CinemaStore,
  sessionId: string,
  artifact: StoryboardArtifact
): Promise<Shot[]> {
  const session = store.getSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const planned = artifact.shots || [];
  const existing = [...session.shots].sort((a, b) => a.index - b.index);
  const projected: Shot[] = [];

  for (let index = 0; index < planned.length; index += 1) {
    const item = planned[index];
    const patch: Partial<Shot> = {
      title: item.title?.trim() || `Shot ${index + 1}`,
      script: item.script?.trim() || "",
      camera: item.camera?.trim() || "",
      durationSec: Math.max(1, Math.min(15, Number(item.durationSec) || 10)),
      assetIds: [],
      rawPrompt: item.prompt?.trim() || "",
      prompt: item.prompt?.trim() || "",
      status: "draft"
    };

    const shot = existing[index]
      ? await store.updateShot(existing[index].id, patch)
      : await store.appendShot(sessionId, patch);
    if (!shot) throw new Error(`Failed to project storyboard shot ${index + 1}`);
    item.nativeShotId = shot.id;
    projected.push(shot);
  }

  return projected;
}

export async function bindStableReferencesIntoShots(
  store: CinemaStore,
  sessionId: string,
  artifact: ReferenceBindingArtifact
): Promise<Shot[]> {
  const session = store.getSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const nativeShots = [...session.shots].sort((a, b) => a.index - b.index);
  const assetByStableRef = new Map(
    store.snapshot().assets
      .filter((asset) => asset.ownerSessionId === sessionId && asset.workflowReferenceId)
      .map((asset) => [asset.workflowReferenceId!, asset.id])
  );

  const updated: Shot[] = [];
  for (let index = 0; index < (artifact.shots || []).length; index += 1) {
    const item = artifact.shots![index];
    const nativeShot = item.nativeShotId
      ? nativeShots.find((shot) => shot.id === item.nativeShotId)
      : nativeShots[index];
    if (!nativeShot) throw new Error(`Native shot not found for bound storyboard item ${item.id || index + 1}`);

    const stableIds = item.assetIds || [];
    const resolved = stableIds.map((referenceId) => {
      const assetId = assetByStableRef.get(referenceId);
      if (!assetId) throw new Error(`Unknown stable asset reference: ${referenceId}`);
      return assetId;
    });

    const prompt = item.prompt?.trim() || nativeShot.rawPrompt || nativeShot.prompt || "";
    const shot = await store.updateShot(nativeShot.id, {
      assetIds: resolved,
      rawPrompt: prompt,
      prompt
    });
    if (!shot) throw new Error(`Failed to bind references for native shot ${nativeShot.id}`);
    item.nativeShotId = shot.id;
    updated.push(shot);
  }

  return updated;
}
