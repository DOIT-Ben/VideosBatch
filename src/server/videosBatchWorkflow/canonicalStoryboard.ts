import { createHash } from "node:crypto";

/**
 * The storyboard contract is deliberately kept separate from the legacy
 * SeeReel Shot projection.  The handbook has three mutually exclusive field
 * layouts; a FINAL_STORYBOARD artifact must use one layout for every segment.
 */
export const CANONICAL_STORYBOARD_SCHEMA_VERSION = "2" as const;
export const CANONICAL_STORYBOARD_TYPES = ["STORY", "SCIENCE", "KNOWLEDGE"] as const;
export type CanonicalStoryboardType = (typeof CANONICAL_STORYBOARD_TYPES)[number];

export const CANONICAL_STORYBOARD_FIELD_ORDER = {
  STORY: ["sequence", "chapter", "scene", "characters", "keyProps", "duration", "visualEffects"],
  SCIENCE: ["sequence", "chapter", "scene", "subjectObjects", "supportingElements", "duration", "visualEffects"],
  KNOWLEDGE: ["sequence", "chapter", "scene", "coreImagery", "supportingElements", "duration", "visualEffects"]
} as const;

export type CanonicalStoryboardSubshot = {
  sequence: number;
  timeRange: string;
  duration: number;
  visual: string;
  action: string;
  camera: string;
  sound: string;
  voice: string;
};

export type CanonicalStoryboardReference = { label: string };
export type CanonicalStoryboardEvidence = { source: string; quote: string };

type CanonicalStoryboardSegmentBase = {
  sequence: number;
  chapter?: string;
  scene: string;
  duration: 10;
  visualEffects: CanonicalStoryboardSubshot[];
  /** Machine metadata follows the handbook fields and is never model-owned. */
  references: CanonicalStoryboardReference[];
  screenplaySceneSequence: number;
  evidence: CanonicalStoryboardEvidence[];
  nativeShotId?: string;
};

export type CanonicalStoryboardStorySegment = CanonicalStoryboardSegmentBase & {
  characters: string;
  keyProps: string;
  subjectObjects?: never;
  supportingElements?: never;
  coreImagery?: never;
};

export type CanonicalStoryboardScienceSegment = CanonicalStoryboardSegmentBase & {
  subjectObjects: string;
  supportingElements: string;
  characters?: never;
  keyProps?: never;
  coreImagery?: never;
};

export type CanonicalStoryboardKnowledgeSegment = CanonicalStoryboardSegmentBase & {
  coreImagery: string;
  supportingElements: string;
  characters?: never;
  keyProps?: never;
  subjectObjects?: never;
};

export type CanonicalStoryboardSegment =
  | CanonicalStoryboardStorySegment
  | CanonicalStoryboardScienceSegment
  | CanonicalStoryboardKnowledgeSegment;

export type CanonicalStoryboardArtifact = {
  schemaVersion: typeof CANONICAL_STORYBOARD_SCHEMA_VERSION;
  title: string;
  kind: "VIDEO_STORYBOARD";
  goal: string;
  overallScript: string;
  visualContinuity: string;
  targetDuration: number;
  aspectRatio: "16:9";
  deliveryMode: "SEGMENTED_MP4";
  format: "FINAL_10_SECOND";
  storyType: CanonicalStoryboardType;
  segments: CanonicalStoryboardSegment[];
};

const STORY_TYPE_ALIASES: ReadonlyArray<[string, CanonicalStoryboardType]> = [
  ["STORY", "STORY"], ["故事", "STORY"], ["故事类", "STORY"], ["故事叙事型", "STORY"], ["情景故事", "STORY"], ["短剧", "STORY"],
  ["SCIENCE", "SCIENCE"], ["科普", "SCIENCE"], ["科普类", "SCIENCE"], ["现象科普型", "SCIENCE"], ["科学探究故事", "SCIENCE"],
  ["KNOWLEDGE", "KNOWLEDGE"], ["知识", "KNOWLEDGE"], ["知识讲解类", "KNOWLEDGE"], ["知识由来与应用型", "KNOWLEDGE"], ["知识故事", "KNOWLEDGE"], ["数学史应用", "KNOWLEDGE"]
];

export function normalizeStoryboardType(value: unknown): CanonicalStoryboardType | undefined {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  const exact = STORY_TYPE_ALIASES.find(([alias]) => alias === text);
  if (exact) return exact[1];
  const lower = text.toLowerCase();
  return STORY_TYPE_ALIASES.find(([alias]) => alias.toLowerCase() === lower)?.[1];
}

export function canonicalRoleField(type: CanonicalStoryboardType): "characters" | "subjectObjects" | "coreImagery" {
  return type === "STORY" ? "characters" : type === "SCIENCE" ? "subjectObjects" : "coreImagery";
}

export function canonicalSupportField(type: CanonicalStoryboardType): "keyProps" | "supportingElements" {
  return type === "STORY" ? "keyProps" : "supportingElements";
}

export const SEMANTIC_REFERENCE_PATTERN = /【(?:人物|场景|道具|主体|辅助元素|核心意象)：[^】]+】/u;
export const STABLE_ASSET_ID_PATTERN = /\bP\d{3,}-A\d{3,}\b/u;
export const POSITIONAL_ASSET_REFERENCE_PATTERN = /(?:第\s*(?:\d+|[一二三四五六七八九十百]+)\s*张\s*(?:图|图片)|(?:图片|图像|参考图)\s*(?:第\s*)?(?:\d+|[一二三四五六七八九十百]+)\s*(?:张)?|(?:图|参考图)\s*(?:\d+|[一二三四五六七八九十百]+))/u;

export function semanticLabelText(value: unknown): string {
  return String(value ?? "")
    .replace(/^\s*【[^：:]+[：:]\s*/u, "")
    .replace(/】\s*$/u, "")
    .trim()
    .toLowerCase();
}

export function nonPunctuationLength(value: unknown): number {
  return Array.from(String(value ?? "").replace(/\s+/gu, "").replace(/[，。！？；：、,.!?;:]/gu, "")).length;
}

export function sentenceCount(value: unknown): number {
  return Array.from(String(value ?? "").matchAll(/[。！？!?]/gu)).length;
}

export function hasAnyText(value: unknown, terms: readonly string[]): boolean {
  const text = String(value ?? "");
  return terms.some((term) => text.includes(term));
}

export function canonicalSubshotTimeRange(subshots: readonly { duration?: number }[], index: number): string {
  const start = subshots.slice(0, index).reduce((total, item) => total + Number(item.duration || 0), 0);
  return `${start}-${start + Number(subshots[index]?.duration || 0)}秒`;
}

function sortedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortedValue(item)]));
  }
  return value;
}

export function stableJson(value: unknown): string { return JSON.stringify(sortedValue(value)); }
export function contentHash(value: unknown): string { return createHash("sha256").update(stableJson(value)).digest("hex"); }

/**
 * Hash the handbook content of a storyboard without native projection metadata.
 * `nativeShotId` is a runtime pointer and must not create a new VideosBatch
 * batch every time the same storyboard is projected into SeeReel.
 */
export function canonicalStoryboardSourceHash(raw: unknown): string {
  const normalized = normalizeStoryboardArtifact(raw);
  if (!normalized) return "";
  const value = {
    ...normalized,
    segments: normalized.segments.map((segment) => {
      const copy = { ...(segment as Record<string, unknown>) };
      delete copy.nativeShotId;
      return copy;
    })
  };
  return contentHash(value);
}

/** Stable identity for the native Shot set belonging to one storyboard revision. */
export function canonicalStoryboardBatchId(raw: unknown, sourceRevision = 0, sourceHash?: string): string {
  const hash = /^[a-f0-9]{64}$/iu.test(String(sourceHash || ""))
    ? String(sourceHash).toLowerCase()
    : canonicalStoryboardSourceHash(raw);
  if (!hash) return "";
  return `vbs-${Math.max(0, Number(sourceRevision) || 0)}-${hash.slice(0, 24)}`;
}

function asText(value: unknown, fallback = "无"): string {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function normalizeReference(value: unknown): CanonicalStoryboardReference | undefined {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  const label = asText(record?.label ?? record?.name ?? value, "");
  if (!label || STABLE_ASSET_ID_PATTERN.test(label)) return undefined;
  return { label };
}

function normalizeSubshots(segment: Record<string, unknown>): CanonicalStoryboardSubshot[] {
  const raw = Array.isArray(segment.visualEffects) ? segment.visualEffects : Array.isArray(segment.subshots) ? segment.subshots : [];
  return raw.map((value: unknown, index: number) => {
    const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
    return {
      sequence: Number(item.sequence) || index + 1,
      timeRange: asText(item.timeRange, canonicalSubshotTimeRange(raw as Array<{ duration?: number }>, index)),
      duration: Number(item.duration) || 0,
      visual: asText(item.visual),
      action: asText(item.action),
      camera: asText(item.camera),
      sound: asText(item.sound),
      voice: asText(item.voice)
    };
  });
}

/** Convert both current and legacy stored rows to the handbook-shaped object. */
export function normalizeStoryboardArtifact(raw: unknown, screenplay?: unknown): CanonicalStoryboardArtifact | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const script = screenplay && typeof screenplay === "object" ? screenplay as Record<string, unknown> : undefined;
  const storyType = normalizeStoryboardType(source.storyType ?? script?.storyType);
  if (!storyType) return undefined;
  const roleField = canonicalRoleField(storyType);
  const supportField = canonicalSupportField(storyType);
  const rawSegments = Array.isArray(source.segments) ? source.segments : [];
  const segments = rawSegments.map((value: unknown, index): CanonicalStoryboardSegment => {
    const segment = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const subshots = normalizeSubshots(segment);
    const roleFallback = storyType === "STORY" ? segment.people : storyType === "SCIENCE" ? segment.subject : segment.imagery;
    const supportFallback = storyType === "STORY" ? segment.props : segment.auxiliaryElements;
    const visualFallback = [segment.visualPrompt, segment.sceneDescription, segment.scene]
      .filter((item) => String(item ?? "").trim()).join("；");
    const references = (Array.isArray(segment.references) ? segment.references : [])
      .map(normalizeReference)
      .filter((value: CanonicalStoryboardReference | undefined): value is CanonicalStoryboardReference => Boolean(value));
    const common: Record<string, unknown> = {
      sequence: Number(segment.sequence) || index + 1,
      ...(String(segment.chapter ?? "").trim() ? { chapter: String(segment.chapter).trim() } : {}),
      scene: asText(segment.scene ?? segment.sceneDescription ?? visualFallback),
      duration: 10,
      visualEffects: subshots,
      references,
      screenplaySceneSequence: Number(segment.screenplaySceneSequence ?? segment.sceneSequence) || 1,
      evidence: Array.isArray(segment.evidence) ? segment.evidence : []
    };
    common[roleField] = asText(segment[roleField] ?? roleFallback);
    common[supportField] = asText(segment[supportField] ?? supportFallback);
    if (typeof segment.nativeShotId === "string" && segment.nativeShotId.trim()) common.nativeShotId = segment.nativeShotId.trim();
    return common as CanonicalStoryboardSegment;
  });
  return {
    schemaVersion: CANONICAL_STORYBOARD_SCHEMA_VERSION,
    title: asText(source.title, "最终十秒分镜"),
    kind: "VIDEO_STORYBOARD",
    goal: asText(source.goal),
    overallScript: asText(source.overallScript),
    visualContinuity: asText(source.visualContinuity),
    targetDuration: Number(source.targetDuration ?? source.targetDurationSeconds) || 0,
    aspectRatio: "16:9",
    deliveryMode: "SEGMENTED_MP4",
    format: "FINAL_10_SECOND",
    storyType,
    segments
  };
}

export function segmentVisualText(segment: unknown, type?: CanonicalStoryboardType): string {
  const value = segment && typeof segment === "object" ? segment as Record<string, unknown> : {};
  const resolved = type || normalizeStoryboardType(value.storyType) || "STORY";
  const role = canonicalRoleField(resolved);
  const support = canonicalSupportField(resolved);
  const effects = Array.isArray(value.visualEffects) ? value.visualEffects : Array.isArray(value.subshots) ? value.subshots : [];
  return [value.scene, value[role], value[support], ...effects.map((item) => {
    const sub = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return [sub.timeRange, sub.visual, sub.action, sub.camera].filter(Boolean).join(" ");
  })].filter((item) => String(item ?? "").trim()).join("\n");
}

export function segmentVoiceText(segment: unknown): string {
  const value = segment && typeof segment === "object" ? segment as Record<string, unknown> : {};
  const effects = Array.isArray(value.visualEffects) ? value.visualEffects : Array.isArray(value.subshots) ? value.subshots : [];
  const voices = effects.map((item) => item && typeof item === "object" ? String((item as Record<string, unknown>).voice ?? "").trim() : "").filter(Boolean);
  return [...new Set(voices)].join("\n");
}

export function segmentSoundText(segment: unknown): string {
  const value = segment && typeof segment === "object" ? segment as Record<string, unknown> : {};
  const effects = Array.isArray(value.visualEffects) ? value.visualEffects : Array.isArray(value.subshots) ? value.subshots : [];
  return effects.map((item) => item && typeof item === "object" ? String((item as Record<string, unknown>).sound ?? "").trim() : "").filter(Boolean).join("；");
}

/** Compatibility-only projection for older clients; canonical storage never uses these keys. */
export function canonicalSegmentToLegacyProjection(segment: unknown, type?: CanonicalStoryboardType) {
  const value = segment && typeof segment === "object" ? segment as Record<string, unknown> : {};
  const resolved = type || normalizeStoryboardType(value.storyType) || "STORY";
  const effects = Array.isArray(value.visualEffects) ? value.visualEffects : Array.isArray(value.subshots) ? value.subshots : [];
  return {
    sequence: Number(value.sequence) || 1,
    screenplaySceneSequence: Number(value.screenplaySceneSequence) || 1,
    duration: 10,
    visualPrompt: segmentVisualText(value, resolved),
    narration: segmentVoiceText(value),
    subtitles: segmentVoiceText(value),
    teachingPurpose: asText(value.teachingPurpose),
    transition: asText(value.transition),
    evidence: Array.isArray(value.evidence) ? value.evidence : [],
    references: Array.isArray(value.references) ? value.references : [],
    subshots: effects.map((item, index) => {
      const sub = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return { sequence: Number(sub.sequence) || index + 1, duration: Number(sub.duration) || 0, visual: asText(sub.visual), action: asText(sub.action), camera: asText(sub.camera), sound: asText(sub.sound), voice: asText(sub.voice) };
    })
  };
}

function subshotSchema(): Record<string, unknown> {
  return {
    type: "object", additionalProperties: false,
    properties: {
      sequence: { type: "integer", minimum: 1, maximum: 5 },
      timeRange: { type: "string", minLength: 3 },
      duration: { type: "integer", minimum: 1, maximum: 8 },
      visual: { type: "string", minLength: 1 }, action: { type: "string", minLength: 1 },
      camera: { type: "string", minLength: 1 }, sound: { type: "string", minLength: 1 }, voice: { type: "string", minLength: 1 }
    },
    required: ["sequence", "timeRange", "duration", "visual", "action", "camera", "sound", "voice"]
  };
}

function referenceSchema(): Record<string, unknown> {
  return { type: "object", additionalProperties: false, properties: { label: { type: "string", minLength: 1 } }, required: ["label"] };
}

function evidenceSchema(): Record<string, unknown> {
  return { type: "object", additionalProperties: false, properties: { source: { type: "string" }, quote: { type: "string" } }, required: ["source", "quote"] };
}

/** JSON Schema for one handbook-specific segment layout. */
export function canonicalSegmentSchema(type: CanonicalStoryboardType): Record<string, unknown> {
  const role = canonicalRoleField(type);
  const support = canonicalSupportField(type);
  const properties: Record<string, unknown> = {
    sequence: { type: "integer", minimum: 1, maximum: 15 },
    chapter: { type: "string", minLength: 1 },
    scene: { type: "string", minLength: 1 },
    [role]: { type: "string", minLength: 1 },
    [support]: { type: "string", minLength: 1 },
    duration: { type: "integer", const: 10 },
    visualEffects: { type: "array", minItems: 3, maxItems: 5, items: subshotSchema() },
    references: { type: "array", maxItems: 7, items: referenceSchema() },
    screenplaySceneSequence: { type: "integer", minimum: 1, maximum: 48 },
    evidence: { type: "array", items: evidenceSchema() }
  };
  return {
    type: "object", additionalProperties: false, properties,
    required: ["sequence", "scene", role, support, "duration", "visualEffects", "references", "screenplaySceneSequence", "evidence"]
  };
}

export function canonicalStoryboardSegmentsSchema(): Record<string, unknown> {
  return { type: "array", minItems: 9, maxItems: 15, items: { oneOf: CANONICAL_STORYBOARD_TYPES.map(canonicalSegmentSchema) } };
}

/** Human-readable handbook projection used by the copyable derived artifact. */
export function renderCanonicalSegmentText(segment: unknown, type: CanonicalStoryboardType): string {
  const value = segment as Record<string, unknown>;
  const role = canonicalRoleField(type);
  const support = canonicalSupportField(type);
  const roleLabel = type === "STORY" ? "人物" : type === "SCIENCE" ? "主体对象" : "核心意象";
  const supportLabel = type === "STORY" ? "关键道具" : "辅助元素";
  const effects = Array.isArray(value.visualEffects) ? value.visualEffects : [];
  const effectText = effects.map((item) => {
    const sub = item as Record<string, unknown>;
    return `${sub.timeRange}：${sub.visual}；动作：${sub.action}；镜头：${sub.camera}；音效：${sub.sound}；旁白/台词：${sub.voice}`;
  }).join("\n");
  return [
    value.chapter ? `章节：${value.chapter}` : undefined,
    `序号：${value.sequence}`,
    `场景画面：${value.scene}`,
    `${roleLabel}：${value[role]}`,
    `${supportLabel}：${value[support]}`,
    "时长：10秒",
    "画面效果：",
    effectText
  ].filter(Boolean).join("\n");
}

export function renderCanonicalStoryboardText(artifact: CanonicalStoryboardArtifact): string {
  return artifact.segments.map((segment) => renderCanonicalSegmentText(segment, artifact.storyType)).join("\n\n");
}
