import { createHash } from "node:crypto";
import { validateVideosBatchAssetPlan } from "./llmTextStages";
import {
  normalizeShotExecutionAssetPlanLineage,
  normalizeShotExecutionSourceLineage,
  validateShotExecutionPackage
} from "./shotExecutionPackage";
import type {
  ShotExecutionAudioIntentEvent,
  ShotExecutionEffect,
  ShotExecutionPackage,
  ShotExecutionPackageLineage,
  ShotExecutionReference,
  ShotExecutionStoryType
} from "../../shared/videosBatchWorkflow";

const SHOT_PROVIDER_PROMPT_SCHEMA_VERSION = "1" as const;
const SHOT_PROVIDER_PROMPT_COMPILER_VERSION = "2" as const;

export const SHOT_PROVIDER_PROMPT_SECTION_ORDER = [
  "teaching",
  "scene",
  "role",
  "support",
  "effects",
  "continuity",
  "audio",
  "references"
] as const;

type ShotProviderPromptSectionId = (typeof SHOT_PROVIDER_PROMPT_SECTION_ORDER)[number];

const SECTION_TITLES: Record<ShotProviderPromptSectionId, string> = {
  teaching: "[教学目标与知识点]",
  scene: "[章节与场景]",
  role: "[类型主体]",
  support: "[辅助字段]",
  effects: "[画面效果]",
  continuity: "[连续性]",
  audio: "[声音表演约束]",
  references: "[Reference image bindings (strict)]"
};

const ROLE_LABELS: Record<ShotExecutionStoryType, "人物" | "主体" | "核心意象"> = {
  STORY: "人物",
  SCIENCE: "主体",
  KNOWLEDGE: "核心意象"
};
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

const SUPPORT_LABELS: Record<ShotExecutionStoryType, "道具" | "辅助元素"> = {
  STORY: "道具",
  SCIENCE: "辅助元素",
  KNOWLEDGE: "辅助元素"
};

const SEMANTIC_TAG_PATTERN = /^【(人物|场景|道具|主体|辅助元素|核心意象)[：:]\s*(.+?)】$/u;
const REFERENCE_LABELS: Record<ShotExecutionStoryType, readonly string[]> = {
  STORY: ["人物", "场景", "道具"],
  SCIENCE: ["主体", "场景", "辅助元素"],
  KNOWLEDGE: ["核心意象", "场景", "辅助元素"]
};
const POSITION_REFERENCE_PATTERN = /(?:第\s*(?:\d+|[一二三四五六七八九十百千]+)\s*(?:张|个)?\s*(?:图|图片|参考图)|(?:参考图|图片|图像|图)\s*#?\s*(?:\d+|[一二三四五六七八九十百千]+)|image\s*#?\s*\d+)/iu;
const STABLE_PUBLIC_ASSET_ID_PATTERN = /\bP\d{3,}-A\d{3,}\b/iu;
const URL_PATTERN = /\b[a-z][a-z\d+.-]{1,31}:(?:\/\/|[^\s])/iu;
const MEDIA_PATH_PATTERN = /(?:^|[\\/])media[\\/]/iu;
const WINDOWS_PATH_PATTERN = /\b[A-Z]:[\\/]/iu;
const UNC_PATH_PATTERN = /\\\\[A-Za-z0-9._-]+[\\/]/u;
const POSIX_PATH_PATTERN = /(?:^|[\s(])\/(?:Users|user|home|tmp|var|mnt|workspace|data|private|opt|srv|media)(?:[\\/]|$)/iu;
const STRUCTURED_PATH_PATTERN = /[\p{L}\p{N}._~-]+(?:[/\\]+[\p{L}\p{N}._~-]+)+/gu;
const NUMERIC_SLASH_EXPRESSION_PATTERN = /^(?:\d+(?:\.\d+)?\/\d+(?:\.\d+)?|\d{4}\/\d{1,2}\/\d{1,2})$/u;
// 「旁白/字幕」「正面/侧面」这类纯汉字正斜杠短语是自然语言，不是文件路径（2026-09-12
// Tier 1 真实模型验收发现：12 段真实分镜里 1 处即导致整链失败）。路径与自然短语的分界：
//  - 反斜杠、扩展名点、ASCII/数字段 → 一律按路径拦截（真实泄漏均为该形态）；
//  - 每段都是纯汉字且只出现正斜杠 → 视为自然短语放行（中文不用反斜杠，自然短语
//    不带扩展名）。由此「资料/角色」这类纯汉字相对路径不再拦截，属已知取舍。
const HAN_SEGMENT_PATTERN = /^[\p{Script=Han}]+$/u;
const PROMPT_ESCAPE_PATTERN = /\\(?:\\|n|u[0-9a-f]{4})/gu;
const PROVIDER_PROMPT_SLASH_EXCEPTIONS = new Set([
  "保持人物/主体、场景、道具/辅助元素的身份连续。",
  "旁白/对白由独立 TTS 与混音链路提供，Provider 不负责生成受控旁白。"
]);
const INTERNAL_IDENTIFIER_PATTERN = /\b(?:assetId|selectedAssetId|publicAssetId|referenceId|shotId|taskId|contentHash|sourceHash)\b\s*[:=]?\s*[^\s,;，。；]*|\b(?:asset|shot|task)_[A-Za-z0-9][A-Za-z0-9_-]*/iu;
const EVENT_INTERNAL_IDENTIFIER_PATTERN = /\b(?:asset|shot|task)_[A-Za-z0-9][A-Za-z0-9_-]*|\b(?:assetId|shotId|taskId)\b/iu;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/u;

interface CompiledShotPromptSection {
  id: ShotProviderPromptSectionId;
  title: string;
  text: string;
}

export interface CompiledShotPrompt {
  ok: true;
  schemaVersion: typeof SHOT_PROVIDER_PROMPT_SCHEMA_VERSION;
  sourceStageId: "FINAL_STORYBOARD";
  sourceRevision: number;
  sourceHash: string;
  assetPlanRevision: number;
  assetPlanHash: string;
  contentHash: string;
  compilerVersion: typeof SHOT_PROVIDER_PROMPT_COMPILER_VERSION;
  promptHash: string;
  text: string;
  sections: readonly CompiledShotPromptSection[];
}

const PROMPT_COMPILER_ERROR_CODES = [
  "PROMPT_PACKAGE_INVALID",
  "PROMPT_PACKAGE_LINEAGE_STALE",
  "PROMPT_FIELD_MISSING",
  "PROMPT_REFERENCE_INVALID",
  "PROMPT_FORBIDDEN_IDENTIFIER",
  "PROMPT_CONTEXT_TOO_LARGE"
] as const;

type PromptCompilerErrorCode = (typeof PROMPT_COMPILER_ERROR_CODES)[number];

export interface PromptCompilerError {
  ok: false;
  code: PromptCompilerErrorCode;
  message: string;
  retryable: boolean;
  sourceRevision: number | null;
  sourceHash: string | null;
  attempt: 0;
  provider: null;
  model: null;
}

export type ShotProviderPromptCompileResult = CompiledShotPrompt | PromptCompilerError;

interface ShotProviderPromptAssetPlanLineage {
  revision?: number;
  hash?: string;
  contentHash?: string;
  styleSpec?: string;
  negativePrompt?: string;
  assetPlanRevision?: number;
  assetPlanHash?: string;
  status?: "ready" | "pending" | "running" | "failed" | "stale";
  assetPlanStatus?: "ready" | "pending" | "running" | "failed" | "stale";
  assetPlanStyleSpec?: string;
  assetPlanNegativePrompt?: string;
  assetPlan?: {
    revision?: number;
    hash?: string;
    styleSpec?: string;
    negativePrompt?: string;
  };
  artifact?: unknown;
}

interface CompileShotProviderPromptOptions {
  maxChars?: number;
  /** Current FINAL_STORYBOARD lineage, when the caller has it available. */
  current?: ShotExecutionPackageLineage | number;
  currentHash?: string;
  expectedLineage?: ShotExecutionPackageLineage | number;
  expectedSourceRevision?: number;
  expectedSourceHash?: string;
  /** Current confirmed ASSET_PLAN stage/artifact lineage, when available. */
  currentAssetPlan?: ShotProviderPromptAssetPlanLineage | number;
  currentAssetPlanHash?: string;
  expectedAssetPlanLineage?: ShotProviderPromptAssetPlanLineage | number;
  expectedAssetPlanRevision?: number;
  expectedAssetPlanHash?: string;
  expectedAssetPlanStyleSpec?: string;
  expectedAssetPlanNegativePrompt?: string;
}

type AnyRecord = Record<string, unknown>;

type ValidationIssue = {
  code: PromptCompilerErrorCode;
  message: string;
  retryable?: boolean;
};

class ShotProviderPromptRenderError extends Error {
  readonly code: PromptCompilerErrorCode;
  readonly retryable: boolean;

  constructor(issue: ValidationIssue) {
    super(issue.message);
    this.name = "ShotProviderPromptRenderError";
    this.code = issue.code;
    this.retryable = Boolean(issue.retryable);
  }
}

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

function escapePromptData(value: string): string {
  return normalizeLineEndings(value)
    .replace(/[\u2028\u2029]/gu, "\n")
    .replace(/\\/gu, "\\\\")
    .replace(/\n/gu, "\\n")
    .replace(/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, (character) => {
      const codePoint = character.codePointAt(0) || 0;
      return `\\u${codePoint.toString(16).padStart(4, "0")}`;
    })
    .replace(/\[/gu, "\\[")
    .replace(/\]/gu, "\\]")
    .replace(/\|/gu, "\\|");
}

function display(value: unknown): string {
  if (value === null || value === undefined) return "无";
  return escapePromptData(String(value));
}

function sourceMetadata(value: unknown): { sourceRevision: number | null; sourceHash: string | null } {
  if (!isRecord(value)) return { sourceRevision: null, sourceHash: null };
  return {
    sourceRevision: Number.isInteger(value.sourceRevision) ? value.sourceRevision as number : null,
    sourceHash: typeof value.sourceHash === "string" ? value.sourceHash : null
  };
}

function makeError(value: unknown, issue: ValidationIssue): PromptCompilerError {
  const source = sourceMetadata(value);
  return {
    ok: false,
    code: issue.code,
    message: issue.message,
    retryable: Boolean(issue.retryable),
    sourceRevision: source.sourceRevision,
    sourceHash: source.sourceHash,
    attempt: 0,
    provider: null,
    model: null
  };
}

type PromptLineageNormalization = {
  current?: ShotExecutionPackageLineage;
  conflicts: string[];
};

function mergePromptLineageParts(
  parts: Array<{ lineage: Partial<ShotExecutionPackageLineage>; conflicts: string[] }>
): PromptLineageNormalization {
  const current: Partial<ShotExecutionPackageLineage> = {};
  const conflicts = parts.flatMap((part) => part.conflicts);
  for (const part of parts) {
    for (const [key, value] of Object.entries(part.lineage) as Array<[keyof ShotExecutionPackageLineage, unknown]>) {
      if (value === undefined) continue;
      if (current[key] !== undefined && current[key] !== value) conflicts.push(`${String(key)} aliases conflict`);
      current[key] = value as never;
    }
  }
  return { current: Object.keys(current).length ? current as ShotExecutionPackageLineage : undefined, conflicts };
}

function hasAssetPlanLineageFields(value: AnyRecord): boolean {
  return ["assetPlanRevision", "assetPlanHash", "assetPlanStatus", "assetPlanArtifactHash", "assetPlanStyleSpec", "assetPlanNegativePrompt", "status", "artifact", "contentHash"]
    .some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isCompleteAssetPlanStage(value: unknown): value is ShotProviderPromptAssetPlanLineage {
  if (!isRecord(value)) return false;
  return (value.status === "ready" || value.assetPlanStatus === "ready")
    && (typeof value.revision === "number" || typeof value.assetPlanRevision === "number")
    && (typeof value.contentHash === "string" || typeof value.assetPlanHash === "string" || typeof value.hash === "string")
    && isRecord(value.artifact);
}

function assetPlanInputsFromLineage(value: unknown): ShotProviderPromptAssetPlanLineage[] {
  if (!isRecord(value)) return [];
  const inputs: ShotProviderPromptAssetPlanLineage[] = [];
  if (isCompleteAssetPlanStage(value)) inputs.push(value as ShotProviderPromptAssetPlanLineage);
  if (isRecord(value.assetPlan)) inputs.push(value.assetPlan as ShotProviderPromptAssetPlanLineage);
  if (hasAssetPlanLineageFields(value) && !isCompleteAssetPlanStage(value)) {
    inputs.push(value as ShotProviderPromptAssetPlanLineage);
  }
  return inputs;
}

function expectedLineage(options: CompileShotProviderPromptOptions): PromptLineageNormalization {
  const sourceParts: Array<{ lineage: Partial<ShotExecutionPackageLineage>; conflicts: string[] }> = [];
  if (options.current !== undefined) {
    sourceParts.push(normalizeShotExecutionSourceLineage(options.current, options.currentHash));
  } else if (options.expectedLineage !== undefined) {
    sourceParts.push(normalizeShotExecutionSourceLineage(options.expectedLineage, options.currentHash));
  }
  if (options.current !== undefined && options.expectedLineage !== undefined) {
    sourceParts.push(normalizeShotExecutionSourceLineage(options.expectedLineage));
  }

  const planParts: Array<{ lineage: Partial<ShotExecutionPackageLineage>; conflicts: string[] }> = [];
  const sourceInputs = [options.current, options.expectedLineage].filter((value) => value !== undefined);
  for (const sourceInput of sourceInputs) {
    for (const planInput of assetPlanInputsFromLineage(sourceInput)) {
      planParts.push(normalizeShotExecutionAssetPlanLineage(planInput));
    }
  }
  if (options.currentAssetPlan !== undefined) {
    planParts.push(normalizeShotExecutionAssetPlanLineage(options.currentAssetPlan));
  }
  if (options.expectedAssetPlanLineage !== undefined) {
    planParts.push(normalizeShotExecutionAssetPlanLineage(options.expectedAssetPlanLineage));
  }

  const merged = mergePromptLineageParts([...sourceParts, ...planParts]);
  const expectedValues: Array<[keyof ShotExecutionPackageLineage, unknown, string]> = [
    ["sourceRevision", options.expectedSourceRevision, "expectedSourceRevision"],
    ["sourceHash", options.expectedSourceHash, "expectedSourceHash"],
    ["assetPlanRevision", options.expectedAssetPlanRevision, "expectedAssetPlanRevision"],
    ["assetPlanHash", options.expectedAssetPlanHash ?? options.currentAssetPlanHash, "expectedAssetPlanHash"],
    ["assetPlanStyleSpec", options.expectedAssetPlanStyleSpec, "expectedAssetPlanStyleSpec"],
    ["assetPlanNegativePrompt", options.expectedAssetPlanNegativePrompt, "expectedAssetPlanNegativePrompt"]
  ];
  for (const [key, expected, label] of expectedValues) {
    if (expected === undefined) continue;
    if (merged.current?.[key] !== undefined && merged.current[key] !== expected) {
      merged.conflicts.push(`${label} conflicts with current lineage`);
    }
  }
  return merged;
}

function currentAssetPlanSource(options: CompileShotProviderPromptOptions): ShotProviderPromptAssetPlanLineage | undefined {
  const explicit = options.currentAssetPlan ?? options.expectedAssetPlanLineage;
  if (explicit !== undefined && typeof explicit !== "number") return explicit;
  for (const value of [options.current, options.expectedLineage]) {
    const embedded = assetPlanInputsFromLineage(value);
    if (embedded.length) return embedded[0];
  }
  return undefined;
}

function packageValidationLineage(
  lineage: PromptLineageNormalization,
  options: CompileShotProviderPromptOptions
): ShotExecutionPackageLineage | undefined {
  if (!lineage.current) return undefined;
  const assetPlan = currentAssetPlanSource(options);
  if (!assetPlan || typeof assetPlan === "number") return lineage.current;
  return { ...lineage.current, assetPlan } as ShotExecutionPackageLineage;
}

function currentLineageIssue(
  lineage: PromptLineageNormalization,
  options: CompileShotProviderPromptOptions
): ValidationIssue | undefined {
  if (lineage.conflicts.length) {
    return {
      code: "PROMPT_PACKAGE_LINEAGE_STALE",
      retryable: false,
      message: `当前血缘别名冲突：${lineage.conflicts.join("；")}`
    };
  }
  const current = lineage.current;
  if (!isRecord(current)
    || !Number.isInteger(current.sourceRevision)
    || Number(current.sourceRevision) < 1
    || typeof current.sourceHash !== "string"
    || !HASH_PATTERN.test(current.sourceHash)
    || !Number.isInteger(current.assetPlanRevision)
    || Number(current.assetPlanRevision) < 1
    || typeof current.assetPlanHash !== "string"
    || !HASH_PATTERN.test(current.assetPlanHash)
    || current.assetPlanStatus !== "ready"
    || typeof current.assetPlanArtifactHash !== "string"
    || !HASH_PATTERN.test(current.assetPlanArtifactHash)
    || current.assetPlanArtifactHash !== current.assetPlanHash
    || typeof current.assetPlanStyleSpec !== "string"
    || !current.assetPlanStyleSpec.trim()
    || typeof current.assetPlanNegativePrompt !== "string"
    || !current.assetPlanNegativePrompt.trim()) {
    return {
      code: "PROMPT_PACKAGE_LINEAGE_STALE",
      retryable: false,
      message: "编译 Provider Prompt 必须提供当前 FINAL_STORYBOARD 与 ASSET_PLAN 的 revision/hash，以及当前计划的 styleSpec/negativePrompt"
    };
  }
  const assetPlan = currentAssetPlanSource(options);
  if (!assetPlan || typeof assetPlan === "number" || !isRecord(assetPlan.artifact)) {
    return {
      code: "PROMPT_PACKAGE_LINEAGE_STALE",
      retryable: false,
      message: "当前 ASSET_PLAN 必须来自带 artifact 的 ready stage wrapper"
    };
  }
  const assetPlanStatus = typeof assetPlan.status === "string"
    ? assetPlan.status
    : assetPlan.assetPlanStatus;
  if (assetPlanStatus !== "ready") {
    return {
      code: "PROMPT_PACKAGE_LINEAGE_STALE",
      retryable: false,
      message: "当前 ASSET_PLAN stage 必须为 ready"
    };
  }
  const assetPlanValidation = validateVideosBatchAssetPlan(assetPlan.artifact);
  if (!assetPlanValidation.ok) {
    return {
      code: "PROMPT_PACKAGE_INVALID",
      retryable: false,
      message: `当前 ASSET_PLAN 业务校验失败：${assetPlanValidation.errors.join("；")}`
    };
  }
  return undefined;
}

function promptCodeForPackageValidation(
  validation: { code?: string; errors: string[] }
): PromptCompilerErrorCode {
  if (validation.code === "SHOT_EXECUTION_PACKAGE_LINEAGE_STALE") return "PROMPT_PACKAGE_LINEAGE_STALE";

  const errors = validation.errors;
  if (errors.some((error) => /^references(?:\[| |$)/u.test(error) && !/^references must be an array$/u.test(error))) {
    return "PROMPT_REFERENCE_INVALID";
  }
  if (errors.some((error) => /is required|must be an object|must be an array/u.test(error))) {
    return "PROMPT_FIELD_MISSING";
  }
  if (errors.some((error) => /sourceStageId|schemaVersion|contentHash|sourceHash|shot\.storyType|roleLabel must|supportLabel must/u.test(error))) {
    return "PROMPT_PACKAGE_INVALID";
  }
  return "PROMPT_PACKAGE_INVALID";
}

function packageValidationIssue(
  value: unknown,
  validation: { code?: string; errors: string[] }
): PromptCompilerError {
  const code = promptCodeForPackageValidation(validation);
  const retryable = code === "PROMPT_PACKAGE_LINEAGE_STALE";
  return makeError(value, {
    code,
    retryable,
    message: `ShotExecutionPackage 校验失败：${validation.errors.join("；")}`
  });
}

function isNaturalCjkSlashPhrase(match: string): boolean {
  if (match.includes("\\")) return false;
  const segments = match.split(/[/\\]+/u);
  return segments.length >= 2 && segments.every((segment) => HAN_SEGMENT_PATTERN.test(segment));
}

function hasStructuredPath(
  value: string,
  allowedTokens: ReadonlySet<string> = new Set(),
  maskPromptEscapes = false
): boolean {
  let scanValue = [...allowedTokens].reduce(
    (current, token) => current.split(token).join(""),
    value
  );
  if (maskPromptEscapes) scanValue = scanValue.replace(PROMPT_ESCAPE_PATTERN, "");
  for (const match of scanValue.matchAll(STRUCTURED_PATH_PATTERN)) {
    if (!allowedTokens.has(match[0])
      && !NUMERIC_SLASH_EXPRESSION_PATTERN.test(match[0])
      && !isNaturalCjkSlashPhrase(match[0])) return true;
  }
  return false;
}

function hasForbiddenTransportOrIdentifier(value: string): boolean {
  return STABLE_PUBLIC_ASSET_ID_PATTERN.test(value)
    || URL_PATTERN.test(value)
    || MEDIA_PATH_PATTERN.test(value)
    || WINDOWS_PATH_PATTERN.test(value)
    || UNC_PATH_PATTERN.test(value)
    || POSIX_PATH_PATTERN.test(value)
    || hasStructuredPath(value)
    || INTERNAL_IDENTIFIER_PATTERN.test(value);
}

function isPositionReference(value: string): boolean {
  return POSITION_REFERENCE_PATTERN.test(value);
}

function containsPromptSectionMarker(value: string): boolean {
  return Object.values(SECTION_TITLES).some((title) => value.includes(title));
}

function userFacingPackageTexts(executionPackage: ShotExecutionPackage): string[] {
  const texts = [
    executionPackage.shot.chapter,
    executionPackage.teaching.goal,
    executionPackage.teaching.knowledgeFocus,
    executionPackage.visual.scene,
    executionPackage.visual.role,
    executionPackage.visual.support,
    executionPackage.visual.styleSpec,
    executionPackage.visual.negativePrompt,
    executionPackage.visual.globalContinuity,
    ...executionPackage.teaching.evidence.flatMap((entry) => [entry.source, entry.quote]),
    ...executionPackage.visual.effects.flatMap((effect) => [effect.timeRange, effect.visual, effect.action, effect.camera]),
    ...executionPackage.audioIntent.voices.map((event) => event.text),
    ...executionPackage.audioIntent.sounds.map((event) => event.text),
    ...executionPackage.references.flatMap((reference) => [reference.semanticLabel, reference.assetKey])
  ];
  return texts.filter((value): value is string => typeof value === "string");
}

function referenceSemanticText(
  reference: ShotExecutionReference,
  storyType: ShotExecutionStoryType
): { text?: string; issue?: ValidationIssue } {
  const raw = normalizeLineEndings(reference.semanticLabel).trim();
  const key = normalizeLineEndings(reference.assetKey).trim();
  if (!raw || !key) {
    return {
      issue: {
        code: "PROMPT_REFERENCE_INVALID",
        message: "参考图 semanticLabel 和 assetKey 必须是非空语义文本"
      }
    };
  }
  if (hasForbiddenTransportOrIdentifier(raw) || hasForbiddenTransportOrIdentifier(key)) {
    return {
      issue: {
        code: "PROMPT_FORBIDDEN_IDENTIFIER",
        message: "参考图语义文本包含禁止的稳定标识、URL 或路径"
      }
    };
  }
  if (isPositionReference(raw) || isPositionReference(key)) {
    return {
      issue: {
        code: "PROMPT_REFERENCE_INVALID",
        message: "参考图必须使用语义标签，不得使用位置型图片引用"
      }
    };
  }

  const tagged = raw.match(SEMANTIC_TAG_PATTERN);
  if (!tagged) {
    return {
      issue: {
        code: "PROMPT_REFERENCE_INVALID",
        message: `参考图 semanticLabel 必须使用 ${REFERENCE_LABELS[storyType].join("、")} 类型标签`
      }
    };
  }
  if (!REFERENCE_LABELS[storyType].includes(tagged[1])) {
    return {
      issue: {
        code: "PROMPT_REFERENCE_INVALID",
        message: `参考图 semanticLabel 类型 ${tagged[1]} 与 ${storyType} 不匹配`
      }
    };
  }
  if (!tagged[2].trim()) {
    return {
      issue: {
        code: "PROMPT_REFERENCE_INVALID",
        message: "参考图 semanticLabel 的语义名称不能为空"
      }
    };
  }
  return { text: escapePromptData(raw) };
}

function validatePromptPackageSemantics(executionPackage: ShotExecutionPackage): ValidationIssue | undefined {
  const storyType = executionPackage.shot.storyType;
  if (executionPackage.visual.roleLabel !== ROLE_LABELS[storyType]) {
    return {
      code: "PROMPT_PACKAGE_INVALID",
      message: `visual.roleLabel 必须匹配 ${storyType} 的类型字段`
    };
  }
  if (executionPackage.visual.supportLabel !== SUPPORT_LABELS[storyType]) {
    return {
      code: "PROMPT_PACKAGE_INVALID",
      message: `visual.supportLabel 必须匹配 ${storyType} 的类型字段`
    };
  }

  for (const value of userFacingPackageTexts(executionPackage)) {
    if (hasForbiddenTransportOrIdentifier(value)) {
      return {
        code: "PROMPT_FORBIDDEN_IDENTIFIER",
        message: "Provider Prompt 字段包含禁止的稳定标识、URL 或路径"
      };
    }
    if (isPositionReference(value)) {
      return {
        code: "PROMPT_REFERENCE_INVALID",
        message: "Provider Prompt 不得使用位置型图片引用"
      };
    }
    if (containsPromptSectionMarker(value)) {
      return {
        code: "PROMPT_FORBIDDEN_IDENTIFIER",
        message: "Provider Prompt 字段不得包含章节标记"
      };
    }
  }

  const references = [...executionPackage.references].sort((left, right) => left.ordinal - right.ordinal);
  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index];
    if (reference.ordinal !== index + 1) {
      return {
        code: "PROMPT_REFERENCE_INVALID",
        message: "参考图 ordinal 必须从 1 开始连续排列"
      };
    }
    if ([reference.referenceId, reference.assetKey, reference.semanticLabel, reference.assetId]
      .some((value) => STABLE_PUBLIC_ASSET_ID_PATTERN.test(value))) {
      return {
        code: "PROMPT_FORBIDDEN_IDENTIFIER",
        message: "参考图审计字段不得携带稳定公开资产编号"
      };
    }
    const semantic = referenceSemanticText(reference, storyType);
    if (semantic.issue) return semantic.issue;
  }

  for (const event of [...executionPackage.audioIntent.voices, ...executionPackage.audioIntent.sounds]) {
    if (EVENT_INTERNAL_IDENTIFIER_PATTERN.test(event.id)) {
      return {
        code: "PROMPT_FORBIDDEN_IDENTIFIER",
        message: "声音事件 id 不得携带原生 assetId、shotId 或 taskId"
      };
    }
  }

  return undefined;
}

function field(path: string, value: unknown, compact: boolean): string {
  return `${path}${compact ? "=" : "："}${display(value)}`;
}

function compactFields(fields: Array<[string, unknown]>): string {
  return fields.map(([path, value]) => field(path, value, true)).join("|");
}

function effectFields(effect: ShotExecutionEffect, index: number): Array<[string, unknown]> {
  const prefix = `visual.effects[${index + 1}]`;
  return [
    [`${prefix}.sequence（子镜头序号）`, effect.sequence],
    [`${prefix}.timeRange`, effect.timeRange],
    [`${prefix}.duration`, effect.duration],
    [`${prefix}.visual`, effect.visual],
    [`${prefix}.action`, effect.action],
    [`${prefix}.camera`, effect.camera]
  ];
}

function audioEventFields(
  path: string,
  event: ShotExecutionAudioIntentEvent,
  index: number
): Array<[string, unknown]> {
  const prefix = `${path}[${index + 1}]`;
  return [
    [`${prefix}.timeWindow`, `${event.startSec}-${event.endSec}秒`],
    [`${prefix}.startSec`, event.startSec],
    [`${prefix}.endSec`, event.endSec],
    [`${prefix}.text（原文）`, event.text]
  ];
}

function section(
  id: ShotProviderPromptSectionId,
  lines: string[]
): CompiledShotPromptSection {
  const title = SECTION_TITLES[id];
  return {
    id,
    title,
    text: [title, ...lines].join("\n")
  };
}

function referenceLines(executionPackage: ShotExecutionPackage): string[] {
  const lines: string[] = [];
  const references = [...executionPackage.references].sort((left, right) => left.ordinal - right.ordinal);
  for (const reference of references) {
    const semantic = referenceSemanticText(reference, executionPackage.shot.storyType).text || "";
    lines.push(`Image ${reference.ordinal} = ${semantic}`);
  }

  const constraints = [
    "严格保持参考图 Image N 对应关系。",
    "保持人物/主体、场景、道具/辅助元素的身份连续。",
    "保持画面、动作、运镜和教学语义。",
    "不生成字幕、标题卡、答案或额外剧情。",
    "不让 Provider 生成受控旁白。",
    "不交换、删除或新增参考图。"
  ];
  lines.push("执行约束：");
  lines.push(...constraints.map((constraint) => `- ${constraint}`));
  return lines;
}

/** Render a package after its caller has completed the public preflight. */
function renderShotProviderPromptSectionsUnchecked(
  executionPackage: ShotExecutionPackage,
  compact = false
): readonly CompiledShotPromptSection[] {
  const evidenceLines = executionPackage.teaching.evidence.length
    ? executionPackage.teaching.evidence.flatMap((entry, index) => [
      field(`teaching.evidence[${index + 1}].source`, entry.source, compact),
      field(`teaching.evidence[${index + 1}].quote`, entry.quote, compact)
    ])
    : [field("teaching.evidence", "无", compact)];

  const effectLines = executionPackage.visual.effects.flatMap((effect, index) => {
    const fields = effectFields(effect, index);
    return compact
      ? [compactFields(fields)]
      : fields.map(([path, value]) => field(path, value, false));
  });

  const voiceLines = executionPackage.audioIntent.voices.length
    ? executionPackage.audioIntent.voices.flatMap((event, index) => {
      const fields = audioEventFields("audioIntent.voices", event, index);
      return compact
        ? [compactFields(fields)]
        : fields.map(([path, value]) => field(path, value, false));
    })
    : [field("audioIntent.voices", "无", compact)];

  const soundLines = executionPackage.audioIntent.sounds.length
    ? executionPackage.audioIntent.sounds.flatMap((event, index) => {
      const fields = audioEventFields("audioIntent.sounds", event, index);
      return compact
        ? [compactFields(fields)]
        : fields.map(([path, value]) => field(path, value, false));
    })
    : [field("audioIntent.sounds", "无", compact)];

  return [
    section("teaching", [
      field("teaching.goal", executionPackage.teaching.goal, compact),
      field("teaching.knowledgeFocus", executionPackage.teaching.knowledgeFocus, compact),
      ...evidenceLines
    ]),
    section("scene", [
      field("shot.chapter", executionPackage.shot.chapter, compact),
      field("visual.scene", executionPackage.visual.scene, compact),
      field("shot.sequence", executionPackage.shot.sequence, compact),
      field("shot.screenplaySceneSequence", executionPackage.shot.screenplaySceneSequence, compact)
    ]),
    section("role", [
      field("shot.storyType", executionPackage.shot.storyType, compact),
      field("visual.roleLabel", executionPackage.visual.roleLabel, compact),
      field("visual.role", executionPackage.visual.role, compact)
    ]),
    section("support", [
      field("visual.supportLabel", executionPackage.visual.supportLabel, compact),
      field("visual.support", executionPackage.visual.support, compact)
    ]),
    section("effects", effectLines),
    section("continuity", [
      field("visual.styleSpec", executionPackage.visual.styleSpec, compact),
      field("visual.negativePrompt", executionPackage.visual.negativePrompt, compact),
      field("visual.globalContinuity", executionPackage.visual.globalContinuity, compact)
    ]),
    section("audio", [
      "旁白/对白由独立 TTS 与混音链路提供，Provider 不负责生成受控旁白。",
      ...voiceLines,
      ...soundLines
    ]),
    section("references", referenceLines(executionPackage))
  ];
}

function assertRenderablePackage(
  executionPackage: ShotExecutionPackage,
  options: CompileShotProviderPromptOptions = {}
): void {
  const lineage = expectedLineage(options);
  const validation = validateShotExecutionPackage(
    executionPackage as unknown,
    packageValidationLineage(lineage, options),
    undefined
  );
  if (!validation.ok) {
    throw new ShotProviderPromptRenderError({
      code: promptCodeForPackageValidation(validation),
      retryable: Boolean(validation.retryable),
      message: `ShotExecutionPackage 校验失败：${validation.errors.join("；")}`
    });
  }
  const semanticIssue = validatePromptPackageSemantics(executionPackage);
  if (semanticIssue) throw new ShotProviderPromptRenderError(semanticIssue);
  const lineageIssue = currentLineageIssue(lineage, options);
  if (lineageIssue) throw new ShotProviderPromptRenderError(lineageIssue);
}

/**
 * Render one package for callers that need sections directly. The guard is
 * intentional: this low-level export must not become a validation bypass.
 */
export function renderShotProviderPromptSections(
  executionPackage: ShotExecutionPackage,
  compactOrOptions: boolean | CompileShotProviderPromptOptions = false,
  maybeOptions: CompileShotProviderPromptOptions = {}
): readonly CompiledShotPromptSection[] {
  const compact = typeof compactOrOptions === "boolean" ? compactOrOptions : false;
  const options = typeof compactOrOptions === "boolean" ? maybeOptions : compactOrOptions;
  assertRenderablePackage(executionPackage, options);
  const sections = freezePromptSections(renderShotProviderPromptSectionsUnchecked(executionPackage, compact));
  const rendered = compileSuccess(executionPackage, sections, compact);
  const renderedIssue = validateRenderedPrompt(rendered);
  if (renderedIssue) throw new ShotProviderPromptRenderError(renderedIssue);
  const lengthIssue = promptLengthIssue(rendered.text, options.maxChars);
  if (lengthIssue) throw new ShotProviderPromptRenderError(lengthIssue);
  return sections;
}

function joinSections(sections: readonly CompiledShotPromptSection[], compact: boolean): string {
  return sections.map((item) => item.text).join(compact ? "\n" : "\n\n");
}

function freezePromptSections(sections: readonly CompiledShotPromptSection[]): readonly CompiledShotPromptSection[] {
  return Object.freeze(sections.map((section) => Object.freeze({ ...section })));
}

function promptHashFor(text: string, compact: boolean): string {
  return createHash("sha256")
    .update(JSON.stringify({
      compilerVersion: SHOT_PROVIDER_PROMPT_COMPILER_VERSION,
      rendering: compact ? "compact" : "full",
      text
    }))
    .digest("hex");
}

function compileSuccess(
  executionPackage: ShotExecutionPackage,
  sections: readonly CompiledShotPromptSection[],
  compact: boolean
): CompiledShotPrompt {
  const frozenSections = freezePromptSections(sections);
  const text = joinSections(frozenSections, compact);
  return Object.freeze({
    ok: true,
    schemaVersion: SHOT_PROVIDER_PROMPT_SCHEMA_VERSION,
    sourceStageId: executionPackage.sourceStageId,
    sourceRevision: executionPackage.sourceRevision,
    sourceHash: executionPackage.sourceHash,
    assetPlanRevision: executionPackage.assetPlanRevision,
    assetPlanHash: executionPackage.assetPlanHash,
    contentHash: executionPackage.contentHash,
    compilerVersion: SHOT_PROVIDER_PROMPT_COMPILER_VERSION,
    promptHash: promptHashFor(text, compact),
    text,
    sections: frozenSections
  });
}

function promptLengthIssue(value: string, rawMaxChars: unknown): ValidationIssue | undefined {
  if (rawMaxChars === undefined) return undefined;
  const maxChars = Number(rawMaxChars);
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    return {
      code: "PROMPT_CONTEXT_TOO_LARGE",
      message: "Provider Prompt maxChars 必须是正整数"
    };
  }
  if (value.length > maxChars) {
    return {
      code: "PROMPT_CONTEXT_TOO_LARGE",
      message: `Provider Prompt 超过 maxChars=${maxChars}（实际 ${value.length}）`
    };
  }
  return undefined;
}

function validateRenderedPrompt(result: CompiledShotPrompt): ValidationIssue | undefined {
  if (CONTROL_CHARACTER_PATTERN.test(result.text)
    || result.sections.some((section) => CONTROL_CHARACTER_PATTERN.test(section.text))) {
    return {
      code: "PROMPT_PACKAGE_INVALID",
      message: "Provider Prompt 不得包含未规整的换行或控制字符"
    };
  }
  if (STABLE_PUBLIC_ASSET_ID_PATTERN.test(result.text)
    || URL_PATTERN.test(result.text)
    || MEDIA_PATH_PATTERN.test(result.text)
    || WINDOWS_PATH_PATTERN.test(result.text)
    || UNC_PATH_PATTERN.test(result.text)
    || POSIX_PATH_PATTERN.test(result.text)
    || hasStructuredPath(result.text, PROVIDER_PROMPT_SLASH_EXCEPTIONS, true)
    || INTERNAL_IDENTIFIER_PATTERN.test(result.text)) {
    return {
      code: "PROMPT_FORBIDDEN_IDENTIFIER",
      message: "Provider Prompt 包含禁止的稳定标识、URL 或路径"
    };
  }
  if (/\{\s*"(?:schemaVersion|sourceStageId|contentHash|shot|teaching|visual|audioIntent|references)"\s*:/u.test(result.text)) {
    return {
      code: "PROMPT_FORBIDDEN_IDENTIFIER",
      message: "Provider Prompt 不得包含完整原始 JSON"
    };
  }
  const expectedTitles = SHOT_PROVIDER_PROMPT_SECTION_ORDER.map((id) => SECTION_TITLES[id]);
  const renderedTitles = result.text.split("\n").filter((line) => expectedTitles.includes(line));
  if (renderedTitles.length !== expectedTitles.length
    || renderedTitles.some((title, index) => title !== expectedTitles[index])) {
    return {
      code: "PROMPT_PACKAGE_INVALID",
      message: "Provider Prompt 章节标题必须固定、唯一且按合同顺序出现"
    };
  }
  return undefined;
}

/**
 * Compile one validated ShotExecutionPackage into a deterministic provider
 * prompt.  The function never contacts a provider and never mutates input.
 */
export function compileShotProviderPrompt(
  executionPackage: ShotExecutionPackage,
  options: CompileShotProviderPromptOptions = {}
): ShotProviderPromptCompileResult {
  const lineage = expectedLineage(options);
  const validation = validateShotExecutionPackage(
    executionPackage as unknown,
    packageValidationLineage(lineage, options),
    undefined
  );
  if (!validation.ok) return packageValidationIssue(executionPackage, validation);

  const semanticIssue = validatePromptPackageSemantics(executionPackage);
  if (semanticIssue) return makeError(executionPackage, semanticIssue);

  const lineageIssue = currentLineageIssue(lineage, options);
  if (lineageIssue) return makeError(executionPackage, lineageIssue);

  const fullSections = renderShotProviderPromptSectionsUnchecked(executionPackage, false);
  const fullResult = compileSuccess(executionPackage, fullSections, false);
  const renderedIssue = validateRenderedPrompt(fullResult);
  if (renderedIssue) return makeError(executionPackage, renderedIssue);

  if (options.maxChars === undefined) return fullResult;
  const maxChars = Number(options.maxChars);
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    return makeError(executionPackage, {
      code: "PROMPT_CONTEXT_TOO_LARGE",
      message: "Provider Prompt maxChars 必须是正整数"
    });
  }
  if (fullResult.text.length <= maxChars) return fullResult;

  const compactSections = renderShotProviderPromptSectionsUnchecked(executionPackage, true);
  const compactResult = compileSuccess(executionPackage, compactSections, true);
  const compactIssue = validateRenderedPrompt(compactResult);
  if (compactIssue) return makeError(executionPackage, compactIssue);
  if (compactResult.text.length <= maxChars) return compactResult;

  return makeError(executionPackage, {
    code: "PROMPT_CONTEXT_TOO_LARGE",
    message: `Provider Prompt 即使按章节和字段边界压缩后仍超过 ${maxChars} 个字符`
  });
}

export function isCompiledShotPrompt(
  result: ShotProviderPromptCompileResult
): result is CompiledShotPrompt {
  if (!(result.ok === true
    && typeof result.text === "string"
    && Array.isArray(result.sections)
    && Number.isInteger(result.assetPlanRevision)
    && /^[a-f0-9]{64}$/u.test(result.assetPlanHash)
    && result.compilerVersion === SHOT_PROVIDER_PROMPT_COMPILER_VERSION
    && /^[a-f0-9]{64}$/u.test(result.promptHash))) return false;
  const fullText = result.sections.map((section) => section.text).join("\n\n");
  const compactText = result.sections.map((section) => section.text).join("\n");
  const isFull = result.text === fullText;
  const isCompact = result.text === compactText;
  return isFull !== isCompact
    && result.promptHash === promptHashFor(result.text, isCompact)
    && validateRenderedPrompt(result) === undefined;
}
