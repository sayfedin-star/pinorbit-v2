import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError } from '../lib/http-error';
import { validateSafeUrl } from '../lib/ssrf-guard';

export interface AccountDefaultsResult {
  defaults: Record<string, string>;
  domains: string[];
  singleDomain: string | null;
  user_count: number;
  workspace_count: number;
  domain_counts: Record<string, number>;
}

/**
 * Helper to fetch all URLs from a table in range-chunks to avoid PostgREST's 1000-row default limit.
 */
async function fetchTableUrlsChunked(
  paAdmin: SupabaseClient,
  tableName: 'user_links' | 'workspace_links',
  filterCol?: string,
  filterVal?: string
): Promise<{ urls: string[]; totalCount: number }> {
  const CHUNK_SIZE = 1000;
  const urls: string[] = [];
  let from = 0;
  let exactTotal = 0;

  while (true) {
    let query = paAdmin
      .from(tableName)
      .select('url', { count: from === 0 ? 'exact' : undefined });

    if (filterCol && filterVal) {
      query = query.eq(filterCol, filterVal);
    }

    const { data, count, error } = await query
      .order('created_at', { ascending: false })
      .range(from, from + CHUNK_SIZE - 1);

    if (error || !data || data.length === 0) break;
    if (from === 0 && typeof count === 'number') {
      exactTotal = count;
    }
    for (const row of data) {
      if (row?.url) urls.push(row.url);
    }
    if (data.length < CHUNK_SIZE) break;
    from += CHUNK_SIZE;
  }

  return { urls, totalCount: Math.max(exactTotal, urls.length) };
}

/**
 * Get account default sites for a workspace, along with all known notebook domains and aggregate counts.
 * Range-chunks across user_links and workspace_links so tables larger than 1000 rows are accurately aggregated.
 * Implements AUTO-RULE: If exactly 1 domain exists in the notebook, it acts as the default
 * for all accounts without an explicit override.
 */
export async function getAccountDefaults(
  paAdmin: SupabaseClient,
  workspaceId: string,
  userId?: string
): Promise<AccountDefaultsResult> {
  // 1. Fetch configured defaults
  const { data: configuredRows, error: confErr } = await paAdmin
    .from('pa_account_default_sites')
    .select('account_id, default_site')
    .eq('workspace_id', workspaceId);

  if (confErr) {
    throw new HttpError(500, `Failed to fetch account default sites: ${confErr.message}`);
  }

  const defaults: Record<string, string> = {};
  for (const row of configuredRows || []) {
    if (row.account_id && row.default_site) {
      defaults[row.account_id] = row.default_site;
    }
  }

  // 2. Fetch distinct domains and counts from user_links and workspace_links in range chunks
  const [userResult, wsResult] = await Promise.all([
    fetchTableUrlsChunked(paAdmin, 'user_links', userId ? 'user_id' : undefined, userId || undefined),
    fetchTableUrlsChunked(paAdmin, 'workspace_links', 'workspace_id', workspaceId),
  ]);

  const domainCounts: Record<string, number> = {};
  const domainSet = new Set<string>();

  const collectDomains = (urls: string[]) => {
    for (const rawUrl of urls) {
      try {
        const u = new URL(rawUrl);
        if (u.hostname) {
          domainSet.add(u.hostname);
          domainCounts[u.hostname] = (domainCounts[u.hostname] || 0) + 1;
        }
      } catch {}
    }
  };

  collectDomains(userResult.urls);
  collectDomains(wsResult.urls);

  const domains = Array.from(domainSet).sort();
  const singleDomain = domains.length === 1 ? domains[0] : null;

  return {
    defaults,
    domains,
    singleDomain,
    user_count: userResult.totalCount,
    workspace_count: wsResult.totalCount,
    domain_counts: domainCounts,
  };
}

/**
 * Save or update default site for an account within a workspace.
 */
export async function setAccountDefault(
  paAdmin: SupabaseClient,
  workspaceId: string,
  accountId: string,
  defaultSite: string
): Promise<{ success: boolean; accountId: string; defaultSite: string }> {
  if (!accountId) {
    throw new HttpError(400, 'Account ID is required.');
  }

  const cleanSite = (defaultSite || '').trim();
  if (!cleanSite) {
    // Delete override if site is emptied
    const { error: delErr } = await paAdmin
      .from('pa_account_default_sites')
      .delete()
      .eq('workspace_id', workspaceId)
      .eq('account_id', accountId);

    if (delErr) {
      throw new HttpError(500, `Failed to remove account default site: ${delErr.message}`);
    }

    return { success: true, accountId, defaultSite: '' };
  }

  // Validate safe URL or safe domain
  const siteWithProto = /^https?:\/\//i.test(cleanSite) ? cleanSite : `https://${cleanSite}`;
  const safe = validateSafeUrl(siteWithProto);

  const { error: upsertErr } = await paAdmin
    .from('pa_account_default_sites')
    .upsert(
      {
        workspace_id: workspaceId,
        account_id: accountId,
        default_site: safe.toString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'workspace_id,account_id' }
    );

  if (upsertErr) {
    throw new HttpError(500, `Failed to save account default site: ${upsertErr.message}`);
  }

  return { success: true, accountId, defaultSite: safe.toString() };
}
