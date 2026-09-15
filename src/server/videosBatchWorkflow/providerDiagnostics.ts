/**
 * Redaction for provider-facing diagnostic text before it is persisted.
 *
 * Mirrors FrameFlow's `safeProviderDiagnosticMessage` (`generations/runtime/response-metadata.ts`):
 * an H3 error body is written by the provider and its request is echoed back through
 * several layers, so the raw text can carry a `Bearer` token, an `api_key`, an inline
 * base64 reference image, or a **signed reference-image URL**. Persisting any of those
 * into `Shot.error` / `videosBatchError.message` turns a transient diagnostic into
 * long-lived storage of a credential or a signed address — the same hazard §7.7
 * already forbids for request logs.
 *
 * Centralised here so the media stage, the workflow API and the LLM executor cannot
 * drift into three slightly different redaction sets.
 */

/** Matches inline `data:` media payloads, base64 or otherwise. */
const INLINE_DATA_PATTERN = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*,[^\s"'<>]+/giu;
/** Any absolute http(s) URL, including signed ones with query strings. */
const ABSOLUTE_URL_PATTERN = /https?:\/\/[^\s"'<>]+/giu;
const BEARER_PATTERN = /Bearer\s+[^\s]+/giu;
const CREDENTIAL_PATTERN = /(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^,\s}]+/giu;

/** Budget for a persisted diagnostic message. Long enough to diagnose, short enough to store. */
export const MAX_PROVIDER_DIAGNOSTIC_LENGTH = 2_000;

/**
 * Strip credentials, inline media payloads and all URLs from provider text, then bound
 * the result. Idempotent: sanitizing already-sanitized text returns it unchanged, so a
 * caller can safely apply it at more than one layer.
 */
export function sanitizeProviderDiagnosticText(
  value: unknown,
  maxLength: number = MAX_PROVIDER_DIAGNOSTIC_LENGTH
): string {
  const raw = typeof value === "string" ? value : value instanceof Error ? value.message : "";
  if (!raw) return "";
  const redacted = raw
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(CREDENTIAL_PATTERN, "$1=[redacted]")
    .replace(INLINE_DATA_PATTERN, "data:[redacted]")
    .replace(ABSOLUTE_URL_PATTERN, "[url redacted]")
    .trim();
  return maxLength > 0 ? redacted.slice(0, maxLength) : redacted;
}
