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
});
