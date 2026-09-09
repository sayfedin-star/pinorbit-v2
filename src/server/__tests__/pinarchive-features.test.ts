import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET as accountBoardsHandler } from '../../pages/api/pinarchive/account-boards';
import { GET as pinsHandler } from '../../pages/api/pinarchive/pins';
import { POST as accountsGasHandler } from '../../pages/api/pinarchive/accounts-gas';

const { mockWsId, mockAccId, mockUser, mockPinArchiveClient } = vi.hoisted(() => ({
  mockWsId: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
  mockAccId: 'b2c3d4e5-f6a7-8b9c-0d1e-2f3a4b5c6d7e',
  mockUser: { id: 'usr-123', email: 'test@example.com' },
  mockPinArchiveClient: {
    from: vi.fn(),
    rpc: vi.fn(),
  },
}));

vi.mock('../../server/db/clients', () => ({
  dbClients: {
    getPinArchive: vi.fn(() => mockPinArchiveClient),
  },
}));

vi.mock('../../server/auth/workspace-guard', () => ({
  assertWorkspaceAccess: vi.fn().mockResolvedValue({ workspaceId: mockWsId }),
}));

vi.mock('../../server/services/promotion-service', () => ({
  promoteCandidates: vi.fn().mockResolvedValue({
    promoted: 5,
    checked: 10,
  }),
}));

vi.mock('../../server/lib/gas-bridge', () => ({
  gasCall: vi.fn(),
}));

describe('PinArchive Features & RPCs Suite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('1. GET /api/pinarchive/account-boards', () => {
    it('validates account_id and calls pa_account_boards RPC', async () => {
      mockPinArchiveClient.rpc.mockResolvedValue({
        data: [
          { board_name: 'Desserts', pins: 42 },
          { board_name: 'Dinner Ideas', pins: 18 },
        ],
        error: null,
      });

      const req = new Request(`http://localhost:4321/api/pinarchive/account-boards?workspace_id=${mockWsId}&account_id=${mockAccId}`);
      const res = await accountBoardsHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(200);
      expect(mockPinArchiveClient.rpc).toHaveBeenCalledWith('pa_account_boards', {
        p_workspace_id: mockWsId,
        p_account_id: mockAccId,
      });

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.boards.length).toBe(2);
      expect(json.boards[0]).toEqual({ board_name: 'Desserts', pins: 42 });
    });

    it('rejects invalid account_id format with 422', async () => {
      const req = new Request(`http://localhost:4321/api/pinarchive/account-boards?workspace_id=${mockWsId}&account_id=invalid-not-uuid`);
      const res = await accountBoardsHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.success).toBe(false);
    });
  });

  describe('2. GET /api/pinarchive/pins?mode=page', () => {
    it('calls pa_account_pins_page RPC and returns pagination metadata and deltas', async () => {
      mockPinArchiveClient.rpc.mockResolvedValue({
        data: [
          {
            id: 'pin-uuid-1',
            pin_id: '123456789',
            title: 'Chocolate Chip Cookies',
            saves: 1500,
            repins: 300,
            comments: 12,
            share_count: 5,
            velocity: 15.5,
            delta_saves: 25,
            delta_shares: 2,
            delta_reactions: 0,
            last_snapshot_at: '2026-08-25T12:00:00Z',
            created_at_pinterest: '2026-08-01T00:00:00Z',
            total_count: 85,
          },
        ],
        error: null,
      });

      const req = new Request(`http://localhost:4321/api/pinarchive/pins?mode=page&account_id=${mockAccId}&sort=saves&limit=50&page=1`);
      const res = await pinsHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(200);
      expect(mockPinArchiveClient.rpc).toHaveBeenCalledWith('pa_account_pins_page', {
        p_workspace_id: mockWsId,
        p_account_id: mockAccId,
        p_q: null,
        p_board: null,
        p_stage: null,
        p_sort: 'saves',
        p_asc: false,
        p_limit: 50,
        p_offset: 0,
        p_max_saves: null,
        p_min_saves: null,
      });

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.count).toBe(1);
      expect(json.total).toBe(85);
      expect(json.page).toBe(1);
      expect(json.page_size).toBe(50);
      expect(json.total_pages).toBe(2);
      expect(json.pins[0].delta_saves).toBe(25);
      expect(json.pins[0].stage).toBe('GROWING');
    });
  });

  describe('3. POST /api/pinarchive/accounts-gas', () => {
    it('executes sync_now action sequentially and returns gas bridge summary', async () => {
      mockPinArchiveClient.from.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            in: vi.fn().mockResolvedValue({
              data: [{ id: mockAccId, username: 'foodblogger', status: 'active', interval_days: 3 }],
              error: null,
            }),
          }),
        }),
      });

      const req = new Request('http://localhost:4321/api/pinarchive/accounts-gas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: mockWsId,
          action: 'sync_now',
          usernames: ['foodblogger'],
        }),
      });

      const res = await accountsGasHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.action).toBe('sync_now');
      expect(json.results.length).toBe(1);
      expect(json.results[0].ok).toBe(true);
      expect(json.results[0].summary.promoted).toBe(5);
      expect(json.results[0].summary.checked).toBe(10);
    });

    it('rejects unauthorized action strings with 422', async () => {
      const req = new Request('http://localhost:4321/api/pinarchive/accounts-gas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: mockWsId,
          action: 'invalid_action',
          usernames: ['foodblogger'],
        }),
      });

      const res = await accountsGasHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.success).toBe(false);
    });

    it('handles run_now action with empty usernames by dispatching workspace-wide', async () => {
      mockPinArchiveClient.from.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: { discovery_max_pages: 500 },
              error: null,
            }),
          }),
        }),
      });

      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValue({
        status: 204,
        ok: true,
      } as any);

      try {
        const req = new Request('http://localhost:4321/api/pinarchive/accounts-gas', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspace_id: mockWsId,
            action: 'run_now',
          }),
        });

        const res = await accountsGasHandler({
          request: req,
          locals: {
            user: mockUser,
            supabase: {},
            activeWorkspaceId: mockWsId,
            runtimeEnv: { GITHUB_DISPATCH_TOKEN: 'gh_test_token' },
          },
        } as any);

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.success).toBe(true);
        expect(json.action).toBe('run_now');
        expect(json.results).toEqual([{ username: 'all', ok: true, summary: { queued: true } }]);
        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringContaining('/actions/workflows/pinarchive-pipeline.yml/dispatches'),
          expect.objectContaining({
            method: 'POST',
            body: expect.stringContaining('"max_pages":"500"'),
          })
        );
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('handles audit_sweep action by dispatching pinarchive-audit-sweep.yml without early-stop', async () => {
      mockPinArchiveClient.from.mockImplementation((table: string) => {
        if (table === 'pa_accounts') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({
                  data: [{ id: mockAccId, username: 'ragonuregaso', status: 'active', interval_days: 1 }],
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'pa_workspace_settings') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: { discovery_max_pages: 500 },
                  error: null,
                }),
              }),
            }),
          };
        }
        return { select: vi.fn() };
      });

      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValue({
        status: 204,
        ok: true,
      } as any);

      try {
        const req = new Request('http://localhost:4321/api/pinarchive/accounts-gas', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspace_id: mockWsId,
            action: 'audit_sweep',
            usernames: ['ragonuregaso'],
          }),
        });

        const res = await accountsGasHandler({
          request: req,
          locals: {
            user: mockUser,
            supabase: {},
            activeWorkspaceId: mockWsId,
            runtimeEnv: { GITHUB_DISPATCH_TOKEN: 'gh_test_token' },
          },
        } as any);

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.success).toBe(true);
        expect(json.action).toBe('audit_sweep');
        expect(json.results).toEqual([{ username: 'ragonuregaso', ok: true, summary: { queued: true } }]);
        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringContaining('/actions/workflows/pinarchive-audit-sweep.yml/dispatches'),
          expect.objectContaining({
            method: 'POST',
            body: expect.stringContaining('"max_pages":"500"'),
          })
        );
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('executes sync_sheet_ages action and updates pa_accounts with sheet oldest_pin_at', async () => {
      const updateMock = vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ error: null }),
        }),
      });

      mockPinArchiveClient.from.mockImplementation((table: string) => {
        if (table === 'pa_accounts') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({
                  data: [{ id: mockAccId, username: 'foodblogger', status: 'active' }],
                  error: null,
                }),
              }),
            }),
            update: updateMock,
          };
        }
        return { select: vi.fn(), update: updateMock };
      });

      const { gasCall } = await import('../../server/lib/gas-bridge');
      vi.mocked(gasCall).mockResolvedValueOnce({
        ok: true,
        version: '2.8.2',
        ages: {
          foodblogger: '2026-06-03T03:20:10.000Z',
        },
      });

      const req = new Request('http://localhost:4321/api/pinarchive/accounts-gas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: mockWsId,
          action: 'sync_sheet_ages',
          usernames: ['foodblogger'],
        }),
      });

      const res = await accountsGasHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.action).toBe('sync_sheet_ages');
      expect(json.results).toEqual([
        {
          username: 'foodblogger',
          ok: true,
          summary: { oldest_pin_at: '2026-06-03T03:20:10.000Z' },
        },
      ]);
      expect(updateMock).toHaveBeenCalledWith({ oldest_pin_at: '2026-06-03T03:20:10.000Z' });
    });
  });
});
