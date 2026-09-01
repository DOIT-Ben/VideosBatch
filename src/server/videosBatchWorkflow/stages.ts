import type { StageDefinition, StageRegistry } from "./stageContracts";
import type { VideosBatchStageId } from "../../shared/videosBatchWorkflow";
import type { VideosBatchLlmExecutor } from "./llmExecutor";
import { createVideosBatchLlmTextStageRegistry, deriveCopyablePrompt, validateVideosBatchTextStage } from "./llmTextStages";
import {
  applyConfirmedReferencesToNativeShots,
  projectAssetCandidatesIntoSeeReel,
  projectFinalStoryboardIntoSeeReel
} from "./nativeProjection";
import { canonicalStoryboardSourceHash, contentHash } from "./canonicalStoryboard";

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

function projectIdFromWorkflow(ctx: any) {
  return String(ctx.workflow.stages.LESSON_INPUT?.artifact?.projectId || "P001").trim();
}

function fakeIntroArtifact() {
  const ids = ["A-01", "A-02", "A-03", "B-01", "B-02", "B-03", "C-01", "C-02", "C-03"];
  const directions = [
    "原始问题与知识产生：追问为什么需要这项知识",
    "可靠史实与时代背景：还原知识出现的真实背景",
    "方法工具演变：观察方法和工具如何逐步改进",
    "古代真实需求：从当时生活中的实际需求出发",
    "古今对照：比较不同年代解决同一问题的方法",
    "现代工程科技应用：连接工程、科技与现实应用",
    "生活冲突与错误现场：从一次可观察的错误展开",
    "推理游戏挑战：把线索组织成一场推理挑战",
    "科技或自然异常：从自然现象和科技异常提出问题"
  ];
  return {
    candidates: ids.map((id, index) => ({
      id,
      name: `课程导入 ${id}`,
      creativeType: directions[index],
      body: `这是${id}的课程导入，${directions[index]}。` + "学生围绕一个真实而清晰的问题展开观察、比较和推理，冲突逐步升级，本课数学知识成为解决问题的关键线索，但此处仍然不揭示结论。".repeat(4).slice(0, 210),
      endingQuestion: "究竟应该怎样判断并解决这个问题？",
      truthfulnessCategory: "完全虚构的故事化情境",
      truthfulnessNote: "用于结构化工作流测试的虚构教学情境。"
    })),
    recommendations: [
      { id: "A-01", reason: "知识连接清晰，课堂吸引力强，便于视频化。" },
      { id: "B-01", reason: "课堂需求明确，能自然引出核心问题，场景易制作。" },
      { id: "C-01", reason: "冲突直观，学生容易代入，适合视频制作。" }
    ]
  };
}

const fakeStoryContent = "故事从一个明确的问题开始，学生发现仅凭眼前看到的现象无法直接作出结论，于是不断提出新的猜测并寻找证据。随着不同观察角度和条件逐步出现，原先看似确定的判断开始产生冲突，大家必须依靠本课的数学知识来重新组织线索。人物通过观察、比较、讨论和验证推进情节，但故事始终不提前给出课堂要学习的最终规律。最后，所有线索汇聚到一个尚未解决的问题上：怎样才能用更可靠的方法完成判断？";

const fakeCourseIntroCandidates: StageDefinition<any> = {
  id: "COURSE_INTRO_CANDIDATES",
  async execute() {
    return { artifact: fakeIntroArtifact() };
  },
  validate(artifact, ctx) {
    return validateVideosBatchTextStage("COURSE_INTRO_CANDIDATES", artifact, ctx);
  }
};

const fakeStoryScript: StageDefinition<any> = {
  id: "STORY_SCRIPT",
  async execute(ctx) {
    const selected = ctx.workflow.selectedIntroId || "A-01";
    return {
      artifact: {
        schemaVersion: "2",
        kind: "LESSON_INTRO_VIDEO_SCRIPT",
        title: `完整故事-${selected}`,
        storyType: "故事叙事型",
        truthfulnessNote: "完全虚构的故事化情境，用于工作流结构验证。",
        content: fakeStoryContent.repeat(4)
      }
    };
  },
  validate(artifact, ctx) {
    return validateVideosBatchTextStage("STORY_SCRIPT", artifact, ctx);
  }
};

const fakeAssetPlan: StageDefinition<any> = {
  id: "ASSET_PLAN",
  async execute() {
    return {
      artifact: {
        schemaVersion: "1",
        title: "视频资产计划",
        kind: "VIDEO_ASSET_PLAN",
        subject: "数学",
        gradeBand: "小学",
        candidateAssets: ["示例学生角色", "课堂观察区", "观察尺", "课堂小鸟"],
        candidateInventory: [
          { assetKey: "CHARACTER-HERO", name: "示例学生角色", category: "CHARACTER", required: true, sourceEvidence: "故事中的主要观察与推理角色。", decision: "required" },
          { assetKey: "SCENE-CLASSROOM", name: "课堂观察区", category: "SCENE", required: true, sourceEvidence: "故事课堂场景。", decision: "required" },
          { assetKey: "PROP-RULER", name: "观察尺", category: "PROP", required: true, sourceEvidence: "故事关键道具。", decision: "required" },
          { assetKey: "CREATURE-BIRD", name: "课堂小鸟", category: "CREATURE", required: false, sourceEvidence: "故事生物。", decision: "optional" }
        ],
        omissionCheck: "已逐段回看故事，并按人物、场景、道具、生物四类完成二次核对。",
        styleSpec: "影视级 3D 国漫 CG 风格，所有资产统一 16:9，保持跨镜头角色、空间和道具连续。",
        negativePrompt: "不要文字，不要水印，不要 logo，不要主体裁切，不要主体缺失，不要多余人物，不要复杂背景，不要畸形肢体，不要低清模糊。",
        items: [
          {
            assetKey: "CHARACTER-HERO",
            category: "CHARACTER",
            name: "示例学生角色",
            description: "故事中的主要观察者，保持跨镜头形象一致。",
            prompt: "高级影视级 3D 国漫 CG 风格人物三视图，正面全身、侧面全身、背面全身、面部特写，四格横向排列，纯白背景，16:9；不要文字，不要水印。",
            negativePrompt: "不要文字，不要水印，不要 logo，不要主体裁切，不要主体缺失，不要多余人物，不要复杂背景，不要畸形肢体，不要低清模糊。",
            aspectRatio: "16:9",
            required: true,
            usage: "跨所有分镜保持主角外观一致。",
            continuityNotes: "脸型、五官、发色、体型和基础服装保持一致。",
            variantNotes: null,
            sourceEvidence: "故事中的主要观察与推理角色。"
          },
          { assetKey: "SCENE-CLASSROOM", category: "SCENE", name: "课堂观察区", description: "故事发生的课堂空间。", prompt: "影视级 3D 国漫 CG 风格纯环境空镜，16:9，前中远景清晰；不要文字，不要水印。", negativePrompt: "不要文字，不要水印，不要 logo，不要主体裁切，不要主体缺失，不要多余人物，不要复杂背景，不要畸形肢体，不要低清模糊。", aspectRatio: "16:9", required: true, usage: "建立连续的课堂观察空间。", continuityNotes: "空间结构保持一致。", variantNotes: null, sourceEvidence: "故事课堂场景。" },
          { assetKey: "PROP-RULER", category: "PROP", name: "观察尺", description: "推动观察冲突的关键道具。", prompt: "影视级 3D 国漫 CG 风格单体道具设定图，纯白背景，主体完整；不要文字，不要水印。", negativePrompt: "不要文字，不要水印，不要 logo，不要主体裁切，不要主体缺失，不要多余人物，不要复杂背景，不要畸形肢体，不要低清模糊。", aspectRatio: "16:9", required: true, usage: "在关键观察镜头中提供可追踪的测量线索。", continuityNotes: "比例和刻度保持一致。", variantNotes: null, sourceEvidence: "故事关键道具。" },
          { assetKey: "CREATURE-BIRD", category: "CREATURE", name: "课堂小鸟", description: "课堂窗外出现的非拟人生物。", prompt: "影视级 3D 国漫 CG 风格非拟人生物设定图，主体完整，纯白背景；不要文字，不要水印。", negativePrompt: "不要文字，不要水印，不要 logo，不要主体裁切，不要主体缺失，不要多余人物，不要复杂背景，不要畸形肢体，不要低清模糊。", aspectRatio: "16:9", required: false, usage: "作为一次性的环境线索，不抢占主叙事。", continuityNotes: "外观保持一致。", variantNotes: null, sourceEvidence: "故事生物。" }
        ]
      }
    };
  },
  validate(artifact, ctx) {
    return validateVideosBatchTextStage("ASSET_PLAN", artifact, ctx);
  }
};

const fakeAssetCandidates: StageDefinition<any> = {
  id: "ASSET_CANDIDATES",
  async execute(ctx) {
    const plan = ctx.workflow.stages.ASSET_PLAN?.artifact as any;
    const projectId = projectIdFromWorkflow(ctx);
    const items = (plan?.items || []).map((item: any, index: number) => ({
      assetKey: item.assetKey,
      publicAssetId: `${projectId}-A${String(index + 1).padStart(3, "0")}`,
      candidateAssetIds: [`asset_fake_${index + 1}`]
    }));
    return { artifact: { items } };
  },
  validate(artifact) {
    const errors: string[] = [];
    const items = Array.isArray(artifact?.items) ? artifact.items : [];
    if (!items.length) errors.push("ASSET_CANDIDATES requires candidates for every asset-plan item");
    for (const item of items) {
      if (!/^P\d{3,}-A\d{3,}$/.test(String(item?.publicAssetId || ""))) errors.push("ASSET_CANDIDATES requires server-owned stable publicAssetId");
      if (!Array.isArray(item?.candidateAssetIds) || !item.candidateAssetIds.length) errors.push(`ASSET_CANDIDATES ${item?.assetKey || "item"} requires at least one candidate`);
    }
    return { ok: errors.length === 0, errors };
  },
  async project(artifact, ctx) {
    const plan = ctx.workflow.stages.ASSET_PLAN?.artifact as any;
    if (!ctx.store) return;
    const projected = await projectAssetCandidatesIntoSeeReel(ctx.store, ctx.session.id, projectIdFromWorkflow(ctx), plan || { items: [] });
    artifact.items = projected.items;
  }
};

const fakeScreenplay: StageDefinition<any> = {
  id: "SCREENPLAY",
  async execute() {
    return {
      artifact: {
        schemaVersion: "1",
        kind: "VIDEO_SCREENPLAY",
        title: "正式视频剧本",
        subject: "数学",
        gradeBand: "小学",
        storyType: "STORY",
        targetDurationSeconds: 120,
        scenes: [
          {
            sequence: 1,
            title: "问题出现与推理推进",
            knowledgeFocus: "围绕本课核心数学问题逐步验证",
            emotionalPurpose: "从好奇到产生认知冲突",
            visualPresentation: "角色故事与观察演示",
            ambientSound: "轻微课堂环境声",
            effectSound: "转场提示音",
            interactionSound: "摆放与观察物体的轻响",
            voice: "自然清晰的小学生对白和教师式旁白",
            visualAction: "角色观察、比较并提出相互冲突的判断",
            dialogue: "我们看到的这一面，真的足以判断整个物体吗？",
            evidence: []
          }
        ]
      }
    };
  },
  validate(artifact, ctx) {
    return validateVideosBatchTextStage("SCREENPLAY", artifact, ctx);
  }
};

const fakeFinalStoryboard: StageDefinition<any> = {
  id: "FINAL_STORYBOARD",
  async execute(ctx) {
    const duration = Number((ctx.workflow.stages.SCREENPLAY?.artifact as any)?.targetDurationSeconds || 120);
    const references = [{ label: "【人物：示例学生角色】" }, { label: "【场景：课堂观察区】" }];
    const segmentCount = duration / 10;
    return {
      artifact: {
        schemaVersion: "2",
        title: "最终分镜",
        kind: "VIDEO_STORYBOARD",
        goal: "完整呈现课程导入故事并停在待解决的数学问题",
        overallScript: "从问题出现、冲突升级到留下课堂悬问，连续覆盖正式剧本。",
        visualContinuity: "同一角色和场景跨分镜保持稳定。",
        targetDuration: duration,
        aspectRatio: "16:9",
        deliveryMode: "SEGMENTED_MP4",
        format: "FINAL_10_SECOND",
        storyType: "STORY",
        segments: Array.from({ length: segmentCount }, (_, index) => ({
          sequence: index + 1,
          screenplaySceneSequence: 1,
          duration: 10,
          chapter: index === 0 ? "第1章" : undefined,
          scene: `课堂观察区中出现第${index + 1}个新的观察问题，角色继续推理，画面保持连续。`,
          characters: "【人物：示例学生角色】",
          keyProps: "【道具：观察尺】",
          visualEffects: [
            { sequence: 1, timeRange: "0-2秒", duration: 2, visual: "【人物：示例学生角色】中景建立人物和环境，突然出现异常", action: "角色发现问题", camera: "固定中景", sound: "环境声", voice: "为什么会这样？" },
            { sequence: 2, timeRange: "2-6秒", duration: 4, visual: "【道具：观察尺】近景呈现观察细节", action: "角色比较并记录变化", camera: "缓慢推近", sound: "轻响", voice: "无" },
            { sequence: 3, timeRange: "6-10秒", duration: 4, visual: "【场景：课堂观察区】回到主体中景", action: "角色提出新的疑问并停住", camera: "稳定跟随", sound: "提示音", voice: "这个问题该怎么解决？" }
          ],
          evidence: [],
          references,
        }))
      }
    };
  },
  validate(artifact, ctx) {
    return validateVideosBatchTextStage("FINAL_STORYBOARD", artifact, ctx);
  },
  async project(artifact, ctx) {
    if (!ctx.store) return;
    const sourceRevision = Number(ctx.workflow.stages.FINAL_STORYBOARD?.revision) || 0;
    const projected = await projectFinalStoryboardIntoSeeReel(ctx.store, ctx.session.id, artifact, {
      sourceRevision,
      sourceHash: canonicalStoryboardSourceHash(artifact)
    });
    (artifact.segments || []).forEach((segment: any, index: number) => {
      if (projected[index]) segment.nativeShotId = projected[index].id;
    });
  }
};

const fakeCopyablePrompt: StageDefinition<any> = {
  id: "COPYABLE_PROMPT",
  async execute(ctx) {
    return { artifact: deriveCopyablePrompt(ctx) };
  },
  validate(artifact, ctx) {
    return validateVideosBatchTextStage("COPYABLE_PROMPT", artifact, ctx);
  }
};

const fakeQuote: StageDefinition<any> = {
  id: "QUOTE",
  async execute(ctx) {
    const storyboard = ctx.workflow.stages.FINAL_STORYBOARD;
    const confirmation = ctx.workflow.stages.ASSET_CONFIRMATION?.artifact as any;
    const storyboardHash = storyboard?.artifact === undefined ? "" : contentHash(storyboard.artifact);
    const confirmationState = ctx.workflow.stages.ASSET_CONFIRMATION;
    const confirmationHash = confirmationState?.artifact === undefined ? "" : contentHash(confirmationState.artifact);
    return {
      artifact: {
        quoteId: `quote_${ctx.session.id}`,
        sourceStageRevision: storyboard?.revision || 0,
        sourceHash: storyboardHash,
        sourceHashes: {
          FINAL_STORYBOARD: storyboardHash,
          ASSET_CONFIRMATION: confirmationHash
        },
        targetDurationSeconds: Number((storyboard?.artifact as any)?.targetDuration || 0),
        assetOrder: (confirmation?.items || []).map((item: any) => item.publicAssetId),
        current: true
      }
    };
  },
  validate(artifact) {
    const errors: string[] = [];
    if (!String(artifact?.quoteId || "").trim()) errors.push("QUOTE requires quoteId");
    if (artifact?.current !== true) errors.push("QUOTE snapshot must be current");
    if (!Array.isArray(artifact?.assetOrder)) errors.push("QUOTE requires stable asset order snapshot");
    return { ok: errors.length === 0, errors };
  }
};

const fakeExecution: StageDefinition<any> = {
  id: "EXECUTION",
  async execute(ctx) {
    return {
      artifact: {
        executionId: `execution_${ctx.session.id}`,
        status: "READY",
        renderIds: ctx.shots.map((shot) => `render_fake_${shot.id}`),
        nativeShotIds: ctx.shots.map((shot) => shot.id)
      }
    };
  },
  validate(artifact) {
    const errors: string[] = [];
    if (!String(artifact?.executionId || "").trim()) errors.push("EXECUTION requires executionId");
    if (artifact?.status !== "READY") errors.push("EXECUTION fake contract must finish READY");
    return { ok: errors.length === 0, errors };
  },
  async project(artifact, ctx) {
    if (!ctx.store) return;
    const storyboard = ctx.workflow.stages.FINAL_STORYBOARD?.artifact as any;
    const confirmation = ctx.workflow.stages.ASSET_CONFIRMATION?.artifact as any;
    const shots = await applyConfirmedReferencesToNativeShots(ctx.store, ctx.session.id, storyboard || { segments: [] }, confirmation || {});
    artifact.nativeShotIds = shots.map((shot) => shot.id);
  }
};

const fakeStitch = pass("STITCH", {
  finalVideoUrl: "fake://videosbatch/final.mp4",
  status: "READY"
});

export function createPhase1FakeStageRegistry(): StageRegistry {
  return {
    COURSE_INTRO_CANDIDATES: fakeCourseIntroCandidates,
    STORY_SCRIPT: fakeStoryScript,
    ASSET_PLAN: fakeAssetPlan,
    ASSET_CANDIDATES: fakeAssetCandidates,
    SCREENPLAY: fakeScreenplay,
    FINAL_STORYBOARD: fakeFinalStoryboard,
    COPYABLE_PROMPT: fakeCopyablePrompt,
    QUOTE: fakeQuote,
    EXECUTION: fakeExecution,
    STITCH: fakeStitch
  };
}

export interface CreateVideosBatchStageRegistryOptions {
  /** Real structured text generation is opt-in dependency injection. */
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
