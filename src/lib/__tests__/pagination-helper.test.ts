import { describe, it, expect } from 'vitest';
import { paginateItems } from '../pagination-helper';

describe('paginateItems pure helper suite', () => {
  it('handles empty datasets cleanly with zero counts and disabled nav', () => {
    const res = paginateItems([], 1, 50);
    expect(res.totalItems).toBe(0);
    expect(res.totalPages).toBe(1);
    expect(res.currentPage).toBe(1);
    expect(res.pagedItems).toEqual([]);
    expect(res.pageStart).toBe(0);
    expect(res.pageEnd).toBe(0);
    expect(res.hasPrev).toBe(false);
    expect(res.hasNext).toBe(false);
  });

  it('slices full first page correctly when items exceed page size', () => {
    const items = Array.from({ length: 105 }, (_, i) => ({ id: `acc-${i + 1}` }));
    const res = paginateItems(items, 1, 50);

    expect(res.totalItems).toBe(105);
    expect(res.totalPages).toBe(3);
    expect(res.currentPage).toBe(1);
    expect(res.pagedItems.length).toBe(50);
    expect(res.pagedItems[0].id).toBe('acc-1');
    expect(res.pagedItems[49].id).toBe('acc-50');
    expect(res.pageStart).toBe(1);
    expect(res.pageEnd).toBe(50);
    expect(res.hasPrev).toBe(false);
    expect(res.hasNext).toBe(true);
  });

  it('slices middle page correctly', () => {
    const items = Array.from({ length: 105 }, (_, i) => ({ id: `acc-${i + 1}` }));
    const res = paginateItems(items, 2, 50);

    expect(res.currentPage).toBe(2);
    expect(res.pagedItems.length).toBe(50);
    expect(res.pagedItems[0].id).toBe('acc-51');
    expect(res.pagedItems[49].id).toBe('acc-100');
    expect(res.pageStart).toBe(51);
    expect(res.pageEnd).toBe(100);
    expect(res.hasPrev).toBe(true);
    expect(res.hasNext).toBe(true);
  });

  it('handles partial trailing last page correctly without truncation or extra items', () => {
    const items = Array.from({ length: 105 }, (_, i) => ({ id: `acc-${i + 1}` }));
    const res = paginateItems(items, 3, 50);

    expect(res.currentPage).toBe(3);
    expect(res.pagedItems.length).toBe(5);
    expect(res.pagedItems[0].id).toBe('acc-101');
    expect(res.pagedItems[4].id).toBe('acc-105');
    expect(res.pageStart).toBe(101);
    expect(res.pageEnd).toBe(105);
    expect(res.hasPrev).toBe(true);
    expect(res.hasNext).toBe(false);
  });

  it('clamps requested page exceeding totalPages to last page', () => {
    const items = Array.from({ length: 75 }, (_, i) => ({ id: `acc-${i + 1}` }));
    const res = paginateItems(items, 999, 50);

    expect(res.totalPages).toBe(2);
    expect(res.currentPage).toBe(2);
    expect(res.pagedItems.length).toBe(25);
    expect(res.pageStart).toBe(51);
    expect(res.pageEnd).toBe(75);
    expect(res.hasPrev).toBe(true);
    expect(res.hasNext).toBe(false);
  });

  it('clamps requested page less than 1 to 1', () => {
    const items = Array.from({ length: 75 }, (_, i) => ({ id: `acc-${i + 1}` }));
    const res = paginateItems(items, -5, 50);

    expect(res.currentPage).toBe(1);
    expect(res.pagedItems.length).toBe(50);
    expect(res.pageStart).toBe(1);
    expect(res.pageEnd).toBe(50);
    expect(res.hasPrev).toBe(false);
    expect(res.hasNext).toBe(true);
  });

  it('dynamically adapts when filter shrinks dataset and clamps page down', () => {
    // User was on page 3 of 150 items:
    const fullDataset = Array.from({ length: 150 }, (_, i) => ({ id: `acc-${i + 1}`, status: i % 2 === 0 ? 'active' : 'paused' }));
    const initialPage = 3;

    // Filter applied: only 12 items match:
    const filtered = fullDataset.filter(x => x.id === 'acc-1' || x.id === 'acc-2');
    const res = paginateItems(filtered, initialPage, 50);

    expect(res.totalItems).toBe(2);
    expect(res.totalPages).toBe(1);
    expect(res.currentPage).toBe(1); // Clamped from 3 to 1
    expect(res.pagedItems.length).toBe(2);
    expect(res.pageStart).toBe(1);
    expect(res.pageEnd).toBe(2);
    expect(res.hasPrev).toBe(false);
    expect(res.hasNext).toBe(false);
  });

  it('gracefully handles non-array input', () => {
    const res = paginateItems(null as any, 1, 50);
    expect(res.totalItems).toBe(0);
    expect(res.pagedItems).toEqual([]);
    expect(res.currentPage).toBe(1);
  });

  it('verifies worst-case interaction performance (< 100ms per render on 50 accounts + 10 consecutive keystrokes + filter toggle)', () => {
    const cachedFullFormatter = new Intl.NumberFormat('en-US');
    const cachedCompactFormatter = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

    const accounts = Array.from({ length: 50 }, (_, i) => ({
      id: `acc-${i}`,
      username: `creator_test_${i}`,
      status: i % 3 === 0 ? 'paused' : 'active',
      ingest_enabled: i % 3 !== 0,
      follower_count: 154200 + i * 1000,
      pins_count: 850 + i * 20,
      oldest_pin_at: '2024-01-15T00:00:00Z',
      interval_days: (i % 7) + 1,
      changed_last_refresh: i % 5,
      next_run_at: '2026-09-11T07:00:00Z',
    }));

    const searchQueries = ['c', 'cr', 'cre', 'crea', 'creat', 'creato', 'creator', 'creator_', 'creator_t', 'creator_test'];
    const startMs = performance.now();

    // 10 consecutive keystrokes
    for (const q of searchQueries) {
      const filtered = accounts.filter(
        (a) => a.username.toLowerCase().includes(q) || a.status.toLowerCase().includes(q)
      );
      const paginated = paginateItems(filtered, 1, 50);
      const renderedRows = paginated.pagedItems.map((a) => ({
        username: a.username,
        followers: cachedCompactFormatter.format(a.follower_count),
        pins: cachedFullFormatter.format(a.pins_count),
      }));
      expect(renderedRows.length).toBeLessThanOrEqual(50);
    }

    // Filter toggles
    for (const tab of ['active', 'paused', 'all']) {
      const filtered = tab === 'all' ? accounts : accounts.filter((a) => a.status === tab);
      const paginated = paginateItems(filtered, 1, 50);
      expect(paginated.pagedItems.length).toBeLessThanOrEqual(50);
    }

    const elapsedMs = performance.now() - startMs;
    // Strict Gate: 10 keystrokes + 3 filter toggles (13 full render cycles) MUST finish in < 100ms total (< 7.7ms/cycle)
    expect(elapsedMs).toBeLessThan(100);
  });
});
