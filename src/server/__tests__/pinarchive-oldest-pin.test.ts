import { describe, it, expect } from 'vitest';
import { computeOldestPinAt } from '../../../scripts/pinarchive-discovery.mjs';

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
