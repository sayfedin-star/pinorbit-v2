import type { SupabaseClient } from '@supabase/supabase-js';
import { dbClients } from '../db/clients';

export interface PinArchiveAccountSummary {
  id: string;
  username: string;
  status: string;
  ingest_enabled: boolean;
  follower_count: number;
  pins_count: number;
  last_run_at: string | null;
  next_run_at: string | null;
  delta_saves_24h?: number;
  delta_repins_24h?: number;
}

export const PINARCHIVE_ACCOUNT_FIELDS =
  'id, username, status, ingest_enabled, follower_count, pins_count, last_run_at, next_run_at';

export async function getAccountByUsername(
  workspaceId: string,
  username: string,
  env?: any,
  paClient?: SupabaseClient
): Promise<PinArchiveAccountSummary | null> {
  if (!workspaceId || !username) {
    return null;
  }

  const db = paClient || dbClients.getPinArchive(env);
  const { data, error } = await db
    .from('pa_accounts')
    .select(PINARCHIVE_ACCOUNT_FIELDS)
    .eq('workspace_id', workspaceId)
    .eq('username', username)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  const accountSummary: PinArchiveAccountSummary = {
    ...(data as PinArchiveAccountSummary),
    delta_saves_24h: 0,
    delta_repins_24h: 0,
  };

  try {
    if (typeof db.rpc === 'function') {
      const { data: deltaRows } = await db.rpc('pa_account_deltas_24h', {
        p_workspace_id: workspaceId,
        p_account_id: accountSummary.id,
      });
      if (Array.isArray(deltaRows) && deltaRows.length > 0) {
        accountSummary.delta_saves_24h = Number(deltaRows[0].delta_saves_24h || 0);
        accountSummary.delta_repins_24h = Number(deltaRows[0].delta_repins_24h || 0);
      }
    }
  } catch (deltaErr) {
    console.warn('[PinArchiveAccountService] Failed to load 24h deltas for account:', deltaErr);
  }

  return accountSummary;
}
