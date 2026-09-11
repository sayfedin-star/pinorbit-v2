/**
 * scripts/lib/vault.mjs
 *
 * Pure shared Vault Cryptography & Cookie Management library.
 * Implements AES-GCM (v1:iv:ct, SHA-256(kek)) encryption/decryption,
 * atomic KEK resolution, and LRU cookie selection for Pinterest scrapers.
 *
 * Rule: Pure utility module only — no top-level side effects or script execution.
 */

import crypto from 'node:crypto';

export const enc = new TextEncoder();
export const dec = new TextDecoder();

export const b64 = b => btoa(String.fromCharCode(...(b instanceof Uint8Array ? b : new Uint8Array(b))));
export const ub64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

/**
 * Derive an AES-GCM CryptoKey from the SHA-256 hash of a Key Encryption Key (KEK).
 */
export async function aesKey(kek, usage) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(kek));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [usage]);
}

/**
 * Decrypt a stored cookie string formatted as `v1:iv:ct` using the given KEK.
 * Returns decrypted plaintext string, or null on decryption failure/tampering.
 */
export async function decryptCookieValue(stored, kek) {
  if (!stored || typeof stored !== 'string') return null;
  if (!stored.startsWith('v1:')) return stored; // Plaintext fallback
  const [, ivB64, ctB64] = stored.split(':');
  if (!ivB64 || !ctB64) return null;
  try {
    return dec.decode(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: ub64(ivB64) },
        await aesKey(kek, 'decrypt'),
        ub64(ctB64)
      )
    );
  } catch {
    return null;
  }
}

/**
 * Encrypt a plaintext cookie value into `v1:iv:ct` format using the given KEK.
 */
export async function encryptCookieValue(plain, kek) {
  if (!plain || typeof plain !== 'string') return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(kek, 'encrypt');
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plain));
  return `v1:${b64(iv)}:${b64(ct)}`;
}

/**
 * Atomically resolve the Key Encryption Key (KEK) from competitor_kek table.
 * Uses atomic { onConflict: 'id', ignoreDuplicates: true } to eliminate concurrent race hazards.
 */
export async function resolveKek(vaultDb) {
  const { data } = await vaultDb.from('competitor_kek').select('kek').limit(1).maybeSingle();
  if (data?.kek) return data.kek;

  const hex = crypto.randomBytes(32).toString('hex');
  await vaultDb.from('competitor_kek').upsert({ id: true, kek: hex }, { onConflict: 'id', ignoreDuplicates: true });

  const { data: d2 } = await vaultDb.from('competitor_kek').select('kek').limit(1).maybeSingle();
  return d2?.kek || null;
}

/**
 * LRU Cookie Vault Selector.
 * Selects the least-recently used active cookie for the workspace, decrypts it, and touches last_used_at.
 */
export async function getVaultCookie(vaultDb, wsId, kek) {
  const { data } = await vaultDb
    .from('pinterest_cookies')
    .select('id, cookie_value')
    .eq('workspace_id', wsId)
    .eq('is_active', true)
    .order('last_used_at', { ascending: true, nullsFirst: true })
    .limit(5);

  for (const c of data || []) {
    const plain = await decryptCookieValue(c.cookie_value, kek);
    if (plain) {
      await vaultDb
        .from('pinterest_cookies')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', c.id);
      return { id: c.id, plain };
    }
  }

  // Legacy auto-import fallback from env if present
  const legacy = process.env.PINTEREST_COOKIE;
  if (legacy && legacy.trim().length >= 20 && kek) {
    try {
      const encStr = await encryptCookieValue(legacy.trim(), kek);
      if (encStr) {
        await vaultDb.from('pinterest_cookies').insert({
          workspace_id: wsId,
          cookie_value: encStr,
          is_active: true,
        });
        console.log(`🔐 Legacy PINTEREST_COOKIE auto-imported into vault for workspace ${wsId}`);
        return { id: 'legacy', plain: legacy.trim() };
      }
    } catch (e) {
      console.warn(`⚠️ Could not auto-import legacy cookie: ${e.message}`);
    }
  }

  return null;
}
