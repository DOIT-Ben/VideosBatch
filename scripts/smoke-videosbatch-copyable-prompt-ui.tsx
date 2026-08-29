import React from "react";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { StoryboardStage } from "../src/client/videosBatchStudio/stages/StoryboardStage";

const storyboard = {
  schemaVersion: "1",
  title: "最终10秒分镜",
  kind: "VIDEO_STORYBOARD",
  goal: "留下数学悬问",
  overallScript: "完整导入",
  visualContinuity: "角色一致",
  targetDuration: 20,
  aspectRatio: "16:9",
  deliveryMode: "SEGMENTED_MP4",
  format: "FINAL_10_SECOND",
  storyType: "STORY",
  segments: [
    {
      sequence: 1,
      screenplaySceneSequence: 1,
      duration: 10,
      visualPrompt: "小宇观察立体模型",
      narration: "只看到一个面，真的能确定吗？",
      subtitles: "真的能确定吗？",
      teachingPurpose: "制造认知冲突",
      transition: "自然转场",
      evidence: [],
      references: [{ assetId: "P001-A001", publicAssetId: "P001-A001", label: "小宇" }],
      subshots: [
        { sequence: 1, duration: 3, visual: "中景", action: "观察", camera: "固定", sound: "环境声", voice: "旁白" },
        { sequence: 2, duration: 3, visual: "近景", action: "比较", camera: "推近", sound: "轻响", voice: "对白" },
        { sequence: 3, duration: 4, visual: "中景", action: "提问", camera: "稳定", sound: "提示音", voice: "悬问" }
      ]
    }
  ]
};

const copyablePrompt = {
  schemaVersion: "1",
  status: "READY",
  failedSegments: [],
  fullText: "分镜1\n画面效果：【P001-A001】 小宇观察立体模型\n教师旁白：只看到一个面，真的能确定吗？",
  segments: [
    {
      sequence: 1,
      text: "分镜1\n画面效果：【P001-A001】 小宇观察立体模型\n教师旁白：只看到一个面，真的能确定吗？",
      referenceAssetIds: ["P001-A001"]
    }
  ]
};

const markup = renderToStaticMarkup(
  <StoryboardStage
    artifact={storyboard}
    copyablePromptArtifact={copyablePrompt}
    copyablePromptStatus="ready"
    onSaveArtifact={() => undefined}
  />
);

assert.ok(markup.includes("分镜结构"), "storyboard step must expose the storyboard structure tab");
assert.ok(markup.includes("执行 Prompt"), "storyboard step must expose the copyable prompt tab");

const source = readFileSync(new URL("../src/client/videosBatchStudio/stages/StoryboardStage.tsx", import.meta.url), "utf8");
assert.ok(source.includes('Tabs'), "storyboard/copyable prompt switching must reuse Radix Tabs");
assert.ok(source.includes("copyablePromptArtifact"), "StoryboardStage must consume COPYABLE_PROMPT as a first-class artifact");
assert.ok(source.includes("复制全部 Prompt"), "copyable prompt UI must support copying the full execution prompt");
assert.ok(source.includes("复制本段"), "copyable prompt UI must support per-segment copying");

console.log("VideosBatch copyable prompt UI smoke: PASS");
