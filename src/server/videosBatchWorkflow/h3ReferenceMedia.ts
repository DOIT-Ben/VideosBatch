import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { readBoundedResponseBytes, ResponseBodyLimitError } from "./boundedResponse";
import { h3ResponseMetadata, NewApiH3ProviderError } from "./h3ProviderErrors";

/**
 * Reference-image materialization for the NewAPI H3 multi-reference workflow.
 *
 * Mirrors FrameFlow's `src/lib/providers/newapi-h3-dedicated/reference-media.ts`:
 * one per-fetch timeout independent of the long job budget, bounded buffering,
 * no shared caches, and an HTTPS-only URL contract that refuses embedded
 * credentials. The previous implementation read `arrayBuffer()` unbounded behind
 * the 45-minute job timer, so a single stalled or oversized reference could
 * consume the whole shot budget or the process heap.
 */

/** Per-fetch budget. The surrounding job timeout must not be the only bound. */
export const H3_REFERENCE_FETCH_TIMEOUT_MS = 30_000;

/** Fetches in flight at once. H3 accepts 2-9 references; two keeps the provider calm. */
export const H3_REFERENCE_FETCH_CONCURRENCY = 2;

export const H3_MAX_REFERENCE_BYTES = 20 * 1024 * 1024;

const MIME_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp"
};

const EXTENSION_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

export interface H3ReferenceFile {
  file: File;
  /** Exact bytes submitted to the provider, content-addressed. */
  byteSize: number;
  bytesSha256: string;
  mimeType: string;
}

function referenceError(message: string): NewApiH3ProviderError {
  // Every branch here fails before any paid request; the run is provably uncharged.
  return new NewApiH3ProviderError(message, "INVALID_REFERENCE_IMAGE", false, 422, undefined, {
    billingResult: "NOT_CHARGED"
  });
}

function referenceBytes(bytes: Uint8Array, ordinal: number, mimeType: string): H3ReferenceFile {
  if (!bytes.length) throw referenceError("NewAPI H3 参考图内容为空");
  if (bytes.length > H3_MAX_REFERENCE_BYTES) throw referenceError("NewAPI H3 参考图不能超过 20MB");
  const extension = MIME_EXTENSION[mimeType] || "jpg";
  return {
    file: new File([new Uint8Array(bytes)], `reference-${ordinal}.${extension}`, { type: mimeType }),
    byteSize: bytes.length,
    bytesSha256: createHash("sha256").update(bytes).digest("hex"),
    mimeType
  };
}

async function localMediaFile(url: string, ordinal: number): Promise<H3ReferenceFile> {
  const mediaRoot = path.resolve(process.cwd(), "data", "media");
  const relative = decodeURIComponent(url.slice("/media/".length));
  const localPath = path.resolve(mediaRoot, relative);
  if (!relative || (localPath !== mediaRoot && !localPath.startsWith(`${mediaRoot}${path.sep}`))) {
    throw referenceError("NewAPI H3 本地参考图路径不合法");
  }
  const extension = path.extname(localPath).toLowerCase();
  const mimeType = EXTENSION_MIME[extension];
  if (!mimeType) throw referenceError("NewAPI H3 本地参考图必须是 PNG/JPEG/WebP");
  // Check the on-disk size before reading so an oversized file never enters memory.
  const info = await stat(localPath).catch(() => undefined);
  if (!info?.isFile()) throw referenceError("NewAPI H3 本地参考图不可读取");
  if (info.size > H3_MAX_REFERENCE_BYTES) throw referenceError("NewAPI H3 参考图不能超过 20MB");
  return referenceBytes(new Uint8Array(await readFile(localPath)), ordinal, mimeType);
}

function httpsReferenceUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw referenceError("NewAPI H3 参考图地址必须是 HTTPS 图片地址");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw referenceError("NewAPI H3 参考图地址必须是 HTTPS 图片地址");
  }
  return url;
}

async function remoteMediaFile(value: string, ordinal: number, signal?: AbortSignal): Promise<H3ReferenceFile> {
  const url = httpsReferenceUrl(value);
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(H3_REFERENCE_FETCH_TIMEOUT_MS)])
    : AbortSignal.timeout(H3_REFERENCE_FETCH_TIMEOUT_MS);
  const timedOut = () => requestSignal.reason instanceof Error && requestSignal.reason.name === "TimeoutError";
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "image/png,image/jpeg,image/webp" },
      signal: requestSignal,
      cache: "no-store"
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw referenceError(timedOut() ? "NewAPI H3 参考图读取超时" : "NewAPI H3 参考图读取失败");
  }
  if (!response.ok) {
    const bodySummary = await response.text().catch(() => "").then((text) => text.slice(0, 300));
    await response.body?.cancel().catch(() => {});
    throw new NewApiH3ProviderError(
      `NewAPI H3 参考图读取失败（HTTP ${response.status}）`,
      "INVALID_REFERENCE_IMAGE",
      false,
      response.status,
      undefined,
      { billingResult: "NOT_CHARGED", responseMetadata: h3ResponseMetadata(response, bodySummary) }
    );
  }
  const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  const mimeType = contentType === "image/jpg" ? "image/jpeg" : contentType;
  if (!MIME_EXTENSION[mimeType]) {
    await response.body?.cancel().catch(() => {});
    throw referenceError("NewAPI H3 参考图必须是 PNG/JPEG/WebP");
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedResponseBytes(response, H3_MAX_REFERENCE_BYTES, requestSignal);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw referenceError(
      error instanceof ResponseBodyLimitError ? "NewAPI H3 参考图不能超过 20MB" : "NewAPI H3 参考图读取失败"
    );
  }
  return referenceBytes(bytes, ordinal, mimeType);
}

export async function h3ReferenceFile(value: string, ordinal: number, signal?: AbortSignal): Promise<H3ReferenceFile> {
  return value.startsWith("/media/")
    ? localMediaFile(value, ordinal)
    : remoteMediaFile(value, ordinal, signal);
}
