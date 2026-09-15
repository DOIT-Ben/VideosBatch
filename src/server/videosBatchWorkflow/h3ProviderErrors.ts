/**
 * Provider-facing error contract for the VideosBatch NewAPI H3 adapter.
 *
 * Mirrors FrameFlow's `src/lib/providers/contracts.ts` + `ProviderApiError` shape: every
 * failure that can reach a paid submission carries an HTTP status, a stable code, a
 * retry verdict, and an explicit billing conclusion. Without the billing conclusion a
 * caller cannot tell "nothing was charged, safe to retry" from "a paid task may be
 * running, stop and reconcile" — which is the failure this module exists to prevent.
 *
 * Kept in its own module so the reference-media fetcher can throw the same error type
 * without importing the orchestrator (which imports the fetcher).
 */
export type H3BillingResult = "NOT_CHARGED" | "CHARGED" | "UNKNOWN";

export interface H3ResponseMetadata {
  status: number;
  headers: Record<string, string>;
  bodySummary: string | null;
}

/** Diagnostic headers only; never echo arbitrary provider headers into persisted records. */
const DIAGNOSTIC_HEADERS = [
  "content-type",
  "retry-after",
  "request-id",
  "x-request-id",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset"
] as const;

export function h3ResponseMetadata(response: Response, bodySummary: string | null): H3ResponseMetadata {
  const headers: Record<string, string> = {};
  for (const name of DIAGNOSTIC_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers[name] = value.slice(0, 200);
  }
  return {
    status: response.status,
    headers,
    bodySummary: bodySummary ? bodySummary.slice(0, 300) : null
  };
}

export interface NewApiH3ProviderErrorOptions {
  billingResult?: H3BillingResult;
  responseMetadata?: H3ResponseMetadata;
}

export class NewApiH3ProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status?: number;
  /** Known provider task id, retained so a poll timeout can be resumed safely. */
  readonly taskId?: string;
  /** Whether the failed attempt is believed to have been billed. */
  readonly billingResult: H3BillingResult;
  /** Provider response evidence, when the failure came from an HTTP response. */
  readonly responseMetadata?: H3ResponseMetadata;

  constructor(
    message: string,
    code: string,
    retryable: boolean,
    status?: number,
    taskId?: string,
    options: NewApiH3ProviderErrorOptions = {}
  ) {
    super(message);
    this.name = "NewApiH3ProviderError";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
    this.taskId = taskId?.trim() || undefined;
    // An unspecified billing outcome must stay unknown rather than claim "not charged".
    this.billingResult = options.billingResult ?? "UNKNOWN";
    this.responseMetadata = options.responseMetadata;
  }
}

export class NewApiH3SubmissionStateUnknownError extends Error {
  readonly code = "H3_SUBMISSION_STATE_UNKNOWN";
  readonly retryable = false;
  /** Failure happened before any paid request was sent. */
  readonly billingResult: H3BillingResult;
  /** Present when the provider accepted a task but the local checkpoint failed. */
  readonly taskId?: string;

  constructor(message: string, taskId?: string, billingResult: H3BillingResult = "UNKNOWN") {
    super(message);
    this.name = "NewApiH3SubmissionStateUnknownError";
    this.taskId = taskId?.trim() || undefined;
    this.billingResult = billingResult;
  }
}
