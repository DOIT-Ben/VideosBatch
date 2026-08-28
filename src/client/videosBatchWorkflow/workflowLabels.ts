import type { VideosBatchStageId } from "../../shared/videosBatchWorkflow";

export const WORKFLOW_LABELS: Record<VideosBatchStageId, string> = {
  LESSON_INPUT: "教案",
  INTRO_GENERATION: "三类九套课程导入",
  STORY_EXPANSION: "三个完整故事",
  STORY_SELECTION: "选定故事",
  ASSET_PROMPT_GENERATION: "资产拆解与提示词",
  ASSET_GENERATION: "资产图片",
  SCREENPLAY_GENERATION: "视频剧本",
  STORYBOARD_GENERATION: "10秒分镜",
  REFERENCE_BINDING: "资产引用",
  VIDEO_GENERATION: "视频生成",
  STITCH: "最终拼接"
};

export const WORKFLOW_STATUS_LABELS = {
  pending: "待生成",
  running: "生成中",
  ready: "已完成",
  failed: "失败",
  stale: "需更新"
} as const;
