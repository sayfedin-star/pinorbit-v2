import { describe, it, expect, vi } from 'vitest';
import { runReverseReconciliation } from '../services/reconcile-service';

describe('Reverse Reconciliation Suite (Condition 2: P1 pins without P4 stamps)', () => {
  it('detects orphan pins in P1 that have no matching stamps in P4', async () => {
    const mockP1Candidates = [
      { id: 'p1-with-stamp', account_id: 'acc-1', title: 'With Stamp', created_at: '2026-01-01', status: 'draft', source_ref: 'batch-1' },
      { id: 'p1-orphan', account_id: 'acc-1', title: 'Orphan Pin', created_at: '2026-01-01', status: 'draft', source_ref: 'batch-1' },
    ];

    const mockP4Stamps = [
      { p1_pin_id: 'p1-with-stamp' },
    ];

    const mockP1Admin: any = {
      from: vi.fn((table: string) => {
        if (table === 'pins') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            not: vi.fn().mockReturnThis(),
            lt: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({ data: mockP1Candidates, error: null }),
          };
        }
        return {};
      }),
    };

    const mockPaAdmin: any = {
      from: vi.fn((table: string) => {
        if (table === 'pa_pin_dispatches') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockResolvedValue({ data: mockP4Stamps, error: null }),
          };
        }
        return {};
      }),
    };

    const report = await runReverseReconciliation(mockP1Admin, mockPaAdmin, 'ws-1', false);

    expect(report.scanned_p1_pins).toBe(2);
    expect(report.orphan_p1_pins_count).toBe(1);
    expect(report.orphan_pins[0].id).toBe('p1-orphan');
    expect(report.cleaned_up).toBe(false);
  });

  it('cleans up orphan pins from P1 when cleanup = true', async () => {
    let deletedIds: string[] = [];

    const mockP1Candidates = [
      { id: 'p1-orphan-1', account_id: 'acc-1', title: 'Orphan 1', created_at: '2026-01-01', status: 'draft', source_ref: 'b-1' },
    ];

    const mockP1Admin: any = {
      from: vi.fn((table: string) => {
        if (table === 'pins') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            not: vi.fn().mockReturnThis(),
            lt: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({ data: mockP1Candidates, error: null }),
            delete: vi.fn().mockReturnValue({
              in: vi.fn((col: string, ids: string[]) => {
                deletedIds = ids;
                return { eq: vi.fn().mockResolvedValue({ error: null }) };
              }),
            }),
          };
        }
        return {};
      }),
    };

    const mockPaAdmin: any = {
      from: vi.fn((table: string) => {
        if (table === 'pa_pin_dispatches') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockResolvedValue({ data: [], error: null }),
          };
        }
        return {};
      }),
    };

    const report = await runReverseReconciliation(mockP1Admin, mockPaAdmin, 'ws-1', true);

    expect(report.orphan_p1_pins_count).toBe(1);
    expect(report.cleaned_up).toBe(true);
    expect(deletedIds).toContain('p1-orphan-1');
  });
});
