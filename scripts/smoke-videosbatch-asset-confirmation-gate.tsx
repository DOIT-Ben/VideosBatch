import React from "react";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { Asset } from "../src/shared/types";
import { isAssetConfirmationComplete } from "../src/client/videosBatchStudio/contentModel";
import { AssetGalleryStage } from "../src/client/videosBatchStudio/stages/AssetGalleryStage";
import { assetsNeedConfirmation } from "../src/client/videosBatchStudio/stageModel";

const plan = {
  items: [{
    assetKey: "CHARACTER-XIAOYU",
    assetId: "P001-A001",
    name: "小宇",
    description: "故事中的主要观察者"
  }]
};

// After an upstream regeneration the candidate ids change: the old confirmed
// selection (asset_old_1) is no longer among the current candidates (asset_new_1).
const candidatesAfterRegeneration = {
  items: [{
    assetKey: "CHARACTER-XIAOYU",
    publicAssetId: "P001-A001",
    candidateAssetIds: ["asset_new_1"]
  }]
};

// A stale ASSET_CONFIRMATION artifact that still carries confirmed: true.
const staleConfirmedArtifact = {
  confirmed: true,
  items: [{
    assetKey: "CHARACTER-XIAOYU",
    publicAssetId: "P001-A001",
    candidateAssetIds: ["asset_old_1"],
    selectedAssetId: "asset_old_1"
  }]
};

const completeArtifact = {
  confirmed: true,
  items: [{
    assetKey: "CHARACTER-XIAOYU",
    publicAssetId: "P001-A001",
    candidateAssetIds: ["asset_new_1"],
    selectedAssetId: "asset_new_1"
  }]
};

// --- isAssetConfirmationComplete: unit rules ---

assert.equal(
  isAssetConfirmationComplete(plan, candidatesAfterRegeneration, staleConfirmedArtifact),
  false,
  "a stale confirmed artifact whose selection is no longer a current candidate must not count as complete"
);
assert.equal(
  isAssetConfirmationComplete(plan, candidatesAfterRegeneration, completeArtifact),
  true,
  "a confirmed artifact whose selection matches the current candidates is complete"
);
assert.equal(
  isAssetConfirmationComplete(plan, candidatesAfterRegeneration, { confirmed: false, items: completeArtifact.items }),
  false,
  "an unconfirmed artifact is never complete"
);
assert.equal(
  isAssetConfirmationComplete({ items: [] }, candidatesAfterRegeneration, completeArtifact),
  false,
  "an empty asset plan cannot satisfy the gate"
);
assert.equal(
  isAssetConfirmationComplete(
    plan,
    candidatesAfterRegeneration,
    { confirmed: true, items: [{ assetKey: "CHARACTER-XIAOYU", publicAssetId: "", selectedAssetId: "asset_new_1" }] }
  ),
  false,
  "a confirmed item without publicAssetId is not complete"
);
assert.equal(
  isAssetConfirmationComplete(
    plan,
    candidatesAfterRegeneration,
    { confirmed: true, items: [] }
  ),
  false,
  "confirmation items must cover every plan item"
);

// --- stageModel.assetsNeedConfirmation must reuse the same rule ---

assert.equal(
  assetsNeedConfirmation({
    currentStage: "ASSET_CONFIRMATION",
    stages: {
      ASSET_PLAN: { artifact: plan },
      ASSET_CANDIDATES: { artifact: candidatesAfterRegeneration },
      ASSET_CONFIRMATION: { artifact: staleConfirmedArtifact, status: "stale" }
    }
  } as any),
  true,
  "stageModel must treat a stale confirmed artifact as still needing confirmation"
);

// --- AssetGalleryStage must keep the confirm bar visible in the deadlock case ---

const nativeAssets: Asset[] = [{
  id: "asset_new_1",
  name: "小宇候选1",
  type: "character",
  mediaKind: "image",
  description: "候选1",
  prompt: "prompt 1",
  imageUrl: "https://cdn.example.com/xiaoyu-new.png",
  thumbnailUrl: "https://cdn.example.com/xiaoyu-new-thumb.png",
  tags: ["videosbatch"],
  workflowReferenceId: "P001-A001",
  ownerSessionId: "session-1",
  createdAt: "2026-08-30T08:00:00.000Z",
  updatedAt: "2026-08-30T08:00:00.000Z"
}];

function renderGallery(confirmationArtifact: any) {
  return renderToStaticMarkup(
    <AssetGalleryStage
      planArtifact={plan}
      candidatesArtifact={candidatesAfterRegeneration}
      confirmationArtifact={confirmationArtifact}
      nativeAssets={nativeAssets}
      selectedAssetIds={{}}
      onSelectAsset={() => undefined}
      busy={false}
      onConfirmAll={() => undefined}
    />
  );
}

const staleMarkup = renderGallery(staleConfirmedArtifact);
assert.ok(
  staleMarkup.includes("确认全部资产"),
  "the confirmation bar must stay visible while the gate is not satisfied, even with confirmed: true"
);

const completeMarkup = renderGallery(completeArtifact);
assert.ok(
  !completeMarkup.includes("确认全部资产"),
  "the confirmation bar must hide once the confirmation is complete"
);

// --- source contract: the confirm bar no longer depends on confirmed alone ---

const gallerySource = readFileSync(new URL("../src/client/videosBatchStudio/stages/AssetGalleryStage.tsx", import.meta.url), "utf8");
assert.ok(
  gallerySource.includes("isAssetConfirmationComplete(planArtifact, candidatesArtifact, confirmationArtifact)"),
  "AssetGalleryStage must gate the confirm bar on the shared completeness rule"
);
assert.ok(
  !gallerySource.includes("!confirmationArtifact?.confirmed && ("),
  "the confirm bar must not render based on the confirmed flag alone"
);

const stageModelSource = readFileSync(new URL("../src/client/videosBatchStudio/stageModel.ts", import.meta.url), "utf8");
assert.ok(
  stageModelSource.includes("isAssetConfirmationComplete"),
  "stageModel must derive assetsNeedConfirmation from the shared completeness rule"
);

console.log("asset confirmation gate smoke passed");
