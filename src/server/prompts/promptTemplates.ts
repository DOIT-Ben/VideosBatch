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

export type PromptTemplateName = (typeof PROMPT_TEMPLATE_NAMES)[number];

const cache = new Map<PromptTemplateName, string>();

function templatePath(name: PromptTemplateName): string {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(name)) throw new Error(`Invalid prompt template name: ${name}`);
  return fileURLToPath(new URL(`./${name}.md`, import.meta.url));
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
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\n+$/u, "");
  if (!normalized.trim()) throw new Error(`Prompt template is empty: src/server/prompts/${name}.md`);
  cache.set(name, normalized);
  return normalized;
}

/**
 * Load every registered template once. Use at startup or in smoke tests to
 * fail fast on a broken prompts directory.
 */
export function warmPromptTemplates(): void {
  for (const name of PROMPT_TEMPLATE_NAMES) loadPromptTemplate(name);
}
