/**
 * Billing conclusion for one provider attempt, in the same vocabulary FrameFlow's
 * `ProviderApiError` uses.
 *
 * `NOT_CHARGED` means the attempt provably did not bill, so a retry is safe; `CHARGED`
 * means it did and a retry would bill twice; `UNKNOWN` means only the provider can say.
 *
 * Defined in a dependency-free leaf module so both the shared domain types
 * (`types.ts`) and the native projection can name the same vocabulary without an
 * import cycle — the persisted render record, the persisted failure record, and the
 * server-side adapter must not be able to drift apart.
 */
export type VideosBatchBillingResult = "NOT_CHARGED" | "CHARGED" | "UNKNOWN";

/**
 * Priority order for accumulating billing evidence across attempts.
 *
 * FrameFlow's `mergeProviderBillingResult` never lets a later, weaker verdict erase a
 * stronger earlier one: `CHARGED` is absorbing, and a proven `NOT_CHARGED` is not
 * overwritten by a subsequent `UNKNOWN`. Losing the "money was spent" fact is what
 * authorizes a duplicate paid submission, so evidence may only ever accumulate.
 */
const BILLING_PRIORITY: Record<VideosBatchBillingResult, number> = {
  UNKNOWN: 0,
  NOT_CHARGED: 1,
  CHARGED: 2
};

/** Keep the strongest of two billing conclusions. `undefined`/unknown input stays unknown. */
export function mergeVideosBatchBillingResult(
  current: VideosBatchBillingResult | undefined,
  incoming: VideosBatchBillingResult | undefined
): VideosBatchBillingResult | undefined {
  if (!current) return incoming;
  if (!incoming) return current;
  return BILLING_PRIORITY[incoming] > BILLING_PRIORITY[current] ? incoming : current;
}
