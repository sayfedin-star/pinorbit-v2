/**
 * Pure helper to filter chronological metrics snapshots by a trailing time window (e.g. 7d, 14d, 30d, All).
 * Anchor defaults to the most recent valid snapshot timestamp in the array.
 * Preserves chronological order (oldest first).
 */
export function filterMetricsByDays<T extends { recorded_at?: string | null }>(
  metrics: T[],
  days: number | 'all' | string,
  anchorMax?: number | string | Date
): T[] {
  if (!Array.isArray(metrics) || metrics.length === 0) {
    return [];
  }

  // Filter out any entries with invalid, missing, or corrupt dates
  const validMetrics: { item: T; time: number }[] = [];
  for (const item of metrics) {
    if (!item || !item.recorded_at) continue;
    const t = new Date(item.recorded_at).getTime();
    if (!isNaN(t)) {
      validMetrics.push({ item, time: t });
    }
  }

  if (validMetrics.length === 0) {
    return [];
  }

  // Handle 'all' or unconstrained days
  if (days === 'all' || days === 'ALL' || days === undefined || days === null || days === '') {
    return validMetrics.map((v) => v.item);
  }

  let daysNum: number;
  if (typeof days === 'number') {
    daysNum = days;
  } else {
    const parsed = parseFloat(String(days).replace(/[^0-9.]/g, ''));
    daysNum = isNaN(parsed) ? 0 : parsed;
  }

  if (daysNum <= 0) {
    return validMetrics.map((v) => v.item);
  }

  // Determine anchor: explicit anchorMax if valid, or the latest timestamp among snapshots
  let anchorTime: number;
  if (anchorMax !== undefined && anchorMax !== null) {
    const parsedAnchor = new Date(anchorMax).getTime();
    anchorTime = !isNaN(parsedAnchor)
      ? parsedAnchor
      : Math.max(...validMetrics.map((v) => v.time));
  } else {
    anchorTime = Math.max(...validMetrics.map((v) => v.time));
  }

  const windowMs = daysNum * 86_400_000;
  const cutoff = anchorTime - windowMs;

  return validMetrics
    .filter((v) => v.time >= cutoff)
    .map((v) => v.item);
}
