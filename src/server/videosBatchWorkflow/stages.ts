import type { StageDefinition, StageRegistry } from "./stageContracts";
import type { VideosBatchStageId } from "../../shared/videosBatchWorkflow";
import type { VideosBatchLlmExecutor } from "./llmExecutor";
import { createVideosBatchLlmTextStageRegistry, validateVideosBatchTextStage } from "./llmTextStages";
import {
  applyConfirmedReferencesToNativeShots,
  projectAssetCandidatesIntoSeeReel,
  projectFinalStoryboardIntoSeeReel
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

function projectIdFromWorkflow(ctx: any) {
  return String(ctx.workflow.stages.LESSON_INPUT?.artifact?.projectId || "P001").trim();
}

function fakeIntroArtifact() {
  const ids = ["A-01", "A-02", "A-03", "B-01", "B-02", "B-03", "C-01", "C-02", "C-03"];
  return {
    candidates: ids.map((id, index) => ({
      id,
      name: `课程导入 ${id}`,
      creativeType: index < 3 ? "数学史与知识由来" : index < 6 ? "历史需求与古今应用" : "创意故事与现代情境",
      body: `这是${id}的课程导入。` + "学生围绕一个真实而清晰的问题展开观察、比较和推理，冲突逐步升级，本课数学知识成为解决问题的关键线索，但此处仍然不揭示结论。".repeat(4).slice(0, 210),
      endingQuestion: "究竟应该怎样判断并解决这个问题？",
      truthfulnessCategory: "完全虚构的故事化情境",
      truthfulnessNote: "用于结构化工作流测试的虚构教学情境。"
    })),
    recommendations: [
      { id: "A-01", reason: "知识连接清晰，课堂吸引力强，便于视频化。" },
      { id: "B-01", reason: "需求明确，能自然引出核心问题，场景易制作。" },
      { id: "C-01", reason: "冲突直观，学生容易代入，镜头表达简单。" }
    ]
  };
}

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
        content: ("故事从一个明确的问题开始，学生发现仅凭眼前看到的现象无法直接作出结论，于是不断提出新的猜测并寻找证据。随着不同观察角度和条件逐步出现，原先看似确定的判断开始产生冲突，大家必须依靠本课的数学知识来重新组织线索。人物通过观察、比较、讨论和验证推进情节，但故事始终不提前给出课堂要学习的最终规律。最后，所有线索汇聚到一个尚未解决的问题上：怎样才能用更可靠的方法完成判断？").repeat(4).slice(0, 680)
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
        candidateAssets: ["示例学生角色"],
        omissionCheck: "已逐段回看故事，当前最小验证资产完整。",
        items: [
          {
            assetKey: "CHARACTER-HERO",
            category: "CHARACTER",
            name: "示例学生角色",
            description: "故事中的主要观察者，保持跨镜头形象一致。",
            prompt: "高级影视级3D国漫CG风格人物三视图，正面全身、侧面全身、背面全身、面部特写，四格横向排列，纯白背景，16:9。",
            aspectRatio: "16:9",
            continuityNotes: "脸型、五官、发色、体型和基础服装保持一致。",
            sourceEvidence: "故事中的主要观察与推理角色。"
          }
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
    const confirmation = ctx.workflow.stages.ASSET_CONFIRMATION?.artifact as any;
    const firstConfirmed = Array.isArray(confirmation?.items) ? confirmation.items[0] : undefined;
    const references = firstConfirmed?.publicAssetId
      ? [{ assetId: firstConfirmed.publicAssetId, publicAssetId: firstConfirmed.publicAssetId, label: "示例学生角色" }]
      : [];
    const segmentCount = duration / 10;
    return {
      artifact: {
        schemaVersion: "1",
        title: "最终10秒分镜",
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
          visualPrompt: `第${index + 1}条正式分镜：角色继续观察和推理，画面保持连续。`,
          narration: `第${index + 1}段旁白。`,
          subtitles: `第${index + 1}段字幕。`,
          teachingPurpose: "推进问题情境但不提前给出结论。",
          transition: index + 1 === segmentCount ? "停在课堂悬问" : "自然连续转场",
          evidence: [],
          references,
          subshots: [
            { sequence: 1, duration: 3, visual: "中景建立人物和环境", action: "角色观察", camera: "固定中景", sound: "环境声", voice: "自然旁白" },
            { sequence: 2, duration: 3, visual: "近景呈现观察细节", action: "角色比较", camera: "缓慢推近", sound: "轻微交互声", voice: "角色对白" },
            { sequence: 3, duration: 4, visual: "回到双人或主体中景", action: "角色提出新的疑问", camera: "稳定跟随", sound: "转场提示音", voice: "留下悬问" }
          ]
        }))
      }
    };
  },
  validate(artifact, ctx) {
    return validateVideosBatchTextStage("FINAL_STORYBOARD", artifact, ctx);
  },
  async project(artifact, ctx) {
    if (!ctx.store) return;
    const projected = await projectFinalStoryboardIntoSeeReel(ctx.store, ctx.session.id, artifact);
    (artifact.segments || []).forEach((segment: any, index: number) => {
      if (projected[index]) segment.nativeShotId = projected[index].id;
    });
  }
};

const fakeCopyablePrompt: StageDefinition<any> = {
  id: "COPYABLE_PROMPT",
  async execute(ctx) {
    const storyboard = ctx.workflow.stages.FINAL_STORYBOARD?.artifact as any;
    const segments = (storyboard?.segments || []).map((segment: any) => {
      const refs = (segment.references || [])
        .map((reference: any) => String(reference.publicAssetId || reference.assetId || ""))
        .filter(Boolean)
        .slice(0, 7);
      const markers = refs.map((id: string) => `【${id}】`).join(" ");
      const text = `分镜${segment.sequence}\n画面效果：${markers}${markers ? " " : ""}${segment.visualPrompt}\n教师旁白：${segment.narration}\n字幕：${segment.subtitles}\n音效与转场：${segment.transition}`;
      return { sequence: segment.sequence, text, referenceAssetIds: refs };
    });
    return {
      artifact: {
        schemaVersion: "1",
        fullText: segments.map((segment: any) => segment.text).join("\n\n"),
        status: "READY",
        failedSegments: [],
        segments
      }
    };
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
    return {
      artifact: {
        quoteId: `quote_${ctx.session.id}`,
        sourceStageRevision: storyboard?.revision || 0,
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
        renderIds: ctx.shots.map((shot) => `render_fake_${shot.id}`)
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
