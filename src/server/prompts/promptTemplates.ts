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
 * is an immutable asset pinned by content hash. Editing a template without bumping
 * its version and pinning the new hash fails fast, so what the model receives can
 * never change silently.
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
} as const satisfies Record<PromptTemplateName, string>;

export type PromptTemplateVersion = (typeof PROMPT_TEMPLATE_VERSIONS)[PromptTemplateName];

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

const cache = new Map<PromptTemplateName, string>();

function templatePath(name: PromptTemplateName): string {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(name)) throw new Error(`Invalid prompt template name: ${name}`);
  return fileURLToPath(new URL(`./${name}.md`, import.meta.url));
}

export function normalizePromptTemplateBody(raw: string): string {
  return raw.replace(/\r\n/g, "\n").replace(/\n+$/u, "");
}

export function hashPromptTemplateContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Normalize a template body and verify it against the pinned hash. Exported so the
 * smoke can exercise the drift rejection without editing files on disk.
 */
export function assertPromptTemplateIntegrity(name: PromptTemplateName, raw: string): string {
  const normalized = normalizePromptTemplateBody(raw);
  if (!normalized.trim()) throw new Error(`Prompt template is empty: src/server/prompts/${name}.md`);
  const pinned = PROMPT_TEMPLATE_HASHES[name];
  const actual = hashPromptTemplateContent(normalized);
  if (pinned !== actual) {
    throw new Error(
      `Prompt template hash drift: src/server/prompts/${name}.md\n`
      + `  pinned ${PROMPT_TEMPLATE_VERSIONS[name]}: ${pinned}\n`
      + `  actual: ${actual}\n`
      + "Editing a prompt skeleton requires bumping PROMPT_TEMPLATE_VERSIONS and pinning the new hash in promptTemplates.ts."
    );
  }
  return normalized;
}

export function loadPromptTemplate(name: PromptTemplateName): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  let raw: string;
  try {
    raw = readFileSync(templatePath(name), "utf8");
  } catch {
    throw new Error(`Prompt template is missing or unreadable: src/server/prompts/${name}.md`);
  }
  const normalized = assertPromptTemplateIntegrity(name, raw);
  cache.set(name, normalized);
  return normalized;
}

/**
 * Load and verify every registered template once. Use at startup or in smoke tests to
 * fail fast on a broken prompts directory.
 */
export function warmPromptTemplates(): void {
  for (const name of PROMPT_TEMPLATE_NAMES) loadPromptTemplate(name);
}
