import { describe, it, expect, beforeEach, vi } from 'vitest';
import { dispatchStagedPin, dispatchBulkStagedPins } from '../services/staged-service';
import * as repurposeService from '../services/repurpose-service';
import * as workspaceGuard from '../auth/workspace-guard';
import { dbClients } from '../db/clients';
import { POST as dispatchHandler } from '../../pages/api/pinarchive/staged/dispatch';
import { POST as dispatchBulkHandler } from '../../pages/api/pinarchive/staged/dispatch-bulk';

describe('PinArchive Staged Dispatch: Safe Defaults & Pre-CAS Validation', () => {
  const workspaceId = '11111111-1111-1111-1111-111111111111';
  const userId = '22222222-2222-2222-2222-222222222222';
  const stagedPinId = 'staged-pin-100';
  const accountId = '33333333-3333-3333-3333-333333333333';

  let mockPaAdmin: any;
  let mockP1Admin: any;
  let stagedPinsDb: any[];
  let boardsDb: any[];
  let spyRepurpose: any;

  beforeEach(() => {
    vi.clearAllMocks();

    vi.spyOn(workspaceGuard, 'assertWorkspaceAccess').mockResolvedValue({
      workspaceId,
      userId,
      role: 'admin',
      isAdmin: true,
      isOwner: false,
    } as any);

    stagedPinsDb = [
      {
        id: stagedPinId,
        workspace_id: workspaceId,
        pa_pin_id: 'pa-100',
        title: 'Modern Architecture',
        board_name: 'Architecture Board',
        original_link: 'https://example.com/arch',
        override_link: '',
        status: 'staged',
      },
    ];

    boardsDb = [
      {
        account_id: accountId,
        board_name: 'Architecture Board',
        pinterest_board_id: 'remote-pinterest-board-123',
      },
    ];

    mockPaAdmin = {
      from: (table: string) => {
        let filterEq: Record<string, any> = {};
        let filterIn: Record<string, any[]> = {};
        const builder: any = {
          select: vi.fn(() => builder),
          update: vi.fn((payload: any) => {
            return {
              eq: vi.fn((col: string, val: any) => {
                filterEq[col] = val;
                return {
                  eq: vi.fn((col2: string, val2: any) => {
                    filterEq[col2] = val2;
                    return {
                      eq: vi.fn((col3: string, val3: any) => {
                        filterEq[col3] = val3;
                        // CAS update match
                        const item = stagedPinsDb.find(
                          (p) =>
                            p.id === filterEq.id &&
                            p.workspace_id === filterEq.workspace_id &&
                            p.status === filterEq.status
                        );
                        if (item) {
                          Object.assign(item, payload);
                          return {
                            select: vi.fn(() => ({
                              maybeSingle: vi.fn(async () => ({ data: { ...item }, error: null })),
                            })),
                          };
                        }
                        return {
                          select: vi.fn(() => ({
                            maybeSingle: vi.fn(async () => ({ data: null, error: null })),
                          })),
                        };
                      }),
                    };
                  }),
                };
              }),
            };
          }),
          eq: vi.fn((col: string, val: any) => {
            filterEq[col] = val;
            return builder;
          }),
          in: vi.fn((col: string, vals: any[]) => {
            filterIn[col] = vals;
            return builder;
          }),
          maybeSingle: vi.fn(async () => {
            if (table === 'pa_staged_pins') {
              const item = stagedPinsDb.find(
                (p) => p.id === filterEq.id && p.workspace_id === filterEq.workspace_id
              );
              return { data: item ? { ...item } : null, error: null };
            }
            return { data: null, error: null };
          }),
          then: vi.fn((cb: any) => {
            if (table === 'pa_staged_pins') {
              let res = stagedPinsDb.filter((p) => p.workspace_id === filterEq.workspace_id);
              if (filterIn.id) {
                res = res.filter((p) => filterIn.id.includes(p.id));
              }
              return Promise.resolve(cb({ data: res, error: null }));
            }
            return Promise.resolve(cb({ data: [], error: null }));
          }),
        };
        return builder;
      },
    };

    mockP1Admin = {
      from: (table: string) => {
        let filterEq: Record<string, any> = {};
        let filterIn: Record<string, any[]> = {};
        const builder: any = {
          select: vi.fn(() => builder),
          eq: vi.fn((col: string, val: any) => {
            filterEq[col] = val;
            return builder;
          }),
          in: vi.fn((col: string, vals: any[]) => {
            filterIn[col] = vals;
            return builder;
          }),
          not: vi.fn(() => builder),
          then: vi.fn((cb: any) => {
            if (table === 'boards') {
              let res = boardsDb.filter((b) => {
                if (filterIn.account_id && !filterIn.account_id.includes(b.account_id)) return false;
                if (filterIn.board_name && !filterIn.board_name.includes(b.board_name)) return false;
                return true;
              });
              return Promise.resolve(cb({ data: res, error: null }));
            }
            return Promise.resolve(cb({ data: [], error: null }));
          }),
        };
        return builder;
      },
    };

    spyRepurpose = vi.spyOn(repurposeService, 'executeRepurposeDispatch').mockResolvedValue({
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

    vi.spyOn(dbClients, 'getSchedulingAdmin').mockImplementation(() => mockP1Admin);
    vi.spyOn(dbClients, 'getPinArchive').mockImplementation(() => mockPaAdmin);
  });

  it('dispatchStagedPin defaults allowDuplicates to false when argument is omitted', async () => {
    const assignments = [
      { accountId, accountLabel: 'Main Account', boardName: 'Architecture Board' },
    ];

    await dispatchStagedPin(
      mockPaAdmin,
      mockP1Admin,
      workspaceId,
      userId,
      stagedPinId,
      assignments
    );

    expect(spyRepurpose).toHaveBeenCalledWith(
      mockPaAdmin,
      mockP1Admin,
      expect.objectContaining({
        allowDuplicates: false,
      })
    );
  });

  it('dispatchBulkStagedPins defaults allowDuplicates to false when argument is omitted', async () => {
    const assignments = [
      { accountId, accountLabel: 'Main Account', boardName: 'Architecture Board' },
    ];

    await dispatchBulkStagedPins(
      mockPaAdmin,
      mockP1Admin,
      workspaceId,
      userId,
      [stagedPinId],
      assignments
    );

    expect(spyRepurpose).toHaveBeenCalledWith(
      mockPaAdmin,
      mockP1Admin,
      expect.objectContaining({
        allowDuplicates: false,
      })
    );
  });

  it('Pre-CAS validation rejects non-publishable boards (missing remote board ID) before CAS update', async () => {
    // Board exists in P1, but has no pinterest_board_id (not publishable yet)
    boardsDb = [];

    const assignments = [
      { accountId, accountLabel: 'Main Account', boardName: 'Architecture Board' },
    ];

    await expect(
      dispatchStagedPin(
        mockPaAdmin,
        mockP1Admin,
        workspaceId,
        userId,
        stagedPinId,
        assignments
      )
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('is not a publishable board'),
    });

    // Verify pin was NEVER updated to dispatched (remains staged)
    const pin = stagedPinsDb.find((p) => p.id === stagedPinId);
    expect(pin.status).toBe('staged');
  });

  it('preserves 409 conflict error when staged pin is missing or already dispatched', async () => {
    stagedPinsDb = []; // Pin is already gone / dispatched

    const assignments = [
      { accountId, accountLabel: 'Main Account', boardName: 'Architecture Board' },
    ];

    await expect(
      dispatchStagedPin(
        mockPaAdmin,
        mockP1Admin,
        workspaceId,
        userId,
        stagedPinId,
        assignments
      )
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('Staged pin is no longer available in the queue'),
    });
  });

  it('HTTP routes pinarchive/staged/dispatch and dispatch-bulk enforce allowDuplicates === true', async () => {
    const mockLocals = {
      user: { id: userId },
      activeWorkspaceId: workspaceId,
      runtime: {
        env: {
          PINARCHIVE_SUPABASE_SECRET_KEY: 'test',
          SCHEDULING_SUPABASE_SECRET_KEY: 'test',
        },
      },
    };

    // 1. Single dispatch without explicit allowDuplicates
    const req1 = new Request('http://localhost:4321/api/pinarchive/staged/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stagedPinId,
        assignments: [{ accountId, accountLabel: 'Acc', boardName: 'Architecture Board' }],
      }),
    });

    const res1 = await dispatchHandler({ request: req1, locals: mockLocals } as any);
    expect(res1.status).toBe(200);
    expect(spyRepurpose).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ allowDuplicates: false })
    );

    // Reset pin status to staged for bulk test
    stagedPinsDb[0].status = 'staged';

    // 2. Bulk dispatch without explicit allowDuplicates
    const req2 = new Request('http://localhost:4321/api/pinarchive/staged/dispatch-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stagedPinIds: [stagedPinId],
        assignments: [{ accountId, accountLabel: 'Acc', boardName: 'Architecture Board' }],
      }),
    });

    const res2 = await dispatchBulkHandler({ request: req2, locals: mockLocals } as any);
    expect(res2.status).toBe(200);
    expect(spyRepurpose).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ allowDuplicates: false })
    );

    // Reset pin status to staged for opt-in test
    stagedPinsDb[0].status = 'staged';

    // 3. Single dispatch with explicit allowDuplicates: true
    const req3 = new Request('http://localhost:4321/api/pinarchive/staged/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stagedPinId,
        assignments: [{ accountId, accountLabel: 'Acc', boardName: 'Architecture Board' }],
        allowDuplicates: true,
      }),
    });

    const res3 = await dispatchHandler({ request: req3, locals: mockLocals } as any);
    expect(res3.status).toBe(200);
    expect(spyRepurpose).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ allowDuplicates: true })
    );
  });
});
