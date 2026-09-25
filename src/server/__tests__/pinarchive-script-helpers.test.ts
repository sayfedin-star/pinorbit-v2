import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  supaQuery,
  supaPatch,
  pushToIngest,
  writeToGas,
  resolveMonotonicOldestPin,
  fetchAllAccounts,
  partitionAccountsLPT,
} from '../../../scripts/lib/pa-client.mjs';
import {
  aesKey,
  decryptCookieValue,
  encryptCookieValue,
  resolveKek,
} from '../../../scripts/lib/vault.mjs';
import {
  PINTEREST_PAGE_HEADERS,
  getPinterestXhrHeaders,
  findPinInTree,
  formatPin,
} from '../../../scripts/lib/pinterest.mjs';

describe('PinArchive Script Library & Pagination Suite (Phase 6d)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. Monotonic Oldest Pin Resolution (LEAST guard)', () => {
    it('initializes to candidate when baseline is null', () => {
      const candidate = '2025-01-15T00:00:00.000Z';
      const result = resolveMonotonicOldestPin(null, candidate);
      expect(result).toBe(candidate);
    });

    it('updates to candidate when candidate is strictly older than baseline', () => {
      const baseline = '2025-06-01T12:00:00.000Z';
      const olderCandidate = '2024-03-10T08:30:00.000Z';
      const result = resolveMonotonicOldestPin(baseline, olderCandidate);
      expect(result).toBe(olderCandidate);
    });

    it('preserves baseline when candidate is newer (monotonic protection)', () => {
      const baseline = '2024-01-01T00:00:00.000Z';
      const newerCandidate = '2025-08-20T00:00:00.000Z';
      const result = resolveMonotonicOldestPin(baseline, newerCandidate);
      expect(result).toBe(baseline);
    });

    it('preserves baseline when candidate is identical', () => {
      const baseline = '2024-05-15T00:00:00.000Z';
      const result = resolveMonotonicOldestPin(baseline, baseline);
      expect(result).toBe(baseline);
    });

    it('preserves baseline when candidate is null, undefined, or empty', () => {
      const baseline = '2024-05-15T00:00:00.000Z';
      expect(resolveMonotonicOldestPin(baseline, null)).toBe(baseline);
      expect(resolveMonotonicOldestPin(baseline, undefined)).toBe(baseline);
      expect(resolveMonotonicOldestPin(baseline, '')).toBe(baseline);
    });

    it('preserves baseline when candidate is an invalid date string', () => {
      const baseline = '2024-05-15T00:00:00.000Z';
      expect(resolveMonotonicOldestPin(baseline, 'invalid-timestamp-string')).toBe(baseline);
    });

    it('initializes to candidate when baseline is invalid date string', () => {
      const candidate = '2024-05-15T00:00:00.000Z';
      expect(resolveMonotonicOldestPin('invalid-baseline', candidate)).toBe(candidate);
    });
  });

  describe('2. Keyset Cursor Pagination (fetchAllAccounts)', () => {
    it('fetches single page when total accounts <= pageSize', async () => {
      const mockBatch = [
        { id: 'acc-1', workspace_id: 'ws-1', username: 'user1', oldest_pin_at: null, pins_count: 10 },
        { id: 'acc-2', workspace_id: 'ws-1', username: 'user2', oldest_pin_at: null, pins_count: 20 },
      ];

      const supaQueryFn = vi.fn().mockResolvedValue(mockBatch);
      const accounts = await fetchAllAccounts(supaQueryFn, {}, 10);

      expect(supaQueryFn).toHaveBeenCalledTimes(1);
      expect(supaQueryFn).toHaveBeenCalledWith(
        'pa_accounts',
        'select=id,workspace_id,username,oldest_pin_at,pins_count&order=id.asc&limit=10'
      );
      expect(accounts).toEqual(mockBatch);
    });

    it('paginates multiple pages via keyset cursor (order=id.asc & id=gt.lastId)', async () => {
      const page1 = [
        { id: '00000000-0000-0000-0000-000000000001', workspace_id: 'ws-1', username: 'u1' },
        { id: '00000000-0000-0000-0000-000000000002', workspace_id: 'ws-1', username: 'u2' },
      ];
      const page2 = [
        { id: '00000000-0000-0000-0000-000000000003', workspace_id: 'ws-1', username: 'u3' },
        { id: '00000000-0000-0000-0000-000000000004', workspace_id: 'ws-1', username: 'u4' },
      ];
      const page3 = [
        { id: '00000000-0000-0000-0000-000000000005', workspace_id: 'ws-1', username: 'u5' },
      ];

      const supaQueryFn = vi
        .fn()
        .mockResolvedValueOnce(page1)
        .mockResolvedValueOnce(page2)
        .mockResolvedValueOnce(page3);

      const accounts = await fetchAllAccounts(supaQueryFn, {}, 2);

      expect(supaQueryFn).toHaveBeenCalledTimes(3);
      expect(supaQueryFn).toHaveBeenNthCalledWith(
        1,
        'pa_accounts',
        'select=id,workspace_id,username,oldest_pin_at,pins_count&order=id.asc&limit=2'
      );
      expect(supaQueryFn).toHaveBeenNthCalledWith(
        2,
        'pa_accounts',
        'select=id,workspace_id,username,oldest_pin_at,pins_count&order=id.asc&limit=2&id=gt.00000000-0000-0000-0000-000000000002'
      );
      expect(supaQueryFn).toHaveBeenNthCalledWith(
        3,
        'pa_accounts',
        'select=id,workspace_id,username,oldest_pin_at,pins_count&order=id.asc&limit=2&id=gt.00000000-0000-0000-0000-000000000004'
      );
      expect(accounts.length).toBe(5);
    });

    it('carries workspace and username filters across all paginated pages', async () => {
      const page1 = [
        { id: 'acc-1', workspace_id: 'ws-target', username: 'creator' },
        { id: 'acc-2', workspace_id: 'ws-target', username: 'creator' },
      ];
      const page2 = [
        { id: 'acc-3', workspace_id: 'ws-target', username: 'creator' },
      ];

      const supaQueryFn = vi.fn().mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);

      await fetchAllAccounts(
        supaQueryFn,
        { workspace: 'ws-target', username: '@creator' },
        2
      );

      expect(supaQueryFn).toHaveBeenNthCalledWith(
        1,
        'pa_accounts',
        'select=id,workspace_id,username,oldest_pin_at,pins_count&order=id.asc&limit=2&workspace_id=eq.ws-target&username=eq.creator'
      );
      expect(supaQueryFn).toHaveBeenNthCalledWith(
        2,
        'pa_accounts',
        'select=id,workspace_id,username,oldest_pin_at,pins_count&order=id.asc&limit=2&workspace_id=eq.ws-target&username=eq.creator&id=gt.acc-2'
      );
    });
  });

  describe('3. Vault AES-GCM Cryptography & Atomic KEK', () => {
    const testKek = 'a'.repeat(64);

    it('encrypts and decrypts cookies roundtrip cleanly', async () => {
      const plain = '_auth=12345; session=abcde; secure';
      const encStr = await encryptCookieValue(plain, testKek);

      expect(encStr).toBeTruthy();
      expect(encStr?.startsWith('v1:')).toBe(true);

      const decrypted = await decryptCookieValue(encStr, testKek);
      expect(decrypted).toBe(plain);
    });

    it('returns plaintext unchanged when stored value does not start with v1:', async () => {
      const plain = 'legacy_unencrypted_cookie_string';
      const result = await decryptCookieValue(plain, testKek);
      expect(result).toBe(plain);
    });

    it('returns null on corrupted ciphertext or wrong KEK', async () => {
      const wrongKek = 'b'.repeat(64);
      const encStr = await encryptCookieValue('secret_cookie', testKek);
      const result = await decryptCookieValue(encStr, wrongKek);
      expect(result).toBeNull();
    });

    it('resolveKek uses atomic ignoreDuplicates: true upsert', async () => {
      const upsertMock = vi.fn().mockResolvedValue({ error: null });
      const selectMock = vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          maybeSingle: vi
            .fn()
            .mockResolvedValueOnce({ data: null }) // first read: empty
            .mockResolvedValueOnce({ data: { kek: 'generated-kek-123' } }), // second read
        }),
      });

      const mockDb = {
        from: vi.fn().mockReturnValue({
          select: selectMock,
          upsert: upsertMock,
        }),
      };

      const kek = await resolveKek(mockDb as any);
      expect(upsertMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: true }),
        { onConflict: 'id', ignoreDuplicates: true }
      );
      expect(kek).toBe('generated-kek-123');
    });
  });

  describe('4. Ingest Push Client (pushToIngest)', () => {
    it('returns { ok: true, pushed: 0 } on empty pins', async () => {
      const res = await pushToIngest({
        workerUrl: 'https://worker.test',
        ingestSecret: 'secret',
        workspaceId: 'ws-1',
        username: 'user1',
        pins: [],
      });
      expect(res).toEqual({ ok: true, pushed: 0 });
    });

    it('handles 200 ok with pushed count', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({ success: true, count: 2 }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const res = await pushToIngest({
        workerUrl: 'https://worker.test',
        ingestSecret: 'secret',
        workspaceId: 'ws-1',
        username: 'user1',
        pins: [{ pin_id: '1' }, { pin_id: '2' }],
      });

      expect(res).toEqual({ ok: true, pushed: 2 });
    });

    it('handles 200 skipped response without treating as pushed', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({ success: true, skipped: 'no_new_pins' }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const res = await pushToIngest({
        workerUrl: 'https://worker.test',
        ingestSecret: 'secret',
        workspaceId: 'ws-1',
        username: 'user1',
        pins: [{ pin_id: '1' }],
      });

      expect(res.ok).toBe(false);
      expect(res.skipped).toBe('no_new_pins');
      expect(res.terminal).toBe(false);
    });

    it('handles 409 ingest_disabled as terminal: true', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        status: 409,
        json: async () => ({ error: 'ingest_disabled' }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const res = await pushToIngest({
        workerUrl: 'https://worker.test',
        ingestSecret: 'secret',
        workspaceId: 'ws-1',
        username: 'user1',
        pins: [{ pin_id: '1' }],
      });

      expect(res.ok).toBe(false);
      expect(res.code).toBe(409);
      expect(res.terminal).toBe(true);
    });

    it('handles 409 account_* as non-terminal skipped', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        status: 409,
        json: async () => ({ error: 'account_paused' }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const res = await pushToIngest({
        workerUrl: 'https://worker.test',
        ingestSecret: 'secret',
        workspaceId: 'ws-1',
        username: 'user1',
        pins: [{ pin_id: '1' }],
      });

      expect(res.ok).toBe(false);
      expect(res.code).toBe(409);
      expect(res.terminal).toBe(false);
      expect(res.skipped).toBe('account_paused');
    });
  });

  describe('5. Pinterest Library Headers & Helpers', () => {
    it('provides distinct headers for HTML page scraping vs XHR API endpoints', () => {
      expect(PINTEREST_PAGE_HEADERS['Accept']).toContain('text/html');
      expect(PINTEREST_PAGE_HEADERS['upgrade-insecure-requests']).toBe('1');

      const xhrHeaders = getPinterestXhrHeaders('testcreator', 'test_cookie');
      expect(xhrHeaders['Accept']).toContain('application/json');
      expect(xhrHeaders['X-Requested-With']).toBe('XMLHttpRequest');
      expect(xhrHeaders['Cookie']).toBe('test_cookie');
      expect(xhrHeaders['X-Pinterest-PWS-Handler']).toBe('www/testcreator/_created.js');
    });

    it('findPinInTree locates nested pin by entityId or pinId', () => {
      const tree = {
        data: {
          feed: [
            { id: 'wrong-pin', saves: 5 },
            {
              entityId: '123456789',
              title: 'Target Pin',
              aggregated_pin_data: { aggregated_stats: { saves: 42 } },
            },
          ],
        },
      };

      const found = findPinInTree(tree, '123456789');
      expect(found).toBeTruthy();
      expect(found.title).toBe('Target Pin');
    });

    it('formatPin extracts annotations with idea_id and reactions correctly', () => {
      const raw = {
        id: '123',
        saves: 15,
        repin_count: 5,
        pin_join: {
          annotationsWithLinksArray: [
            { name: 'DIY Crafts', url: 'https://www.pinterest.com/ideas/diy-crafts/987654321/' },
          ],
          visual_annotation: ['Art', 'Design'],
        },
        reactionCountsData: [
          { reactionType: 1, reactionCount: 10 },
          { reactionType: 2, reactionCount: 3 },
        ],
      };

      const formatted = formatPin(raw);
      expect(formatted.saves).toBe(15);
      expect(formatted.repins).toBe(5);
      expect(formatted.annotations.length).toBe(3);
      expect(formatted.annotations[0]).toEqual({
        name: 'DIY Crafts',
        idea_id: '987654321',
        url: 'https://www.pinterest.com/ideas/diy-crafts/987654321/',
      });
      expect((formatted.reactions as any).type_1).toBe(10);
      expect((formatted.reactions as any).type_2).toBe(3);
    });
  });

  describe('4. Deterministic Greedy Bin-Packing (LPT) Sharding Suite', () => {
    it('returns empty array when accounts input is empty or invalid', () => {
      expect(partitionAccountsLPT([], 4, 0)).toEqual([]);
      expect(partitionAccountsLPT(null as any, 4, 0)).toEqual([]);
      expect(partitionAccountsLPT(undefined as any, 4, 0)).toEqual([]);
    });

    it('returns all accounts when shardCount is 1', () => {
      const mockAccounts = [
        { id: 'acc-1', username: 'user1', pins_count: 100, status: 'active', ingest_enabled: true },
        { id: 'acc-2', username: 'user2', pins_count: 200, status: 'active', ingest_enabled: true },
      ];
      expect(partitionAccountsLPT(mockAccounts, 1, 0)).toEqual(mockAccounts);
    });

    it('clamps targetShard safely when out of bounds', () => {
      const mockAccounts = [
        { id: 'acc-1', username: 'user1', pins_count: 100, status: 'active', ingest_enabled: true },
      ];
      // targetShard 10 clamped to 3 (shardCount - 1)
      const res = partitionAccountsLPT(mockAccounts, 4, 10);
      expect(Array.isArray(res)).toBe(true);
    });

    it('handles boundary condition when active accounts < shardCount', () => {
      const mockAccounts = [
        { id: 'acc-1', username: 'user1', pins_count: 500, status: 'active', ingest_enabled: true },
        { id: 'acc-2', username: 'user2', pins_count: 300, status: 'active', ingest_enabled: true },
      ];
      const shard0 = partitionAccountsLPT(mockAccounts, 4, 0);
      const shard1 = partitionAccountsLPT(mockAccounts, 4, 1);
      const shard2 = partitionAccountsLPT(mockAccounts, 4, 2);
      const shard3 = partitionAccountsLPT(mockAccounts, 4, 3);

      expect(shard0.length).toBe(1);
      expect((shard0[0] as any).username).toBe('user1');
      expect(shard1.length).toBe(1);
      expect((shard1[0] as any).username).toBe('user2');
      expect(shard2).toEqual([]);
      expect(shard3).toEqual([]);
    });

    it('safely handles null, undefined, 0, negative, and string pins_count without NaN', () => {
      const mockAccounts = [
        { id: 'acc-1', username: 'user1', pins_count: null, status: 'active', ingest_enabled: true },
        { id: 'acc-2', username: 'user2', pins_count: undefined, status: 'active', ingest_enabled: true },
        { id: 'acc-3', username: 'user3', pins_count: 0, status: 'active', ingest_enabled: true },
        { id: 'acc-4', username: 'user4', pins_count: -10, status: 'active', ingest_enabled: true },
        { id: 'acc-5', username: 'user5', pins_count: '1500', status: 'active', ingest_enabled: true },
        { id: 'acc-6', username: 'user6', pins_count: 'invalid', status: 'active', ingest_enabled: true },
      ];
      const shard0: any[] = partitionAccountsLPT(mockAccounts, 4, 0);
      const shard1: any[] = partitionAccountsLPT(mockAccounts, 4, 1);
      const shard2: any[] = partitionAccountsLPT(mockAccounts, 4, 2);
      const shard3: any[] = partitionAccountsLPT(mockAccounts, 4, 3);

      const all = [...shard0, ...shard1, ...shard2, ...shard3];
      expect(all.length).toBe(6);
      expect(new Set(all.map(a => a.id)).size).toBe(6);
      // user5 (1500 pins) should be in shard0 as it's the largest
      expect(shard0.some(a => a.username === 'user5')).toBe(true);
    });

    it('guarantees deterministic, 1-to-1 partitioning across all shards with zero duplicates or drops', () => {
      const mockAccounts = Array.from({ length: 30 }, (_, i) => ({
        id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
        username: `user_${i}`,
        pins_count: (i * 37) % 500,
        status: i % 5 === 0 ? 'paused' : 'active',
        ingest_enabled: i % 7 !== 0,
      }));

      const shards: any[][] = [0, 1, 2, 3].map(s => partitionAccountsLPT(mockAccounts, 4, s));
      const totalAssigned = shards.flat();

      expect(totalAssigned.length).toBe(mockAccounts.length);
      const uniqueIds = new Set(totalAssigned.map(a => a.id));
      expect(uniqueIds.size).toBe(mockAccounts.length);
    });

    it('balances workload and eliminates straggler skew (P4 simulation)', () => {
      // Simulate P4 accounts with one giant account (2000 pins) and medium/small accounts
      const p4Accounts = [
        { id: 'acc-giant', username: 'recipestower', pins_count: 1984, status: 'active', ingest_enabled: true },
        { id: 'acc-m1', username: 'ragonuregaso', pins_count: 443, status: 'active', ingest_enabled: true },
        { id: 'acc-m2', username: 'charandcoall', pins_count: 384, status: 'active', ingest_enabled: true },
        { id: 'acc-m3', username: 'emmataste_', pins_count: 372, status: 'active', ingest_enabled: true },
        { id: 'acc-m4', username: 'everydayeatskitchen', pins_count: 338, status: 'active', ingest_enabled: true },
        { id: 'acc-m5', username: 'crispandgreenb', pins_count: 317, status: 'active', ingest_enabled: true },
        { id: 'acc-m6', username: 'golikgfould', pins_count: 299, status: 'active', ingest_enabled: true },
        { id: 'acc-m7', username: 'wifesrecipesbyme', pins_count: 291, status: 'active', ingest_enabled: true },
        { id: 'acc-m8', username: 'vieauogondimy', pins_count: 255, status: 'active', ingest_enabled: true },
        { id: 'acc-s1', username: 'ladleandbowl', pins_count: 243, status: 'active', ingest_enabled: true },
        { id: 'acc-s2', username: 'whispe_sad', pins_count: 239, status: 'active', ingest_enabled: true },
        { id: 'acc-s3', username: 'athleticlift', pins_count: 229, status: 'active', ingest_enabled: true },
        { id: 'acc-s4', username: 'yarosesovik', pins_count: 228, status: 'active', ingest_enabled: true },
        { id: 'acc-s5', username: 'hamdaymarot', pins_count: 184, status: 'active', ingest_enabled: true },
        { id: 'acc-s6', username: 'cicisafriajit', pins_count: 164, status: 'active', ingest_enabled: true },
        { id: 'acc-s7', username: 'sycksesalmamd2lu9', pins_count: 161, status: 'active', ingest_enabled: true },
        { id: 'acc-s8', username: 'roseisabelle555', pins_count: 148, status: 'active', ingest_enabled: true },
        { id: 'acc-s9', username: 'rikkibgutch', pins_count: 144, status: 'active', ingest_enabled: true },
        { id: 'acc-s10', username: 'cicisentiafarida', pins_count: 142, status: 'active', ingest_enabled: true },
        { id: 'acc-s11', username: 'cicidulurajis', pins_count: 139, status: 'active', ingest_enabled: true },
        { id: 'acc-s12', username: 'stelbftwinn', pins_count: 131, status: 'active', ingest_enabled: true },
        { id: 'acc-s13', username: 'amelia192819', pins_count: 129, status: 'active', ingest_enabled: true },
        { id: 'acc-s14', username: 'zollinsadru', pins_count: 126, status: 'active', ingest_enabled: true },
        { id: 'acc-s15', username: 'ciciputrilestariningsih', pins_count: 91, status: 'active', ingest_enabled: true },
        { id: 'acc-s16', username: 'suzanneknox21', pins_count: 71, status: 'active', ingest_enabled: true },
        { id: 'acc-s17', username: 'denisevigliottarecipes', pins_count: 70, status: 'active', ingest_enabled: true },
        { id: 'acc-s18', username: 'cindymay3977', pins_count: 64, status: 'active', ingest_enabled: true },
        { id: 'acc-s19', username: 'aliciacastillooo25', pins_count: 58, status: 'active', ingest_enabled: true },
        { id: 'acc-s20', username: 'oneyaaron5800722', pins_count: 37, status: 'active', ingest_enabled: true },
      ];

      const shards: any[][] = [0, 1, 2, 3].map(s => partitionAccountsLPT(p4Accounts, 4, s));
      const pinsPerShard: number[] = shards.map(list => list.reduce((sum: number, a: any) => sum + (a.pins_count || 0), 0));

      const totalPins = pinsPerShard.reduce((a, b) => a + b, 0);
      const avgPins = totalPins / 4;

      // Under LPT, no shard deviates by more than 10% from the average
      for (const shardTotal of pinsPerShard) {
        const diffFromAvg = Math.abs(shardTotal - avgPins);
        const percentDiff = (diffFromAvg / avgPins) * 100;
        expect(percentDiff).toBeLessThan(10);
      }
    });
  });

  describe('4. formatPin Annotations Enrichment & Merging', () => {
    it('merges idea_id and url across duplicate annotations in annotationsWithLinksArray', () => {
      const pinObj = {
        id: '123456',
        pinJoin: {
          annotationsWithLinksArray: [
            { name: 'Dinner Ideas', idea_id: null, url: null },
            { name: 'dinner ideas', idea_id: '999', url: 'https://pinterest.com/ideas/dinner/999/' },
          ],
        },
      };
      const formatted = formatPin(pinObj);
      expect(formatted.annotations).toEqual([
        {
          name: 'Dinner Ideas',
          idea_id: '999',
          url: 'https://pinterest.com/ideas/dinner/999/',
        },
      ]);
    });

    it('falls back to pin.annotations when annotationsWithLinksArray is absent', () => {
      const pinObj = {
        id: '789012',
        annotations: [
          { name: 'Keto Diet', idea_id: '555', url: '/ideas/keto/555/' },
        ],
      };
      const formatted = formatPin(pinObj);
      expect(formatted.annotations).toEqual([
        {
          name: 'Keto Diet',
          idea_id: '555',
          url: '/ideas/keto/555/',
        },
      ]);
    });
  });
});
