/**
 * scripts/lib/runner-cache.mjs
 *
 * Lightweight runner-local cache for Pinterest pin data.
 * Accelerates fused pipeline runs by sharing freshly discovered pin data
 * directly with subsequent rotation/refresh stages on the same runner VM,
 * eliminating redundant HTTP requests and protecting against rate limits (HTTP 429).
 *
 * Rule: Pure utility module only — no top-level side effects or script execution.
 */

import fs from 'node:fs';
import path from 'node:path';

const CACHE_DIR = path.resolve(process.cwd(), '.cache');
const CACHE_FILE = process.env.RUNNER_CACHE_FILE || path.join(CACHE_DIR, 'runner-pins.json');
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

let inMemoryMap = null;
let stats = { hits: 0, misses: 0, saved: 0 };

function initCache() {
  if (inMemoryMap !== null) return;
  inMemoryMap = new Map();

  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        for (const [id, entry] of Object.entries(parsed)) {
          if (entry && entry.cachedAt && entry.data) {
            inMemoryMap.set(String(id), entry);
          }
        }
      }
    }
  } catch (err) {
    // Graceful fallback to empty map
    inMemoryMap = new Map();
  }
}

/**
 * Save an array of pins (or a single pin object) into the local runner cache.
 */
export function savePinsToRunnerCache(pins, ttlMs = DEFAULT_TTL_MS) {
  if (!pins) return 0;
  initCache();

  const list = Array.isArray(pins) ? pins : [pins];
  let count = 0;
  const now = Date.now();

  for (const pin of list) {
    const pinId = String(pin?.pin_id || pin?.id || pin?.node_id || '').trim();
    if (!pinId) continue;

    inMemoryMap.set(pinId, {
      cachedAt: now,
      ttlMs,
      data: {
        ok: true,
        ...pin,
        pin_id: pinId,
        saves: Number(pin.saves || 0),
        repins: Number(pin.repins || 0),
        comments: Number(pin.comments || 0),
        share_count: Number(pin.share_count || 0),
        reactions: (typeof pin.reactions === 'object' && pin.reactions !== null) ? pin.reactions : {},
        annotations: Array.isArray(pin.annotations) ? pin.annotations : [],
        created_at_pinterest: pin.created_at_pinterest || null,
        _cachedBy: 'runner-cache',
      },
    });
    count++;
  }

  // Persist to disk atomically
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const serialized = Object.fromEntries(inMemoryMap.entries());
    const tempFile = `${CACHE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(serialized), 'utf-8');
    fs.renameSync(tempFile, CACHE_FILE);
    stats.saved += count;
  } catch (err) {
    console.warn(`[RunnerCache] Could not persist cache to disk: ${err.message}`);
  }

  return count;
}

/**
 * Retrieve a pin from the local runner cache if present and unexpired.
 */
export function getPinFromRunnerCache(pinId) {
  if (!pinId) return null;
  initCache();

  const id = String(pinId).trim();
  const entry = inMemoryMap.get(id);

  if (!entry) {
    stats.misses++;
    return null;
  }

  const age = Date.now() - entry.cachedAt;
  const ttl = entry.ttlMs || DEFAULT_TTL_MS;

  if (age > ttl) {
    inMemoryMap.delete(id);
    stats.misses++;
    return null;
  }

  stats.hits++;
  return entry.data;
}

/**
 * Returns cache telemetry stats.
 */
export function getRunnerCacheStats() {
  initCache();
  return {
    hits: stats.hits,
    misses: stats.misses,
    saved: stats.saved,
    totalCached: inMemoryMap.size,
  };
}

/**
 * Clears the cache in memory and on disk.
 */
export function clearRunnerCache() {
  inMemoryMap = new Map();
  stats = { hits: 0, misses: 0, saved: 0 };
  try {
    if (fs.existsSync(CACHE_FILE)) {
      fs.unlinkSync(CACHE_FILE);
    }
  } catch (_) {}
}
