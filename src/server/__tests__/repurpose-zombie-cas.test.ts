import { describe, it, expect, vi } from 'vitest';
import { executeRepurposeDispatch } from '../services/repurpose-service';

describe('Repurpose Zombie CAS Reconciliation Suite', () => {
  it('reconciles zombie batch via atomic CAS and recovers if P1 pins exist', async () => {
    const staleTime = new Date(Date.now() - 150 * 1000).toISOString();
    let casUpdateCalled = false;
    let completedUpdateCalled = false;

    const mockPaAdmin: any = {
      from: vi.fn((table: string) => {
        if (table === 'pa_repurpose_batches') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: 'batch-zombie-1',
                status: 'in_progress',
                updated_at: staleTime,
                pins_count: 2,
                targets_count: 1,
              },
            }),
            update: vi.fn().mockImplementation((payload: any) => {
              if (payload.status === 'reconciling') casUpdateCalled = true;
              if (payload.status === 'completed') completedUpdateCalled = true;
              return {
                eq: vi.fn().mockReturnThis(),
                select: vi.fn().mockReturnThis(),
                maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'batch-zombie-1' } }),
              };
            }),
          };
        }
        return {};
      }),
    };

    const mockP1Admin: any = {
      from: vi.fn((table: string) => {
        if (table === 'pins') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            then: vi.fn((resolve) => resolve({ data: [{ id: 'p1-1' }, { id: 'p1-2' }] })),
          };
        }
        return {};
      }),
    };

    const result = await executeRepurposeDispatch(mockPaAdmin, mockP1Admin, {
      batchUuid: 'batch-zombie-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
      pinIds: ['p-1', 'p-2'],
      targets: [{ accountId: 'acc-1', accountLabel: 'Acc 1', boardName: 'Board 1' }],
    });

    expect(casUpdateCalled).toBe(true);
    expect(completedUpdateCalled).toBe(true);
    expect(result.success).toBe(true);
    expect(result.replayed).toBe(true);
  });

  it('reconciles zombie batch and triggers compensation if P1 pins missing (throws 410)', async () => {
    const staleTime = new Date(Date.now() - 120 * 1000).toISOString();

    const mockPaAdmin: any = {
      from: vi.fn((table: string) => {
        if (table === 'pa_repurpose_batches') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: 'batch-zombie-lost',
                status: 'in_progress',
                updated_at: staleTime,
                pins_count: 2,
                targets_count: 1,
              },
            }),
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnThis(),
              select: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'batch-zombie-lost' } }),
            }),
            delete: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
            }),
          };
        }
        return {};
      }),
    };

    const mockP1Admin: any = {
      from: vi.fn((table: string) => {
        if (table === 'pins') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            then: vi.fn((resolve) => resolve({ data: [] })),
            delete: vi.fn().mockReturnValue({
              in: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
            }),
          };
        }
        return {};
      }),
    };

    await expect(
      executeRepurposeDispatch(mockPaAdmin, mockP1Admin, {
        batchUuid: 'batch-zombie-lost',
        workspaceId: 'ws-1',
        userId: 'user-1',
        pinIds: ['p-1', 'p-2'],
        targets: [{ accountId: 'acc-1', accountLabel: 'Acc 1', boardName: 'Board 1' }],
      })
    ).rejects.toMatchObject({
      status: 410,
      options: { code: 'zombie_reconciled' },
    });
  });

  it('reconciles zombie batch even when duplicates were skipped (p1Pins.length < expected but > 0)', async () => {
    const staleTime = new Date(Date.now() - 150 * 1000).toISOString();
    let savedSummary: any = null;

    const mockPaAdmin: any = {
      from: vi.fn((table: string) => {
        if (table === 'pa_repurpose_batches') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: 'batch-zombie-skipped-dup',
                status: 'in_progress',
                updated_at: staleTime,
                pins_count: 5,
                targets_count: 2,
              },
            }),
            update: vi.fn().mockImplementation((payload: any) => {
              if (payload.status === 'completed') {
                savedSummary = payload.result_summary;
              }
              return {
                eq: vi.fn().mockReturnThis(),
                select: vi.fn().mockReturnThis(),
                maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'batch-zombie-skipped-dup' } }),
              };
            }),
          };
        }
        return {};
      }),
    };

    // 7 pins found out of 10 expected (3 duplicates were skipped)
    const mockP1Admin: any = {
      from: vi.fn((table: string) => {
        if (table === 'pins') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            then: vi.fn((resolve) =>
              resolve({
                data: [
                  { id: 'pin-1' },
                  { id: 'pin-2' },
                  { id: 'pin-3' },
                  { id: 'pin-4' },
                  { id: 'pin-5' },
                  { id: 'pin-6' },
                  { id: 'pin-7' },
                ],
              })
            ),
          };
        }
        return {};
      }),
    };

    const result = await executeRepurposeDispatch(mockPaAdmin, mockP1Admin, {
      batchUuid: 'batch-zombie-skipped-dup',
      workspaceId: 'ws-1',
      userId: 'user-1',
      pinIds: ['p-1', 'p-2', 'p-3', 'p-4', 'p-5'],
      targets: [
        { accountId: 'acc-1', accountLabel: 'Acc 1', boardName: 'Board 1' },
        { accountId: 'acc-2', accountLabel: 'Acc 2', boardName: 'Board 2' },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.replayed).toBe(true);
    expect(result.summary.total_stamps).toBe(7);
    expect(result.summary.skipped_duplicates).toBe(3); // 10 expected - 7 found
    expect(savedSummary).toBeDefined();
    expect(savedSummary.skipped_duplicates).toBe(3);
  });
});

