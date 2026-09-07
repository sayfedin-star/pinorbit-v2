export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../../server/auth/workspace-guard';
import { analyticsDb } from '../../../../server/db/analytics';
import { fastcronService } from '../../../../server/services/fastcron-service';

const FALLBACK_TIMEZONES = [
  'Africa/Cairo', 'Africa/Johannesburg', 'Africa/Lagos', 'Africa/Nairobi',
  'America/Anchorage', 'America/Argentina/Buenos_Aires', 'America/Bogota',
  'America/Caracas', 'America/Chicago', 'America/Denver', 'America/Halifax',
  'America/Los_Angeles', 'America/Mexico_City', 'America/New_York',
  'America/Phoenix', 'America/Santiago', 'America/Sao_Paulo', 'America/Toronto',
  'America/Vancouver', 'Asia/Bangkok', 'Asia/Dubai', 'Asia/Hong_Kong',
  'Asia/Jakarta', 'Asia/Jerusalem', 'Asia/Kolkata', 'Asia/Manila',
  'Asia/Riyadh', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Singapore',
  'Asia/Taipei', 'Asia/Tokyo', 'Atlantic/Reykjavik', 'Australia/Adelaide',
  'Australia/Brisbane', 'Australia/Melbourne', 'Australia/Perth',
  'Australia/Sydney', 'Europe/Amsterdam', 'Europe/Athens', 'Europe/Berlin',
  'Europe/Brussels', 'Europe/Dublin', 'Europe/Istanbul', 'Europe/Lisbon',
  'Europe/London', 'Europe/Madrid', 'Europe/Paris', 'Europe/Rome',
  'Pacific/Auckland', 'Pacific/Honolulu', 'UTC',
];

function isValidTimeZone(tz: string): boolean {
  if (!tz || typeof tz !== 'string') return false;
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.supportedValuesOf === 'function') {
      const supported = Intl.supportedValuesOf('timeZone');
      return supported.includes(tz);
    }
  } catch (e: any) {
    console.warn('[AnalyticsBulk] Intl.supportedValuesOf failed:', e?.message);
  }
  return FALLBACK_TIMEZONES.includes(tz);
}

// Concurrency helper with limit <= 3
async function runWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  const executing: Promise<void>[] = [];

  for (const item of items) {
    const p = Promise.resolve()
      .then(() => fn(item))
      .then((res) => {
        results.push(res);
      })
      .finally(() => {
        // Remove this promise from executing array when done
        const idx = executing.indexOf(p);
        if (idx !== -1) executing.splice(idx, 1);
      });

    executing.push(p);

    if (executing.length >= limit) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}

export const POST: APIRoute = async ({ request, locals }) => {
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

  let body: any = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return new Response(
      JSON.stringify({ success: false, error: 'Invalid JSON body.' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  const { action, job_ids, options } = body;

  const validActions = [
    'run',
    'enable',
    'disable',
    'pause',
    'delete',
    'logs',
    'failures',
    'next',
    'edit',
    'sync_missing',
  ];

  if (!action || !validActions.includes(action)) {
    return new Response(
      JSON.stringify({
        success: false,
        error: `Invalid action "${action}". Allowed: ${validActions.join(', ')}`,
      }),
      {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  try {
    const access = await assertWorkspaceAccess(schedulingClient, workspaceId, user.id);

    // Mutations require admin or owner role
    const mutationActions = ['run', 'enable', 'disable', 'pause', 'delete', 'edit', 'sync_missing'];
    if (mutationActions.includes(action) && !access.isAdmin && !access.isOwner) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Forbidden: Admin or Owner role required to execute bulk cron actions.',
        }),
        {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    const connections = await analyticsDb.listWorkspaceConnections(workspaceId);
    const settings = await analyticsDb.getWorkspaceAnalyticsSettings(workspaceId);

    // Build jobMap: job_id -> { connection, channel }
    const jobMap = new Map<number, { connection: any; channel: 'account_analytics' | 'top_pins' }>();
    for (const conn of connections) {
      if (conn.analytics_fastcron_job_id != null) {
        jobMap.set(Number(conn.analytics_fastcron_job_id), { connection: conn, channel: 'account_analytics' });
      }
      if (conn.top_pins_fastcron_job_id != null) {
        jobMap.set(Number(conn.top_pins_fastcron_job_id), { connection: conn, channel: 'top_pins' });
      }
    }

    // If sync_missing action, handle connections missing job IDs
    if (action === 'sync_missing') {
      const results: any[] = [];
      for (const conn of connections) {
        if (!conn.analytics_fastcron_job_id && conn.analytics_webhook_url) {
          const resA = await fastcronService.syncScheduleWithFastCron(workspaceId, conn.id, 'analytics', runtimeEnv);
          results.push({
            connection_id: conn.id,
            display_name: conn.display_name,
            channel: 'account_analytics',
            success: resA.success,
            fastcron_job_id: resA.fastcron_job_id || null,
            error: resA.error,
          });
        }
        if (!conn.top_pins_fastcron_job_id && conn.top_pins_webhook_url) {
          const resB = await fastcronService.syncScheduleWithFastCron(workspaceId, conn.id, 'top_pins', runtimeEnv);
          results.push({
            connection_id: conn.id,
            display_name: conn.display_name,
            channel: 'top_pins',
            success: resB.success,
            fastcron_job_id: resB.fastcron_job_id || null,
            error: resB.error,
          });
        }
      }

      return new Response(
        JSON.stringify({
          success: true,
          action: 'sync_missing',
          results,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Validate job_ids array
    if (!Array.isArray(job_ids) || job_ids.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'job_ids must be a non-empty array of numbers.' }),
        {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    const numericJobIds = job_ids.map((id) => Number(id)).filter((id) => !isNaN(id) && id > 0);
    if (numericJobIds.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'job_ids must contain valid numeric IDs.' }),
        {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Tenant Isolation Check: Verify all job_ids belong to this workspace
    const unknownJobIds: number[] = [];
    for (const jId of numericJobIds) {
      if (!jobMap.has(jId)) {
        unknownJobIds.push(jId);
      }
    }

    if (unknownJobIds.length > 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Forbidden: One or more job_ids do not belong to this workspace.',
          unknown_job_ids: unknownJobIds,
        }),
        {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Execute according to action
    const results: any[] = [];

    if (action === 'run') {
      const fromOverride = options?.from_date || options?.start_date;
      const toOverride = options?.to_date || options?.end_date;

      if (fromOverride && toOverride && fromOverride > toOverride) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Validation Error: start_date must be before end_date (identical dates allowed for same-day pull).',
          }),
          {
            status: 422,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      await runWithConcurrencyLimit(numericJobIds, 3, async (jId) => {
        const item = jobMap.get(jId)!;
        const channelToken = item.channel === 'account_analytics' ? item.connection.analytics_fastcron_token : item.connection.top_pins_fastcron_token;
        const effectiveConnToken = channelToken || item.connection.fastcron_token;
        const token = await fastcronService.resolveFastCronToken(effectiveConnToken, settings?.fastcron_token, runtimeEnv);

        if (!token) {
          results.push({ job_id: jId, success: false, error: 'FastCron token not configured.' });
          return;
        }

        const isAnalytics = item.channel === 'account_analytics';
        const startOffset = isAnalytics
          ? (item.connection.analytics_start_offset_days ?? 7)
          : (item.connection.top_pins_start_offset_days ?? 7);
        const endOffset = isAnalytics
          ? (item.connection.analytics_end_offset_days ?? 1)
          : (item.connection.top_pins_end_offset_days ?? 2);

        let startDate: string;
        let endDate: string;
        if (fromOverride && toOverride) {
          startDate = fromOverride;
          endDate = toOverride;
        } else {
          const now = new Date();
          const sObj = new Date(now.getTime() - startOffset * 24 * 60 * 60 * 1000);
          const eObj = new Date(now.getTime() - endOffset * 24 * 60 * 60 * 1000);
          startDate = sObj.toISOString().split('T')[0];
          endDate = eObj.toISOString().split('T')[0];
        }

        const payloadObj: Record<string, any> = {
          job_type: 'manual_sync',
          channel: item.channel,
          connection_id: item.connection.id,
          start_date: startDate,
          end_date: endDate,
        };

        if (isAnalytics) {
          payloadObj.analytics_start_offset_days = startOffset;
          payloadObj.analytics_end_offset_days = endOffset;
        } else {
          payloadObj.top_pins_start_offset_days = startOffset;
          payloadObj.top_pins_end_offset_days = endOffset;
          payloadObj.num_of_pins = item.connection.top_pins_num_of_pins || 50;
          payloadObj.sort_modes = item.connection.top_pins_sort_modes || ['IMPRESSION', 'OUTBOUND_CLICK', 'SAVE', 'ENGAGEMENT', 'PIN_CLICK'];
        }

        const runRes = await fastcronService.fastcronCall('cron_run', { id: jId, payload: JSON.stringify(payloadObj) }, token);
        results.push({
          job_id: jId,
          channel: item.channel,
          display_name: item.connection.display_name,
          success: runRes.success,
          error: runRes.error,
          startDate,
          endDate,
        });
      });
    } else if (action === 'pause') {
      const forExpr = String(options?.for || '').trim();
      const pauseRegex = /^((15|30|45) minutes|\d+ (hour|day)s?)$/;

      if (!forExpr || !pauseRegex.test(forExpr)) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'options.for is required and must match "(15|30|45) minutes" or "N hour(s)" or "N day(s)" (e.g. "1 hour", "30 minutes").',
          }),
          {
            status: 422,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      await runWithConcurrencyLimit(numericJobIds, 3, async (jId) => {
        const item = jobMap.get(jId)!;
        const channelToken = item.channel === 'account_analytics' ? item.connection.analytics_fastcron_token : item.connection.top_pins_fastcron_token;
        const effectiveConnToken = channelToken || item.connection.fastcron_token;
        const token = await fastcronService.resolveFastCronToken(effectiveConnToken, settings?.fastcron_token, runtimeEnv);

        if (!token) {
          results.push({ job_id: jId, success: false, error: 'FastCron token not configured.' });
          return;
        }

        const pauseRes = await fastcronService.pauseJob(jId, forExpr, token);
        results.push({
          job_id: jId,
          channel: item.channel,
          display_name: item.connection.display_name,
          success: pauseRes.success,
          error: pauseRes.error,
        });
      });
    } else if (action === 'enable') {
      await runWithConcurrencyLimit(numericJobIds, 3, async (jId) => {
        const item = jobMap.get(jId)!;
        const ok = await fastcronService.enableFastCronJob(workspaceId, jId, runtimeEnv, item.connection.id);
        results.push({
          job_id: jId,
          channel: item.channel,
          display_name: item.connection.display_name,
          success: ok,
          error: ok ? undefined : 'Failed to enable FastCron job.',
        });
      });
    } else if (action === 'disable') {
      await runWithConcurrencyLimit(numericJobIds, 3, async (jId) => {
        const item = jobMap.get(jId)!;
        const ok = await fastcronService.disableFastCronJob(workspaceId, jId, runtimeEnv, item.connection.id);
        results.push({
          job_id: jId,
          channel: item.channel,
          display_name: item.connection.display_name,
          success: ok,
          error: ok ? undefined : 'Failed to disable FastCron job.',
        });
      });
    } else if (action === 'edit') {
      // Validate edit options
      const editPayload: Record<string, any> = {};

      if (options?.timeout !== undefined) {
        const timeout = Number(options.timeout);
        if (isNaN(timeout) || timeout < 5 || timeout > 60) {
          return new Response(
            JSON.stringify({ success: false, error: 'timeout must be an integer between 5 and 60.' }),
            { status: 422, headers: { 'Content-Type': 'application/json' } }
          );
        }
        editPayload.timeout = timeout;
      }

      if (options?.instances !== undefined) {
        const instances = Number(options.instances);
        if (isNaN(instances) || instances < 0 || instances > 5) {
          return new Response(
            JSON.stringify({ success: false, error: 'instances must be an integer between 0 and 5.' }),
            { status: 422, headers: { 'Content-Type': 'application/json' } }
          );
        }
        editPayload.instances = instances;
      }

      if (options?.notify !== undefined) {
        if (typeof options.notify !== 'boolean') {
          return new Response(
            JSON.stringify({ success: false, error: 'notify must be a boolean.' }),
            { status: 422, headers: { 'Content-Type': 'application/json' } }
          );
        }
        editPayload.notify = options.notify;
      }

      if (options?.timezone !== undefined) {
        const tz = String(options.timezone).trim();
        if (!isValidTimeZone(tz)) {
          return new Response(
            JSON.stringify({ success: false, error: 'Invalid timezone.' }),
            { status: 422, headers: { 'Content-Type': 'application/json' } }
          );
        }
        editPayload.timezone = tz;
      }

      if (options?.expression !== undefined) {
        const expr = String(options.expression).trim();
        editPayload.expression = expr;
      }

      await runWithConcurrencyLimit(numericJobIds, 3, async (jId) => {
        const item = jobMap.get(jId)!;
        const channelToken = item.channel === 'account_analytics' ? item.connection.analytics_fastcron_token : item.connection.top_pins_fastcron_token;
        const effectiveConnToken = channelToken || item.connection.fastcron_token;
        const token = await fastcronService.resolveFastCronToken(effectiveConnToken, settings?.fastcron_token, runtimeEnv);

        if (!token) {
          results.push({ job_id: jId, success: false, error: 'FastCron token not configured.' });
          return;
        }

        const editRes = await fastcronService.editJob(jId, editPayload, token);
        if (editRes.success) {
          // Sync DB options where relevant
          const dbUpdates: Record<string, any> = {};
          if (editPayload.notify !== undefined) dbUpdates.fastcron_notify = editPayload.notify;
          if (editPayload.timeout !== undefined) dbUpdates.fastcron_timeout = editPayload.timeout;
          if (editPayload.instances !== undefined) dbUpdates.fastcron_instances = editPayload.instances;
          if (editPayload.expression !== undefined) {
            if (item.channel === 'account_analytics') dbUpdates.analytics_cron_expression = editPayload.expression;
            else dbUpdates.top_pins_cron_expression = editPayload.expression;
          }
          if (Object.keys(dbUpdates).length > 0) {
            await analyticsDb.updateWorkspaceConnection(workspaceId, item.connection.id, dbUpdates);
          }
        }

        results.push({
          job_id: jId,
          channel: item.channel,
          display_name: item.connection.display_name,
          success: editRes.success,
          error: editRes.error,
        });
      });
    } else if (action === 'delete') {
      // Group job IDs by token
      const tokenGroups = new Map<string, number[]>();
      for (const jId of numericJobIds) {
        const item = jobMap.get(jId)!;
        const channelToken = item.channel === 'account_analytics' ? item.connection.analytics_fastcron_token : item.connection.top_pins_fastcron_token;
        const effectiveConnToken = channelToken || item.connection.fastcron_token;
        const token = await fastcronService.resolveFastCronToken(effectiveConnToken, settings?.fastcron_token, runtimeEnv);
        if (token) {
          const arr = tokenGroups.get(token) || [];
          arr.push(jId);
          tokenGroups.set(token, arr);
        } else {
          results.push({ job_id: jId, success: false, error: 'FastCron token not configured.' });
        }
      }

      for (const [token, ids] of tokenGroups.entries()) {
        try {
          if (ids.length > 1) {
            const bRes = await fastcronService.batchDelete(ids, token);
            for (const jId of ids) {
              results.push({ job_id: jId, success: bRes.success, error: bRes.error });
            }
          } else {
            const sRes = await fastcronService.deleteFastCronJob(workspaceId, ids[0], runtimeEnv);
            results.push({ job_id: ids[0], success: sRes, error: sRes ? undefined : 'Delete failed.' });
          }
        } catch (delErr: any) {
          for (const jId of ids) {
            results.push({ job_id: jId, success: false, error: delErr.message });
          }
        }
      }

      // DB Cleanup: Set deleted job ID columns to null and schedule_status to pending
      const deletedSet = new Set(
        results
          .filter((r) => r.success === true)
          .map((r) => Number(r.job_id))
          .filter((n) => !Number.isNaN(n))
      );
      for (const conn of connections) {
        const updates: Record<string, any> = {};
        if (conn.analytics_fastcron_job_id && deletedSet.has(Number(conn.analytics_fastcron_job_id))) {
          updates.analytics_fastcron_job_id = null;
          updates.analytics_schedule_status = 'pending';
        }
        if (conn.top_pins_fastcron_job_id && deletedSet.has(Number(conn.top_pins_fastcron_job_id))) {
          updates.top_pins_fastcron_job_id = null;
          updates.top_pins_schedule_status = 'pending';
        }
        if (Object.keys(updates).length > 0) {
          await analyticsDb.updateWorkspaceConnection(workspaceId, conn.id, updates);
        }
      }
    } else if (action === 'logs') {
      const logsList: any[] = [];
      await runWithConcurrencyLimit(numericJobIds, 3, async (jId) => {
        const item = jobMap.get(jId)!;
        const channelToken = item.channel === 'account_analytics' ? item.connection.analytics_fastcron_token : item.connection.top_pins_fastcron_token;
        const effectiveConnToken = channelToken || item.connection.fastcron_token;
        const token = await fastcronService.resolveFastCronToken(effectiveConnToken, settings?.fastcron_token, runtimeEnv);

        if (!token) return;

        const res = await fastcronService.fastcronCall('cron_logs', { id: jId }, token);
        if (res.success) {
          const l = Array.isArray(res.data?.logs) ? res.data.logs : Array.isArray(res.data?.data) ? res.data.data : Array.isArray(res.data) ? res.data : [];
          for (const entry of l) {
            logsList.push({
              ...entry,
              job_id: jId,
              channel: item.channel,
              display_name: item.connection.display_name,
            });
          }
        }
        results.push({ job_id: jId, success: res.success, error: res.error });
      });

      // Sort desc by started_at/time
      logsList.sort((a, b) => {
        const tA = new Date(a.date || a.started_at || a.time || 0).getTime();
        const tB = new Date(b.date || b.started_at || b.time || 0).getTime();
        return tB - tA;
      });

      return new Response(
        JSON.stringify({
          success: true,
          action: 'logs',
          data: logsList,
          results,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    } else if (action === 'failures') {
      const failuresList: any[] = [];
      await runWithConcurrencyLimit(numericJobIds, 3, async (jId) => {
        const item = jobMap.get(jId)!;
        const channelToken = item.channel === 'account_analytics' ? item.connection.analytics_fastcron_token : item.connection.top_pins_fastcron_token;
        const effectiveConnToken = channelToken || item.connection.fastcron_token;
        const token = await fastcronService.resolveFastCronToken(effectiveConnToken, settings?.fastcron_token, runtimeEnv);

        if (!token) return;

        const res = await fastcronService.getFailures(jId, token);
        if (res.success) {
          const l = Array.isArray(res.data?.failures) ? res.data.failures : Array.isArray(res.data?.data) ? res.data.data : Array.isArray(res.data) ? res.data : [];
          for (const entry of l) {
            failuresList.push({
              ...entry,
              job_id: jId,
              channel: item.channel,
              display_name: item.connection.display_name,
            });
          }
        }
        results.push({ job_id: jId, success: res.success, error: res.error });
      });

      failuresList.sort((a, b) => {
        const tA = new Date(a.date || a.started_at || a.time || 0).getTime();
        const tB = new Date(b.date || b.started_at || b.time || 0).getTime();
        return tB - tA;
      });

      return new Response(
        JSON.stringify({
          success: true,
          action: 'failures',
          data: failuresList,
          results,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    } else if (action === 'next') {
      const nextMap: Record<string, any> = {};
      await runWithConcurrencyLimit(numericJobIds, 3, async (jId) => {
        const item = jobMap.get(jId)!;
        const channelToken = item.channel === 'account_analytics' ? item.connection.analytics_fastcron_token : item.connection.top_pins_fastcron_token;
        const effectiveConnToken = channelToken || item.connection.fastcron_token;
        const token = await fastcronService.resolveFastCronToken(effectiveConnToken, settings?.fastcron_token, runtimeEnv);

        if (!token) return;

        const res = await fastcronService.nextRuns(jId, token);
        if (res.success) {
          nextMap[jId] = {
            job_id: jId,
            channel: item.channel,
            display_name: item.connection.display_name,
            runs: res.data?.data || res.data?.runs || (Array.isArray(res.data) ? res.data : []),
          };
        }
        results.push({ job_id: jId, success: res.success, error: res.error, data: res.data });
      });

      return new Response(
        JSON.stringify({
          success: true,
          action: 'next',
          data: nextMap,
          results,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        action,
        results,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (err: any) {
    const isAuth = err.message?.includes('Forbidden') || err.message?.includes('Unauthorized');
    return new Response(
      JSON.stringify({ success: false, error: err.message || 'Bulk cron action failed.' }),
      {
        status: isAuth ? 403 : 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
};
