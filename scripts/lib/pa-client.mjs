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
        signal: AbortSignal.timeout(30000),
        redirect: 'follow',
      });
      const elapsedMs = Date.now() - startedAt;
      const contentType = res.headers.get('content-type') || '';
      const bodyText = await res.text().catch(() => '');

      // Tier-0 diagnostics: exactly the 5 approved fields; never the secret, never full rows
      console.log(`🩺 [GAS Write] @${username} attempt ${attempt + 1}/${maxRetries + 1}: status=${res.status} ct=${contentType || 'none'} elapsed=${elapsedMs}ms rows=${rowsCount}`);

      // (1) HTTP error: evaluated FIRST
      if (!res.ok) {
        const typed = `GAS_HTTP_${res.status}: ${bodyText.slice(0, 300).replace(/\s+/g, ' ')}`;
        if ((res.status >= 500 || res.status === 429) && attempt < maxRetries) {
          await sleep(Math.floor(2000 * Math.pow(1.8, attempt) + Math.random() * 1000));
          continue;
        }
        return { ok: false, error: typed };
      }

      let data = null;
      try { data = JSON.parse(bodyText); } catch { data = null; }

      // (2) Non-JSON / empty body check (for 2xx responses with non-JSON content)
      if (data === null || typeof data !== 'object') {
        const typed = `GAS_NON_JSON(status=${res.status},ct=${contentType || 'none'}): ${bodyText.slice(0, 300).replace(/\s+/g, ' ')}`;
        const transient = res.ok || res.status >= 500 || res.status === 429;
        if (transient && attempt < maxRetries) {
          await sleep(Math.floor(2000 * Math.pow(1.8, attempt) + Math.random() * 1000));
          continue;
        }
        return { ok: false, error: typed };
      }

      // (3) Lock conflict check
      if (data.ok === false && data.error === 'locked') {
        if (attempt < maxRetries) {
          console.warn(`⚠️ [GAS Write] Lock conflict detected on attempt ${attempt + 1}/${maxRetries + 1}, retrying...`);
          await sleep(Math.floor(2000 * Math.pow(1.8, attempt) + Math.random() * 1000));
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
        ? `GAS_TIMEOUT_30S(elapsed=${Date.now() - startedAt}ms): ${err.message}`
        : (err?.message || 'Unknown GAS write error');
      if (attempt < maxRetries) {
        console.warn(`⚠️ [GAS Write] Error on attempt ${attempt + 1}/${maxRetries + 1}: ${err.message}, retrying...`);
        await sleep(Math.floor(2000 * Math.pow(1.8, attempt) + Math.random() * 1000));
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
    signal: AbortSignal.timeout(30000),
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
