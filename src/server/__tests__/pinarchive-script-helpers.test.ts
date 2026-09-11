import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveMonotonicOldestPin,
  fetchAllAccounts,
} from '../../../scripts/sync-oldest-pins-from-sheet.mjs';
import {
  supaQuery,
  supaPatch,
  pushToIngest,
  writeToGas,
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
      expect(formatted.reactions.type_1).toBe(10);
      expect(formatted.reactions.type_2).toBe(3);
    });
  });
});
