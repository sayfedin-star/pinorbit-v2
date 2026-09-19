import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fastcronService } from '../services/fastcron-service';
import { analyticsDb } from '../db/analytics';
import { POST as triggerSyncHandler } from '../../pages/api/analytics/trigger-sync';

vi.mock('../db/analytics', () => ({
  analyticsDb: {
    getWorkspaceConnection: vi.fn(),
    getWorkspaceAnalyticsSettings: vi.fn(),
  },
}));

vi.mock('../auth/workspace-guard', () => ({
  assertWorkspaceAccess: vi.fn().mockResolvedValue({
    id: 'mem-1',
    role: 'owner',
    isAdmin: true,
    isOwner: true,
  }),
}));

describe('Manual Trigger & Test Ping Sync Suite (V20.1 Per-Pipeline Date Offsets & Overrides, R31.1 Ping Dates)', () => {
  const workspaceId = '00000000-0000-0000-0000-000000000001';
  const connectionId = 'a1b2c3d4-e5f6-7890-1234-56789abcdef0';
  const mockRuntimeEnv = { FASTCRON_API_TOKEN: 'valid_fastcron_token_12345' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ping mode includes start_date and end_date in payload', async () => {
    (analyticsDb.getWorkspaceConnection as any).mockResolvedValue({
      id: connectionId,
      workspace_id: workspaceId,
      display_name: 'hymumdotcom',
      analytics_webhook_url: 'https://hook.make.com/pipeline-a',
      analytics_start_offset_days: 7,
      analytics_end_offset_days: 1,
    });

    let sentPayload: any = null;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init: any) => {
      expect(url).toBe('https://hook.make.com/pipeline-a');
      sentPayload = JSON.parse(init.body);
      return { ok: true, status: 200 } as any;
    }) as any);

    const result = await fastcronService.triggerManualSync(
      workspaceId,
      connectionId,
      'analytics',
      'ping',
      mockRuntimeEnv
    );

    expect(result.success).toBe(true);
    expect(result.mode).toBe('ping');
    expect(sentPayload.job_type).toBe('ping');
    expect(sentPayload.channel).toBe('account_analytics');
    expect(sentPayload.connection_id).toBe(connectionId);
    expect(sentPayload.start_date).toBeDefined();
    expect(sentPayload.end_date).toBeDefined();
    expect(sentPayload.start_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(sentPayload.end_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    fetchSpy.mockRestore();
  });

  it('ping mode uses channel offsets when no overrides', async () => {
    (analyticsDb.getWorkspaceConnection as any).mockResolvedValue({
      id: connectionId,
      workspace_id: workspaceId,
      display_name: 'hymumdotcom',
      top_pins_webhook_url: 'https://hook.make.com/pipeline-b',
      top_pins_start_offset_days: 14,
      top_pins_end_offset_days: 3,
      top_pins_num_of_pins: 25,
      top_pins_sort_modes: ['IMPRESSION', 'SAVE'],
    });

    let sentPayload: any = null;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init: any) => {
      expect(url).toBe('https://hook.make.com/pipeline-b');
      sentPayload = JSON.parse(init.body);
      return { ok: true, status: 200 } as any;
    }) as any);

    const result = await fastcronService.triggerManualSync(
      workspaceId,
      connectionId,
      'top_pins',
      'ping',
      mockRuntimeEnv
    );

    expect(result.success).toBe(true);
    expect(sentPayload.channel).toBe('top_pins');
    expect(sentPayload.num_of_pins).toBe(25);
    expect(sentPayload.sort_modes).toEqual(['IMPRESSION', 'SAVE']);
    expect(sentPayload.start_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(sentPayload.end_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Verify computed start_date is roughly 14 days ago and end_date is 3 days ago
    const now = new Date();
    const expectedStart = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const expectedEnd = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    expect(sentPayload.start_date).toBe(expectedStart);
    expect(sentPayload.end_date).toBe(expectedEnd);

    fetchSpy.mockRestore();
  });

  it('ping mode respects override dates when provided', async () => {
    (analyticsDb.getWorkspaceConnection as any).mockResolvedValue({
      id: connectionId,
      workspace_id: workspaceId,
      display_name: 'hymumdotcom',
      analytics_webhook_url: 'https://hook.make.com/pipeline-a',
      analytics_start_offset_days: 7,
      analytics_end_offset_days: 1,
    });

    let sentPayload: any = null;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (_url: string, init: any) => {
      sentPayload = JSON.parse(init.body);
      return { ok: true, status: 200 } as any;
    }) as any);

    const result = await fastcronService.triggerManualSync(
      workspaceId,
      connectionId,
      'analytics',
      'ping',
      mockRuntimeEnv,
      { from_date: '2026-06-01', to_date: '2026-06-30' }
    );

    expect(result.success).toBe(true);
    expect(sentPayload.start_date).toBe('2026-06-01');
    expect(sentPayload.end_date).toBe('2026-06-30');

    fetchSpy.mockRestore();
  });

  it('V20.1: triggerManualSync uses channel-specific offsets and includes them in cron_run payload', async () => {
    (analyticsDb.getWorkspaceConnection as any).mockResolvedValue({
      id: connectionId,
      workspace_id: workspaceId,
      display_name: 'hymumdotcom',
      analytics_webhook_url: 'https://hook.make.com/pipeline-a',
      analytics_fastcron_job_id: 8899,
      analytics_start_offset_days: 14,
      analytics_end_offset_days: 3,
    });
    (analyticsDb.getWorkspaceAnalyticsSettings as any).mockResolvedValue({
      fastcron_token: 'db_token_1234567890',
    });

    let capturedUrl = '';
    let capturedBody: any = null;

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init: any) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body);
      return {
        status: 200,
        ok: true,
        json: async () => ({ status: 'OK' }),
      } as any;
    }) as any);

    const result = await fastcronService.triggerManualSync(
      workspaceId,
      connectionId,
      'analytics',
      'sync',
      mockRuntimeEnv
    );

    expect(result.success).toBe(true);
    expect(capturedUrl).toContain('/cron_run');
    expect(capturedBody.id).toBe(8899);

    const innerPayload = JSON.parse(capturedBody.payload);
    expect(innerPayload.job_type).toBe('manual_sync');
    expect(innerPayload.channel).toBe('account_analytics');
    expect(innerPayload.connection_id).toBe(connectionId);
    expect(innerPayload.analytics_start_offset_days).toBe(14);
    expect(innerPayload.analytics_end_offset_days).toBe(3);
    expect(innerPayload.start_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(innerPayload.end_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    fetchSpy.mockRestore();
  });

  it('V20.1: manual run date override takes precedence and is forwarded in payload', async () => {
    (analyticsDb.getWorkspaceConnection as any).mockResolvedValue({
      id: connectionId,
      workspace_id: workspaceId,
      display_name: 'hymumdotcom',
      top_pins_webhook_url: 'https://hook.make.com/pipeline-b',
      top_pins_fastcron_job_id: 9900,
      top_pins_start_offset_days: 7,
      top_pins_end_offset_days: 2,
    });
    (analyticsDb.getWorkspaceAnalyticsSettings as any).mockResolvedValue({
      fastcron_token: 'db_token_1234567890',
    });

    let capturedBody: any = null;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (_url: string, init: any) => {
      capturedBody = JSON.parse(init.body);
      return {
        status: 200,
        ok: true,
        json: async () => ({ status: 'OK' }),
      } as any;
    }) as any);

    const result = await fastcronService.triggerManualSync(
      workspaceId,
      connectionId,
      'top_pins',
      'sync',
      mockRuntimeEnv,
      { from_date: '2026-07-01', to_date: '2026-07-15' }
    );

    expect(result.success).toBe(true);
    const innerPayload = JSON.parse(capturedBody.payload);
    expect(innerPayload.start_date).toBe('2026-07-01');
    expect(innerPayload.end_date).toBe('2026-07-15');
    expect(innerPayload.channel).toBe('top_pins');
    expect(innerPayload.top_pins_start_offset_days).toBe(7);
    expect(innerPayload.top_pins_end_offset_days).toBe(2);

    fetchSpy.mockRestore();
  });

  it('V20.2: rejects manual run override when start_date > end_date with 422', async () => {
    const locals = { user: { id: 'u1' }, supabase: {}, activeWorkspaceId: workspaceId };

    const req = new Request('http://localhost/api/analytics/trigger-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connection_id: connectionId,
        channel: 'analytics',
        mode: 'sync',
        from_date: '2026-08-10',
        to_date: '2026-08-05', // start > end -> invalid
      }),
    });

    const res = await triggerSyncHandler({ request: req, locals } as any);
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toContain('Validation Error: start_date must be before end_date (identical dates allowed for same-day pull).');
  });

  it('V20.2: allows manual run override with identical start_date and end_date (same-day range)', async () => {
    (analyticsDb.getWorkspaceConnection as any).mockResolvedValue({
      id: connectionId,
      workspace_id: workspaceId,
      display_name: 'hymumdotcom',
      analytics_webhook_url: 'https://hook.make.com/pipeline-a',
      analytics_fastcron_job_id: 8899,
      analytics_start_offset_days: 7,
      analytics_end_offset_days: 1,
    });
    (analyticsDb.getWorkspaceAnalyticsSettings as any).mockResolvedValue({
      fastcron_token: 'db_token_1234567890',
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async () => ({
      status: 200,
      ok: true,
      json: async () => ({ status: 'OK' }),
    })) as any);

    const locals = { user: { id: 'u1' }, supabase: {}, activeWorkspaceId: workspaceId };

    const req = new Request('http://localhost/api/analytics/trigger-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connection_id: connectionId,
        channel: 'analytics',
        mode: 'sync',
        from_date: '2026-08-10',
        to_date: '2026-08-10',
      }),
    });

    const res = await triggerSyncHandler({ request: req, locals } as any);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);

    fetchSpy.mockRestore();
  });

  it('R2 / B6: Falls back gracefully to legacy direct POST with Content-Type: application/json and all mappable fields', async () => {
    (analyticsDb.getWorkspaceConnection as any).mockResolvedValue({
      id: connectionId,
      workspace_id: workspaceId,
      display_name: 'hymumdotcom',
      analytics_webhook_url: 'https://hook.make.com/pipeline-a',
      analytics_fastcron_job_id: null,
      analytics_start_offset_days: 7,
      analytics_end_offset_days: 1,
    });
    (analyticsDb.getWorkspaceAnalyticsSettings as any).mockResolvedValue({
      fastcron_token: null,
    });

    let sentHeaders: any = null;
    let sentPayload: any = null;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init: any) => {
      expect(url).toBe('https://hook.make.com/pipeline-a');
      sentHeaders = init.headers;
      sentPayload = JSON.parse(init.body);
      return { ok: true, status: 200 } as any;
    }) as any);

    const result = await fastcronService.triggerManualSync(
      workspaceId,
      connectionId,
      'analytics',
      'sync',
      mockRuntimeEnv
    );

    expect(result.success).toBe(true);
    expect(sentHeaders['Content-Type']).toBe('application/json');
    expect(sentPayload.connection_id).toBe(connectionId);
    expect(sentPayload.start_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(sentPayload.end_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(sentPayload.analytics_start_offset_days).toBe(7);
    expect(sentPayload.analytics_end_offset_days).toBe(1);
    expect(sentPayload.job_type).toBe('manual_sync');
    expect(sentPayload.channel).toBe('account_analytics');

    fetchSpy.mockRestore();
  });

  it('direct: true bypasses FastCron cron_run and dispatches directly to webhookUrl', async () => {
    (analyticsDb.getWorkspaceConnection as any).mockResolvedValue({
      id: connectionId,
      workspace_id: workspaceId,
      display_name: 'hymumdotcom',
      top_pins_webhook_url: 'https://hook.make.com/pipeline-b-direct',
      top_pins_fastcron_job_id: 12345, // fastcron job exists!
      top_pins_start_offset_days: 7,
      top_pins_end_offset_days: 2,
      top_pins_num_of_pins: 50,
      top_pins_sort_modes: ['IMPRESSION'],
    });
    (analyticsDb.getWorkspaceAnalyticsSettings as any).mockResolvedValue({
      fastcron_token: 'db_token_1234567890',
    });

    let calledUrl = '';
    let sentPayload: any = null;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init: any) => {
      calledUrl = url;
      sentPayload = JSON.parse(init.body);
      return { ok: true, status: 200 } as any;
    }) as any);

    const result = await fastcronService.triggerManualSync(
      workspaceId,
      connectionId,
      'top_pins',
      'sync',
      mockRuntimeEnv,
      { from_date: '2026-03-24', to_date: '2026-03-24', direct: true }
    );

    expect(result.success).toBe(true);
    // Verified: It called the Make.com webhook URL directly, NOT FastCron API (/cron_run)
    expect(calledUrl).toBe('https://hook.make.com/pipeline-b-direct');
    expect(calledUrl).not.toContain('/cron_run');
    expect(sentPayload.job_type).toBe('manual_sync');
    expect(sentPayload.channel).toBe('top_pins');
    expect(sentPayload.start_date).toBe('2026-03-24');
    expect(sentPayload.end_date).toBe('2026-03-24');
    expect(sentPayload.num_of_pins).toBe(50);
    expect(sentPayload.sort_modes).toEqual(['IMPRESSION']);

    fetchSpy.mockRestore();
  });
});

