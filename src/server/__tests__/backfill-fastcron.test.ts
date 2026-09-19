import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST as postBackfillTick } from '../../pages/api/internal/pinterest/backfill-tick';
import { POST as postBackfillAdmin, GET as getBackfillAdmin } from '../../pages/api/analytics/backfill';
import { analyticsDb } from '../db/analytics';
import { fastcronService } from '../services/fastcron-service';

// Mock workspace guard
vi.mock('../auth/workspace-guard', () => ({
  assertWorkspaceAccess: vi.fn().mockResolvedValue(true),
}));

// Mock webhook secrets
vi.mock('../services/webhook-secrets', () => ({
  verifyIngestSecret: vi.fn().mockImplementation(async (secret: string) => {
    return { valid: secret === 'valid_secret' };
  }),
  getEffectiveSecret: vi.fn().mockResolvedValue({ value: 'valid_secret', source: 'workspace' }),
}));

// Mock SSRF guard
vi.mock('../lib/ssrf-guard', () => ({
  validateSafeUrl: vi.fn().mockReturnValue(true),
}));

describe('FastCron Recurring Loop Backfill System', () => {
  const mockWorkspaceId = '11111111-1111-1111-1111-111111111111';
  const mockConnectionId = '22222222-2222-2222-2222-222222222222';
  const mockJobId = '33333333-3333-3333-3333-333333333333';

  let mockJob: any;
  let mockConnection: any;

  beforeEach(() => {
    vi.restoreAllMocks();

    mockJob = {
      id: mockJobId,
      workspace_id: mockWorkspaceId,
      connection_id: mockConnectionId,
      channel: 'top_pins',
      status: 'running',
      start_date: '2026-09-01',
      end_date: '2026-09-03',
      current_date: '2026-09-01',
      total_days: 3,
      completed_days: 0,
      failed_days: 0,
      interval_minutes: 1,
      fastcron_job_id: 9999,
      last_run_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    mockConnection = {
      id: mockConnectionId,
      workspace_id: mockWorkspaceId,
      display_name: 'Test Pinterest Account',
      top_pins_webhook_url: 'https://hook.us2.make.com/test-top-pins',
      top_pins_sort_modes: ['OUTBOUND_CLICK', 'IMPRESSION'],
      top_pins_num_of_pins: 50,
      fastcron_token: 'test_token',
    };

    vi.spyOn(analyticsDb, 'getBackfillJobById').mockImplementation(async (id: string) => {
      return id === mockJobId ? { ...mockJob } : null;
    });

    vi.spyOn(analyticsDb, 'getActiveBackfillJob').mockImplementation(async () => {
      return mockJob.status === 'running' || mockJob.status === 'paused' ? { ...mockJob } : null;
    });

    vi.spyOn(analyticsDb, 'getWorkspaceConnection').mockResolvedValue(mockConnection);
    vi.spyOn(analyticsDb, 'claimBackfillTick').mockImplementation(async () => ({ ...mockJob }));
    vi.spyOn(analyticsDb, 'advanceBackfillJob').mockImplementation(async (_id, params) => {
      mockJob.current_date = params.nextDate;
      if (params.failed) mockJob.failed_days++;
      else mockJob.completed_days++;
      if (params.isFinished) mockJob.status = 'completed';
      return { ...mockJob };
    });
    vi.spyOn(analyticsDb, 'updateBackfillJob').mockImplementation(async (_id, updates) => {
      Object.assign(mockJob, updates);
      return { ...mockJob };
    });
    vi.spyOn(analyticsDb, 'createBackfillJob').mockImplementation(async (params) => {
      mockJob = {
        ...mockJob,
        ...params,
        id: mockJobId,
        current_date: params.startDate,
        status: 'running',
      };
      return { ...mockJob };
    });

    vi.spyOn(fastcronService, 'deleteBackfillCronJob').mockResolvedValue(true);
    vi.spyOn(fastcronService, 'pauseBackfillCronJob').mockResolvedValue(true);
    vi.spyOn(fastcronService, 'resumeBackfillCronJob').mockResolvedValue(true);
    vi.spyOn(fastcronService, 'createBackfillCronJob').mockResolvedValue({ success: true, jobId: 9999 });

    // Mock global fetch for Make.com webhook dispatch
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('hook.us2.make.com')) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Internal Backfill Tick Endpoint (/api/internal/pinterest/backfill-tick)', () => {
    it('rejects unauthenticated requests without secret header', async () => {
      const req = new Request('http://localhost/api/internal/pinterest/backfill-tick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backfill_job_id: mockJobId }),
      });

      const res = await postBackfillTick({ request: req, locals: {} } as any);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toContain('Unauthorized');
    });

    it('processes single day tick, dispatches to Make.com, and advances current_date', async () => {
      const req = new Request('http://localhost/api/internal/pinterest/backfill-tick', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-ingest-secret': 'valid_secret',
        },
        body: JSON.stringify({ backfill_job_id: mockJobId }),
      });

      const res = await postBackfillTick({ request: req, locals: {} } as any);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.processed_date).toBe('2026-09-01');
      expect(json.next_date).toBe('2026-09-02');
      expect(json.is_finished).toBe(false);

      // Verify Make.com was called with the exact current_date
      expect(global.fetch).toHaveBeenCalledWith(
        'https://hook.us2.make.com/test-top-pins',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"start_date":"2026-09-01"'),
        })
      );
    });

    it('marks job completed and calls deleteBackfillCronJob on final day', async () => {
      mockJob.current_date = '2026-09-03';
      mockJob.end_date = '2026-09-03';

      const req = new Request('http://localhost/api/internal/pinterest/backfill-tick', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-ingest-secret': 'valid_secret',
        },
        body: JSON.stringify({ backfill_job_id: mockJobId }),
      });

      const res = await postBackfillTick({ request: req, locals: {} } as any);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.is_finished).toBe(true);
      expect(mockJob.status).toBe('completed');

      // Verify FastCron job was deleted
      expect(fastcronService.deleteBackfillCronJob).toHaveBeenCalledWith(
        mockWorkspaceId,
        9999,
        expect.anything(),
        mockConnectionId
      );
    });

    it('defensively cleans up FastCron job if tick arrives after job was cancelled', async () => {
      mockJob.status = 'cancelled';

      const req = new Request('http://localhost/api/internal/pinterest/backfill-tick', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-ingest-secret': 'valid_secret',
        },
        body: JSON.stringify({ backfill_job_id: mockJobId }),
      });

      const res = await postBackfillTick({ request: req, locals: {} } as any);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.message).toContain('Cleaned up FastCron job');
      expect(fastcronService.deleteBackfillCronJob).toHaveBeenCalled();
    });
  });

  describe('Public Backfill Management API (/api/analytics/backfill)', () => {
    it('enforces 90-day lookback guard on start action', async () => {
      const oldDate = '2025-01-01'; // More than 90 days ago
      const req = new Request('http://localhost/api/analytics/backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'start',
          connection_id: mockConnectionId,
          from_date: oldDate,
          to_date: '2026-09-18',
        }),
      });

      const res = await postBackfillAdmin({
        request: req,
        locals: {
          user: { id: 'u1' },
          supabase: {},
          activeWorkspaceId: mockWorkspaceId,
        },
      } as any);

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error).toContain('90 days');
    });

    it('starts cloud backfill and registers FastCron recurring job', async () => {
      mockJob.status = 'completed'; // No active job

      const req = new Request('http://localhost/api/analytics/backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'start',
          connection_id: mockConnectionId,
          from_date: '2026-09-10',
          to_date: '2026-09-15',
          interval_minutes: 1,
        }),
      });

      const res = await postBackfillAdmin({
        request: req,
        locals: {
          user: { id: 'u1' },
          supabase: {},
          activeWorkspaceId: mockWorkspaceId,
        },
      } as any);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(fastcronService.createBackfillCronJob).toHaveBeenCalledWith(
        mockWorkspaceId,
        mockConnectionId,
        expect.any(String),
        1,
        expect.anything()
      );
    });

    it('pauses and resumes backfill', async () => {
      // Pause
      const pauseReq = new Request('http://localhost/api/analytics/backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'pause', job_id: mockJobId }),
      });

      const pauseRes = await postBackfillAdmin({
        request: pauseReq,
        locals: { user: { id: 'u1' }, supabase: {}, activeWorkspaceId: mockWorkspaceId },
      } as any);

      expect(pauseRes.status).toBe(200);
      expect(mockJob.status).toBe('paused');
      expect(fastcronService.pauseBackfillCronJob).toHaveBeenCalled();

      // Resume
      const resumeReq = new Request('http://localhost/api/analytics/backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resume', job_id: mockJobId }),
      });

      const resumeRes = await postBackfillAdmin({
        request: resumeReq,
        locals: { user: { id: 'u1' }, supabase: {}, activeWorkspaceId: mockWorkspaceId },
      } as any);

      expect(resumeRes.status).toBe(200);
      expect(mockJob.status).toBe('running');
      expect(fastcronService.resumeBackfillCronJob).toHaveBeenCalled();
    });

    it('cancels backfill and deletes FastCron job', async () => {
      const cancelReq = new Request('http://localhost/api/analytics/backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', job_id: mockJobId }),
      });

      const cancelRes = await postBackfillAdmin({
        request: cancelReq,
        locals: { user: { id: 'u1' }, supabase: {}, activeWorkspaceId: mockWorkspaceId },
      } as any);

      expect(cancelRes.status).toBe(200);
      expect(mockJob.status).toBe('cancelled');
      expect(fastcronService.deleteBackfillCronJob).toHaveBeenCalledWith(
        mockWorkspaceId,
        9999,
        expect.anything(),
        mockConnectionId
      );
    });
  });
});
