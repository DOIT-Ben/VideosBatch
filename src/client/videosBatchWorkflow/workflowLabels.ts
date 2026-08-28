import type { VideosBatchStageId } from "../../shared/videosBatchWorkflow";

export const WORKFLOW_LABELS: Record<VideosBatchStageId, string> = {
  LESSON_INPUT: "教案",
  COURSE_INTRO_CANDIDATES: "三类九套课程导入",
  COURSE_INTRO_SELECTION: "锁定课程导入",
  STORY_SCRIPT: "故事文稿",
  ASSET_PLAN: "资产计划与提示词",
  ASSET_CANDIDATES: "资产候选图",
  ASSET_CONFIRMATION: "确认资产",
  SCREENPLAY: "正式视频剧本",
  FINAL_STORYBOARD: "最终10秒分镜",
  COPYABLE_PROMPT: "垫图副本",
  QUOTE: "报价",
  EXECUTION: "视频执行",
  STITCH: "最终拼接"
};

export const WORKFLOW_STATUS_LABELS = {
  pending: "待处理",
  running: "处理中",
  ready: "已完成",
  failed: "失败",
  stale: "需更新"
} as const;
