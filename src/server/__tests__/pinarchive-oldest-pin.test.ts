import { describe, it, expect } from 'vitest';
import { computeOldestPinAt, resolveAccountOldestPinAt } from '../../../scripts/pinarchive-discovery.mjs';

const pin = (iso: string) => ({ pin_id: 'x', created_at_pinterest: iso });

describe('computeOldestPinAt (monotonic min)', () => {
  it('returns batch min when no existing value', () => {
    expect(computeOldestPinAt(null, [pin('2026-05-01T00:00:00.000Z'), pin('2026-04-09T00:14:38.000Z')]))
      .toBe('2026-04-09T00:14:38.000Z');
  });
  it('keeps existing when batch is newer (early-stop window safety)', () => {
    expect(computeOldestPinAt('2026-01-01T00:00:00.000Z', [pin('2026-05-01T00:00:00.000Z')]))
      .toBe('2026-01-01T00:00:00.000Z');
  });
  it('adopts older batch min (backfill convergence)', () => {
    expect(computeOldestPinAt('2026-05-01T00:00:00.000Z', [pin('2026-03-01T00:00:00.000Z')]))
      .toBe('2026-03-01T00:00:00.000Z');
  });
  it('returns null for empty/unparseable batch and null existing', () => {
    expect(computeOldestPinAt(null, [])).toBeNull();
    expect(computeOldestPinAt(null, [{ pin_id: 'x', created_at_pinterest: 'garbage' }])).toBeNull();
  });
  it('ignores unparseable entries when a valid min exists', () => {
    expect(computeOldestPinAt(null, [{ pin_id: 'x' }, pin('2026-04-09T00:14:38.000Z')]))
      .toBe('2026-04-09T00:14:38.000Z');
  });
});

describe('resolveAccountOldestPinAt (poisoning guard)', () => {
  it('rejects batch when existing baseline is older (preserves Sheet-synced age against recent incremental batches)', () => {
    // Current baseline is June 2026; recent 7-day incremental batch only sees September 2026
    const res = resolveAccountOldestPinAt('2026-06-03T03:20:10.000Z', '2026-09-01T13:53:06.000Z', false);
    expect(res).toBeNull();
  });

  it('updates baseline when batch pin is strictly older than existing baseline', () => {
    const res = resolveAccountOldestPinAt('2026-06-03T03:20:10.000Z', '2026-01-15T12:00:00.000Z', false);
    expect(res).toBe('2026-01-15T12:00:00.000Z');
  });

  it('never initializes null baseline on partial or incremental routine runs (anti-poisoning guard)', () => {
    // Incremental run: isFullBackfillComplete = false
    const res = resolveAccountOldestPinAt(null, '2026-09-01T13:53:06.000Z', false);
    expect(res).toBeNull();
  });

  it('initializes null baseline only when a full backfill completes to the end of history', () => {
    // Full backfill reached the very end of account history (!hasMore && !cursor)
    const res = resolveAccountOldestPinAt(null, '2026-01-01T00:00:00.000Z', true);
    expect(res).toBe('2026-01-01T00:00:00.000Z');
  });

  it('returns null when batchOldest is null regardless of parameters', () => {
    expect(resolveAccountOldestPinAt(null, null, true)).toBeNull();
    expect(resolveAccountOldestPinAt('2026-06-03T03:20:10.000Z', null, false)).toBeNull();
  });
});
