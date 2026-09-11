/**
 * PinArchive Refresh: fetches updated metrics & relay enrichment for archived pins and pushes deltas.
 * Env Vars: PINARCHIVE_SUPABASE_URL, PINARCHIVE_SUPABASE_KEY, PINORBIT_WORKER_URL, PINARCHIVE_INGEST_SECRET
 */

import { fileURLToPath } from 'url';
import path from 'path';
import {
  PINTEREST_PAGE_HEADERS as HEADERS,
  findPinInTree,
  formatPin,
  extractPinData,
} from './lib/pinterest.mjs';
import { pushToIngest } from './lib/pa-client.mjs';

const CFG = {
  SLEEP_MS_MIN: 2500,
  SLEEP_MS_MAX: 4000,
  BATCH_SIZE: 12,
  PUSH_SLEEP_MS: 3000,
  CIRCUIT_BREAKER: 3,
  CONCURRENCY: 3,
};

const SHARD_COUNT = Math.max(1, parseInt(process.env.SHARD_COUNT || '1', 10) || 1);
const REFRESH_SHARD = Math.max(0, parseInt(process.env.REFRESH_SHARD || '0', 10) || 0);

const { PINARCHIVE_SUPABASE_URL, PINARCHIVE_SUPABASE_KEY, PINORBIT_WORKER_URL, PINARCHIVE_INGEST_SECRET } = process.env;

const REFRESH_WORKSPACE_ID = (process.env.REFRESH_WORKSPACE_ID || process.env.WORKSPACE_ID || process.env.WORKSPACE_FILTER || process.env.REFRESH_WORKSPACE_FILTER || '').trim();
const REFRESH_USERNAME = (process.env.REFRESH_USERNAME || '').trim().toLowerCase();
const REFRESH_USERNAMES = (process.env.REFRESH_USERNAMES || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);
const REFRESH_FORCE = (process.env.REFRESH_FORCE || process.env.FORCE_RUN || '').trim().toLowerCase() === 'true';

function checkEnv() {
  const missing = [];
  if (!PINARCHIVE_SUPABASE_URL) missing.push('PINARCHIVE_SUPABASE_URL');
  if (!PINARCHIVE_SUPABASE_KEY) missing.push('PINARCHIVE_SUPABASE_KEY');
  if (!PINORBIT_WORKER_URL) missing.push('PINORBIT_WORKER_URL');
  if (!PINARCHIVE_INGEST_SECRET) missing.push('PINARCHIVE_INGEST_SECRET');
  if (missing.length) { console.error(`Missing env vars: ${missing.join(', ')}`); process.exit(1); }
}

async function supaQuery(table, params = '') {
  const url = `${PINARCHIVE_SUPABASE_URL}/rest/v1/${table}${params ? '?' + params : ''}`;
  const res = await fetch(url, {
    headers: { 'apikey': PINARCHIVE_SUPABASE_KEY, 'Authorization': `Bearer ${PINARCHIVE_SUPABASE_KEY}`, 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`Supabase ${table}: HTTP ${res.status}`);
  return res.json();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function randomJitterMs(min = CFG.SLEEP_MS_MIN, max = CFG.SLEEP_MS_MAX) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

class Semaphore {
  constructor(max) {
    this.max = max;
    this.count = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.count < this.max) {
      this.count++;
      return;
    }
    await new Promise(resolve => this.queue.push(resolve));
  }
  release() {
    this.count--;
    if (this.queue.length > 0) {
      this.count++;
      const next = this.queue.shift();
      next();
    }
  }
}



async function fetchPinFromPinterest(pinId) {
  try {
    const res = await fetch(`https://www.pinterest.com/pin/${pinId}/`, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (res.status !== 200) return { ok: false, code: res.status };
    const html = await res.text();
    const data = extractPinData(html, pinId);
    if (!data) {
      return {
        ok: false,
        code: 200,
        error: 'extraction-failed',
        diag: {
          htmlLen: html.length,
          relay: html.includes('__PWS_RELAY_REGISTER_COMPLETED_REQUEST__'),
          pws: html.includes('__PWS_DATA__'),
          hasPinId: html.includes(pinId),
        },
      };
    }
    return { ok: true, ...data };
  } catch (err) {
    return {
      ok: false,
      code: 0,
      error: err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'fetch-timeout-15s' : (err?.message || 'fetch-failed'),
    };
  }
}

async function pushBatch(workspaceId, username, pins, followerCount, totalPins) {
  return pushToIngest({
    workerUrl: PINORBIT_WORKER_URL,
    ingestSecret: PINARCHIVE_INGEST_SECRET,
    workspaceId,
    username,
    pins,
    runType: 'refresh',
    trigger: 'refresh',
    followerCount,
    totalPins,
  });
}

async function main() {
  checkEnv();
  console.log('\nPinArchive Refresh starting...\n');

  // Load workspace settings to map gating controls
  const settingsMap = new Map();
  try {
    const wsSettings = await supaQuery('pa_workspace_settings', 'select=workspace_id,ingest_enabled,paused_account_policy,refresh_max_pins,refresh_min_saves,discovery_stop_pages,audit_sweep_enabled,daily_sheet_sync_enabled,github_schedule_enabled');
    if (Array.isArray(wsSettings)) {
      for (const s of wsSettings) {
        settingsMap.set(s.workspace_id, s);
      }
    }
  } catch (e) {
    console.warn('Could not query pa_workspace_settings (using defaults):', e.message);
  }

  // Check Master Workspace Global Kill-Switch for scheduled pipeline runs
  const isGhScheduled = (process.env.EVENT_NAME || process.env.GITHUB_EVENT_NAME || '').trim().toLowerCase() === 'schedule';
  if (isGhScheduled) {
    try {
      const p1Url = process.env.SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL || process.env.PINORBIT_SUPABASE_URL || '';
      const p1Key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
      if (p1Url && p1Key) {
        const p1Res = await fetch(`${p1Url}/rest/v1/workspaces?select=id,is_master&is_master=eq.true&limit=1`, {
          headers: { apikey: p1Key, Authorization: `Bearer ${p1Key}`, Accept: 'application/json' },
        });
        if (p1Res.ok) {
          const masterWorkspaces = await p1Res.json();
          if (Array.isArray(masterWorkspaces) && masterWorkspaces.length > 0) {
            const masterId = masterWorkspaces[0].id;
            const masterSetting = settingsMap.get(masterId);
            if (masterSetting && masterSetting.github_schedule_enabled === false) {
              console.log(`[GLOBAL SKIP] GitHub Actions schedule is globally disabled by Master Workspace (${masterId.slice(0, 8)}). Exiting immediately.`);
              return;
            }
          }
        }
      }
    } catch (err) {
      // Non-blocking fallback
    }
  }

  let accounts = await supaQuery('pa_accounts', 'select=id,workspace_id,username,follower_count,status,ingest_enabled,last_run_at&order=username.asc');
  if (!accounts.length) { console.log('No accounts found.'); return; }

  if (REFRESH_USERNAME) {
    accounts = accounts.filter(a => a.username.toLowerCase() === REFRESH_USERNAME);
    console.log(`Requested single account @${REFRESH_USERNAME}: ${accounts.length} matched in this workspace/shard scope`);
  } else if (REFRESH_USERNAMES.length > 0) {
    const set = new Set(REFRESH_USERNAMES);
    accounts = accounts.filter(a => set.has(a.username.toLowerCase()));
    console.log(`Requested ${REFRESH_USERNAMES.length} account(s): ${accounts.length} matched in this workspace/shard scope`);
  }

  if (!accounts.length) { console.log('No matching accounts found.'); return; }

  // Group accounts by workspace for passengers summary
  const wsGroups = new Map();
  for (const a of accounts) {
    const ws = a.workspace_id;
    if (!wsGroups.has(ws)) wsGroups.set(ws, { total: 0, intervals: new Set() });
    const g = wsGroups.get(ws);
    g.total++;
    g.intervals.add(`${a.interval_days || 1}d`);
  }

  console.log('🚌 Today\'s passengers:');
  for (const [wsId, g] of wsGroups.entries()) {
    console.log(`- Workspace ${wsId.slice(0, 8)}: ${g.total} accounts (interval=${Array.from(g.intervals).join('/')})`);
  }
  console.log('');

  // Distribute accounts across shard matrix when processing multi-account workspaces
  const isTargetedRun = Boolean(REFRESH_USERNAME || REFRESH_USERNAMES.length > 0);
  const shardedAccounts = isTargetedRun
    ? accounts
    : accounts.filter((_, idx) => idx % SHARD_COUNT === REFRESH_SHARD);

  console.log(`Found ${accounts.length} account(s) total — processing ${shardedAccounts.length} in shard ${REFRESH_SHARD + 1}/${SHARD_COUNT}\n`);
  const summary = { refreshed: 0, updated: 0, pushed: 0, errors: [] };

  for (const acc of shardedAccounts) {
    const wsPrefix = `[ws:${acc.workspace_id.slice(0, 8)}]`;
    const wsSetting = settingsMap.get(acc.workspace_id);
    const wsIngestEnabled = wsSetting ? wsSetting.ingest_enabled : true;
    const wsGhScheduleEnabled = wsSetting?.github_schedule_enabled ?? true;
    const isGhScheduledEvent = (process.env.GITHUB_EVENT_NAME || '').trim().toLowerCase() === 'schedule';
    const pausedPolicy = wsSetting ? wsSetting.paused_account_policy : 'reject';

    // Check GitHub schedule gate
    if (isGhScheduledEvent && !wsGhScheduleEnabled) {
      console.log(`[SKIP]${wsPrefix} GitHub Actions 07:00 UTC schedule is disabled (delegated to FastCron).`);
      continue;
    }

    // Check workspace-level ingest gate
    if (wsIngestEnabled === false) {
      console.log(`[SKIP]${wsPrefix} Ingest is disabled at workspace level.`);
      continue;
    }

    // Check account-level ingest gate
    if (acc.ingest_enabled === false) {
      console.log(`[SKIP]${wsPrefix} Account @${acc.username} ingest is disabled (ingest_enabled=false).`);
      continue;
    }

    // Check paused policy gate
    if (['paused', 'cookie_expired', 'error'].includes(acc.status) && pausedPolicy === 'reject') {
      console.log(`[SKIP]${wsPrefix} Account @${acc.username} is paused (policy=reject).`);
      continue;
    }

    if (REFRESH_WORKSPACE_ID && acc.workspace_id !== REFRESH_WORKSPACE_ID) {
      console.log(`[SKIP]${wsPrefix} ${acc.username}: outside requested workspace.`); continue;
    }
    if (REFRESH_USERNAME && acc.username.toLowerCase() !== REFRESH_USERNAME) {
      console.log(`[SKIP]${wsPrefix} ${acc.username}: outside requested account.`); continue;
    }

    // X2: Precedence: env REFRESH_MAX_PINS if set -> else DB setting -> else 0 (unlimited with pagination)
    const envMaxPinsRaw = process.env.REFRESH_MAX_PINS !== undefined && process.env.REFRESH_MAX_PINS.trim() !== ''
      ? parseInt(process.env.REFRESH_MAX_PINS, 10)
      : null;
    const settingsRefreshMaxPins = typeof wsSetting?.refresh_max_pins === 'number' ? wsSetting.refresh_max_pins : null;
    const configuredCap = envMaxPinsRaw !== null && !isNaN(envMaxPinsRaw)
      ? envMaxPinsRaw
      : (settingsRefreshMaxPins !== null && !isNaN(settingsRefreshMaxPins) ? settingsRefreshMaxPins : 0);

    const cap = configuredCap > 0 ? configuredCap : Number.MAX_SAFE_INTEGER;
    const effectiveCap = Math.min(cap, 10000);

    // Refresh Min Saves Gate: env REFRESH_MIN_SAVES -> else DB setting -> else 0 (all)
    const envMinSavesRaw = process.env.REFRESH_MIN_SAVES !== undefined && process.env.REFRESH_MIN_SAVES.trim() !== ''
      ? parseInt(process.env.REFRESH_MIN_SAVES, 10)
      : null;
    const settingsRefreshMinSaves = typeof wsSetting?.refresh_min_saves === 'number' ? wsSetting.refresh_min_saves : null;
    const effectiveMinSaves = envMinSavesRaw !== null && !isNaN(envMinSavesRaw)
      ? Math.max(0, envMinSavesRaw)
      : (settingsRefreshMinSaves !== null && !isNaN(settingsRefreshMinSaves) ? Math.max(0, settingsRefreshMinSaves) : 0);
    const savesFilterQuery = effectiveMinSaves > 0 ? `&saves=gte.${effectiveMinSaves}` : '';

    // True pagination loop (1000 per page)
    const allPins = [];
    let offset = 0;
    const PAGE = 1000;
    while (allPins.length < effectiveCap) {
      const fetchLimit = Math.min(PAGE, effectiveCap - allPins.length);
      const chunk = await supaQuery(
        'pa_pins',
        `select=pin_id,saves,repins,comments,share_count,reactions,annotations,seo_category,canonical_pin_id,seo_alt_text,board_pin_count,board_last_modified_at,archived_at,title,description,link,utm_link,domain,board_name,board_id,created_at_pinterest,image_url,dominant_color,image_signature,node_id,is_video,velocity&workspace_id=eq.${acc.workspace_id}&account_id=eq.${acc.id}${savesFilterQuery}&order=last_updated_at.asc&limit=${fetchLimit}&offset=${offset}`
      );
      if (!Array.isArray(chunk) || chunk.length === 0) break;
      allPins.push(...chunk);
      if (chunk.length < fetchLimit) break;
      offset += chunk.length;
    }

    const pins = isTargetedRun ? allPins.filter((_, idx) => idx % SHARD_COUNT === REFRESH_SHARD) : allPins;

    if (!pins.length) continue;
    console.log(`${acc.username}: ${pins.length} pins to refresh (min saves: ${effectiveMinSaves > 0 ? effectiveMinSaves : 'all'}, shard ${REFRESH_SHARD + 1}/${SHARD_COUNT} of ${allPins.length} total)`);

    let consecutiveErrors = 0;
    let rateLimitCooldownUntil = 0;
    let circuitBroken = false;
    const changedPins = [];
    let accountFollowerCount = typeof acc.follower_count === 'number' && acc.follower_count > 0 ? acc.follower_count : null;

    const sem = new Semaphore(CFG.CONCURRENCY);

    // Two-Phase: Phase 1 (Concurrent Fetch & Extract with Promise.allSettled)
    await Promise.allSettled(
      pins.map(async (p) => {
        await sem.acquire();
        try {
          if (circuitBroken) return;

          // Rate-limit cooldown check
          if (Date.now() < rateLimitCooldownUntil) {
            const waitMs = Math.max(0, rateLimitCooldownUntil - Date.now());
            console.warn(`[RATE LIMIT] Pausing for ${Math.round(waitMs / 1000)}s cooldown before pin ${p.pin_id}`);
            await sleep(waitMs);
          }

          if (circuitBroken) return;

          // Apply jitter delay before request
          await sleep(randomJitterMs());

          const pinId = String(p.pin_id);
          const fresh = await fetchPinFromPinterest(pinId);

          if (!fresh.ok) {
            if (fresh.code === 429) {
              consecutiveErrors++;
              rateLimitCooldownUntil = Date.now() + 60000;
              console.warn(`[429 RATE LIMIT] Pin ${pinId} received 429. Setting 60s cooldown.`);
            } else if (fresh.code === 403) {
              consecutiveErrors++;
            } else {
              consecutiveErrors = 0;
            }

            if (consecutiveErrors >= CFG.CIRCUIT_BREAKER) {
              circuitBroken = true;
              summary.errors.push(`circuit-breaker: ${acc.username}`);
              console.error(`[CIRCUIT BREAKER] Hit ${CFG.CIRCUIT_BREAKER} consecutive errors on ${acc.username}. Aborting remaining pin fetches for this account.`);
              return;
            }

            if (fresh.code === 200 && fresh.diag) {
              console.warn(`[DIAG] ${pinId}: html=${Math.round(fresh.diag.htmlLen / 1024)}KB relay=${fresh.diag.relay} pws=${fresh.diag.pws} hasPinId=${fresh.diag.hasPinId}`);
            }
            console.warn(`[FAIL] ${pinId}: ${fresh.error || 'http ' + fresh.code} (code=${fresh.code})`);
            summary.errors.push(`${pinId}: ${fresh.error || 'http ' + fresh.code}`);
            return;
          }

          consecutiveErrors = 0;
          summary.refreshed++;

          if (typeof fresh.follower_count === 'number' && fresh.follower_count > 0 && accountFollowerCount === null) {
            accountFollowerCount = fresh.follower_count;
          }

          const oldSaves = Number(p.saves) || 0;
          const oldRepins = Number(p.repins) || 0;

          const existingAnnotationNames = new Set((Array.isArray(p.annotations) ? p.annotations : [])
            .map(a => (typeof a === 'string' ? a.trim() : String(a?.name || '').trim()))
            .filter(Boolean));
          const newAnnotations = (Array.isArray(fresh.annotations) ? fresh.annotations : [])
            .filter(a => a?.name && !existingAnnotationNames.has(a.name));

          // X3: ageDays NaN protection
          const createdAt = p.created_at_pinterest || fresh.created_at_pinterest;
          const ms = createdAt ? Date.now() - new Date(createdAt).getTime() : NaN;
          const ageDays = !Number.isFinite(ms) || ms <= 0 ? 1 : Math.max(1, Math.round(ms / (1000 * 60 * 60 * 24)));

          const oldShares = Number(p.share_count) || 0;
          const oldComments = Number(p.comments) || 0;

          if (
            fresh.saves !== oldSaves ||
            fresh.repins !== oldRepins ||
            (fresh.share_count !== undefined && fresh.share_count !== oldShares) ||
            (fresh.comments !== undefined && fresh.comments !== oldComments) ||
            newAnnotations.length > 0
          ) {
            const changedItem = {
              pin_id: pinId,
              saves: fresh.saves,
              repins: fresh.repins,
              comments: fresh.comments,
              velocity: Math.round((fresh.saves / ageDays) * 100) / 100,
              archived_at: p.archived_at ?? null,
              refreshed_at: new Date().toISOString(),
            };
            if (fresh.reactions && Object.keys(fresh.reactions).length > 0) {
              changedItem.reactions = fresh.reactions;
            }
            if (newAnnotations.length > 0) {
              changedItem.annotations = newAnnotations;
            }
            if (typeof fresh.share_count === 'number' && fresh.share_count > 0) {
              changedItem.share_count = fresh.share_count;
            }
            changedPins.push(changedItem);
            summary.updated++;
          }
        } finally {
          sem.release();
        }
      })
    );

    // Two-Phase: Phase 2 (Sequential Batch Push)
    if (changedPins.length > 0) {
      console.log(`[PUSH] Pushing ${changedPins.length} changed pins for @${acc.username} in batches of ${CFG.BATCH_SIZE}...`);
      for (let i = 0; i < changedPins.length; i += CFG.BATCH_SIZE) {
        const batch = changedPins.slice(i, i + CFG.BATCH_SIZE);
        const result = await pushBatch(acc.workspace_id, acc.username, batch, accountFollowerCount, allPins.length);
        if (result.ok) {
          summary.pushed += result.pushed;
        } else {
          summary.errors.push(`push: ${result.error}`);
          if (result.terminal) break;
        }
        if (i + CFG.BATCH_SIZE < changedPins.length) {
          await sleep(CFG.PUSH_SLEEP_MS);
        }
      }
    }
  }

  console.log(`\nSummary: checked=${summary.refreshed}, changed=${summary.updated}, pushed=${summary.pushed}, errors=${summary.errors.length}`);
  const isFiltered = Boolean(REFRESH_WORKSPACE_ID || REFRESH_USERNAME || REFRESH_USERNAMES.length > 0);
  const hasPushErrors = summary.errors.some(e => e.startsWith('push:'));
  const allFailed = summary.errors.length > 0 && summary.refreshed === 0;

  if (hasPushErrors || allFailed) {
    process.exit(1);
  }

  if (isFiltered) {
    // Filtered run: success if anything was pushed/updated, regardless of per-pin extraction misses
    if (summary.pushed > 0 || summary.updated > 0) process.exit(0);
    // No change but also no systemic failure (e.g. capped rotation) → still 0
    if (summary.errors.length === 0) process.exit(0);
    // All pins in the filtered scope failed → keep red signal
    process.exit(1);
  }

  if (summary.errors.length > summary.refreshed) {
    process.exit(1);
  }

  process.exit(0);
}

export { extractPinData, formatPin, findPinInTree, fetchPinFromPinterest, pushBatch, Semaphore };

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
