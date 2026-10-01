/**
 * PinArchive Refresh: fetches updated metrics & relay enrichment for archived pins and pushes deltas.
 * Env Vars: PINARCHIVE_SUPABASE_URL, PINARCHIVE_SUPABASE_KEY, PINORBIT_WORKER_URL, PINARCHIVE_INGEST_SECRET
 */

import fs from 'node:fs';
import { fileURLToPath } from 'url';
import path from 'path';
import {
  PINTEREST_PAGE_HEADERS as HEADERS,
  findPinInTree,
  formatPin,
  extractPinData,
} from './lib/pinterest.mjs';
import { pushToIngest, fetchAllAccounts, supaPatch, supaInsert } from './lib/pa-client.mjs';
import {
  getPinFromRunnerCache,
  savePinsToRunnerCache,
  flushRunnerCacheToDisk,
  getRunnerCacheStats,
} from './lib/runner-cache.mjs';

const CFG = {
  SLEEP_MS_MIN: 1500,
  SLEEP_MS_MAX: 2500,
  BATCH_SIZE: 50,
  PUSH_SLEEP_MS: 500,
  CIRCUIT_BREAKER: 10,
  CONCURRENCY: 4,
};

const SHARD_COUNT = Math.max(1, parseInt(process.env.SHARD_COUNT || '1', 10) || 1);
const REFRESH_SHARD = Math.max(0, parseInt(process.env.REFRESH_SHARD || '0', 10) || 0);

const { PINARCHIVE_SUPABASE_URL, PINARCHIVE_SUPABASE_KEY, PINORBIT_WORKER_URL, PINARCHIVE_INGEST_SECRET } = process.env;

const REFRESH_WORKSPACE_ID = (process.env.REFRESH_WORKSPACE_ID || process.env.WORKSPACE_ID || process.env.WORKSPACE_FILTER || process.env.REFRESH_WORKSPACE_FILTER || '').trim();
const REFRESH_USERNAME = (process.env.REFRESH_USERNAME || '').trim().toLowerCase().replace(/^@/, '');
const REFRESH_USERNAMES = (process.env.REFRESH_USERNAMES || '')
  .split(',')
  .map(s => s.trim().toLowerCase().replace(/^@/, ''))
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
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Supabase ${table}: HTTP ${res.status}: ${txt}`);
  }
  try {
    return await res.json();
  } catch (err) {
    await res.body?.cancel().catch(() => {});
    throw err;
  }
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



async function fetchPinFromPinterest(pinId, maxRetries = 2) {
  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      const res = await fetch(`https://www.pinterest.com/pin/${pinId}/`, {
        headers: HEADERS,
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });

      if (res.status === 429) {
        await res.text().catch(() => '');
        if (attempt < maxRetries) {
          const backoff = (attempt + 1) * 3000 + Math.floor(Math.random() * 2000);
          await sleep(backoff);
          attempt++;
          continue;
        }
        return { ok: false, code: 429, error: 'rate-limited-429' };
      }

      if (res.status >= 500 && res.status < 600) {
        await res.text().catch(() => '');
        if (attempt < maxRetries) {
          const backoff = (attempt + 1) * 2000 + Math.floor(Math.random() * 1500);
          await sleep(backoff);
          attempt++;
          continue;
        }
        return { ok: false, code: res.status, error: `http-${res.status}` };
      }

      if (res.status !== 200) {
        await res.text().catch(() => '');
        return { ok: false, code: res.status };
      }
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
      if (attempt < maxRetries) {
        const backoff = (attempt + 1) * 2000 + Math.floor(Math.random() * 1000);
        await sleep(backoff);
        attempt++;
        continue;
      }
      return {
        ok: false,
        code: 0,
        error: err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'fetch-timeout-15s' : (err?.message || 'fetch-failed'),
      };
    }
  }
}

async function pushBatch(workspaceId, username, pins, followerCount, totalPins, accountId, skipRunLog, totalChanged) {
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
    accountId,
    skipRunLog,
    pinsUpdated: totalChanged,
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
          signal: AbortSignal.timeout(15000),
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
        } else {
          await p1Res.text().catch(() => '');
        }
      }
    } catch (err) {
      // Non-blocking fallback
    }
  }

  const accountFilters = {
    select: 'id,workspace_id,username,follower_count,status,ingest_enabled,last_run_at,interval_days,pins_count',
  };
  if (REFRESH_WORKSPACE_ID) accountFilters.workspace = REFRESH_WORKSPACE_ID;
  if (REFRESH_USERNAME) accountFilters.username = REFRESH_USERNAME;

  let accounts = await fetchAllAccounts(supaQuery, accountFilters);
  if (!accounts.length) { console.log('No accounts found.'); return; }

  if (REFRESH_USERNAME) {
    accounts = accounts.filter(a => a.username.toLowerCase() === REFRESH_USERNAME);
    console.log(`Requested single account @${REFRESH_USERNAME}: ${accounts.length} matched in this workspace/shard scope`);
  } else if (REFRESH_USERNAMES.length > 0) {
    const set = new Set(REFRESH_USERNAMES);
    accounts = accounts.filter(a => set.has(a.username.toLowerCase()));
    console.log(`Requested ${REFRESH_USERNAMES.length} account(s): ${accounts.length} matched in this workspace/shard scope`);
  }

  if (REFRESH_WORKSPACE_ID) {
    accounts = accounts.filter(a => a.workspace_id === REFRESH_WORKSPACE_ID);
    console.log(`Filtered by workspace ${REFRESH_WORKSPACE_ID}: ${accounts.length} account(s)`);
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

  // Intra-Account Pin-Level Modulo Sharding across all runners
  // All matrix runners iterate through eligible accounts, processing their deterministic slice of pins (idx % SHARD_COUNT === REFRESH_SHARD)
  // Stagger/rotate account order by shard index to eliminate thundering herd and distribute load
  const offset = REFRESH_SHARD % (accounts.length || 1);
  const shardedAccounts = accounts.length > 1
    ? [...accounts.slice(offset), ...accounts.slice(0, offset)]
    : accounts;

  console.log(`Found ${accounts.length} account(s) total — processing pin slice (shard ${REFRESH_SHARD + 1}/${SHARD_COUNT}, account start offset=${offset}) across eligible accounts\n`);

  if (!shardedAccounts.length) {
    console.log('No accounts assigned to this shard.');
    if (process.env.GITHUB_STEP_SUMMARY) {
      try {
        fs.appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          `### 🔄 Refresh Shard ${REFRESH_SHARD + 1}/${SHARD_COUNT} (⚪ Idle)\n*No accounts assigned to this shard in current scope.*\n\n`,
          'utf-8'
        );
      } catch (e) {
        console.warn('Could not write to GITHUB_STEP_SUMMARY:', e.message);
      }
    }
    return;
  }

  const summary = { refreshed: 0, updated: 0, pushed: 0, errors: [] };
  const accountSummaries = [];

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

    if (REFRESH_USERNAME && acc.username.toLowerCase() !== REFRESH_USERNAME) {
      console.log(`[SKIP]${wsPrefix} ${acc.username}: outside requested account.`); continue;
    }

    // Fast-skip accounts with 0 known pins in DB to eliminate redundant database queries
    if (typeof acc.pins_count === 'number' && acc.pins_count === 0) {
      continue;
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
    const effectiveCap = cap;

    // Refresh Min Saves Gate: env REFRESH_MIN_SAVES -> else DB setting -> else 0 (all)
    const envMinSavesRaw = process.env.REFRESH_MIN_SAVES !== undefined && process.env.REFRESH_MIN_SAVES.trim() !== ''
      ? parseInt(process.env.REFRESH_MIN_SAVES, 10)
      : null;
    const settingsRefreshMinSaves = typeof wsSetting?.refresh_min_saves === 'number' ? wsSetting.refresh_min_saves : null;
    const effectiveMinSaves = envMinSavesRaw !== null && !isNaN(envMinSavesRaw)
      ? Math.max(0, envMinSavesRaw)
      : (settingsRefreshMinSaves !== null && !isNaN(settingsRefreshMinSaves) ? Math.max(0, settingsRefreshMinSaves) : 0);
    const savesFilterQuery = effectiveMinSaves > 0 ? `&saves=gte.${effectiveMinSaves}` : '';

    // Two-Phase Hydration: Phase 1 (Lean keyset discovery of pin_ids only — 100x lighter on DB & network)
    const allPinIds = [];
    let pinOffset = 0;
    const PAGE = 1000;
    while (allPinIds.length < effectiveCap) {
      const fetchLimit = Math.min(PAGE, effectiveCap - allPinIds.length);
      const chunk = await supaQuery(
        'pa_pins',
        `select=pin_id&workspace_id=eq.${acc.workspace_id}&account_id=eq.${acc.id}${savesFilterQuery}&order=pin_id.asc&limit=${fetchLimit}&offset=${pinOffset}`
      );
      if (!Array.isArray(chunk) || chunk.length === 0) break;
      for (const c of chunk) {
        if (c.pin_id) allPinIds.push(String(c.pin_id));
      }
      if (chunk.length < fetchLimit) break;
      pinOffset += chunk.length;
    }

    // Strictly deterministic in-memory sort by immutable pin_id before modulo partitioning
    allPinIds.sort((a, b) => a.localeCompare(b));

    // Intra-account pin-level modulo sharding across all runners
    const targetPinIds = allPinIds.filter((_, idx) => idx % SHARD_COUNT === REFRESH_SHARD);

    if (!targetPinIds.length) continue;

    // Two-Phase Hydration: Phase 2 (Targeted hydration — fetch full records ONLY for pins assigned to this shard)
    const pins = [];
    const HYDRATE_CHUNK = 100;
    for (let i = 0; i < targetPinIds.length; i += HYDRATE_CHUNK) {
      const chunkIds = targetPinIds.slice(i, i + HYDRATE_CHUNK);
      const encodedIds = chunkIds.map(encodeURIComponent).join(',');
      const rows = await supaQuery(
        'pa_pins',
        `select=pin_id,saves,repins,comments,share_count,reactions,annotations,seo_category,canonical_pin_id,seo_alt_text,board_pin_count,board_last_modified_at,archived_at,title,description,link,utm_link,domain,board_name,board_id,created_at_pinterest,image_url,dominant_color,image_signature,node_id,is_video,velocity&workspace_id=eq.${acc.workspace_id}&account_id=eq.${acc.id}&pin_id=in.(${encodedIds})`
      );
      if (Array.isArray(rows)) {
        pins.push(...rows);
      }
    }

    if (!pins.length) continue;
    console.log(`${acc.username}: ${pins.length} pins to refresh (min saves: ${effectiveMinSaves > 0 ? effectiveMinSaves : 'all'}, shard ${REFRESH_SHARD + 1}/${SHARD_COUNT} of ${allPinIds.length} total)`);

    let consecutiveErrors = 0;
    let rateLimitCooldownUntil = 0;
    let circuitBroken = false;
    const changedPins = [];
    let accountFollowerCount = null;

    const sem = new Semaphore(CFG.CONCURRENCY);

    // Two-Phase: Phase 1 (Concurrent Fetch & Extract with Promise.allSettled)
    await Promise.allSettled(
      pins.map(async (p) => {
        await sem.acquire();
        try {
          if (circuitBroken) return;

          const pinId = String(p.pin_id);
          let fresh = getPinFromRunnerCache(pinId);

          if (!fresh) {
            // Rate-limit cooldown check
            if (Date.now() < rateLimitCooldownUntil) {
              const waitMs = Math.max(0, rateLimitCooldownUntil - Date.now());
              const jitterMs = Math.floor(Math.random() * 2000);
              console.warn(`[RATE LIMIT] Pausing for ${Math.round(waitMs / 1000)}s cooldown (+${jitterMs}ms jitter) before pin ${p.pin_id}`);
              await sleep(waitMs + jitterMs);
            }

            if (circuitBroken) return;

            // Apply jitter delay before request
            await sleep(randomJitterMs());

            fresh = await fetchPinFromPinterest(pinId);
            if (fresh && fresh.ok) {
              savePinsToRunnerCache({ pin_id: pinId, ...fresh }, undefined, false);
            }
          }

          if (!fresh || !fresh.ok) {
            const isSystemic = fresh?.code === 429 || fresh?.code === 503 || fresh?.error?.includes('timeout') || fresh?.error?.includes('fetch-failed');
            if (fresh?.code === 429) {
              const wasAlreadyInCooldown = Date.now() < rateLimitCooldownUntil;
              rateLimitCooldownUntil = Math.max(rateLimitCooldownUntil, Date.now() + 60000);
              console.warn(`[429 RATE LIMIT] Pin ${pinId} received 429. Setting 60s cooldown.`);
              if (!wasAlreadyInCooldown) {
                consecutiveErrors++;
              }
            } else if (isSystemic) {
              consecutiveErrors++;
            }

            if (consecutiveErrors >= CFG.CIRCUIT_BREAKER) {
              circuitBroken = true;
              summary.errors.push(`circuit-breaker: ${acc.username}`);
              console.error(`[CIRCUIT BREAKER] Hit ${CFG.CIRCUIT_BREAKER} consecutive systemic errors on ${acc.username}. Aborting remaining pin fetches for this account.`);
              return;
            }

            if (fresh?.code === 200 && fresh?.diag) {
              console.warn(`[DIAG] ${pinId}: html=${Math.round(fresh.diag.htmlLen / 1024)}KB relay=${fresh.diag.relay} pws=${fresh.diag.pws} hasPinId=${fresh.diag.hasPinId}`);
            }
            console.warn(`[FAIL] ${pinId}: ${fresh?.error || 'http ' + (fresh?.code ?? 'unknown')} (code=${fresh?.code ?? 0})`);
            summary.errors.push(`${pinId}: ${fresh?.error || 'http ' + (fresh?.code ?? 'unknown')}`);
            return;
          }

          consecutiveErrors = 0;
          summary.refreshed++;

          if (typeof fresh.follower_count === 'number' && fresh.follower_count > 0 && fresh.follower_count !== acc.follower_count && accountFollowerCount === null) {
            accountFollowerCount = fresh.follower_count;
          }

          const oldSaves = Number(p.saves) || 0;
          const oldRepins = Number(p.repins) || 0;

          const existingAnnList = Array.isArray(p.annotations) ? p.annotations : [];
          const freshAnnList = Array.isArray(fresh.annotations) ? fresh.annotations : [];

          const existingAnnotationNames = new Set(
            existingAnnList
              .map(a => (typeof a === 'string' ? a.trim().toLowerCase() : String(a?.name || '').trim().toLowerCase()))
              .filter(Boolean)
          );
          const freshAnnotationNames = new Set(
            freshAnnList
              .map(a => (typeof a === 'string' ? a.trim().toLowerCase() : String(a?.name || '').trim().toLowerCase()))
              .filter(Boolean)
          );

          let annotationsChanged = false;
          if (freshAnnList.length > 0) {
            if (existingAnnotationNames.size !== freshAnnotationNames.size) {
              annotationsChanged = true;
            } else {
              for (const name of freshAnnotationNames) {
                if (!existingAnnotationNames.has(name)) {
                  annotationsChanged = true;
                  break;
                }
              }
              if (!annotationsChanged) {
                // Enrichment parity check: detect if fresh brings idea_id or url that existing lacks
                const existingMap = new Map();
                for (const a of existingAnnList) {
                  const n = (typeof a === 'string' ? a.trim() : String(a?.name || '').trim()).toLowerCase();
                  if (n && !existingMap.has(n)) existingMap.set(n, a);
                }
                for (const f of freshAnnList) {
                  const n = (typeof f === 'string' ? f.trim() : String(f?.name || '').trim()).toLowerCase();
                  const prev = existingMap.get(n);
                  const fIdea = typeof f === 'object' && f ? f.idea_id : null;
                  const fUrl = typeof f === 'object' && f ? f.url : null;
                  const prevIdea = typeof prev === 'object' && prev ? prev.idea_id : null;
                  const prevUrl = typeof prev === 'object' && prev ? prev.url : null;
                  if ((fIdea && !prevIdea) || (fUrl && !prevUrl)) {
                    annotationsChanged = true;
                    break;
                  }
                }
              }
            }
          }

          // X3: ageDays NaN protection
          const createdAt = p.created_at_pinterest || fresh.created_at_pinterest;
          const ms = createdAt ? Date.now() - new Date(createdAt).getTime() : NaN;
          const ageDays = !Number.isFinite(ms) || ms <= 0 ? 1 : Math.max(1, Math.round(ms / (1000 * 60 * 60 * 24)));

          const oldShares = Number(p.share_count) || 0;
          const oldComments = Number(p.comments) || 0;
          const oldReactionsTotal = Number(p.reactions?.total || 0);
          const freshReactionsTotal = typeof fresh.reactions?.total === 'number' ? fresh.reactions.total : null;
          const reactionsAdvanced = freshReactionsTotal !== null && freshReactionsTotal > oldReactionsTotal;

          const enrichmentAdvancement =
            (Boolean(fresh.canonical_pin_id) && fresh.canonical_pin_id !== p.canonical_pin_id) ||
            (Boolean(fresh.seo_category) && fresh.seo_category !== p.seo_category) ||
            (Boolean(fresh.seo_alt_text) && fresh.seo_alt_text !== p.seo_alt_text) ||
            (typeof fresh.board_pin_count === 'number' && fresh.board_pin_count !== p.board_pin_count) ||
            (Boolean(fresh.board_last_modified_at) && fresh.board_last_modified_at !== p.board_last_modified_at) ||
            (Boolean(fresh.image_signature) && fresh.image_signature !== p.image_signature) ||
            (Boolean(fresh.dominant_color) && fresh.dominant_color !== p.dominant_color);

          if (
            fresh.saves !== oldSaves ||
            fresh.repins !== oldRepins ||
            (fresh.share_count !== undefined && fresh.share_count !== oldShares) ||
            (fresh.comments !== undefined && fresh.comments !== oldComments) ||
            reactionsAdvanced ||
            annotationsChanged ||
            enrichmentAdvancement
          ) {
            const changedItem = {
              pin_id: pinId,
              title: fresh.title || p.title || null,
              description: fresh.description || p.description || null,
              link: fresh.link || p.link || null,
              domain: fresh.domain || p.domain || null,
              board_name: fresh.board_name || p.board_name || null,
              created_at_pinterest: p.created_at_pinterest || fresh.created_at_pinterest || null,
              image_url: fresh.image_url || p.image_url || null,
              saves: fresh.saves,
              repins: fresh.repins,
              comments: fresh.comments,
              velocity: Math.round((fresh.saves / ageDays) * 100) / 100,
              archived_at: p.archived_at ?? null,
              refreshed_at: new Date().toISOString(),
            };
            if (fresh.is_video !== undefined) changedItem.is_video = Boolean(fresh.is_video);
            if (fresh.node_id) changedItem.node_id = fresh.node_id;
            if (fresh.board_id) changedItem.board_id = fresh.board_id;
            if (fresh.canonical_pin_id) changedItem.canonical_pin_id = fresh.canonical_pin_id;
            if (fresh.seo_category) changedItem.seo_category = fresh.seo_category;
            if (fresh.seo_alt_text) changedItem.seo_alt_text = fresh.seo_alt_text;
            if (typeof fresh.board_pin_count === 'number') changedItem.board_pin_count = fresh.board_pin_count;
            if (fresh.board_last_modified_at) changedItem.board_last_modified_at = fresh.board_last_modified_at;
            if (fresh.image_signature) changedItem.image_signature = fresh.image_signature;
            if (fresh.dominant_color) changedItem.dominant_color = fresh.dominant_color;
            if (freshReactionsTotal !== null && freshReactionsTotal >= oldReactionsTotal && freshReactionsTotal > 0) {
              changedItem.reactions = fresh.reactions;
            } else if (oldReactionsTotal > 0) {
              changedItem.reactions = p.reactions;
            } else if (fresh.reactions && Object.keys(fresh.reactions).length > 0) {
              changedItem.reactions = fresh.reactions;
            }
            if ((annotationsChanged || freshAnnList.length > 0) && freshAnnList.length > 0) {
              changedItem.annotations = freshAnnList;
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

    // Flush runner cache to disk once per account (eliminating 383+ synchronous disk writes per runner)
    flushRunnerCacheToDisk();

    // Two-Phase: Phase 2 (Sequential Batch Push)
    // All batch pushes pass skipRunLog: true so Ingest API NEVER locks or updates pa_accounts
    if (changedPins.length > 0) {
      console.log(`[PUSH] Pushing ${changedPins.length} changed pins for @${acc.username} in batches of ${CFG.BATCH_SIZE}...`);
      for (let i = 0; i < changedPins.length; i += CFG.BATCH_SIZE) {
        const batch = changedPins.slice(i, i + CFG.BATCH_SIZE);
        const isLastBatch = i + CFG.BATCH_SIZE >= changedPins.length;
        const result = await pushBatch(
          acc.workspace_id,
          acc.username,
          batch,
          accountFollowerCount,
          allPinIds.length,
          acc.id,
          true,
          changedPins.length
        );
        if (result.ok) {
          summary.pushed += result.pushed;
        } else {
          summary.errors.push(`push: ${result.error}`);
          if (result.terminal) break;
        }
        if (!isLastBatch) {
          await sleep(CFG.PUSH_SLEEP_MS);
        }
      }

      // Record this shard's completed telemetry directly in pa_runs
      const nowIso = new Date().toISOString();
      try {
        await supaInsert(PINARCHIVE_SUPABASE_URL, PINARCHIVE_SUPABASE_KEY, 'pa_runs', {
          workspace_id: acc.workspace_id,
          account_id: acc.id,
          trigger: 'refresh',
          started_at: nowIso,
          finished_at: nowIso,
          pages_fetched: 1,
          pins_added: 0,
          pins_updated: changedPins.length,
          pins_promoted: 0,
          status: 'completed',
          message: `refresh shard ${REFRESH_SHARD + 1}/${SHARD_COUNT} (${changedPins.length} updated)`
        });
      } catch (err) {
        console.warn(`[REFRESH] Could not record pa_runs for shard ${REFRESH_SHARD + 1}: ${err.message}`);
      }
    }

    // Leader Shard Authority: ONLY the leader shard updates pa_accounts (zero lock contention)
    const isLeader = (REFRESH_SHARD === 0 || SHARD_COUNT === 1) && !circuitBroken;
    if (isLeader) {
      const nowIso = new Date().toISOString();
      try {
        const patchData = { last_run_at: nowIso };
        if (accountFollowerCount) patchData.follower_count = accountFollowerCount;
        await supaPatch(PINARCHIVE_SUPABASE_URL, PINARCHIVE_SUPABASE_KEY, 'pa_accounts', `workspace_id=eq.${acc.workspace_id}&id=eq.${acc.id}`, patchData);
        if (changedPins.length === 0) {
          await supaInsert(PINARCHIVE_SUPABASE_URL, PINARCHIVE_SUPABASE_KEY, 'pa_runs', {
            workspace_id: acc.workspace_id,
            account_id: acc.id,
            trigger: 'refresh',
            started_at: nowIso,
            finished_at: nowIso,
            pages_fetched: 1,
            pins_added: 0,
            pins_updated: 0,
            pins_promoted: 0,
            status: 'completed',
            message: `refresh shard 1/${SHARD_COUNT} (0 changed)`
          });
          console.log(`[REFRESH] @${acc.username}: 0 changed pins, recorded freshness & run log as leader shard.`);
        }
      } catch (err) {
        console.warn(`[REFRESH] Could not record leader freshness for @${acc.username}: ${err.message}`);
      }
    }

    accountSummaries.push({
      username: acc.username,
      checked: pins.length,
      changed: changedPins.length,
      circuitBroken,
    });
  }

  const cacheStats = getRunnerCacheStats();
  console.log(`\nSummary: checked=${summary.refreshed}, changed=${summary.updated}, pushed=${summary.pushed}, cacheHits=${cacheStats.hits}, errors=${summary.errors.length}`);
  const isFiltered = Boolean(REFRESH_WORKSPACE_ID || REFRESH_USERNAME || REFRESH_USERNAMES.length > 0);
  const hasPushErrors = summary.errors.some(e => e.startsWith('push:'));
  const hasCircuitBreaker = summary.errors.some(e => e.startsWith('circuit-breaker'));
  const systemicErrors = summary.errors.filter(e =>
    e.startsWith('push:') ||
    e.startsWith('circuit-breaker') ||
    e.includes('429') ||
    e.includes('rate-limited') ||
    e.includes('timeout')
  );
  const allSystemicFailed = systemicErrors.length > 0 && summary.refreshed === 0;

  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      const statusIcon = (hasPushErrors || hasCircuitBreaker || allSystemicFailed)
        ? '❌ Failed'
        : (summary.errors.length > 0 ? '⚠️ Has Errors' : '✅ Completed');
      let md = `### 🔄 Refresh Shard ${REFRESH_SHARD + 1}/${SHARD_COUNT} (${statusIcon})\n\n`;
      if (accountSummaries.length > 0) {
        md += `| Account | Pins Scanned | Pins Updated | Status |\n`;
        md += `| :--- | :---: | :---: | :---: |\n`;
        for (const row of accountSummaries) {
          const rowStatus = row.circuitBroken ? '❌ Circuit-broken' : '✅ OK';
          md += `| \`@${row.username}\` | ${row.checked} | **${row.changed}** | ${rowStatus} |\n`;
        }
        md += `\n`;
      }
      md += `**Total:** ${summary.refreshed} pin(s) checked, **${summary.updated}** changed, **${summary.pushed}** pushed to Ingest.\n\n`;
      if (cacheStats.hits > 0) {
        md += `⚡ **Runner Cache Acceleration:** ${cacheStats.hits} pin(s) served instantly from local runner cache (saved ${cacheStats.hits} network requests).\n\n`;
      }
      if (summary.errors.length > 0) {
        md += `<details><summary>⚠️ View Errors (${summary.errors.length})</summary>\n\n- ${summary.errors.join('\n- ')}\n\n</details>\n\n`;
      }
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md, 'utf-8');
    } catch (e) {
      console.warn('Could not write to GITHUB_STEP_SUMMARY:', e.message);
    }
  }

  if (hasPushErrors || hasCircuitBreaker || allSystemicFailed) {
    process.exit(1);
  }

  if (isFiltered) {
    // Filtered run: success if anything was pushed/updated, regardless of per-pin extraction misses
    if (summary.pushed > 0 || summary.updated > 0) process.exit(0);
    // No change but also no systemic failure (e.g. capped rotation) → still 0
    if (systemicErrors.length === 0) process.exit(0);
    // All pins in the filtered scope failed systemically → keep red signal
    process.exit(1);
  }

  // Systemic threshold: fail only if systemic errors exceed successfully refreshed pins and nothing was refreshed
  if (systemicErrors.length > summary.refreshed && summary.refreshed === 0) {
    process.exit(1);
  }

  process.exit(0);
}

export { extractPinData, formatPin, findPinInTree, fetchPinFromPinterest, pushBatch, Semaphore };

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
