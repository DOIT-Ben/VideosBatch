import { strict as assert } from "node:assert";
import {
  compileShotProviderPrompt,
  renderShotProviderPromptSections,
  SHOT_PROVIDER_PROMPT_SECTION_ORDER,
  type CompiledShotPrompt,
  type PromptCompilerError,
  type ShotProviderPromptCompileResult
} from "../src/server/videosBatchWorkflow/promptCompiler";
import {
  hashShotExecutionPackage
} from "../src/server/videosBatchWorkflow/shotExecutionPackage";
import {
  SHOT_EXECUTION_PACKAGE_FIXTURES
} from "../src/server/videosBatchWorkflow/shotExecutionPackageFixtures";

function expectSuccess(result: ShotProviderPromptCompileResult, label: string): CompiledShotPrompt {
  assert.equal(result.ok, true, `${label} must compile: ${result.ok ? "" : result.message}`);
  if (!result.ok) throw new Error(`${label} unexpectedly returned ${result.code}`);
  return result;
}

function expectError(
  result: ShotProviderPromptCompileResult,
  code: PromptCompilerError["code"],
  label: string
): PromptCompilerError {
  assert.equal(result.ok, false, `${label} must be rejected as ${code}`);
  if (result.ok) throw new Error(`${label} unexpectedly compiled`);
  assert.equal(result.code, code, `${label} error code`);
  assert.equal(typeof result.message, "string", `${label} error message`);
  assert.equal(typeof result.retryable, "boolean", `${label} retryable flag`);
  assert.ok(Object.prototype.hasOwnProperty.call(result, "sourceRevision"), `${label} sourceRevision`);
  assert.ok(Object.prototype.hasOwnProperty.call(result, "sourceHash"), `${label} sourceHash`);
  assert.equal("text" in result, false, `${label} must not expose a sendable prompt`);
  assert.equal("sections" in result, false, `${label} must not expose partial sections`);
  return result;
}

function rehashed<T extends Record<string, unknown>>(
  source: T,
  mutate: (candidate: T) => void
): T {
  const candidate = structuredClone(source) as T & { contentHash?: string };
  mutate(candidate);
  candidate.contentHash = hashShotExecutionPackage(candidate);
  return candidate;
}

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = value.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function assertPromptContains(prompt: string, value: string, label: string): void {
  assert.ok(prompt.includes(value), `${label} must be present in the compiled prompt`);
}

const expectedTitles = [
  "[教学目标与知识点]",
  "[章节与场景]",
  "[类型主体]",
  "[辅助字段]",
  "[画面效果]",
  "[连续性]",
  "[声音表演约束]",
  "[Reference image bindings (strict)]"
];

const expectedTypeLabels = {
  STORY: { roleLabel: "人物", supportLabel: "道具" },
  SCIENCE: { roleLabel: "主体", supportLabel: "辅助元素" },
  KNOWLEDGE: { roleLabel: "核心意象", supportLabel: "辅助元素" }
} as const;

const compiledByType = new Map<keyof typeof expectedTypeLabels, CompiledShotPrompt>();

for (const storyType of ["STORY", "SCIENCE", "KNOWLEDGE"] as const) {
  const fixture = SHOT_EXECUTION_PACKAGE_FIXTURES[storyType];
  const result = expectSuccess(compileShotProviderPrompt(fixture), `${storyType} fixture`);
  compiledByType.set(storyType, result);

  assert.deepEqual(result.sections.map((section) => section.id), [...SHOT_PROVIDER_PROMPT_SECTION_ORDER]);
  assert.deepEqual(result.sections.map((section) => section.title), expectedTitles);
  assert.equal(result.text, result.sections.map((section) => section.text).join("\n\n"));
  assert.equal(result.sourceStageId, "FINAL_STORYBOARD");
  assert.equal(result.sourceRevision, fixture.sourceRevision);
  assert.equal(result.sourceHash, fixture.sourceHash);
  assert.equal(result.contentHash, fixture.contentHash);
  assert.doesNotMatch(result.text, /\r/u, `${storyType} prompt must use LF only`);
  assert.doesNotMatch(result.text, /"shot"\s*:/u, `${storyType} prompt must not be a JSON dump`);

  const labels = expectedTypeLabels[storyType];
  for (const fieldValue of [
    `teaching.goal：${fixture.teaching.goal}`,
    `teaching.knowledgeFocus：${fixture.teaching.knowledgeFocus}`,
    `teaching.evidence[1].source：${fixture.teaching.evidence[0].source}`,
    `teaching.evidence[1].quote：${fixture.teaching.evidence[0].quote}`,
    `shot.chapter：${fixture.shot.chapter}`,
    `visual.scene：${fixture.visual.scene}`,
    `shot.sequence：${fixture.shot.sequence}`,
    `shot.screenplaySceneSequence：${fixture.shot.screenplaySceneSequence}`,
    `shot.storyType：${storyType}`,
    `visual.roleLabel：${labels.roleLabel}`,
    `visual.role：${fixture.visual.role}`,
    `visual.supportLabel：${labels.supportLabel}`,
    `visual.support：${fixture.visual.support}`,
    `visual.globalContinuity：${fixture.visual.globalContinuity}`
  ]) {
    assertPromptContains(result.text, fieldValue, `${storyType} ${fieldValue}`);
  }

  fixture.visual.effects.forEach((effect, index) => {
    const prefix = `visual.effects[${index + 1}]`;
    for (const [field, value] of [
      ["sequence（子镜头序号）", effect.sequence],
      ["timeRange", effect.timeRange],
      ["duration", effect.duration],
      ["visual", effect.visual],
      ["action", effect.action],
      ["camera", effect.camera]
    ] as const) {
      assertPromptContains(result.text, `${prefix}.${field}：${value}`, `${storyType} ${prefix}.${field}`);
    }
  });

  for (const [path, events] of [
    ["audioIntent.voices", fixture.audioIntent.voices],
    ["audioIntent.sounds", fixture.audioIntent.sounds]
  ] as const) {
    events.forEach((event, index) => {
      assertPromptContains(result.text, `${path}[${index + 1}].id：${event.id}`, `${storyType} ${path} id`);
      assertPromptContains(result.text, `${path}[${index + 1}].startSec：${event.startSec}`, `${storyType} ${path} start`);
      assertPromptContains(result.text, `${path}[${index + 1}].endSec：${event.endSec}`, `${storyType} ${path} end`);
      assertPromptContains(result.text, `${path}[${index + 1}].text（原文）：${event.text}`, `${storyType} ${path} text`);
      assert.equal(countOccurrences(result.text, event.text), 1, `${storyType} ${path} original text must render once`);
    });
  }
  assertPromptContains(result.text, "旁白/对白由独立 TTS 与混音链路提供，Provider 不负责生成受控旁白。", `${storyType} TTS boundary`);

  const imageBindings = [...result.text.matchAll(/^Image (\d+) = (.+)$/gmu)];
  assert.deepEqual(imageBindings.map((match) => [Number(match[1]), match[2]]), [
    [1, fixture.references[0].semanticLabel.replace(/^【[^：:]+[：:]\s*/u, "").replace(/】\s*$/u, "")],
    [2, fixture.references[1].semanticLabel.replace(/^【[^：:]+[：:]\s*/u, "").replace(/】\s*$/u, "")],
    [3, fixture.references[2].semanticLabel.replace(/^【[^：:]+[：:]\s*/u, "").replace(/】\s*$/u, "")]
  ], `${storyType} Image N binding order`);
  assert.match(result.text, /严格保持参考图 Image N 对应关系。/u);
  assert.match(result.text, /保持人物\/主体、场景、道具\/辅助元素的身份连续。/u);
  assert.match(result.text, /保持画面、动作、运镜和教学语义。/u);
  assert.match(result.text, /不生成字幕、标题卡、答案或额外剧情。/u);
  assert.match(result.text, /不让 Provider 生成受控旁白。/u);
  assert.match(result.text, /不交换、删除或新增参考图。/u);

  assert.doesNotMatch(result.text, /P\d{3,}-A\d{3,}/u, `${storyType} prompt must not expose stable public ids`);
  assert.doesNotMatch(result.text, /asset_fixture_[a-z]+_(?:role|scene|support)/u, `${storyType} prompt must not expose native asset ids`);
  assert.doesNotMatch(result.text, /https?:\/\//iu, `${storyType} prompt must not expose URLs`);
  assert.doesNotMatch(result.text, /\/media\//iu, `${storyType} prompt must not expose media paths`);
}

const base = SHOT_EXECUTION_PACKAGE_FIXTURES.STORY;
const full = compiledByType.get("STORY")!;
const compactText = renderShotProviderPromptSections(base, true).map((section) => section.text).join("\n");
const compact = expectSuccess(
  compileShotProviderPrompt(base, { maxChars: compactText.length }),
  "compact STORY prompt"
);
assert.ok(compact.text.length < full.text.length, "compact rendering must remove only deterministic formatting overhead");
assert.equal(compact.text, compact.sections.map((section) => section.text).join("\n"));
assertPromptContains(compact.text, `visual.effects[1].camera=${base.visual.effects[0].camera}`, "compact camera field");
assertPromptContains(compact.text, `audioIntent.voices[1].text（原文）=${base.audioIntent.voices[0].text}`, "compact voice field");

expectError(
  compileShotProviderPrompt(base, { maxChars: 1 }),
  "PROMPT_CONTEXT_TOO_LARGE",
  "overlong STORY prompt"
);

expectError(
  compileShotProviderPrompt(base, { current: { sourceRevision: base.sourceRevision + 1, sourceHash: base.sourceHash } }),
  "PROMPT_PACKAGE_LINEAGE_STALE",
  "stale source revision"
);
expectError(
  compileShotProviderPrompt(base, { current: { sourceRevision: base.sourceRevision, sourceHash: "0".repeat(64) } }),
  "PROMPT_PACKAGE_LINEAGE_STALE",
  "stale source hash"
);

const missingField = structuredClone(base) as any;
delete missingField.visual.globalContinuity;
expectError(compileShotProviderPrompt(missingField), "PROMPT_FIELD_MISSING", "missing continuity field");

const wrongStoryType = rehashed(base, (candidate) => {
  (candidate.shot as Record<string, unknown>).storyType = "SCIENCE";
});
expectError(compileShotProviderPrompt(wrongStoryType as any), "PROMPT_PACKAGE_INVALID", "wrong storyType");

const wrongRoleLabel = rehashed(base, (candidate) => {
  (candidate.visual as Record<string, unknown>).roleLabel = "主体";
});
expectError(compileShotProviderPrompt(wrongRoleLabel as any), "PROMPT_PACKAGE_INVALID", "wrong roleLabel");

const wrongSupportLabel = rehashed(base, (candidate) => {
  (candidate.visual as Record<string, unknown>).supportLabel = "辅助元素";
});
expectError(compileShotProviderPrompt(wrongSupportLabel as any), "PROMPT_PACKAGE_INVALID", "wrong supportLabel");

const wrongOrdinal = rehashed(base, (candidate) => {
  const references = candidate.references as Array<Record<string, unknown>>;
  references[0].ordinal = 2;
});
expectError(compileShotProviderPrompt(wrongOrdinal as any), "PROMPT_REFERENCE_INVALID", "non-contiguous reference ordinal");

const positionReference = rehashed(base, (candidate) => {
  const references = candidate.references as Array<Record<string, unknown>>;
  references[0].semanticLabel = "第1张图";
});
expectError(compileShotProviderPrompt(positionReference as any), "PROMPT_REFERENCE_INVALID", "position-based reference label");

for (const [label, value] of [
  ["stable public asset id", "角色 P001-A001"],
  ["native asset id", "角色 asset_fixture_story_role"],
  ["https URL", "场景 https://example.invalid/scene.png"],
  ["media path", "场景 /media/scene.png"],
  ["absolute path", "场景 C:\\media\\scene.png"]
] as const) {
  const forbidden = rehashed(base, (candidate) => {
    (candidate.visual as Record<string, unknown>).role = value;
  });
  expectError(compileShotProviderPrompt(forbidden as any), "PROMPT_FORBIDDEN_IDENTIFIER", label);
}

const forbiddenReferenceAssetId = rehashed(base, (candidate) => {
  const references = candidate.references as Array<Record<string, unknown>>;
  references[0].assetId = "P001-A001";
});
expectError(compileShotProviderPrompt(forbiddenReferenceAssetId as any), "PROMPT_FORBIDDEN_IDENTIFIER", "reference stable public asset id");

const duplicateVoice = rehashed(base, (candidate) => {
  const voices = candidate.audioIntent.voices as Array<Record<string, unknown>>;
  voices.push({ ...voices[0] });
});
const duplicateVoiceError = expectError(compileShotProviderPrompt(duplicateVoice as any), "PROMPT_PACKAGE_INVALID", "duplicate voice event");
assert.match(duplicateVoiceError.message, /duplicate/u);

const badContentHash = structuredClone(base) as any;
badContentHash.contentHash = "f".repeat(64);
expectError(compileShotProviderPrompt(badContentHash), "PROMPT_PACKAGE_INVALID", "contentHash mismatch");

const wrongSourceStage = rehashed(base, (candidate) => {
  candidate.sourceStageId = "SCREENPLAY" as never;
});
expectError(compileShotProviderPrompt(wrongSourceStage as any), "PROMPT_PACKAGE_INVALID", "wrong source stage");

const stableFirst = expectSuccess(compileShotProviderPrompt(base), "first deterministic STORY compile");
const stableSecond = expectSuccess(compileShotProviderPrompt(base), "second deterministic STORY compile");
assert.equal(stableFirst.text, stableSecond.text, "same input must produce identical text");
assert.deepEqual(stableFirst.sections, stableSecond.sections, "same input must produce identical sections");
assert.equal(stableFirst.contentHash, stableSecond.contentHash, "same input must produce identical contentHash");

console.log("VideosBatch deterministic provider prompt compiler contract smoke passed");
