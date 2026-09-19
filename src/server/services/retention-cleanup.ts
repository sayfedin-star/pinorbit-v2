import { dbClients } from '../db/clients';
import { clampRetentionPostedDays, clampProcessingTimeoutMinutes } from './scheduling-logic';

export interface CleanupOverrides {
  p1?: boolean;
  p2?: boolean;
  p3?: boolean;
  p4?: boolean;
}

interface BatchedDeleteOptions {
  workspaceId: string;
  column?: string;
  value?: string;
  dateColumn: string;
  cutoff: string;
  extraFilter?: { column: string; value: string };
  batchSize?: number;
}

export interface BatchedDeleteResult {
  deleted: number;
  hitCap: boolean;
}

export async function batchedDelete(
  client: any,
  table: string,
  options: BatchedDeleteOptions
): Promise<BatchedDeleteResult> {
  const ws = options.workspaceId;
  if (!ws || typeof ws !== 'string' || ws.trim() === '') {
    throw new Error(`[batchedDelete] CRITICAL: Valid workspaceId is required for table "${table}". Aborting delete.`);
  }
  const cleanWs = ws.trim();

  let totalDeleted = 0;
  const batchSize = Math.max(1, Math.min(1000, options.batchSize || 500));
  const MAX_BATCH_ITERATIONS = 50;
  let iterations = 0;
  let hitCap = false;

  const col = options.column || 'workspace_id';
  const val = options.value !== undefined ? options.value : cleanWs;

  while (iterations < MAX_BATCH_ITERATIONS) {
    iterations++;
    let query = client
      .from(table)
      .select('id')
      .eq('workspace_id', cleanWs)
      .lt(options.dateColumn, options.cutoff);

    if (col !== 'workspace_id') {
      query = query.eq(col, val);
    }

    if (options.extraFilter) {
      query = query.eq(options.extraFilter.column, options.extraFilter.value);
    }

    const { data: rows, error: selectErr } = await query.limit(batchSize);
    if (selectErr) throw selectErr;
    if (!rows || rows.length === 0) break;

    const ids = rows.map((r: any) => r.id);
    let delQuery = client
      .from(table)
      .delete({ count: 'exact' })
      .eq('workspace_id', cleanWs)
      .in('id', ids);

    const { count, error: deleteErr } = await delQuery;

    if (deleteErr) throw deleteErr;

    const batchDeleted = count ?? ids.length;
    totalDeleted += batchDeleted;

    if (batchDeleted < batchSize) break;

    if (iterations >= MAX_BATCH_ITERATIONS && batchDeleted >= batchSize) {
      hitCap = true;
      break;
    }

    // Small delay to reduce DB load
    await new Promise((r) => setTimeout(r, 10));
  }

  return { deleted: totalDeleted, hitCap };
}

export async function runRetentionCleanup(
  workspaceId: string,
  runtimeEnv: Record<string, any>,
  opts?: { overrides?: CleanupOverrides; trigger?: 'api' | 'manual' }
): Promise<Record<string, any>> {
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!workspaceId || typeof workspaceId !== 'string' || !UUID_REGEX.test(workspaceId.trim())) {
    throw new Error(`[runRetentionCleanup] CRITICAL: Invalid or missing workspace_id ("${workspaceId}"). Aborting retention cleanup.`);
  }
  const cleanWorkspaceId = workspaceId.trim();

  const schedulingAdmin = dbClients.getSchedulingAdmin(runtimeEnv);

  // Read workspace retention settings (with fallbacks)
  const { data: wsSettings } = await schedulingAdmin
    .from('workspace_retention_settings')
    .select('*')
    .eq('workspace_id', cleanWorkspaceId)
    .maybeSingle();

  const retentionPostedDays = clampRetentionPostedDays(wsSettings?.retention_posted_days);
  const processingTimeoutMinutes = clampProcessingTimeoutMinutes(wsSettings?.processing_timeout_minutes);
  const postedCutoff = new Date(Date.now() - retentionPostedDays * 86400000).toISOString();

  // Strict Clamping for all sub-project retention days to prevent accidental zero-wipe
  const terminalDays = Math.max(1, Math.min(365, Number(wsSettings?.retention_terminal_days) || 90));
  const logsDays = Math.max(1, Math.min(180, Number(wsSettings?.retention_logs_days) || 14));
  const importDays = Math.max(1, Math.min(365, Number(wsSettings?.import_sessions_days) || 30));

  const compSnapshotsDays = Math.max(1, Math.min(365, Number(wsSettings?.competitor_snapshots_days) || 90));
  const compJobsDays = Math.max(1, Math.min(180, Number(wsSettings?.competitor_jobs_days) || 30));

  const ingestionRunsDays = Math.max(1, Math.min(365, Number(wsSettings?.ingestion_runs_days) || 30));
  const topPinsRawDays = Math.max(1, Math.min(730, Number(wsSettings?.top_pins_raw_days) || 180));

  const paRunsDays = Math.max(1, Math.min(365, Number(wsSettings?.pa_runs_retention_days ?? wsSettings?.pa_runs_days) || 60));
  const paMetricsDays = Math.max(1, Math.min(365, Number(wsSettings?.pa_metrics_retention_days ?? wsSettings?.pa_metrics_days) || 90));

  const warnings: string[] = [];

  // Effective gates based on explicit overrides or DB toggles (default false in schema)
  const effectiveP1 = opts?.overrides?.p1 ?? Boolean(wsSettings?.auto_prune_enabled ?? false);
  const effectiveP2 = opts?.overrides?.p2 ?? Boolean(wsSettings?.p2_prune_enabled ?? false);
  const effectiveP3 = opts?.overrides?.p3 ?? Boolean(wsSettings?.p3_prune_enabled ?? false);
  const effectiveP4 = opts?.overrides?.p4 ?? Boolean(wsSettings?.p4_prune_enabled ?? false);

  // 1. Unconditional Orphan Pin Sweep (outside gates)
  const sweepCutoff = new Date(Date.now() - processingTimeoutMinutes * 60000).toISOString();
  let sweptPinsCount = 0;
  try {
    const sweepQuery = schedulingAdmin
      .from('pins')
      .update({
        status: 'pending',
        processing_started_at: null,
        claimed_at: null,
        claimed_by_schedule_id: null,
        updated_at: new Date().toISOString(),
      })
      .eq('workspace_id', cleanWorkspaceId)
      .eq('status', 'processing');

    const effectiveSweepQuery = typeof sweepQuery.or === 'function'
      ? sweepQuery.or(`claimed_at.lt.${sweepCutoff},and(claimed_at.is.null,processing_started_at.lt.${sweepCutoff})`)
      : sweepQuery.lt('claimed_at', sweepCutoff);

    const { count, error: sweepErr } = await effectiveSweepQuery.lt('attempts', 2);

    if (sweepErr) throw sweepErr;
    sweptPinsCount = count ?? 0;
  } catch (err: any) {
    warnings.push(`Sweep failed: ${err.message}`);
  }

  // 1b. Mark expired processing pins with exhausted retries (attempts >= 2) as failed
  try {
    const builder = schedulingAdmin.from('pins');
    if (builder && typeof builder.update === 'function') {
      const q = builder
        .update({
          status: 'failed',
          last_failure_reason: 'Processing timed out after maximum retry attempts.',
          processing_started_at: null,
          claimed_at: null,
          claimed_by_schedule_id: null,
          updated_at: new Date().toISOString(),
        })
        .eq('workspace_id', cleanWorkspaceId)
        .eq('status', 'processing');

      const effectiveQ = typeof q.or === 'function'
        ? q.or(`claimed_at.lt.${sweepCutoff},and(claimed_at.is.null,processing_started_at.lt.${sweepCutoff})`)
        : q.lt('claimed_at', sweepCutoff);

      if (effectiveQ && typeof effectiveQ.gte === 'function') {
        const { error: termErr } = await effectiveQ.gte('attempts', 2);
        if (termErr) throw termErr;
      }
    }
  } catch (err: any) {
    warnings.push(`Terminal sweep failed: ${err.message}`);
  }

  // 2. Gate P1 (Posted pins, terminal pins, delivery logs, import sessions)
  let deletedPinsCount = 0;
  let deletedTerminalPinsCount = 0;
  let deletedDeliveryLogs = 0;
  let deletedImportSessions = 0;
  let wasTruncated = false;

  if (effectiveP1) {
    try {
      // 1. Purge posted pins older than workspace retention days using batchedDelete
      const resPosted = await batchedDelete(schedulingAdmin, 'pins', {
        column: 'workspace_id',
        value: cleanWorkspaceId,
        workspaceId: cleanWorkspaceId,
        dateColumn: 'posted_at',
        cutoff: postedCutoff,
        extraFilter: { column: 'status', value: 'posted' },
      });
      deletedPinsCount = resPosted.deleted;
      if (resPosted.hitCap) wasTruncated = true;

      // 2. Terminal pins: failed & cancelled using batchedDelete
      const terminalCutoff = new Date(Date.now() - terminalDays * 86400000).toISOString();
      const delFailed = await batchedDelete(schedulingAdmin, 'pins', {
        column: 'workspace_id',
        value: cleanWorkspaceId,
        workspaceId: cleanWorkspaceId,
        dateColumn: 'updated_at',
        cutoff: terminalCutoff,
        extraFilter: { column: 'status', value: 'failed' },
      });
      if (delFailed.hitCap) wasTruncated = true;

      const delCancelled = await batchedDelete(schedulingAdmin, 'pins', {
        column: 'workspace_id',
        value: cleanWorkspaceId,
        workspaceId: cleanWorkspaceId,
        dateColumn: 'updated_at',
        cutoff: terminalCutoff,
        extraFilter: { column: 'status', value: 'cancelled' },
      });
      if (delCancelled.hitCap) wasTruncated = true;

      deletedTerminalPinsCount = delFailed.deleted + delCancelled.deleted;

      // 3. Pin delivery logs RPC
      const { data: logsData, error: logsErr } = await schedulingAdmin.rpc('purge_old_pin_delivery_logs', {
        p_keep_success_days: logsDays,
        p_keep_failure_days: Math.max(logsDays, 30),
        p_workspace_id: cleanWorkspaceId,
      });
      if (logsErr) throw logsErr;
      deletedDeliveryLogs = typeof logsData === 'number' ? logsData : 0;

      // 4. Import sessions using batchedDelete
      const sessionsCutoff = new Date(Date.now() - importDays * 86400000).toISOString();
      const resSessions = await batchedDelete(schedulingAdmin, 'import_sessions', {
        column: 'workspace_id',
        value: cleanWorkspaceId,
        workspaceId: cleanWorkspaceId,
        dateColumn: 'created_at',
        cutoff: sessionsCutoff,
      });
      deletedImportSessions = resSessions.deleted;
      if (resSessions.hitCap) wasTruncated = true;
    } catch (p1Err: any) {
      console.error('[Retention] P1 prune failed:', p1Err);
      warnings.push(`P1 prune failed: ${p1Err.message || String(p1Err)}`);
    }
  }

  // 3. Gate P2 (Competitor snapshots and ingestion jobs)
  let p2Result: any = null;
  if (effectiveP2) {
    try {
      const competitorsClient = dbClients.getCompetitors(runtimeEnv);
      const { data: p2Data, error: p2Err } = await competitorsClient.rpc('purge_competitor_retention', {
        p_keep_snapshot_days: compSnapshotsDays,
        p_keep_job_days: compJobsDays,
        p_workspace_id: cleanWorkspaceId,
      });
      if (p2Err) throw p2Err;
      p2Result = p2Data;
    } catch (p2Err: any) {
      console.error('[Retention] P2 prune failed:', p2Err);
      warnings.push(`P2 prune failed: ${p2Err.message || String(p2Err)}`);
    }
  }

  // 4. Gate P3 (Analytics snapshots and ingestion runs)
  let deletedSnapshotsCount = 0;
  let deletedIngestionRuns = 0;
  if (effectiveP3) {
    try {
      const analyticsClient = dbClients.getAnalytics(runtimeEnv);
      const { data: runsData, error: runsErr } = await analyticsClient.rpc('purge_old_analytics_ingestion_runs', {
        p_keep_days: ingestionRunsDays,
        p_workspace_id: cleanWorkspaceId,
      });
      if (runsErr) throw runsErr;
      deletedIngestionRuns = runsData?.deleted_runs ?? (typeof runsData === 'number' ? runsData : 0);

      const snapshotCutoff = new Date(Date.now() - topPinsRawDays * 86400000).toISOString().split('T')[0];

      const resSnapshots = await batchedDelete(analyticsClient, 'top_pins_snapshots', {
        column: 'workspace_id',
        value: cleanWorkspaceId,
        workspaceId: cleanWorkspaceId,
        dateColumn: 'window_end',
        cutoff: snapshotCutoff,
      });
      deletedSnapshotsCount = resSnapshots.deleted;
      if (resSnapshots.hitCap) wasTruncated = true;

      if (wsSettings?.top_pins_downsample_enabled) {
        console.warn('[Retention] Top pins downsampling requested for workspace:', cleanWorkspaceId);
      }
    } catch (p3Err: any) {
      console.error('[Retention] P3 prune failed:', p3Err);
      warnings.push(`P3 prune failed: ${p3Err.message || String(p3Err)}`);
    }
  }

  // 5. Gate P4 (PinArchive runs and metrics)
  let deletedPaRuns = 0;
  let deletedPaMetrics = 0;
  if (effectiveP4) {
    try {
      const pinArchiveClient = dbClients.getPinArchive(runtimeEnv);
      const paRunsCutoff = new Date(Date.now() - paRunsDays * 86400000).toISOString();

      const resRuns = await batchedDelete(pinArchiveClient, 'pa_runs', {
        column: 'workspace_id',
        value: cleanWorkspaceId,
        workspaceId: cleanWorkspaceId,
        dateColumn: 'started_at',
        cutoff: paRunsCutoff,
      });
      deletedPaRuns = resRuns.deleted;
      if (resRuns.hitCap) wasTruncated = true;

      const paMetricsCutoff = new Date(Date.now() - paMetricsDays * 86400000).toISOString();

      const resMetrics = await batchedDelete(pinArchiveClient, 'pa_pin_metrics', {
        column: 'workspace_id',
        value: cleanWorkspaceId,
        workspaceId: cleanWorkspaceId,
        dateColumn: 'recorded_at',
        cutoff: paMetricsCutoff,
      });
      deletedPaMetrics = resMetrics.deleted;
      if (resMetrics.hitCap) wasTruncated = true;
    } catch (p4Err: any) {
      console.error('[Retention] P4 prune failed:', p4Err);
      warnings.push(`P4 prune failed: ${p4Err.message || String(p4Err)}`);
    }
  }

  // Construct consolidated payload
  const attemptedGates = [effectiveP1, effectiveP2, effectiveP3, effectiveP4].filter(Boolean).length;
  const allFailed = attemptedGates > 0 && warnings.length >= attemptedGates;

  const payload: Record<string, any> = {
    success: !allFailed,
    truncated: wasTruncated,
    workspace_id: cleanWorkspaceId,
    auto_prune_enabled: Boolean(wsSettings?.auto_prune_enabled ?? false),
    p2_prune_enabled: Boolean(wsSettings?.p2_prune_enabled ?? false),
    p3_prune_enabled: Boolean(wsSettings?.p3_prune_enabled ?? false),
    p4_prune_enabled: Boolean(wsSettings?.p4_prune_enabled ?? false),
    retention_posted_days: retentionPostedDays,
    processing_timeout_minutes: processingTimeoutMinutes,
    deleted_pins_count: deletedPinsCount,
    deleted_terminal_pins_count: deletedTerminalPinsCount,
    deleted_delivery_logs: deletedDeliveryLogs,
    deleted_import_sessions: deletedImportSessions,
    swept_pins_count: sweptPinsCount,
    p2: p2Result,
    deleted_ingestion_runs: deletedIngestionRuns,
    deleted_snapshots_count: deletedSnapshotsCount,
    deleted_pa_runs: deletedPaRuns,
    deleted_pa_metrics: deletedPaMetrics,
    posted_cutoff: postedCutoff,
    warnings,
  };

  // Fail-lazy telemetry upsert with complete schema defaults
  try {
    const telemetryPayload = {
      ...(wsSettings ?? {}),
      workspace_id: cleanWorkspaceId,
      auto_prune_enabled: wsSettings?.auto_prune_enabled ?? false,
      retention_posted_days: retentionPostedDays,
      retention_terminal_days: terminalDays,
      retention_logs_days: logsDays,
      import_sessions_days: importDays,
      processing_timeout_minutes: processingTimeoutMinutes,
      p2_prune_enabled: wsSettings?.p2_prune_enabled ?? false,
      competitor_snapshots_days: compSnapshotsDays,
      competitor_jobs_days: compJobsDays,
      p3_prune_enabled: wsSettings?.p3_prune_enabled ?? false,
      ingestion_runs_days: ingestionRunsDays,
      top_pins_raw_days: topPinsRawDays,
      top_pins_downsample_enabled: wsSettings?.top_pins_downsample_enabled ?? false,
      analytics_daily_keep_days: wsSettings?.analytics_daily_keep_days ?? null,
      p4_prune_enabled: wsSettings?.p4_prune_enabled ?? false,
      pa_runs_retention_days: paRunsDays,
      pa_metrics_retention_days: paMetricsDays,
      last_cleanup_at: new Date().toISOString(),
      last_cleanup_result: {
        at: new Date().toISOString(),
        trigger: opts?.trigger ?? 'api',
        swept_pins: payload.swept_pins_count,
        warnings: payload.warnings,
        sections: {
          p1: {
            pins: payload.deleted_pins_count,
            terminal: payload.deleted_terminal_pins_count,
            logs: payload.deleted_delivery_logs,
            sessions: payload.deleted_import_sessions,
          },
          p2: payload.p2 ?? null,
          p3: {
            runs: payload.deleted_ingestion_runs,
            snapshots: payload.deleted_snapshots_count,
          },
          p4: {
            runs: payload.deleted_pa_runs,
            metrics: payload.deleted_pa_metrics,
          },
        },
      },
      updated_at: new Date().toISOString(),
    };

    if (schedulingAdmin && typeof schedulingAdmin.from === 'function') {
      const builder = schedulingAdmin.from('workspace_retention_settings');
      if (builder && typeof builder.upsert === 'function') {
        await builder.upsert(telemetryPayload, { onConflict: 'workspace_id' });
      }
    }
  } catch (e) {
    console.warn('[Retention] telemetry write failed:', e);
  }

  return payload;
}
