import { describe, it, expect, vi, beforeEach } from 'vitest';
import { analyticsDb } from '../db/analytics';
import { dbClients } from '../db/clients';
import { GET as topPinsGET } from '../../pages/api/analytics/top-pins';
import { GET as connectionTopPinsGET } from '../../pages/api/analytics/connections/[id]/top-pins';
import { pinnerAnalyticsService } from '../services/pinner-analytics-service';
import { assertWorkspaceAccess } from '../auth/workspace-guard';

vi.mock('../db/clients', () => ({
  dbClients: {
    getAnalytics: vi.fn(),
  },
}));

vi.mock('../services/pinner-analytics-service', () => ({
  pinnerAnalyticsService: {
    getTopPins: vi.fn().mockResolvedValue({ data: [], cacheStatus: 'MISS' }),
    getTopPinsServerPaginated: vi.fn().mockResolvedValue({ data: { pins: [], total: 0 }, cacheStatus: 'MISS' }),
  },
}));

vi.mock('../auth/workspace-guard', () => ({
  assertWorkspaceAccess: vi.fn(),
}));

vi.mock('../../lib/edge-kv', () => ({
  getAnalyticsKV: vi.fn().mockReturnValue(null),
}));

describe('P1 #5 & P1 #7: Analytics Ingestion Run Sweeper & Cache Bypass Gating Suite', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000001';
  const connectionId = 'a1b2c3d4-e5f6-7890-1234-56789abcdef0';
  const userId = 'user-test-uuid';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('P1 #5: Ingestion Run Sweeper Workspace Scoping', () => {
    it('scopes stale processing run sweeper to workspace_id and connection_id', async () => {
      const eqCalls: Array<[string, any]> = [];
      const updateMock = vi.fn().mockReturnThis();

      const mockClient: any = {
        from: vi.fn((table: string) => {
          if (table === 'analytics_ingestion_runs') {
            return {
              update: updateMock,
              eq: vi.fn((col: string, val: any) => {
                eqCalls.push([col, val]);
                return mockClient.from(table);
              }),
              lt: vi.fn().mockResolvedValue({ error: null }),
              insert: vi.fn().mockReturnValue({
                select: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: {
                      id: 'run-1',
                      workspace_id: workspaceId,
                      connection_id: connectionId,
                      status: 'processing',
                    },
                    error: null,
                  }),
                }),
              }),
            };
          }
          return {};
        }),
      };

      (dbClients.getAnalytics as any).mockReturnValue(mockClient);

      await analyticsDb.createIngestionRun({
        workspace_id: workspaceId,
        connection_id: connectionId,
        channel: 'account_analytics',
        job_type: 'daily_sync',
      });

      // Verify the sweeper called update
      expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          error_details: { error: 'stale_processing_timeout' },
        })
      );

      // Verify tenant isolation: .eq('workspace_id', workspaceId) was called
      expect(eqCalls).toContainEqual(['workspace_id', workspaceId]);
      expect(eqCalls).toContainEqual(['connection_id', connectionId]);
      expect(eqCalls).toContainEqual(['status', 'processing']);
    });
  });

  describe('P1 #7: Top Pins Cache Bypass Gating', () => {
    const makeRequest = (url: string) => new Request(url, { method: 'GET' });
    const mockLocals = {
      user: { id: userId, email: 'test@example.com' },
      supabase: {} as any,
      activeWorkspaceId: workspaceId,
    };

    it('permits cache_bypass=1 for admin users', async () => {
      (assertWorkspaceAccess as any).mockResolvedValue({
        isAdmin: true,
        isOwner: false,
        role: 'admin',
      });

      const req = makeRequest(`https://app.pinorbit.com/api/analytics/top-pins?workspace_id=${workspaceId}&connection_id=${connectionId}&cache_bypass=1`);
      const res = await topPinsGET({ request: req, locals: mockLocals } as any);

      expect(res.status).toBe(200);
      expect(pinnerAnalyticsService.getTopPins).toHaveBeenCalledWith(
        mockLocals.supabase,
        userId,
        workspaceId,
        connectionId,
        'IMPRESSION',
        50,
        null,
        true, // bypassCache must be TRUE for admin
        undefined,
        undefined
      );
    });

    it('permits cache_bypass=1 for owner users', async () => {
      (assertWorkspaceAccess as any).mockResolvedValue({
        isAdmin: false,
        isOwner: true,
        role: 'owner',
      });

      const req = makeRequest(`https://app.pinorbit.com/api/analytics/top-pins?workspace_id=${workspaceId}&connection_id=${connectionId}&cache_bypass=1`);
      const res = await topPinsGET({ request: req, locals: mockLocals } as any);

      expect(res.status).toBe(200);
      expect(pinnerAnalyticsService.getTopPins).toHaveBeenCalledWith(
        mockLocals.supabase,
        userId,
        workspaceId,
        connectionId,
        'IMPRESSION',
        50,
        null,
        true, // bypassCache must be TRUE for owner
        undefined,
        undefined
      );
    });

    it('denies cache_bypass=1 for non-admin members (passes bypassCache = false)', async () => {
      (assertWorkspaceAccess as any).mockResolvedValue({
        isAdmin: false,
        isOwner: false,
        role: 'member',
      });

      const req = makeRequest(`https://app.pinorbit.com/api/analytics/top-pins?workspace_id=${workspaceId}&connection_id=${connectionId}&cache_bypass=1`);
      const res = await topPinsGET({ request: req, locals: mockLocals } as any);

      expect(res.status).toBe(200);
      expect(pinnerAnalyticsService.getTopPins).toHaveBeenCalledWith(
        mockLocals.supabase,
        userId,
        workspaceId,
        connectionId,
        'IMPRESSION',
        50,
        null,
        false, // bypassCache must be FALSE for member
        undefined,
        undefined
      );
    });

    it('connection top-pins denies cache_bypass=1 for non-admin members', async () => {
      (assertWorkspaceAccess as any).mockResolvedValue({
        isAdmin: false,
        isOwner: false,
        role: 'member',
      });

      const req = makeRequest(`https://app.pinorbit.com/api/analytics/connections/${connectionId}/top-pins?workspace_id=${workspaceId}&cache_bypass=1`);
      const res = await connectionTopPinsGET({ request: req, locals: mockLocals, params: { id: connectionId } } as any);

      expect(res.status).toBe(200);
      expect(pinnerAnalyticsService.getTopPinsServerPaginated).toHaveBeenCalledWith(
        mockLocals.supabase,
        userId,
        workspaceId,
        connectionId,
        'IMPRESSION',
        50,
        null,
        false, // bypassCache must be FALSE for member
        undefined,
        undefined,
        1,
        25,
        ''
      );
    });
  });
});
