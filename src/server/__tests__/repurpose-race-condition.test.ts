import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeRepurposeDispatch } from '../services/repurpose-service';

describe('Repurpose Race Condition & Idempotency Suite', () => {
  let mockPaAdmin: any;
  let mockP1Admin: any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns replayed 200 summary when batch is already completed', async () => {
    const mockSummary = {
      batch_uuid: 'batch-completed-1',
      total_stamps: 5,
      accounts_count: 1,
      pins_count: 5,
      skipped_duplicates: 0,
      excluded_no_image: 0,
      link_used: '',
      completed_at: new Date().toISOString(),
    };

    mockPaAdmin = {
      from: vi.fn((table: string) => {
        if (table === 'pa_repurpose_batches') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: 'batch-completed-1',
                status: 'completed',
                result_summary: mockSummary,
              },
            }),
          };
        }
        return {};
      }),
    };
    mockP1Admin = {};

    const res = await executeRepurposeDispatch(mockPaAdmin, mockP1Admin, {
      batchUuid: 'batch-completed-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
      pinIds: ['pin-1'],
      targets: [{ accountId: 'acc-1', accountLabel: 'Acc 1', boardName: 'Board 1' }],
    });

    expect(res.success).toBe(true);
    expect(res.replayed).toBe(true);
    expect(res.summary.total_stamps).toBe(5);
  });

  it('throws 409 retryable duplicate_in_progress when batch is running (<90s elapsed)', async () => {
    mockPaAdmin = {
      from: vi.fn((table: string) => {
        if (table === 'pa_repurpose_batches') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: 'batch-active-1',
                status: 'in_progress',
                updated_at: new Date().toISOString(),
              },
            }),
          };
        }
        return {};
      }),
    };
    mockP1Admin = {};

    await expect(
      executeRepurposeDispatch(mockPaAdmin, mockP1Admin, {
        batchUuid: 'batch-active-1',
        workspaceId: 'ws-1',
        userId: 'user-1',
        pinIds: ['pin-1'],
        targets: [{ accountId: 'acc-1', accountLabel: 'Acc 1', boardName: 'Board 1' }],
      })
    ).rejects.toMatchObject({
      status: 409,
      options: { code: 'duplicate_in_progress', retryable: true },
    });
  });

  it('handles 23505 conflict on batch insert with 409 retryable', async () => {
    mockPaAdmin = {
      from: vi.fn((table: string) => {
        if (table === 'pa_repurpose_batches') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null }),
            insert: vi.fn().mockResolvedValue({ error: { code: '23505', message: 'duplicate key' } }),
          };
        }
        if (table === 'pa_pins') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockResolvedValue({
              data: [{ id: 'pin-1', title: 'T', image_url: 'https://img.com/1.jpg' }],
            }),
          };
        }
        if (table === 'pa_pin_dispatches') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({ data: [] }),
            }),
          };
        }
        return {};
      }),
    };
    mockP1Admin = {};

    await expect(
      executeRepurposeDispatch(mockPaAdmin, mockP1Admin, {
        batchUuid: 'batch-concurrent-1',
        workspaceId: 'ws-1',
        userId: 'user-1',
        pinIds: ['pin-1'],
        targets: [{ accountId: 'acc-1', accountLabel: 'Acc 1', boardName: 'Board 1' }],
      })
    ).rejects.toMatchObject({
      status: 409,
      options: { code: 'duplicate_in_progress', retryable: true },
    });
  });
});
