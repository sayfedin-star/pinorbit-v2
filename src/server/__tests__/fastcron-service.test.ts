import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fastcronService, FASTCRON_BASE } from '../services/fastcron-service';
import { analyticsDb } from '../db/analytics';
import { getEffectiveSecret } from '../services/webhook-secrets';

vi.mock('../db/analytics', () => ({
  analyticsDb: {
    getWorkspaceAnalyticsSettings: vi.fn(),
    getWorkspaceConnection: vi.fn(),
    updateWorkspaceConnection: vi.fn(),
    listWorkspaceConnections: vi.fn(),
  },
}));

vi.mock('../services/webhook-secrets', () => ({
  getEffectiveSecret: vi.fn().mockResolvedValue({ value: 'test_effective_sec_999', source: 'global' }),
}));

describe('FastCron Full Service Suite (R6 Reconcile Idempotency & Orphan Cleanup)', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000001';
  const connectionId = 'conn-uuid-12345';
  const mockRuntimeEnv = { FASTCRON_API_TOKEN: 'valid_env_fastcron_token_12345' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('A1: Asserts FastCron base URL is exactly https://www.fastcron.com/api/v1', () => {
    expect(FASTCRON_BASE).toBe('https://www.fastcron.com/api/v1');
  });

  it('A1: fastcronCall fails closed without query-string token fallback on 404/405', async () => {
    let callCount = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init?: any) => {
      callCount++;
      expect(init?.method).toBe('POST');
      expect(url).toBe('https://www.fastcron.com/api/v1/cron_test');
      return {
        status: 405,
        ok: false,
        json: async () => ({ error: 'Method Not Allowed' }),
      } as any;
    }) as any);

    const result = await fastcronService.fastcronCall(
      'cron_test',
      { sample_param: 'value123' },
      'test_token'
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/refusing fallback query-string authentication/i);
    expect(callCount).toBe(1);

    fetchSpy.mockRestore();
  });

  it('A1: fastcronCall surfaces FastCron error messages verbatim to caller', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async () => {
      return {
        status: 200,
        ok: true,
        json: async () => ({ status: 'error', message: 'FastCron quota exceeded for user tier.' }),
      } as any;
    }) as any);

    const result = await fastcronService.fastcronCall(
      'cron_add',
      { name: 'test' },
      'test_token'
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('FastCron quota exceeded for user tier.');

    fetchSpy.mockRestore();
  });

  it('R6.4: Idempotent 3x consecutive sync calls verify existing jobs with cron_get and purge orphan duplicates', async () => {
    (analyticsDb.getWorkspaceAnalyticsSettings as any).mockResolvedValue({
      fastcron_token: 'db_token_1234567890',
    });

    // Mock in-memory connection state
    const mockConn: any = {
      id: connectionId,
      workspace_id: workspaceId,
      display_name: 'hymumdotcom',
      analytics_webhook_url: 'https://hook.make.com/pipeline-a',
      top_pins_webhook_url: 'https://hook.make.com/pipeline-b',
      analytics_sync_time: '04:00',
      top_pins_sync_time: '04:30',
      analytics_schedule_status: 'pending',
      top_pins_schedule_status: 'pending',
      analytics_fastcron_job_id: null,
      top_pins_fastcron_job_id: null,
      analytics_start_offset_days: 7,
      analytics_end_offset_days: 1,
      top_pins_start_offset_days: 7,
      top_pins_end_offset_days: 2,
    };

    (analyticsDb.getWorkspaceConnection as any).mockImplementation(async () => ({ ...mockConn }));
    (analyticsDb.updateWorkspaceConnection as any).mockImplementation(async (_wsId: string, _connId: string, updates: any) => {
      Object.assign(mockConn, updates);
      return { ...mockConn };
    });

    // Simulated FastCron server job table
    let fastcronJobs: Array<{ id: number; name: string; url: string; expression: string; postData?: string }> = [];
    let nextJobId = 1001;

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init?: any) => {
      const endpoint = url.split('/').pop()?.split('?')[0];
      const body = init?.body ? JSON.parse(init.body) : {};

      if (endpoint === 'cron_batch_add') {
        const id1 = nextJobId++;
        const id2 = nextJobId++;
        fastcronJobs.push({ id: id1, name: body.data[0].name, url: body.data[0].url, expression: body.data[0].expression });
        fastcronJobs.push({ id: id2, name: body.data[1].name, url: body.data[1].url, expression: body.data[1].expression });
        return {
          status: 200,
          ok: true,
          json: async () => ({ status: 'OK', ids: [id1, id2] }),
        } as any;
      }

      if (endpoint === 'cron_add') {
        const id = nextJobId++;
        fastcronJobs.push({ id, name: body.name, url: body.url, expression: body.expression });
        return {
          status: 200,
          ok: true,
          json: async () => ({ status: 'OK', id }),
        } as any;
      }

      if (endpoint === 'cron_get') {
        const job = fastcronJobs.find((j) => j.id === body.id);
        if (job) {
          return { status: 200, ok: true, json: async () => ({ status: 'OK', data: job }) } as any;
        } else {
          return { status: 404, ok: false, json: async () => ({ status: 'error', message: 'Job not found' }) } as any;
        }
      }

      if (endpoint === 'cron_edit') {
        const job = fastcronJobs.find((j) => j.id === body.id);
        if (job) {
          job.expression = body.expression;
          job.url = body.url;
        }
        return { status: 200, ok: true, json: async () => ({ status: 'OK' }) } as any;
      }

      if (endpoint === 'cron_list') {
        return {
          status: 200,
          ok: true,
          json: async () => ({ status: 'OK', jobs: [...fastcronJobs] }),
        } as any;
      }

      if (endpoint === 'cron_delete') {
        fastcronJobs = fastcronJobs.filter((j) => j.id !== body.id);
        return { status: 200, ok: true, json: async () => ({ status: 'OK' }) } as any;
      }

      return { status: 200, ok: true, json: async () => ({ status: 'OK' }) } as any;
    }) as any);

    // ==========================================
    // Sync Click 1 (Creation: batch add)
    // ==========================================
    const res1 = await fastcronService.syncScheduleWithFastCron(
      workspaceId,
      connectionId,
      'analytics',
      mockRuntimeEnv
    );
    expect(res1.success).toBe(true);
    expect(mockConn.analytics_fastcron_job_id).toBe(1001);
    expect(mockConn.top_pins_fastcron_job_id).toBe(1002);
    expect(fastcronJobs.length).toBe(2);

    // Simulate an orphan duplicate injected in FastCron for this connection
    fastcronJobs.push({
      id: 9999,
      name: 'PinOrbit analytics — 00000000 — hymumdotcom duplicate',
      url: 'https://pinorbit-v2.o-i.workers.dev/api/internal/pinterest/daily-dispatch',
      postData: JSON.stringify({ connection_id: connectionId, channel: 'account_analytics' }),
      expression: '0 4 * * *',
    });
    expect(fastcronJobs.length).toBe(3);

    // ==========================================
    // Sync Click 2 (Reconcile & Orphan Cleanup)
    // ==========================================
    const res2 = await fastcronService.syncScheduleWithFastCron(
      workspaceId,
      connectionId,
      'analytics',
      mockRuntimeEnv
    );
    expect(res2.success).toBe(true);
    expect(mockConn.analytics_fastcron_job_id).toBe(1001);
    // Verified: orphan job 9999 was cleaned up via cron_delete!
    expect(fastcronJobs.find((j) => j.id === 9999)).toBeUndefined();
    expect(fastcronJobs.length).toBe(2);

    // ==========================================
    // Sync Click 3 (Idempotent: Re-verify & Edit only)
    // ==========================================
    const res3 = await fastcronService.syncScheduleWithFastCron(
      workspaceId,
      connectionId,
      'analytics',
      mockRuntimeEnv
    );
    expect(res3.success).toBe(true);
    expect(mockConn.analytics_fastcron_job_id).toBe(1001);
    expect(mockConn.top_pins_fastcron_job_id).toBe(1002);
    expect(mockConn.analytics_schedule_status).toBe('synced');
    expect(fastcronJobs.length).toBe(2);

    fetchSpy.mockRestore();
  });

  it('B6: disableFastCronJob and enableFastCronJob use cron_disable and cron_enable', async () => {
    let capturedAction = '';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string) => {
      capturedAction = url;
      return {
        status: 200,
        ok: true,
        json: async () => ({ status: 'OK' }),
      } as any;
    }) as any);

    (analyticsDb.getWorkspaceAnalyticsSettings as any).mockResolvedValue({
      fastcron_token: 'db_token_1234567890',
    });

    // Disable
    const disableOk = await fastcronService.disableFastCronJob(workspaceId, 9900, mockRuntimeEnv);
    expect(disableOk).toBe(true);
    expect(capturedAction).toContain('/cron_disable');

    // Enable
    const enableOk = await fastcronService.enableFastCronJob(workspaceId, 9900, mockRuntimeEnv);
    expect(enableOk).toBe(true);
    expect(capturedAction).toContain('/cron_enable');

    fetchSpy.mockRestore();
  });

  it('B6: getCronLogs queries cron_logs endpoint and returns log entries', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string) => {
      expect(url).toContain('/cron_logs');
      return {
        status: 200,
        ok: true,
        json: async () => ({
          status: 'OK',
          logs: [
            { date: '2026-08-09 04:00:00', http_status: 200, output: 'OK 7 rows' },
          ],
        }),
      } as any;
    }) as any);

    (analyticsDb.getWorkspaceConnection as any).mockResolvedValue({
      id: connectionId,
      workspace_id: workspaceId,
      analytics_fastcron_job_id: 9900,
      top_pins_fastcron_job_id: 9901,
    });

    (analyticsDb.getWorkspaceAnalyticsSettings as any).mockResolvedValue({
      fastcron_token: 'db_token_1234567890',
    });

    const logRes = await fastcronService.getCronLogs(workspaceId, connectionId, 9900, mockRuntimeEnv);
    expect(logRes.success).toBe(true);
    expect(logRes.logs?.length).toBe(1);
    expect(logRes.logs?.[0].http_status).toBe(200);

    fetchSpy.mockRestore();
  });

  it('F-05: getCronLogs rejects with 403 when jobId does not belong to connection', async () => {
    (analyticsDb.getWorkspaceConnection as any).mockResolvedValue({
      id: connectionId,
      workspace_id: workspaceId,
      analytics_fastcron_job_id: 9900,
      top_pins_fastcron_job_id: 9901,
    });

    const logRes = await fastcronService.getCronLogs(workspaceId, connectionId, 1234, mockRuntimeEnv);
    expect(logRes.success).toBe(false);
    expect(logRes.error).toContain('403 Forbidden: jobId does not belong to this connection');
  });

  it('R8.2: Fails with schedule_status error and returns success:false if FastCron returns non-numeric or missing id', async () => {
    (analyticsDb.getWorkspaceAnalyticsSettings as any).mockResolvedValue({
      fastcron_token: 'db_token_1234567890',
    });

    const mockConn: any = {
      id: connectionId,
      workspace_id: workspaceId,
      display_name: 'testconn',
      analytics_webhook_url: 'https://hook.make.com/pipeline-a',
      analytics_sync_time: '04:00',
      analytics_schedule_status: 'pending',
      analytics_fastcron_job_id: null,
      top_pins_webhook_url: null,
    };

    (analyticsDb.getWorkspaceConnection as any).mockResolvedValue(mockConn);
    (analyticsDb.updateWorkspaceConnection as any).mockImplementation(async (_wsId: string, _connId: string, updates: any) => {
      Object.assign(mockConn, updates);
      return { ...mockConn };
    });

    // FastCron returns status: 'OK' but no extractable numeric id
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async () => {
      return {
        status: 200,
        ok: true,
        json: async () => ({ status: 'OK', id: null, data: {} }),
      } as any;
    }) as any);

    const result = await fastcronService.syncScheduleWithFastCron(
      workspaceId,
      connectionId,
      'analytics',
      mockRuntimeEnv
    );

    expect(result.success).toBe(false);
    expect(result.schedule_status).toBe('error');
    expect(mockConn.analytics_schedule_status).toBe('error');
    expect(mockConn.analytics_fastcron_job_id).toBeNull();

    fetchSpy.mockRestore();
  });

  it('R8.4: Two-channel URL matrix test proving cross-channel orphan cleanup safety', async () => {
    (analyticsDb.getWorkspaceAnalyticsSettings as any).mockResolvedValue({
      fastcron_token: 'db_token_1234567890',
    });

    const urlA = 'https://hook.make.com/pipeline-a-url';
    const urlB = 'https://hook.make.com/pipeline-b-url';

    const mockConn: any = {
      id: connectionId,
      workspace_id: workspaceId,
      display_name: 'matrix-conn',
      analytics_webhook_url: urlA,
      top_pins_webhook_url: urlB,
      analytics_sync_time: '04:00',
      top_pins_sync_time: '04:30',
      analytics_schedule_status: 'synced',
      top_pins_schedule_status: 'synced',
      analytics_fastcron_job_id: 1001,
      top_pins_fastcron_job_id: 1002,
    };

    (analyticsDb.getWorkspaceConnection as any).mockImplementation(async () => ({ ...mockConn }));
    (analyticsDb.updateWorkspaceConnection as any).mockImplementation(async (_wsId: string, _connId: string, updates: any) => {
      Object.assign(mockConn, updates);
      return { ...mockConn };
    });

    // In FastCron:
    // Job 1001: URL A (verified A)
    // Job 9991: URL A (orphan A)
    // Job 1002: URL B (verified B)
    // Job 9992: URL B (orphan B)
    // In FastCron:
    // Job 1001: URL A (verified A)
    // Job 9991: URL A (orphan A)
    // Job 1002: URL B (verified B)
    // Job 9992: URL B (orphan B)
    let fastcronJobs = [
      { id: 1001, name: 'matrix-conn Job A Verified', url: urlA, postData: JSON.stringify({ connection_id: connectionId }), expression: '0 4 * * *' },
      { id: 9991, name: 'matrix-conn Job A Orphan', url: urlA, postData: JSON.stringify({ connection_id: connectionId }), expression: '0 4 * * *' },
      { id: 1002, name: 'matrix-conn Job B Verified', url: urlB, postData: JSON.stringify({ connection_id: connectionId }), expression: '30 4 * * *' },
      { id: 9992, name: 'matrix-conn Job B Orphan', url: urlB, postData: JSON.stringify({ connection_id: connectionId }), expression: '30 4 * * *' },
    ];

    const deletedIds: number[] = [];

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init?: any) => {
      const endpoint = url.split('/').pop()?.split('?')[0];
      const body = init?.body ? JSON.parse(init.body) : {};

      if (endpoint === 'cron_get') {
        const job = fastcronJobs.find((j) => j.id === body.id);
        return { status: 200, ok: true, json: async () => ({ status: 'OK', data: job }) } as any;
      }

      if (endpoint === 'cron_edit') {
        return { status: 200, ok: true, json: async () => ({ status: 'OK' }) } as any;
      }

      if (endpoint === 'cron_list') {
        return { status: 200, ok: true, json: async () => ({ status: 'OK', data: [...fastcronJobs] }) } as any;
      }

      if (endpoint === 'cron_delete') {
        deletedIds.push(body.id);
        fastcronJobs = fastcronJobs.filter((j) => j.id !== body.id);
        return { status: 200, ok: true, json: async () => ({ status: 'OK' }) } as any;
      }

      return { status: 200, ok: true, json: async () => ({ status: 'OK' }) } as any;
    }) as any);

    // Sync Channel A: Should delete only 9991 (URL A orphan). MUST NOT touch 1002 or 9992 (URL B).
    const syncResA = await fastcronService.syncScheduleWithFastCron(
      workspaceId,
      connectionId,
      'analytics',
      mockRuntimeEnv
    );

    expect(syncResA.success).toBe(true);
    expect(deletedIds).toEqual([9991]);
    expect(fastcronJobs.find((j) => j.id === 1001)).toBeDefined(); // Channel A verified intact
    expect(fastcronJobs.find((j) => j.id === 1002)).toBeDefined(); // Channel B verified untouched
    expect(fastcronJobs.find((j) => j.id === 9992)).toBeDefined(); // Channel B orphan untouched during Channel A sync

    // Now Sync Channel B: Should delete only 9992 (URL B orphan). MUST NOT touch 1001.
    const syncResB = await fastcronService.syncScheduleWithFastCron(
      workspaceId,
      connectionId,
      'top_pins',
      mockRuntimeEnv
    );

    expect(syncResB.success).toBe(true);
    expect(deletedIds).toEqual([9991, 9992]);
    expect(fastcronJobs.find((j) => j.id === 1001)).toBeDefined(); // Channel A verified still intact
    expect(fastcronJobs.find((j) => j.id === 1002)).toBeDefined(); // Channel B verified intact
    expect(fastcronJobs.length).toBe(2); // Exactly 2 jobs remain

    fetchSpy.mockRestore();
  });

  it('httpHeaders contains x-ingest-secret: <effectiveSecret>', async () => {
    (getEffectiveSecret as any).mockResolvedValueOnce({ value: 'test_effective_sec_123', source: 'global' });
    (analyticsDb.getWorkspaceAnalyticsSettings as any).mockResolvedValue({
      fastcron_token: 'db_token_1234567890',
    });

    const mockConn: any = {
      id: connectionId,
      workspace_id: workspaceId,
      display_name: 'dispatch-conn',
      analytics_webhook_url: 'https://hook.make.com/pipeline-a',
      top_pins_webhook_url: null,
      analytics_sync_time: '04:00',
      analytics_schedule_status: 'pending',
      analytics_fastcron_job_id: null,
    };

    (analyticsDb.getWorkspaceConnection as any).mockImplementation(async () => ({ ...mockConn }));
    (analyticsDb.updateWorkspaceConnection as any).mockImplementation(async (_wsId: string, _connId: string, updates: any) => {
      Object.assign(mockConn, updates);
      return { ...mockConn };
    });

    let capturedJobParams: any = null;

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init?: any) => {
      const endpoint = url.split('/').pop()?.split('?')[0];
      if (endpoint === 'cron_add' || endpoint === 'cron_edit') {
        capturedJobParams = JSON.parse(init.body);
      }
      return { status: 200, ok: true, json: async () => ({ status: 'OK', id: 7788 }) } as any;
    }) as any);

    const res = await fastcronService.syncScheduleWithFastCron(
      workspaceId,
      connectionId,
      'analytics',
      { FASTCRON_API_TOKEN: 'valid_env_token_12345' }
    );

    expect(res.success).toBe(true);
    expect(capturedJobParams.url).toBe('https://pinorbit-v2.o-i.workers.dev/api/internal/pinterest/daily-dispatch');
    expect(capturedJobParams.postData).toBe(JSON.stringify({ connection_id: connectionId, channel: 'account_analytics' }));
    expect(capturedJobParams.httpHeaders).toContain('x-ingest-secret: test_effective_sec_123');

    fetchSpy.mockRestore();
  });

  it('schedule_status=\'error\' when getEffectiveSecret returns null', async () => {
    (getEffectiveSecret as any).mockResolvedValueOnce({ value: '', source: 'none' });
    (analyticsDb.getWorkspaceAnalyticsSettings as any).mockResolvedValue({
      fastcron_token: 'db_token_1234567890',
    });

    const mockConn: any = {
      id: connectionId,
      workspace_id: workspaceId,
      display_name: 'missing-secret-conn',
      analytics_webhook_url: 'https://hook.make.com/pipeline-a',
      top_pins_webhook_url: null,
      analytics_sync_time: '04:00',
      analytics_schedule_status: 'pending',
      analytics_fastcron_job_id: null,
    };

    (analyticsDb.getWorkspaceConnection as any).mockImplementation(async () => ({ ...mockConn }));
    (analyticsDb.updateWorkspaceConnection as any).mockImplementation(async (_wsId: string, _connId: string, updates: any) => {
      Object.assign(mockConn, updates);
      return { ...mockConn };
    });

    const res = await fastcronService.syncScheduleWithFastCron(
      workspaceId,
      connectionId,
      'analytics',
      { FASTCRON_API_TOKEN: 'valid_env_token_12345' }
    );

    expect(res.success).toBe(false);
    expect(res.schedule_status).toBe('error');
    expect(res.error).toContain('Ingest secret not configured');
    expect(mockConn.analytics_schedule_status).toBe('error');
  });

  it('R9.4: Simulated Channel A FastCron failure leaves Channel B status and jobs completely untouched', async () => {
    (analyticsDb.getWorkspaceAnalyticsSettings as any).mockResolvedValue({
      fastcron_token: 'db_token_1234567890',
    });

    const mockConn: any = {
      id: connectionId,
      workspace_id: workspaceId,
      display_name: 'isolation-conn',
      analytics_webhook_url: 'https://hook.make.com/pipeline-a',
      top_pins_webhook_url: 'https://hook.make.com/pipeline-b',
      analytics_sync_time: '04:00',
      top_pins_sync_time: '04:30',
      analytics_schedule_status: 'pending',
      top_pins_schedule_status: 'synced',
      analytics_fastcron_job_id: null,
      top_pins_fastcron_job_id: 8888,
    };

    (analyticsDb.getWorkspaceConnection as any).mockImplementation(async () => ({ ...mockConn }));
    (analyticsDb.updateWorkspaceConnection as any).mockImplementation(async (_wsId: string, _connId: string, updates: any) => {
      Object.assign(mockConn, updates);
      return { ...mockConn };
    });

    // Simulate FastCron failure on cron_add for Channel A
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string) => {
      const endpoint = url.split('/').pop()?.split('?')[0];
      if (endpoint === 'cron_add') {
        return {
          status: 500,
          ok: false,
          json: async () => ({ status: 'error', message: 'FastCron 500 internal outage on Pipeline A' }),
        } as any;
      }
      return { status: 200, ok: true, json: async () => ({ status: 'OK' }) } as any;
    }) as any);

    const resultA = await fastcronService.syncScheduleWithFastCron(
      workspaceId,
      connectionId,
      'analytics',
      mockRuntimeEnv
    );

    // Channel A reports failure
    expect(resultA.success).toBe(false);
    expect(resultA.schedule_status).toBe('error');
    expect(mockConn.analytics_schedule_status).toBe('error');

    // Channel B remains 100% UNTOUCHED
    expect(mockConn.top_pins_schedule_status).toBe('synced');
    expect(mockConn.top_pins_fastcron_job_id).toBe(8888);

    fetchSpy.mockRestore();
  });
});

