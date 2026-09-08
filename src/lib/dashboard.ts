import { getAccounts } from './accounts';
import { getAccountWebhooks } from './webhooks';
import { countLogs } from './logs';
import { supabase } from './supabase-client';
import { mockPins, matchesWorkspace } from './supabase-mock';
import type { DashboardKPIs } from './types';

export async function countPinsByStatus(workspaceId?: string, statuses?: string[]): Promise<number> {
  if (!supabase) {
    let pins = mockPins;
    if (workspaceId) {
      pins = pins.filter((p) => matchesWorkspace(p.workspace_id, workspaceId));
    }
    if (statuses && statuses.length > 0) {
      pins = pins.filter((p) => statuses.includes(p.status));
    }
    return pins.length;
  }

  let query = supabase
    .from('pins')
    .select('id', { count: 'exact', head: true });

  if (workspaceId) {
    query = query.eq('workspace_id', workspaceId);
  }

  if (statuses && statuses.length > 0) {
    query = query.in('status', statuses);
  }

  const { count, error } = await query;
  if (error) {
    throw error;
  }

  return count ?? 0;
}

// 8. Fetch Dashboard KPIs
export async function getDashboardKPIs(workspaceId?: string): Promise<DashboardKPIs> {
  const [accounts, webhooks, totalLogs, pendingPins, postedPins, failedPins] = await Promise.all([
    getAccounts(workspaceId),
    getAccountWebhooks(undefined, workspaceId),
    countLogs(workspaceId),
    countPinsByStatus(workspaceId, ['pending', 'processing']),
    countPinsByStatus(workspaceId, ['posted']),
    countPinsByStatus(workspaceId, ['failed']),
  ]);

  return {
    totalAccounts: accounts.length,
    activeAccounts: accounts.filter((a) => a.is_active).length,
    pendingPins,
    postedPins,
    failedPins,
    totalLogs,
    totalWebhooks: webhooks.length,
    activeWebhooks: webhooks.filter((w) => w.is_active).length,
    exhaustedWebhooks: webhooks.filter((w) => w.remaining_capacity <= 0).length,
  };
}
