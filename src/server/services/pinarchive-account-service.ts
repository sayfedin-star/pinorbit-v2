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

  return data as PinArchiveAccountSummary;
}
