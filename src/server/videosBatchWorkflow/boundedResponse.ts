export class ResponseBodyLimitError extends Error {
  constructor() {
    super("Response body exceeds the configured byte limit");
    this.name = "ResponseBodyLimitError";
  }
}

/**
 * Bound application buffering by actual decoded body bytes, never by a trusted header.
 *
 * Mirrors FrameFlow's `src/lib/http/bounded-response.ts` so both workstations fail the
 * same way when a provider streams more than we are willing to hold. `arrayBuffer()`
 * forces the whole payload into memory before the size check, which is exactly the
 * failure this replaces.
 */
export async function readBoundedResponseBytes(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError("Invalid response byte limit");
  const cancelBody = () => { void response.body?.cancel().catch(() => {}); };
  const reason = () => signal?.reason ?? new DOMException("Response read aborted", "AbortError");
  if (signal?.aborted) { cancelBody(); throw reason(); }
  const declared = response.headers.get("content-length")?.trim();
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    cancelBody();
    throw new ResponseBodyLimitError();
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  let bytes = new Uint8Array(0);
  let total = 0;
  let rejectRead: ((reason: unknown) => void) | undefined;
  const onAbort = () => {
    rejectRead?.(reason());
    // A custom source's cancel promise may never settle; do not await it.
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw reason();
      const chunk = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
        rejectRead = reject;
        void reader.read().then(resolve, reject);
      });
      rejectRead = undefined;
      if (signal?.aborted) throw reason();
      if (chunk.done) break;
      if (chunk.value.byteLength > maxBytes - total) throw new ResponseBodyLimitError();
      const required = total + chunk.value.byteLength;
      if (required > bytes.byteLength) {
        const expanded = new Uint8Array(Math.min(maxBytes, Math.max(required, bytes.byteLength * 2, 8192)));
        expanded.set(bytes.subarray(0, total));
        bytes = expanded;
      }
      // Copy accepted bytes; do not retain upstream backing buffers or one entry per tiny chunk.
      bytes.set(chunk.value, total);
      total = required;
    }
    return bytes.slice(0, total);
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
