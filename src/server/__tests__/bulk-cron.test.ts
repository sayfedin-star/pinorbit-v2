import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET as getCronJobs } from '../../pages/api/analytics/cron/jobs';
import { POST as postCronBulk } from '../../pages/api/analytics/cron/bulk';
import { analyticsDb } from '../db/analytics';
import { fastcronService } from '../services/fastcron-service';

vi.mock('../auth/workspace-guard', () => ({
  assertWorkspaceAccess: vi.fn().mockImplementation(async (_client, _wsId, userId) => {
    if (userId === 'non-admin') {
      return { id: 'member-1', role: 'member', isAdmin: false, isOwner: false };
    }
    return { id: 'admin-1', role: 'admin', isAdmin: true, isOwner: true };
  }),
}));

vi.mock('../db/analytics', () => ({
  analyticsDb: {
    listWorkspaceConnections: vi.fn(),
    getWorkspaceAnalyticsSettings: vi.fn(),
    updateWorkspaceConnection: vi.fn(),
  },
}));

vi.mock('../services/fastcron-service', () => ({
  fastcronService: {
    resolveFastCronToken: vi.fn().mockResolvedValue('mock_token_123'),
    listJobs: vi.fn().mockResolvedValue({
      success: true,
      data: {
        data: [
          { id: 1001, name: 'PinOrbit #1001', expression: '0 4 * * *', timezone: 'UTC', status: 'UP', notify: true },
          { id: 1002, name: 'PinOrbit #1002', expression: '30 4 * * *', timezone: 'UTC', status: 'UP', notify: true },
        ],
      },
    }),
    fastcronCall: vi.fn().mockResolvedValue({ success: true, data: { status: 'OK' } }),
    pauseJob: vi.fn().mockResolvedValue({ success: true, data: { status: 'OK' } }),
    nextRuns: vi.fn().mockResolvedValue({ success: true, data: { data: ['2026-08-12 04:00:00'] } }),
    getFailures: vi.fn().mockResolvedValue({ success: true, data: { failures: [] } }),
    editJob: vi.fn().mockResolvedValue({ success: true, data: { status: 'OK' } }),
    enableFastCronJob: vi.fn().mockResolvedValue(true),
    disableFastCronJob: vi.fn().mockResolvedValue(true),
    batchDelete: vi.fn().mockResolvedValue({ success: true }),
    deleteFastCronJob: vi.fn().mockResolvedValue(true),
    syncScheduleWithFastCron: vi.fn().mockResolvedValue({ success: true, fastcron_job_id: 9999 }),
  },
}));

describe('V35 — Bulk Cron Actions & Jobs Suite', () => {
  const workspaceId = 'ws-uuid-1234';
  const connectionId = 'conn-uuid-5678';

  beforeEach(() => {
    vi.clearAllMocks();
    (analyticsDb.listWorkspaceConnections as any).mockResolvedValue([
      {
        id: connectionId,
        workspace_id: workspaceId,
        display_name: 'hymumdotcom',
        analytics_fastcron_job_id: 1001,
        analytics_cron_expression: '0 4 * * *',
        analytics_sync_time: '04:00',
        analytics_schedule_status: 'synced',
        top_pins_fastcron_job_id: 1002,
        top_pins_cron_expression: '30 4 * * *',
        top_pins_sync_time: '04:30',
        top_pins_schedule_status: 'synced',
        analytics_start_offset_days: 7,
        analytics_end_offset_days: 1,
        top_pins_start_offset_days: 7,
        top_pins_end_offset_days: 2,
      },
    ]);
    (analyticsDb.getWorkspaceAnalyticsSettings as any).mockResolvedValue({
      workspace_id: workspaceId,
      timezone: 'UTC',
      fastcron_token: 'ws_token',
    });
    (analyticsDb.updateWorkspaceConnection as any).mockResolvedValue({});
  });

  describe('GET /api/analytics/cron/jobs', () => {
    it('returns 200 with merged live jobs list for workspace', async () => {
      const locals = {
        user: { id: 'admin-user' },
        supabase: {} as any,
        activeWorkspaceId: workspaceId,
        runtime: { env: {} },
      };

      const res = await getCronJobs({ locals } as any);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.jobs).toHaveLength(2);
      expect(json.jobs[0].job_id).toBe(1001);
      expect(json.jobs[0].live?.status).toBe('UP');
      expect(json.jobs[1].job_id).toBe(1002);
    });

    it('rejects unauthenticated request with 401', async () => {
      const res = await getCronJobs({ locals: {} } as any);
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/analytics/cron/bulk', () => {
    const defaultLocals = {
      user: { id: 'admin-user' },
      supabase: {} as any,
      activeWorkspaceId: workspaceId,
      runtime: { env: {} },
    };

    it('enforces tenant boundary: unknown job_id returns 403 with unknown_job_ids', async () => {
      const req = new Request('http://localhost/api/analytics/cron/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'run',
          job_ids: [1001, 99999], // 99999 does not belong to this workspace
        }),
      });

      const res = await postCronBulk({ request: req, locals: defaultLocals } as any);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain('do not belong to this workspace');
      expect(json.unknown_job_ids).toEqual([99999]);
    });

    it('requires admin or owner role for mutations (member gets 403)', async () => {
      const memberLocals = {
        user: { id: 'non-admin' },
        supabase: {} as any,
        activeWorkspaceId: workspaceId,
        runtime: { env: {} },
      };

      const req = new Request('http://localhost/api/analytics/cron/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'run',
          job_ids: [1001],
        }),
      });

      const res = await postCronBulk({ request: req, locals: memberLocals } as any);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain('Admin or Owner role required');
    });

    it('executes bulk run with same-day override dates (start == end allowed)', async () => {
      const req = new Request('http://localhost/api/analytics/cron/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'run',
          job_ids: [1001, 1002],
          options: {
            from_date: '2026-08-01',
            to_date: '2026-08-01', // same-day
          },
        }),
      });

      const res = await postCronBulk({ request: req, locals: defaultLocals } as any);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.results).toHaveLength(2);
      expect(json.results[0].startDate).toBe('2026-08-01');
      expect(json.results[0].endDate).toBe('2026-08-01');
      expect(fastcronService.fastcronCall).toHaveBeenCalledWith(
        'cron_run',
        expect.objectContaining({ id: 1001 }),
        'mock_token_123'
      );
    });

    it('rejects bulk run when from_date > to_date with 422 error', async () => {
      const req = new Request('http://localhost/api/analytics/cron/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'run',
          job_ids: [1001],
          options: {
            from_date: '2026-08-10',
            to_date: '2026-08-01', // inverted
          },
        }),
      });

      const res = await postCronBulk({ request: req, locals: defaultLocals } as any);
      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain('start_date must be before end_date (identical dates allowed for same-day pull)');
    });

    it('validates pause regex: rejects invalid duration and accepts valid durations', async () => {
      // Invalid case
      const reqInvalid = new Request('http://localhost/api/analytics/cron/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'pause',
          job_ids: [1001],
          options: { for: '20 minutes' }, // invalid (must be 15|30|45 minutes or N hour(s) or N day(s))
        }),
      });

      const resInvalid = await postCronBulk({ request: reqInvalid, locals: defaultLocals } as any);
      expect(resInvalid.status).toBe(422);

      // Valid cases
      for (const validDur of ['15 minutes', '30 minutes', '45 minutes', '1 hour', '2 hours', '7 days']) {
        const reqValid = new Request('http://localhost/api/analytics/cron/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'pause',
            job_ids: [1001],
            options: { for: validDur },
          }),
        });

        const resValid = await postCronBulk({ request: reqValid, locals: defaultLocals } as any);
        expect(resValid.status).toBe(200);
        expect(fastcronService.pauseJob).toHaveBeenCalledWith(1001, validDur, 'mock_token_123');
      }
    });

    it('executes delete, calls FastCron and clears DB columns with pending status', async () => {
      const req = new Request('http://localhost/api/analytics/cron/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'delete',
          job_ids: [1001, 1002],
        }),
      });

      const res = await postCronBulk({ request: req, locals: defaultLocals } as any);
      expect(res.status).toBe(200);
      expect(fastcronService.batchDelete).toHaveBeenCalledWith([1001, 1002], 'mock_token_123');

      // Verify DB update reset both columns to null and status to pending
      expect(analyticsDb.updateWorkspaceConnection).toHaveBeenCalledWith(
        workspaceId,
        connectionId,
        expect.objectContaining({
          analytics_fastcron_job_id: null,
          analytics_schedule_status: 'pending',
          top_pins_fastcron_job_id: null,
          top_pins_schedule_status: 'pending',
        })
      );
    });

    it('does not clear DB columns when FastCron remote delete fails', async () => {
      vi.mocked(fastcronService.batchDelete).mockResolvedValueOnce({ success: false, error: 'Remote deletion failed' });

      const req = new Request('http://localhost/api/analytics/cron/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'delete',
          job_ids: [1001, 1002],
        }),
      });

      const res = await postCronBulk({ request: req, locals: defaultLocals } as any);
      expect(res.status).toBe(200);
      expect(fastcronService.batchDelete).toHaveBeenCalledWith([1001, 1002], 'mock_token_123');

      // Verify DB update was NOT called because remote delete failed
      expect(analyticsDb.updateWorkspaceConnection).not.toHaveBeenCalled();
    });

    it('executes edit action with validated options', async () => {
      const req = new Request('http://localhost/api/analytics/cron/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'edit',
          job_ids: [1001],
          options: {
            timeout: 45,
            instances: 2,
            notify: false,
          },
        }),
      });

      const res = await postCronBulk({ request: req, locals: defaultLocals } as any);
      expect(res.status).toBe(200);
      expect(fastcronService.editJob).toHaveBeenCalledWith(
        1001,
        { timeout: 45, instances: 2, notify: false },
        'mock_token_123'
      );
    });

    it('executes logs, failures, and next aggregated read actions', async () => {
      // Logs
      const reqLogs = new Request('http://localhost/api/analytics/cron/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'logs', job_ids: [1001] }),
      });
      const resLogs = await postCronBulk({ request: reqLogs, locals: defaultLocals } as any);
      expect(resLogs.status).toBe(200);

      // Failures
      const reqFailures = new Request('http://localhost/api/analytics/cron/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'failures', job_ids: [1001] }),
      });
      const resFailures = await postCronBulk({ request: reqFailures, locals: defaultLocals } as any);
      expect(resFailures.status).toBe(200);

      // Next
      const reqNext = new Request('http://localhost/api/analytics/cron/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'next', job_ids: [1001] }),
      });
      const resNext = await postCronBulk({ request: reqNext, locals: defaultLocals } as any);
      expect(resNext.status).toBe(200);
    });

    it('executes sync_missing to provision missing jobs for connections', async () => {
      (analyticsDb.listWorkspaceConnections as any).mockResolvedValue([
        {
          id: 'conn-missing',
          workspace_id: workspaceId,
          display_name: 'missing_conn',
          analytics_webhook_url: 'https://hook.make.com/abc',
          analytics_fastcron_job_id: null, // missing
          top_pins_webhook_url: 'https://hook.make.com/def',
          top_pins_fastcron_job_id: null, // missing
        },
      ]);

      const req = new Request('http://localhost/api/analytics/cron/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync_missing' }),
      });

      const res = await postCronBulk({ request: req, locals: defaultLocals } as any);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.results).toHaveLength(2);
      expect(fastcronService.syncScheduleWithFastCron).toHaveBeenCalledTimes(2);
    });
  });
});
