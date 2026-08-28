import { randomUUID } from "node:crypto";
import type { Asset, AssetImageModel, Shot, ShotRender } from "../../shared/types";
import {
  cacheGeneratedImage,
  cacheGeneratedVideo,
  defaultSeedreamAssetImageModel,
  generateAssetImage,
  generateShotVideo,
  stitchShotVideos
} from "../generators";
import type { StageDefinition, StageRegistry } from "./stageContracts";
import {
  applyConfirmedReferencesToNativeShots,
  projectAssetCandidatesIntoSeeReel
} from "./nativeProjection";

export interface NativeAssetImageResult {
  url: string;
  composedPrompt?: string;
  model: AssetImageModel;
  credentialSource?: "standard" | "agent-plan" | "missing";
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

export interface VideosBatchNativeMediaDeps {
  defaultAssetImageModel(): AssetImageModel;
  generateAssetImage(asset: Asset, model: AssetImageModel): Promise<NativeAssetImageResult>;
  cacheGeneratedImage(url: string, assetId: string): Promise<NativeCachedImageResult>;
  generateShotVideo(shot: Shot, assets: Asset[]): Promise<string>;
  cacheGeneratedVideo(url: string, renderId: string): Promise<NativeCachedVideoResult>;
  stitchShotVideos(sessionId: string, shots: Shot[]): Promise<{ finalVideoUrl: string; signature: string }>;
}

export const defaultVideosBatchNativeMediaDeps: VideosBatchNativeMediaDeps = {
  defaultAssetImageModel: defaultSeedreamAssetImageModel,
  generateAssetImage: async (asset, model) => generateAssetImage(asset, model),
  cacheGeneratedImage,
  generateShotVideo: async (shot, assets) => generateShotVideo(shot, assets),
  cacheGeneratedVideo,
  stitchShotVideos: async (sessionId, shots) => stitchShotVideos(sessionId, shots)
};

function requireStore(ctx: any) {
  if (!ctx.store) throw new Error("Native VideosBatch media execution requires CinemaStore");
  return ctx.store;
}

function projectIdFromWorkflow(ctx: any) {
  const projectId = String(ctx.workflow.stages.LESSON_INPUT?.artifact?.projectId || "").trim();
  if (!projectId) throw new Error("LESSON_INPUT.projectId is required for native media execution");
  return projectId;
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

function validateAssetCandidates(artifact: any) {
  const errors: string[] = [];
  const items = Array.isArray(artifact?.items) ? artifact.items : [];
  if (!items.length) errors.push("ASSET_CANDIDATES requires at least one generated candidate");
  for (const item of items) {
    if (!String(item?.assetKey || "").trim()) errors.push("ASSET_CANDIDATES item requires assetKey");
    if (!/^P\d{3,}-A\d{3,}$/.test(String(item?.publicAssetId || ""))) {
      errors.push(`ASSET_CANDIDATES ${item?.assetKey || "item"} requires a server-owned stable publicAssetId`);
    }
    if (!Array.isArray(item?.candidateAssetIds) || !item.candidateAssetIds.length) {
      errors.push(`ASSET_CANDIDATES ${item?.assetKey || "item"} requires at least one generated native candidate`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function modelForShot(shot: Shot) {
  return shot.seedanceVariant === "fast" ? "seedance-2-0-fast" : "seedance-2-0";
}

function newestReadyRenderId(shot: Shot) {
  return (shot.renders || []).find((render) => render.status === "ready" && render.videoUrl)?.id;
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

      const beforeByStable = new Map(
        store.snapshot().assets
          .filter((asset: Asset) => asset.ownerSessionId === ctx.session.id && asset.workflowReferenceId)
          .map((asset: Asset) => [asset.workflowReferenceId!, asset])
      );

      const projected = await projectAssetCandidatesIntoSeeReel(
        store,
        ctx.session.id,
        projectIdFromWorkflow(ctx),
        plan
      );

      const resultItems: any[] = [];
      for (const item of projected.items) {
        const nativeId = item.candidateAssetIds[0];
        const planned = items.find((candidate: any) => String(candidate?.assetKey) === item.assetKey);
        let asset = store.snapshot().assets.find((candidate: Asset) => candidate.id === nativeId);
        if (!asset) throw new Error(`Projected native asset not found: ${nativeId}`);

        const previous = beforeByStable.get(item.publicAssetId);
        const promptUnchanged = Boolean(previous?.imageUrl && previous.prompt === String(planned?.prompt || "").trim());
        if (!promptUnchanged) {
          const model = deps.defaultAssetImageModel();
          const generated = await deps.generateAssetImage(asset, model);
          const sourceUrl = assertRealMediaUrl(generated.url, `Asset ${item.publicAssetId}`);
          const cached = await deps.cacheGeneratedImage(sourceUrl, asset.id);
          const imageUrl = assertRealMediaUrl(cached.imageUrl || sourceUrl, `Cached asset ${item.publicAssetId}`);
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
            composedPrompt: generated.composedPrompt || asset.prompt
          });
          if (!updated) throw new Error(`Failed to persist generated asset ${item.publicAssetId}`);
          asset = updated;
        }

        resultItems.push({
          assetKey: item.assetKey,
          publicAssetId: item.publicAssetId,
          candidateAssetIds: [asset.id]
        });
      }

      return { artifact: { items: resultItems } };
    },
    validate(artifact) {
      return validateAssetCandidates(artifact);
    }
  };

  const execution: StageDefinition<any> = {
    id: "EXECUTION",
    async execute(ctx) {
      const store = requireStore(ctx);
      const storyboard = ctx.workflow.stages.FINAL_STORYBOARD?.artifact as any;
      const confirmation = ctx.workflow.stages.ASSET_CONFIRMATION?.artifact as any;
      if (!storyboard?.segments?.length) throw new Error("FINAL_STORYBOARD is required before native execution");
      if (confirmation?.confirmed !== true) throw new Error("ASSET_CONFIRMATION must be confirmed before native execution");

      await applyConfirmedReferencesToNativeShots(store, ctx.session.id, storyboard, confirmation);
      const nativeSession = store.getSession(ctx.session.id);
      if (!nativeSession) throw new Error(`Session not found: ${ctx.session.id}`);

      const renderIds: string[] = [];
      const nativeShotIds: string[] = [];
      for (const current of nativeSession.shots.sort((a, b) => a.index - b.index)) {
        nativeShotIds.push(current.id);
        const reusable = current.status === "ready" && current.videoUrl ? newestReadyRenderId(current) : undefined;
        if (reusable) {
          renderIds.push(reusable);
          continue;
        }

        const activeAssets = store.getAssetsForShot(current);
        const remoteUrl = assertRealMediaUrl(
          await deps.generateShotVideo(current, activeAssets),
          `Shot ${current.index}`
        );
        const renderId = `render_vb_${randomUUID().slice(0, 8)}`;
        const cached = await deps.cacheGeneratedVideo(remoteUrl, renderId);
        const videoUrl = assertRealMediaUrl(cached.videoUrl || remoteUrl, `Cached shot ${current.index}`);
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
          seedanceVariant: current.seedanceVariant,
          assetIds: [...(current.assetIds || [])],
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
          generationModel: model,
          generationTaskId: undefined,
          generationStartedAt: undefined,
          status: "ready",
          error: undefined
        });
        if (!updated) throw new Error(`Failed to persist native render for shot ${current.id}`);
        renderIds.push(renderId);
      }

      return {
        artifact: {
          executionId: `execution_${ctx.session.id}`,
          status: "READY",
          renderIds,
          nativeShotIds
        }
      };
    },
    validate(artifact, ctx) {
      const errors: string[] = [];
      if (!String(artifact?.executionId || "").trim()) errors.push("EXECUTION requires executionId");
      if (artifact?.status !== "READY") errors.push("EXECUTION must finish READY");
      if (!Array.isArray(artifact?.renderIds) || artifact.renderIds.length !== ctx.session.shots.length) {
        errors.push("EXECUTION requires one renderId for every native shot");
      }
      return { ok: errors.length === 0, errors };
    }
  };

  const stitch: StageDefinition<any> = {
    id: "STITCH",
    async execute(ctx) {
      const store = requireStore(ctx);
      const session = store.getSession(ctx.session.id);
      if (!session) throw new Error(`Session not found: ${ctx.session.id}`);
      const shots = [...session.shots].sort((a, b) => a.index - b.index);
      if (!shots.length) throw new Error("STITCH requires at least one native shot");
      const missing = shots.filter((shot) => !shot.videoUrl || shot.status !== "ready");
      if (missing.length) throw new Error(`STITCH requires every shot ready; missing: ${missing.map((shot) => shot.id).join(", ")}`);

      const stitchJobId = `stitch_vb_${randomUUID().slice(0, 8)}`;
      const startedAt = new Date().toISOString();
      const created = await store.createStitchJob(ctx.session.id, {
        id: stitchJobId,
        name: "VideosBatch final",
        shotIds: shots.map((shot) => shot.id),
        status: "running",
        startedAt,
        progress: "stitching"
      });
      if (!created) throw new Error("Failed to create native SeeReel StitchJob");

      try {
        const result = await deps.stitchShotVideos(ctx.session.id, shots);
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
          runningSignature: undefined
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
            stitchJobId,
            finalVideoUrl,
            signature: result.signature,
            status: "READY"
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
    validate(artifact) {
      const errors: string[] = [];
      if (!String(artifact?.stitchJobId || "").trim()) errors.push("STITCH requires stitchJobId");
      if (!String(artifact?.finalVideoUrl || "").trim()) errors.push("STITCH requires finalVideoUrl");
      if (!String(artifact?.signature || "").trim()) errors.push("STITCH requires signature");
      if (artifact?.status !== "READY") errors.push("STITCH must finish READY");
      return { ok: errors.length === 0, errors };
    }
  };

  return {
    ASSET_CANDIDATES: assetCandidates,
    EXECUTION: execution,
    STITCH: stitch
  };
}
