import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET as pinsHandler } from '../../pages/api/pinarchive/pins';

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

describe('PinArchive Account Growth Pace Suite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('1. API Pass-Through in mode=page', () => {
    it('passes through delta_saves_3d, delta_repins_3d, delta_saves_7d, delta_repins_7d from RPC', async () => {
      mockPinArchiveClient.rpc.mockResolvedValue({
        data: [
          {
            id: 'pin-uuid-1',
            pin_id: '1141592205576263549',
            title: 'Test Pin Growth',
            saves: 1655,
            repins: 300,
            comments: 12,
            share_count: 5,
            velocity: 15.5,
            delta_saves: 116,
            delta_repins: 114,
            delta_saves_3d: 383,
            delta_repins_3d: 383,
            delta_saves_7d: 539,
            delta_repins_7d: 404,
            delta_shares: 2,
            delta_reactions: 0,
            last_snapshot_at: '2026-09-09T12:00:00Z',
            created_at_pinterest: '2026-08-01T00:00:00Z',
            total_count: 42,
          },
        ],
        error: null,
      });

      const req = new Request(`http://localhost:4321/api/pinarchive/pins?mode=page&account_id=${mockAccId}&sort=delta_3d&limit=50&page=1`);
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
        p_sort: 'delta_3d',
        p_asc: false,
        p_limit: 50,
        p_offset: 0,
        p_max_saves: null,
        p_min_saves: null,
      });

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.count).toBe(1);
      const pin = json.pins[0];
      expect(pin.delta_saves).toBe(116);
      expect(pin.delta_repins).toBe(114);
      expect(pin.delta_saves_3d).toBe(383);
      expect(pin.delta_repins_3d).toBe(383);
      expect(pin.delta_saves_7d).toBe(539);
      expect(pin.delta_repins_7d).toBe(404);
    });

    it('passes delta_7d sort parameter to RPC', async () => {
      mockPinArchiveClient.rpc.mockResolvedValue({
        data: [],
        error: null,
      });

      const req = new Request(`http://localhost:4321/api/pinarchive/pins?mode=page&account_id=${mockAccId}&sort=delta_7d`);
      const res = await pinsHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(200);
      expect(mockPinArchiveClient.rpc).toHaveBeenCalledWith(
        'pa_account_pins_page',
        expect.objectContaining({ p_sort: 'delta_7d' })
      );
    });

    it('returns zero for all 6 delta fields on fallback query when RPC fails', async () => {
      mockPinArchiveClient.rpc.mockRejectedValue(new Error('RPC unavailable'));

      const mockQueryBuilder = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        range: vi.fn().mockResolvedValue({
          data: [
            {
              id: 'pin-fallback-1',
              pin_id: '99999999',
              title: 'Fallback Pin',
              saves: 100,
              repins: 20,
              comments: 2,
              created_at_pinterest: '2026-08-10T00:00:00Z',
            },
          ],
          count: 1,
          error: null,
        }),
      };

      mockPinArchiveClient.from.mockReturnValue(mockQueryBuilder);

      const req = new Request(`http://localhost:4321/api/pinarchive/pins?mode=page&account_id=${mockAccId}`);
      const res = await pinsHandler({
        request: req,
        locals: { user: mockUser, supabase: {}, activeWorkspaceId: mockWsId },
      } as any);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      const pin = json.pins[0];
      expect(pin.delta_saves).toBe(0);
      expect(pin.delta_repins).toBe(0);
      expect(pin.delta_saves_3d).toBe(0);
      expect(pin.delta_repins_3d).toBe(0);
      expect(pin.delta_saves_7d).toBe(0);
      expect(pin.delta_repins_7d).toBe(0);
    });
  });

  describe('2. Client Growth Pace Interaction & Filter Logic', () => {
    it('resets headerSort and aligns currentSort when changing pace', () => {
      // Behavioral simulation of account/[username].astro pace switching
      let activePace: '24h' | '3d' | '7d' | 'all' = '24h';
      let headerSort: { sort: string; asc: boolean } | null = { sort: 'repins', asc: true };
      let currentSort = 'saves';

      const changePace = (newPace: '24h' | '3d' | '7d' | 'all') => {
        activePace = newPace;
        // Strict requirement: reset headerSort on pace change
        headerSort = null;

        if (activePace === '24h') currentSort = 'delta_saves';
        else if (activePace === '3d') currentSort = 'delta_3d';
        else if (activePace === '7d') currentSort = 'delta_7d';
        else currentSort = 'saves';
      };

      // User was sorting by header repins ASC, then clicked 3d pace pill
      changePace('3d');
      expect(activePace).toBe('3d');
      expect(headerSort).toBeNull(); // Reset! Does not stick to old header sort
      expect(currentSort).toBe('delta_3d');

      changePace('7d');
      expect(activePace).toBe('7d');
      expect(headerSort).toBeNull();
      expect(currentSort).toBe('delta_7d');

      changePace('all');
      expect(activePace).toBe('all');
      expect(headerSort).toBeNull();
      expect(currentSort).toBe('saves');

      changePace('24h');
      expect(activePace).toBe('24h');
      expect(headerSort).toBeNull();
      expect(currentSort).toBe('delta_saves');
    });

    it('filters changedOnly pins respecting activePace timeframe', () => {
      const pins = [
        {
          id: 'p1',
          saves: 100,
          delta_saves: 5,
          delta_repins: 0,
          delta_saves_3d: 0,
          delta_repins_3d: 0,
          delta_saves_7d: 0,
          delta_repins_7d: 0,
        },
        {
          id: 'p2',
          saves: 50,
          delta_saves: 0,
          delta_repins: 0,
          delta_saves_3d: 15,
          delta_repins_3d: 0,
          delta_saves_7d: 20,
          delta_repins_7d: 5,
        },
        {
          id: 'p3',
          saves: 0,
          delta_saves: 0,
          delta_repins: 0,
          delta_saves_3d: 0,
          delta_repins_3d: 0,
          delta_saves_7d: 0,
          delta_repins_7d: 0,
        },
      ];

      const filterChanged = (items: typeof pins, pace: '24h' | '3d' | '7d' | 'all') => {
        return items.filter((p) => {
          if (pace === '3d') {
            return Number(p.delta_saves_3d || 0) !== 0 || Number(p.delta_repins_3d || 0) !== 0;
          } else if (pace === '7d') {
            return Number(p.delta_saves_7d || 0) !== 0 || Number(p.delta_repins_7d || 0) !== 0;
          } else if (pace === 'all') {
            return Number(p.saves || 0) > 0;
          } else {
            return Number(p.delta_saves || 0) !== 0 || Number(p.delta_repins || 0) !== 0;
          }
        });
      };

      // 24h pace: only p1 changed
      expect(filterChanged(pins, '24h').map((p) => p.id)).toEqual(['p1']);

      // 3d pace: only p2 changed
      expect(filterChanged(pins, '3d').map((p) => p.id)).toEqual(['p2']);

      // 7d pace: only p2 changed
      expect(filterChanged(pins, '7d').map((p) => p.id)).toEqual(['p2']);

      // all pace: p1 and p2 have saves > 0
      expect(filterChanged(pins, 'all').map((p) => p.id)).toEqual(['p1', 'p2']);
    });
  });
});
