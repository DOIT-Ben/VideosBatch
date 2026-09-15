/**
 * Canonical bounded-parallelism helper.
 *
 * `index.ts` and `generators.ts` still carry private copies from before this module
 * existed; they are intentionally left untouched so this change stays scoped to the H3
 * reference path. New callers use this one.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index], index);
      }
    })
  );
  return results;
}
