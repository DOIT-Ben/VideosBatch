import type { Connection, Edge } from "@xyflow/react";
import type { Asset, SessionWithShots, StoreSnapshot } from "../../shared/types";
import type { FlowNodeData } from "./buildGraph";

/**
 * The optimistic wire drawn the instant a person completes a drag, before the
 * server round-trip that turns it into real data. Every edge here is "a wire in
 * someone's hand", so they all share one look instead of the five hues they used
 * to: the `edge-pending` class paints them brass, and only the wire's shape
 * (dash, opacity) distinguishes the kind of connection being made.
 */
const PENDING_EDGE_CLASS = "edge-pending";

export interface PendingConnectInput {
  connection: Connection;
  session: SessionWithShots;
  snapshot: StoreSnapshot;
  targetNodeData?: FlowNodeData;
}

export function mergePendingEdges(derivedEdges: Edge[], pendingEdges: Edge[]) {
  const derivedIds = new Set(derivedEdges.map((edge) => edge.id));
  return [
    ...derivedEdges,
    ...pendingEdges.filter((edge) => !derivedIds.has(edge.id))
  ];
}

export function buildPendingConnectEdge(input: PendingConnectInput): Edge | undefined {
  const source = input.connection.source || "";
  const target = input.connection.target || "";
  if (!source || !target) return undefined;
  const isFrameAnchorNode = (nodeId: string) => nodeId.startsWith("frame-anchor-") || nodeId.startsWith("tailframe-");
  const isVisualNode = (nodeId: string) => nodeId.startsWith("image-") || nodeId.startsWith("asset-") || nodeId.startsWith("moodboard-") || isFrameAnchorNode(nodeId);
  const assetIdFromVisualNode = (nodeId: string) => {
    if (nodeId.startsWith("frame-anchor-")) return nodeId.slice("frame-anchor-".length);
    if (nodeId.startsWith("tailframe-")) return nodeId.slice("tailframe-".length);
    if (nodeId.startsWith("image-")) return nodeId.slice("image-".length);
    if (nodeId.startsWith("asset-")) return nodeId.slice("asset-".length);
    if (nodeId.startsWith("moodboard-")) return nodeId.slice("moodboard-".length);
    return "";
  };

  if ((isVisualNode(source) || source.startsWith("storyboard-")) && (isVisualNode(target) || target.startsWith("storyboard-"))) {
    const sourceAsset = resolveVisualReferenceSourceAssetId(source, input.session);
    if (!sourceAsset) return undefined;
    if (isVisualNode(target)) {
      const targetAssetId = assetIdFromVisualNode(target);
      const targetAsset = input.snapshot.assets.find((asset) => asset.id === targetAssetId);
      if (!targetAsset || targetAsset.id === sourceAsset.id) return undefined;
      return {
        id: `${source.startsWith("storyboard-") ? "e-storyboardref" : "e-assetref"}-${sourceAsset.id}-${targetAsset.id}`,
        source,
        target,
        animated: true,
        className: PENDING_EDGE_CLASS,
        data: { canDisconnectAssetReference: true, sourceAssetId: sourceAsset.id, targetAssetId: targetAsset.id },
        style: { strokeWidth: 2, strokeDasharray: "5 3", opacity: 0.8 }
      };
    }
    const targetShotId = target.slice("storyboard-".length);
    const targetShot = input.session.shots?.find((shot) => shot.id === targetShotId);
    if (!targetShot || targetShot.subShotStoryboardAssetId === sourceAsset.id) return undefined;
    return {
      id: `e-asset-${sourceAsset.id}-${target}`,
      source,
      target,
      animated: true,
      className: PENDING_EDGE_CLASS,
      data: { canDisconnect: true, assetId: sourceAsset.id, shotId: targetShot.id },
      style: { strokeWidth: 2, opacity: 0.8 }
    };
  }

  if (isVisualNode(source) && (target.startsWith("storyboard-") || target.startsWith("shot-"))) {
    const assetId = assetIdFromVisualNode(source);
    const targetShotId = target.startsWith("storyboard-")
      ? target.slice("storyboard-".length)
      : target.slice("shot-".length);
    const asset = input.snapshot.assets.find((item) => item.id === assetId);
    const targetShot = input.session.shots?.find((shot) => shot.id === targetShotId);
    if (!asset || !targetShot) return undefined;
    const isFrameAnchor = hasTag(asset, "tailframe") || hasTag(asset, "frame-anchor");
    if (isFrameAnchor) {
      return {
        id: `e-tailframe-${asset.id}-${targetShot.id}`,
        source,
        target: `shot-${targetShot.id}`,
        animated: true,
        className: PENDING_EDGE_CLASS,
        data: { canDisconnectFirstFrame: true, tailframeAssetId: asset.id, targetShotId: targetShot.id },
        style: { strokeWidth: 2, opacity: 0.8 }
      };
    }
    return {
      id: `e-asset-${asset.id}-shot-${targetShot.id}`,
      source,
      target: `shot-${targetShot.id}`,
      animated: true,
      className: PENDING_EDGE_CLASS,
      data: { canDisconnect: true, assetId: asset.id, shotId: targetShot.id },
      style: { strokeWidth: 2, opacity: 0.8 }
    };
  }

  if (source.startsWith("storyboard-") && target.startsWith("shot-")) {
    const ownerShotId = source.slice("storyboard-".length);
    const targetShotId = target.slice("shot-".length);
    const ownerShot = input.session.shots?.find((shot) => shot.id === ownerShotId);
    const targetShot = input.session.shots?.find((shot) => shot.id === targetShotId);
    const storyboardAssetId = ownerShot?.subShotStoryboardAssetId;
    if (!ownerShot || !targetShot || !storyboardAssetId) return undefined;
    const isPrimary = ownerShot.id === targetShot.id;
    return {
      id: `e-storyboard-${ownerShot.id}-shot-${targetShot.id}-${storyboardAssetId}`,
      source,
      target: `shot-${targetShot.id}`,
      animated: true,
      className: PENDING_EDGE_CLASS,
      data: { canDisconnectStoryboard: true, storyboardAssetId, targetShotId: targetShot.id, isPrimary },
      style: {
        strokeWidth: 2,
        opacity: 0.8,
        ...(isPrimary ? {} : { strokeDasharray: "4 3" })
      }
    };
  }

  if ((source.startsWith("refvideo-") || source.startsWith("videoproc-") || source.startsWith("video-")) && target.startsWith("shot-")) {
    const refAssetId = source.startsWith("refvideo-")
      ? source.slice("refvideo-".length)
      : source.startsWith("videoproc-")
        ? source.slice("videoproc-".length)
        : source.slice("video-".length);
    const refAsset = input.snapshot.assets.find((asset) => asset.id === refAssetId);
    const targetShotId = target.slice("shot-".length);
    const targetShot = input.session.shots?.find((shot) => shot.id === targetShotId);
    if (!refAsset || !targetShot) return undefined;
    return {
      id: `e-${source}-shot-${targetShot.id}`,
      source,
      target: `shot-${targetShot.id}`,
      animated: true,
      className: PENDING_EDGE_CLASS,
      data: { canDisconnectRefVideo: true, refVideoAssetId: refAsset.id, targetShotId: targetShot.id },
      style: { strokeWidth: 2, opacity: 0.8 }
    };
  }

  if (isFrameAnchorNode(source) && target.startsWith("shot-")) {
    const tailframeAssetId = assetIdFromVisualNode(source);
    const targetShotId = target.slice("shot-".length);
    const targetShot = input.session.shots?.find((shot) => shot.id === targetShotId);
    if (!targetShot) return undefined;
    return {
      id: `e-tailframe-${tailframeAssetId}-${targetShot.id}`,
      source,
      target: `shot-${targetShot.id}`,
      animated: true,
      className: PENDING_EDGE_CLASS,
      data: { canDisconnectFirstFrame: true, tailframeAssetId, targetShotId: targetShot.id },
      style: { strokeWidth: 2, opacity: 0.8 }
    };
  }

  if (source.startsWith("stitch-") && target.startsWith("audio-") && input.targetNodeData?.kind === "audioTrack") {
    const job = input.targetNodeData.job;
    if (input.session.audioTrackStitchJobIds?.includes(job.id)) return undefined;
    return {
      id: `e-audio-${source}-${target}`,
      source,
      target,
      animated: true,
      className: PENDING_EDGE_CLASS,
      data: { canDisconnectAudioTrack: true, stitchJobId: job.id },
      style: {
        strokeWidth: 2,
        opacity: 0.8,
        ...(job.finalVideoUrl ? {} : { strokeDasharray: "6 4" })
      }
    };
  }

  if (source.startsWith("shot-") && target.startsWith("shot-")) {
    const sourceShotId = source.slice("shot-".length);
    const targetShotId = target.slice("shot-".length);
    const sourceShot = input.session.shots?.find((shot) => shot.id === sourceShotId);
    const targetShot = input.session.shots?.find((shot) => shot.id === targetShotId);
    if (!sourceShot || !targetShot || sourceShot.id === targetShot.id) return undefined;
    return {
      id: `e-shotref-${sourceShot.id}-${targetShot.id}`,
      source,
      target,
      animated: true,
      className: PENDING_EDGE_CLASS,
      data: { canDisconnectShotRef: true, sourceShotId: sourceShot.id, targetShotId: targetShot.id },
      style: { strokeWidth: 2, strokeDasharray: "4 3", opacity: 0.8 }
    };
  }

  return undefined;
}

function hasTag(asset: Asset, tag: string) {
  return (asset.tags || []).includes(tag);
}

function resolveVisualReferenceSourceAssetId(nodeId: string, session: SessionWithShots): { id: string } | undefined {
  if (nodeId.startsWith("image-")) return { id: nodeId.slice("image-".length) };
  if (nodeId.startsWith("asset-")) return { id: nodeId.slice("asset-".length) };
  if (nodeId.startsWith("moodboard-")) return { id: nodeId.slice("moodboard-".length) };
  if (!nodeId.startsWith("storyboard-")) return undefined;
  const shotId = nodeId.slice("storyboard-".length);
  const shot = session.shots?.find((item) => item.id === shotId);
  return shot?.subShotStoryboardAssetId ? { id: shot.subShotStoryboardAssetId } : undefined;
}
