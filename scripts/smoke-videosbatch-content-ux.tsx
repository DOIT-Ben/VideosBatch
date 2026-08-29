import React from "react";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { Asset } from "../src/shared/types";
import {
  buildAssetCandidateGroups,
  buildAssetConfirmationArtifact,
  updateStoryArtifactContent,
  preferredShotVideoUrl,
  preferredFinalVideo
} from "../src/client/videosBatchStudio/contentModel";
import { AssetGalleryStage } from "../src/client/videosBatchStudio/stages/AssetGalleryStage";
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

console.log("VideosBatch content UX smoke: PASS");
