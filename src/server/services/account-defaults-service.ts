import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError } from '../lib/http-error';
import { validateSafeUrl } from '../lib/ssrf-guard';

export interface AccountDefaultsResult {
  defaults: Record<string, string>;
  domains: string[];
  singleDomain: string | null;
}

/**
 * Get account default sites for a workspace, along with all known notebook domains.
 * Implements AUTO-RULE: If exactly 1 domain exists in the notebook, it acts as the default
 * for all accounts without an explicit override.
 */
export async function getAccountDefaults(
  paAdmin: SupabaseClient,
  workspaceId: string
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

  // 2. Fetch distinct domains from user_links and workspace_links
  const [userLinksRes, wsLinksRes] = await Promise.all([
    paAdmin.from('user_links').select('url'),
    paAdmin.from('workspace_links').select('url').eq('workspace_id', workspaceId),
  ]);

  const domainSet = new Set<string>();
  const collectDomains = (rows: any[] | null) => {
    for (const r of rows || []) {
      if (r?.url) {
        try {
          const u = new URL(r.url);
          if (u.hostname) domainSet.add(u.hostname);
        } catch {}
      }
    }
  };

  collectDomains(userLinksRes.data);
  collectDomains(wsLinksRes.data);

  const domains = Array.from(domainSet).sort();
  const singleDomain = domains.length === 1 ? domains[0] : null;

  return {
    defaults,
    domains,
    singleDomain,
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
