import type { StageDefinition, StageRegistry } from "./stageContracts";
import type { VideosBatchStageId } from "../../shared/videosBatchWorkflow";
import type { VideosBatchLlmExecutor } from "./llmExecutor";
import { createVideosBatchLlmTextStageRegistry } from "./llmTextStages";
import {
  bindStableReferencesIntoShots,
  projectAssetsIntoSeeReel,
  projectStoryboardIntoSeeReel
} from "./nativeProjection";

function pass<T>(id: VideosBatchStageId, artifact: T): StageDefinition<T> {
  return {
    id,
    async execute() {
      return { artifact: structuredClone(artifact) };
    },
    validate() {
      return { ok: true, errors: [] };
    }
  };
}

const fakeAssetGeneration: StageDefinition<{ assetIds: string[] }> = {
  id: "ASSET_GENERATION",
  async execute() {
    return { artifact: { assetIds: [] } };
  },
  validate() {
    return { ok: true, errors: [] };
  },
  async project(artifact, ctx) {
    if (!ctx.store) {
      artifact.assetIds = ["asset_fake_P001_A001"];
      return;
    }
    const plan = ctx.workflow.stages.ASSET_PROMPT_GENERATION?.artifact;
    const assets = await projectAssetsIntoSeeReel(ctx.store, ctx.session.id, plan || { assets: [] });
    artifact.assetIds = assets.map((asset) => asset.id);
  }
};

const fakeStoryboardGeneration: StageDefinition<any> = {
  id: "STORYBOARD_GENERATION",
  async execute() {
    return {
      artifact: {
        shots: [
          {
            id: "shot-plan-1",
            durationSec: 10,
            subshots: [
              { durationSec: 3 },
              { durationSec: 3 },
              { durationSec: 4 }
            ],
            prompt: "Fake storyboard prompt"
          }
        ]
      }
    };
  },
  validate() {
    return { ok: true, errors: [] };
  },
  async project(artifact, ctx) {
    if (!ctx.store) return;
    await projectStoryboardIntoSeeReel(ctx.store, ctx.session.id, artifact);
  }
};

const fakeReferenceBinding: StageDefinition<any> = {
  id: "REFERENCE_BINDING",
  async execute() {
    return {
      artifact: {
        shots: [
          {
            id: "shot-plan-1",
            assetIds: ["P001-A001"],
            prompt: "Fake storyboard prompt with stable reference P001-A001"
          }
        ]
      }
    };
  },
  validate() {
    return { ok: true, errors: [] };
  },
  async project(artifact, ctx) {
    if (!ctx.store) return;
    const storyboard = ctx.workflow.stages.STORYBOARD_GENERATION?.artifact as any;
    const nativeShotByPlanId = new Map(
      (storyboard?.shots || []).map((shot: any) => [shot.id, shot.nativeShotId])
    );
    for (const shot of artifact.shots || []) {
      shot.nativeShotId = nativeShotByPlanId.get(shot.id) || shot.nativeShotId;
    }
    await bindStableReferencesIntoShots(ctx.store, ctx.session.id, artifact);
  }
};

export function createPhase1FakeStageRegistry(): StageRegistry {
  return {
    INTRO_GENERATION: pass("INTRO_GENERATION", {
      candidates: Array.from({ length: 9 }, (_, index) => ({
        id: `${["A", "B", "C"][Math.floor(index / 3)]}${(index % 3) + 1}`,
        title: `课程导入 ${index + 1}`,
        content: `Fake intro candidate ${index + 1}`
      })),
      recommendedIds: ["A1", "B1", "C1"]
    }),
    STORY_EXPANSION: pass("STORY_EXPANSION", {
      stories: [1, 2, 3].map((index) => ({
        id: `story-${index}`,
        title: `完整故事 ${index}`,
        content: `Fake expanded story ${index}`
      }))
    }),
    ASSET_PROMPT_GENERATION: pass("ASSET_PROMPT_GENERATION", {
      assets: [
        {
          referenceId: "P001-A001",
          type: "character",
          name: "示例角色",
          prompt: "Fake reusable character asset"
        }
      ]
    }),
    ASSET_GENERATION: fakeAssetGeneration,
    SCREENPLAY_GENERATION: pass("SCREENPLAY_GENERATION", {
      scenes: [
        {
          id: "scene-1",
          title: "示例场次",
          visual: "Fake screenplay visual",
          dialogue: "Fake dialogue"
        }
      ]
    }),
    STORYBOARD_GENERATION: fakeStoryboardGeneration,
    REFERENCE_BINDING: fakeReferenceBinding,
    VIDEO_GENERATION: pass("VIDEO_GENERATION", {
      renderIds: ["render_fake_1"]
    }),
    STITCH: pass("STITCH", {
      finalVideoUrl: "fake://videosbatch/final.mp4"
    })
  };
}

export interface CreateVideosBatchStageRegistryOptions {
  /**
   * Explicit dependency injection only. The server does not create or enable a real LLM executor
   * unless the caller supplies one, so existing local/CI behavior remains fully fake and key-free.
   */
  textExecutor?: VideosBatchLlmExecutor;
}

export function createVideosBatchStageRegistry(
  options: CreateVideosBatchStageRegistryOptions = {}
): StageRegistry {
  const mode = (process.env.VIDEOSBATCH_EXECUTOR_MODE || "fake").trim().toLowerCase();
  if (mode !== "fake") throw new Error(`Unsupported VIDEOSBATCH_EXECUTOR_MODE: ${mode}`);

  const registry = createPhase1FakeStageRegistry();
  if (!options.textExecutor) return registry;

  return {
    ...registry,
    ...createVideosBatchLlmTextStageRegistry(options.textExecutor)
  };
}
