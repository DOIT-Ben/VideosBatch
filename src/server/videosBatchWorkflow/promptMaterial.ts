/**
 * Render structured workflow material without cutting through a field value.
 * A prompt may omit complete trailing fields/items when it reaches the budget,
 * but it must never send a partial value to a provider.
 */
export const DEFAULT_PROMPT_MATERIAL_BUDGET = 48_000;

export class PromptMaterialTooLargeError extends Error {
  readonly code = "PROMPT_CONTEXT_TOO_LARGE";
  readonly retryable = false;

  constructor(message = "VideosBatch prompt material exceeds the configured context budget") {
    super(message);
    this.name = "PromptMaterialTooLargeError";
  }
}

type RenderOptions = {
  indent?: string;
  budget?: number;
};

function normalizedBudget(value: unknown) {
  const budget = Number(value);
  return Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : DEFAULT_PROMPT_MATERIAL_BUDGET;
}

function scalar(value: unknown) {
  if (value === null || value === undefined || value === "") return "无";
  return String(value);
}

/**
 * The optional third argument is kept for compatibility with existing callers
 * that used the old `(value, indent, budget)` signature.
 */
export function renderPromptMaterial(value: unknown, options?: RenderOptions | string, legacyBudget?: number): string {
  const indent = typeof options === "string" ? options : options?.indent || "";
  const budget = normalizedBudget(typeof options === "string" ? legacyBudget : options?.budget);
  const rendered = renderNode(value, indent);
  if (rendered.length <= budget) return rendered;

  // Keep every key and value when the readable form is too large. The compact
  // representation is a transport-only compression of the same material; it
  // never drops trailing fields or array items. If even that form is too large,
  // fail explicitly so the caller can surface a context-size error.
  const compact = `${indent}${compactNode(value)}`;
  if (compact.length <= budget) return compact;
  throw new PromptMaterialTooLargeError("VideosBatch prompt renderer exceeded its context budget without lossless compression");
}

function renderNode(value: unknown, indent: string): string {
  if (value === null || value === undefined || value === "") {
    return `${indent}无`;
  }
  if (Array.isArray(value)) return renderArray(value, indent);
  if (typeof value === "object") return renderObject(value as Record<string, unknown>, indent);

  return `${indent}${scalar(value)}`;
}

function renderArray(value: unknown[], indent: string): string {
  if (!value.length) return `${indent}无`;
  return value.map((item) => `${indent}-\n${renderNode(item, `${indent}  `)}`).join("\n");
}

function renderObject(value: Record<string, unknown>, indent: string): string {
  const entries = Object.entries(value);
  if (!entries.length) return `${indent}无`;
  return entries.map(([key, item]) => {
    const prefix = `${indent}${key}：`;
    if (item !== null && typeof item === "object") return `${prefix}\n${renderNode(item, `${indent}  `)}`;
    return `${prefix}${scalar(item)}`;
  }).join("\n");
}

function compactNode(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "bigint") return JSON.stringify(String(value));
  if (Array.isArray(value)) return `[${value.map(compactNode).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${JSON.stringify(key)}:${compactNode(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(String(value));
}
