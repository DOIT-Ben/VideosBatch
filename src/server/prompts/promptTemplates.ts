import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Prompt skeleton templates live as .md files next to this loader.
 *
 * Conventions:
 * - Files are UTF-8 with LF line endings and exactly one trailing newline.
 * - The loader strips trailing newlines, so the returned string stays
 *   byte-identical to the historical in-code skeleton constants.
 * - Templates are loaded once per process and cached. Every consumer binds the
 *   template at module top level, so a missing or empty file fails fast at
 *   startup instead of mid-workflow.
 *
 * Out of scope on purpose: promptCompiler.ts (a deterministic compiler, not a
 * static skeleton), promptCompose.ts (dynamic per-asset assembly) and the
 * `<contract_repair>` template in llmTextStages.ts (runtime-constructed fields).
 *
 * Versioning follows FrameFlow's `video-creation-prompts/registry.ts`: a skeleton
 * is an immutable asset pinned by content hash, and a version is a real load
 * dimension rather than a label. `loadPromptTemplate(name, version)` reads back the
 * exact bytes a historical run was compiled from, so replaying an old session never
 * silently substitutes today's instructions. Editing a template without publishing a
 * new version and pinning its hash fails fast.
 */
export const PROMPT_TEMPLATE_NAMES = [
  "videosbatch-intro-candidates",
  "videosbatch-story-script",
  "videosbatch-asset-plan",
  "videosbatch-screenplay",
  "videosbatch-final-storyboard",
  "videosbatch-copyable-prompt",
  "short-film-outline",
  "short-film-casting"
] as const;

type PromptTemplateName = (typeof PROMPT_TEMPLATE_NAMES)[number];

/**
 * Every published skeleton revision, oldest first. Adding a version here means the
 * new revision has its own file on disk and its own pinned hashes; the previous
 * revision's bytes stay where they are.
 */
export const PROMPT_TEMPLATE_VERSION_ORDER = ["v1.0.0"] as const;

export type PromptTemplateVersion = (typeof PROMPT_TEMPLATE_VERSION_ORDER)[number];

/** Current reviewed version of each skeleton. Bump it together with the hash pin. */
export const PROMPT_TEMPLATE_VERSIONS = {
  "videosbatch-intro-candidates": "v1.0.0",
  "videosbatch-story-script": "v1.0.0",
  "videosbatch-asset-plan": "v1.0.0",
  "videosbatch-screenplay": "v1.0.0",
  "videosbatch-final-storyboard": "v1.0.0",
  "videosbatch-copyable-prompt": "v1.0.0",
  "short-film-outline": "v1.0.0",
  "short-film-casting": "v1.0.0"
} as const satisfies Record<PromptTemplateName, PromptTemplateVersion>;

/**
 * SHA-256 of the normalized template body (LF line endings, no trailing newline).
 * Pinning the normalized body keeps the fingerprint stable across line-ending churn
 * and makes it a statement about exactly what the model receives.
 */
export const PROMPT_TEMPLATE_HASHES = {
  "videosbatch-intro-candidates": "57b71ae914c5855a822b4ac73e657c8cfe69ce5380dec94a3e5dba23e3ab6809",
  "videosbatch-story-script": "a725e5aa2c528ec83af65c31ae982188f2be61e728cdc2611d1f30c67b174636",
  "videosbatch-asset-plan": "4309856a6040a4afbe6e37a1f7497d8c9b9789118e305d6dedbf77e674ddb7e9",
  "videosbatch-screenplay": "c3fb704063c5ff8eb0039ae103b27be0e9d40f0234c7f9be7255513763e151bb",
  "videosbatch-final-storyboard": "d150e093a9991d640cd1d3be164f0d281d0200e06a7871e9cd3a98bb3eafbdfa",
  "videosbatch-copyable-prompt": "2550b73f50e91a1d43dde970fbe0248fae93f981b53cbbd3c2914b0648464ab2",
  "short-film-outline": "c011a04a235ba8750b28f37fd217bcc5d45db37a1a35db0f966b0ffe359ea13f",
  "short-film-casting": "05aa7c948a3f727fb9fb86bc7032cf8f71fafabb6f452e3d226452cf4b5f84c2"
} as const satisfies Record<PromptTemplateName, string>;

/**
 * Hashes stay adjacent to every version, exactly like FrameFlow's
 * `..._HASHES_BY_VERSION`: publishing a revision means adding a full table for it
 * (spread the previous table and override what changed) so a version can never be
 * loaded without a pin.
 */
export const PROMPT_TEMPLATE_HASHES_BY_VERSION = {
  "v1.0.0": PROMPT_TEMPLATE_HASHES
} as const satisfies Readonly<Record<PromptTemplateVersion, Readonly<Record<PromptTemplateName, string>>>>;

const cache = new Map<string, string>();

function isKnownPromptTemplateVersion(value: string): value is PromptTemplateVersion {
  return (PROMPT_TEMPLATE_VERSION_ORDER as readonly string[]).includes(value);
}

function isRegisteredPromptTemplateName(value: string): value is PromptTemplateName {
  return (PROMPT_TEMPLATE_NAMES as readonly string[]).includes(value);
}

/**
 * Relative path of one template revision. The current revision keeps the historical
 * flat path; every earlier revision lives under `history/<name>/` and must still be
 * present on disk. Exported so the contract can be asserted without writing fixtures.
 */
export function promptTemplateRelativePath(name: PromptTemplateName, version: PromptTemplateVersion): string {
  return version === PROMPT_TEMPLATE_VERSIONS[name]
    ? `${name}.md`
    : `history/${name}/${version}.md`;
}

function templatePath(name: PromptTemplateName, version: PromptTemplateVersion): string {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(name)) throw new Error(`Invalid prompt template name: ${name}`);
  return fileURLToPath(new URL(`./${promptTemplateRelativePath(name, version)}`, import.meta.url));
}

export function normalizePromptTemplateBody(raw: string): string {
  return raw.replace(/\r\n/g, "\n").replace(/\n+$/u, "");
}

export function hashPromptTemplateContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Normalize a template body and verify it against the pinned hash for `version`.
 * Exported so the smoke can exercise drift rejection without editing files on disk.
 */
export function assertPromptTemplateIntegrity(
  name: PromptTemplateName,
  raw: string,
  version: PromptTemplateVersion = PROMPT_TEMPLATE_VERSIONS[name]
): string {
  const normalized = normalizePromptTemplateBody(raw);
  if (!normalized.trim()) {
    throw new Error(`Prompt template is empty: src/server/prompts/${promptTemplateRelativePath(name, version)}`);
  }
  const pinned = PROMPT_TEMPLATE_HASHES_BY_VERSION[version]?.[name];
  if (!pinned) throw new Error(`Prompt template ${name} has no pinned hash for version ${version}`);
  const actual = hashPromptTemplateContent(normalized);
  if (pinned !== actual) {
    throw new Error(
      `Prompt template hash drift: src/server/prompts/${promptTemplateRelativePath(name, version)}\n`
      + `  pinned ${version}: ${pinned}\n`
      + `  actual: ${actual}\n`
      + "Editing a prompt skeleton requires publishing a new PROMPT_TEMPLATE_VERSION_ORDER entry, "
      + "keeping the previous revision on disk, and pinning the new hash in promptTemplates.ts."
    );
  }
  return normalized;
}

/**
 * Load one skeleton revision. Defaults to the template's current version; pass an
 * explicit version to read back what a historical run used. An unpublished version
 * fails fast instead of falling back to the current text, because silently loading
 * different instructions is the exact failure versioning exists to prevent.
 */
export function loadPromptTemplate(
  name: PromptTemplateName,
  version?: PromptTemplateVersion
): string {
  if (!isRegisteredPromptTemplateName(name)) {
    throw new Error(`Prompt template is missing or unreadable: src/server/prompts/${String(name)}.md`);
  }
  const target = version ?? PROMPT_TEMPLATE_VERSIONS[name];
  if (!isKnownPromptTemplateVersion(target)) {
    throw new Error(
      `Unknown prompt template version: ${target}. Known versions: ${PROMPT_TEMPLATE_VERSION_ORDER.join(", ")}.`
    );
  }
  const cacheKey = `${target}:${name}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;
  let raw: string;
  try {
    raw = readFileSync(templatePath(name, target), "utf8");
  } catch {
    throw new Error(`Prompt template is missing or unreadable: src/server/prompts/${promptTemplateRelativePath(name, target)}`);
  }
  const normalized = assertPromptTemplateIntegrity(name, raw, target);
  cache.set(cacheKey, normalized);
  return normalized;
}

/**
 * Load and verify every registered template at its current version once. Use at startup
 * or in smoke tests to fail fast on a broken prompts directory.
 */
export function warmPromptTemplates(): void {
  for (const name of PROMPT_TEMPLATE_NAMES) loadPromptTemplate(name);
}
