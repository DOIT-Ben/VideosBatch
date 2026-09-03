import {
  buildShotExecutionPackageFromStoryboard,
  type BuildShotExecutionPackageFromStoryboardInput,
  type ShotExecutionReferenceBindingInput
} from "./shotExecutionPackage";
import type { ShotExecutionPackage, ShotExecutionStoryType } from "../../shared/videosBatchWorkflow";

export interface ShotExecutionPackageFixture {
  finalStoryboard: Record<string, unknown>;
  screenplay: Record<string, unknown>;
  referenceBindings: ShotExecutionReferenceBindingInput[];
  package: ShotExecutionPackage;
}

type FixtureDefinition = {
  storyType: ShotExecutionStoryType;
  roleField: "characters" | "subjectObjects" | "coreImagery";
  supportField: "keyProps" | "supportingElements";
  roleLabel: "人物" | "主体" | "核心意象";
  supportLabel: "道具" | "辅助元素";
  roleName: string;
  supportName: string;
  sceneName: string;
  knowledgeFocus: string;
};

const DEFINITIONS: Record<ShotExecutionStoryType, FixtureDefinition> = {
  STORY: {
    storyType: "STORY",
    roleField: "characters",
    supportField: "keyProps",
    roleLabel: "人物",
    supportLabel: "道具",
    roleName: "林小满",
    supportName: "测量纸板",
    sceneName: "校园观察室",
    knowledgeFocus: "通过角色冲突理解测量与判断"
  },
  SCIENCE: {
    storyType: "SCIENCE",
    roleField: "subjectObjects",
    supportField: "supportingElements",
    roleLabel: "主体",
    supportLabel: "辅助元素",
    roleName: "水滴",
    supportName: "温度计",
    sceneName: "透明实验台",
    knowledgeFocus: "观察温度变化与水滴状态的关系"
  },
  KNOWLEDGE: {
    storyType: "KNOWLEDGE",
    roleField: "coreImagery",
    supportField: "supportingElements",
    roleLabel: "核心意象",
    supportLabel: "辅助元素",
    roleName: "古代算筹",
    supportName: "商贸账册",
    sceneName: "历史档案室",
    knowledgeFocus: "追溯算筹在真实生活中的知识由来"
  }
};

function makeFixture(definition: FixtureDefinition): ShotExecutionPackageFixture {
  const role = `【${definition.roleLabel}：${definition.roleName}】`;
  const support = `【${definition.supportLabel}：${definition.supportName}】`;
  const scene = `【场景：${definition.sceneName}】`;
  const finalStoryboard: Record<string, unknown> = {
    schemaVersion: "2",
    title: `${definition.storyType} 执行包分镜 fixture`,
    kind: "VIDEO_STORYBOARD",
    goal: `用一条十秒镜头呈现${definition.knowledgeFocus}。`,
    overallScript: "从异常出现、观察推进到留下待解问题。",
    visualContinuity: "主体、空间、方向和光线在镜头内保持连续。",
    targetDuration: 10,
    aspectRatio: "16:9",
    deliveryMode: "SEGMENTED_MP4",
    format: "FINAL_10_SECOND",
    storyType: definition.storyType,
    segments: [{
      sequence: 1,
      chapter: "第1章",
      screenplaySceneSequence: 1,
      duration: 10,
      scene: `${definition.sceneName}中，${definition.roleName}发现一个需要验证的问题。`,
      [definition.roleField]: role,
      [definition.supportField]: support,
      evidence: [{ source: "fixture教材页", quote: definition.knowledgeFocus }],
      references: [
        { label: role },
        { label: scene },
        { label: support }
      ],
      visualEffects: [
        {
          sequence: 1,
          timeRange: "0-2秒",
          duration: 2,
          visual: `${role}在${scene}中突然发现异常。`,
          action: "角色停下并抬头观察",
          camera: "固定中景建立空间",
          sound: "环境声",
          voice: "为什么会出现这个异常？"
        },
        {
          sequence: 2,
          timeRange: "2-6秒",
          duration: 4,
          visual: `${support}呈现关键细节。`,
          action: "角色比较并记录变化",
          camera: "缓慢推近到细节",
          sound: "纸张轻响",
          voice: "无"
        },
        {
          sequence: 3,
          timeRange: "6-10秒",
          duration: 4,
          visual: `${role}回到${scene}并保留未解线索。`,
          action: "角色转身留下悬问",
          camera: "稳定跟随收束画面",
          sound: "提示音",
          voice: "怎样才能验证这个判断？"
        }
      ]
    }]
  };
  const screenplay: Record<string, unknown> = {
    schemaVersion: "1",
    kind: "VIDEO_SCREENPLAY",
    storyType: definition.storyType,
    scenes: [{ sequence: 1, knowledgeFocus: definition.knowledgeFocus, evidence: [{ source: "fixture教材页", quote: definition.knowledgeFocus }] }]
  };
  const referenceBindings: ShotExecutionReferenceBindingInput[] = [
    { referenceId: "ref-role", ordinal: 1, assetKey: `${definition.storyType}-ROLE`, semanticLabel: role, assetId: `asset_fixture_${definition.storyType.toLowerCase()}_role`, imageUrl: `https://fixture.invalid/${definition.storyType.toLowerCase()}/role.png` },
    { referenceId: "ref-scene", ordinal: 2, assetKey: `${definition.storyType}-SCENE`, semanticLabel: scene, assetId: `asset_fixture_${definition.storyType.toLowerCase()}_scene`, imageUrl: `https://fixture.invalid/${definition.storyType.toLowerCase()}/scene.png` },
    { referenceId: "ref-support", ordinal: 3, assetKey: `${definition.storyType}-SUPPORT`, semanticLabel: support, assetId: `asset_fixture_${definition.storyType.toLowerCase()}_support`, imageUrl: `https://fixture.invalid/${definition.storyType.toLowerCase()}/support.png` }
  ];
  const input: BuildShotExecutionPackageFromStoryboardInput = {
    finalStoryboard,
    segment: 1,
    sourceRevision: 1,
    screenplay,
    referenceBindings
  };
  return { finalStoryboard, screenplay, referenceBindings, package: buildShotExecutionPackageFromStoryboard(input) };
}

const FIXTURES = {
  STORY: makeFixture(DEFINITIONS.STORY),
  SCIENCE: makeFixture(DEFINITIONS.SCIENCE),
  KNOWLEDGE: makeFixture(DEFINITIONS.KNOWLEDGE)
} as const;

export const STORY_FINAL_STORYBOARD_FIXTURE = FIXTURES.STORY.finalStoryboard;
export const SCIENCE_FINAL_STORYBOARD_FIXTURE = FIXTURES.SCIENCE.finalStoryboard;
export const KNOWLEDGE_FINAL_STORYBOARD_FIXTURE = FIXTURES.KNOWLEDGE.finalStoryboard;

export const STORY_SHOT_EXECUTION_PACKAGE_FIXTURE = FIXTURES.STORY.package;
export const SCIENCE_SHOT_EXECUTION_PACKAGE_FIXTURE = FIXTURES.SCIENCE.package;
export const KNOWLEDGE_SHOT_EXECUTION_PACKAGE_FIXTURE = FIXTURES.KNOWLEDGE.package;

export const SHOT_EXECUTION_PACKAGE_FIXTURES = {
  STORY: STORY_SHOT_EXECUTION_PACKAGE_FIXTURE,
  SCIENCE: SCIENCE_SHOT_EXECUTION_PACKAGE_FIXTURE,
  KNOWLEDGE: KNOWLEDGE_SHOT_EXECUTION_PACKAGE_FIXTURE
} as const;

export const SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS = {
  STORY: FIXTURES.STORY,
  SCIENCE: FIXTURES.SCIENCE,
  KNOWLEDGE: FIXTURES.KNOWLEDGE
} as const;

// Lowercase aliases make the fixtures convenient in focused smoke scripts.
export const storyShotExecutionPackageFixture = STORY_SHOT_EXECUTION_PACKAGE_FIXTURE;
export const scienceShotExecutionPackageFixture = SCIENCE_SHOT_EXECUTION_PACKAGE_FIXTURE;
export const knowledgeShotExecutionPackageFixture = KNOWLEDGE_SHOT_EXECUTION_PACKAGE_FIXTURE;
