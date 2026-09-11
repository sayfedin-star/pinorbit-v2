/**
 * Concurrency helper executing async operations across an array of items with a maximum concurrency limit.
 * Uses indexed workers to preserve exact input order and prevent unhandled promise rejections.
 */
export async function runWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const concurrency = Math.max(1, Math.min(limit, items.length));
  const results: R[] = new Array(items.length);
  let currentIndex = 0;
  let firstError: any = null;

  const workers = Array.from({ length: concurrency }, async () => {
    while (currentIndex < items.length && !firstError) {
      const idx = currentIndex++;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (err) {
        firstError = err;
        throw err;
      }
    }
  });

  await Promise.all(workers);
  return results;
}
