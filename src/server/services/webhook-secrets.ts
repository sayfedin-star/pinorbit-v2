import { getServerEnv } from '../db/clients';

export const GLOBAL_KEY = 'ingest_secret:global';
export const wsKey = (wsId: string) => `ingest_secret:ws:${wsId}`;

export interface IngestSecretResolution {
  value: string;
  source: 'workspace' | 'global' | 'env';
}

export interface IngestSecretStatus {
  secret: string;
  source: 'workspace' | 'global' | 'env';
  hasOverride: boolean;
}

/**
 * Resolves the effective ingest secret in strict immutable order:
 * 1. ingest_secret:ws:{wsId} (Workspace override)
 * 2. ingest_secret:ws:{wsId}:prev (Workspace override grace period - 300s)
 * 3. ingest_secret:global (Global secret)
 * 4. ingest_secret:global:prev (Global secret grace period - 300s)
 * 5. INGEST_SECRET_KEY env (Fallback)
 */
export async function getEffectiveSecret(
  wsId: string,
  runtimeEnv: Record<string, any>
): Promise<IngestSecretResolution> {
  const kv = runtimeEnv?.INGEST_SECRETS_KV;
  if (kv) {
    if (wsId) {
      const ws = await kv.get(wsKey(wsId));
      if (ws) return { value: ws, source: 'workspace' };
      const wsPrev = await kv.get(`${wsKey(wsId)}:prev`);
      if (wsPrev) return { value: wsPrev, source: 'workspace' };
    }
    const g = await kv.get(GLOBAL_KEY);
    if (g) return { value: g, source: 'global' };
    const gPrev = await kv.get(`${GLOBAL_KEY}:prev`);
    if (gPrev) return { value: gPrev, source: 'global' };
  }

  const serverConfig = getServerEnv(runtimeEnv);
  return { value: serverConfig.INGEST_SECRET_KEY ?? '', source: 'env' };
}

/**
 * Auto-generates global secret in KV on first view if absent.
 */
export async function ensureGlobalSecret(
  runtimeEnv: Record<string, any>
): Promise<string> {
  const kv = runtimeEnv?.INGEST_SECRETS_KV;
  if (!kv) {
    const serverConfig = getServerEnv(runtimeEnv);
    return serverConfig.INGEST_SECRET_KEY || '';
  }

  let g = await kv.get(GLOBAL_KEY);
  if (!g) {
    g = crypto.randomUUID();
    await kv.put(GLOBAL_KEY, g);
  }
  return g;
}

/**
 * Rotates secret with a 300s grace period (storing previous secret under ${key}:prev).
 */
export async function regenerate(
  scope: 'global' | 'workspace',
  wsId: string | undefined,
  runtimeEnv: Record<string, any>
): Promise<string> {
  const kv = runtimeEnv?.INGEST_SECRETS_KV;
  if (!kv) {
    throw new Error('Cloudflare KV namespace INGEST_SECRETS_KV is not configured in runtime environment.');
  }

  if (scope === 'workspace' && !wsId) {
    throw new Error('Workspace ID is required to generate workspace override secret.');
  }

  const key = scope === 'global' ? GLOBAL_KEY : wsKey(wsId!);
  const current = await kv.get(key);
  if (current) {
    await kv.put(`${key}:prev`, current, { expirationTtl: 300 });
  }

  const next = crypto.randomUUID();
  await kv.put(key, next);
  return next;
}

/**
 * Deletes ONLY the workspace override key; global secret remains untouched.
 */
export async function removeWorkspaceOverride(
  wsId: string,
  runtimeEnv: Record<string, any>
): Promise<void> {
  const kv = runtimeEnv?.INGEST_SECRETS_KV;
  if (kv && wsId) {
    await kv.delete(wsKey(wsId));
  }
}

/**
 * Retrieves the secret status for UI view, ensuring global secret exists if KV available.
 */
export async function getSecretStatus(
  wsId: string,
  runtimeEnv: Record<string, any>
): Promise<IngestSecretStatus> {
  const kv = runtimeEnv?.INGEST_SECRETS_KV;
  if (kv && wsId) {
    const ws = await kv.get(wsKey(wsId));
    if (ws) {
      return { secret: ws, source: 'workspace', hasOverride: true };
    }
  }

  const secret = await ensureGlobalSecret(runtimeEnv);
  return {
    secret,
    source: kv ? 'global' : 'env',
    hasOverride: false,
  };
}

/**
 * Masks a secret for display in UI (shows first 8 chars + ellipsis).
 */
export function maskSecret(secret: string): string {
  if (!secret || secret.length <= 8) return '********';
  return secret.slice(0, 8) + '...';
}

/**
 * Retrieves masked secret status for UI display.
 */
export async function getSecretStatusMasked(
  wsId: string,
  runtimeEnv: Record<string, any>
): Promise<{ masked: string; source: string; hasOverride: boolean }> {
  const status = await getSecretStatus(wsId, runtimeEnv);
  return {
    masked: maskSecret(status.secret),
    source: status.source,
    hasOverride: status.hasOverride,
  };
}
