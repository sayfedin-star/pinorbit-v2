export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { dbClients } from '../../../server/db/clients';

function clampInt(val: any, min: number, max: number, fallback: number | null): number | null {
  if (val === undefined || val === null || val === '') return fallback;
  const num = Number(val);
  if (isNaN(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
}

export const GET: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};

  const url = new URL(request.url);
  const workspaceId = url.searchParams.get('workspace_id') || locals.activeWorkspaceId;

  if (!user || !schedulingClient || !workspaceId) {
    return new Response(JSON.stringify({ error: 'Unauthorized or missing workspace ID' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    await assertWorkspaceAccess(schedulingClient, workspaceId, user.id);
    const adminClient = dbClients.getSchedulingAdmin(runtimeEnv);

    const { data: settings, error } = await adminClient
      .from('workspace_retention_settings')
      .select('*')
      .eq('workspace_id', workspaceId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!settings) {
      return new Response(
        JSON.stringify({
          workspace_id: workspaceId,
          auto_prune_enabled: false,
          retention_posted_days: 30,
          retention_terminal_days: 90,
          retention_logs_days: 14,
          import_sessions_days: 30,
          processing_timeout_minutes: 45,
          p2_prune_enabled: false,
          competitor_snapshots_days: 90,
          competitor_jobs_days: 30,
          p3_prune_enabled: false,
          ingestion_runs_days: 30,
          top_pins_raw_days: 180,
          top_pins_downsample_enabled: false,
          analytics_daily_keep_days: null,
          p4_prune_enabled: false,
          pa_runs_retention_days: 60,
          pa_metrics_retention_days: 90,
          last_cleanup_at: null,
          last_cleanup_result: null,
          is_default: true,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    return new Response(
      JSON.stringify({
        workspace_id: settings.workspace_id,
        auto_prune_enabled: settings.auto_prune_enabled ?? false,
        retention_posted_days: settings.retention_posted_days ?? 30,
        retention_terminal_days: settings.retention_terminal_days ?? 90,
        retention_logs_days: settings.retention_logs_days ?? 14,
        import_sessions_days: settings.import_sessions_days ?? 30,
        processing_timeout_minutes: settings.processing_timeout_minutes ?? 45,
        p2_prune_enabled: settings.p2_prune_enabled ?? false,
        competitor_snapshots_days: settings.competitor_snapshots_days ?? 90,
        competitor_jobs_days: settings.competitor_jobs_days ?? 30,
        p3_prune_enabled: settings.p3_prune_enabled ?? false,
        ingestion_runs_days: settings.ingestion_runs_days ?? 30,
        top_pins_raw_days: settings.top_pins_raw_days ?? 180,
        top_pins_downsample_enabled: settings.top_pins_downsample_enabled ?? false,
        analytics_daily_keep_days: settings.analytics_daily_keep_days ?? null,
        p4_prune_enabled: settings.p4_prune_enabled ?? false,
        pa_runs_retention_days: settings.pa_runs_retention_days ?? 60,
        pa_metrics_retention_days: settings.pa_metrics_retention_days ?? 90,
        last_cleanup_at: settings.last_cleanup_at ?? null,
        last_cleanup_result: settings.last_cleanup_result ?? null,
        is_default: false,
        updated_at: settings.updated_at,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Failed to load retention settings' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const PATCH: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};

  if (!user || !schedulingClient) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: any = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const workspaceId = body.workspace_id || locals.activeWorkspaceId;
  if (!workspaceId) {
    return new Response(JSON.stringify({ error: 'workspace_id is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, 'admin');
    const adminClient = dbClients.getSchedulingAdmin(runtimeEnv);

    // Fetch existing or fallback
    const { data: existing } = await adminClient
      .from('workspace_retention_settings')
      .select('*')
      .eq('workspace_id', workspaceId)
      .maybeSingle();

    const rawAutoPrune = body.auto_prune_enabled !== undefined ? body.auto_prune_enabled : existing?.auto_prune_enabled;
    const rawPostedDays = body.retention_posted_days !== undefined ? body.retention_posted_days : existing?.retention_posted_days;
    const rawTerminalDays = body.retention_terminal_days !== undefined ? body.retention_terminal_days : existing?.retention_terminal_days;
    const rawLogsDays = body.retention_logs_days !== undefined ? body.retention_logs_days : existing?.retention_logs_days;
    const rawImportDays = body.import_sessions_days !== undefined ? body.import_sessions_days : existing?.import_sessions_days;
    const rawTimeout = body.processing_timeout_minutes !== undefined ? body.processing_timeout_minutes : existing?.processing_timeout_minutes;

    const rawP2Prune = body.p2_prune_enabled !== undefined ? body.p2_prune_enabled : existing?.p2_prune_enabled;
    const rawCompSnapshots = body.competitor_snapshots_days !== undefined ? body.competitor_snapshots_days : existing?.competitor_snapshots_days;
    const rawCompJobs = body.competitor_jobs_days !== undefined ? body.competitor_jobs_days : existing?.competitor_jobs_days;

    const rawP3Prune = body.p3_prune_enabled !== undefined ? body.p3_prune_enabled : existing?.p3_prune_enabled;
    const rawIngestionRuns = body.ingestion_runs_days !== undefined ? body.ingestion_runs_days : existing?.ingestion_runs_days;
    const rawTopPinsRaw = body.top_pins_raw_days !== undefined ? body.top_pins_raw_days : existing?.top_pins_raw_days;
    const rawTopPinsDownsample = body.top_pins_downsample_enabled !== undefined ? body.top_pins_downsample_enabled : existing?.top_pins_downsample_enabled;

    const rawP4Prune = body.p4_prune_enabled !== undefined ? body.p4_prune_enabled : existing?.p4_prune_enabled;
    const rawPaRuns = body.pa_runs_retention_days !== undefined ? body.pa_runs_retention_days : existing?.pa_runs_retention_days;
    const rawPaMetrics = body.pa_metrics_retention_days !== undefined ? body.pa_metrics_retention_days : existing?.pa_metrics_retention_days;

    let clampedDailyKeep: number | null = null;
    if (body.analytics_daily_keep_days === null || body.analytics_daily_keep_days === '') {
      clampedDailyKeep = null;
    } else if (body.analytics_daily_keep_days !== undefined) {
      clampedDailyKeep = clampInt(body.analytics_daily_keep_days, 1, 730, existing?.analytics_daily_keep_days ?? null);
    } else {
      clampedDailyKeep = existing?.analytics_daily_keep_days ?? null;
    }

    const payload = {
      ...(existing ?? {}),
      workspace_id: workspaceId,
      auto_prune_enabled: Boolean(rawAutoPrune ?? false),
      retention_posted_days: clampInt(rawPostedDays, 1, 365, existing?.retention_posted_days ?? 30) ?? 30,
      retention_terminal_days: clampInt(rawTerminalDays, 1, 365, existing?.retention_terminal_days ?? 90) ?? 90,
      retention_logs_days: clampInt(rawLogsDays, 1, 180, existing?.retention_logs_days ?? 14) ?? 14,
      import_sessions_days: clampInt(rawImportDays, 1, 365, existing?.import_sessions_days ?? 30) ?? 30,
      processing_timeout_minutes: clampInt(rawTimeout, 5, 240, existing?.processing_timeout_minutes ?? 45) ?? 45,
      p2_prune_enabled: Boolean(rawP2Prune ?? false),
      competitor_snapshots_days: clampInt(rawCompSnapshots, 1, 365, existing?.competitor_snapshots_days ?? 90) ?? 90,
      competitor_jobs_days: clampInt(rawCompJobs, 1, 180, existing?.competitor_jobs_days ?? 30) ?? 30,
      p3_prune_enabled: Boolean(rawP3Prune ?? false),
      ingestion_runs_days: clampInt(rawIngestionRuns, 1, 365, existing?.ingestion_runs_days ?? 30) ?? 30,
      top_pins_raw_days: clampInt(rawTopPinsRaw, 1, 730, existing?.top_pins_raw_days ?? 180) ?? 180,
      top_pins_downsample_enabled: Boolean(rawTopPinsDownsample ?? false),
      analytics_daily_keep_days: clampedDailyKeep,
      p4_prune_enabled: Boolean(rawP4Prune ?? false),
      pa_runs_retention_days: clampInt(rawPaRuns, 1, 365, existing?.pa_runs_retention_days ?? 60) ?? 60,
      pa_metrics_retention_days: clampInt(rawPaMetrics, 1, 365, existing?.pa_metrics_retention_days ?? 90) ?? 90,
      updated_at: new Date().toISOString(),
    };

    const { data: saved, error: upsertErr } = await adminClient
      .from('workspace_retention_settings')
      .upsert(payload, { onConflict: 'workspace_id' })
      .select('*')
      .single();

    if (upsertErr) throw upsertErr;

    return new Response(
      JSON.stringify({
        success: true,
        workspace_id: saved.workspace_id,
        auto_prune_enabled: saved.auto_prune_enabled,
        retention_posted_days: saved.retention_posted_days,
        retention_terminal_days: saved.retention_terminal_days,
        retention_logs_days: saved.retention_logs_days,
        import_sessions_days: saved.import_sessions_days,
        processing_timeout_minutes: saved.processing_timeout_minutes,
        p2_prune_enabled: saved.p2_prune_enabled,
        competitor_snapshots_days: saved.competitor_snapshots_days,
        competitor_jobs_days: saved.competitor_jobs_days,
        p3_prune_enabled: saved.p3_prune_enabled,
        ingestion_runs_days: saved.ingestion_runs_days,
        top_pins_raw_days: saved.top_pins_raw_days,
        top_pins_downsample_enabled: saved.top_pins_downsample_enabled,
        analytics_daily_keep_days: saved.analytics_daily_keep_days,
        p4_prune_enabled: saved.p4_prune_enabled,
        pa_runs_retention_days: saved.pa_runs_retention_days,
        pa_metrics_retention_days: saved.pa_metrics_retention_days,
        last_cleanup_at: saved.last_cleanup_at ?? null,
        last_cleanup_result: saved.last_cleanup_result ?? null,
        is_default: false,
        updated_at: saved.updated_at,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Failed to update retention settings' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
