import { describe, it, expect } from 'vitest';
import { filterMetricsByDays } from '../metrics-timeframe';

describe('filterMetricsByDays pure helper suite', () => {
  // Mock dataset mimicking the 21 snapshots from the user screenshot (Aug 24 to Sep 10, 2026)
  const baseDate = new Date('2026-09-10T13:06:00Z').getTime();
  const dayMs = 86_400_000;

  // 21 snapshots spread across 17 days:
  // Snapshot 20: Sep 10 (anchor, 0d ago)
  // Snapshot 19: Sep 9 (1d ago)
  // Snapshot 18: Sep 8 (2d ago)
  // Snapshot 17: Sep 7 (3d ago)
  // Snapshot 16: Sep 6 (4d ago)
  // Snapshot 15: Sep 5 (5d ago)
  // Snapshot 14: Sep 4 (6d ago)
  // Snapshot 13: Sep 3 (7d ago - exactly 7.0 days ago)
  // Snapshot 12: Sep 2 (8d ago)
  // ...
  // Snapshot 0: Aug 24 (17d ago)
  const sample21Metrics = Array.from({ length: 21 }, (_, i) => {
    const daysAgo = 20 - i; // i=0 => 20d ago, i=20 => 0d ago
    const time = new Date(baseDate - daysAgo * dayMs).toISOString();
    return {
      id: `metric-${i}`,
      recorded_at: time,
      saves: 1000 + i * 15,
      repins: 500 + i * 8,
    };
  });

  it('1. Window 7 from 21: filters trailing 7 days relative to latest anchor correctly', () => {
    const res = filterMetricsByDays(sample21Metrics, 7);
    // Cutoff is anchor - 7 days.
    // Days ago <= 7: i=13 (7d), i=14 (6d), i=15 (5d), i=16 (4d), i=17 (3d), i=18 (2d), i=19 (1d), i=20 (0d) = 8 items
    expect(res.length).toBe(8);
    expect(res[0].id).toBe('metric-13');
    expect(res[res.length - 1].id).toBe('metric-20');
  });

  it('2. Inclusive boundary: snapshot recorded exactly at anchor - 7 days is included (>= cutoff)', () => {
    const anchor = new Date('2026-09-10T12:00:00Z').getTime();
    const exactCutoff = new Date(anchor - 7 * dayMs).toISOString();
    const older = new Date(anchor - 7 * dayMs - 1000).toISOString(); // 1 second older
    const newer = new Date(anchor - 6 * dayMs).toISOString();

    const metrics = [
      { id: 'm-old', recorded_at: older },
      { id: 'm-exact', recorded_at: exactCutoff },
      { id: 'm-new', recorded_at: newer },
      { id: 'm-anchor', recorded_at: new Date(anchor).toISOString() },
    ];

    const res = filterMetricsByDays(metrics, 7, anchor);
    expect(res.map((m) => m.id)).toEqual(['m-exact', 'm-new', 'm-anchor']);
  });

  it('3. Orphan single snapshot inside window: returns single-item array without failure', () => {
    const anchor = new Date('2026-09-10T12:00:00Z').getTime();
    const metrics = [
      { id: 'm-30d-ago', recorded_at: new Date(anchor - 30 * dayMs).toISOString() },
      { id: 'm-anchor', recorded_at: new Date(anchor).toISOString() },
    ];

    const res = filterMetricsByDays(metrics, 7);
    expect(res.length).toBe(1);
    expect(res[0].id).toBe('m-anchor');
  });

  it('4. Corrupt and invalid dates are safely ignored without crashing or producing NaN', () => {
    const anchor = new Date('2026-09-10T12:00:00Z').getTime();
    const metrics = [
      { id: 'm-null', recorded_at: null },
      { id: 'm-empty', recorded_at: '' },
      { id: 'm-invalid', recorded_at: 'not-a-valid-date-string' },
      { id: 'm-valid-old', recorded_at: new Date(anchor - 20 * dayMs).toISOString() },
      { id: 'm-valid-anchor', recorded_at: new Date(anchor).toISOString() },
    ];

    const res7d = filterMetricsByDays(metrics, 7);
    expect(res7d.length).toBe(1);
    expect(res7d[0].id).toBe('m-valid-anchor');

    const resAll = filterMetricsByDays(metrics, 'all');
    expect(resAll.length).toBe(2);
    expect(resAll.map((m) => m.id)).toEqual(['m-valid-old', 'm-valid-anchor']);
  });

  it('5. "all" and "ALL" returns all valid metrics preserving chronological order', () => {
    const res = filterMetricsByDays(sample21Metrics, 'all');
    expect(res.length).toBe(21);
    expect(res[0].id).toBe('metric-0');
    expect(res[20].id).toBe('metric-20');

    const resUpper = filterMetricsByDays(sample21Metrics, 'ALL');
    expect(resUpper.length).toBe(21);
  });

  it('6. Non-empty valid dataset mathematically never yields empty result (anchor is always >= cutoff)', () => {
    const single = [{ id: 'm-only', recorded_at: '2026-09-10T10:00:00Z' }];
    const res = filterMetricsByDays(single, 1);
    expect(res.length).toBe(1);
    expect(res[0].id).toBe('m-only');
  });

  it('7. String parsing: accepts "7d", "14d", "30d" properly extracting day numbers', () => {
    const res7 = filterMetricsByDays(sample21Metrics, '7d');
    const res14 = filterMetricsByDays(sample21Metrics, '14d');
    const res30 = filterMetricsByDays(sample21Metrics, '30d');

    expect(res7.length).toBe(8);
    expect(res14.length).toBe(15);
    expect(res30.length).toBe(21); // Spans 17 days, so 30d contains all 21
  });

  it('8. Handles empty, null, or undefined array gracefully with []', () => {
    expect(filterMetricsByDays([], 7)).toEqual([]);
    expect(filterMetricsByDays(null as any, 7)).toEqual([]);
    expect(filterMetricsByDays(undefined as any, 'all')).toEqual([]);
  });
});
