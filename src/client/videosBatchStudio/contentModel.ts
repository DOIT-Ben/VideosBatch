import type { Asset, Session, Shot } from "../../shared/types";

export interface VideosBatchCandidateView {
  id: string;
  asset?: Asset;
  previewUrl: string;
}

export interface VideosBatchAssetCandidateGroup {
  assetKey: string;
  publicAssetId: string;
  name: string;
  description: string;
  candidateAssetIds: string[];
  candidates: VideosBatchCandidateView[];
  selectedAssetId?: string;
}

export function preferredAssetPreviewUrl(asset: Asset | undefined) {
  if (!asset) return "";
  return asset.thumbnailUrl
    || asset.imageUrl
    || asset.sourceImageUrl
    || asset.referenceImageUrl
    || (asset.mediaKind === "image" ? asset.mediaUrl : "")
    || "";
}

export function buildAssetCandidateGroups(
  planArtifact: any,
  candidatesArtifact: any,
  confirmationArtifact: any,
  nativeAssets: Asset[]
): VideosBatchAssetCandidateGroup[] {
  const planItems = Array.isArray(planArtifact?.items) ? planArtifact.items : [];
  const candidateItems = Array.isArray(candidatesArtifact?.items) ? candidatesArtifact.items : [];
  const confirmationItems = Array.isArray(confirmationArtifact?.items) ? confirmationArtifact.items : [];
  const candidateByKey = new Map(candidateItems.map((item: any) => [String(item?.assetKey || ""), item] as const));
  const confirmationByKey = new Map(confirmationItems.map((item: any) => [String(item?.assetKey || ""), item] as const));
  const assetById = new Map(nativeAssets.map((asset) => [asset.id, asset] as const));

  return planItems.map((item: any) => {
    const assetKey = String(item?.assetKey || "");
    const candidateItem = candidateByKey.get(assetKey) as any;
    const confirmationItem = confirmationByKey.get(assetKey) as any;
    const candidateAssetIds = Array.isArray(candidateItem?.candidateAssetIds)
      ? candidateItem.candidateAssetIds.map((id: unknown) => String(id || "")).filter(Boolean)
      : [];
    const candidates = candidateAssetIds.map((id: string) => {
      const asset = assetById.get(id);
      return { id, asset, previewUrl: preferredAssetPreviewUrl(asset) };
    });
    const confirmedSelection = String(confirmationItem?.selectedAssetId || "").trim();
    const selectedAssetId = candidateAssetIds.includes(confirmedSelection)
      ? confirmedSelection
      : candidateAssetIds[0];

    return {
      assetKey,
      publicAssetId: String(candidateItem?.publicAssetId || item?.assetId || ""),
      name: String(item?.name || assetKey),
      description: String(item?.description || ""),
      candidateAssetIds,
      candidates,
      selectedAssetId
    };
  });
}

export function buildAssetConfirmationArtifact(
  groups: VideosBatchAssetCandidateGroup[],
  selectedAssetIds: Record<string, string>
) {
  const items = groups.map((group) => {
    const selectedAssetId = String(selectedAssetIds[group.assetKey] || group.selectedAssetId || "").trim();
    if (!selectedAssetId || !group.candidateAssetIds.includes(selectedAssetId)) {
      throw new Error(`${group.name || group.assetKey} 还没有选择有效候选图`);
    }
    return {
      assetKey: group.assetKey,
      publicAssetId: group.publicAssetId,
      candidateAssetIds: [...group.candidateAssetIds],
      selectedAssetId
    };
  });
  if (!items.length) throw new Error("没有可确认的资产候选图");
  return { confirmed: true, items };
}

/**
 * Single source of truth for "the ASSET_CONFIRMATION gate is satisfied".
 * Mirrors the server rule in src/server/videosBatchWorkflow/runner.ts
 * (assetConfirmationReady) and additionally requires every confirmed
 * selection to still resolve inside the current candidate ids, so a stale
 * confirmation artifact from before an upstream regeneration no longer
 * counts as complete.
 */
export function isAssetConfirmationComplete(
  planArtifact: any,
  candidatesArtifact: any,
  confirmationArtifact: any
): boolean {
  if (confirmationArtifact?.confirmed !== true) return false;
  const planItems = Array.isArray(planArtifact?.items) ? planArtifact.items : [];
  const candidateItems = Array.isArray(candidatesArtifact?.items) ? candidatesArtifact.items : [];
  const confirmedItems = Array.isArray(confirmationArtifact?.items) ? confirmationArtifact.items : [];
  if (!planItems.length || confirmedItems.length !== planItems.length) return false;

  const candidateByKey = new Map(candidateItems.map((item: any) => [String(item?.assetKey || ""), item] as const));
  const confirmedByKey = new Map(confirmedItems.map((item: any) => [String(item?.assetKey || ""), item] as const));
  return planItems.every((item: any) => {
    const assetKey = String(item?.assetKey || "");
    const confirmed = confirmedByKey.get(assetKey) as any;
    if (!confirmed?.publicAssetId || !confirmed?.selectedAssetId) return false;
    const candidateItem = candidateByKey.get(assetKey) as any;
    const candidateAssetIds = Array.isArray(candidateItem?.candidateAssetIds)
      ? candidateItem.candidateAssetIds.map((id: unknown) => String(id || ""))
      : [];
    return candidateAssetIds.includes(String(confirmed.selectedAssetId));
  });
}

export function updateStoryArtifactContent<T extends Record<string, any>>(artifact: T, content: string): T {
  return { ...artifact, content: String(content) };
}

export function updateScreenplaySceneFields<T extends Record<string, any>>(
  artifact: T,
  sceneSequence: number,
  patch: Record<string, unknown>
): T {
  const scenes = Array.isArray(artifact.scenes) ? artifact.scenes : [];
  const nextScenes = scenes.map((scene: any) =>
    Number(scene?.sequence) === Number(sceneSequence) ? { ...scene, ...patch, sequence: scene.sequence } : scene
  );
  return { ...artifact, scenes: nextScenes };
}

export function updateStoryboardSegmentFields<T extends Record<string, any>>(
  artifact: T,
  segmentSequence: number,
  patch: Record<string, unknown>
): T {
  const segments = Array.isArray(artifact.segments) ? artifact.segments : [];
  const nextSegments = segments.map((segment: any) =>
    Number(segment?.sequence) === Number(segmentSequence)
      ? { ...segment, ...patch, sequence: segment.sequence, duration: segment.duration }
      : segment
  );
  return { ...artifact, segments: nextSegments };
}

export function updateStoryboardSubshotFields<T extends Record<string, any>>(
  artifact: T,
  segmentSequence: number,
  subshotSequence: number,
  patch: Record<string, unknown>
): T {
  const segments = Array.isArray(artifact.segments) ? artifact.segments : [];
  const nextSegments = segments.map((segment: any) => {
    if (Number(segment?.sequence) !== Number(segmentSequence)) return segment;
    const subshotField = Array.isArray(segment?.visualEffects) ? "visualEffects" : "subshots";
    const subshots = Array.isArray(segment?.[subshotField]) ? segment[subshotField] : [];
    const nextSubshots = subshots.map((subshot: any) =>
      Number(subshot?.sequence) === Number(subshotSequence)
        ? { ...subshot, ...patch, sequence: subshot.sequence, duration: subshot.duration }
        : subshot
    );
    return { ...segment, [subshotField]: nextSubshots };
  });
  return { ...artifact, segments: nextSegments };
}

export type VideosBatchStoryboardField = readonly [key: string, label: string, wide?: boolean];

/** Return the handbook fields for a segment while retaining legacy display compatibility. */
export function storyboardSegmentFieldDefinitions(artifact: any, segment: any): VideosBatchStoryboardField[] {
  const rawType = String(artifact?.storyType || "").trim().toUpperCase();
  const type = rawType === "STORY" || rawType.includes("故事") || Object.hasOwn(segment || {}, "characters")
    ? "STORY"
    : rawType === "SCIENCE" || rawType.includes("科普") || Object.hasOwn(segment || {}, "subjectObjects")
      ? "SCIENCE"
      : rawType === "KNOWLEDGE" || rawType.includes("知识") || Object.hasOwn(segment || {}, "coreImagery")
        ? "KNOWLEDGE"
        : "LEGACY";

  if (type === "STORY") return [
    ["scene", "场景画面", true],
    ["characters", "人物", true],
    ["keyProps", "关键道具", true]
  ];
  if (type === "SCIENCE") return [
    ["scene", "场景画面", true],
    ["subjectObjects", "主体对象", true],
    ["supportingElements", "辅助元素", true]
  ];
  if (type === "KNOWLEDGE") return [
    ["scene", "场景画面", true],
    ["coreImagery", "核心意象", true],
    ["supportingElements", "辅助元素", true]
  ];
  return [
    ["visualPrompt", "画面 Prompt", true],
    ["teachingPurpose", "教学目的"],
    ["narration", "旁白"],
    ["subtitles", "字幕"],
    ["transition", "转场"]
  ];
}

/** Read either the canonical visualEffects list or the legacy subshots list. */
export function storyboardSegmentSubshots(segment: any): any[] {
  if (Array.isArray(segment?.visualEffects)) return segment.visualEffects;
  return Array.isArray(segment?.subshots) ? segment.subshots : [];
}

export function storyboardSegmentSummary(segment: any): string {
  return String(segment?.visualPrompt || segment?.scene || "").trim();
}

export function preferredShotVideoUrl(shot: Partial<Shot> | undefined) {
  if (!shot) return "";
  return shot.playbackVideoUrl || shot.videoUrl || "";
}

export interface PreferredFinalVideo {
  playbackUrl: string;
  downloadUrl: string;
  status: string;
  progress: string;
}

export function preferredFinalVideo(session: Partial<Session> | undefined): PreferredFinalVideo {
  if (!session) return { playbackUrl: "", downloadUrl: "", status: "idle", progress: "" };
  const jobs = Array.isArray(session.stitchJobs) ? session.stitchJobs : [];
  const preferredJob = [...jobs].reverse().find((job) =>
    Boolean(job.finalVideoPlaybackUrl || job.finalVideoUrl || job.finalVideoDownloadUrl)
  ) || jobs[jobs.length - 1];

  if (preferredJob) {
    const playbackUrl = preferredJob.finalVideoPlaybackUrl || preferredJob.finalVideoUrl || "";
    return {
      playbackUrl,
      downloadUrl: preferredJob.finalVideoDownloadUrl || playbackUrl,
      status: preferredJob.status || "idle",
      progress: preferredJob.progress || ""
    };
  }

  const playbackUrl = session.finalVideoPlaybackUrl || session.finalVideoUrl || "";
  return {
    playbackUrl,
    downloadUrl: session.finalVideoDownloadUrl || playbackUrl,
    status: session.stitchStatus || (playbackUrl ? "ready" : "idle"),
    progress: session.stitchProgress || ""
  };
}
