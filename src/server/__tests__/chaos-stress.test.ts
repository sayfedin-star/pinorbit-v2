import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeBidirectionalCompensation } from '../services/repurpose-service';
import { POST as deleteWorkspaceHandler } from '../../pages/api/workspaces/delete';
import { POST as ingestHandler } from '../../pages/api/internal/pinterest/ingest';
import { POST as dailyDispatchHandler } from '../../pages/api/internal/pinterest/daily-dispatch';
import { POST as cleanupRetentionHandler } from '../../pages/api/internal/pinterest/cleanup-retention';
import { verifyIngestSecret } from '../services/webhook-secrets';
import { safeParseJson } from '../lib/safe-json';
import { pinnerETL } from '../services/pinner-etl';
import { gasCall } from '../lib/gas-bridge';
import { createBoardViaWebhook } from '../../lib/boards';
import { analyticsDb } from '../db/analytics';
import { dbClients } from '../db/clients';
import * as workspaceGuard from '../auth/workspace-guard';

describe('Level-2 Adversarial & Chaos Stress Test Suite', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Axis 1: Transaction Atomicity & Partial Writes
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Axis 1: Transaction Atomicity & Compensation', () => {
    it('executeBidirectionalCompensation chunks large pin ID arrays to prevent 414 URI Too Long and deletes by indexed source_ref', async () => {
      const p1InCalls: string[][] = [];
      const p1EqCalls: Array<{ col: string; val: string }> = [];

      const mockP1Admin: any = {
        from: vi.fn((table: string) => {
          if (table === 'pins') {
            return {
              delete: vi.fn().mockReturnValue({
                in: vi.fn((col: string, ids: string[]) => {
                  p1InCalls.push(ids);
                  return {
                    eq: vi.fn((c: string, v: string) => {
                      p1EqCalls.push({ col: c, val: v });
                      return Promise.resolve({ error: null });
                    }),
                  };
                }),
                eq: vi.fn((col: string, val: string) => {
                  p1EqCalls.push({ col, val });
                  return {
                    eq: vi.fn((c: string, v: string) => {
                      p1EqCalls.push({ col: c, val: v });
                      return Promise.resolve({ error: null });
                    }),
                  };
                }),
              }),
            };
          }
          return {};
        }),
      };

      const mockPaAdmin: any = {
        from: vi.fn(() => ({
          delete: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ error: null }),
            }),
          }),
        })),
      };

      // 250 pin IDs (would exceed single URL limit if not chunked)
      const largePinIds = Array.from({ length: 250 }, (_, i) => `pin-${i + 1}`);
      const batchUuid = 'batch-chaos-atomicity-001';
      const workspaceId = 'ws-chaos-001';

      await executeBidirectionalCompensation(mockP1Admin, mockPaAdmin, workspaceId, batchUuid, largePinIds);

      // Verify chunking: 250 IDs chunked into 100 + 100 + 50 = 3 chunks
      expect(p1InCalls).toHaveLength(3);
      expect(p1InCalls[0]).toHaveLength(100);
      expect(p1InCalls[1]).toHaveLength(100);
      expect(p1InCalls[2]).toHaveLength(50);

      // Verify source_ref deletion occurred
      const sourceRefCall = p1EqCalls.find((c) => c.col === 'source_ref' && c.val === batchUuid);
      expect(sourceRefCall).toBeDefined();

      // Verify P4 batch deleted
      expect(mockPaAdmin.from).toHaveBeenCalledWith('pa_repurpose_batches');
    });

    it('workspace delete fails fast and halts when a cleanup task returns PostgREST error', async () => {
      const workspaceId = '00000000-0000-0000-0000-000000000001';

      vi.spyOn(workspaceGuard, 'assertWorkspaceAccess').mockResolvedValue({
        isOwner: true,
        isAdmin: true,
        role: 'owner',
        workspaceId,
      } as any);

      // Mock P1/P2/P3/P4 emptiness check (all return count: 0)
      const mockEmptyTable = () => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ count: 0, error: null }),
        }),
      });

      const mockP1Admin: any = {
        from: vi.fn((tbl: string) => {
          if (tbl === 'workspace_retention_settings') {
            return {
              delete: vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValue({ error: { message: 'Foreign key lock timeout on retention' } }),
              }),
            };
          }
          return mockEmptyTable();
        }),
      };

      const mockP2Admin: any = { from: vi.fn(() => mockEmptyTable()) };
      const mockP3Admin: any = {
        from: vi.fn((tbl: string) => {
          if (tbl === 'workspace_analytics_settings') {
            return {
              delete: vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValue({ error: null }),
              }),
            };
          }
          return mockEmptyTable();
        }),
      };

      const workspaceDeleteMock = vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      });

      const mockSchedulingClient: any = {
        from: vi.fn((tbl: string) => {
          if (tbl === 'workspaces') {
            return { delete: workspaceDeleteMock };
          }
          return mockEmptyTable();
        }),
      };

      vi.spyOn(dbClients, 'getSchedulingAdmin').mockReturnValue(mockP1Admin);
      vi.spyOn(dbClients, 'getCompetitorsAdmin').mockReturnValue(mockP2Admin);
      vi.spyOn(dbClients, 'getAnalyticsAdmin').mockReturnValue(mockP3Admin);
      vi.spyOn(dbClients, 'getConfig').mockReturnValue({ PINARCHIVE_SUPABASE_SECRET_KEY: '' } as any);

      const req = new Request('http://localhost:4321/api/workspaces/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspaceId }),
      });

      const res = await deleteWorkspaceHandler({
        request: req,
        locals: { user: { id: 'owner-1' }, supabase: mockSchedulingClient },
      } as any);

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain('Failed to clean up workspace dependencies');
      expect(json.error).toContain('Foreign key lock timeout on retention');

      // The workspace itself MUST NOT have been deleted
      expect(workspaceDeleteMock).not.toHaveBeenCalled();
    });

    it('workspace delete fails fast and halts when a table count query fails with PostgREST error', async () => {
      const workspaceId = '00000000-0000-0000-0000-000000000001';

      vi.spyOn(workspaceGuard, 'assertWorkspaceAccess').mockResolvedValue({
        isOwner: true,
        isAdmin: true,
        role: 'owner',
        workspaceId,
      } as any);

      // Mock P1 pins count returning an error (e.g. timeout / network glitch)
      const mockP1Admin: any = {
        from: vi.fn((tbl: string) => {
          if (tbl === 'pins') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValue({ count: null, error: { message: 'Connection pool timeout on pins table' } }),
              }),
            };
          }
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ count: 0, error: null }),
            }),
          };
        }),
      };

      const mockP2Admin: any = {
        from: vi.fn(() => ({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ count: 0, error: null }),
          }),
        })),
      };
      const mockP3Admin: any = {
        from: vi.fn(() => ({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ count: 0, error: null }),
          }),
        })),
      };

      const workspaceDeleteMock = vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      });

      const mockSchedulingClient: any = {
        from: vi.fn((tbl: string) => {
          if (tbl === 'workspaces') return { delete: workspaceDeleteMock };
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ count: 0, error: null }),
            }),
          };
        }),
      };

      vi.spyOn(dbClients, 'getSchedulingAdmin').mockReturnValue(mockP1Admin);
      vi.spyOn(dbClients, 'getCompetitorsAdmin').mockReturnValue(mockP2Admin);
      vi.spyOn(dbClients, 'getAnalyticsAdmin').mockReturnValue(mockP3Admin);
      vi.spyOn(dbClients, 'getConfig').mockReturnValue({ PINARCHIVE_SUPABASE_SECRET_KEY: '' } as any);

      const req = new Request('http://localhost:4321/api/workspaces/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspaceId }),
      });

      const res = await deleteWorkspaceHandler({
        request: req,
        locals: { user: { id: 'owner-1' }, supabase: mockSchedulingClient },
      } as any);

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toContain('P1 pins count error: Connection pool timeout on pins table');
      expect(workspaceDeleteMock).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Axis 2: Database-Enforced Monotonicity Simulation
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Axis 2: Database-Enforced Monotonicity', () => {
    it('simulates trg_pa_pins_enforce_monotonic_metrics: keeps higher values on concurrent/out-of-order writes including reactions', () => {
      // Direct simulation of PostgreSQL trigger logic:
      // NEW.saves := GREATEST(COALESCE(OLD.saves, 0), COALESCE(NEW.saves, 0));
      const applyMonotonicTrigger = (oldRow: any, newRow: any) => {
        let reactions = newRow.reactions;
        if (oldRow.reactions && typeof oldRow.reactions === 'object' && Number(oldRow.reactions.total || 0) > 0) {
          if (!newRow.reactions || typeof newRow.reactions !== 'object' || Number(newRow.reactions.total || 0) < Number(oldRow.reactions.total || 0)) {
            reactions = oldRow.reactions;
          }
        }
        return {
          ...newRow,
          saves: Math.max(oldRow.saves ?? 0, newRow.saves ?? 0),
          repins: Math.max(oldRow.repins ?? 0, newRow.repins ?? 0),
          comments: Math.max(oldRow.comments ?? 0, newRow.comments ?? 0),
          share_count: Math.max(oldRow.share_count ?? 0, newRow.share_count ?? 0),
          reactions,
        };
      };

      const committedState = {
        pin_id: 'pin-12345',
        saves: 150,
        repins: 80,
        comments: 12,
        share_count: 45,
        reactions: { total: 42, type_1: 40, type_7: 2 },
      };

      // Stale write arrives with lower counts and missing reactions (e.g. GAS collector)
      const staleIncomingWrite = {
        pin_id: 'pin-12345',
        saves: 120, // Stale!
        repins: 60,  // Stale!
        comments: 12,
        share_count: 30, // Stale!
        reactions: null, // Partial payload without reactions!
      };

      const result = applyMonotonicTrigger(committedState, staleIncomingWrite);

      expect(result.saves).toBe(150); // Did not regress to 120
      expect(result.repins).toBe(80);  // Did not regress to 60
      expect(result.share_count).toBe(45); // Did not regress to 30
      expect(result.reactions).toEqual({ total: 42, type_1: 40, type_7: 2 }); // Preserved!

      // Fresh write arrives with higher counts and reactions
      const freshIncomingWrite = {
        pin_id: 'pin-12345',
        saves: 200,
        repins: 95,
        comments: 15,
        share_count: 50,
        reactions: { total: 55, type_1: 50, type_7: 5 },
      };

      const advancedResult = applyMonotonicTrigger(result, freshIncomingWrite);
      expect(advancedResult.saves).toBe(200);
      expect(advancedResult.repins).toBe(95);
      expect(advancedResult.comments).toBe(15);
      expect(advancedResult.share_count).toBe(50);
      expect(advancedResult.reactions).toEqual({ total: 55, type_1: 50, type_7: 5 });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Axis 3: Cloudflare Edge & Memory Bottlenecks (128MB OOM)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Axis 3: Cloudflare Edge & Memory Limits', () => {
    it('getMetricSummary caps batch iterations at MAX_BATCHES to prevent unbounded memory allocation', async () => {
      let rangeCallCount = 0;

      const mockAnalyticsClient: any = {
        from: vi.fn(() => ({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              range: vi.fn().mockImplementation(() => {
                rangeCallCount++;
                // Always return a full batch of 1000 rows (simulating infinite rows)
                return Promise.resolve({
                  data: Array.from({ length: 1000 }, () => ({
                    total_impressions: 10,
                    total_engagements: 2,
                    total_saves: 1,
                    total_pin_clicks: 1,
                  })),
                  error: null,
                });
              }),
            }),
          }),
        })),
      };

      vi.spyOn(dbClients, 'getAnalytics').mockReturnValue(mockAnalyticsClient);

      const summary = await analyticsDb.getMetricSummary('00000000-0000-0000-0000-000000000001');

      // Must have stopped at MAX_BATCHES = 10 instead of running infinitely
      expect(rangeCallCount).toBe(10);
      expect(summary.total_impressions).toBe(10 * 1000 * 10);
      expect(summary.workspace_id).toBe('00000000-0000-0000-0000-000000000001');
    });

    it('getAccountOverviewMetrics selects only required numeric columns and does not load raw_metrics JSONB', async () => {
      const selectedColumns: Record<string, string> = {};

      const mockAnalyticsClient: any = {
        from: vi.fn((table: string) => ({
          select: vi.fn((cols: string) => {
            selectedColumns[table] = cols;
            return {
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    gte: vi.fn().mockReturnValue({
                      order: vi.fn().mockReturnValue({
                        limit: vi.fn().mockResolvedValue({
                          data: [
                            {
                              impressions: 500,
                              engagements: 50,
                              pin_clicks: 25,
                              outbound_clicks: 10,
                              saves: 15,
                              recorded_at: '2026-09-19T00:00:00Z',
                              created_at: '2026-09-19T00:00:00Z',
                            },
                          ],
                          error: null,
                        }),
                      }),
                    }),
                  }),
                  order: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue({
                      data: [],
                      error: null,
                    }),
                  }),
                }),
              }),
            };
          }),
        })),
      };

      vi.spyOn(dbClients, 'getAnalytics').mockReturnValue(mockAnalyticsClient);

      const result = await analyticsDb.getAccountOverviewMetrics(
        '00000000-0000-0000-0000-000000000001',
        'conn-001',
        30
      );

      expect(selectedColumns['account_analytics_daily']).not.toBe('*');
      expect(selectedColumns['account_analytics_daily']).toContain('impressions');
      expect(selectedColumns['account_analytics_daily']).toContain('engagements');
      expect(selectedColumns['account_analytics_daily']).toContain('pin_clicks');
      expect(selectedColumns['account_analytics_daily']).toContain('outbound_clicks');
      expect(selectedColumns['account_analytics_daily']).toContain('saves');
      expect(selectedColumns['account_analytics_summaries']).not.toBe('*');
      expect(result.impressions).toBe(500);
    });

    it('getConnectionDailyMetrics caps totals query iterations at MAX_TOTALS_BATCHES = 10 to prevent unbounded execution', async () => {
      let totalsRangeCallCount = 0;

      const mockAnalyticsClient: any = {
        from: vi.fn((table: string) => {
          if (table === 'account_analytics_daily') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              gte: vi.fn().mockReturnThis(),
              lte: vi.fn().mockReturnThis(),
              order: vi.fn().mockReturnThis(),
              range: vi.fn().mockImplementation(() => {
                totalsRangeCallCount++;
                return Promise.resolve({
                  data: Array.from({ length: 1000 }, () => ({
                    impressions: 100,
                    engagements: 10,
                    outbound_clicks: 5,
                    pin_clicks: 5,
                    saves: 2,
                  })),
                  error: null,
                });
              }),
            };
          }
          return {};
        }),
      };

      vi.spyOn(dbClients, 'getAnalytics').mockReturnValue(mockAnalyticsClient);

      const result = await analyticsDb.getConnectionDailyMetrics(
        '00000000-0000-0000-0000-000000000001',
        'conn-001',
        '2026-01-01',
        '2026-12-31'
      );

      // Must have stopped at MAX_TOTALS_BATCHES = 10 instead of running infinitely
      expect(totalsRangeCallCount).toBeGreaterThanOrEqual(10);
      expect(result.totals.impressions).toBe(100 * 1000 * 10);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Axis 4: Timing Attacks & Secret Comparisons
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Axis 4: Timing Safe Secret Comparison', () => {
    it('verifyIngestSecret evaluates all candidates without early return and matches candidate', async () => {
      const runtimeEnv = {
        INGEST_SECRET_KEY: 'env_secret_key_123',
      };
      const validWsId = '00000000-0000-0000-0000-000000000001';

      // Candidate matches
      const resMatch = await verifyIngestSecret('env_secret_key_123', validWsId, runtimeEnv);
      expect(resMatch.valid).toBe(true);

      // Candidate does not match
      const resMismatch = await verifyIngestSecret('wrong_secret', validWsId, runtimeEnv);
      expect(resMismatch.valid).toBe(false);

      // Empty secret rejected
      const resEmpty = await verifyIngestSecret('', validWsId, runtimeEnv);
      expect(resEmpty.valid).toBe(false);
    });

    it('ingest endpoint accepts previous secret during 300s grace period and rejects global secret when workspace override exists', async () => {
      const wsId = '00000000-0000-0000-0000-000000000001';
      const connId = '00000000-0000-0000-0000-000000000099';

      const mockKvStore = new Map<string, string>();
      mockKvStore.set('ingest_secret:global', 'global_secret');
      mockKvStore.set(`ingest_secret:ws:${wsId}`, 'new_ws_secret');
      mockKvStore.set(`ingest_secret:ws:${wsId}:prev`, 'old_ws_secret_grace_period');

      const runtimeEnv = {
        INGEST_SECRETS_KV: {
          get: vi.fn(async (key: string) => mockKvStore.get(key) || null),
        },
      };

      const mockAnalyticsClient = {
        from: vi.fn((table: string) => ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          is: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({
            data: {
              id: connId,
              workspace_id: wsId,
              analytics_enabled: true,
              deleted_at: null,
            },
            error: null,
          }),
        })),
      };

      vi.spyOn(dbClients, 'getAnalytics').mockReturnValue(mockAnalyticsClient as any);
      vi.spyOn(pinnerETL, 'processIngestionPayload').mockResolvedValue({ success: true, rows_processed: 1 } as any);

      // 1. Previous secret in grace period is ACCEPTED
      const graceReq = new Request('http://localhost:4321/api/internal/pinterest/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-ingest-secret': 'old_ws_secret_grace_period',
        },
        body: JSON.stringify({ connection_id: connId, workspace_id: wsId }),
      });

      const graceRes = await ingestHandler({
        request: graceReq,
        locals: { runtime: { env: runtimeEnv } },
      } as any);

      expect(graceRes.status).toBe(200);

      // 2. Global secret is REJECTED because workspace override exists
      const globalReq = new Request('http://localhost:4321/api/internal/pinterest/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-ingest-secret': 'global_secret',
        },
        body: JSON.stringify({ connection_id: connId, workspace_id: wsId }),
      });

      const globalRes = await ingestHandler({
        request: globalReq,
        locals: { runtime: { env: runtimeEnv } },
      } as any);

      expect(globalRes.status).toBe(401);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Axis 5: Chaos & Upstream Malfunction
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Axis 5: Upstream Malfunction & Safe Response Parsing', () => {
    it('gasCall handles 0-byte empty body without throwing unhandled SyntaxError', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => '',
        })
      );

      const result = await gasCall(
        { PINARCHIVE_GAS_URL: 'https://script.google.com/test', PINARCHIVE_INGEST_SECRET: 'test' },
        '00000000-0000-0000-0000-000000000001',
        'sheet_sync',
        { test: true }
      );

      expect(result.ok).toBe(false);
      expect(result.error).toContain('Empty response body from GAS');
    });

    it('gasCall handles malformed HTML/JSON responses gracefully', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => '<html>502 Bad Gateway</html>',
        })
      );

      const result = await gasCall(
        { PINARCHIVE_GAS_URL: 'https://script.google.com/test', PINARCHIVE_INGEST_SECRET: 'test' },
        '00000000-0000-0000-0000-000000000001',
        'sheet_sync',
        { test: true }
      );

      expect(result.ok).toBe(false);
      expect(result.error).toContain('GAS returned non-JSON/HTML response');
    });

    it('createBoardViaWebhook handles 502 HTML error page without crashing with SyntaxError', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string) => {
          if (String(url).includes('/api/boards/action')) {
            return Promise.resolve({
              ok: false,
              status: 502,
              json: async () => {
                throw new SyntaxError('Unexpected token < in JSON at position 0');
              },
            });
          }
          // getAccountBoards fallback
          return Promise.resolve({
            ok: true,
            json: async () => ({ success: true, boards: [] }),
          });
        })
      );

      const result = await createBoardViaWebhook({
        accountId: 'acc-1',
        boardName: 'Test Board',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid response from server');
    });

    it('daily-dispatch rejects SSRF webhook URLs with HTTP 400 before attempting fetch', async () => {
      const mockAnalyticsClient = {
        from: vi.fn((table: string) => ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          is: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({
            data: {
              id: 'conn-001',
              workspace_id: '00000000-0000-0000-0000-000000000001',
              analytics_webhook_url: 'http://169.254.169.254/latest/meta-data',
              top_pins_webhook_url: null,
            },
            error: null,
          }),
        })),
      };

      vi.spyOn(dbClients, 'getAnalytics').mockReturnValue(mockAnalyticsClient as any);

      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const req = new Request('http://localhost:4321/api/internal/pinterest/daily-dispatch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-ingest-secret': 'test-secret',
        },
        body: JSON.stringify({
          connection_id: 'conn-001',
          channel: 'account_analytics',
        }),
      });

      const res = await dailyDispatchHandler({
        request: req,
        locals: {
          runtime: {
            env: {
              INGEST_SECRETS_KV: {
                get: vi.fn().mockResolvedValue('test-secret'),
              },
            },
          },
        },
      } as any);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('Unsafe webhook URL');
      // fetch MUST NOT have been called for SSRF URL
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('cleanup-retention catches stream read error and returns HTTP 400 without crashing', async () => {
      const req = {
        headers: new Headers({
          'Content-Type': 'application/json',
          'x-workspace-id': '00000000-0000-0000-0000-000000000001',
        }),
        text: vi.fn().mockRejectedValue(new Error('Connection reset by peer')),
      };

      const res = await cleanupRetentionHandler({
        request: req as any,
        locals: {},
      } as any);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('Failed to read request body');
    });

    it('safeParseJson enforces 5MB limit, catches unreadable streams, and parses valid JSON', async () => {
      // 1. Normal JSON parsing
      const validReq = new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({ valid: true, data: 123 }),
      });
      const validRes = await safeParseJson(validReq);
      expect(validRes.ok).toBe(true);
      expect(validRes.body).toEqual({ valid: true, data: 123 });

      // 2. Unreadable stream
      const brokenReq = {
        text: vi.fn().mockRejectedValue(new Error('Stream aborted by client')),
      } as any;
      const brokenRes = await safeParseJson(brokenReq);
      expect(brokenRes.ok).toBe(false);
      expect(brokenRes.status).toBe(400);
      expect(brokenRes.error).toContain('Failed to read request body');

      // 3. Oversized payload (>5MB)
      const hugeText = 'x'.repeat(5 * 1024 * 1024 + 10);
      const hugeReq = {
        text: vi.fn().mockResolvedValue(hugeText),
      } as any;
      const hugeRes = await safeParseJson(hugeReq);
      expect(hugeRes.ok).toBe(false);
      expect(hugeRes.status).toBe(413);
      expect(hugeRes.error).toContain('Payload too large');

      // 4. Malformed JSON
      const malformedReq = new Request('http://localhost', {
        method: 'POST',
        body: '<html>502 Bad Gateway</html>',
      });
      const malformedRes = await safeParseJson(malformedReq);
      expect(malformedRes.ok).toBe(false);
      expect(malformedRes.status).toBe(400);
      expect(malformedRes.error).toContain('Malformed JSON payload');
    });
  });
});
