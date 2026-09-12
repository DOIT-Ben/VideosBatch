import { strict as assert } from "node:assert";
import {
  buildShotExecutionPackageFromStoryboard,
  createShotExecutionPackage,
  hashShotExecutionPackage,
  validateShotExecutionPackage
} from "../src/server/videosBatchWorkflow/shotExecutionPackage";
import {
  SHOT_EXECUTION_PACKAGE_FIXTURES,
  SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS
} from "../src/server/videosBatchWorkflow/shotExecutionPackageFixtures";

for (const storyType of ["STORY", "SCIENCE", "KNOWLEDGE"] as const) {
  const fixture = SHOT_EXECUTION_PACKAGE_FIXTURES[storyType];
  const input = SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS[storyType];
  const valid = validateShotExecutionPackage(fixture, {
    sourceRevision: fixture.sourceRevision,
    sourceHash: fixture.sourceHash,
    assetPlanRevision: fixture.assetPlanRevision,
    assetPlanHash: fixture.assetPlanHash,
    assetPlanStatus: "ready",
    assetPlanArtifactHash: input.assetPlanHash,
    assetPlanStyleSpec: fixture.visual.styleSpec,
    assetPlanNegativePrompt: fixture.visual.negativePrompt,
    assetPlan: input.assetPlanStage
  });
  assert.equal(valid.ok, true, `${storyType} fixture must satisfy the package contract: ${valid.errors.join(" | ")}`);
  assert.equal(Object.isFrozen(fixture), true, `${storyType} fixture must be frozen for replay`);
  assert.match(fixture.contentHash, /^[a-f0-9]{64}$/u);

  const rebuilt = buildShotExecutionPackageFromStoryboard({
    finalStoryboard: input.finalStoryboard,
    segment: 1,
    sourceRevision: 1,
    screenplay: input.screenplay,
    assetPlan: input.assetPlanStage,
    assetPlanRevision: input.assetPlanRevision,
    assetPlanHash: input.assetPlanHash,
    expectedLineage: {
      assetPlanRevision: input.assetPlanRevision,
      assetPlanHash: input.assetPlanHash,
      assetPlanStyleSpec: input.assetPlan.styleSpec as string,
      assetPlanNegativePrompt: input.assetPlan.negativePrompt as string
    },
    referenceBindings: input.referenceBindings
  });
  assert.equal(rebuilt.contentHash, fixture.contentHash, `${storyType} rebuild must be deterministic`);
  const reordered = structuredClone(rebuilt) as any;
  reordered.shot = {
    storyType: reordered.shot.storyType,
    durationSec: reordered.shot.durationSec,
    screenplaySceneSequence: reordered.shot.screenplaySceneSequence,
    chapter: reordered.shot.chapter,
    sequence: reordered.shot.sequence
  };
  assert.equal(hashShotExecutionPackage(reordered), fixture.contentHash, `${storyType} hash must ignore object insertion order`);
  assert.deepEqual(rebuilt.references.map((reference) => reference.ordinal), [1, 2, 3]);
  assert.equal(rebuilt.assetPlanRevision, input.assetPlanRevision, `${storyType} asset-plan revision must be preserved`);
  assert.equal(rebuilt.assetPlanHash, input.assetPlanHash, `${storyType} asset-plan hash must be preserved`);
  assert.equal(rebuilt.visual.styleSpec, input.assetPlan.styleSpec, `${storyType} styleSpec must come from ASSET_PLAN`);
  assert.equal(rebuilt.visual.negativePrompt, input.assetPlan.negativePrompt, `${storyType} negativePrompt must come from ASSET_PLAN`);
  assert.equal(rebuilt.audioIntent.voices.length, 2);
  assert.equal(rebuilt.audioIntent.sounds.length, 3);
  assert.ok(rebuilt.references.every((reference) => !("imageUrl" in (reference as any))), `${storyType} package must not persist image URLs`);
}

const base = SHOT_EXECUTION_PACKAGE_FIXTURES.STORY;
const baseInput = SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY;
const currentLineage = {
  sourceRevision: base.sourceRevision,
  sourceHash: base.sourceHash,
  assetPlanRevision: base.assetPlanRevision,
  assetPlanHash: base.assetPlanHash,
  assetPlanStatus: "ready" as const,
  assetPlanArtifactHash: baseInput.assetPlanHash,
  assetPlanStyleSpec: base.visual.styleSpec,
  assetPlanNegativePrompt: base.visual.negativePrompt,
  assetPlan: baseInput.assetPlanStage
};

const missingCurrentResult = validateShotExecutionPackage(base);
assert.equal(missingCurrentResult.ok, false, "missing current lineage must be rejected");
assert.equal(missingCurrentResult.code, "SHOT_EXECUTION_PACKAGE_LINEAGE_STALE");
const metadataOnlyLineage = { ...currentLineage } as Record<string, unknown>;
delete metadataOnlyLineage.assetPlan;
const metadataOnlyResult = validateShotExecutionPackage(base, metadataOnlyLineage as any);
assert.equal(metadataOnlyResult.ok, false, "metadata-only ASSET_PLAN lineage must be rejected");
assert.equal(metadataOnlyResult.code, "SHOT_EXECUTION_PACKAGE_LINEAGE_STALE");
assert.throws(
  () => createShotExecutionPackage(structuredClone(base), metadataOnlyLineage as any),
  /current FINAL_STORYBOARD and ready ASSET_PLAN lineage is required/
);
const incompleteWrapper = { ...baseInput.assetPlanStage } as Record<string, unknown>;
delete incompleteWrapper.contentHash;
const incompleteWrapperResult = validateShotExecutionPackage(base, {
  ...currentLineage,
  assetPlan: incompleteWrapper
} as any);
assert.equal(incompleteWrapperResult.ok, false, "ASSET_PLAN wrapper must carry its own contentHash");
assert.equal(incompleteWrapperResult.code, "SHOT_EXECUTION_PACKAGE_LINEAGE_STALE");
const invalidCurrentAssetPlan = structuredClone(baseInput.assetPlan) as Record<string, unknown>;
delete invalidCurrentAssetPlan.items;
const invalidCurrentAssetPlanHash = hashShotExecutionPackage(invalidCurrentAssetPlan);
const invalidCurrentPackage = structuredClone(base) as any;
invalidCurrentPackage.assetPlanHash = invalidCurrentAssetPlanHash;
invalidCurrentPackage.contentHash = hashShotExecutionPackage(invalidCurrentPackage);
const invalidCurrentAssetPlanResult = validateShotExecutionPackage(invalidCurrentPackage, {
  ...currentLineage,
  assetPlanHash: invalidCurrentAssetPlanHash,
  assetPlanArtifactHash: invalidCurrentAssetPlanHash,
  assetPlan: {
    status: "ready",
    revision: baseInput.assetPlanRevision,
    contentHash: invalidCurrentAssetPlanHash,
    artifact: invalidCurrentAssetPlan
  }
} as any);
assert.equal(invalidCurrentAssetPlanResult.ok, false, "current ASSET_PLAN business validation must be rerun");
assert.equal(invalidCurrentAssetPlanResult.code, "SHOT_EXECUTION_PACKAGE_INVALID");
assert.ok(
  invalidCurrentAssetPlanResult.errors.some((message) => message.includes("business validation failed")),
  "invalid current ASSET_PLAN must expose business validation evidence"
);
for (const status of ["pending", "running", "failed", "stale"] as const) {
  const nonReady = validateShotExecutionPackage(base, { ...currentLineage, assetPlanStatus: status });
  assert.equal(nonReady.ok, false, `ASSET_PLAN status=${status} must be rejected`);
  assert.equal(nonReady.code, "SHOT_EXECUTION_PACKAGE_LINEAGE_STALE");
}
const missingArtifactWrapper = { ...baseInput.assetPlanStage } as Record<string, unknown>;
delete missingArtifactWrapper.artifact;
const missingArtifactHash = validateShotExecutionPackage(base, {
  ...currentLineage,
  assetPlan: missingArtifactWrapper
} as any);
assert.equal(missingArtifactHash.ok, false, "missing artifact hash must be rejected");
assert.equal(missingArtifactHash.code, "SHOT_EXECUTION_PACKAGE_LINEAGE_STALE");
const conflictingPlanAliases = validateShotExecutionPackage(base, {
  ...currentLineage,
  assetPlanHash: base.assetPlanHash,
  assetPlan: { contentHash: "0".repeat(64) }
} as any);
assert.equal(conflictingPlanAliases.ok, false, "conflicting plan aliases must be rejected");
assert.equal(conflictingPlanAliases.code, "SHOT_EXECUTION_PACKAGE_LINEAGE_STALE");
const mismatchedReferenceBinding = structuredClone(baseInput.referenceBindings);
mismatchedReferenceBinding[0].semanticLabel = "【场景：林小满】";
assert.throws(
  () => buildShotExecutionPackageFromStoryboard({
    finalStoryboard: baseInput.finalStoryboard,
    segment: 1,
    sourceRevision: 1,
    screenplay: baseInput.screenplay,
    assetPlan: baseInput.assetPlanStage,
    referenceBindings: mismatchedReferenceBinding
  }),
  /referenceBindings\[0\].*FINAL_STORYBOARD/u,
  "a binding that only matches one field must not replace the declared semantic reference"
);
const conflictingReferenceAliases = structuredClone(baseInput.referenceBindings);
conflictingReferenceAliases[0].selectedAssetId = "asset_conflicting_alias";
assert.throws(
  () => buildShotExecutionPackageFromStoryboard({
    finalStoryboard: baseInput.finalStoryboard,
    segment: 1,
    sourceRevision: 1,
    screenplay: baseInput.screenplay,
    assetPlan: baseInput.assetPlanStage,
    referenceBindings: conflictingReferenceAliases
  }),
  /referenceBindings\[0\]\.assetId aliases conflict/u,
  "conflicting assetId aliases must not be silently prioritized"
);
assert.throws(
  () => createShotExecutionPackage(base),
  /current FINAL_STORYBOARD and ready ASSET_PLAN lineage is required/
);
const recreated = createShotExecutionPackage(structuredClone(base), currentLineage);
assert.equal(recreated.contentHash, base.contentHash, "constructor must accept a complete current lineage");

const missingField = structuredClone(base) as any;
delete missingField.visual.effects;
const missingResult = validateShotExecutionPackage(missingField);
assert.equal(missingResult.ok, false, "missing required fields must be rejected");
assert.ok(missingResult.errors.some((message) => message.includes("visual.effects")));

const wrongType = structuredClone(base) as any;
wrongType.shot.durationSec = "10";
wrongType.contentHash = hashShotExecutionPackage(wrongType);
const wrongTypeResult = validateShotExecutionPackage(wrongType);
assert.equal(wrongTypeResult.ok, false, "wrong field types must be rejected");
assert.ok(wrongTypeResult.errors.some((message) => message.includes("durationSec")));

const wrongChapter = structuredClone(base) as any;
wrongChapter.shot.chapter = "第一章";
wrongChapter.contentHash = hashShotExecutionPackage(wrongChapter);
const wrongChapterResult = validateShotExecutionPackage(wrongChapter);
assert.equal(wrongChapterResult.ok, false, "chapter must use the canonical 第N章 format");
assert.ok(wrongChapterResult.errors.some((message) => message.includes("chapter")));

const invalidTimeRange = structuredClone(base) as any;
invalidTimeRange.visual.effects[0].timeRange = "99-100秒";
invalidTimeRange.contentHash = hashShotExecutionPackage(invalidTimeRange);
const invalidTimeRangeResult = validateShotExecutionPackage(invalidTimeRange);
assert.equal(invalidTimeRangeResult.ok, false, "subshot timeRange must stay within the ten-second shot");
assert.ok(invalidTimeRangeResult.errors.some((message) => message.includes("timeRange")));

const mismatchedTimeRange = structuredClone(base) as any;
mismatchedTimeRange.visual.effects[0].timeRange = "0-3秒";
mismatchedTimeRange.contentHash = hashShotExecutionPackage(mismatchedTimeRange);
const mismatchedTimeRangeResult = validateShotExecutionPackage(mismatchedTimeRange);
assert.equal(mismatchedTimeRangeResult.ok, false, "subshot timeRange must match duration");
assert.ok(mismatchedTimeRangeResult.errors.some((message) => message.includes("match duration")));

const invalidSourceDuration = structuredClone(SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.finalStoryboard) as any;
invalidSourceDuration.segments[0].duration = 9;
assert.throws(
  () => buildShotExecutionPackageFromStoryboard({
    finalStoryboard: invalidSourceDuration,
    segment: 1,
    sourceRevision: 1,
    assetPlan: SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.assetPlanStage,
    assetPlanRevision: SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.assetPlanRevision,
    assetPlanHash: SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.assetPlanHash,
    referenceBindings: SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.referenceBindings
  }),
  /duration must be 10/
);

assert.throws(
  () => buildShotExecutionPackageFromStoryboard({
    ...SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY,
    sourceRevision: 1,
    assetPlan: SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.assetPlan
  } as any),
  /raw artifacts are not accepted/
);
const invalidAssetPlan = structuredClone(SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.assetPlan) as Record<string, unknown>;
invalidAssetPlan.styleSpec = "foo";
invalidAssetPlan.negativePrompt = "bar";
const invalidAssetPlanHash = hashShotExecutionPackage(invalidAssetPlan);
assert.throws(
  () => buildShotExecutionPackageFromStoryboard({
    ...SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY,
    sourceRevision: 1,
    assetPlan: {
      status: "ready",
      revision: SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.assetPlanRevision,
      contentHash: invalidAssetPlanHash,
      artifact: invalidAssetPlan
    },
    assetPlanHash: invalidAssetPlanHash
  } as any),
  /business validation failed/
);
for (const status of ["pending", "running", "failed", "stale"] as const) {
  assert.throws(
    () => buildShotExecutionPackageFromStoryboard({
      ...SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY,
      sourceRevision: 1,
      assetPlan: {
        ...SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.assetPlanStage,
        status
      }
    } as any),
    /status=ready/
  );
}
const missingArtifactStage = { ...SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.assetPlanStage } as Record<string, unknown>;
delete missingArtifactStage.artifact;
assert.throws(
  () => buildShotExecutionPackageFromStoryboard({
    ...SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY,
    sourceRevision: 1,
    assetPlan: missingArtifactStage
  } as any),
  /raw artifacts are not accepted/
);
assert.throws(
  () => buildShotExecutionPackageFromStoryboard({
    ...SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY,
    sourceRevision: 1,
    assetPlanHash: "0".repeat(64),
    assetPlan: {
      ...SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.assetPlanStage,
      contentHash: "0".repeat(64)
    }
  } as any),
  /canonical ASSET_PLAN artifact/
);
assert.throws(
  () => buildShotExecutionPackageFromStoryboard({
    ...SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY,
    sourceRevision: 1,
    assetPlan: {
      ...SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.assetPlanStage,
      assetPlanHash: "0".repeat(64)
    }
  } as any),
  /aliases conflict/
);

const undeclaredBindingInput = SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY;
assert.throws(
  () => buildShotExecutionPackageFromStoryboard({
    finalStoryboard: undeclaredBindingInput.finalStoryboard,
    segment: 1,
    sourceRevision: 1,
    assetPlan: undeclaredBindingInput.assetPlanStage,
    assetPlanRevision: undeclaredBindingInput.assetPlanRevision,
    assetPlanHash: undeclaredBindingInput.assetPlanHash,
    expectedLineage: {
      assetPlanRevision: undeclaredBindingInput.assetPlanRevision,
      assetPlanHash: undeclaredBindingInput.assetPlanHash,
      assetPlanStyleSpec: undeclaredBindingInput.assetPlan.styleSpec as string,
      assetPlanNegativePrompt: undeclaredBindingInput.assetPlan.negativePrompt as string
    },
    referenceBindings: [
      ...undeclaredBindingInput.referenceBindings,
      { referenceId: "ref-undeclared", assetKey: "STORY-EXTRA", semanticLabel: "【道具：未声明】", assetId: "asset_extra" }
    ]
  }),
  /not declared/
);

const staleRevision = validateShotExecutionPackage(base, {
  sourceRevision: base.sourceRevision + 1,
  sourceHash: base.sourceHash
});
assert.equal(staleRevision.ok, false, "stale source revision must be rejected");
assert.equal(staleRevision.code, "SHOT_EXECUTION_PACKAGE_LINEAGE_STALE");

const staleHash = validateShotExecutionPackage(base, {
  sourceRevision: base.sourceRevision,
  sourceHash: "0".repeat(64)
});
assert.equal(staleHash.ok, false, "stale source hash must be rejected");
assert.equal(staleHash.code, "SHOT_EXECUTION_PACKAGE_LINEAGE_STALE");

const staleSplitHash = validateShotExecutionPackage(base, { sourceRevision: base.sourceRevision }, "0".repeat(64));
assert.equal(staleSplitHash.ok, false, "a separately supplied current hash must be checked");
assert.equal(staleSplitHash.code, "SHOT_EXECUTION_PACKAGE_LINEAGE_STALE");

assert.throws(
  () => buildShotExecutionPackageFromStoryboard({
    ...baseInput,
    sourceRevision: 1,
    revision: 999,
    sourceHash: base.sourceHash,
    hash: "0".repeat(64)
  } as any),
  /aliases conflict/
);

const duplicateVoice = structuredClone(base) as any;
duplicateVoice.audioIntent.voices.push({ ...duplicateVoice.audioIntent.voices[0] });
duplicateVoice.contentHash = hashShotExecutionPackage(duplicateVoice);
const duplicateResult = validateShotExecutionPackage(duplicateVoice);
assert.equal(duplicateResult.ok, false, "duplicate voice events must be rejected");
assert.equal(duplicateResult.code, "SHOT_EXECUTION_PACKAGE_DUPLICATE_VOICE");

assert.throws(
  () => createShotExecutionPackage({ ...structuredClone(base), contentHash: "f".repeat(64) } as any),
  /contentHash/
);

assert.throws(
  () => buildShotExecutionPackageFromStoryboard({
    ...SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY,
    sourceRevision: 1,
    assetPlan: SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.assetPlanStage,
    styleSpec: "旧风格"
  } as any),
  /explicit overrides/
);
assert.throws(
  () => buildShotExecutionPackageFromStoryboard({
    ...SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY,
    sourceRevision: 1,
    assetPlan: SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.assetPlanStage,
    expectedLineage: {
      assetPlanRevision: SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.assetPlanRevision,
      assetPlanHash: SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.assetPlanHash,
      assetPlanStyleSpec: SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.assetPlan.styleSpec as string,
      assetPlanNegativePrompt: SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.assetPlan.negativePrompt as string
    },
    assetPlanHash: "0".repeat(64)
  }),
  /assetPlanHash/
);
assert.throws(
  () => buildShotExecutionPackageFromStoryboard({
    ...SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY,
    sourceRevision: 1,
    assetPlan: SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.assetPlanStage,
    expectedLineage: {
      assetPlanRevision: 2,
      assetPlanHash: SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.assetPlanHash,
      assetPlanStyleSpec: SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.assetPlan.styleSpec as string,
      assetPlanNegativePrompt: SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.assetPlan.negativePrompt as string
    }
  }),
  /assetPlanRevision/
);
assert.throws(
  () => buildShotExecutionPackageFromStoryboard({
    ...SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY,
    sourceRevision: 1,
    assetPlan: SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.assetPlanStage,
    expectedLineage: {
      ...currentLineage,
      sourceRevision: 2
    }
  } as any),
  /sourceRevision is stale/
);
assert.throws(
  () => buildShotExecutionPackageFromStoryboard({
    ...SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY,
    sourceRevision: 1,
    assetPlan: SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.assetPlanStage,
    expectedLineage: {
      ...currentLineage,
      sourceHash: "0".repeat(64)
    }
  } as any),
  /sourceHash is stale/
);
const oldAssetPlan = structuredClone(SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.assetPlan) as Record<string, unknown>;
oldAssetPlan.styleSpec = "影视级 3D 国漫 CG 风格，旧版本的建模与光影约束。";
oldAssetPlan.negativePrompt = "不要文字，不要水印，不要logo，不要主体裁切，不要主体缺失，不要多余人物，不要复杂背景，不要畸形肢体，不要低清模糊，旧版本负面约束。";
const oldAssetPlanHash = hashShotExecutionPackage(oldAssetPlan);
const oldAssetPlanStage = {
  status: "ready",
  revision: SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.assetPlanRevision,
  contentHash: oldAssetPlanHash,
  artifact: oldAssetPlan
};
assert.throws(
  () => buildShotExecutionPackageFromStoryboard({
    ...SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY,
    sourceRevision: 1,
    assetPlan: oldAssetPlanStage,
    assetPlanRevision: SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.assetPlanRevision,
    assetPlanHash: oldAssetPlanHash,
    expectedLineage: {
      sourceRevision: SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.package.sourceRevision,
      sourceHash: SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.package.sourceHash,
      assetPlanRevision: SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.assetPlanRevision,
      assetPlanHash: SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.assetPlanHash,
      assetPlanStyleSpec: SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.assetPlan.styleSpec as string,
      assetPlanNegativePrompt: SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.assetPlan.negativePrompt as string
    }
  }),
  /assetPlanHash is stale/
);

console.log("VideosBatch ShotExecutionPackage contract smoke passed");
