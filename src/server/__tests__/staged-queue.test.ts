import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  stagePins,
  getStagedQueue,
  updateStagedPin,
  deleteStagedPin,
  dispatchStagedPin,
} from '../services/staged-service';
import * as repurposeService from '../services/repurpose-service';

describe('Staged Queue Service Suite (v2.8)', () => {
  const workspaceId = 'ws-test-123';
  const userId = 'user-test-456';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('stagePins', () => {
    it('throws 400 if no pin IDs provided', async () => {
      const mockPaAdmin = {} as any;
      await expect(stagePins(mockPaAdmin, workspaceId, userId, [])).rejects.toThrow(
        'No pin IDs provided to stage.'
      );
    });

    it('throws 422 if none of the pins have valid image_url', async () => {
      const mockPaAdmin = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: vi.fn().mockResolvedValue({
            data: [{ id: 'p1', image_url: '   ' }],
            error: null,
          }),
        }),
      } as any;

      await expect(stagePins(mockPaAdmin, workspaceId, userId, ['p1'])).rejects.toThrow(
        'None of the selected pins have valid images for staging.'
      );
    });

    it('successfully bulk stages pins with sanitized override link', async () => {
      const mockPins = [
        { id: 'p1', title: 'Pin 1', image_url: 'https://cdn.example.com/1.jpg', link: 'https://example.com/orig1', board_name: 'Board A' },
        { id: 'p2', title: '', image_url: 'https://cdn.example.com/2.jpg', link: '', board_name: '' },
      ];

      let insertedRows: any[] = [];

      const mockPaAdmin = {
        from: vi.fn((table: string) => {
          if (table === 'pa_pins') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              in: vi.fn().mockResolvedValue({ data: mockPins, error: null }),
            };
          }
          if (table === 'pa_staged_pins') {
            return {
              insert: vi.fn((rows: any[]) => {
                insertedRows = rows;
                return {
                  select: vi.fn().mockResolvedValue({
                    data: rows.map((r, i) => ({ id: `staged-${i + 1}`, ...r })),
                    error: null,
                  }),
                };
              }),
            };
          }
          return {};
        }),
      } as any;

      const result = await stagePins(mockPaAdmin, workspaceId, userId, ['p1', 'p2'], {
        overrideLink: 'https://example.com/shelf-item',
        boardName: 'Custom Board',
      });

      expect(result.count).toBe(2);
      expect(insertedRows).toHaveLength(2);
      expect(insertedRows[0].workspace_id).toBe(workspaceId);
      expect(insertedRows[0].staged_by).toBe(userId);
      expect(insertedRows[0].pa_pin_id).toBe('p1');
      expect(insertedRows[0].title).toBe('Pin 1');
      expect(insertedRows[0].override_link).toBe('https://example.com/shelf-item');
      expect(insertedRows[0].board_name).toBe('Custom Board');
      expect(insertedRows[0].status).toBe('staged');

      // Second pin had empty title, defaults to 'Archived Pin'
      expect(insertedRows[1].title).toBe('Archived Pin');
    });

    it('rejects SSRF malicious links in stagePins defaults', async () => {
      const mockPins = [{ id: 'p1', title: 'Pin 1', image_url: 'https://cdn.example.com/1.jpg' }];
      const mockPaAdmin = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: vi.fn().mockResolvedValue({ data: mockPins, error: null }),
        }),
      } as any;

      await expect(
        stagePins(mockPaAdmin, workspaceId, userId, ['p1'], {
          overrideLink: 'http://169.254.169.254/latest/meta-data',
        })
      ).rejects.toThrow();
    });
  });

  describe('getStagedQueue', () => {
    it('returns staged pins for workspace sorted by created_at DESC', async () => {
      const mockRows = [
        { id: 'staged-1', workspace_id: workspaceId, status: 'staged', title: 'Pin 1' },
        { id: 'staged-2', workspace_id: workspaceId, status: 'staged', title: 'Pin 2' },
      ];

      const mockPaAdmin = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockResolvedValue({ data: mockRows, error: null }),
        }),
      } as any;

      const res = await getStagedQueue(mockPaAdmin, workspaceId);
      expect(res).toHaveLength(2);
      expect(res[0].id).toBe('staged-1');
    });
  });

  describe('updateStagedPin', () => {
    it('updates title, board_name, and validates safe URL', async () => {
      const updatedRow = {
        id: 'staged-1',
        title: 'New Title',
        board_name: 'New Board',
        override_link: 'https://valid.com/dest',
        status: 'staged',
      };

      const mockPaAdmin = {
        from: vi.fn().mockReturnValue({
          update: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          select: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: updatedRow, error: null }),
        }),
      } as any;

      const res = await updateStagedPin(mockPaAdmin, workspaceId, 'staged-1', {
        title: 'New Title',
        board_name: 'New Board',
        override_link: 'https://valid.com/dest',
      });

      expect(res.title).toBe('New Title');
      expect(res.override_link).toBe('https://valid.com/dest');
    });

    it('rejects SSRF internal/private addresses on update', async () => {
      const mockPaAdmin = {} as any;

      await expect(
        updateStagedPin(mockPaAdmin, workspaceId, 'staged-1', {
          override_link: 'http://localhost:8080/admin',
        })
      ).rejects.toThrow();
    });

    it('throws 404 if staged pin is not found or already dispatched', async () => {
      const mockPaAdmin = {
        from: vi.fn().mockReturnValue({
          update: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          select: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      } as any;

      await expect(
        updateStagedPin(mockPaAdmin, workspaceId, 'staged-1', { title: 'New' })
      ).rejects.toThrow('Staged pin not found or already dispatched/cancelled.');
    });
  });

  describe('deleteStagedPin', () => {
    it('deletes the staged pin scoped to workspace', async () => {
      const deleteEq = vi.fn().mockResolvedValue({ error: null });
      const mockPaAdmin = {
        from: vi.fn().mockReturnValue({
          delete: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: deleteEq,
            }),
          }),
        }),
      } as any;

      await deleteStagedPin(mockPaAdmin, workspaceId, 'staged-1');
      expect(deleteEq).toHaveBeenCalled();
    });
  });

  describe('dispatchStagedPin (CAS & Compensation)', () => {
    it('CAS succeeds and dispatches pin with individual account links', async () => {
      const stagedRow = {
        id: 'staged-1',
        workspace_id: workspaceId,
        pa_pin_id: 'pa-pin-100',
        title: 'Staged Kitchen Design',
        image_url: 'https://cdn.example.com/kitchen.jpg',
        original_link: 'https://original.com/item',
        override_link: '',
        board_name: 'Kitchens',
        status: 'staged',
      };

      const mockPaAdmin = {
        from: vi.fn((table: string) => {
          if (table === 'pa_staged_pins') {
            return {
              update: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              select: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({ data: stagedRow, error: null }),
            };
          }
          return {};
        }),
      } as any;

      const mockP1Admin = {} as any;

      const spyRepurpose = vi.spyOn(repurposeService, 'executeRepurposeDispatch').mockResolvedValue({
        success: true,
        summary: {
          batch_uuid: 'batch-123',
          total_stamps: 2,
          accounts_count: 2,
          pins_count: 1,
          skipped_duplicates: 0,
          excluded_no_image: 0,
          link_used: '',
          completed_at: new Date().toISOString(),
        },
      });

      const assignments = [
        {
          accountId: 'acc-1',
          accountLabel: 'Account One',
          boardName: 'Kitchens A',
          linkUrl: 'https://notebook.com/shelf1/kitchen-link',
        },
        {
          accountId: 'acc-2',
          accountLabel: 'Account Two',
          boardName: 'Kitchens B',
          linkUrl: 'https://notebook.com/shelf2/kitchen-link',
        },
      ];

      const res = await dispatchStagedPin(
        mockPaAdmin,
        mockP1Admin,
        workspaceId,
        userId,
        'staged-1',
        assignments
      );

      expect(res.success).toBe(true);
      expect(res.summary.total_stamps).toBe(2);
      expect(spyRepurpose).toHaveBeenCalledWith(
        mockPaAdmin,
        mockP1Admin,
        expect.objectContaining({
          workspaceId,
          userId,
          pinIds: ['pa-pin-100'],
          targets: [
            {
              accountId: 'acc-1',
              accountLabel: 'Account One',
              boardName: 'Kitchens A',
              customLink: 'https://notebook.com/shelf1/kitchen-link',
            },
            {
              accountId: 'acc-2',
              accountLabel: 'Account Two',
              boardName: 'Kitchens B',
              customLink: 'https://notebook.com/shelf2/kitchen-link',
            },
          ],
        })
      );
    });

    it('CAS throws 409 conflict if pin is already dispatched or cancelled', async () => {
      const mockPaAdmin = {
        from: vi.fn().mockReturnValue({
          update: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          select: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      } as any;

      const mockP1Admin = {} as any;

      await expect(
        dispatchStagedPin(mockPaAdmin, mockP1Admin, workspaceId, userId, 'staged-1', [
          { accountId: 'acc-1', accountLabel: 'Acc 1', boardName: 'Board' },
        ])
      ).rejects.toThrow('Staged pin is no longer available in the queue (already dispatched or cancelled).');
    });

    it('Compensation rollback: rolls back status to staged if repurpose dispatch fails', async () => {
      const stagedRow = {
        id: 'staged-1',
        workspace_id: workspaceId,
        pa_pin_id: 'pa-pin-100',
        title: 'Failing Pin',
        image_url: 'https://cdn.example.com/fail.jpg',
        original_link: 'https://original.com',
        override_link: '',
        board_name: 'Board',
        status: 'staged',
      };

      const rollbackUpdate = vi.fn().mockReturnThis();

      const mockPaAdmin = {
        from: vi.fn(() => {
          return {
            update: rollbackUpdate,
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  select: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({ data: stagedRow, error: null }),
                  }),
                }),
                select: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: stagedRow, error: null }),
                }),
              }),
              select: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: stagedRow, error: null }),
              }),
            }),
          };
        }),
      } as any;

      // Mock executeRepurposeDispatch to fail
      vi.spyOn(repurposeService, 'executeRepurposeDispatch').mockRejectedValue(
        new Error('Network failure writing to P1')
      );

      await expect(
        dispatchStagedPin(mockPaAdmin, {} as any, workspaceId, userId, 'staged-1', [
          { accountId: 'acc-1', accountLabel: 'Acc 1', boardName: 'Board' },
        ])
      ).rejects.toThrow('Network failure writing to P1');

      // Verify rollback was invoked
      expect(rollbackUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'staged' })
      );
    });
  });
});
