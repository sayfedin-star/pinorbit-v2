import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDeterministicPinPostKey, buildPinPostIdempotencyKey } from '../services/scheduling-logic';
import { isPrivateOrReservedIp, validateSafeUrl } from '../lib/ssrf-guard';
import { HttpError } from '../lib/http-error';
import { schedulingDb } from '../db/scheduling';
import { competitorsDb } from '../db/competitors';

vi.mock('../auth/workspace-guard', () => ({
  assertWorkspaceAccess: vi.fn().mockResolvedValue({
    workspaceId: '00000000-0000-0000-0000-000000000001',
    role: 'owner',
    isOwner: true,
    isAdmin: true,
  }),
}));

describe('Adversarial Hardening & Reliability Suite (Vectors 1 - 6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Vector 1: Deterministic Pin Post Idempotency Keys', () => {
    it('generates consistent key across any retry attempt count', () => {
      const pinId = 'pin-uuid-1234-abcd';
      const key0 = buildDeterministicPinPostKey(pinId);
      const key1 = buildDeterministicPinPostKey(pinId);
      const key2 = buildDeterministicPinPostKey(pinId);

      expect(key0).toBe('pin.post:pin-uuid-1234-abcd');
      expect(key1).toBe(key0);
      expect(key2).toBe(key0);

      // Contrast with old attempt-mutating key which generated different keys
      const oldKey1 = buildPinPostIdempotencyKey(pinId, 1);
      const oldKey2 = buildPinPostIdempotencyKey(pinId, 2);
      expect(oldKey1).not.toBe(oldKey2);
    });
  });

  describe('Vector 2: SSRF Cloud Metadata & Internal Hostname Protection', () => {
    it('detects and blocks cloud metadata hostnames', () => {
      expect(isPrivateOrReservedIp('metadata.google.internal')).toBe(true);
      expect(isPrivateOrReservedIp('metadata')).toBe(true);
      expect(isPrivateOrReservedIp('instance-data')).toBe(true);
    });

    it('detects and blocks internal and reserved domain suffixes', () => {
      expect(isPrivateOrReservedIp('service.internal')).toBe(true);
      expect(isPrivateOrReservedIp('k8s.cluster.local')).toBe(true);
      expect(isPrivateOrReservedIp('router.lan')).toBe(true);
      expect(isPrivateOrReservedIp('intranet.corp')).toBe(true);
      expect(isPrivateOrReservedIp('hidden.onion')).toBe(true);
    });

    it('detects and blocks short-form and dotted IPv4 bypasses (127.1, 10.1, 127.0.1, 0x7f.1)', () => {
      expect(isPrivateOrReservedIp('127.1')).toBe(true);
      expect(isPrivateOrReservedIp('10.1')).toBe(true);
      expect(isPrivateOrReservedIp('127.0.1')).toBe(true);
      expect(isPrivateOrReservedIp('169.254.1')).toBe(true);
      expect(isPrivateOrReservedIp('192.168.1')).toBe(true);
      expect(isPrivateOrReservedIp('172.16.1')).toBe(true);
      expect(isPrivateOrReservedIp('0x7f.1')).toBe(true);
    });

    it('validateSafeUrl throws HttpError 400 on cloud metadata and short-form IPv4 URLs', () => {
      expect(() => validateSafeUrl('http://metadata.google.internal/computeMetadata/v1/')).toThrow(HttpError);
      expect(() => validateSafeUrl('http://instance-data/latest/meta-data/')).toThrow(HttpError);
      expect(() => validateSafeUrl('http://secret.internal/api/keys')).toThrow(HttpError);
      expect(() => validateSafeUrl('http://my-service.local/admin')).toThrow(HttpError);
      expect(() => validateSafeUrl('http://database.lan/status')).toThrow(HttpError);
      expect(() => validateSafeUrl('http://internal.corp/vpn')).toThrow(HttpError);
      expect(() => validateSafeUrl('http://127.1/secret')).toThrow(HttpError);
      expect(() => validateSafeUrl('http://10.1/admin')).toThrow(HttpError);
      expect(() => validateSafeUrl('http://127.0.1/')).toThrow(HttpError);
    });

    it('allows legitimate external public URLs', () => {
      expect(validateSafeUrl('https://api.pinterest.com/v5/pins').hostname).toBe('api.pinterest.com');
      expect(validateSafeUrl('https://hook.make.com/12345').hostname).toBe('hook.make.com');
    });
  });

  describe('Vector 3: Multi-Tenant Scoping in Data Layers', () => {
    it('getPostingWindows enforces workspace_id boundary in query', async () => {
      const eqMock = vi.fn().mockReturnThis();
      const orderMock = vi.fn().mockReturnThis();
      const selectMock = vi.fn().mockReturnValue({
        eq: eqMock,
      });

      // Chain: select('*').eq('workspace_id', ...).eq('account_id', ...).order(...).order(...)
      eqMock.mockReturnValue({
        eq: eqMock,
        order: orderMock,
      });
      orderMock.mockReturnValue({
        order: orderMock,
        then: (resolve: any) => resolve({ data: [{ id: 'pw-1', day_of_week: 1, posting_time: '10:00' }], error: null }),
      });

      const mockClient = {
        from: vi.fn().mockReturnValue({ select: selectMock }),
      };

      const res = await schedulingDb.getPostingWindows(
        mockClient as any,
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000999'
      );

      expect(mockClient.from).toHaveBeenCalledWith('account_posting_windows');
      expect(eqMock).toHaveBeenCalledWith('workspace_id', '00000000-0000-0000-0000-000000000001');
      expect(eqMock).toHaveBeenCalledWith('account_id', '00000000-0000-0000-0000-000000000999');
      expect(res.length).toBe(1);
    });

    it('fetchDispatchesLedger enforces workspace_id boundary on pa_pins and pa_repurpose_batches', async () => {
      const eqMock = vi.fn().mockReturnThis();
      const inMock = vi.fn().mockReturnThis();
      const selectMock = vi.fn().mockReturnValue({
        eq: eqMock,
        in: inMock,
      });

      // Chain: from('...').select('...').eq('workspace_id', ...).in('id', ...)
      const builderMock: any = {
        in: vi.fn().mockResolvedValue({ data: [], error: null }),
        gte: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({
          data: [
            {
              id: 'disp-1',
              batch_id: 'batch-1',
              pa_pin_id: 'pa-pin-1',
              target_account_id: 'acc-1',
              target_account_label: 'Target',
              target_board_name: 'Board',
              link_used: 'https://example.com',
              p1_pin_id: 'p1-pin-1',
              sent_at: '2026-09-01T00:00:00Z',
              sent_by: 'user-1',
            },
          ],
          error: null,
        }),
      };
      eqMock.mockReturnValue(builderMock);

      const mockPaAdmin = {
        from: vi.fn().mockReturnValue({ select: selectMock }),
      };
      const mockP1Admin = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        }),
      };

      const { fetchDispatchesLedger } = await import('../services/dispatched-service');
      await fetchDispatchesLedger(mockPaAdmin as any, mockP1Admin as any, {
        workspaceId: '00000000-0000-0000-0000-000000000001',
      });

      // Check that pa_pins and pa_repurpose_batches were queried with workspace_id
      expect(mockPaAdmin.from).toHaveBeenCalledWith('pa_pins');
      expect(mockPaAdmin.from).toHaveBeenCalledWith('pa_repurpose_batches');
      expect(eqMock).toHaveBeenCalledWith('workspace_id', '00000000-0000-0000-0000-000000000001');
    });
  });

  describe('Vector 4: Batch Chunking Protection (Chunk Size = 500)', () => {
    it('createPinsBatch chunks payloads greater than 500 rows into multiple queries', async () => {
      const insertMock = vi.fn();
      const mockClient = {
        from: vi.fn().mockReturnValue({
          insert: insertMock,
        }),
      };

      // Create 1,200 pin records
      const dummyPins = Array.from({ length: 1200 }, (_, i) => ({
        account_id: '00000000-0000-0000-0000-000000000001',
        title: `Pin ${i}`,
        description: null,
        image_url: `https://images.example.com/${i}.jpg`,
        board_name: 'Boards',
        link: null,
        status: 'pending' as const,
        source: 'manual',
        scheduled_for: null,
      }));

      insertMock.mockImplementation((chunk: any[]) => ({
        select: vi.fn().mockResolvedValue({
          data: chunk.map((c, idx) => ({ ...c, id: `pin-${idx}`, attempts: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() })),
          error: null,
        }),
      }));

      const results = await schedulingDb.createPinsBatch(
        mockClient as any,
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000002',
        dummyPins
      );

      // 1,200 rows with CHUNK_SIZE = 500 => 3 chunks (500, 500, 200)
      expect(insertMock).toHaveBeenCalledTimes(3);
      expect(insertMock.mock.calls[0][0].length).toBe(500);
      expect(insertMock.mock.calls[1][0].length).toBe(500);
      expect(insertMock.mock.calls[2][0].length).toBe(200);
      expect(results.length).toBe(1200);
    });

    it('upsertCompetitorsBatch chunks payloads greater than 500 rows into multiple queries', async () => {
      const upsertMock = vi.fn();
      const mockCompetitorClient = {
        from: vi.fn().mockReturnValue({
          upsert: upsertMock,
        }),
      };

      upsertMock.mockImplementation((chunk: any[]) => ({
        select: vi.fn().mockResolvedValue({
          data: chunk.map((c, idx) => ({ ...c, id: `comp-${idx}` })),
          error: null,
        }),
      }));

      const { dbClients } = await import('../db/clients');
      vi.spyOn(dbClients, 'getCompetitors').mockReturnValue(mockCompetitorClient as any);

      // Create 1,050 competitor records
      const dummyComps = Array.from({ length: 1050 }, (_, i) => ({
        username: `creator_${i}`,
        profile_reach: 1000,
      }));

      const results = await competitorsDb.upsertCompetitorsBatch('00000000-0000-0000-0000-000000000001', dummyComps);

      // 1,050 rows with CHUNK_SIZE = 500 => 3 chunks (500, 500, 50)
      expect(upsertMock).toHaveBeenCalledTimes(3);
      expect(upsertMock.mock.calls[0][0].length).toBe(500);
      expect(upsertMock.mock.calls[1][0].length).toBe(500);
      expect(upsertMock.mock.calls[2][0].length).toBe(50);
      expect(results.length).toBe(1050);
    });

    it('upsertTopPinsSnapshots chunks payloads greater than 500 rows into multiple queries', async () => {
      const upsertMock = vi.fn();
      const mockAnalyticsClient = {
        from: vi.fn().mockReturnValue({
          upsert: upsertMock,
        }),
      };

      upsertMock.mockImplementation((chunk: any[]) => ({
        select: vi.fn(),
        count: chunk.length,
        error: null,
      }));

      const { dbClients } = await import('../db/clients');
      vi.spyOn(dbClients, 'getAnalytics').mockReturnValue(mockAnalyticsClient as any);
      const { analyticsDb } = await import('../db/analytics');

      // Create 1,200 snapshot records
      const dummySnapshots = Array.from({ length: 1200 }, (_, i) => ({
        pin_id: `pin_${i}`,
        window_start: '2026-09-01',
        window_end: '2026-09-07',
        sort_by: 'IMPRESSION' as const,
        rank_position: i + 1,
        impressions: 1000,
        engagement: 50,
        outbound_clicks: 10,
        pin_clicks: 20,
        saves: 5,
      }));

      const count = await analyticsDb.upsertTopPinsSnapshots(
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000002',
        dummySnapshots as any
      );

      // 1,200 rows with CHUNK_SIZE = 500 => 3 chunks (500, 500, 200)
      expect(upsertMock).toHaveBeenCalledTimes(3);
      expect(upsertMock.mock.calls[0][0].length).toBe(500);
      expect(upsertMock.mock.calls[1][0].length).toBe(500);
      expect(upsertMock.mock.calls[2][0].length).toBe(200);
      expect(count).toBe(1200);
    });
  });

  describe('Vector 5: UTC Date Skew & Midnight Falsy Coercion', () => {
    it('analytics queries compute startDate using UTC date methods (setUTCDate/getUTCDate)', async () => {
      const gteMock = vi.fn().mockReturnValue({
        order: vi.fn().mockResolvedValue({ data: [], error: null }),
      });
      const eqMock = vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          gte: gteMock,
        }),
      });
      const selectMock = vi.fn().mockReturnValue({
        eq: eqMock,
      });
      const mockAnalyticsClient = {
        from: vi.fn().mockReturnValue({
          select: selectMock,
        }),
      };

      const { dbClients } = await import('../db/clients');
      vi.spyOn(dbClients, 'getAnalytics').mockReturnValue(mockAnalyticsClient as any);
      const { analyticsDb } = await import('../db/analytics');

      await analyticsDb.getDailyTimeSeries(
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000002',
        30
      );

      // Compute expected UTC date string
      const expectedDate = new Date();
      expectedDate.setUTCDate(expectedDate.getUTCDate() - 30);
      const expectedStr = expectedDate.toISOString().split('T')[0];

      expect(gteMock).toHaveBeenCalledWith('metric_date', expectedStr);
    });
  });
});

