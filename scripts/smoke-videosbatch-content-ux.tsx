import React from "react";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { Asset } from "../src/shared/types";
import {
  buildAssetCandidateGroups,
  buildAssetConfirmationArtifact,
  updateStoryArtifactContent,
  updateScreenplaySceneFields,
  updateStoryboardSegmentFields,
  preferredShotVideoUrl,
  preferredFinalVideo
} from "../src/client/videosBatchStudio/contentModel";
import { AssetGalleryStage } from "../src/client/videosBatchStudio/stages/AssetGalleryStage";
import { ScreenplayStage } from "../src/client/videosBatchStudio/stages/ScreenplayStage";
import { StoryboardStage } from "../src/client/videosBatchStudio/stages/StoryboardStage";
import { ExecutionStage } from "../src/client/videosBatchStudio/stages/ExecutionStage";
import { FinalVideoStage } from "../src/client/videosBatchStudio/stages/FinalVideoStage";

const now = "2026-08-29T08:00:00.000Z";
const nativeAssets: Asset[] = [
  {
    id: "asset_candidate_1",
    name: "小宇候选1",
    type: "character",
    mediaKind: "image",
    description: "候选1",
    prompt: "prompt 1",
    imageUrl: "https://cdn.example.com/xiaoyu-1.png",
    thumbnailUrl: "https://cdn.example.com/xiaoyu-1-thumb.png",
    tags: ["videosbatch"],
    workflowReferenceId: "P001-A001",
    ownerSessionId: "session-1",
    createdAt: now,
    updatedAt: now
  },
  {
    id: "asset_candidate_2",
    name: "小宇候选2",
    type: "character",
    mediaKind: "image",
    description: "候选2",
    prompt: "prompt 2",
    sourceImageUrl: "https://cdn.example.com/xiaoyu-2.png",
    tags: ["videosbatch"],
    workflowReferenceId: "P001-A001",
    ownerSessionId: "session-1",
    createdAt: now,
    updatedAt: now
  }
];

const plan = {
  items: [{
    assetKey: "CHARACTER-XIAOYU",
    assetId: "P001-A001",
    name: "小宇",
    description: "故事中的主要观察者"
  }]
};
const candidates = {
  items: [{
    assetKey: "CHARACTER-XIAOYU",
    publicAssetId: "P001-A001",
    candidateAssetIds: ["asset_candidate_1", "asset_candidate_2"]
  }]
};
const confirmation = {
  confirmed: false,
  items: [{
    assetKey: "CHARACTER-XIAOYU",
    publicAssetId: "P001-A001",
    candidateAssetIds: ["asset_candidate_1", "asset_candidate_2"],
    selectedAssetId: "asset_candidate_2"
  }]
};

const groups = buildAssetCandidateGroups(plan, candidates, confirmation, nativeAssets);
assert.equal(groups.length, 1);
assert.equal(groups[0].candidates.length, 2);
assert.equal(groups[0].candidates[0].previewUrl, "https://cdn.example.com/xiaoyu-1-thumb.png");
assert.equal(groups[0].candidates[1].previewUrl, "https://cdn.example.com/xiaoyu-2.png");
assert.equal(groups[0].selectedAssetId, "asset_candidate_2", "existing user selection must be preserved");

const nextConfirmation = buildAssetConfirmationArtifact(groups, {
  "CHARACTER-XIAOYU": "asset_candidate_1"
});
assert.equal(nextConfirmation.confirmed, true);
assert.deepEqual(nextConfirmation.items[0].candidateAssetIds, ["asset_candidate_1", "asset_candidate_2"]);
assert.equal(nextConfirmation.items[0].selectedAssetId, "asset_candidate_1");

const story = {
  schemaVersion: "2",
  kind: "LESSON_INTRO_VIDEO_SCRIPT",
  title: "蒙眼侦探",
  storyType: "故事叙事型",
  truthfulnessNote: "虚构课堂情境",
  content: "旧正文"
};
const editedStory = updateStoryArtifactContent(story, "新的完整故事正文");
assert.equal(editedStory.content, "新的完整故事正文");
assert.equal(editedStory.title, story.title);
assert.equal(editedStory.schemaVersion, "2");
assert.notEqual(editedStory, story, "editing must return a new artifact object");

const screenplay = {
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
      title: "问题出现",
      knowledgeFocus: "观察物体",
      emotionalPurpose: "好奇",
      visualPresentation: "故事",
      ambientSound: "教室声",
      effectSound: "提示音",
      interactionSound: "桌面声",
      voice: "学生对白",
      visualAction: "观察模型",
      dialogue: "真的能确定吗？",
      evidence: [{ source: "教材", quote: "观察物体" }]
    }
  ]
};
const editedScreenplay = updateScreenplaySceneFields(screenplay, 1, {
  visualAction: "小宇绕着模型观察",
  dialogue: "只看到一个面，真的够吗？"
});
assert.equal(editedScreenplay.scenes[0].visualAction, "小宇绕着模型观察");
assert.equal(editedScreenplay.scenes[0].dialogue, "只看到一个面，真的够吗？");
assert.deepEqual(editedScreenplay.scenes[0].evidence, screenplay.scenes[0].evidence, "screenplay edit must preserve evidence");
assert.equal(editedScreenplay.targetDurationSeconds, 120, "screenplay edit must preserve duration contract");
assert.notEqual(editedScreenplay.scenes[0], screenplay.scenes[0], "screenplay scene edit must be immutable");

const storyboard = {
  schemaVersion: "1",
  title: "最终10秒分镜",
  kind: "VIDEO_STORYBOARD",
  goal: "留下数学悬问",
  overallScript: "完整导入",
  visualContinuity: "角色一致",
  targetDuration: 120,
  aspectRatio: "16:9",
  deliveryMode: "SEGMENTED_MP4",
  format: "FINAL_10_SECOND",
  storyType: "STORY",
  segments: [
    {
      sequence: 1,
      screenplaySceneSequence: 1,
      duration: 10,
      visualPrompt: "原始画面",
      narration: "原始旁白",
      subtitles: "原始字幕",
      teachingPurpose: "制造冲突",
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
const editedStoryboard = updateStoryboardSegmentFields(storyboard, 1, {
  visualPrompt: "新的画面提示",
  narration: "新的旁白"
});
assert.equal(editedStoryboard.segments[0].visualPrompt, "新的画面提示");
assert.equal(editedStoryboard.segments[0].narration, "新的旁白");
assert.equal(editedStoryboard.segments[0].duration, 10, "storyboard edit must preserve the 10-second contract");
assert.deepEqual(editedStoryboard.segments[0].references, storyboard.segments[0].references, "storyboard edit must preserve stable asset references");
assert.deepEqual(editedStoryboard.segments[0].subshots, storyboard.segments[0].subshots, "main segment edit must not silently rewrite subshots");
assert.notEqual(editedStoryboard.segments[0], storyboard.segments[0], "storyboard segment edit must be immutable");

assert.equal(preferredShotVideoUrl({ playbackVideoUrl: "https://cdn.example.com/shot.mp4", videoUrl: "local.mp4" } as any), "https://cdn.example.com/shot.mp4");
assert.deepEqual(
  preferredFinalVideo({
    stitchJobs: [{ id: "stitch-1", shotIds: [], status: "ready", finalVideoPlaybackUrl: "https://cdn.example.com/final.mp4", finalVideoDownloadUrl: "https://cdn.example.com/final-download.mp4", createdAt: now }]
  } as any),
  { playbackUrl: "https://cdn.example.com/final.mp4", downloadUrl: "https://cdn.example.com/final-download.mp4", status: "ready", progress: "" }
);

const assetMarkup = renderToStaticMarkup(
  <AssetGalleryStage
    planArtifact={plan}
    candidatesArtifact={candidates}
    confirmationArtifact={confirmation}
    nativeAssets={nativeAssets}
    selectedAssetIds={{ "CHARACTER-XIAOYU": "asset_candidate_2" }}
    onSelectAsset={() => undefined}
    busy={false}
    onConfirmAll={() => undefined}
  />
);
assert.ok(assetMarkup.includes("xiaoyu-1-thumb.png"), "asset gallery must render real SeeReel candidate images");
assert.ok(assetMarkup.includes("xiaoyu-2.png"), "asset gallery must render every generated candidate image");
assert.ok(assetMarkup.includes("已选择"), "selected candidate must be visibly marked");

const screenplayMarkup = renderToStaticMarkup(
  <ScreenplayStage artifact={screenplay} onSaveArtifact={() => undefined} />
);
assert.ok(screenplayMarkup.includes("编辑视频剧本"), "screenplay page must expose structured editing");

const storyboardMarkup = renderToStaticMarkup(
  <StoryboardStage artifact={storyboard} onSaveArtifact={() => undefined} />
);
assert.ok(storyboardMarkup.includes("编辑分镜"), "storyboard page must expose structured editing");

const shotMarkup = renderToStaticMarkup(
  <ExecutionStage
    quoteArtifact={{ targetDurationSeconds: 20, assetOrder: ["P001-A001"] }}
    executionArtifact={{ status: "READY", nativeShotIds: ["shot-1"] }}
    shots={[{
      id: "shot-1", sessionId: "session-1", index: 0, title: "镜头一", script: "", camera: "", durationSec: 10,
      assetIds: [], prompt: "", playbackVideoUrl: "https://cdn.example.com/shot-1.mp4", status: "ready", createdAt: now, updatedAt: now
    }]}
    onOpenCanvas={() => undefined}
  />
);
assert.ok(shotMarkup.includes("shot-1.mp4"), "execution page must render native shot video playback");
assert.ok(shotMarkup.includes("已完成"), "execution page must show native shot readiness");

const finalMarkup = renderToStaticMarkup(
  <FinalVideoStage
    artifact={{ status: "READY", finalVideoUrl: "fake://videosbatch/final.mp4" }}
    session={{ id: "session-1", title: "demo", logline: "", style: "", targetDurationSec: 20, createdAt: now, updatedAt: now, stitchJobs: [{ id: "stitch-1", shotIds: ["shot-1"], status: "ready", finalVideoPlaybackUrl: "https://cdn.example.com/final.mp4", finalVideoDownloadUrl: "https://cdn.example.com/final-download.mp4", createdAt: now }] } as any}
    onOpenCanvas={() => undefined}
  />
);
assert.ok(finalMarkup.includes("https://cdn.example.com/final.mp4"), "final page must prefer native SeeReel stitch playback URL");
assert.ok(finalMarkup.includes("final-download.mp4"), "final page must expose native SeeReel download URL");

const packageSource = readFileSync(new URL("../package.json", import.meta.url), "utf8");
assert.ok(packageSource.includes('"radix-ui"'), "accessible Dialog/Tabs/ScrollArea primitives must come from Radix UI");
const drawerSource = readFileSync(new URL("../src/client/videosBatchStudio/components/ArtifactDebugDrawer.tsx", import.meta.url), "utf8");
assert.ok(drawerSource.includes('from "radix-ui"'), "debug drawer must use Radix Dialog instead of a hand-rolled modal");
const storyboardSource = readFileSync(new URL("../src/client/videosBatchStudio/stages/StoryboardStage.tsx", import.meta.url), "utf8");
assert.ok(storyboardSource.includes("Accordion"), "storyboard segment expansion must reuse Radix Accordion instead of custom collapse logic");

console.log("VideosBatch content UX smoke: PASS");
