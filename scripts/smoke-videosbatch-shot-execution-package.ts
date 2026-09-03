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
    sourceHash: fixture.sourceHash
  });
  assert.equal(valid.ok, true, `${storyType} fixture must satisfy the package contract: ${valid.errors.join(" | ")}`);
  assert.equal(Object.isFrozen(fixture), true, `${storyType} fixture must be frozen for replay`);
  assert.match(fixture.contentHash, /^[a-f0-9]{64}$/u);

  const rebuilt = buildShotExecutionPackageFromStoryboard({
    finalStoryboard: input.finalStoryboard,
    segment: 1,
    sourceRevision: 1,
    screenplay: input.screenplay,
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
  assert.equal(rebuilt.audioIntent.voices.length, 2);
  assert.equal(rebuilt.audioIntent.sounds.length, 3);
  assert.ok(rebuilt.references.every((reference) => !("imageUrl" in (reference as any))), `${storyType} package must not persist image URLs`);
}

const base = SHOT_EXECUTION_PACKAGE_FIXTURES.STORY;

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

const invalidSourceDuration = structuredClone(SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.finalStoryboard) as any;
invalidSourceDuration.segments[0].duration = 9;
assert.throws(
  () => buildShotExecutionPackageFromStoryboard({
    finalStoryboard: invalidSourceDuration,
    segment: 1,
    sourceRevision: 1,
    referenceBindings: SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY.referenceBindings
  }),
  /duration must be 10/
);

const undeclaredBindingInput = SHOT_EXECUTION_PACKAGE_FIXTURE_INPUTS.STORY;
assert.throws(
  () => buildShotExecutionPackageFromStoryboard({
    finalStoryboard: undeclaredBindingInput.finalStoryboard,
    segment: 1,
    sourceRevision: 1,
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

console.log("VideosBatch ShotExecutionPackage contract smoke passed");
