import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dispatchStagedPin, dispatchBulkStagedPins } from '../services/staged-service';
import * as repurposeService from '../services/repurpose-service';

describe('Staged Dispatch Publishable Boards Validation Suite (P1 #R6)', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000001';
  const userId = 'user-1111-2222-3333-444444444444';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects dispatch with 422 and rolls back CAS to staged when board has null pinterest_board_id', async () => {
    const stagedRow = {
      id: 'staged-pin-1',
      workspace_id: workspaceId,
      pa_pin_id: 'pa-pin-100',
      title: 'Test Pin',
      image_url: 'https://cdn.example.com/test.jpg',
      original_link: 'https://example.com/original',
      override_link: '',
      board_name: 'Unmapped Board',
      status: 'staged',
    };

    const rollbackUpdateSpy = vi.fn().mockReturnThis();

    const mockPaAdmin = {
      from: vi.fn((table: string) => {
        if (table === 'pa_staged_pins') {
          return {
            update: vi.fn((payload: any) => {
              if (payload.status === 'staged') {
                rollbackUpdateSpy(payload);
              }
              const chain: any = {
                eq: vi.fn(() => chain),
                select: vi.fn(() => chain),
                maybeSingle: vi.fn(async () => ({ data: stagedRow, error: null })),
              };
              return chain;
            }),
          };
        }
        return {};
      }),
    };

    // mockP1Admin returns NO valid boards (simulating board missing pinterest_board_id)
    const mockP1Admin = {
      from: vi.fn((table: string) => {
        if (table === 'boards') {
          const chain: any = {
            select: vi.fn(() => chain),
            eq: vi.fn(() => chain),
            in: vi.fn(() => chain),
            not: vi.fn(async () => ({ data: [], error: null })),
          };
          return chain;
        }
        return {};
      }),
    };

    const repurposeSpy = vi.spyOn(repurposeService, 'executeRepurposeDispatch');

    await expect(
      dispatchStagedPin(
        mockPaAdmin as any,
        mockP1Admin as any,
        workspaceId,
        userId,
        'staged-pin-1',
        [
          {
            accountId: 'acc-1',
            accountLabel: 'Account One',
            boardName: 'Unmapped Board',
            linkUrl: 'https://example.com/dest',
          },
        ]
      )
    ).rejects.toThrow(/not a publishable board/);

    // executeRepurposeDispatch should never be called
    expect(repurposeSpy).not.toHaveBeenCalled();

    // Rollback update must be called with status: 'staged'
    expect(rollbackUpdateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'staged' })
    );
  });

  it('validates fallback to casWon.board_name when assignment boardName is omitted', async () => {
    const stagedRow = {
      id: 'staged-pin-2',
      workspace_id: workspaceId,
      pa_pin_id: 'pa-pin-200',
      title: 'Fallback Pin',
      image_url: 'https://cdn.example.com/fallback.jpg',
      original_link: 'https://example.com/original',
      override_link: '',
      board_name: 'Default Staged Board',
      status: 'staged',
    };

    const mockPaAdmin = {
      from: vi.fn((table: string) => {
        if (table === 'pa_staged_pins') {
          return {
            update: vi.fn(() => {
              const chain: any = {
                eq: vi.fn(() => chain),
                select: vi.fn(() => chain),
                maybeSingle: vi.fn(async () => ({ data: stagedRow, error: null })),
              };
              return chain;
            }),
          };
        }
        return {};
      }),
    };

    // mockP1Admin returns valid board matching acc-1:Default Staged Board
    const mockP1Admin = {
      from: vi.fn((table: string) => {
        if (table === 'boards') {
          const chain: any = {
            select: vi.fn(() => chain),
            eq: vi.fn(() => chain),
            in: vi.fn(() => chain),
            not: vi.fn(async () => ({
              data: [{ account_id: 'acc-1', board_name: 'Default Staged Board' }],
              error: null,
            })),
          };
          return chain;
        }
        return {};
      }),
    };

    const repurposeSpy = vi.spyOn(repurposeService, 'executeRepurposeDispatch').mockResolvedValue({
      success: true,
      summary: {
        batch_uuid: 'batch-123',
        total_stamps: 1,
        accounts_count: 1,
        pins_count: 1,
        skipped_duplicates: 0,
        excluded_no_image: 0,
        link_used: '',
        completed_at: new Date().toISOString(),
      },
    });

    const res = await dispatchStagedPin(
      mockPaAdmin as any,
      mockP1Admin as any,
      workspaceId,
      userId,
      'staged-pin-2',
      [
        {
          accountId: 'acc-1',
          accountLabel: 'Account One',
          boardName: '', // omitted, should fallback to casWon.board_name
          linkUrl: 'https://example.com/dest',
        },
      ]
    );

    expect(res.success).toBe(true);
    expect(repurposeSpy).toHaveBeenCalledWith(
      mockPaAdmin,
      mockP1Admin,
      expect.objectContaining({
        targets: [
          expect.objectContaining({
            accountId: 'acc-1',
            boardName: 'Default Staged Board',
          }),
        ],
      })
    );
  });

  it('dispatchBulkStagedPins isolates failures per pin without crashing the bulk loop', async () => {
    const pin1Row = {
      id: 'bulk-1',
      workspace_id: workspaceId,
      pa_pin_id: 'pa-pin-1',
      title: 'Valid Pin',
      image_url: 'https://cdn.example.com/1.jpg',
      original_link: 'https://example.com/1',
      board_name: 'Valid Board',
      status: 'staged',
    };

    const pin2Row = {
      id: 'bulk-2',
      workspace_id: workspaceId,
      pa_pin_id: 'pa-pin-2',
      title: 'Invalid Pin',
      image_url: 'https://cdn.example.com/2.jpg',
      original_link: 'https://example.com/2',
      board_name: 'Missing Remote Board',
      status: 'staged',
    };

    const mockPaAdmin = {
      from: vi.fn((table: string) => {
        if (table === 'pa_staged_pins') {
          return {
            update: vi.fn(() => {
              const chain: any = {
                eq: vi.fn((field: string, val: string) => {
                  if (field === 'id') {
                    chain._id = val;
                  }
                  return chain;
                }),
                select: vi.fn(() => chain),
                maybeSingle: vi.fn(async () => {
                  const r = chain._id === 'bulk-2' ? pin2Row : pin1Row;
                  return { data: r, error: null };
                }),
              };
              return chain;
            }),
          };
        }
        return {};
      }),
    };

    // P1Admin: Only 'Valid Board' has a valid remote pinterest_board_id
    const mockP1Admin = {
      from: vi.fn((table: string) => {
        if (table === 'boards') {
          const chain: any = {
            select: vi.fn(() => chain),
            eq: vi.fn(() => chain),
            in: vi.fn((field: string, values: string[]) => {
              chain._lastInValues = values;
              return chain;
            }),
            not: vi.fn(async () => {
              // If queried for Valid Board, return it; if Missing Remote Board, return empty
              if (chain._lastInValues && chain._lastInValues.includes('Valid Board')) {
                return { data: [{ account_id: 'acc-1', board_name: 'Valid Board' }], error: null };
              }
              return { data: [], error: null };
            }),
          };
          return chain;
        }
        return {};
      }),
    };

    vi.spyOn(repurposeService, 'executeRepurposeDispatch').mockResolvedValue({
      success: true,
      summary: {
        batch_uuid: 'batch-bulk',
        total_stamps: 1,
        accounts_count: 1,
        pins_count: 1,
        skipped_duplicates: 0,
        excluded_no_image: 0,
        link_used: '',
        completed_at: new Date().toISOString(),
      },
    });

    const result = await dispatchBulkStagedPins(
      mockPaAdmin as any,
      mockP1Admin as any,
      workspaceId,
      userId,
      ['bulk-1', 'bulk-2'],
      [
        {
          accountId: 'acc-1',
          accountLabel: 'Acc One',
          boardName: '', // will resolve via casWon.board_name
          linkUrl: 'https://example.com/dest',
        },
      ]
    );

    expect(result.succeeded).toContain('bulk-1');
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].id).toBe('bulk-2');
    expect(result.failed[0].error).toContain('not a publishable board');
  });
});
