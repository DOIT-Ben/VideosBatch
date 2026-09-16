import { createHash } from "node:crypto";

/**
 * Integrity layer for the paid generation snapshot, ported from FrameFlow's
 * `src/lib/generation-execution-snapshot.ts`.
 *
 * FrameFlow's contract has three parts the VideosBatch execution package did not
 * have: a *strict* canonical JSON form (so the hash provably covers every field),
 * a payload hash that is recomputed on read, and an adapter capability gate so a
 * task produced by an adapter version that is no longer shipped is refused
 * instead of being polled into an unknown charge.
 *
 * This module is deliberately standalone. The older `canonicalStoryboard.stableJson`
 * projects through `JSON.stringify`, which silently drops `undefined` members and
 * turns non-finite numbers into `null`; that is fine for a repeatable content hash
 * but it cannot prove the hash covers what was submitted. Reusing it here would
 * also change every already-pinned package hash, so the two live side by side:
 * `stableJson` for lineage content hashes, this module for the paid snapshot.
 */

export const VIDEOSBATCH_EXECUTION_SNAPSHOT_SCHEMA_VERSION = 1;

export type VideosBatchCreationMode =
  | "text_to_video"
  | "single_reference_to_video"
  | "multi_reference_to_video";

/** One (adapter, version) capability row. Mirrors FrameFlow's capability matrix. */
export interface VideosBatchAdapterCapability {
  adapterKey: string;
  adapterVersion: string;
  /** Runtime model ids this adapter version may submit. */
  runtimeModelIds: readonly string[];
  creationMode: VideosBatchCreationMode;
  minReferences: number;
  maxReferences: number;
}

export const VIDEOSBATCH_ADAPTER_CAPABILITY_MATRIX: readonly VideosBatchAdapterCapability[] = [
  {
    adapterKey: "newapi-h3",
    adapterVersion: "1.0.0",
    runtimeModelIds: ["minimax_h3"],
    creationMode: "multi_reference_to_video",
    minReferences: 2,
    maxReferences: 9
  }
];

export type VideosBatchExecutionSnapshotFailureCode =
  | "EXECUTION_SNAPSHOT_INTEGRITY_FAILED"
  | "GENERATION_ADAPTER_VERSION_UNAVAILABLE";

export class VideosBatchExecutionSnapshotError extends Error {
  constructor(
    readonly code: VideosBatchExecutionSnapshotFailureCode,
    message: string
  ) {
    super(message);
    this.name = "VideosBatchExecutionSnapshotError";
  }
}

function integrityFailure(message: string): VideosBatchExecutionSnapshotError {
  return new VideosBatchExecutionSnapshotError("EXECUTION_SNAPSHOT_INTEGRITY_FAILED", message);
}

/**
 * Canonical JSON: object keys sorted at every depth, arrays mapped, and every
 * non-JSON value (`undefined`, non-finite numbers, functions, symbols) rejected
 * with a hard error instead of being dropped or coerced. A lossy projection would
 * mean the hash does not actually cover the payload it claims to describe.
 */
function normalizedJsonValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("执行快照只允许有限 JSON 数字");
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizedJsonValue);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] === undefined) throw new TypeError("执行快照不允许 undefined");
      normalized[key] = normalizedJsonValue(record[key]);
    }
    return normalized;
  }
  throw new TypeError("执行快照只允许 JSON 值");
}

export function canonicalExecutionJson(value: unknown): string {
  return JSON.stringify(normalizedJsonValue(value));
}

export function executionPayloadSha256(payloadJson: string): string {
  return createHash("sha256").update(payloadJson, "utf8").digest("hex");
}

/** Canonicalize a paid-snapshot payload and derive its hash in one step. */
export function serializeVideosBatchExecutionSnapshot(payload: unknown): { payloadJson: string; payloadSha256: string } {
  const payloadJson = canonicalExecutionJson(payload);
  return { payloadJson, payloadSha256: executionPayloadSha256(payloadJson) };
}

const registeredAdapters = new Set(
  VIDEOSBATCH_ADAPTER_CAPABILITY_MATRIX.map((row) => `${row.adapterKey}:${row.adapterVersion}`)
);

export function assertVideosBatchAdapterAvailable(adapterKey: string, adapterVersion: string): void {
  if (!registeredAdapters.has(`${adapterKey}:${adapterVersion}`)) {
    throw new VideosBatchExecutionSnapshotError(
      "GENERATION_ADAPTER_VERSION_UNAVAILABLE",
      "任务所需的生成适配器版本不可用"
    );
  }
}

/**
 * The capability row that actually authorises this submission, or `undefined`.
 * Callers must treat `undefined` as "cannot pay": either the adapter version is
 * gone, or it does not (any longer) support this model, creation mode or
 * reference count.
 */
export function videosBatchAdapterCapability(
  adapterKey: string,
  adapterVersion: string,
  runtimeModelId: string,
  creationMode: VideosBatchCreationMode,
  referenceCount: number
): VideosBatchAdapterCapability | undefined {
  return VIDEOSBATCH_ADAPTER_CAPABILITY_MATRIX.find((row) => (
    row.adapterKey === adapterKey
    && row.adapterVersion === adapterVersion
    && row.runtimeModelIds.includes(runtimeModelId)
    && row.creationMode === creationMode
    && referenceCount >= row.minReferences
    && referenceCount <= row.maxReferences
  ));
}

export function assertVideosBatchAdapterSupports(
  adapterKey: string,
  adapterVersion: string,
  runtimeModelId: string,
  creationMode: VideosBatchCreationMode,
  referenceCount: number
): VideosBatchAdapterCapability {
  const capability = videosBatchAdapterCapability(
    adapterKey, adapterVersion, runtimeModelId, creationMode, referenceCount
  );
  if (!capability) {
    throw new VideosBatchExecutionSnapshotError(
      "GENERATION_ADAPTER_VERSION_UNAVAILABLE",
      "任务所需的生成适配器不支持当前模型、创作模式或参考图数量"
    );
  }
  return capability;
}

export interface VideosBatchExecutionSnapshotRecord {
  payloadJson: string;
  payloadSha256: string;
  adapterKey: string;
  adapterVersion: string;
}

/**
 * Read side. Recomputes the hash, refuses a payload that is not in canonical form,
 * and refuses an adapter version that is no longer in the matrix — so a resumed
 * poll can never run against a task this build cannot reason about.
 */
export function parseVideosBatchExecutionSnapshot(
  input: Readonly<VideosBatchExecutionSnapshotRecord>
): Record<string, unknown> {
  if (executionPayloadSha256(input.payloadJson) !== input.payloadSha256) {
    throw integrityFailure("生成执行快照完整性校验失败");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(input.payloadJson);
  } catch {
    throw integrityFailure("生成执行快照不是合法 JSON");
  }
  if (canonicalExecutionJson(decoded) !== input.payloadJson) {
    throw integrityFailure("生成执行快照合同不合法");
  }
  assertVideosBatchAdapterAvailable(input.adapterKey, input.adapterVersion);
  return decoded as Record<string, unknown>;
}
