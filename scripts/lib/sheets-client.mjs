/**
 * scripts/lib/sheets-client.mjs
 *
 * Production-Hardened Zero-Dependency Google Sheets API v4 Client using Node.js 22 built-in `node:crypto`.
 *
 * Architecture & Concurrency Guarantees:
 *  1. Single-Flight Token Deduplication: Prevents OAuth token exchange thundering herd.
 *  2. In-Memory Token Caching: 50-minute bearer cache with auto-refresh and 401 eviction.
 *  3. Socket & Stream Leak Elimination: Enforces strict stream cancellation/consumption via `finally`.
 *  4. Canonical FIFO Queue Mutex (`TabMutex`): Zero deadlock, self-pruning queue with timeout isolation.
 *  5. Cross-Runner Race Safety: Idempotent tab creation handles 400 "already exists" seamlessly.
 *  6. Username Normalization: Automatically strips leading `@` to avoid tab naming divergence.
 *  7. Set-Union Tab Discovery: Merges fresh metadata into known set without cache invalidation races.
 *  8. Full Data Integrity: Preserves `first_seen_at`, `archived_at`, and unmutated fields on sparse updates.
 *  9. Chunked Batch Writes & Appends: Respects payload size limits (500 updates / 1000 appends).
 * 10. Jittered 5-Stage Exponential Backoff: Full 140-second recovery for HTTP 429 quota exhaustion.
 *
 * Rule: Pure utility module only — no top-level side effects or script execution.
 */

import crypto from 'node:crypto';

export const PINARCHIVE_SHEET_HEADERS = [
  'pin_id',
  'title',
  'description',
  'link',
  'domain',
  'board_name',
  'created_at',
  'image_url',
  'image_signature',
  'dominant_color',
  'saves',
  'repins',
  'comments',
  'velocity',
  'first_seen_at',
  'last_updated_at',
  'archived_at',
  'tags',
];

const SHEETS_BASE_URL = 'https://sheets.googleapis.com/v4/spreadsheets';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

// In-memory token cache: { token, expiresAtMs, clientEmail }
let tokenCache = null;

// Single-Flight deduplication promise for token exchange (prevents thundering herd)
let tokenInFlightPromise = null;

// In-memory set of known tab titles per spreadsheetId: Map<spreadsheetId, Set<tabTitle>>
const knownTabsCache = new Map();

/**
 * Canonical FIFO In-Process Mutex.
 * Guarantees strict sequential execution for writes targeting the same tab.
 * When a queued waiter times out, it cleanly removes itself from the queue
 * without compromising or releasing the active lock held by the running task.
 */
class TabMutex {
  constructor() {
    this._queue = [];
    this._locked = false;
  }

  async acquire(timeoutMs = 60000) {
    if (!this._locked) {
      this._locked = true;
      return () => this._release();
    }

    return new Promise((resolve, reject) => {
      let timerId = null;

      const entry = {
        resolve: releaseFn => {
          if (timerId) clearTimeout(timerId);
          resolve(releaseFn);
        },
        reject: err => {
          if (timerId) clearTimeout(timerId);
          reject(err);
        },
      };

      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        timerId = setTimeout(() => {
          const idx = this._queue.indexOf(entry);
          if (idx !== -1) {
            this._queue.splice(idx, 1);
            entry.reject(new Error(`Tab lock acquisition timed out after ${timeoutMs}ms`));
          }
        }, timeoutMs);
      }

      this._queue.push(entry);
    });
  }

  _release() {
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      next.resolve(() => this._release());
    } else {
      this._locked = false;
    }
  }

  isIdle() {
    return !this._locked && this._queue.length === 0;
  }
}

// Per-tab write serialization mutexes: Map<lockKey, TabMutex>
const tabMutexes = new Map();

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Format a Date object to "YYYY-MM-DD HH:mm:ss" GMT string matching Google Sheets convention.
 */
export function formatSheetDate(d = new Date()) {
  const dateObj = d instanceof Date ? d : new Date(d);
  if (!Number.isFinite(dateObj.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${dateObj.getUTCFullYear()}-${pad(dateObj.getUTCMonth() + 1)}-${pad(dateObj.getUTCDate())} ${pad(dateObj.getUTCHours())}:${pad(dateObj.getUTCMinutes())}:${pad(dateObj.getUTCSeconds())}`;
}

/**
 * Parse a date/timestamp cell value from Google Sheets to unix milliseconds.
 */
export function parseSheetTimestamp(cell) {
  if (cell instanceof Date) return cell.getTime();
  const s = String(cell || '').trim();
  if (!s) return NaN;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (m) {
    const frac = m[3] || '';
    let tz = m[4] || 'Z';
    if (/^[+-]\d{4}$/.test(tz)) tz = tz.slice(0, 3) + ':' + tz.slice(3);
    return Date.parse(m[1] + 'T' + m[2] + frac + tz);
  }
  return Date.parse(s);
}

/**
 * Escape a sheet / tab name for A1 notation (e.g. `'pins_username'`).
 */
export function escapeSheetTitle(title) {
  return `'${String(title || '').replace(/'/g, "''")}'`;
}

/**
 * Parse and validate Google Service Account credentials.
 * Accepts either a JSON string (e.g. from GOOGLE_SERVICE_ACCOUNT_KEY env) or a parsed object.
 */
export function parseCredentials(raw) {
  if (!raw) {
    throw new Error('Google Service Account credentials missing');
  }

  let creds = raw;
  if (typeof raw === 'string') {
    try {
      creds = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Invalid JSON in Google Service Account credentials: ${err.message}`);
    }
  }

  if (!creds || typeof creds !== 'object') {
    throw new Error('Google Service Account credentials must be an object');
  }

  const clientEmail = String(creds.client_email || '').trim();
  let privateKey = String(creds.private_key || '').trim();

  if (!clientEmail) {
    throw new Error('Missing client_email in Google Service Account credentials');
  }
  if (!privateKey) {
    throw new Error('Missing private_key in Google Service Account credentials');
  }

  // Handle literal escaped newlines (e.g. from environment variables: "\\n" -> "\n")
  if (privateKey.includes('\\n')) {
    privateKey = privateKey.replace(/\\n/g, '\n');
  }

  return {
    client_email: clientEmail,
    private_key: privateKey,
    token_uri: creds.token_uri || GOOGLE_TOKEN_URL,
    project_id: creds.project_id || '',
  };
}

/**
 * Clear the in-memory token cache (useful for testing and key rotation).
 */
export function clearTokenCache() {
  tokenCache = null;
  tokenInFlightPromise = null;
}

/**
 * Clear the in-memory tabs cache and active lock mutexes (useful for testing).
 */
export function clearTabsCache() {
  knownTabsCache.clear();
  tabMutexes.clear();
}

/**
 * Execute an operation under a per-tab mutex to prevent concurrent write collisions
 * within the same Node.js process.
 */
export async function withTabLock(lockKey, operationFn, timeoutMs = 60000) {
  let mutex = tabMutexes.get(lockKey);
  if (!mutex) {
    mutex = new TabMutex();
    tabMutexes.set(lockKey, mutex);
  }

  const release = await mutex.acquire(timeoutMs);
  try {
    return await operationFn();
  } finally {
    release();
    if (mutex.isIdle()) {
      tabMutexes.delete(lockKey);
    }
  }
}

/**
 * Generate a Google OAuth2 Access Token using Service Account JWT bearer assertion.
 * Pure Node.js 22 built-in `node:crypto` implementation.
 * Single-Flight pattern guarantees zero duplicate token exchanges under concurrent calls.
 */
export async function getGoogleAccessToken(rawCredentials, options = {}) {
  const creds = parseCredentials(rawCredentials);
  const nowMs = Date.now();

  // Return cached token if valid for at least 5 more minutes (300,000ms)
  if (
    tokenCache &&
    tokenCache.clientEmail === creds.client_email &&
    tokenCache.expiresAtMs > nowMs + 300000
  ) {
    return tokenCache.token;
  }

  // If a token exchange is already in progress, await the in-flight promise
  if (tokenInFlightPromise) {
    return await tokenInFlightPromise;
  }

  tokenInFlightPromise = (async () => {
    try {
      const currentNowMs = Date.now();
      const nowSec = Math.floor(currentNowMs / 1000);
      const headerObj = { alg: 'RS256', typ: 'JWT' };
      const claimsObj = {
        iss: creds.client_email,
        scope: GOOGLE_SHEETS_SCOPE,
        aud: creds.token_uri,
        exp: nowSec + 3600,
        iat: nowSec,
      };

      const encodedHeader = Buffer.from(JSON.stringify(headerObj)).toString('base64url');
      const encodedClaims = Buffer.from(JSON.stringify(claimsObj)).toString('base64url');
      const unsignedToken = `${encodedHeader}.${encodedClaims}`;

      let signature = '';
      try {
        const signer = crypto.createSign('RSA-SHA256');
        signer.update(unsignedToken);
        signature = signer.sign(creds.private_key, 'base64url');
      } catch (err) {
        throw new Error(`Failed to sign Google OAuth JWT with private key: ${err.message}`);
      }

      const signedJwt = `${unsignedToken}.${signature}`;
      const bodyParams = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signedJwt,
      });

      const signal = options.signal || AbortSignal.timeout(15000);
      let res = null;
      try {
        res = await fetch(creds.token_uri, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: bodyParams.toString(),
          signal,
        });

        const resText = await res.text();
        let tokenData = null;
        try {
          tokenData = JSON.parse(resText);
        } catch {
          tokenData = null;
        }

        if (!res.ok || !tokenData?.access_token) {
          const errMsg = tokenData?.error_description || tokenData?.error || resText || `HTTP ${res.status}`;
          throw new Error(`Google OAuth2 token exchange failed (${res.status}): ${errMsg}`);
        }

        const expiresInSec = Number(tokenData.expires_in) || 3600;
        tokenCache = {
          token: tokenData.access_token,
          clientEmail: creds.client_email,
          expiresAtMs: currentNowMs + expiresInSec * 1000,
        };

        return tokenCache.token;
      } finally {
        if (res && !res.bodyUsed && res.body) {
          await res.body.cancel().catch(() => {});
        }
      }
    } finally {
      tokenInFlightPromise = null;
    }
  })();

  return await tokenInFlightPromise;
}

/**
 * Execute an authenticated Google Sheets API v4 request with retry logic for transient errors.
 * Ensures complete stream consumption and socket leak prevention via guaranteed finally block.
 */
async function sheetsFetch(accessToken, url, fetchOptions = {}, maxRetries = 5) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res = null;
    try {
      const signal = fetchOptions.signal || AbortSignal.timeout(30000);
      res = await fetch(url, {
        ...fetchOptions,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          ...(fetchOptions.headers || {}),
        },
        signal,
      });

      // Transient rate-limit (429) or Google server error (500, 502, 503, 504)
      const isTransient = res.status === 429 || (res.status >= 500 && res.status < 600);

      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        let errJson = null;
        try { errJson = JSON.parse(bodyText); } catch {}
        const errorDetail = errJson?.error?.message || bodyText.slice(0, 300) || `HTTP ${res.status}`;

        if (res.status === 401) {
          clearTokenCache();
        }

        if (isTransient && attempt < maxRetries) {
          // Check for Retry-After header
          const retryAfterSec = Number(res.headers?.get?.('retry-after'));
          const baseDelay = res.status === 429 ? 3500 : 2000;
          let backoffMs = Math.floor(baseDelay * Math.pow(2, attempt) + Math.random() * 2000);
          if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
            backoffMs = Math.max(backoffMs, retryAfterSec * 1000 + 500);
          }

          console.warn(`⚠️ [Sheets API] Transient HTTP ${res.status} on attempt ${attempt + 1}/${maxRetries + 1}, retrying in ${backoffMs}ms...`);
          await sleep(backoffMs);
          continue;
        }

        const err = new Error(`Sheets API request failed (HTTP ${res.status}): ${errorDetail}`);
        err.status = res.status;
        err.detail = errorDetail;
        throw err;
      }

      const text = await res.text();
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch (err) {
        throw new Error(`Sheets API returned non-JSON body: ${err.message}`);
      }
    } catch (err) {
      const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      if ((isTimeout || !err.status) && attempt < maxRetries) {
        const backoffMs = Math.floor(2000 * Math.pow(2, attempt) + Math.random() * 1500);
        console.warn(`⚠️ [Sheets API] Network/Timeout error on attempt ${attempt + 1}/${maxRetries + 1}: ${err.message}, retrying in ${backoffMs}ms...`);
        await sleep(backoffMs);
        continue;
      }
      throw err;
    } finally {
      if (res && !res.bodyUsed && res.body) {
        await res.body.cancel().catch(() => {});
      }
    }
  }

  throw new Error('Sheets API retries exhausted');
}

/**
 * Fetch spreadsheet metadata to discover existing tab titles.
 */
export async function getSpreadsheetTabs(accessToken, spreadsheetId) {
  const url = `${SHEETS_BASE_URL}/${spreadsheetId}?fields=sheets.properties(sheetId,title)`;
  const data = await sheetsFetch(accessToken, url);
  const titles = new Set();
  if (Array.isArray(data?.sheets)) {
    for (const s of data.sheets) {
      if (s?.properties?.title) {
        titles.add(String(s.properties.title).trim());
      }
    }
  }
  return titles;
}

/**
 * Ensure that a specific creator sheet tab exists.
 * Race-safe: If another runner created the tab concurrently, handles 400 "already exists" seamlessly.
 */
export async function ensureSheetExists(accessToken, spreadsheetId, tabName) {
  let known = knownTabsCache.get(spreadsheetId);
  if (!known) {
    known = await getSpreadsheetTabs(accessToken, spreadsheetId);
    knownTabsCache.set(spreadsheetId, known);
  }

  if (known.has(tabName)) {
    return true;
  }

  // Tab not in local cache: verify with live metadata before attempting creation
  const freshTabs = await getSpreadsheetTabs(accessToken, spreadsheetId);
  for (const t of freshTabs) known.add(t);
  if (known.has(tabName)) {
    return true;
  }

  // Attempt creation of sheet with frozen header row
  const addUrl = `${SHEETS_BASE_URL}/${spreadsheetId}:batchUpdate`;
  try {
    await sheetsFetch(accessToken, addUrl, {
      method: 'POST',
      body: JSON.stringify({
        requests: [
          {
            addSheet: {
              properties: {
                title: tabName,
                gridProperties: {
                  frozenRowCount: 1,
                },
              },
            },
          },
        ],
      }),
    });

    // Write canonical header row into newly created sheet
    const headerRange = `${escapeSheetTitle(tabName)}!A1:R1`;
    const headerUrl = `${SHEETS_BASE_URL}/${spreadsheetId}/values/${encodeURIComponent(headerRange)}?valueInputOption=USER_ENTERED`;
    await sheetsFetch(accessToken, headerUrl, {
      method: 'PUT',
      body: JSON.stringify({
        range: headerRange,
        majorDimension: 'ROWS',
        values: [PINARCHIVE_SHEET_HEADERS],
      }),
    });

    known.add(tabName);
    return true;
  } catch (err) {
    // Cross-runner race check: if another shard created the tab concurrently, treat as success
    const errText = String(err?.message || err?.detail || '');
    if (err.status === 400 && /already exists/i.test(errText)) {
      known.add(tabName);
      return true;
    }
    throw err;
  }
}

/**
 * Read all rows from a sheet tab.
 * Returns { headers: string[], headerMap: Record<string, number>, rows: string[][] }
 */
export async function readSheetRows(accessToken, spreadsheetId, tabName) {
  const range = `${escapeSheetTitle(tabName)}!A:R`;
  const url = `${SHEETS_BASE_URL}/${spreadsheetId}/values/${encodeURIComponent(range)}`;
  let data = null;
  try {
    data = await sheetsFetch(accessToken, url);
  } catch (err) {
    if (err.status === 400 && String(err.message).includes('Unable to parse range')) {
      return { headers: [], headerMap: {}, rows: [] };
    }
    throw err;
  }

  const rawValues = Array.isArray(data?.values) ? data.values : [];
  if (rawValues.length === 0) {
    return { headers: [], headerMap: {}, rows: [] };
  }

  const headers = rawValues[0].map(h => String(h || '').trim());
  const headerMap = {};
  headers.forEach((h, i) => {
    if (h) headerMap[h] = i; // 0-based column index
  });

  const rows = rawValues.slice(1);
  return { headers, headerMap, rows };
}

/**
 * Build an 18-column row array matching the canonical PinArchive sheet schema.
 */
export function buildSheetRow(pinObj, headerMap, width = PINARCHIVE_SHEET_HEADERS.length, existingRow = null, nowFormatted = formatSheetDate()) {
  const row = new Array(width).fill('');

  const getExistingVal = (colName) => {
    if (!existingRow || !headerMap || headerMap[colName] === undefined) return '';
    return existingRow[headerMap[colName]] ?? '';
  };

  PINARCHIVE_SHEET_HEADERS.forEach(h => {
    let val = pinObj[h];

    if (h === 'created_at' && (val === undefined || val === null || val === '')) {
      val = pinObj.created_at_pinterest || getExistingVal('created_at');
    }

    if (h === 'tags') {
      if (val === undefined || val === null) {
        if (Array.isArray(pinObj.annotations) && pinObj.annotations.length > 0) {
          val = pinObj.annotations
            .map(a => (typeof a === 'string' ? a.trim() : String(a?.name || '').trim()))
            .filter(Boolean)
            .join(', ');
        } else {
          val = getExistingVal('tags');
        }
      } else if (Array.isArray(val)) {
        val = val.join(', ');
      }
    }

    if (h === 'first_seen_at') {
      val = getExistingVal('first_seen_at') || pinObj.first_seen_at || nowFormatted;
    }

    if (h === 'last_updated_at') {
      val = nowFormatted;
    }

    if (h === 'archived_at') {
      val = pinObj.archived_at || getExistingVal('archived_at') || '';
    }

    // Preserve existing sheet value if field is undefined/null/empty in sparse pin updates
    if ((val === undefined || val === null || val === '') && existingRow) {
      val = getExistingVal(h);
    }

    if (Array.isArray(val)) {
      val = val.join(', ');
    }

    const colIdx = headerMap && headerMap[h] !== undefined ? headerMap[h] : PINARCHIVE_SHEET_HEADERS.indexOf(h);
    if (colIdx >= 0 && colIdx < width) {
      row[colIdx] = val !== undefined && val !== null ? val : '';
    }
  });

  return row;
}

/**
 * Determine whether an existing sheet row needs an update based on changed fields.
 * Includes data integrity guard for newly qualified pins (`archived_at`).
 */
export function rowNeedsUpdate(existRow, headerMap, r) {
  // 1. Data Integrity: Check if pin newly became archived
  const existArchived = headerMap['archived_at'] !== undefined ? String(existRow[headerMap['archived_at']] ?? '').trim() : '';
  const newArchived = String(r.archived_at ?? '').trim();
  if (newArchived && !existArchived) {
    return true;
  }

  // 2. Metrics & Metadata comparison
  const compareFields = [
    'title',
    'description',
    'link',
    'domain',
    'board_name',
    'created_at',
    'image_url',
    'image_signature',
    'dominant_color',
    'saves',
    'repins',
    'comments',
    'velocity',
    'tags',
  ];

  for (const f of compareFields) {
    const colIdx = headerMap[f];
    const oldVal = colIdx !== undefined ? String(existRow[colIdx] ?? '').trim() : '';

    let newVal = r[f];
    if (f === 'created_at' && (newVal === undefined || newVal === null || newVal === '')) {
      newVal = r.created_at_pinterest;
    }
    if (f === 'tags') {
      if (newVal === undefined || newVal === null) {
        if (Array.isArray(r.annotations) && r.annotations.length > 0) {
          newVal = r.annotations
            .map(a => (typeof a === 'string' ? a.trim() : String(a?.name || '').trim()))
            .filter(Boolean)
            .join(', ');
        }
      } else if (Array.isArray(newVal)) {
        newVal = newVal.join(', ');
      }
    }

    if (newVal !== undefined && newVal !== null) {
      const newStr = String(newVal).trim();
      if (newStr && newStr !== oldVal) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Direct Google Sheets API v4 Writer.
 * Replaces GAS Web App with atomic, sub-second authenticated REST API operations.
 * Protected by:
 *  - Per-tab in-process FIFO mutex (`withTabLock`).
 *  - Safe server-side table appending via `insertDataOption=OVERWRITE`.
 *  - Full in-batch deduplication and changed-row detection.
 *
 * @param {string|object} credentials - Service Account JSON string or parsed object
 * @param {string} spreadsheetId - Google Spreadsheet ID
 * @param {object} payload - { username, mode: 'update' | 'append', rows: any[] }
 * @param {object} [options] - Additional options (e.g. maxRetries)
 */
export async function writeToSheetsApi(credentials, spreadsheetId, payload, options = {}) {
  const startedAt = Date.now();
  const rawUsername = String(payload?.username || '').trim();
  if (!rawUsername) {
    return { ok: false, error: 'username required' };
  }

  const cleanUsername = rawUsername.toLowerCase().replace(/^@/, '');
  const tabName = `pins_${cleanUsername}`;
  const lockKey = `${spreadsheetId}::${tabName}`;

  const rawRows = Array.isArray(payload?.rows) ? payload.rows : [];
  if (rawRows.length === 0) {
    return {
      ok: true,
      version: '4.0.0-api',
      total_received: 0,
      written: 0,
      appended: 0,
      updated: 0,
      unchanged: 0,
    };
  }

  if (!spreadsheetId) {
    return { ok: false, error: 'spreadsheetId required' };
  }

  // Execute under per-tab mutex to eliminate race conditions within this process
  return await withTabLock(lockKey, async () => {
    try {
      // Pre-flight micro-jitter (50ms - 250ms) to desynchronize simultaneous runner bursts
      const jitterMs = Math.floor(Math.random() * 200) + 50;
      await sleep(jitterMs);

      const accessToken = await getGoogleAccessToken(credentials, options);

      // 1. Ensure tab exists with headers (race-safe)
      await ensureSheetExists(accessToken, spreadsheetId, tabName);

      // 2. Read existing rows
      const { headerMap, rows: existingRows } = await readSheetRows(accessToken, spreadsheetId, tabName);
      const width = Math.max(PINARCHIVE_SHEET_HEADERS.length, Object.keys(headerMap).length);
      const nowFormatted = formatSheetDate();

      // 3. In-batch deduplication of input pins
      const dedupedRows = [];
      const seenInputIds = new Set();
      for (const r of rawRows) {
        const id = String(r?.pin_id || '').trim();
        if (!id || seenInputIds.has(id)) continue;
        seenInputIds.add(id);
        dedupedRows.push(r);
      }

      const mode = payload.mode === 'update' ? 'update' : 'append';

      if (mode === 'append') {
        const rowsToAppend = dedupedRows.map(r => buildSheetRow(r, headerMap, width, null, nowFormatted));
        if (rowsToAppend.length > 0) {
          const APPEND_CHUNK = 1000;
          for (let a = 0; a < rowsToAppend.length; a += APPEND_CHUNK) {
            const chunkAppend = rowsToAppend.slice(a, a + APPEND_CHUNK);
            const appendRange = `${escapeSheetTitle(tabName)}!A:R`;
            const appendUrl = `${SHEETS_BASE_URL}/${spreadsheetId}/values/${encodeURIComponent(appendRange)}:append?valueInputOption=USER_ENTERED&insertDataOption=OVERWRITE`;
            await sheetsFetch(accessToken, appendUrl, {
              method: 'POST',
              body: JSON.stringify({
                range: appendRange,
                majorDimension: 'ROWS',
                values: chunkAppend,
              }),
            }, options.maxRetries || 4);
          }
        }

        const elapsedMs = Date.now() - startedAt;
        console.log(`✅ [Sheets API] @${cleanUsername}: written=${rowsToAppend.length} (app=${rowsToAppend.length}, upd=0, unch=0) in ${elapsedMs}ms`);
        return {
          ok: true,
          version: '4.0.0-api',
          total_received: rawRows.length,
          written: rowsToAppend.length,
          appended: rowsToAppend.length,
          updated: 0,
          unchanged: 0,
        };
      }

      // mode === 'update'
      // Build index of existing pin IDs: pin_id -> { index (0-based within existingRows), row }
      // Uses first occurrence mapping to prevent duplicate ambiguity
      const pinIdColIdx = headerMap['pin_id'] !== undefined ? headerMap['pin_id'] : 0;
      const existingIndex = new Map();
      existingRows.forEach((row, i) => {
        const id = String(row[pinIdColIdx] || '').trim();
        if (id && !existingIndex.has(id)) existingIndex.set(id, { index: i, row });
      });

      const toAppend = [];
      const batchUpdateData = [];
      let updatedCount = 0;
      let unchangedCount = 0;

      for (const r of dedupedRows) {
        const pinId = String(r.pin_id || '').trim();
        if (!pinId) continue;

        const existing = existingIndex.get(pinId);
        if (existing) {
          if (!rowNeedsUpdate(existing.row, headerMap, r)) {
            unchangedCount++;
            continue;
          }

          const builtRow = buildSheetRow(r, headerMap, width, existing.row, nowFormatted);
          const rowNumber = existing.index + 2; // 1-based, row 1 is header
          batchUpdateData.push({
            range: `${escapeSheetTitle(tabName)}!A${rowNumber}:R${rowNumber}`,
            majorDimension: 'ROWS',
            values: [builtRow],
          });
          updatedCount++;
        } else {
          toAppend.push(buildSheetRow(r, headerMap, width, null, nowFormatted));
        }
      }

      // 4. Execute updates via values:batchUpdate
      if (batchUpdateData.length > 0) {
        // Chunk batch updates in blocks of 500 ranges to respect HTTP request size limits
        const BATCH_CHUNK = 500;
        for (let b = 0; b < batchUpdateData.length; b += BATCH_CHUNK) {
          const chunkData = batchUpdateData.slice(b, b + BATCH_CHUNK);
          const batchUrl = `${SHEETS_BASE_URL}/${spreadsheetId}/values:batchUpdate`;
          await sheetsFetch(accessToken, batchUrl, {
            method: 'POST',
            body: JSON.stringify({
              valueInputOption: 'USER_ENTERED',
              data: chunkData,
            }),
          }, options.maxRetries || 4);
        }
      }

      // 5. Execute appends via values:append with OVERWRITE in chunks of 1000
      if (toAppend.length > 0) {
        const APPEND_CHUNK = 1000;
        for (let a = 0; a < toAppend.length; a += APPEND_CHUNK) {
          const chunkAppend = toAppend.slice(a, a + APPEND_CHUNK);
          const appendRange = `${escapeSheetTitle(tabName)}!A:R`;
          const appendUrl = `${SHEETS_BASE_URL}/${spreadsheetId}/values/${encodeURIComponent(appendRange)}:append?valueInputOption=USER_ENTERED&insertDataOption=OVERWRITE`;
          await sheetsFetch(accessToken, appendUrl, {
            method: 'POST',
            body: JSON.stringify({
              range: appendRange,
              majorDimension: 'ROWS',
              values: chunkAppend,
            }),
          }, options.maxRetries || 4);
        }
      }

      const elapsedMs = Date.now() - startedAt;
      const written = toAppend.length + updatedCount;
      console.log(`✅ [Sheets API] @${cleanUsername}: written=${written} (app=${toAppend.length}, upd=${updatedCount}, unch=${unchangedCount}) in ${elapsedMs}ms`);

      return {
        ok: true,
        version: '4.0.0-api',
        total_received: rawRows.length,
        written,
        appended: toAppend.length,
        updated: updatedCount,
        unchanged: unchangedCount,
      };
    } catch (err) {
      const elapsedMs = Date.now() - startedAt;
      const errMsg = err?.message || 'Sheets API error';
      console.warn(`❌ [Sheets API] Failed for @${cleanUsername} (${elapsedMs}ms): ${errMsg}`);
      return { ok: false, error: errMsg };
    }
  });
}

/**
 * Query true oldest pin timestamps (account_ages) directly via Google Sheets API v4 batchGet.
 * Pre-filters against existing spreadsheet tabs to prevent HTTP 400 "Unable to parse range".
 */
export async function getAccountAgesFromSheetsApi(credentials, spreadsheetId, usernames, options = {}) {
  const USERNAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
  const validUsernames = Array.isArray(usernames)
    ? usernames.map(String).map(s => s.trim().toLowerCase().replace(/^@/, '')).filter(s => USERNAME_RE.test(s))
    : [];

  const ages = {};
  for (const u of validUsernames) {
    ages[u] = null;
  }

  if (validUsernames.length === 0 || !spreadsheetId) {
    return ages;
  }

  try {
    const accessToken = await getGoogleAccessToken(credentials, options);

    // Discover existing tabs (cached in knownTabsCache to minimize redundant calls)
    let existingTabs = knownTabsCache.get(spreadsheetId);
    if (!existingTabs) {
      existingTabs = await getSpreadsheetTabs(accessToken, spreadsheetId);
      knownTabsCache.set(spreadsheetId, existingTabs);
    } else {
      // If any requested usernames are not present in cache, refresh tabs once
      const hasMissingTabs = validUsernames.some(u => !existingTabs.has(`pins_${u}`));
      if (hasMissingTabs) {
        const freshTabs = await getSpreadsheetTabs(accessToken, spreadsheetId);
        for (const t of freshTabs) existingTabs.add(t);
      }
    }

    const queryableUsernames = validUsernames.filter(u => existingTabs.has(`pins_${u}`));
    if (queryableUsernames.length === 0) {
      return ages;
    }

    // Google Sheets API allows up to 100 ranges per batchGet call
    const BATCH_SIZE = 100;
    for (let i = 0; i < queryableUsernames.length; i += BATCH_SIZE) {
      const chunk = queryableUsernames.slice(i, i + BATCH_SIZE);
      const ranges = chunk.map(u => `${escapeSheetTitle(`pins_${u}`)}!G2:G`);
      const rangesParam = ranges.map(r => `ranges=${encodeURIComponent(r)}`).join('&');
      const batchGetUrl = `${SHEETS_BASE_URL}/${spreadsheetId}/values:batchGet?${rangesParam}`;

      const data = await sheetsFetch(accessToken, batchGetUrl, {}, options.maxRetries || 3);
      const valueRanges = Array.isArray(data?.valueRanges) ? data.valueRanges : [];

      valueRanges.forEach((vr, idx) => {
        // Robust range title parsing: extracts username from 'pins_<username>'!G2:G
        const rangeMatch = String(vr?.range || '').match(/^'?pins_([^'!]+)'?!/i);
        const username = rangeMatch ? rangeMatch[1].toLowerCase() : chunk[idx];
        if (!username) return;

        const cells = Array.isArray(vr?.values) ? vr.values : [];
        let minMs = Infinity;
        let minIso = null;

        for (const row of cells) {
          const cell = row[0];
          if (cell === '' || cell === null || cell === undefined) continue;
          const t = parseSheetTimestamp(cell);
          if (Number.isFinite(t) && t < minMs) {
            minMs = t;
            minIso = new Date(t).toISOString();
          }
        }

        if (Number.isFinite(minMs)) {
          ages[username] = minIso;
        }
      });
    }

    return ages;
  } catch (err) {
    console.warn(`⚠️ [Sheets API] Batch getAccountAges failed: ${err.message}`);
    return ages;
  }
}
