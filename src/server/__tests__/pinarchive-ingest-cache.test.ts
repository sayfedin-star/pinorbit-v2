import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST as ingestHandler, _clearIngestCachesForTesting } from '../../pages/api/internal/pinarchive/ingest';
import { dbClients } from '../db/clients';

vi.mock('../db/clients', () => {
  const mockSchedulingAdmin = {
    from: vi.fn(),
  };

  const mockPinArchive = {
    from: vi.fn(),
    rpc: vi.fn(),
  };

  return {
    isProductionEnv: vi.fn().mockReturnValue(false),
    isKnownDefaultIngestSecret: vi.fn().mockReturnValue(false),
    isKnownDefaultKek: vi.fn().mockReturnValue(false),
    getServerEnv: vi.fn().mockReturnValue({}),
    dbClients: {
      getSchedulingAdmin: vi.fn().mockReturnValue(mockSchedulingAdmin),
      getPinArchive: vi.fn().mockReturnValue(mockPinArchive),
      getConfig: vi.fn().mockReturnValue({}),
    },
  };
});

describe('PinArchive Ingest Memoization & Batch Optimization Suite', () => {
  const mockWsId1 = '00000000-0000-0000-0000-000000000001';
  const mockWsId2 = '00000000-0000-0000-0000-000000000002';
  const mockSecret = 'test_secret_cache_suite';

  let mockKvStore: Map<string, string>;
  let mockRuntimeEnv: Record<string, any>;
  let mockAdminClient: any;
  let mockPinArchiveClient: any;

  let wsSettingsQueryCount: number;
  let accountSelectCount: number;
  let accountUpsertCount: number;
  let runsInsertCount: number;
  let rpcBatchCount: number;

  beforeEach(() => {
    vi.clearAllMocks();
    _clearIngestCachesForTesting();

    mockKvStore = new Map<string, string>();
    mockRuntimeEnv = {
      ENABLE_INGEST_CACHE: 'true',
      INGEST_SECRETS_KV: {
        get: vi.fn(async (key: string) => mockKvStore.get(key) || null),
        put: vi.fn(async (key: string, val: string) => mockKvStore.set(key, val)),
        delete: vi.fn(async (key: string) => mockKvStore.delete(key)),
      },
      INGEST_SECRET_KEY: 'env_secret_default_999',
    };

    wsSettingsQueryCount = 0;
    accountSelectCount = 0;
    accountUpsertCount = 0;
    runsInsertCount = 0;
    rpcBatchCount = 0;

    mockAdminClient = dbClients.getSchedulingAdmin();
    mockPinArchiveClient = dbClients.getPinArchive();

    // Default valid workspace in P1
    mockAdminClient.from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockImplementation(() => Promise.resolve({ data: { id: mockWsId1 }, error: null })),
    });

    mockKvStore.set(`ingest_secret:ws:${mockWsId1}`, mockSecret);
    mockKvStore.set(`ingest_secret:ws:${mockWsId2}`, mockSecret);

    // Setup mockPinArchiveClient
    mockPinArchiveClient.from.mockImplementation((table: string) => {
      if (table === 'pa_workspace_settings') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockImplementation(() => {
                wsSettingsQueryCount++;
                return Promise.resolve({
                  data: {
                    ingest_enabled: true,
                    paused_account_policy: 'reject',
                    max_batch_pins: 500,
                  },
                  error: null,
                });
              }),
            }),
          }),
        };
      }

      if (table === 'pa_accounts') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockImplementation(() => {
                  accountSelectCount++;
                  return Promise.resolve({
                    data: {
                      id: '11111111-1111-1111-1111-111111111111',
                      status: 'active',
                      ingest_enabled: true,
                    },
                    error: null,
                  });
                }),
              }),
            }),
          }),
          upsert: vi.fn().mockImplementation(() => {
            accountUpsertCount++;
            return {
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: {
                    id: '11111111-1111-1111-1111-111111111111',
                    workspace_id: mockWsId1,
                    username: 'test_creator',
                  },
                  error: null,
                }),
              }),
            };
          }),
        };
      }

      if (table === 'pa_runs') {
        return {
          insert: vi.fn().mockImplementation(() => {
            runsInsertCount++;
            return {
              select: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: { id: 'run-uuid-123' },
                  error: null,
                }),
              }),
            };
          }),
        };
      }

      if (table === 'pa_pins') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({
                data: [],
                error: null,
              }),
            }),
          }),
          upsert: vi.fn().mockReturnValue({
            select: vi.fn().mockResolvedValue({
              data: [],
              error: null,
            }),
          }),
        };
      }

      return {};
    });

    mockPinArchiveClient.rpc.mockImplementation((fn: string) => {
      if (fn === 'pa_ingest_pin_batch') {
        rpcBatchCount++;
        return Promise.resolve({
          data: {
            success: true,
            account_id: '11111111-1111-1111-1111-111111111111',
            added: 5,
            updated: 0,
            snapshots: 0,
            archived_pin_ids: ['pin_1', 'pin_2', 'pin_3', 'pin_4', 'pin_5'],
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });
  });

  it('1. Caches pa_workspace_settings across consecutive batches for the same workspace (0 redundant queries)', async () => {
    const makeReq = () =>
      new Request('http://localhost:4321/api/internal/pinarchive/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-ingest-secret': mockSecret,
        },
        body: JSON.stringify({
          workspace_id: mockWsId1,
          username: 'test_creator',
          pins: [{ pin_id: 'pin_1', title: 'P1', saves: 10 }],
        }),
      });

    // Batch 1
    const res1 = await ingestHandler({
      request: makeReq(),
      locals: { runtime: { env: mockRuntimeEnv } },
    } as any);
    expect(res1.status).toBe(200);
    expect(wsSettingsQueryCount).toBe(1);

    // Batch 2 (Immediate subsequent call)
    const res2 = await ingestHandler({
      request: makeReq(),
      locals: { runtime: { env: mockRuntimeEnv } },
    } as any);
    expect(res2.status).toBe(200);
    // Should NOT query pa_workspace_settings again
    expect(wsSettingsQueryCount).toBe(1);
  });

  it('2. Throttles pa_accounts upsert and avoids redundant select across batches within 60s', async () => {
    const makeReq = () =>
      new Request('http://localhost:4321/api/internal/pinarchive/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-ingest-secret': mockSecret,
        },
        body: JSON.stringify({
          workspace_id: mockWsId1,
          username: 'test_creator',
          pins: [{ pin_id: 'pin_1', title: 'P1', saves: 10 }],
        }),
      });

    // Batch 1: Performs select and upsert
    const res1 = await ingestHandler({
      request: makeReq(),
      locals: { runtime: { env: mockRuntimeEnv } },
    } as any);
    expect(res1.status).toBe(200);
    expect(accountSelectCount).toBe(1);
    expect(accountUpsertCount).toBe(1);

    // Batch 2: Should hit accountCache (0 select, 0 upsert)
    const res2 = await ingestHandler({
      request: makeReq(),
      locals: { runtime: { env: mockRuntimeEnv } },
    } as any);
    expect(res2.status).toBe(200);
    expect(accountSelectCount).toBe(1);
    expect(accountUpsertCount).toBe(1);
  });

  it('3. Multi-tenant isolation: same username under different workspace does not share account cache', async () => {
    const makeReq = (wsId: string) =>
      new Request('http://localhost:4321/api/internal/pinarchive/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-ingest-secret': mockSecret,
        },
        body: JSON.stringify({
          workspace_id: wsId,
          username: 'test_creator',
          pins: [{ pin_id: 'pin_1', title: 'P1', saves: 10 }],
        }),
      });

    // Request for workspace 1
    await ingestHandler({
      request: makeReq(mockWsId1),
      locals: { runtime: { env: mockRuntimeEnv } },
    } as any);
    expect(accountUpsertCount).toBe(1);

    // Request for workspace 2 with same username
    await ingestHandler({
      request: makeReq(mockWsId2),
      locals: { runtime: { env: mockRuntimeEnv } },
    } as any);
    // Must trigger fresh resolution & upsert for workspace 2!
    expect(accountUpsertCount).toBe(2);
  });

  it('4. Omits pa_runs insert when skip_run_log is true, but records it when false/omitted', async () => {
    const makeReq = (skipRunLog?: boolean) =>
      new Request('http://localhost:4321/api/internal/pinarchive/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-ingest-secret': mockSecret,
        },
        body: JSON.stringify({
          workspace_id: mockWsId1,
          username: 'test_creator',
          skip_run_log: skipRunLog,
          pins: [{ pin_id: 'pin_1', title: 'P1', saves: 10 }],
        }),
      });

    // Intermediate batch with skip_run_log: true
    const res1 = await ingestHandler({
      request: makeReq(true),
      locals: { runtime: { env: mockRuntimeEnv } },
    } as any);
    expect(res1.status).toBe(200);
    const json1 = await res1.json();
    expect(json1.success).toBe(true);
    expect(runsInsertCount).toBe(0);

    // Final batch with skip_run_log: false
    const res2 = await ingestHandler({
      request: makeReq(false),
      locals: { runtime: { env: mockRuntimeEnv } },
    } as any);
    expect(res2.status).toBe(200);
    const json2 = await res2.json();
    expect(json2.success).toBe(true);
    expect(runsInsertCount).toBe(1);
    expect(json2.run_id).toBe('run-uuid-123');
  });

  it('5. _clearIngestCachesForTesting resets caches', async () => {
    const makeReq = () =>
      new Request('http://localhost:4321/api/internal/pinarchive/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-ingest-secret': mockSecret,
        },
        body: JSON.stringify({
          workspace_id: mockWsId1,
          username: 'test_creator',
          pins: [{ pin_id: 'pin_1', title: 'P1', saves: 10 }],
        }),
      });

    await ingestHandler({
      request: makeReq(),
      locals: { runtime: { env: mockRuntimeEnv } },
    } as any);
    expect(wsSettingsQueryCount).toBe(1);
    expect(accountUpsertCount).toBe(1);

    // Clear caches
    _clearIngestCachesForTesting();

    // Next request must query again
    await ingestHandler({
      request: makeReq(),
      locals: { runtime: { env: mockRuntimeEnv } },
    } as any);
    expect(wsSettingsQueryCount).toBe(2);
    expect(accountUpsertCount).toBe(2);
  });

  it('6. Re-upserts account after 60s throttle window elapses', async () => {
    const makeReq = () =>
      new Request('http://localhost:4321/api/internal/pinarchive/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-ingest-secret': mockSecret,
        },
        body: JSON.stringify({
          workspace_id: mockWsId1,
          username: 'test_creator',
          pins: [{ pin_id: 'pin_1', title: 'P1', saves: 10 }],
        }),
      });

    const nowSpy = vi.spyOn(Date, 'now');
    let currentTime = 1_000_000_000;
    nowSpy.mockImplementation(() => currentTime);

    try {
      // First call at t=0
      await ingestHandler({
        request: makeReq(),
        locals: { runtime: { env: mockRuntimeEnv } },
      } as any);
      expect(accountUpsertCount).toBe(1);

      // Second call at t+30s (within 60s throttle window) -> skipped
      currentTime += 30_000;
      await ingestHandler({
        request: makeReq(),
        locals: { runtime: { env: mockRuntimeEnv } },
      } as any);
      expect(accountUpsertCount).toBe(1);

      // Third call at t+65s (after 60s throttle window) -> re-upserted
      currentTime += 35_000;
      await ingestHandler({
        request: makeReq(),
        locals: { runtime: { env: mockRuntimeEnv } },
      } as any);
      expect(accountUpsertCount).toBe(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('7. Bypasses account upsert throttle when account status changes', async () => {
    const makeReq = (status?: string) =>
      new Request('http://localhost:4321/api/internal/pinarchive/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-ingest-secret': mockSecret,
        },
        body: JSON.stringify({
          workspace_id: mockWsId1,
          username: 'test_creator',
          account_meta: status ? { status } : undefined,
          pins: [{ pin_id: 'pin_1', title: 'P1', saves: 10 }],
        }),
      });

    // Call 1: active status
    await ingestHandler({
      request: makeReq('active'),
      locals: { runtime: { env: mockRuntimeEnv } },
    } as any);
    expect(accountUpsertCount).toBe(1);

    // Call 2: identical status within 60s -> skipped
    await ingestHandler({
      request: makeReq('active'),
      locals: { runtime: { env: mockRuntimeEnv } },
    } as any);
    expect(accountUpsertCount).toBe(1);

    // Call 3: changed status ('cookie_expired') within 60s -> bypasses throttle and upserts!
    await ingestHandler({
      request: makeReq('cookie_expired'),
      locals: { runtime: { env: mockRuntimeEnv } },
    } as any);
    expect(accountUpsertCount).toBe(2);
  });

  it('8. Bypasses account upsert throttle when backfill_cursor is provided', async () => {
    const makeReq = (cursor?: string) =>
      new Request('http://localhost:4321/api/internal/pinarchive/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-ingest-secret': mockSecret,
        },
        body: JSON.stringify({
          workspace_id: mockWsId1,
          username: 'test_creator',
          account_meta: cursor !== undefined ? { backfill_cursor: cursor } : undefined,
          pins: [{ pin_id: 'pin_1', title: 'P1', saves: 10 }],
        }),
      });

    // Call 1: without cursor
    await ingestHandler({
      request: makeReq(),
      locals: { runtime: { env: mockRuntimeEnv } },
    } as any);
    expect(accountUpsertCount).toBe(1);

    // Call 2: with explicit cursor -> bypasses throttle so cursor is not lost
    await ingestHandler({
      request: makeReq('bm_cursor_abc_123'),
      locals: { runtime: { env: mockRuntimeEnv } },
    } as any);
    expect(accountUpsertCount).toBe(2);
  });

  it('9. Supports consolidated pins_updated override in pa_runs', async () => {
    let capturedRunRow: any = null;
    mockPinArchiveClient.from.mockImplementation((table: string) => {
      if (table === 'pa_runs') {
        return {
          insert: vi.fn().mockImplementation((row: any) => {
            capturedRunRow = row;
            return {
              select: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: { id: 'run-consolidated-999' },
                  error: null,
                }),
              }),
            };
          }),
        };
      }
      if (table === 'pa_workspace_settings') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: { ingest_enabled: true, paused_account_policy: 'reject', max_batch_pins: 500 },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'pa_accounts') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: { id: '11111111-1111-1111-1111-111111111111', status: 'active', ingest_enabled: true },
                  error: null,
                }),
              }),
            }),
          }),
          upsert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: { id: '11111111-1111-1111-1111-111111111111', workspace_id: mockWsId1, username: 'test_creator' },
                error: null,
              }),
            }),
          }),
        };
      }
      return {};
    });

    const req = new Request('http://localhost:4321/api/internal/pinarchive/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': mockSecret,
      },
      body: JSON.stringify({
        workspace_id: mockWsId1,
        username: 'test_creator',
        skip_run_log: false,
        pins_updated: 125, // Total updated across multiple batches
        pins: [{ pin_id: 'pin_1', title: 'P1', saves: 10 }],
      }),
    });

    const res = await ingestHandler({
      request: req,
      locals: { runtime: { env: mockRuntimeEnv } },
    } as any);

    expect(res.status).toBe(200);
    expect(capturedRunRow).not.toBeNull();
    expect(capturedRunRow.pins_updated).toBe(125);
  });
});

