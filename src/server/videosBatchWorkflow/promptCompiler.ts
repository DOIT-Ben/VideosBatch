import { validateShotExecutionPackage } from "./shotExecutionPackage";
import type {
  ShotExecutionAudioIntentEvent,
  ShotExecutionEffect,
  ShotExecutionPackage,
  ShotExecutionPackageLineage,
  ShotExecutionReference,
  ShotExecutionStoryType
} from "../../shared/videosBatchWorkflow";

export const SHOT_PROVIDER_PROMPT_SCHEMA_VERSION = "1" as const;

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

export type ShotProviderPromptSectionId = (typeof SHOT_PROVIDER_PROMPT_SECTION_ORDER)[number];

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

const SUPPORT_LABELS: Record<ShotExecutionStoryType, "道具" | "辅助元素"> = {
  STORY: "道具",
  SCIENCE: "辅助元素",
  KNOWLEDGE: "辅助元素"
};

const SEMANTIC_TAG_PATTERN = /^【(人物|场景|道具|主体|辅助元素|核心意象)[：:]\s*(.+?)】$/u;
const POSITION_REFERENCE_PATTERN = /(?:第\s*(?:\d+|[一二三四五六七八九十百千]+)\s*(?:张|个)?\s*(?:图|图片|参考图)|(?:参考图|图片|图像|图)\s*#?\s*(?:\d+|[一二三四五六七八九十百千]+)|image\s*#?\s*\d+)/iu;
const STABLE_PUBLIC_ASSET_ID_PATTERN = /\bP\d{3,}-A\d{3,}\b/iu;
const URL_PATTERN = /https?:\/\//iu;
const MEDIA_PATH_PATTERN = /\/media\//iu;
const WINDOWS_PATH_PATTERN = /\b[A-Z]:[\\/]/iu;
const UNC_PATH_PATTERN = /\\\\[A-Za-z0-9._-]+[\\/]/u;
const POSIX_PATH_PATTERN = /(?:^|[\s(])\/(?:Users|user|home|tmp|var|mnt|workspace|data|private|opt|srv|media)(?:[\\/]|$)/iu;
const INTERNAL_IDENTIFIER_PATTERN = /\b(?:assetId|shotId|taskId)\s*[:=]\s*[^\s,;，。；]+|\b(?:asset|shot|task)_[A-Za-z0-9][A-Za-z0-9_-]*/iu;
const EVENT_INTERNAL_IDENTIFIER_PATTERN = /\b(?:asset|shot|task)_[A-Za-z0-9][A-Za-z0-9_-]*|\b(?:assetId|shotId|taskId)\b/iu;

export interface CompiledShotPromptSection {
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
  contentHash: string;
  text: string;
  sections: readonly CompiledShotPromptSection[];
}

export const PROMPT_COMPILER_ERROR_CODES = [
  "PROMPT_PACKAGE_INVALID",
  "PROMPT_PACKAGE_LINEAGE_STALE",
  "PROMPT_FIELD_MISSING",
  "PROMPT_REFERENCE_INVALID",
  "PROMPT_FORBIDDEN_IDENTIFIER",
  "PROMPT_CONTEXT_TOO_LARGE"
] as const;

export type PromptCompilerErrorCode = (typeof PROMPT_COMPILER_ERROR_CODES)[number];

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

export interface CompileShotProviderPromptOptions {
  maxChars?: number;
  /** Current FINAL_STORYBOARD lineage, when the caller has it available. */
  current?: ShotExecutionPackageLineage | number;
  currentHash?: string;
  expectedLineage?: ShotExecutionPackageLineage | number;
  expectedSourceRevision?: number;
  expectedSourceHash?: string;
}

type AnyRecord = Record<string, unknown>;

type ValidationIssue = {
  code: PromptCompilerErrorCode;
  message: string;
  retryable?: boolean;
};

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

function display(value: unknown): string {
  if (value === null || value === undefined) return "无";
  return normalizeLineEndings(String(value));
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

function expectedLineage(options: CompileShotProviderPromptOptions): {
  current?: ShotExecutionPackageLineage | number;
  currentHash?: string;
} {
  const current = options.expectedLineage ?? options.current;
  const sourceRevision = options.expectedSourceRevision;
  const sourceHash = options.expectedSourceHash ?? options.currentHash;

  if (current !== undefined) {
    return {
      current: sourceRevision === undefined && sourceHash === undefined
        ? current
        : {
          ...(typeof current === "number" ? { sourceRevision: current } : current),
          ...(sourceRevision !== undefined ? { sourceRevision } : {}),
          ...(sourceHash !== undefined ? { sourceHash } : {})
        },
      currentHash: typeof current === "number" ? sourceHash : undefined
    };
  }

  if (sourceRevision !== undefined || sourceHash !== undefined) {
    return {
      current: {
        ...(sourceRevision !== undefined ? { sourceRevision } : {}),
        ...(sourceHash !== undefined ? { sourceHash } : {})
      }
    };
  }

  return {};
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

function hasForbiddenTransportOrIdentifier(value: string): boolean {
  return STABLE_PUBLIC_ASSET_ID_PATTERN.test(value)
    || URL_PATTERN.test(value)
    || MEDIA_PATH_PATTERN.test(value)
    || WINDOWS_PATH_PATTERN.test(value)
    || UNC_PATH_PATTERN.test(value)
    || POSIX_PATH_PATTERN.test(value)
    || INTERNAL_IDENTIFIER_PATTERN.test(value);
}

function isPositionReference(value: string): boolean {
  return POSITION_REFERENCE_PATTERN.test(value);
}

function userFacingPackageTexts(executionPackage: ShotExecutionPackage): string[] {
  const texts = [
    executionPackage.shot.chapter,
    executionPackage.teaching.goal,
    executionPackage.teaching.knowledgeFocus,
    executionPackage.visual.scene,
    executionPackage.visual.role,
    executionPackage.visual.support,
    executionPackage.visual.globalContinuity,
    ...executionPackage.teaching.evidence.flatMap((entry) => [entry.source, entry.quote]),
    ...executionPackage.visual.effects.flatMap((effect) => [effect.timeRange, effect.visual, effect.action, effect.camera]),
    ...executionPackage.audioIntent.voices.map((event) => event.text),
    ...executionPackage.audioIntent.sounds.map((event) => event.text),
    ...executionPackage.references.flatMap((reference) => [reference.semanticLabel, reference.assetKey])
  ];
  return texts.filter((value): value is string => typeof value === "string");
}

function referenceSemanticText(reference: ShotExecutionReference): { text?: string; issue?: ValidationIssue } {
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
  if (raw.startsWith("【") || raw.endsWith("】")) {
    if (!tagged) {
      return {
        issue: {
          code: "PROMPT_REFERENCE_INVALID",
          message: "参考图 semanticLabel 的语义标签格式无效"
        }
      };
    }
    return { text: tagged[2].trim() };
  }
  return { text: raw };
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
    const semantic = referenceSemanticText(reference);
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
    [`${prefix}.id`, event.id],
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
    const semantic = referenceSemanticText(reference).text || "";
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

/** Render an already validated package without reading any external state. */
export function renderShotProviderPromptSections(
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

export const renderProviderPromptSections = renderShotProviderPromptSections;

function joinSections(sections: readonly CompiledShotPromptSection[], compact: boolean): string {
  return sections.map((item) => item.text).join(compact ? "\n" : "\n\n");
}

function compileSuccess(
  executionPackage: ShotExecutionPackage,
  sections: readonly CompiledShotPromptSection[],
  compact: boolean
): CompiledShotPrompt {
  return {
    ok: true,
    schemaVersion: SHOT_PROVIDER_PROMPT_SCHEMA_VERSION,
    sourceStageId: executionPackage.sourceStageId,
    sourceRevision: executionPackage.sourceRevision,
    sourceHash: executionPackage.sourceHash,
    contentHash: executionPackage.contentHash,
    text: joinSections(sections, compact),
    sections
  };
}

function validateRenderedPrompt(result: CompiledShotPrompt): ValidationIssue | undefined {
  if (/\r/u.test(result.text) || result.sections.some((section) => /\r/u.test(section.text))) {
    return {
      code: "PROMPT_PACKAGE_INVALID",
      message: "Provider Prompt 换行必须统一为 LF"
    };
  }
  if (STABLE_PUBLIC_ASSET_ID_PATTERN.test(result.text)
    || URL_PATTERN.test(result.text)
    || MEDIA_PATH_PATTERN.test(result.text)
    || WINDOWS_PATH_PATTERN.test(result.text)
    || UNC_PATH_PATTERN.test(result.text)
    || POSIX_PATH_PATTERN.test(result.text)
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
    lineage.current,
    lineage.currentHash
  );
  if (!validation.ok) return packageValidationIssue(executionPackage, validation);

  const semanticIssue = validatePromptPackageSemantics(executionPackage);
  if (semanticIssue) return makeError(executionPackage, semanticIssue);

  const fullSections = renderShotProviderPromptSections(executionPackage, false);
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

  const compactSections = renderShotProviderPromptSections(executionPackage, true);
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
  return result.ok === true && typeof result.text === "string" && Array.isArray(result.sections);
}

export function isPromptCompilerError(
  result: ShotProviderPromptCompileResult
): result is PromptCompilerError {
  return result.ok === false && typeof result.code === "string";
}
