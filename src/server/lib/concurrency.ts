/**
 * Concurrency helper executing async operations across an array of items with a maximum concurrency limit.
 * Vendored from src/pages/api/analytics/cron/bulk.ts with zero external dependencies.
 */
export async function runWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  const executing: Promise<void>[] = [];

  for (const item of items) {
    const p = Promise.resolve()
      .then(() => fn(item))
      .then((res) => {
        results.push(res);
      })
      .finally(() => {
        // Remove this promise from executing array when done
        const idx = executing.indexOf(p);
        if (idx !== -1) executing.splice(idx, 1);
      });

    executing.push(p);

    if (executing.length >= limit) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}
