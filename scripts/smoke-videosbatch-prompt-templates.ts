import { strict as assert } from "node:assert";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  assertPromptTemplateIntegrity,
  hashPromptTemplateContent,
  normalizePromptTemplateBody,
  PROMPT_TEMPLATE_HASHES,
  PROMPT_TEMPLATE_NAMES,
  PROMPT_TEMPLATE_VERSIONS,
  loadPromptTemplate,
  warmPromptTemplates
} from "../src/server/prompts/promptTemplates";
import { getVideosBatchTextStageSpec } from "../src/server/videosBatchWorkflow/textStageSpecs";

/**
 * Prompt template smoke: the skeleton files under src/server/prompts/ are the
 * single source of truth for static system prompts. This smoke pins the
 * directory contract (registry ↔ files), per-template anchors, loader caching,
 * fail-fast behavior, and the wiring of every consumer.
 */

const names = [...PROMPT_TEMPLATE_NAMES];
const promptsDir = fileURLToPath(new URL("../src/server/prompts/", import.meta.url));

// 1. Registry ↔ directory must match exactly: a missing file fails startup,
//    an unregistered .md file means someone added a template without wiring it.
assert.equal(names.length, 8, "PROMPT_TEMPLATE_NAMES must list every template");
const diskFiles = readdirSync(promptsDir).filter((name) => name.endsWith(".md")).sort();
assert.deepEqual(
  diskFiles,
  names.map((name) => `${name}.md`).sort(),
  "prompts directory and registry must contain exactly the same templates"
);

// 2. Warm load: any missing or empty template throws here.
warmPromptTemplates();

// 3. Per-template anchors. These are load-bearing phrases enforced by business
//    gates or security policy; losing one in an edit must fail verification.
const anchors: Record<string, string[]> = {
  "videosbatch-intro-candidates": ["安全边界", "严格只返回结构化 JSON"],
  "videosbatch-story-script": ["600—800字", "严格只返回结构化 JSON"],
  "videosbatch-asset-plan": ["影视级 3D 国漫 CG 风格", "VIDEO_ASSET_PLAN"],
  "videosbatch-screenplay": ["VIDEO_SCREENPLAY", "targetDurationSeconds"],
  "videosbatch-final-storyboard": ["FINAL_10_SECOND", "targetDuration/10"],
  "videosbatch-copyable-prompt": ["垫图可复制提示词副本", "referenceAssetIds"],
  "short-film-outline": ["短片大纲", "严格 JSON"],
  "short-film-casting": ["选角导演", "JSON"]
};
for (const name of names) {
  const content = loadPromptTemplate(name);
  assert.ok(content.trim().length >= 40, `${name} must not be empty or trivially short`);
  for (const anchor of anchors[name] || []) {
    assert.ok(content.includes(anchor), `${name} lost its anchor text: ${anchor}`);
  }
  // 4. LF-only file with the loader stripping trailing newlines.
  const raw = readFileSync(`${promptsDir}${name}.md`, "utf8");
  assert.ok(!raw.includes("\r"), `${name}.md must use LF line endings`);
  assert.equal(loadPromptTemplate(name), content, `${name} loader cache must be stable`);
}

// 5. Loader cache returns the identical string instance.
assert.ok(
  names.every((name) => loadPromptTemplate(name) === loadPromptTemplate(name)),
  "loadPromptTemplate must return the cached template"
);

// 6. Unknown or malformed names fail fast.
assert.throws(() => loadPromptTemplate("does-not-exist" as Parameters<typeof loadPromptTemplate>[0]), /missing or unreadable/u);
assert.throws(() => loadPromptTemplate("../escape" as Parameters<typeof loadPromptTemplate>[0]));

// 7. Consumer wiring: every text-stage spec resolves its system prompt from a
//    template, and the generators entry uses the outline template.
const wiring: Array<[Parameters<typeof getVideosBatchTextStageSpec>[0], string]> = [
  ["COURSE_INTRO_CANDIDATES", "videosbatch-intro-candidates"],
  ["STORY_SCRIPT", "videosbatch-story-script"],
  ["ASSET_PLAN", "videosbatch-asset-plan"],
  ["SCREENPLAY", "videosbatch-screenplay"],
  ["FINAL_STORYBOARD", "videosbatch-final-storyboard"],
  ["COPYABLE_PROMPT", "videosbatch-copyable-prompt"]
];
for (const [stageId, templateName] of wiring) {
  const spec = getVideosBatchTextStageSpec(stageId);
  assert.equal(spec.systemPrompt, loadPromptTemplate(templateName), `${stageId} must use ${templateName}.md as its system prompt`);
}
// 7b. generators.ts and index.ts keep module-private bindings; pin those
//     textually (index.ts boots the server, so it can never be imported here).
const generatorsSource = readFileSync(fileURLToPath(new URL("../src/server/generators.ts", import.meta.url)), "utf8");
assert.ok(generatorsSource.includes('loadPromptTemplate("short-film-outline")'), "generators.ts must wire the outline prompt from the template registry");
const indexSource = readFileSync(fileURLToPath(new URL("../src/server/index.ts", import.meta.url)), "utf8");
assert.ok(indexSource.includes('loadPromptTemplate("short-film-casting")'), "index.ts must wire the casting prompt from the template registry");

// 8. Version + content-hash pins (ADR-0001 P2). A skeleton is an immutable asset:
//    editing one without bumping its version and pinning the new hash must fail
//    fast, because a silent prompt change silently changes every model output.
assert.deepEqual(
  Object.keys(PROMPT_TEMPLATE_VERSIONS).sort(),
  names.slice().sort(),
  "every registered template must declare a version"
);
assert.deepEqual(
  Object.keys(PROMPT_TEMPLATE_HASHES).sort(),
  names.slice().sort(),
  "every registered template must pin a content hash"
);
for (const name of names) {
  const content = loadPromptTemplate(name);
  assert.match(PROMPT_TEMPLATE_VERSIONS[name], /^v\d+\.\d+\.\d+$/u, `${name} version must look like vX.Y.Z`);
  assert.equal(
    PROMPT_TEMPLATE_HASHES[name],
    hashPromptTemplateContent(content),
    `${name} pinned hash must equal the loaded template body`
  );
  assert.equal(
    PROMPT_TEMPLATE_HASHES[name],
    hashPromptTemplateContent(normalizePromptTemplateBody(readFileSync(`${promptsDir}${name}.md`, "utf8"))),
    `${name} pinned hash must be derived from the normalized on-disk body`
  );
}
// Positive control: the pin must actually discriminate a body edit, and the gate
// must reject it. Without this, "the pin matches" could hold for a dead check.
const pinnedTemplate = "videosbatch-asset-plan";
assert.notEqual(
  hashPromptTemplateContent(`${loadPromptTemplate(pinnedTemplate)} `),
  PROMPT_TEMPLATE_HASHES[pinnedTemplate],
  "the content hash must change when the template body changes"
);
assert.throws(
  () => assertPromptTemplateIntegrity(pinnedTemplate, `${loadPromptTemplate(pinnedTemplate)} 新增一行`),
  /hash drift/u,
  "an unpinned template edit must be rejected instead of silently changing model input"
);
assert.equal(
  assertPromptTemplateIntegrity(pinnedTemplate, readFileSync(`${promptsDir}${pinnedTemplate}.md`, "utf8")),
  loadPromptTemplate(pinnedTemplate),
  "an unedited template must pass the integrity gate"
);

console.log(`ok: ${names.length} prompt templates, registry↔directory aligned, anchors intact, version+hash pinned, consumers wired`);
