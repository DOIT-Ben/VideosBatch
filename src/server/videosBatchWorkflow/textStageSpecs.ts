import type { VideosBatchStageId, VideosBatchWorkflowState } from "../../shared/videosBatchWorkflow";
import type { JsonSchema } from "./llmExecutor";

export type VideosBatchTextStageId =
  | "INTRO_GENERATION"
  | "STORY_EXPANSION"
  | "ASSET_PROMPT_GENERATION"
  | "SCREENPLAY_GENERATION"
  | "STORYBOARD_GENERATION";

export const VIDEOS_BATCH_TEXT_STAGE_IDS: VideosBatchTextStageId[] = [
  "INTRO_GENERATION",
  "STORY_EXPANSION",
  "ASSET_PROMPT_GENERATION",
  "SCREENPLAY_GENERATION",
  "STORYBOARD_GENERATION"
];

export interface VideosBatchTextStageSpec {
  id: VideosBatchTextStageId;
  schemaName: string;
  systemPrompt: string;
  jsonSchema: JsonSchema;
  buildUserPrompt(workflow: VideosBatchWorkflowState): string;
}

const INTRO_IDS = ["A1", "A2", "A3", "B1", "B2", "B3", "C1", "C2", "C3"] as const;
const TRUTHFULNESS = ["真实史实", "真实背景下的合理改编", "完全虚构的故事化情境"] as const;

function stageArtifact(workflow: any, stageId: VideosBatchStageId): any {
  return workflow?.stages?.[stageId]?.artifact;
}

function lessonInput(workflow: any) {
  const artifact = stageArtifact(workflow, "LESSON_INPUT") || {};
  return {
    projectId: String(workflow?.projectId || artifact.projectId || "").trim(),
    lessonText: String(workflow?.lessonText || artifact.lessonText || "").trim()
  };
}

function selectedStory(workflow: any) {
  const expansion = stageArtifact(workflow, "STORY_EXPANSION");
  const stories = Array.isArray(expansion?.stories) ? expansion.stories : [];
  const selectedId = String(workflow?.selectedStoryId || "").trim();
  const story = stories.find((item: any) => String(item?.id || "") === selectedId) || (stories.length === 1 ? stories[0] : undefined);
  if (!story) throw new Error("VideosBatch selected story is not available for this stage");
  return story;
}

function recommendedIntros(workflow: any) {
  const intro = stageArtifact(workflow, "INTRO_GENERATION") || {};
  const candidates = Array.isArray(intro.candidates) ? intro.candidates : [];
  const recommendationIds = Array.isArray(intro.recommendations)
    ? intro.recommendations.map((item: any) => String(item?.id || "")).filter(Boolean)
    : Array.isArray(intro.recommendedIds)
      ? intro.recommendedIds.map((item: any) => String(item || "")).filter(Boolean)
      : [];
  if (!recommendationIds.length) return candidates.slice(0, 3);
  return recommendationIds
    .map((id: string) => candidates.find((candidate: any) => String(candidate?.id || "") === id))
    .filter(Boolean)
    .slice(0, 3);
}

const introSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    candidates: {
      type: "array",
      minItems: 9,
      maxItems: 9,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", enum: [...INTRO_IDS] },
          name: { type: "string" },
          creativeType: { type: "string" },
          body: { type: "string" },
          endingQuestion: { type: "string" },
          truthfulnessCategory: { type: "string", enum: [...TRUTHFULNESS] },
          truthfulnessNote: { type: "string" }
        },
        required: ["id", "name", "creativeType", "body", "endingQuestion", "truthfulnessCategory", "truthfulnessNote"]
      }
    },
    recommendations: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", enum: [...INTRO_IDS] },
          reason: { type: "string" }
        },
        required: ["id", "reason"]
      }
    }
  },
  required: ["candidates", "recommendations"]
};

const storySchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    stories: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          sourceIntroId: { type: "string" },
          title: { type: "string" },
          type: { type: "string" },
          truthfulnessNote: { type: "string" },
          content: { type: "string" }
        },
        required: ["id", "sourceIntroId", "title", "type", "truthfulnessNote", "content"]
      }
    }
  },
  required: ["stories"]
};

const assetSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    candidateAssets: {
      type: "array",
      items: { type: "string" }
    },
    omissionCheck: { type: "string" },
    assets: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          referenceId: { type: "string" },
          type: { type: "string", enum: ["character", "scene", "prop", "creature"] },
          name: { type: "string" },
          source: { type: "string" },
          usage: { type: "string" },
          prompt: { type: "string" }
        },
        required: ["referenceId", "type", "name", "source", "usage", "prompt"]
      }
    }
  },
  required: ["candidateAssets", "omissionCheck", "assets"]
};

const screenplaySchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    scenes: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          theme: { type: "string" },
          audienceEmotion: { type: "string" },
          presentationModes: {
            type: "array",
            minItems: 1,
            items: {
              type: "string",
              enum: ["动画示意", "历史场景再现", "实拍演示", "图表数据", "角色扮演", "混合"]
            }
          },
          soundEffects: {
            type: "object",
            additionalProperties: false,
            properties: {
              ambience: { type: "array", items: { type: "string" } },
              transition: { type: "array", items: { type: "string" } },
              action: { type: "array", items: { type: "string" } },
              voiceCue: { type: "array", items: { type: "string" } }
            },
            required: ["ambience", "transition", "action", "voiceCue"]
          },
          visuals: { type: "array", minItems: 1, items: { type: "string" } },
          dialogue: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                speaker: { type: "string" },
                tone: { type: "string" },
                text: { type: "string" }
              },
              required: ["speaker", "tone", "text"]
            }
          },
          knowledgePackaging: { type: "array", items: { type: "string" } }
        },
        required: [
          "id",
          "title",
          "theme",
          "audienceEmotion",
          "presentationModes",
          "soundEffects",
          "visuals",
          "dialogue",
          "knowledgePackaging"
        ]
      }
    }
  },
  required: ["scenes"]
};

const storyboardSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    storyboardType: { type: "string", enum: ["story", "science", "knowledge"] },
    shots: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          chapter: { type: "string" },
          sequence: { type: "string" },
          title: { type: "string" },
          scene: { type: "string" },
          subjects: { type: "array", items: { type: "string" } },
          props: { type: "array", items: { type: "string" } },
          durationSec: { type: "number", const: 10 },
          prompt: { type: "string" },
          subshots: {
            type: "array",
            minItems: 3,
            maxItems: 5,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                startSec: { type: "number", minimum: 0, maximum: 10 },
                endSec: { type: "number", minimum: 0, maximum: 10 },
                durationSec: { type: "number", exclusiveMinimum: 0, maximum: 10 },
                visual: { type: "string" },
                camera: { type: "string" },
                sound: { type: "string" },
                dialogue: { type: "string" }
              },
              required: ["startSec", "endSec", "durationSec", "visual", "camera", "sound", "dialogue"]
            }
          }
        },
        required: ["id", "chapter", "sequence", "title", "scene", "subjects", "props", "durationSec", "prompt", "subshots"]
      }
    }
  },
  required: ["storyboardType", "shots"]
};

const INTRO_SYSTEM = `你是一名小学数学课堂趣味导入创意策划专家。你的任务是依据教案生成可继续扩写为课堂导入视频的创意候选。严格服从给定的结构化输出合同，不输出 Markdown、表格或合同之外的分析。`;

const STORY_SYSTEM = `你是一名小学数学课程趣味导入故事创作专家。你的任务是把已经选定的课程导入分别扩写成完整故事，而不是写分镜、旁白、字幕或图片资产。严格服从结构化输出合同。`;

const ASSET_SYSTEM = `你是一名图片资产拆解与提示词生成专家。你要以不遗漏为优先级，从故事中提取可复用的视觉资产，建立稳定资产编号，并为每个确定资产生成独立图片提示词。严格服从结构化输出合同。`;

const SCREENPLAY_SYSTEM = `你是一名故事、科普与知识讲解类视频剧本改编专家。你要把故事改编为可拍摄、可动画化的视频剧本，保持事实和故事核心不被篡改。严格服从结构化输出合同。`;

const STORYBOARD_SYSTEM = `你是一名短视频分镜设计专家。你要把完整视频剧本转换成连续、可制作、课堂友好的10秒主分镜。严格服从结构化输出合同。`;

const specs: Record<VideosBatchTextStageId, VideosBatchTextStageSpec> = {
  INTRO_GENERATION: {
    id: "INTRO_GENERATION",
    schemaName: "videosbatch_intro_generation",
    systemPrompt: INTRO_SYSTEM,
    jsonSchema: introSchema,
    buildUserPrompt(workflow) {
      const { lessonText } = lessonInput(workflow);
      return `【教案内容】\n${lessonText}\n\n请为本课生成三类九套课程导入，必须完整覆盖并使用以下编号：\nA. 数学史与知识由来\n- A1：知识产生所要解决的原始问题\n- A2：可靠的数学史人物、事件或真实时代背景\n- A3：方法、工具或表示方式的形成与演变\nB. 历史需求与古今应用\n- B1：古代生产或生活中的真实需求\n- B2：同一问题在古代与现代的解决方式对照\n- B3：现代生活、工程、科技或公共服务中的真实应用\nC. 创意故事与现代情境\n- C1：学生熟悉的生活冲突或错误现场\n- C2：推理、游戏、挑战或任务情境\n- C3：科技现象、自然现象或具有画面感的异常情境\n\n硬性要求：\n1. 总计恰好9套，不得遗漏 A1、A2、A3、B1、B2、B3、C1、C2、C3。九套的开头、冲突来源、推进方式、场景和结尾要真正不同。\n2. 每套课程导入正文控制在200—300字，只写情境、人物需求、冲突升级、数学知识为何成为关键线索以及停在何处。\n3. 开头直接出现人物需求、异常、争议或问题；不要使用“今天我们来学习……”一类传统开场。\n4. 结尾只留下“为什么、怎么算、怎么量、怎么分、怎样比较或怎样解决”一类问题，不给答案，不提前讲透本课核心结论、方法、性质、公式或规律。\n5. 本阶段不要写500—800字完整故事，不写视频分镜、旁白、字幕或图片资产建议。\n6. 真实历史人物或事件只能使用公认事实；无法确认直接关系时不得写成某人“发明了”知识。虚构情节必须明确标注。真实性类别只能是：真实史实、真实背景下的合理改编、完全虚构的故事化情境。\n7. 完成9套后推荐恰好3套，每条推荐理由不超过80字，并综合课堂吸引力、核心知识连接强度和视频制作可行性。`;
    }
  },
  STORY_EXPANSION: {
    id: "STORY_EXPANSION",
    schemaName: "videosbatch_story_expansion",
    systemPrompt: STORY_SYSTEM,
    jsonSchema: storySchema,
    buildUserPrompt(workflow) {
      const { lessonText } = lessonInput(workflow);
      const intros = recommendedIntros(workflow);
      return `【教案内容】\n${lessonText}\n\n【选定的三套课程导入】\n${JSON.stringify(intros, null, 2)}\n\n请把以上三套导入分别扩写为3个完整故事。\n硬性要求：\n1. 严格围绕各自原导入展开，不得擅自改换课题、知识点或故事方向；每个故事的 sourceIntroId 必须指向对应导入。\n2. 每个完整故事控制在600—800字，语言适合对应年级和教师课堂口头讲述。\n3. 开头有悬念或真实问题需求；中间必须有冲突升级，数学知识点是解决冲突的关键线索。\n4. 结尾只留下“为什么、怎么算、怎么量、怎么分、怎样比较或怎样解决”的问题，不给答案，不提前讲透核心结论、公式、性质或规律。\n5. 不增加教材之外需要学生掌握的新数学知识、方法、例题、练习或结论。\n6. 三个故事在冲突来源、推进方式、场景和引出角度上明显不同。\n7. 若涉及历史人物或事件，保持公认事实；真实性说明用一句话说明属于真实史实、真实背景下的合理改编或完全虚构的故事化情境。\n8. 本阶段不输出分镜、旁白、字幕、镜头表或图片资产建议。`;
    }
  },
  ASSET_PROMPT_GENERATION: {
    id: "ASSET_PROMPT_GENERATION",
    schemaName: "videosbatch_asset_prompt_generation",
    systemPrompt: ASSET_SYSTEM,
    jsonSchema: assetSchema,
    buildUserPrompt(workflow) {
      const { projectId } = lessonInput(workflow);
      const story = selectedStory(workflow);
      return `【项目ID】\n${projectId}\n\n【故事文稿】\n${story.content || JSON.stringify(story)}\n\n请完成图片资产拆解和提示词生成。\n硬性要求：\n1. 逐段、逐句扫描所有可能形成图片资产的视觉对象，以不遗漏为最高优先级；先形成 candidateAssets，再做二次遗漏检查。\n2. 最终资产只分为四类并映射到结构化类型：人物/拟人动物=character；场景/空间环境=scene；兵器/法宝/道具=prop；神兽/灵宠/非拟人生物=creature。\n3. 同一基础资产只建立一次；同一角色不同造型尽量保持身份和外貌连续，不重复建立无意义基础资产。\n4. 稳定资产编号必须从 ${projectId}-A001 开始，依次为 ${projectId}-A002、${projectId}-A003……；编号全局唯一，不重复、不跳号。后续分镜会直接引用这些编号。\n5. 一个资产只生成一条图片提示词，不把人物、场景、道具、生物混进同一张资产图。\n6. 当前默认统一风格：高级影视级3D国漫CG风格，精致建模质感，结构准确，电影感柔和光影，画面干净，适合资产库复用。\n7. 人物提示词强调三视图/面部特写和角色一致性；场景必须纯环境空镜无人物；道具必须单体居中无手持；非拟人生物必须完整展示。\n8. 通用负面约束：不要文字、水印、logo、乱码、主体裁切、主体缺失、多余人物、复杂背景、比例错误、结构混乱、畸形肢体、多手多指、脸部崩坏、风格混乱、低清模糊。\n9. omissionCheck 必须明确说明已经按人物、场景、道具、生物四类完成二次核对。`;
    }
  },
  SCREENPLAY_GENERATION: {
    id: "SCREENPLAY_GENERATION",
    schemaName: "videosbatch_screenplay_generation",
    systemPrompt: SCREENPLAY_SYSTEM,
    jsonSchema: screenplaySchema,
    buildUserPrompt(workflow) {
      const story = selectedStory(workflow);
      return `【故事文稿】\n${story.content || JSON.stringify(story)}\n\n请把故事改编为完整视频剧本。\n硬性要求：\n1. 按视频内容模块或故事段落自然拆分场次，每场包含主题/知识点、受众情绪目的、主要呈现方式。\n2. 每场集中设计四类音效：环境/氛围、特效/转场、动作/交互、人声提示；没有的类别使用空数组。\n3. 画面与动作描述必须可视化，结合景别、运镜、画面内容与必要包装；每2—3句话可以切换画面或镜头角度，拒绝纯台词干讲。\n4. 对白/旁白必须标注 speaker、tone、text；原故事中的重要事实、数据、定义、时间、人物和结论不得篡改。\n5. 可按需加入知识包装，但不要为了“总结”而提前讲透本课原本要留给课堂的问题。\n6. 保持黄金开场、可视化原则、节奏推进和记忆锚点；避免血腥、恐怖、低俗、成人化和伪科学。\n7. 输出的是视频剧本，不是最终分镜；不要在本阶段硬拆10秒镜头。`;
    }
  },
  STORYBOARD_GENERATION: {
    id: "STORYBOARD_GENERATION",
    schemaName: "videosbatch_storyboard_generation",
    systemPrompt: STORYBOARD_SYSTEM,
    jsonSchema: storyboardSchema,
    buildUserPrompt(workflow) {
      const screenplay = stageArtifact(workflow, "SCREENPLAY_GENERATION");
      if (!screenplay) throw new Error("VideosBatch screenplay artifact is not available for storyboard generation");
      return `【视频剧本】\n${JSON.stringify(screenplay, null, 2)}\n\n请从开头到结尾完整拆分为连续主分镜，覆盖全部场次。\n硬性要求：\n1. 每个主分镜固定10秒，durationSec 必须为10。\n2. 每个主分镜拆成3-5个连续子镜头；每个子镜头写清 startSec、endSec、durationSec、画面、镜头、音效和台词/旁白；子镜头时长累计必须精准等于10秒。\n3. 前2秒优先提供钩子画面、异常、实验瞬间、人物需求或问题；中间推进冲突/变化/知识关系；最后2—3秒停在悬念、问题或课堂衔接点。\n4. 根据剧本的主要呈现方式，为整个剧本只选择一种 storyboardType，不得混用：角色扮演/叙事冲突为主=story；动画示意/图表数据/数学或科学原理为主=science；历史场景/人物事迹/知识来源为主=knowledge。\n5. 画面必须实际可制作，优先二维动画、课件动画、动态图解、简单角色动作、局部特写和轻量特效；禁止过度复杂大场面。\n6. 小学课堂内容保持清楚、友好、不过度惊吓；不提前讲透核心结论，保持数学关系、科学原理和历史事实准确。\n7. prompt 是该主分镜后续视频生成使用的完整自然语言画面描述；此时不要编造任何 P001-Axxx 一类资产ID，稳定资产引用将在后续 REFERENCE_BINDING 确定性阶段写入。`;
    }
  }
};

export function getVideosBatchTextStageSpec(stageId: VideosBatchTextStageId): VideosBatchTextStageSpec {
  const spec = specs[stageId];
  if (!spec) throw new Error(`No VideosBatch text-stage spec registered for ${stageId}`);
  return spec;
}
