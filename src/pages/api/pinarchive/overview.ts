export const prerender = false;
import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { dbClients } from '../../../server/db/clients';
import { errorStatus } from '../../../server/lib/http-error';
import { getNextCronDate } from '../../../lib/cron-helper';
import { gasCall } from '../../../server/lib/gas-bridge';
import { edgeCache } from '../../../server/services/edge-cache';
import { getAnalyticsKV } from '../../../lib/edge-kv';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (o: any, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { 'Content-Type': 'application/json' },
  });

async function guard(locals: any, explicitWs?: string) {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  if (!user || !schedulingClient) {
    return { err: json({ success: false, error: 'Unauthorized: missing session' }, 401) };
  }
  const workspaceId = explicitWs || locals.activeWorkspaceId;
  if (!workspaceId) {
    return { err: json({ success: false, error: 'Unauthorized: missing workspace identifier' }, 401) };
  }
  if (!UUID_REGEX.test(workspaceId)) {
    return { err: json({ success: false, error: 'Invalid workspace identifier format.' }, 400) };
  }
  try {
    const wsCtx = await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, 'member');
    return { ok: { ws: wsCtx.workspaceId, db: dbClients.getPinArchive(locals.runtime?.env) } };
  } catch (e: any) {
    return { err: json({ success: false, error: e.message || 'Forbidden' }, errorStatus(e)) };
  }
}

export const GET: APIRoute = async ({ request, locals }) => {
  const searchParams = new URL(request.url).searchParams;
  const explicitWs = searchParams.get('workspace_id') || undefined;
  const g = await guard(locals, explicitWs);
  if (g.err) return g.err;

  const db = g.ok!.db;
  const ws = g.ok!.ws;

  try {
    // Safely prepare table queries with method checks
    const runsTable = typeof db.from === 'function' ? db.from('pa_runs') : null;
    const runsPromise = runsTable && typeof runsTable.select === 'function'
      ? runsTable.select('account_id, pins_updated, started_at').eq('workspace_id', ws).eq('trigger', 'refresh').order('started_at', { ascending: false }).limit(300)
      : Promise.resolve({ data: [], error: null });

    const settingsTable = typeof db.from === 'function' ? db.from('pa_workspace_settings') : null;
    const settingsPromise = settingsTable && typeof settingsTable.select === 'function'
      ? settingsTable.select('cron_expression, schedule_status, fastcron_job_id').eq('workspace_id', ws).maybeSingle()
      : Promise.resolve({ data: null, error: null });

    // Task 4: Accelerated Summary table & fast sums RPC
    const statsTable = typeof db.from === 'function' ? db.from('pa_account_stats') : null;
    const statsPromise = statsTable && typeof statsTable.select === 'function'
      ? statsTable.select('account_id, pins_count, archived_count, sum_saves, sum_shares').eq('workspace_id', ws)
      : Promise.resolve({ data: null, error: { message: 'stats table unavailable' } });

    const fastSumsPromise = typeof db.rpc === 'function'
      ? db.rpc('pa_workspace_sums_fast', { p_workspace_id: ws })
      : Promise.resolve({ data: null, error: { message: 'fast sums rpc unavailable' } });

    // Tier 2: Execute all independent queries concurrently via Promise.allSettled
    const [
      accResSettled,
      recentRunsSettled,
      wsSettingsSettled,
      statsResSettled,
      fastSumsSettled
    ] = await Promise.allSettled([
      db.from('pa_accounts')
        .select('id, username, status, pins_count, follower_count, last_run_at, sheet_id, next_run_at, ingest_enabled, interval_days, backfill_status, backfill_cursor, last_result, oldest_pin_at')
        .eq('workspace_id', ws)
        .limit(100),
      runsPromise,
      settingsPromise,
      statsPromise,
      fastSumsPromise
    ]);

    // 1. Process Accounts
    const accRes = accResSettled.status === 'fulfilled' ? accResSettled.value : null;
    if (!accRes || accRes.error) {
      return json({ success: false, error: accRes?.error?.message || 'Failed to fetch accounts' }, 500);
    }
    let accounts = (accRes.data || []).map((a: any) => ({ ...a }));

    // 2. Fetch live DB pin count and KPI sums (Fast Path with Defensive Fallback)
    const countMap = new Map<string, number>();
    const archivedMap = new Map<string, number>();
    let totalPins = 0;
    let sumSaves = 0;
    let sumShares = 0;

    const statsRes = statsResSettled.status === 'fulfilled' ? statsResSettled.value : null;
    const fastSumsRes = fastSumsSettled.status === 'fulfilled' ? fastSumsSettled.value : null;

    const isStatsValid = statsRes && !statsRes.error && Array.isArray(statsRes.data);
    const isFastSumsValid = fastSumsRes && !fastSumsRes.error && Array.isArray(fastSumsRes.data) && fastSumsRes.data.length > 0;

    if (isStatsValid && isFastSumsValid) {
      for (const row of statsRes.data) {
        if (row.account_id) {
          countMap.set(row.account_id, Number(row.pins_count || 0));
          archivedMap.set(row.account_id, Number(row.archived_count ?? row.pins_count ?? 0));
        }
      }
      const fastSums = fastSumsRes.data[0];
      sumSaves = Number(fastSums.sum_saves || 0);
      sumShares = Number(fastSums.sum_shares || 0);
      totalPins = Number(fastSums.total_pins || 0);
    } else {
      // Defensive fallback: run legacy queries if summary table or fast RPC is unavailable/errored
      const pinsTable = typeof db.from === 'function' ? db.from('pa_pins') : null;
      const countPromise = pinsTable && typeof pinsTable.select === 'function'
        ? pinsTable.select('*', { count: 'exact', head: true }).eq('workspace_id', ws)
        : Promise.resolve({ count: 0, error: null });

      const [countRpcSettled, totalPinsSettled, sumsRpcSettled] = await Promise.allSettled([
        typeof db.rpc === 'function'
          ? db.rpc('pa_account_pin_counts', { p_workspace_id: ws })
          : Promise.resolve({ data: [], error: null }),
        countPromise,
        typeof db.rpc === 'function'
          ? db.rpc('pa_workspace_sums', { p_workspace_id: ws })
          : Promise.resolve({ data: [], error: null })
      ]);

      const countRpc = countRpcSettled.status === 'fulfilled' ? countRpcSettled.value : null;
      if (countRpc && !countRpc.error && Array.isArray(countRpc.data)) {
        for (const row of countRpc.data) {
          if (row.account_id) {
            countMap.set(row.account_id, Number(row.pins || 0));
            archivedMap.set(row.account_id, Number(row.archived ?? row.pins ?? 0));
          }
        }
      }

      const totalPinsRes = totalPinsSettled.status === 'fulfilled' ? totalPinsSettled.value : null;
      totalPins = (totalPinsRes && !totalPinsRes.error && typeof totalPinsRes.count === 'number')
        ? totalPinsRes.count
        : 0;

      const rpcRes = sumsRpcSettled.status === 'fulfilled' ? sumsRpcSettled.value : null;
      if (rpcRes && !rpcRes.error && Array.isArray(rpcRes.data) && rpcRes.data.length > 0) {
        sumSaves = Number(rpcRes.data[0].sum_saves || 0);
        sumShares = Number(rpcRes.data[0].sum_shares || 0);
      } else {
        try {
          if (pinsTable && typeof pinsTable.select === 'function') {
            const query = pinsTable.select('saves, share_count').eq('workspace_id', ws);
            const ordered = typeof query?.order === 'function' ? query.order('pin_id', { ascending: true }) : query;
            const paged = typeof ordered?.range === 'function'
              ? ordered.range(0, 999)
              : typeof ordered?.limit === 'function'
              ? ordered.limit(1000)
              : ordered;
            const { data: fallbackPins } = await paged;
            for (const p of fallbackPins || []) {
              sumSaves += Number(p.saves || 0);
              sumShares += Number(p.share_count || 0);
            }
          }
        } catch (sumErr) {
          console.warn('[PinArchive Overview] Sums query fallback warning:', sumErr);
        }
      }
    }

    // 3. Compute Recent Δ per account from its latest refresh run session
    let changedMap = new Map<string, number>();
    const runsRes = recentRunsSettled.status === 'fulfilled' ? recentRunsSettled.value : null;
    const recentRuns = (runsRes && !runsRes.error && Array.isArray(runsRes.data)) ? runsRes.data : [];
    if (recentRuns.length > 0) {
      const accountLatestTime = new Map<string, number>();
      for (const r of recentRuns) {
        if (!r.account_id || !r.started_at) continue;
        const t = new Date(r.started_at).getTime();
        if (!accountLatestTime.has(r.account_id) || t > accountLatestTime.get(r.account_id)!) {
          accountLatestTime.set(r.account_id, t);
        }
      }

      for (const r of recentRuns) {
        if (!r.account_id || !r.started_at) continue;
        const latestT = accountLatestTime.get(r.account_id);
        if (!latestT) continue;
        const t = new Date(r.started_at).getTime();
        // Aggregate batches from the same run session (within 45 minutes of account's latest run)
        if (latestT - t <= 45 * 60 * 1000) {
          changedMap.set(r.account_id, (changedMap.get(r.account_id) || 0) + Number(r.pins_updated || 0));
        }
      }
    }

    // 4. Derive active schedule next run from persisted workspace settings
    let activeNextRunIso: string | null = null;
    const settingsRes = wsSettingsSettled.status === 'fulfilled' ? wsSettingsSettled.value : null;
    const wsSettings = (settingsRes && !settingsRes.error) ? settingsRes.data : null;
    if (wsSettings) {
      const cronExpr = wsSettings.cron_expression;
      const isPaused = wsSettings.schedule_status === 'paused' || wsSettings.schedule_status === 'disabled';
      const hasJob = Boolean(wsSettings.fastcron_job_id);
      const jobTimezone = 'UTC';

      if (cronExpr && !isPaused && hasJob) {
        const nextDate = getNextCronDate(cronExpr, jobTimezone);
        if (nextDate) {
          activeNextRunIso = nextDate.toISOString();
        }
      }
    }

    // 5. Query oldest pin timestamp (Account Age) via GAS bridge & edge cache
    // Transitional fallback: only needed when one or more accounts lack a persisted oldest_pin_at
    const needsGasAges = accounts.some((a: any) => !a.oldest_pin_at);
    const allUsernames = accounts.map((a: any) => a.username).filter(Boolean);
    const chunk1 = allUsernames.slice(0, 50);
    const chunk2 = allUsernames.slice(50, 100);

    const kv = getAnalyticsKV(locals);
    let cachedAges: Record<string, string | null> | null = null;
    let agesCacheKey = '';

    let agesRes1: any = null;
    let agesRes2: any = null;

    if (needsGasAges && allUsernames.length > 0) {
      // TIER C Hardening: deterministic hash-based edge cache key (capped length, order-independent)
      const sortedJoined = [...allUsernames].sort().join('|');
      const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sortedJoined));
      const hashHex = Array.from(new Uint8Array(hashBuf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 16);
      agesCacheKey = `pa:ages:v2:${ws}:${hashHex}`;

      try {
        const cached = await edgeCache.get<Record<string, string | null>>(agesCacheKey, kv);
        if (cached.status === 'HIT' && cached.data) {
          cachedAges = cached.data;
        }
      } catch (e: any) {
        console.warn('[PinArchiveOverview] Edge cache get error:', e?.message);
      }

      if (cachedAges) {
        agesRes1 = { ok: true, ages: cachedAges };
        agesRes2 = { ok: true, ages: cachedAges };
      } else {
        const [r1, r2] = await Promise.allSettled([
          chunk1.length > 0
            ? gasCall(locals.runtime?.env, ws, 'account_ages', { usernames: chunk1 })
            : Promise.resolve({ ok: false }),
          chunk2.length > 0
            ? gasCall(locals.runtime?.env, ws, 'account_ages', { usernames: chunk2 })
            : Promise.resolve({ ok: false }),
        ]);
        agesRes1 = r1.status === 'fulfilled' ? r1.value : null;
        agesRes2 = r2.status === 'fulfilled' ? r2.value : null;
      }
    }

    // Merge oldest_pin_at results across chunks
    // 1. GAS / cache fallback first
    const combinedAges: Record<string, string | null> = {};
    if (agesRes1 && agesRes1.ok && agesRes1.ages) {
      Object.assign(combinedAges, agesRes1.ages);
    }
    if (agesRes2 && agesRes2.ok && agesRes2.ages) {
      Object.assign(combinedAges, agesRes2.ages);
    }

    // 2. Persisted DB column takes absolute precedence (overwrites GAS fallback)
    for (const a of accounts) {
      if (a.oldest_pin_at) {
        combinedAges[a.username] = a.oldest_pin_at;
      }
    }

    // Save to edge cache (6 hours TTL if ages found, 30s if all null to avoid locking empty cache)
    if (needsGasAges && !cachedAges && agesCacheKey && Object.keys(combinedAges).length > 0) {
      const hasAnyAge = Object.values(combinedAges).some((v) => Boolean(v));
      const ttl = hasAnyAge ? 6 * 3600 : 30;
      try {
        await edgeCache.set(agesCacheKey, combinedAges, kv, ttl);
      } catch (e: any) {
        console.warn('[PinArchiveOverview] Edge cache set error:', e?.message);
      }
    }

    // Attach computed metrics to each account:
    accounts = accounts.map((a: any) => {
      const dbPins = countMap.has(a.id) ? countMap.get(a.id) : a.pins_count;
      return {
        ...a,
        db_pins_count: dbPins,
        archived_count: archivedMap.has(a.id) ? archivedMap.get(a.id) : (countMap.has(a.id) ? countMap.get(a.id) : a.pins_count ?? 0),
        next_run_at: activeNextRunIso || a.next_run_at || null,
        changed_last_refresh: changedMap.get(a.id) ?? 0,
        checked_last_refresh: Number(dbPins ?? 0),
        oldest_pin_at: combinedAges[a.username] ?? null,
      };
    });

    return json({
      success: true,
      accounts,
      totals: {
        accounts: accounts.length,
        archived_pins: totalPins,
        sum_saves: sumSaves,
        sum_shares: sumShares,
        total_pins: totalPins,
      },
    });
  } catch (e: any) {
    return json({ success: false, error: e.message || 'Internal Server Error' }, 500);
  }
};
