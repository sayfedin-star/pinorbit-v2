export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../../server/auth/workspace-guard';
import { analyticsDb } from '../../../../server/db/analytics';
import { fastcronService } from '../../../../server/services/fastcron-service';

export const GET: APIRoute = async ({ locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const runtimeEnv = (locals as { runtime?: { env?: Record<string, any> }; runtimeEnv?: Record<string, any> })?.runtime?.env || (locals as { runtimeEnv?: Record<string, any> })?.runtimeEnv || {};

  if (!user || !schedulingClient) {
    return new Response(
      JSON.stringify({ success: false, error: 'Unauthorized: authentication required.' }),
      {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  if (!workspaceId) {
    return new Response(
      JSON.stringify({ success: false, error: 'Active workspace not found in session.' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  try {
    const { isAdmin } = await assertWorkspaceAccess(schedulingClient, workspaceId, user.id);

    const connections = await analyticsDb.listWorkspaceConnections(workspaceId);
    const settings = await analyticsDb.getWorkspaceAnalyticsSettings(workspaceId);

    // Collect all tokens in this workspace to fetch live jobs
    const tokens = new Set<string>();
    for (const conn of connections) {
      const tokA = await fastcronService.resolveFastCronToken(conn.analytics_fastcron_token || conn.fastcron_token, settings?.fastcron_token, runtimeEnv);
      if (tokA) tokens.add(tokA);
      const tokB = await fastcronService.resolveFastCronToken(conn.top_pins_fastcron_token || conn.fastcron_token, settings?.fastcron_token, runtimeEnv);
      if (tokB) tokens.add(tokB);
    }
    if (tokens.size === 0) {
      const wsTok = await fastcronService.resolveFastCronToken(null, settings?.fastcron_token, runtimeEnv);
      if (wsTok) tokens.add(wsTok);
    }

    // List jobs across distinct tokens
    const liveJobsMap = new Map<number, any>();
    for (const token of tokens) {
      try {
        const listRes = await fastcronService.listJobs(token, 'PinOrbit');
        if (listRes.success) {
          const list = Array.isArray(listRes.data?.data)
            ? listRes.data.data
            : Array.isArray(listRes.data?.jobs)
            ? listRes.data.jobs
            : Array.isArray(listRes.data)
            ? listRes.data
            : [];
          for (const j of list) {
            const jId = Number(j.id);
            if (!isNaN(jId) && jId > 0) {
              liveJobsMap.set(jId, j);
            }
          }
        }
      } catch (listErr) {
        console.warn('[CronJobsList] Failed to query FastCron list for token:', listErr);
      }
    }

    // Build merged jobs list scoped strictly to this workspace's connections
    const jobs: any[] = [];

    for (const conn of connections) {
      // Channel A: Account Analytics
      const idA = conn.analytics_fastcron_job_id ? Number(conn.analytics_fastcron_job_id) : null;
      const liveA = idA ? liveJobsMap.get(idA) : null;

      jobs.push({
        connection_id: conn.id,
        display_name: conn.display_name,
        channel: 'account_analytics',
        label: 'Pipeline A: Account Analytics',
        job_id: idA,
        cron_expression: conn.analytics_cron_expression || '0 4 * * *',
        sync_time: conn.analytics_sync_time || '04:00',
        schedule_status: conn.analytics_schedule_status || 'pending',
        webhook_url: isAdmin ? (conn.analytics_webhook_url || null) : null,
        has_webhook: Boolean(conn.analytics_webhook_url),
        live: liveA
          ? {
              id: idA,
              name: liveA.name,
              expression: liveA.expression,
              timezone: liveA.timezone || settings?.timezone || 'UTC',
              status: liveA.status || null,
              paused: liveA.paused ?? (liveA.status === 'PAUSED' || liveA.status === 'paused'),
              notify: liveA.notify ?? true,
              timeout: liveA.timeout ? Number(liveA.timeout) : 30,
              next_run_at: liveA.next_run_at || liveA.nextRun || null,
              last_run_at: liveA.last_run_at || liveA.lastRun || null,
              last_status: liveA.last_status || liveA.lastStatus || null,
            }
          : null,
      });

      // Channel B: Ranked Top Pins
      const idB = conn.top_pins_fastcron_job_id ? Number(conn.top_pins_fastcron_job_id) : null;
      const liveB = idB ? liveJobsMap.get(idB) : null;

      jobs.push({
        connection_id: conn.id,
        display_name: conn.display_name,
        channel: 'top_pins',
        label: 'Pipeline B: Ranked Top Pins',
        job_id: idB,
        cron_expression: conn.top_pins_cron_expression || '30 4 * * *',
        sync_time: conn.top_pins_sync_time || '04:30',
        schedule_status: conn.top_pins_schedule_status || 'pending',
        webhook_url: isAdmin ? (conn.top_pins_webhook_url || null) : null,
        has_webhook: Boolean(conn.top_pins_webhook_url),
        live: liveB
          ? {
              id: idB,
              name: liveB.name,
              expression: liveB.expression,
              timezone: liveB.timezone || settings?.timezone || 'UTC',
              status: liveB.status || null,
              paused: liveB.paused ?? (liveB.status === 'PAUSED' || liveB.status === 'paused'),
              notify: liveB.notify ?? true,
              timeout: liveB.timeout ? Number(liveB.timeout) : 30,
              next_run_at: liveB.next_run_at || liveB.nextRun || null,
              last_run_at: liveB.last_run_at || liveB.lastRun || null,
              last_status: liveB.last_status || liveB.lastStatus || null,
            }
          : null,
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        workspace_id: workspaceId,
        timezone: settings?.timezone || 'UTC',
        jobs,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (err: any) {
    const isAuth = err.message?.includes('Forbidden') || err.message?.includes('Unauthorized');
    return new Response(
      JSON.stringify({ success: false, error: err.message || 'Failed to list cron jobs.' }),
      {
        status: isAuth ? 403 : 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
};
