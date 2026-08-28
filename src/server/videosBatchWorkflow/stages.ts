import type { StageDefinition, StageRegistry } from "./stageContracts";
import type { VideosBatchStageId } from "../../shared/videosBatchWorkflow";

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
    ASSET_GENERATION: pass("ASSET_GENERATION", {
      assetIds: ["asset_fake_P001_A001"]
    }),
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
    STORYBOARD_GENERATION: pass("STORYBOARD_GENERATION", {
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
    }),
    REFERENCE_BINDING: pass("REFERENCE_BINDING", {
      shots: [
        {
          id: "shot-plan-1",
          assetIds: ["P001-A001"],
          prompt: "Fake storyboard prompt with stable reference P001-A001"
        }
      ]
    }),
    VIDEO_GENERATION: pass("VIDEO_GENERATION", {
      renderIds: ["render_fake_1"]
    }),
    STITCH: pass("STITCH", {
      finalVideoUrl: "fake://videosbatch/final.mp4"
    })
  };
}

export function createVideosBatchStageRegistry(): StageRegistry {
  const mode = (process.env.VIDEOSBATCH_EXECUTOR_MODE || "fake").trim().toLowerCase();
  if (mode === "fake") return createPhase1FakeStageRegistry();
  throw new Error(`Unsupported VIDEOSBATCH_EXECUTOR_MODE: ${mode}`);
}
