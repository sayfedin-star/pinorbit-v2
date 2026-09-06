import { describe, it, expect, vi } from 'vitest';
import { checkPriorDispatches, executeRepurposeDispatch } from '../services/repurpose-service';
import { HttpError } from '../lib/http-error';

describe('P1 #2: Repurpose Fail-Closed Prior Dispatches Suite', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000001';
  const pinIds = ['pin-1', 'pin-2'];
  const targetAccountIds = ['acc-1'];

  it('throws HttpError 503 retryable when failClosed is true and DB query fails', async () => {
    const mockPaClient: any = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        then: vi.fn((resolve) => resolve({ data: null, error: { message: 'Connection pool exhausted' } })),
      }),
    };

    await expect(
      checkPriorDispatches(mockPaClient, workspaceId, pinIds, targetAccountIds, { failClosed: true })
    ).rejects.toThrow(HttpError);

    try {
      await checkPriorDispatches(mockPaClient, workspaceId, pinIds, targetAccountIds, { failClosed: true });
    } catch (err: any) {
      expect(err).toBeInstanceOf(HttpError);
      expect(err.status).toBe(503);
      expect(err.options?.retryable).toBe(true);
      expect(err.message).toContain('Failed to verify prior dispatches');
    }
  });

  it('fails open (returns empty duplicates) when failClosed is false or omitted and DB query fails', async () => {
    const mockPaClient: any = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        then: vi.fn((resolve) => resolve({ data: null, error: { message: 'Connection pool exhausted' } })),
      }),
    };

    const resOmitted = await checkPriorDispatches(mockPaClient, workspaceId, pinIds, targetAccountIds);
    expect(resOmitted).toEqual({ totalDuplicates: 0, duplicates: [] });

    const resFalse = await checkPriorDispatches(mockPaClient, workspaceId, pinIds, targetAccountIds, { failClosed: false });
    expect(resFalse).toEqual({ totalDuplicates: 0, duplicates: [] });
  });

  it('executeRepurposeDispatch throws 503 when allowDuplicates is false and prior dispatches check errors', async () => {
    const mockPaAdmin: any = {
      from: vi.fn((table: string) => {
        if (table === 'pa_repurpose_batches') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null }), // New batch
            insert: vi.fn().mockResolvedValue({ error: null }),
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ error: null }),
            }),
            delete: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValue({ error: null }),
              }),
            }),
          };
        }
        if (table === 'pa_pin_dispatches') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            then: vi.fn((resolve) => resolve({ data: null, error: { message: 'Database query timeout' } })),
          };
        }
        if (table === 'pa_pins') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockResolvedValue({
              data: [
                {
                  id: 'pin-1',
                  title: 'Test Pin',
                  description: 'Desc',
                  image_url: 'https://example.com/img.jpg',
                  link: 'https://example.com',
                  board_name: 'Board',
                  account_id: 'acc-src',
                },
              ],
              error: null,
            }),
          };
        }
        return {};
      }),
    };

    const mockP1Admin: any = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({ data: [{ id: 'acc-1' }], error: null }),
        insert: vi.fn().mockResolvedValue({ error: null }),
        delete: vi.fn().mockReturnValue({
          in: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: null }),
          }),
        }),
      }),
    };

    await expect(
      executeRepurposeDispatch(mockPaAdmin, mockP1Admin, {
        batchUuid: 'b1111111-1111-1111-1111-111111111111',
        workspaceId,
        userId: 'user-1',
        pinIds: ['pin-1'],
        targets: [{ accountId: 'acc-1', accountLabel: 'Acc 1', boardName: 'Board 1' }],
        allowDuplicates: false,
      })
    ).rejects.toThrow(HttpError);

    try {
      await executeRepurposeDispatch(mockPaAdmin, mockP1Admin, {
        batchUuid: 'b1111111-1111-1111-1111-111111111111',
        workspaceId,
        userId: 'user-1',
        pinIds: ['pin-1'],
        targets: [{ accountId: 'acc-1', accountLabel: 'Acc 1', boardName: 'Board 1' }],
        allowDuplicates: false,
      });
    } catch (err: any) {
      expect(err).toBeInstanceOf(HttpError);
      expect(err.status).toBe(503);
      expect(err.options?.retryable).toBe(true);
    }
  });
});
