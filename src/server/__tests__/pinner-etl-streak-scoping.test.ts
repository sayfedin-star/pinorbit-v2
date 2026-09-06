import { describe, it, expect, beforeEach, vi } from 'vitest';
import { pinnerETL } from '../services/pinner-etl';
import { dbClients } from '../db/clients';

vi.mock('../db/analytics', () => ({
  analyticsDb: {
    createIngestionRun: vi.fn().mockResolvedValue({ id: 'run-1' }),
    completeIngestionRun: vi.fn().mockResolvedValue(undefined),
    failIngestionRun: vi.fn().mockResolvedValue(undefined),
    checkConsecutiveFailures: vi.fn().mockResolvedValue(false),
    upsertAccountDailyMetrics: vi.fn().mockResolvedValue(1),
    upsertAccountSummary: vi.fn().mockResolvedValue(undefined),
    upsertTopPinsSnapshots: vi.fn().mockResolvedValue(1),
    upsertDailyWorkspaceMetrics: vi.fn().mockResolvedValue(1),
    updateConnectionLastSync: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('Pinner ETL: Multi-Tenant & Channel Scoped Failure Streak Tracking', () => {
  const wsId = '11111111-1111-1111-1111-111111111111';
  const conn1 = 'conn-111';
  const conn2 = 'conn-222';

  let connectionsDb: any[];

  beforeEach(() => {
    vi.clearAllMocks();
    pinnerETL.resetFailureStreak(wsId);

    connectionsDb = [
      { id: conn1, workspace_id: wsId, analytics_enabled: true, deleted_at: null },
      { id: conn2, workspace_id: wsId, analytics_enabled: true, deleted_at: null },
    ];

    const mockAnalyticsClient = {
      from: (table: string) => {
        let filterEq: Record<string, any> = {};
        const builder: any = {
          select: vi.fn(() => builder),
          eq: vi.fn((col: string, val: any) => {
            filterEq[col] = val;
            return builder;
          }),
          is: vi.fn(() => builder),
          maybeSingle: vi.fn(async () => {
            if (table === 'analytics_connections') {
              const conn = connectionsDb.find((c) => c.id === filterEq.id && c.workspace_id === filterEq.workspace_id);
              return { data: conn || null, error: null };
            }
            return { data: null, error: null };
          }),
        };
        return builder;
      },
    };

    vi.spyOn(dbClients, 'getAnalytics').mockReturnValue(mockAnalyticsClient as any);
  });

  it('scopes failure streaks strictly to workspaceId:connectionId:channel', async () => {
    // Fail conn1 on account_analytics twice
    const failPayload1 = {
      workspace_id: wsId,
      connection_id: conn1,
      channel: 'account_analytics' as const,
      success: false,
      error_details: { http_status: 500, error_message: 'Pinterest 500 Internal Error' },
    };

    await pinnerETL.processIngestionPayload(failPayload1);
    expect(pinnerETL.getFailureStreak(wsId, conn1, 'account_analytics')).toBe(1);

    await pinnerETL.processIngestionPayload(failPayload1);
    expect(pinnerETL.getFailureStreak(wsId, conn1, 'account_analytics')).toBe(2);

    // Assert that conn2 within the same workspace is NOT affected
    expect(pinnerETL.getFailureStreak(wsId, conn2, 'account_analytics')).toBe(0);

    // Assert that top_pins channel on conn1 is NOT affected
    expect(pinnerETL.getFailureStreak(wsId, conn1, 'top_pins')).toBe(0);
  });

  it('resets only the specific channel streak on success', async () => {
    // Fail conn1 on account_analytics
    await pinnerETL.processIngestionPayload({
      workspace_id: wsId,
      connection_id: conn1,
      channel: 'account_analytics',
      success: false,
      error_details: { http_status: 500, error_message: 'Error' },
    });

    // Fail conn1 on top_pins
    await pinnerETL.processIngestionPayload({
      workspace_id: wsId,
      connection_id: conn1,
      channel: 'top_pins',
      success: false,
      error_details: { http_status: 500, error_message: 'Error' },
    });

    expect(pinnerETL.getFailureStreak(wsId, conn1, 'account_analytics')).toBe(1);
    expect(pinnerETL.getFailureStreak(wsId, conn1, 'top_pins')).toBe(1);

    // Send successful ingestion for account_analytics
    await pinnerETL.processIngestionPayload({
      workspace_id: wsId,
      connection_id: conn1,
      channel: 'account_analytics',
      success: true,
      account_analytics: [
        { date: '2026-09-01', impressions: 100, saves: 10, pin_clicks: 5, outbound_clicks: 2 },
      ],
    });

    // account_analytics streak is reset, but top_pins streak remains active
    expect(pinnerETL.getFailureStreak(wsId, conn1, 'account_analytics')).toBe(0);
    expect(pinnerETL.getFailureStreak(wsId, conn1, 'top_pins')).toBe(1);
  });

  it('resetFailureStreak(workspaceId) purges all connection and channel streaks under that workspace prefix', async () => {
    await pinnerETL.processIngestionPayload({
      workspace_id: wsId,
      connection_id: conn1,
      channel: 'account_analytics',
      success: false,
    });
    await pinnerETL.processIngestionPayload({
      workspace_id: wsId,
      connection_id: conn2,
      channel: 'top_pins',
      success: false,
    });

    expect(pinnerETL.getFailureStreak(wsId, conn1, 'account_analytics')).toBe(1);
    expect(pinnerETL.getFailureStreak(wsId, conn2, 'top_pins')).toBe(1);

    // Call resetFailureStreak with only workspaceId
    pinnerETL.resetFailureStreak(wsId);

    expect(pinnerETL.getFailureStreak(wsId, conn1, 'account_analytics')).toBe(0);
    expect(pinnerETL.getFailureStreak(wsId, conn2, 'top_pins')).toBe(0);
  });
});
