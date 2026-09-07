export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../../../server/auth/workspace-guard';
import { analyticsDb } from '../../../../../server/db/analytics';
import { fastcronService } from '../../../../../server/services/fastcron-service';
import { getServerEnv } from '../../../../../server/db/clients';
import { encryptToken } from '../../../../../server/lib/token-crypto';
import type { AnalyticsConnectionSettingsResponse } from '../../../../../lib/types';

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
    console.warn('[AnalyticsSettings] Intl.supportedValuesOf failed:', e?.message);
  }
  return FALLBACK_TIMEZONES.includes(tz);
}

export const GET: APIRoute = async ({ params, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const connectionId = params.id;

  if (!user || !schedulingClient) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized: authentication required.' }),
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

  if (!connectionId) {
    return new Response(
      JSON.stringify({ success: false, error: 'connection ID parameter is required.' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  try {
    await assertWorkspaceAccess(schedulingClient, workspaceId, user.id);
    const connection = await analyticsDb.getWorkspaceConnection(workspaceId, connectionId);

    if (!connection) {
      return new Response(
        JSON.stringify({ success: false, error: 'Connection not found in this workspace.' }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    let latestFailedAccount: any = null;
    try {
      latestFailedAccount = await analyticsDb.getLatestFailedRun(workspaceId, connection.id, 'account_analytics');
    } catch {
      latestFailedAccount = null;
    }

    let latestFailedTopPins: any = null;
    try {
      latestFailedTopPins = await analyticsDb.getLatestFailedRun(workspaceId, connection.id, 'top_pins');
    } catch {
      latestFailedTopPins = null;
    }

    let health: any = null;
    try {
      health = await analyticsDb.getConnectionHealth(connection.id);
    } catch {
      health = null;
    }

    const hasAnalyticsToken = Boolean(connection.analytics_fastcron_token && connection.analytics_fastcron_token.trim().length >= 16);
    const hasTopPinsToken = Boolean(connection.top_pins_fastcron_token && connection.top_pins_fastcron_token.trim().length >= 16);
    const analyticsFingerprint = hasAnalyticsToken
      ? '••••' + (connection.analytics_fastcron_token ?? '').trim().slice(-4)
      : null;
    const topPinsFingerprint = hasTopPinsToken
      ? '••••' + (connection.top_pins_fastcron_token ?? '').trim().slice(-4)
      : null;

    const responseData: AnalyticsConnectionSettingsResponse = {
      id: connection.id,
      display_name: connection.display_name,
      revoked_at: connection.revoked_at || null,
      last_analytics_sync_at: connection.last_analytics_sync_at || null,
      analytics_webhook_url: connection.analytics_webhook_url || null,
      analytics_sync_time: connection.analytics_sync_time || '04:00',
      analytics_cron_expression: connection.analytics_cron_expression || '0 4 * * *',
      analytics_schedule_status: connection.analytics_schedule_status || 'pending',
      analytics_start_offset_days: connection.analytics_start_offset_days ?? 7,
      analytics_end_offset_days: connection.analytics_end_offset_days ?? 1,
      top_pins_webhook_url: connection.top_pins_webhook_url || null,
      top_pins_sync_time: connection.top_pins_sync_time || '04:30',
      top_pins_cron_expression: connection.top_pins_cron_expression || '30 4 * * *',
      top_pins_schedule_status: connection.top_pins_schedule_status || 'pending',
      top_pins_start_offset_days: connection.top_pins_start_offset_days ?? 7,
      top_pins_end_offset_days: connection.top_pins_end_offset_days ?? 2,
      top_pins_num_of_pins: connection.top_pins_num_of_pins ?? 50,
      top_pins_sort_modes: connection.top_pins_sort_modes || [
        'IMPRESSION',
        'OUTBOUND_CLICK',
        'SAVE',
        'ENGAGEMENT',
        'PIN_CLICK',
      ],
      has_fastcron_token: Boolean(connection.fastcron_token && connection.fastcron_token.trim().length >= 16),
      has_analytics_fastcron_token: hasAnalyticsToken,
      has_top_pins_fastcron_token: hasTopPinsToken,
      token_fingerprint: connection.fastcron_token && connection.fastcron_token.trim().length >= 16 
        ? '••••' + connection.fastcron_token.trim().slice(-4) 
        : null,
      analytics_token_fingerprint: analyticsFingerprint,
      analytics_fastcron_token_fingerprint: analyticsFingerprint,
      top_pins_token_fingerprint: topPinsFingerprint,
      top_pins_fastcron_token_fingerprint: topPinsFingerprint,
      fastcron_notify: connection.fastcron_notify ?? true,
      fastcron_timeout: connection.fastcron_timeout ?? 30,
      fastcron_instances: connection.fastcron_instances ?? 1,
      health: health ? {
        total_runs: health.total_runs ?? 0,
        consecutive_failures: health.consecutive_failures ?? 0,
        last_success_at: health.last_success_at || null,
        revoked: health.revoked ?? false,
      } : null,
      last_error_a: latestFailedAccount?.error_details?.message || latestFailedAccount?.error_details?.error || null,
      last_error_b: latestFailedTopPins?.error_details?.message || latestFailedTopPins?.error_details?.error || null,
    };

    return new Response(JSON.stringify({ success: true, data: responseData }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    const isAuth = err.message?.includes('Forbidden') || err.message?.includes('Unauthorized');
    return new Response(
      JSON.stringify({ success: false, error: err.message || 'Failed to get connection settings.' }),
      {
        status: isAuth ? 403 : 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
};

export const POST: APIRoute = async ({ params, request, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const connectionId = params.id;
  const runtimeEnv = (locals as { runtime?: { env?: Record<string, any> }; runtimeEnv?: Record<string, any> })?.runtime?.env || (locals as { runtimeEnv?: Record<string, any> })?.runtimeEnv || {};

  if (!user || !schedulingClient) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized: authentication required.' }),
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

  if (!connectionId) {
    return new Response(
      JSON.stringify({ success: false, error: 'connection ID parameter is required.' }),
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

  try {
    const access = await assertWorkspaceAccess(schedulingClient, workspaceId, user.id);
    if (!access.isAdmin && !access.isOwner) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Forbidden: Admin or Owner role required to edit connection settings.',
        }),
        {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    const existing = await analyticsDb.getWorkspaceConnection(workspaceId, connectionId);
    if (!existing) {
      return new Response(
        JSON.stringify({ success: false, error: 'Connection not found in this workspace.' }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    const updates: any = {};

    // Validate and update Pipeline A (Account Analytics)
    if (body.analytics_webhook_url !== undefined) {
      if (body.analytics_webhook_url) {
        const v = fastcronService.validateWebhookUrl(body.analytics_webhook_url);
        if (!v.valid) {
          return new Response(
            JSON.stringify({ success: false, error: `Analytics Webhook URL invalid: ${v.error}` }),
            { status: 422, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }
      updates.analytics_webhook_url = body.analytics_webhook_url || null;
      if (body.analytics_webhook_url !== existing.analytics_webhook_url) {
        updates.analytics_schedule_status = 'pending';
      }
    }

    if (body.analytics_sync_time) {
      const c = fastcronService.parseTimeToCron(body.analytics_sync_time);
      if (!c.valid || !c.cron) {
        return new Response(
          JSON.stringify({ success: false, error: `Analytics sync time invalid: ${c.error}` }),
          { status: 422, headers: { 'Content-Type': 'application/json' } }
        );
      }
      updates.analytics_sync_time = body.analytics_sync_time.trim();
      updates.analytics_cron_expression = c.cron;
      if (body.analytics_sync_time !== existing.analytics_sync_time) {
        updates.analytics_schedule_status = 'pending';
      }
    }

    // Validate Pipeline A Date Offsets (V20.1)
    const analyticsStart = body.analytics_start_offset_days !== undefined
      ? parseInt(String(body.analytics_start_offset_days), 10)
      : (existing.analytics_start_offset_days ?? 7);
    const analyticsEnd = body.analytics_end_offset_days !== undefined
      ? parseInt(String(body.analytics_end_offset_days), 10)
      : (existing.analytics_end_offset_days ?? 1);

    if (body.analytics_start_offset_days !== undefined || body.analytics_end_offset_days !== undefined) {
      if (isNaN(analyticsStart) || analyticsStart < 1 || analyticsStart > 90) {
        return new Response(
          JSON.stringify({ success: false, error: 'Pipeline A Start Offset must be an integer between 1 and 90.' }),
          { status: 422, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (isNaN(analyticsEnd) || analyticsEnd < 0 || analyticsEnd > 60) {
        return new Response(
          JSON.stringify({ success: false, error: 'Pipeline A End Offset must be an integer between 0 and 60.' }),
          { status: 422, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (analyticsEnd > analyticsStart) {
        return new Response(
          JSON.stringify({ success: false, error: 'Pipeline A End Offset must be less than Start Offset (equal values allowed for same-day range).' }),
          { status: 422, headers: { 'Content-Type': 'application/json' } }
        );
      }

      updates.analytics_start_offset_days = analyticsStart;
      updates.analytics_end_offset_days = analyticsEnd;

      if (
        analyticsStart !== existing.analytics_start_offset_days ||
        analyticsEnd !== existing.analytics_end_offset_days
      ) {
        updates.analytics_schedule_status = 'pending';
      }
    }

    // Validate and update Pipeline B (Top Pins)
    if (body.top_pins_webhook_url !== undefined) {
      if (body.top_pins_webhook_url) {
        const v = fastcronService.validateWebhookUrl(body.top_pins_webhook_url);
        if (!v.valid) {
          return new Response(
            JSON.stringify({ success: false, error: `Top Pins Webhook URL invalid: ${v.error}` }),
            { status: 422, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }
      updates.top_pins_webhook_url = body.top_pins_webhook_url || null;
      if (body.top_pins_webhook_url !== existing.top_pins_webhook_url) {
        updates.top_pins_schedule_status = 'pending';
      }
    }

    if (body.top_pins_sync_time) {
      const c = fastcronService.parseTimeToCron(body.top_pins_sync_time);
      if (!c.valid || !c.cron) {
        return new Response(
          JSON.stringify({ success: false, error: `Top Pins sync time invalid: ${c.error}` }),
          { status: 422, headers: { 'Content-Type': 'application/json' } }
        );
      }
      updates.top_pins_sync_time = body.top_pins_sync_time.trim();
      updates.top_pins_cron_expression = c.cron;
      if (body.top_pins_sync_time !== existing.top_pins_sync_time) {
        updates.top_pins_schedule_status = 'pending';
      }
    }

    // Validate Pipeline B Date Offsets (V20.1)
    const topPinsStart = body.top_pins_start_offset_days !== undefined
      ? parseInt(String(body.top_pins_start_offset_days), 10)
      : (existing.top_pins_start_offset_days ?? 7);
    const topPinsEnd = body.top_pins_end_offset_days !== undefined
      ? parseInt(String(body.top_pins_end_offset_days), 10)
      : (existing.top_pins_end_offset_days ?? 2);

    if (body.top_pins_start_offset_days !== undefined || body.top_pins_end_offset_days !== undefined) {
      if (isNaN(topPinsStart) || topPinsStart < 1 || topPinsStart > 90) {
        return new Response(
          JSON.stringify({ success: false, error: 'Pipeline B Start Offset must be an integer between 1 and 90.' }),
          { status: 422, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (isNaN(topPinsEnd) || topPinsEnd < 0 || topPinsEnd > 60) {
        return new Response(
          JSON.stringify({ success: false, error: 'Pipeline B End Offset must be an integer between 0 and 60.' }),
          { status: 422, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (topPinsEnd > topPinsStart) {
        return new Response(
          JSON.stringify({ success: false, error: 'Pipeline B End Offset must be less than Start Offset (equal values allowed for same-day range).' }),
          { status: 422, headers: { 'Content-Type': 'application/json' } }
        );
      }

      updates.top_pins_start_offset_days = topPinsStart;
      updates.top_pins_end_offset_days = topPinsEnd;

      if (
        topPinsStart !== existing.top_pins_start_offset_days ||
        topPinsEnd !== existing.top_pins_end_offset_days
      ) {
        updates.top_pins_schedule_status = 'pending';
      }
    }

    // Validate V23: top_pins_num_of_pins [1, 50]
    if (body.top_pins_num_of_pins !== undefined) {
      const numPins = Number(body.top_pins_num_of_pins);
      if (!Number.isInteger(numPins) || numPins < 1 || numPins > 50) {
        return new Response(
          JSON.stringify({ success: false, error: 'top_pins_num_of_pins must be an integer between 1 and 50.' }),
          { status: 422, headers: { 'Content-Type': 'application/json' } }
        );
      }
      updates.top_pins_num_of_pins = numPins;
      if (numPins !== existing.top_pins_num_of_pins) {
        updates.top_pins_schedule_status = 'pending';
      }
    }

    // Validate V23: top_pins_sort_modes (non-empty array of valid sort modes)
    if (body.top_pins_sort_modes !== undefined) {
      if (!Array.isArray(body.top_pins_sort_modes) || body.top_pins_sort_modes.length === 0) {
        return new Response(
          JSON.stringify({ success: false, error: 'top_pins_sort_modes must be a non-empty array.' }),
          { status: 422, headers: { 'Content-Type': 'application/json' } }
        );
      }
      const validModes = new Set(['IMPRESSION', 'OUTBOUND_CLICK', 'SAVE', 'ENGAGEMENT', 'PIN_CLICK']);
      const normalized = body.top_pins_sort_modes.map((m: any) => String(m).toUpperCase());
      for (const m of normalized) {
        if (!validModes.has(m)) {
          return new Response(
            JSON.stringify({
              success: false,
              error: `Invalid sort mode "${m}". Allowed modes: IMPRESSION, OUTBOUND_CLICK, SAVE, ENGAGEMENT, PIN_CLICK.`,
            }),
            { status: 422, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }
      updates.top_pins_sort_modes = normalized;
      if (JSON.stringify(normalized) !== JSON.stringify(existing.top_pins_sort_modes)) {
        updates.top_pins_schedule_status = 'pending';
      }
    }

    // Validate V23: fastcron_timeout [5, 60]
    if (body.fastcron_timeout !== undefined) {
      const timeout = Number(body.fastcron_timeout);
      if (!Number.isInteger(timeout) || timeout < 5 || timeout > 60) {
        return new Response(
          JSON.stringify({ success: false, error: 'fastcron_timeout must be an integer between 5 and 60.' }),
          { status: 422, headers: { 'Content-Type': 'application/json' } }
        );
      }
      updates.fastcron_timeout = timeout;
    }

    // Validate V23: fastcron_instances [0, 5]
    if (body.fastcron_instances !== undefined) {
      const instances = Number(body.fastcron_instances);
      if (!Number.isInteger(instances) || instances < 0 || instances > 5) {
        return new Response(
          JSON.stringify({ success: false, error: 'fastcron_instances must be an integer between 0 and 5.' }),
          { status: 422, headers: { 'Content-Type': 'application/json' } }
        );
      }
      updates.fastcron_instances = instances;
    }

    // Validate V23: fastcron_notify (boolean)
    if (body.fastcron_notify !== undefined) {
      if (typeof body.fastcron_notify !== 'boolean') {
        return new Response(
          JSON.stringify({ success: false, error: 'fastcron_notify must be a boolean.' }),
          { status: 422, headers: { 'Content-Type': 'application/json' } }
        );
      }
      updates.fastcron_notify = body.fastcron_notify;
    }

    // Validate R23.1: analytics_fastcron_token (write-only; if provided length >= 16 else 422)
    if (body.analytics_fastcron_token !== undefined) {
      if (body.analytics_fastcron_token === null || body.analytics_fastcron_token === '') {
        updates.analytics_fastcron_token = null;
      } else {
        const tok = String(body.analytics_fastcron_token).trim();
        if (tok.length < 16) {
          return new Response(
            JSON.stringify({ success: false, error: 'FastCron API Token must be at least 16 characters.' }),
            { status: 422, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (!tok.startsWith('v1:')) {
          const env = getServerEnv(runtimeEnv);
          updates.analytics_fastcron_token = await encryptToken(tok, env.TOKEN_KEK);
        } else {
          updates.analytics_fastcron_token = tok;
        }
      }
    }

    // Validate R23.1: top_pins_fastcron_token (write-only; if provided length >= 16 else 422)
    if (body.top_pins_fastcron_token !== undefined) {
      if (body.top_pins_fastcron_token === null || body.top_pins_fastcron_token === '') {
        updates.top_pins_fastcron_token = null;
      } else {
        const tok = String(body.top_pins_fastcron_token).trim();
        if (tok.length < 16) {
          return new Response(
            JSON.stringify({ success: false, error: 'FastCron API Token must be at least 16 characters.' }),
            { status: 422, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (!tok.startsWith('v1:')) {
          const env = getServerEnv(runtimeEnv);
          updates.top_pins_fastcron_token = await encryptToken(tok, env.TOKEN_KEK);
        } else {
          updates.top_pins_fastcron_token = tok;
        }
      }
    }

    // Workspace-level Timezone
    if (body.timezone !== undefined) {
      const tz = String(body.timezone).trim();
      if (!isValidTimeZone(tz)) {
        return new Response(
          JSON.stringify({ success: false, error: 'Invalid timezone.' }),
          { status: 422, headers: { 'Content-Type': 'application/json' } }
        );
      }
      await analyticsDb.upsertWorkspaceAnalyticsSettings(workspaceId, { timezone: tz });
    }

    const updated = await analyticsDb.updateWorkspaceConnection(workspaceId, connectionId, updates);

    let health: any = null;
    try {
      health = await analyticsDb.getConnectionHealth(updated.id);
    } catch {
      health = null;
    }

    const hasAnalyticsToken = Boolean(updated.analytics_fastcron_token && updated.analytics_fastcron_token.trim().length >= 16);
    const hasTopPinsToken = Boolean(updated.top_pins_fastcron_token && updated.top_pins_fastcron_token.trim().length >= 16);
    const analyticsFingerprint = hasAnalyticsToken
      ? '••••' + (updated.analytics_fastcron_token ?? '').trim().slice(-4)
      : null;
    const topPinsFingerprint = hasTopPinsToken
      ? '••••' + (updated.top_pins_fastcron_token ?? '').trim().slice(-4)
      : null;

    const responseData: AnalyticsConnectionSettingsResponse = {
      id: updated.id,
      display_name: updated.display_name,
      revoked_at: updated.revoked_at || null,
      analytics_webhook_url: updated.analytics_webhook_url || null,
      analytics_sync_time: updated.analytics_sync_time,
      analytics_cron_expression: updated.analytics_cron_expression,
      analytics_schedule_status: updated.analytics_schedule_status,
      analytics_start_offset_days: updated.analytics_start_offset_days ?? 7,
      analytics_end_offset_days: updated.analytics_end_offset_days ?? 1,
      top_pins_webhook_url: updated.top_pins_webhook_url || null,
      top_pins_sync_time: updated.top_pins_sync_time,
      top_pins_cron_expression: updated.top_pins_cron_expression,
      top_pins_schedule_status: updated.top_pins_schedule_status,
      top_pins_start_offset_days: updated.top_pins_start_offset_days ?? 7,
      top_pins_end_offset_days: updated.top_pins_end_offset_days ?? 2,
      top_pins_num_of_pins: updated.top_pins_num_of_pins ?? 50,
      top_pins_sort_modes: updated.top_pins_sort_modes || [
        'IMPRESSION',
        'OUTBOUND_CLICK',
        'SAVE',
        'ENGAGEMENT',
        'PIN_CLICK',
      ],
      has_fastcron_token: Boolean(updated.fastcron_token && updated.fastcron_token.trim().length >= 16),
      has_analytics_fastcron_token: hasAnalyticsToken,
      has_top_pins_fastcron_token: hasTopPinsToken,
      token_fingerprint: updated.fastcron_token && updated.fastcron_token.trim().length >= 16 
        ? '••••' + updated.fastcron_token.trim().slice(-4) 
        : null,
      analytics_token_fingerprint: analyticsFingerprint,
      analytics_fastcron_token_fingerprint: analyticsFingerprint,
      top_pins_token_fingerprint: topPinsFingerprint,
      top_pins_fastcron_token_fingerprint: topPinsFingerprint,
      fastcron_notify: updated.fastcron_notify ?? true,
      fastcron_timeout: updated.fastcron_timeout ?? 30,
      fastcron_instances: updated.fastcron_instances ?? 1,
      health: health ? {
        total_runs: health.total_runs ?? 0,
        consecutive_failures: health.consecutive_failures ?? 0,
        last_success_at: health.last_success_at || null,
        revoked: health.revoked ?? false,
      } : null,
    };

    return new Response(JSON.stringify({ success: true, data: responseData }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: err.message || 'Failed to update connection settings.' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
};
