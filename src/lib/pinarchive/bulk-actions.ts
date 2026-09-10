/**
 * PinArchive Bulk Actions Orchestrator Module
 */

import {
  toggleAccountsIngest,
  updateAccountsInterval,
  deleteAccounts,
  dispatchAccountsGas,
  dispatchFastRefresh,
  fetchJson,
} from './api-client';

export async function executeBulkPause(
  workspaceId: string,
  accountIds: string[]
): Promise<any> {
  return toggleAccountsIngest(workspaceId, accountIds, false);
}

export async function executeBulkResume(
  workspaceId: string,
  accountIds: string[]
): Promise<any> {
  return toggleAccountsIngest(workspaceId, accountIds, true);
}

export async function executeBulkInterval(
  workspaceId: string,
  accountIds: string[],
  newDays: number
): Promise<any> {
  return updateAccountsInterval(workspaceId, {
    account_ids: accountIds,
    interval_days: newDays,
  });
}

export async function executeBulkDelete(
  accountIds: string[]
): Promise<any> {
  return deleteAccounts(accountIds);
}

export async function executeBulkDiscovery(
  workspaceId: string,
  usernames: string[]
): Promise<any> {
  return dispatchAccountsGas(workspaceId, 'run_now', usernames);
}

export async function executeBulkAuditSweep(
  workspaceId: string,
  usernames?: string[]
): Promise<any> {
  return dispatchAccountsGas(workspaceId, 'audit_sweep', usernames);
}

export async function executeBulkSheetSync(
  workspaceId: string,
  usernames?: string[]
): Promise<any> {
  return dispatchAccountsGas(workspaceId, 'sync_sheet_ages', usernames);
}

export async function executeBulkRefresh(
  workspaceId: string,
  usernames: string[]
): Promise<any> {
  return dispatchFastRefresh(workspaceId, usernames);
}

export async function executeBulkSendToCompetitors(
  workspaceId: string,
  usernames: string[]
): Promise<any> {
  const json = await fetchJson('/api/admin/competitors', {
    method: 'POST',
    body: JSON.stringify({
      workspace_id: workspaceId,
      competitors: usernames,
      account_type: 'competitor',
    }),
    timeoutMs: 15000,
  });

  const compIds = (json.competitors || []).map((c: any) => c.id).filter(Boolean);
  if (compIds.length > 0) {
    // Fire-and-forget background scraper dispatch
    fetchJson('/api/admin/competitor-ops', {
      method: 'POST',
      body: JSON.stringify({
        action: 'dispatch',
        workspace_id: workspaceId,
        ids: compIds,
        trigger: 'pinarchive_bulk_send',
        force: true,
      }),
      timeoutMs: 8000,
    }).catch(console.warn);
  }

  return json;
}
