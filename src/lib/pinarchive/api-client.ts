/**
 * PinArchive API Client Module
 * Safe, multi-tenant workspace-scoped API communications.
 */

export function getWorkspaceId(): string {
  if (typeof document === 'undefined') return '';
  const root = document.getElementById('pinarchive-page-root');
  if (root) {
    const ws = root.getAttribute('data-workspace-id');
    if (ws) return ws.trim();
  }
  const params = new URLSearchParams(window.location.search);
  return params.get('workspace_id') || '';
}

export async function fetchJson<T = any>(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {}
): Promise<T> {
  const { timeoutMs = 10000, ...fetchOptions } = options;
  const signal = fetchOptions.signal || AbortSignal.timeout(timeoutMs);

  const res = await fetch(url, {
    ...fetchOptions,
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...(fetchOptions.headers || {}),
    },
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    const errorMsg = json.error || `Request failed with HTTP status ${res.status}`;
    throw new Error(errorMsg);
  }

  return json as T;
}

/**
 * Batch fetch pins (max 50, workspace-scoped)
 */
export async function fetchBatchPins(
  ids: string[],
  workspaceId?: string
): Promise<{ success: boolean; pins: any[]; total: number }> {
  const cleanIds = ids.slice(0, 50).filter(Boolean);
  if (cleanIds.length === 0) {
    return { success: true, pins: [], total: 0 };
  }

  const ws = workspaceId || getWorkspaceId();
  let url = `/api/pinarchive/pins?ids=${encodeURIComponent(cleanIds.join(','))}`;
  if (ws) {
    url += `&workspace_id=${encodeURIComponent(ws)}`;
  }

  return fetchJson(url, { method: 'GET', timeoutMs: 12000 });
}

export async function fetchOverview(workspaceId?: string): Promise<any> {
  const ws = workspaceId || getWorkspaceId();
  const url = ws
    ? `/api/pinarchive/overview?workspace_id=${encodeURIComponent(ws)}`
    : '/api/pinarchive/overview';
  return fetchJson(url, { method: 'GET', timeoutMs: 15000 });
}

export async function fetchCompetitors(workspaceId?: string): Promise<any> {
  const ws = workspaceId || getWorkspaceId();
  const url = ws
    ? `/api/admin/competitors?workspace_id=${encodeURIComponent(ws)}&lite=1`
    : '/api/admin/competitors?lite=1';
  return fetchJson(url, { method: 'GET', timeoutMs: 8000 });
}

export async function fetchSettings(): Promise<any> {
  return fetchJson('/api/pinarchive/settings', { method: 'GET', timeoutMs: 8000 });
}

export async function saveSettings(payload: Record<string, any>): Promise<any> {
  return fetchJson('/api/pinarchive/settings', {
    method: 'PATCH',
    body: JSON.stringify(payload),
    timeoutMs: 10000,
  });
}

export async function toggleAccountsIngest(
  workspaceId: string,
  accountIds: string[],
  enabled: boolean
): Promise<any> {
  return fetchJson('/api/pinarchive/accounts-ingest-toggle', {
    method: 'POST',
    body: JSON.stringify({
      workspace_id: workspaceId,
      account_ids: accountIds,
      ingest_enabled: enabled,
    }),
    timeoutMs: 10000,
  });
}

export async function updateAccountsInterval(
  workspaceId: string,
  payload: { account_id?: string; username?: string; account_ids?: string[]; interval_days: number }
): Promise<any> {
  return fetchJson('/api/pinarchive/accounts-interval', {
    method: 'PATCH',
    body: JSON.stringify({
      workspace_id: workspaceId,
      ...payload,
    }),
    timeoutMs: 10000,
  });
}

export async function deleteAccounts(accountIds: string[]): Promise<any> {
  return fetchJson('/api/pinarchive/accounts-delete', {
    method: 'POST',
    body: JSON.stringify({ account_ids: accountIds }),
    timeoutMs: 10000,
  });
}

export async function dispatchAccountsGas(
  workspaceId: string,
  action: string,
  usernames?: string[]
): Promise<any> {
  const body: any = { action, workspace_id: workspaceId };
  if (usernames && usernames.length > 0) {
    body.usernames = usernames;
  }
  return fetchJson('/api/pinarchive/accounts-gas', {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: 15000,
  });
}

export async function dispatchFastRefresh(
  workspaceId: string,
  usernames: string[]
): Promise<any> {
  return fetchJson('/api/internal/pinarchive/refresh', {
    method: 'POST',
    body: JSON.stringify({
      workspace_id: workspaceId,
      usernames,
    }),
    timeoutMs: 15000,
  });
}

export async function reevaluateCandidates(workspaceId: string): Promise<any> {
  return fetchJson('/api/internal/pinarchive/reevaluate', {
    method: 'POST',
    body: JSON.stringify({ workspace_id: workspaceId }),
    timeoutMs: 30000,
  });
}
