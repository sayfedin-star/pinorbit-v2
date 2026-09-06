import { describe, it, expect, vi } from 'vitest';
import { executeRepurposeDispatch } from '../services/repurpose-service';
import { HttpError } from '../lib/http-error';

describe('P1 #3: Repurpose Stale Reconciling Batch Recovery Suite', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000001';
  const userId = 'user-123';
  const batchUuid = 'b2222222-2222-2222-2222-222222222222';
  const targets = [{ accountId: 'acc-1', accountLabel: 'Acc 1', boardName: 'Board 1' }];

  it('throws 409 Conflict if batch is in "reconciling" state and active within HEARTBEAT_TIMEOUT_SECONDS (90s)', async () => {
    // Active 30 seconds ago
    const recentTime = new Date(Date.now() - 30 * 1000).toISOString();

    const mockPaAdmin: any = {
      from: vi.fn((table: string) => {
        if (table === 'pa_repurpose_batches') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: batchUuid,
                status: 'reconciling',
                updated_at: recentTime,
                heartbeat_at: recentTime,
                pins_count: 2,
                targets_count: 1,
              },
            }),
          };
        }
        return {};
      }),
    };

    const mockP1Admin: any = {};

    await expect(
      executeRepurposeDispatch(mockPaAdmin, mockP1Admin, {
        batchUuid,
        workspaceId,
        userId,
        pinIds: ['pin-1', 'pin-2'],
        targets,
      })
    ).rejects.toThrow(HttpError);

    try {
      await executeRepurposeDispatch(mockPaAdmin, mockP1Admin, {
        batchUuid,
        workspaceId,
        userId,
        pinIds: ['pin-1', 'pin-2'],
        targets,
      });
    } catch (err: any) {
      expect(err).toBeInstanceOf(HttpError);
      expect(err.status).toBe(409);
      expect(err.message).toContain('Duplicate batch currently in progress');
      expect(err.options?.code).toBe('duplicate_in_progress');
    }
  });

  it('claims CAS for stale "reconciling" batch (>90s) and marks completed if P1 pins exist', async () => {
    // Stale 150 seconds ago
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
                id: batchUuid,
                status: 'reconciling',
                updated_at: staleTime,
                heartbeat_at: staleTime,
                pins_count: 2,
                targets_count: 1,
              },
            }),
            update: vi.fn().mockImplementation((payload: any) => {
              if (payload.status === 'reconciling') casUpdateCalled = true;
              if (payload.status === 'completed') completedUpdateCalled = true;
              return {
                eq: vi.fn().mockReturnThis(),
                in: vi.fn().mockReturnThis(),
                select: vi.fn().mockReturnThis(),
                maybeSingle: vi.fn().mockResolvedValue({ data: { id: batchUuid } }),
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
      batchUuid,
      workspaceId,
      userId,
      pinIds: ['pin-1', 'pin-2'],
      targets,
    });

    expect(casUpdateCalled).toBe(true);
    expect(completedUpdateCalled).toBe(true);
    expect(result.success).toBe(true);
    expect(result.replayed).toBe(true);
  });

  it('claims CAS for stale "reconciling" batch (>90s) and compensates (throws 410) if P1 pins are missing', async () => {
    // Stale 120 seconds ago
    const staleTime = new Date(Date.now() - 120 * 1000).toISOString();
    let batchDeleted = false;

    const mockPaAdmin: any = {
      from: vi.fn((table: string) => {
        if (table === 'pa_repurpose_batches') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: batchUuid,
                status: 'reconciling',
                updated_at: staleTime,
                heartbeat_at: staleTime,
                pins_count: 2,
                targets_count: 1,
              },
            }),
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnThis(),
              in: vi.fn().mockReturnThis(),
              select: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({ data: { id: batchUuid } }),
            }),
            delete: vi.fn().mockImplementation(() => {
              batchDeleted = true;
              return {
                eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
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
            delete: vi.fn().mockReturnValue({
              in: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
            }),
            then: vi.fn((resolve) => resolve({ data: [] })), // 0 P1 pins found
          };
        }
        return {};
      }),
    };

    await expect(
      executeRepurposeDispatch(mockPaAdmin, mockP1Admin, {
        batchUuid,
        workspaceId,
        userId,
        pinIds: ['pin-1', 'pin-2'],
        targets,
      })
    ).rejects.toThrow(HttpError);

    try {
      await executeRepurposeDispatch(mockPaAdmin, mockP1Admin, {
        batchUuid,
        workspaceId,
        userId,
        pinIds: ['pin-1', 'pin-2'],
        targets,
      });
    } catch (err: any) {
      expect(err).toBeInstanceOf(HttpError);
      expect(err.status).toBe(410);
      expect(err.message).toContain('Zombie batch reconciled and cleaned up');
      expect(err.options?.code).toBe('zombie_reconciled');
    }

    expect(batchDeleted).toBe(true);
  });
});
