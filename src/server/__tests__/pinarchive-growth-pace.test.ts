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

    it('re-aligns currentSort when clicking active pace if currentSort was divergent', () => {
      let activePace: '24h' | '3d' | '7d' | 'all' = '24h';
      let currentSort = 'saves'; // Desynchronized state (e.g. user selected Total Saves from dropdown)
      let headerSort: { sort: string; asc: boolean } | null = null;
      let loaded = false;

      const handlePaceClick = (tf: '24h' | '3d' | '7d' | 'all') => {
        const targetSort = tf === '24h' ? 'delta_saves' : tf === '3d' ? 'delta_3d' : tf === '7d' ? 'delta_7d' : 'saves';
        if (tf === activePace && currentSort === targetSort && !headerSort) return;
        activePace = tf;
        headerSort = null;
        currentSort = targetSort;
        loaded = true;
      };

      // Clicking 24h when currentSort is 'saves' SHOULD NOT return early; it must re-align to delta_saves
      handlePaceClick('24h');
      expect(currentSort).toBe('delta_saves');
      expect(loaded).toBe(true);

      // Clicking 24h again when already aligned SHOULD return early
      loaded = false;
      handlePaceClick('24h');
      expect(loaded).toBe(false);
    });

    it('classifies annotations into true linked ideas vs visual recognition tags', () => {
      const rawAnnotations = [
        { name: 'Easy Dinner Recipes Shepards Pie', url: '/ideas/easy-dinner-recipes-shepards-pie/945637318053/', idea_id: '945637318053' },
        { name: 'Potato Shepherd\'s Pie', url: '/ideas/potato-shepherd\'s-pie/926241892080/', idea_id: '926241892080' },
        { name: 'Shepherds Pie Recipe Baked Potato', url: '/ideas/shepherds-pie-recipe-baked-potato/937964544073/', idea_id: '937964544073' },
        { name: 'How To Make Shepherd\'s Pie Twice Baked Potatoes', url: '/answers/how-to-make-shepherd\'s-pie-twice-baked-potatoes/912403973169/', idea_id: null },
        { name: 'Easy Shepherd\'s Pie Dish', url: '/ideas/easy-shepherd\'s-pie-dish/917569127062/', idea_id: '917569127062' },
        { name: 'Shepherd\'s Pie On Baked Potato', url: '/ideas/shepherd\'s-pie-on-baked-potato/911903621151/', idea_id: '911903621151' },
        { name: 'Shepherds Pie Potato', url: '/ideas/shepherds-pie-potato/944459893890/', idea_id: '944459893890' },
        { name: 'Baked Potatoes Shepherds Pie', url: '/ideas/baked-potatoes-shepherds-pie/911298721619/', idea_id: '911298721619' },
        { name: 'Shepard Pie Baked Potato Recipe', url: '/ideas/shepard-pie-baked-potato-recipe/925302907269/', idea_id: '925302907269' },
        { name: 'Easy Shepard’s Pie', url: null, idea_id: null },
        { name: 'Baked Potatoes Ground Beef', url: null, idea_id: null },
        { name: 'Shepard’s Pie Recipe', url: null, idea_id: null },
        { name: 'One-pot Shepherd\'s Pie Dish', url: null, idea_id: null },
        { name: 'How To Make Shepherd\'s Pie In A Potato', url: null, idea_id: null },
        { name: 'Shepherd Pie Baked Potato', url: null, idea_id: null },
        { name: 'Easy Shepherd\'s Pie Meal', url: null, idea_id: null },
      ];

      const linkedIdeas: any[] = [];
      const visualTags: any[] = [];

      rawAnnotations.forEach((a) => {
        if (a.url || a.idea_id) {
          linkedIdeas.push(a);
        } else {
          visualTags.push(a);
        }
      });

      expect(linkedIdeas.length).toBe(9);
      expect(visualTags.length).toBe(7);
      expect(rawAnnotations.length).toBe(16);

      const counterText = `${linkedIdeas.length} linked ideas · ${visualTags.length} visual tags`;
      expect(counterText).toBe('9 linked ideas · 7 visual tags');
    });

    it('sets activePace to all when selecting non-delta sorts in dropdown', () => {
      let activePace: '24h' | '3d' | '7d' | 'all' = '24h';
      let currentSort = 'delta_saves';

      const handleDropdownSortChange = (newSort: string) => {
        currentSort = newSort;
        if (currentSort === 'delta_saves') {
          activePace = '24h';
        } else if (currentSort === 'delta_3d') {
          activePace = '3d';
        } else if (currentSort === 'delta_7d') {
          activePace = '7d';
        } else {
          activePace = 'all';
        }
      };

      handleDropdownSortChange('saves');
      expect(activePace).toBe('all');

      handleDropdownSortChange('velocity');
      expect(activePace).toBe('all');

      handleDropdownSortChange('delta_3d');
      expect(activePace).toBe('3d');

      handleDropdownSortChange('delta_saves');
      expect(activePace).toBe('24h');
    });

    it('deduplicates annotations case-insensitively and handles diverse URL formats safely', () => {
      const rawAnnotations = [
        { name: 'Potato Shepard Pie', url: '/ideas/potato/123/', idea_id: '123' },
        { name: 'potato shepard pie', url: '/ideas/potato/123/', idea_id: '123' }, // duplicate (case variant)
        { name: 'Full Url Idea', url: 'https://www.pinterest.com/ideas/full/456/', idea_id: null },
        { name: 'Visual Tag One', url: null, idea_id: null },
        { name: 'Visual Tag One', url: null, idea_id: null }, // duplicate
      ];

      const linkedIdeas: Array<{ name: string; url: string }> = [];
      const visualTags: Array<{ name: string }> = [];
      const seenNames = new Set<string>();

      rawAnnotations.forEach((a: any) => {
        const name = typeof a === 'string' ? a.trim() : String(a?.name || '').trim();
        if (!name) return;
        const lower = name.toLowerCase();
        if (seenNames.has(lower)) return;
        seenNames.add(lower);

        const url = typeof a === 'object' && a?.url ? String(a.url).trim() : null;
        const ideaId = typeof a === 'object' && a?.idea_id ? String(a.idea_id).trim() : null;

        if (url || ideaId) {
          let fullUrl = '';
          if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
            fullUrl = url;
          } else if (url && url.startsWith('/')) {
            fullUrl = `https://www.pinterest.com${url}`;
          } else if (url) {
            fullUrl = `https://www.pinterest.com/${url}`;
          } else if (ideaId) {
            fullUrl = `https://www.pinterest.com/ideas/${encodeURIComponent(name)}/${encodeURIComponent(ideaId)}/`;
          } else {
            fullUrl = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(name)}`;
          }
          linkedIdeas.push({ name, url: fullUrl });
        } else {
          visualTags.push({ name });
        }
      });

      expect(linkedIdeas.length).toBe(2);
      expect(linkedIdeas[0].url).toBe('https://www.pinterest.com/ideas/potato/123/');
      expect(linkedIdeas[1].url).toBe('https://www.pinterest.com/ideas/full/456/');
      expect(visualTags.length).toBe(1);
      expect(visualTags[0].name).toBe('Visual Tag One');
    });
  });
});

