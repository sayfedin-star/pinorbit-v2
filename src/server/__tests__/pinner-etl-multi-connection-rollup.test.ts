import { describe, it, expect, beforeEach, vi } from 'vitest';
import { pinnerETL } from '../services/pinner-etl';
import { analyticsDb } from '../db/analytics';
import { dbClients } from '../db/clients';
import type { PinnerIngestPayload } from '../../lib/types';

vi.mock('../db/analytics', () => ({
  analyticsDb: {
    createIngestionRun: vi.fn().mockResolvedValue({ id: 'mock-run-id' }),
    completeIngestionRun: vi.fn().mockResolvedValue(undefined),
    failIngestionRun: vi.fn().mockResolvedValue(undefined),
    checkConsecutiveFailures: vi.fn().mockResolvedValue(false),
    upsertAccountDailyMetrics: vi.fn().mockResolvedValue(1),
    upsertAccountSummary: vi.fn().mockResolvedValue(undefined),
    upsertTopPinsSnapshots: vi.fn().mockResolvedValue(0),
    upsertDailyWorkspaceMetrics: vi.fn().mockResolvedValue(1),
    updateConnectionLastSync: vi.fn().mockResolvedValue(undefined),
  },
}));

const mockDailyRecords = [
  {
    metric_date: '2026-08-01',
    impressions: 1000,
    engagements: 50,
    saves: 10,
    outbound_clicks: 5,
    pin_clicks: 20,
    profile_visits: 2,
  },
  {
    metric_date: '2026-08-01',
    impressions: 500,
    engagements: 25,
    saves: 5,
    outbound_clicks: 2,
    pin_clicks: 10,
    profile_visits: 1,
  },
];

vi.mock('../db/clients', () => ({
  dbClients: {
    getConfig: vi.fn().mockReturnValue({
      INGEST_SECRET_KEY: 'test-ingest-secret',
    }),
    getAnalytics: vi.fn().mockReturnValue({
      from: vi.fn((table: string) => {
        const chain: any = {
          upsert: vi.fn().mockResolvedValue({ error: null }),
          update: vi.fn().mockReturnThis(),
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: vi.fn().mockReturnThis(),
          lt: vi.fn().mockReturnThis(),
          is: vi.fn().mockReturnThis(),
          then: vi.fn().mockImplementation((fn: any) => {
            if (table === 'account_analytics_daily') {
              return Promise.resolve(fn ? fn({ data: mockDailyRecords, error: null }) : { data: mockDailyRecords, error: null });
            }
            return Promise.resolve(fn ? fn({ error: null }) : { error: null });
          }),
          maybeSingle: vi.fn().mockImplementation(async () => ({
            data: {
              id: 'a1b2c3d4-e5f6-7890-1234-56789abcdef0',
              workspace_id: '00000000-0000-0000-0000-000000000001',
              analytics_enabled: true,
            },
            error: null,
          })),
        };
        return chain;
      }),
    }),
  },
}));

describe('P1 #1: Pinner ETL Multi-Connection Daily Rollup Suite', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000001';
  const connectionId = 'a1b2c3d4-e5f6-7890-1234-56789abcdef0';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('re-sums multi-connection daily metrics across affected dates into daily_workspace_metrics', async () => {
    const payload: PinnerIngestPayload = {
      success: true,
      workspace_id: workspaceId,
      connection_id: connectionId,
      window_start: '2026-08-01T00:00:00Z',
      window_end: '2026-08-01T23:59:59Z',
      account_analytics: {
        all: {
          daily_metrics: [
            {
              date: '2026-08-01',
              data_status: 'READY',
              metrics: {
                IMPRESSION: 500,
                ENGAGEMENT: 25,
                SAVE: 5,
                OUTBOUND_CLICK: 2,
                PIN_CLICK: 10,
              },
            },
          ],
        },
      },
    };

    const res = await pinnerETL.processIngestionPayload(payload);
    expect(res.success).toBe(true);

    // Verify upsertDailyWorkspaceMetrics received sum of Connection 1 (1000) + Connection 2 (500) = 1500
    expect(analyticsDb.upsertDailyWorkspaceMetrics).toHaveBeenCalledTimes(1);
    expect(analyticsDb.upsertDailyWorkspaceMetrics).toHaveBeenCalledWith(
      workspaceId,
      expect.arrayContaining([
        expect.objectContaining({
          metric_date: '2026-08-01',
          total_impressions: 1500,
          total_engagements: 75,
          total_saves: 15,
          total_outbound_clicks: 7,
          total_pin_clicks: 30,
          total_profile_visits: 3,
        }),
      ])
    );
  });

  it('overlays top pins aggregates onto the latest date after DB re-sum', async () => {
    const payload: PinnerIngestPayload = {
      success: true,
      workspace_id: workspaceId,
      connection_id: connectionId,
      request_context: {
        start_date: '2026-08-01',
        end_date: '2026-08-01',
      },
      window_start: '2026-08-01T00:00:00Z',
      window_end: '2026-08-01T23:59:59Z',
      account_analytics: {
        all: {
          daily_metrics: [
            {
              date: '2026-08-01',
              data_status: 'READY',
              metrics: {
                IMPRESSION: 500,
                ENGAGEMENT: 25,
                SAVE: 5,
                OUTBOUND_CLICK: 2,
                PIN_CLICK: 10,
              },
            },
          ],
        },
      },
      top_pins_analytics: {
        sort_by: 'IMPRESSION',
        pins: [
          {
            pin_id: 'pin_1',
            sort_by: 'IMPRESSION',
            data_status: 'READY',
            metrics: {
              IMPRESSION: 400,
              OUTBOUND_CLICK: 10,
              SAVE: 8,
            },
          },
        ],
      },
    };

    const res = await pinnerETL.processIngestionPayload(payload);
    expect(res.success).toBe(true);

    expect(analyticsDb.upsertDailyWorkspaceMetrics).toHaveBeenCalledWith(
      workspaceId,
      expect.arrayContaining([
        expect.objectContaining({
          metric_date: '2026-08-01',
          total_impressions: 1500,
          top_pin_impressions: 400,
          top_pin_outbound_clicks: 10,
          top_pin_saves: 8,
          active_top_pins_count: 1,
        }),
      ])
    );
  });
});
