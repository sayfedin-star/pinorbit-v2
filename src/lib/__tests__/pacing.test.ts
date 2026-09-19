import { describe, it, expect } from 'vitest';
import { calculateJSPacingForAccount } from '../supabase';
import { mockAccounts, mockPins } from '../supabase-mock';

describe('calculateJSPacingForAccount test suite', () => {
  it('calculates pacing timestamps for pending pins within active posting window', () => {
    const count = calculateJSPacingForAccount('acc-1');
    expect(typeof count).toBe('number');
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it('handles non-existent account ID gracefully', () => {
    const count = calculateJSPacingForAccount('non-existent-id');
    expect(count).toBe(0);
  });

  it('does not coerce midnight window start 00:00 to 09:00', () => {
    const acc = mockAccounts.find((a) => a.id === 'acc-1');
    expect(acc).toBeDefined();
    if (acc) {
      const origStart = acc.posting_window_start;
      const origEnd = acc.posting_window_end;
      acc.posting_window_start = '00:00';
      acc.posting_window_end = '04:00';
      try {
        calculateJSPacingForAccount('acc-1');
        const pending = mockPins.filter((p) => p.account_id === 'acc-1' && p.status === 'pending');
        expect(pending.length).toBeGreaterThan(0);
        for (const p of pending) {
          if (p.scheduled_for) {
            const h = new Date(p.scheduled_for).getHours();
            expect(h).toBeLessThanOrEqual(4);
            expect(h).toBeGreaterThanOrEqual(0);
          }
        }
      } finally {
        acc.posting_window_start = origStart;
        acc.posting_window_end = origEnd;
      }
    }
  });
});

