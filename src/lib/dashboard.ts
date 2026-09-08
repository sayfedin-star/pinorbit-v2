import { getAccounts } from './accounts';
import { getAccountWebhooks } from './webhooks';
import { getPins } from './pins';
import { getLogs } from './logs';
import type { DashboardKPIs } from './types';

// 8. Fetch Dashboard KPIs
export async function getDashboardKPIs(workspaceId?: string): Promise<DashboardKPIs> {
  const [accounts, webhooks, pins, logs] = await Promise.all([
    getAccounts(workspaceId),
    getAccountWebhooks(undefined, workspaceId),
    getPins('all', undefined, workspaceId),
    getLogs(100, workspaceId),
  ]);

  return {
    totalAccounts: accounts.length,
    activeAccounts: accounts.filter((a) => a.is_active).length,
    pendingPins: pins.filter((p) => p.status === 'pending' || p.status === 'processing').length,
    postedPins: pins.filter((p) => p.status === 'posted').length,
    failedPins: pins.filter((p) => p.status === 'failed').length,
    totalLogs: logs.length,
    totalWebhooks: webhooks.length,
    activeWebhooks: webhooks.filter((w) => w.is_active).length,
    exhaustedWebhooks: webhooks.filter((w) => w.remaining_capacity <= 0).length,
  };
}
