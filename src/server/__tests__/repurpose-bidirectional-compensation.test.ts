import { describe, it, expect, vi } from 'vitest';
import { executeBidirectionalCompensation, executeRepurposeDispatch } from '../services/repurpose-service';

describe('Repurpose Bidirectional Compensation Suite', () => {
  it('deletes tracked P1 pins and cascades P4 batch upon compensation', async () => {
    const mockP1Delete = vi.fn().mockReturnThis();
    const mockP1In = vi.fn().mockReturnThis();
    const mockP1Eq = vi.fn().mockResolvedValue({ error: null });

    const mockP1Admin: any = {
      from: vi.fn(() => ({
        delete: mockP1Delete,
        in: mockP1In,
        eq: mockP1Eq,
      })),
    };

    const mockPaDelete = vi.fn().mockReturnThis();
    const mockPaEq1 = vi.fn().mockReturnThis();
    const mockPaEq2 = vi.fn().mockResolvedValue({ error: null });

    const mockPaAdmin: any = {
      from: vi.fn(() => ({
        delete: mockPaDelete,
        eq: mockPaEq1.mockImplementation(() => ({ eq: mockPaEq2 })),
      })),
    };

    const batchUuid = 'batch-compensate-1';
    const insertedIds = ['p1-uuid-1', 'p1-uuid-2'];
    const workspaceId = 'ws-1';

    await executeBidirectionalCompensation(mockP1Admin, mockPaAdmin, workspaceId, batchUuid, insertedIds);

    expect(mockP1Admin.from).toHaveBeenCalledWith('pins');
    expect(mockP1In).toHaveBeenCalledWith('id', insertedIds);
    expect(mockP1Eq).toHaveBeenCalledWith('workspace_id', workspaceId);
    expect(mockPaAdmin.from).toHaveBeenCalledWith('pa_repurpose_batches');
    expect(mockPaEq1).toHaveBeenCalledWith('id', batchUuid);
  });

  it('triggers compensation when P1 insert fails mid-execution', async () => {
    const p1PinsDeleted: string[][] = [];
    const paBatchesDeleted: string[] = [];

    const mockPaAdmin: any = {
      from: vi.fn((table: string) => {
        if (table === 'pa_repurpose_batches') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null }),
            insert: vi.fn().mockResolvedValue({ error: null }),
            update: vi.fn().mockReturnThis(),
            delete: vi.fn().mockReturnValue({
              eq: vi.fn((col: string, val: string) => {
                if (col === 'id') paBatchesDeleted.push(val);
                return { eq: vi.fn().mockResolvedValue({ error: null }) };
              }),
            }),
          };
        }
        if (table === 'pa_pins') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockResolvedValue({
              data: [{ id: 'p-1', title: 'T', image_url: 'https://img.com/p1.jpg' }],
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

    const mockP1Admin: any = {
      from: vi.fn((table: string) => {
        if (table === 'pins') {
          return {
            insert: vi.fn().mockResolvedValue({ error: { message: 'P1 database constraint failure' } }),
            delete: vi.fn().mockReturnValue({
              in: vi.fn((_col: string, ids: string[]) => {
                p1PinsDeleted.push(ids);
                return { eq: vi.fn().mockResolvedValue({ error: null }) };
              }),
            }),
          };
        }
        return {};
      }),
    };

    await expect(
      executeRepurposeDispatch(mockPaAdmin, mockP1Admin, {
        batchUuid: 'batch-fail-chunk',
        workspaceId: 'ws-1',
        userId: 'user-1',
        pinIds: ['p-1'],
        targets: [{ accountId: 'acc-1', accountLabel: 'Acc 1', boardName: 'Board 1' }],
      })
    ).rejects.toThrowError(/Changes have been compensated and rolled back/);

    expect(p1PinsDeleted.length).toBeGreaterThan(0);
    expect(paBatchesDeleted).toContain('batch-fail-chunk');
  });
});
