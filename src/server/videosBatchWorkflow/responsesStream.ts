/** Bounded Responses SSE reader. Only terminal response.completed is success. */
export class ResponsesStreamError extends Error {
  constructor(readonly code: string, readonly partialText: string) { super(code); }
}

export async function readResponsesStream(response: Response, onText?: () => void): Promise<any> {
  if (!response.body) throw new ResponsesStreamError("EMPTY_STREAM", "");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", data: string[] = [], text = "", bytes = 0;
  let terminal: any;
  const fail = (code: string): never => { throw new ResponsesStreamError(code, text); };
  const dispatch = () => {
    if (!data.length) return;
    const raw = data.join("\n"); data = [];
    if (raw === "[DONE]") return;
    let event: any;
    try { event = JSON.parse(raw); } catch { return fail("INVALID_STREAM_EVENT"); }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      text += event.delta;
      onText?.();
    }
    if (event.type === "error" || event.type === "response.failed") fail("STREAM_PROVIDER_ERROR");
    if (event.type === "response.incomplete") fail("INCOMPLETE_STRUCTURED_OUTPUT");
    if (event.type === "response.completed") {
      if (!event.response || event.response.status !== "completed") fail("INCOMPLETE_STRUCTURED_OUTPUT");
      terminal = event.response;
    }
  };
  const line = (value: string) => {
    if (!value) dispatch();
    else if (value.startsWith("data:")) data.push(value.slice(5).replace(/^ /, ""));
  };
  try {
    while (!terminal) {
      const chunk = await reader.read();
      if (chunk.done) {
        buffer += decoder.decode();
        for (const finalLine of buffer.split(/\r\n|\r|\n/)) {
          if (terminal) break;
          line(finalLine);
        }
        if (!terminal) dispatch();
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > 16_000_000) fail("STREAM_SIZE_LIMIT");
      buffer += decoder.decode(chunk.value, { stream: true });
      while (!terminal) {
        const end = buffer.search(/[\r\n]/);
        if (end < 0 || (buffer[end] === "\r" && end === buffer.length - 1)) break;
        const width = buffer[end] === "\r" && buffer[end + 1] === "\n" ? 2 : 1;
        line(buffer.slice(0, end));
        buffer = buffer.slice(end + width);
      }
    }
    if (!terminal) fail("STREAM_INTERRUPTED");
    // The terminal response is authoritative. Use accumulated deltas only when
    // compatible gateways omit final output, never duplicate the same text.
    return { ...terminal, ...(!terminal.output_text && !terminal.output?.length ? { output_text: text } : {}) };
  } catch (error) {
    if (error instanceof ResponsesStreamError) throw error;
    throw new ResponsesStreamError(error instanceof Error && error.name === "AbortError" ? "TIMEOUT" : "STREAM_INTERRUPTED", text);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
