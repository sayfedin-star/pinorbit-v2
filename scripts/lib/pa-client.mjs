/**
 * scripts/lib/pa-client.mjs
 *
 * Pure shared client library for PinArchive background scripts and automation.
 * Encapsulates Supabase PostgREST queries, Ingest API dispatch, and Google Apps Script bridge calls.
 *
 * Rule: Pure utility module only — no top-level side effects or script execution.
 */

import crypto from 'node:crypto';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Execute a GET query against Supabase PostgREST with timeout protection.
 */
export async function supaQuery(baseUrl, apiKey, table, params = '', options = {}) {
  const url = `${baseUrl.replace(/\/+$/, '')}/rest/v1/${table}${params ? '?' + params : ''}`;
  const signal = options.signal || AbortSignal.timeout(options.timeoutMs || 15000);

  const res = await fetch(url, {
    headers: {
      apikey: apiKey,
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      ...(options.headers || {}),
    },
    signal,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Supabase ${table} failed (HTTP ${res.status}): ${txt}`);
  }

  return res.json();
}

/**
 * Execute a PATCH query against Supabase PostgREST with timeout protection.
 */
export async function supaPatch(baseUrl, apiKey, table, matchParams, body, options = {}) {
  const url = `${baseUrl.replace(/\/+$/, '')}/rest/v1/${table}?${matchParams}`;
  const signal = options.signal || AbortSignal.timeout(options.timeoutMs || 15000);

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      apikey: apiKey,
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=minimal',
      ...(options.headers || {}),
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Supabase PATCH ${table} failed (HTTP ${res.status}): ${txt}`);
  }

  return options.prefer?.includes('return=representation') ? res.json() : true;
}

/**
 * Execute a POST / INSERT query against Supabase PostgREST with timeout protection.
 */
export async function supaInsert(baseUrl, apiKey, table, body, options = {}) {
  const url = `${baseUrl.replace(/\/+$/, '')}/rest/v1/${table}`;
  const signal = options.signal || AbortSignal.timeout(options.timeoutMs || 15000);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: apiKey,
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=minimal',
      ...(options.headers || {}),
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Supabase POST ${table} failed (HTTP ${res.status}): ${txt}`);
  }

  return options.prefer?.includes('return=representation') ? res.json() : true;
}

/**
 * Unified Ingest API Push Helper.
 * Supports both discovery (run_type: 'backfill' | 'audit_sweep') and refresh (run_type: 'refresh') payload shapes.
 */
export async function pushToIngest({
  workerUrl,
  ingestSecret,
  workspaceId,
  username,
  pins,
  runType = 'backfill',
  trigger = null,
  followerCount = undefined,
  accountMeta = undefined,
  totalPins = undefined,
  signal = undefined,
  accountId = undefined,
  skipRunLog = undefined,
  pinsUpdated = undefined,
  pinsAdded = undefined,
}) {
  if (!Array.isArray(pins) || pins.length === 0) {
    return { ok: true, pushed: 0 };
  }

  const effectiveTrigger = trigger || runType;
  const effectiveMeta = accountMeta || {
    pins_count: Number.isFinite(totalPins) ? totalPins : pins.length,
    last_result: runType,
  };

  const body = {
    run_id: crypto.randomUUID(),
    workspace_id: workspaceId,
    username,
    fetched_at: new Date().toISOString(),
    run_type: runType,
    trigger: effectiveTrigger,
    follower_count: typeof followerCount === 'number' ? followerCount : undefined,
    account_meta: effectiveMeta,
    pins,
    ...(accountId ? { account_id: accountId } : {}),
    ...(skipRunLog !== undefined ? { skip_run_log: skipRunLog } : {}),
    ...(typeof pinsUpdated === 'number' ? { pins_updated: pinsUpdated } : {}),
    ...(typeof pinsAdded === 'number' ? { pins_added: pinsAdded } : {}),
  };

  const effectiveSignal = signal || AbortSignal.timeout(20000);
  const endpoint = `${workerUrl.replace(/\/+$/, '')}/api/internal/pinarchive/ingest`;

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': ingestSecret,
      },
      body: JSON.stringify(body),
      signal: effectiveSignal,
    });
  } catch (err) {
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      ok: false,
      code: 0,
      terminal: false,
      error: isTimeout ? 'ingest-timeout-20s' : (err?.message || 'ingest-fetch-failed'),
    };
  }

  let error = '';
  let json = null;
  try {
    json = await res.json();
    error = json?.error || '';
  } catch (_) {
    try {
      error = await res.text();
    } catch (_) {}
  }

  if (res.status >= 200 && res.status < 300) {
    if (json && json.skipped) {
      return { ok: false, skipped: json.skipped, terminal: false, error: String(json.skipped) };
    }
    return { ok: true, pushed: pins.length };
  }

  if (res.status === 409) {
    if (error === 'ingest_disabled') {
      return { ok: false, code: 409, terminal: true, error: 'ingest_disabled (terminal)' };
    }
    if (error.indexOf('account_') === 0 || (json && json.skipped)) {
      const skippedReason = (json && json.skipped) || error;
      return { ok: false, code: 409, terminal: false, skipped: skippedReason, error: `${skippedReason} (account skipped)` };
    }
  }

  return { ok: false, code: res.status, error: error || `http ${res.status}` };
}

/**
 * Google Apps Script Sheet Writer with exponential backoff and diagnostics.
 */
export async function writeToGas(gasUrl, secret, payload, maxRetries = 3) {
  if (!gasUrl || gasUrl.trim() === '') {
    console.log('ℹ️ sheet_write skipped: GAS URL not configured');
    return { ok: true, skipped: true };
  }
  const rowsCount = Array.isArray(payload?.rows) ? payload.rows.length : 0;
  const username = String(payload?.username || '');

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const startedAt = Date.now();
    try {
      const res = await fetch(gasUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-ingest-secret': secret },
        body: JSON.stringify({ ...payload, action: 'sheet_write', secret }),
        signal: AbortSignal.timeout(60000),
        redirect: 'follow',
      });
      const elapsedMs = Date.now() - startedAt;
      const contentType = res.headers.get('content-type') || '';
      const bodyText = await res.text().catch(() => '');

      // Tier-0 diagnostics: exactly the 5 approved fields; never the secret, never full rows
      console.log(`🩺 [GAS Write] @${username} attempt ${attempt + 1}/${maxRetries + 1}: status=${res.status} ct=${contentType || 'none'} elapsed=${elapsedMs}ms rows=${rowsCount}`);

      // (1) Check for transient HTTP responses including Google proxy/HTML 404
      const isHtmlResponse = contentType.includes('text/html') || bodyText.includes('<!DOCTYPE html>') || bodyText.includes('ppConfig');
      const isTransientHttp = res.status >= 500 || res.status === 429 || (res.status === 404 && isHtmlResponse);

      if (!res.ok) {
        const typed = `GAS_HTTP_${res.status}: ${bodyText.slice(0, 300).replace(/\s+/g, ' ')}`;
        if (isTransientHttp && attempt < maxRetries) {
          const backoffMs = Math.floor(3000 * Math.pow(2, attempt) + Math.random() * 2000);
          console.warn(`⚠️ [GAS Write] Transient HTTP ${res.status} on attempt ${attempt + 1}/${maxRetries + 1}, retrying in ${backoffMs}ms...`);
          await sleep(backoffMs);
          continue;
        }
        return { ok: false, error: typed };
      }

      let data = null;
      try { data = JSON.parse(bodyText); } catch { data = null; }

      // (2) Non-JSON / empty body check (for 2xx responses with non-JSON content)
      if (data === null || typeof data !== 'object') {
        const typed = `GAS_NON_JSON(status=${res.status},ct=${contentType || 'none'}): ${bodyText.slice(0, 300).replace(/\s+/g, ' ')}`;
        const transient = res.ok || res.status >= 500 || res.status === 429 || isHtmlResponse;
        if (transient && attempt < maxRetries) {
          const backoffMs = Math.floor(3000 * Math.pow(2, attempt) + Math.random() * 2000);
          console.warn(`⚠️ [GAS Write] Non-JSON response on attempt ${attempt + 1}/${maxRetries + 1}, retrying in ${backoffMs}ms...`);
          await sleep(backoffMs);
          continue;
        }
        return { ok: false, error: typed };
      }

      // (3) Lock conflict check
      if (data.ok === false && data.error === 'locked') {
        if (attempt < maxRetries) {
          const backoffMs = Math.floor(3000 * Math.pow(2, attempt) + Math.random() * 2000);
          console.warn(`⚠️ [GAS Write] Lock conflict detected on attempt ${attempt + 1}/${maxRetries + 1}, retrying in ${backoffMs}ms...`);
          await sleep(backoffMs);
          continue;
        }
        return { ok: false, error: 'locked' };
      }

      // (4) Success telemetry
      if (data.ok) {
        console.log(`✅ [GAS Write] @${username}: written=${typeof data.written === 'number' ? data.written : (Number(data.appended) || 0) + (Number(data.updated) || 0)} (app=${data.appended ?? '-'}, upd=${data.updated ?? '-'}, unch=${data.unchanged ?? '-'}) in ${elapsedMs}ms`);
      }
      return data;
    } catch (err) {
      const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      const typed = isTimeout
        ? `GAS_TIMEOUT_60S(elapsed=${Date.now() - startedAt}ms): ${err.message}`
        : (err?.message || 'Unknown GAS write error');
      if (attempt < maxRetries) {
        const backoffMs = Math.floor(3000 * Math.pow(2, attempt) + Math.random() * 2000);
        console.warn(`⚠️ [GAS Write] Error on attempt ${attempt + 1}/${maxRetries + 1}: ${err.message}, retrying in ${backoffMs}ms...`);
        await sleep(backoffMs);
        continue;
      }
      console.warn(`❌ [GAS Write] Failed after ${maxRetries + 1} attempts: ${err.message}`);
      return { ok: false, error: typed };
    }
  }
  return { ok: false, error: 'gas_write_exhausted' };
}

/**
 * Query Google Apps Script `account_ages` action for a chunk of creator usernames.
 */
export async function callGasAccountAges(gasUrl, secret, workspaceId, usernames) {
  const body = {
    v: 1,
    cmd_id: crypto.randomUUID(),
    secret,
    action: 'account_ages',
    workspace_id: workspaceId,
    payload: {
      usernames,
    },
  };

  const res = await fetch(gasUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'follow',
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`GAS HTTP ${res.status}: ${txt}`);
  }

  const data = await res.json();
  if (!data || data.ok === false) {
    throw new Error(`GAS error: ${data?.error || 'Unknown GAS error'}`);
  }

  return data.ages || {};
}

/**
 * Determine monotonic oldest pin timestamp (LEAST):
 * Updates only when candidate is strictly older than existing baseline (or baseline is null).
 * Preserves existing baseline if candidate is newer, identical, or invalid.
 */
export function resolveMonotonicOldestPin(baselineIso, candidateIso) {
  if (!candidateIso || typeof candidateIso !== 'string') {
    return baselineIso || null;
  }

  const candidateMs = Date.parse(candidateIso);
  if (!Number.isFinite(candidateMs)) {
    return baselineIso || null;
  }

  if (!baselineIso || typeof baselineIso !== 'string') {
    return new Date(candidateMs).toISOString();
  }

  const baselineMs = Date.parse(baselineIso);
  if (!Number.isFinite(baselineMs)) {
    return new Date(candidateMs).toISOString();
  }

  // Strictly monotonic: candidate must be strictly older (earlier in time) than baseline
  if (candidateMs < baselineMs) {
    return new Date(candidateMs).toISOString();
  }

  return baselineIso;
}

/**
 * Keyset cursor pagination over pa_accounts.
 * Carries --workspace and --username filters across every page.
 */
export async function fetchAllAccounts(supaQueryFn, filters = {}, pageSize = 1000) {
  const allAccounts = [];
  let lastId = null;
  const selectClause = filters.select
    ? (filters.select.split(',').map(s => s.trim()).includes('id') ? filters.select : `id,${filters.select}`)
    : 'id,workspace_id,username,oldest_pin_at,pins_count';

  while (true) {
    let params = `select=${selectClause}&order=id.asc&limit=${pageSize}`;
    if (filters.workspace) {
      params += `&workspace_id=eq.${encodeURIComponent(filters.workspace)}`;
    }
    if (filters.username) {
      params += `&username=eq.${encodeURIComponent(filters.username.toLowerCase().replace(/^@/, ''))}`;
    }
    if (lastId) {
      params += `&id=gt.${encodeURIComponent(lastId)}`;
    }

    const batch = await supaQueryFn('pa_accounts', params);
    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }
    allAccounts.push(...batch);
    if (batch.length < pageSize) {
      break;
    }
    const nextLastId = batch[batch.length - 1]?.id;
    if (!nextLastId || nextLastId === lastId) {
      break;
    }
    lastId = nextLastId;
  }

  return allAccounts;
}

/**
 * Deterministic Greedy Bin-Packing (Longest Processing Time First) for matrix runner sharding.
 *
 * Balances workload across shard runners based on account weights (pins_count).
 * - Defensively extracts weight: Number.isFinite(p) && p > 0 ? p : 0
 * - Deterministic comparator: pins_count DESC, tie-breaker id.localeCompare
 * - Assigns active accounts to the shard with minimal accumulated pins
 * - Distributes inactive accounts evenly by fewest accounts count
 * - Returns accounts for targetShard (safe for targetShard out-of-range or active.length < shardCount)
 *
 * @param {any[]} accounts - List of accounts fetched from database
 * @param {number} shardCount - Number of shards (runners) in matrix
 * @param {number} targetShard - Shard index to return (0-based)
 * @returns {any[]} Accounts assigned to targetShard
 */
export function partitionAccountsLPT(accounts, shardCount = 1, targetShard = 0) {
  if (!Array.isArray(accounts) || accounts.length === 0) return [];
  const count = Math.max(1, parseInt(shardCount, 10) || 1);
  const target = Math.max(0, Math.min(count - 1, parseInt(targetShard, 10) || 0));

  if (count === 1) return [...accounts];

  const getWeight = (acc) => {
    const p = acc?.pins_count;
    if (typeof p === 'number' && Number.isFinite(p) && p > 0) return p;
    if (typeof p === 'string' && p.trim() !== '') {
      const parsed = parseInt(p.trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return 0;
  };

  const active = [];
  const inactive = [];

  for (const acc of accounts) {
    if (!acc || typeof acc !== 'object') continue;
    const isPaused = ['paused', 'cookie_expired', 'error'].includes(acc.status);
    const isIngestDisabled = acc.ingest_enabled === false;
    if (isPaused || isIngestDisabled) {
      inactive.push(acc);
    } else {
      active.push(acc);
    }
  }

  // Deterministic LPT sort: pins_count DESC, then id ASC for tie-breaking
  active.sort((a, b) => {
    const diff = getWeight(b) - getWeight(a);
    if (diff !== 0) return diff;
    return String(a?.id || '').localeCompare(String(b?.id || ''));
  });

  const shards = Array.from({ length: count }, (_, i) => ({
    shardId: i,
    accounts: [],
    totalPins: 0,
  }));

  // Assign active accounts to shard with minimal totalPins
  for (const acc of active) {
    let minShard = shards[0];
    for (let i = 1; i < count; i++) {
      if (shards[i].totalPins < minShard.totalPins) {
        minShard = shards[i];
      } else if (
        shards[i].totalPins === minShard.totalPins &&
        shards[i].accounts.length < minShard.accounts.length
      ) {
        minShard = shards[i];
      }
    }
    minShard.accounts.push(acc);
    minShard.totalPins += getWeight(acc);
  }

  // Distribute inactive accounts round-robin by shard with fewest total accounts
  inactive.sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
  for (const acc of inactive) {
    let minShard = shards[0];
    for (let i = 1; i < count; i++) {
      if (shards[i].accounts.length < minShard.accounts.length) {
        minShard = shards[i];
      }
    }
    minShard.accounts.push(acc);
  }

  return shards[target].accounts;
}

