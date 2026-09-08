import { supabase } from './supabase-client';
import { editedAccountScheduleSession } from './supabase-session';
import { rescheduleAccountPendingPins } from './schedules';
import {
  mockAccounts,
  mockWebhooks,
  mockBoards,
  mockPins,
  matchesWorkspace,
  type RawAccount,
} from './supabase-mock';
import { DEFAULT_WORKSPACE_ID } from './constants/workspaces';
import type { Account, AccountPinStats } from './types';

function getMockAccountPinStats(accountId: string): AccountPinStats {
  const accPins = mockPins.filter((p) => p.account_id === accountId);
  const total = accPins.length;
  const retrying = accPins.filter((p) => p.status === 'pending' && (p.retry_count || 0) > 0).length;
  const pending = accPins.filter((p) => (p.status === 'pending' && (!p.retry_count || p.retry_count === 0)) || p.status === 'processing').length;
  const posted = accPins.filter((p) => p.status === 'posted').length;
  const failed = accPins.filter((p) => p.status === 'failed').length;

  const acc = mockAccounts.find((a) => a.id === accountId);
  const maxDaily = acc ? acc.max_pins_per_day : 20;

  const todayStr = new Date().toISOString().slice(0, 10);
  const postedToday = accPins.filter(
    (p) => p.status === 'posted' && p.posted_at && p.posted_at.startsWith(todayStr)
  ).length;

  const remainingToday = Math.max(0, maxDaily - postedToday);

  return { total, pending, posted, failed, retrying, remainingToday };
}

// 1. Fetch Accounts with Webhook Summary
export async function getAccounts(workspaceId?: string): Promise<Account[]> {
  let list: Account[] = [];
  if (!supabase) {
    list = workspaceId ? mockAccounts.filter((a) => matchesWorkspace(a.workspace_id, workspaceId)) : mockAccounts;
  } else {
    try {
      let query = supabase
        .from('accounts')
        .select('*, boards(id), account_webhooks!account_webhooks_account_id_fkey(id, label, is_active, is_primary)')
        .order('created_at', { ascending: false });

      if (workspaceId) {
        query = query.eq('workspace_id', workspaceId);
      }

      const { data, error } = await query;

      if (error) {
        let basicQuery = supabase
          .from('accounts')
          .select('*')
          .order('created_at', { ascending: false });

        if (workspaceId) {
          basicQuery = basicQuery.eq('workspace_id', workspaceId);
        }

        const { data: basicData } = await basicQuery;

        list = (basicData as Account[] || []).map((acc) => ({
          ...acc,
          boards_count: 0,
          webhooks_count: 0,
          active_webhooks_count: 0,
          primary_webhook_label: 'None',
        }));
      } else if (data) {
        list = (data as RawAccount[]).map((acc) => {
          const hooks = acc.account_webhooks || [];
          const primaryHook = hooks.find((h) => h.is_primary);

          return {
            ...acc,
            boards_count: acc.boards ? acc.boards.length : 0,
            webhooks_count: hooks.length,
            active_webhooks_count: hooks.filter((h) => h.is_active).length,
            primary_webhook_label: primaryHook ? primaryHook.label : 'None',
          };
        });
      }
    } catch (err) {
      console.warn('Supabase fetch accounts error, using fallback:', err);
      list = workspaceId ? mockAccounts.filter((a) => !a.workspace_id || a.workspace_id === workspaceId) : mockAccounts;
    }
  }

  return list.map((acc) => {
    if (editedAccountScheduleSession.has(acc.id)) {
      return { ...acc, ...editedAccountScheduleSession.get(acc.id) };
    }
    return acc;
  });
}

// 9. Admin Mutations & Webhook Operations
export async function createAccount(payload: {
  account_name: string;
  webhook_url: string;
  max_pins_per_day: number;
  posting_interval_minutes?: number;
  is_active?: boolean;
  workspace_id?: string;
}): Promise<{ data: Account | null; error: string | null }> {
  const targetWsId = payload.workspace_id || DEFAULT_WORKSPACE_ID;

  if (!supabase) {
    const newAcc: Account = {
      id: 'acc-' + Date.now(),
      workspace_id: targetWsId,
      account_name: payload.account_name,
      webhook_url: payload.webhook_url,
      max_pins_per_day: payload.max_pins_per_day,
      posting_interval_minutes: payload.posting_interval_minutes ?? 30,
      is_active: payload.is_active ?? true,
      created_at: new Date().toISOString(),
      boards_count: 0,
      webhooks_count: 1,
      active_webhooks_count: 1,
      primary_webhook_label: 'Primary',
    };
    mockAccounts.unshift(newAcc);
    return { data: newAcc, error: null };
  }

  const { data, error } = await supabase
    .from('accounts')
    .insert({
      workspace_id: targetWsId,
      account_name: payload.account_name,
      webhook_url: payload.webhook_url,
      max_pins_per_day: payload.max_pins_per_day,
      posting_interval_minutes: payload.posting_interval_minutes ?? 30,
      is_active: payload.is_active ?? true,
    })
    .select('*')
    .single();

  if (error) {
    return { data: null, error: error.message };
  }

  if (data) {
    await supabase.from('account_webhooks').insert({
      account_id: data.id,
      label: 'Primary',
      webhook_url: payload.webhook_url,
      monthly_capacity: 500,
      monthly_usage: 0,
      priority: 1,
      is_active: payload.is_active ?? true,
      is_primary: true,
    });
  }

  return { data: data as Account, error: null };
}

export async function updateAccountDailyLimit(
  id: string,
  max_pins_per_day: number
): Promise<{ data: Account | null; error: string | null; success: boolean }> {
  if (!supabase) {
    const target = mockAccounts.find((a) => a.id === id);
    if (target) {
      target.max_pins_per_day = max_pins_per_day;
      return { data: target, error: null, success: true };
    }
    return { data: null, error: 'Account not found', success: false };
  }

  const { data, error } = await supabase
    .from('accounts')
    .update({ max_pins_per_day })
    .eq('id', id)
    .select('*')
    .single();

  if (error) {
    return { data: null, error: error.message, success: false };
  }
  return { data: data as Account, error: null, success: true };
}

export async function toggleAccountActive(
  id: string,
  is_active: boolean
): Promise<{ data: Account | null; error: string | null; success: boolean }> {
  if (!supabase) {
    const target = mockAccounts.find((a) => a.id === id);
    if (target) {
      target.is_active = is_active;
      return { data: target, error: null, success: true };
    }
    return { data: null, error: 'Account not found', success: false };
  }

  const { data, error } = await supabase
    .from('accounts')
    .update({ is_active })
    .eq('id', id)
    .select('*')
    .single();

  if (error) {
    return { data: null, error: error.message, success: false };
  }
  return { data: data as Account, error: null, success: true };
}

// 17. Fetch Single Account Details
export async function getAccountDetails(accountId: string): Promise<Account | null> {
  let resultAcc: Account | null = null;

  if (!supabase) {
    const acc = mockAccounts.find((a) => a.id === accountId);
    if (!acc) return null;
    const hooks = mockWebhooks.filter((w) => w.account_id === accountId);
    const primaryHook = hooks.find((h) => h.is_primary);
    const boards = mockBoards.filter((b) => b.account_id === accountId);
    const postedPins = mockPins.filter((p) => p.account_id === accountId && p.status === 'posted' && p.posted_at);
    const lastPublished = postedPins.length > 0
      ? [...postedPins].sort((a, b) => new Date(b.posted_at!).getTime() - new Date(a.posted_at!).getTime())[0].posted_at
      : null;

    resultAcc = {
      ...acc,
      board_webhook_id: acc.board_webhook_id || null,
      boards_count: boards.length,
      webhooks_count: hooks.length,
      active_webhooks_count: hooks.filter((h) => h.is_active).length,
      primary_webhook_label: primaryHook ? primaryHook.label : 'None',
      last_published_at: lastPublished || null,
    };
  } else {
    try {
      const { data: accData, error: accError } = await supabase
        .from('accounts')
        .select('*, boards(id), account_webhooks!account_webhooks_account_id_fkey(id, label, is_active, is_primary)')
        .eq('id', accountId)
        .maybeSingle();

      if (accError || !accData) {
        if (accError) {
          console.warn(`Supabase getAccountDetails rich query failed for ${accountId}, attempting fallback:`, accError);
        }
        const { data: fallbackData, error: fallbackError } = await supabase
          .from('accounts')
          .select('*')
          .eq('id', accountId)
          .maybeSingle();

        if (fallbackError) {
          console.error(`Supabase getAccountDetails fallback error for ${accountId}:`, fallbackError);
          throw new Error(fallbackError.message || 'Database error fetching account');
        }
        if (!fallbackData) return null;

        const [boardsRes, hooksRes] = await Promise.all([
          supabase.from('boards').select('id').eq('account_id', accountId),
          supabase.from('account_webhooks').select('id, label, is_active, is_primary').eq('account_id', accountId),
        ]);

        const fallbackHooks = hooksRes.data || [];
        const fallbackPrimary = fallbackHooks.find((h) => h.is_primary);

        resultAcc = {
          ...fallbackData,
          boards_count: (boardsRes.data || []).length,
          webhooks_count: fallbackHooks.length,
          active_webhooks_count: fallbackHooks.filter((h) => h.is_active).length,
          primary_webhook_label: fallbackPrimary ? fallbackPrimary.label : 'None',
          last_published_at: null,
        };
      } else {
        const raw = accData as RawAccount;
        const hooks = raw.account_webhooks || [];
        const primaryHook = hooks.find((h) => h.is_primary);

        let lastPublishedAt: string | null = null;
        try {
          const { data: latestPin } = await supabase
            .from('pins')
            .select('posted_at')
            .eq('account_id', accountId)
            .eq('status', 'posted')
            .not('posted_at', 'is', null)
            .order('posted_at', { ascending: false })
            .limit(1)
            .maybeSingle();

          if (latestPin?.posted_at) {
            lastPublishedAt = latestPin.posted_at;
          }
        } catch (e) {
          console.warn(`Could not fetch last_published_at for ${accountId}:`, e);
        }

        resultAcc = {
          ...raw,
          boards_count: raw.boards ? raw.boards.length : 0,
          webhooks_count: hooks.length,
          active_webhooks_count: hooks.filter((h) => h.is_active).length,
          primary_webhook_label: primaryHook ? primaryHook.label : 'None',
          last_published_at: lastPublishedAt,
        };
      }
    } catch (err) {
      console.error(`Supabase getAccountDetails error for ${accountId}:`, err);
      throw err;
    }
  }

  // Merge active session edits if any
  if (resultAcc && editedAccountScheduleSession.has(accountId)) {
    resultAcc = {
      ...resultAcc,
      ...editedAccountScheduleSession.get(accountId),
    };
  }

  return resultAcc;
}

// 18. Fetch Account Pin Stats (Derived metrics)
export async function getAccountPinStats(accountId: string): Promise<AccountPinStats> {
  if (!supabase) {
    return getMockAccountPinStats(accountId);
  }

  try {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const [
      totalRes,
      pendingRes,
      retryingRes,
      postedRes,
      failedRes,
      accRes,
      todayPostedRes,
    ] = await Promise.all([
      supabase.from('pins').select('*', { count: 'exact', head: true }).eq('account_id', accountId),
      supabase.from('pins').select('*', { count: 'exact', head: true }).eq('account_id', accountId).in('status', ['pending', 'processing']),
      supabase.from('pins').select('*', { count: 'exact', head: true }).eq('account_id', accountId).eq('status', 'pending').gt('retry_count', 0),
      supabase.from('pins').select('*', { count: 'exact', head: true }).eq('account_id', accountId).eq('status', 'posted'),
      supabase.from('pins').select('*', { count: 'exact', head: true }).eq('account_id', accountId).eq('status', 'failed'),
      supabase.from('accounts').select('max_pins_per_day').eq('id', accountId).maybeSingle(),
      supabase.from('pins').select('*', { count: 'exact', head: true }).eq('account_id', accountId).eq('status', 'posted').gte('posted_at', todayStart.toISOString()),
    ]);

    const total = totalRes.count ?? 0;
    const pending = pendingRes.count ?? 0;
    const retrying = retryingRes.count ?? 0;
    const posted = postedRes.count ?? 0;
    const failed = failedRes.count ?? 0;

    const maxDaily = accRes.data ? accRes.data.max_pins_per_day : 20;
    const postedToday = todayPostedRes.count ?? 0;
    const remainingToday = Math.max(0, maxDaily - postedToday);

    return { total, pending, posted, failed, retrying, remainingToday };
  } catch (err) {
    console.warn(`Supabase getAccountPinStats error for ${accountId}:`, err);
    return getMockAccountPinStats(accountId);
  }
}

/**
 * Bulk fetch pin statistics for multiple accounts in a single aggregated DB roundtrip.
 */
export async function getBulkAccountPinStats(accountIds: string[]): Promise<Record<string, AccountPinStats>> {
  const result: Record<string, AccountPinStats> = {};
  if (!accountIds || accountIds.length === 0) return result;

  accountIds.forEach((id) => {
    result[id] = { total: 0, pending: 0, posted: 0, failed: 0, retrying: 0, remainingToday: 20 };
  });

  if (!supabase) {
    accountIds.forEach((id) => {
      result[id] = getMockAccountPinStats(id);
    });
    return result;
  }

  try {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayStr = todayStart.toISOString();

    const [pinsRes, accsRes] = await Promise.all([
      supabase.from('pins').select('id, account_id, status, retry_count, posted_at').in('account_id', accountIds),
      supabase.from('accounts').select('id, max_pins_per_day').in('id', accountIds),
    ]);

    const maxDailyMap = new Map((accsRes.data || []).map((a) => [a.id, a.max_pins_per_day || 20]));

    accountIds.forEach((id) => {
      result[id].remainingToday = maxDailyMap.get(id) || 20;
    });

    if (pinsRes.error || !pinsRes.data) return result;

    const postedTodayMap = new Map<string, number>();

    for (const pin of pinsRes.data) {
      const stats = result[pin.account_id];
      if (!stats) continue;

      stats.total++;
      if (pin.status === 'pending' || pin.status === 'processing') {
        if ((pin.retry_count || 0) > 0) {
          stats.retrying++;
        } else {
          stats.pending++;
        }
      } else if (pin.status === 'posted') {
        stats.posted++;
        if (pin.posted_at && pin.posted_at >= todayStr) {
          const count = (postedTodayMap.get(pin.account_id) || 0) + 1;
          postedTodayMap.set(pin.account_id, count);
        }
      } else if (pin.status === 'failed') {
        stats.failed++;
      }
    }

    accountIds.forEach((id) => {
      const maxDaily = maxDailyMap.get(id) || 20;
      const postedToday = postedTodayMap.get(id) || 0;
      result[id].remainingToday = Math.max(0, maxDaily - postedToday);
    });

    return result;
  } catch (err) {
    console.warn('Supabase getBulkAccountPinStats error:', err);
    accountIds.forEach((id) => {
      result[id] = getMockAccountPinStats(id);
    });
    return result;
  }
}

// 22. Update Account Scheduling Information
export async function updateAccountSchedule(
  accountId: string,
  data: {
    posting_window_start?: string | null;
    posting_window_end?: string | null;
    posting_interval_minutes?: number | null;
    random_delay_minutes?: number | null;
    timezone?: string;
    pinning_started_at?: string | null;
    active_days?: string[] | string;
  }
): Promise<{ data: Partial<Account> | null; error: string | null; success: boolean }> {
  // Always record edits in client session state map
  const existingSession = editedAccountScheduleSession.get(accountId) || {};
  const mergedSession = { ...existingSession, ...data };
  editedAccountScheduleSession.set(accountId, mergedSession);

  // Always update mock data fallback
  const mockAcc = mockAccounts.find((a) => a.id === accountId);
  if (mockAcc) {
    if (data.posting_window_start !== undefined) mockAcc.posting_window_start = data.posting_window_start;
    if (data.posting_window_end !== undefined) mockAcc.posting_window_end = data.posting_window_end;
    if (data.posting_interval_minutes !== undefined && data.posting_interval_minutes !== null) mockAcc.posting_interval_minutes = data.posting_interval_minutes;
    if (data.random_delay_minutes !== undefined && data.random_delay_minutes !== null) mockAcc.random_delay_minutes = data.random_delay_minutes;
    if (data.timezone !== undefined) mockAcc.timezone = data.timezone;
    if (data.pinning_started_at !== undefined) mockAcc.pinning_started_at = data.pinning_started_at;
    if (data.active_days !== undefined) mockAcc.active_days = data.active_days;
  }

  if (!supabase) {
    return { data: (mockAcc || mergedSession) as Account, error: null, success: true };
  }

  try {
    const updatePayload: Record<string, any> = {};
    if (data.posting_window_start !== undefined) updatePayload.posting_window_start = data.posting_window_start;
    if (data.posting_window_end !== undefined) updatePayload.posting_window_end = data.posting_window_end;
    if (data.posting_interval_minutes !== undefined && data.posting_interval_minutes !== null) updatePayload.posting_interval_minutes = data.posting_interval_minutes;
    if (data.random_delay_minutes !== undefined && data.random_delay_minutes !== null) updatePayload.random_delay_minutes = data.random_delay_minutes;
    if (data.timezone !== undefined) updatePayload.timezone = data.timezone;
    if (data.pinning_started_at !== undefined) updatePayload.pinning_started_at = data.pinning_started_at;
    if (data.active_days !== undefined) updatePayload.active_days = data.active_days;

    let updated: any = null;
    let { data: resData, error } = await supabase
      .from('accounts')
      .update(updatePayload)
      .eq('id', accountId)
      .select('*')
      .maybeSingle();

    if (!error && resData) {
      updated = resData;
    } else {
      // Fallback 1: Try without active_days if column not present in DB schema cache
      const payloadWithoutDays = { ...updatePayload };
      delete payloadWithoutDays.active_days;

      const res2 = await supabase
        .from('accounts')
        .update(payloadWithoutDays)
        .eq('id', accountId)
        .select('*')
        .maybeSingle();

      if (!res2.error && res2.data) {
        updated = { ...res2.data, active_days: data.active_days };
        error = null;
      } else {
        // Fallback 2: Core fields only
        const corePayload: Record<string, any> = {};
        if (data.posting_window_start !== undefined) corePayload.posting_window_start = data.posting_window_start;
        if (data.posting_window_end !== undefined) corePayload.posting_window_end = data.posting_window_end;
        if (data.timezone !== undefined) corePayload.timezone = data.timezone;
        if (data.pinning_started_at !== undefined) corePayload.pinning_started_at = data.pinning_started_at;

        const res3 = await supabase
          .from('accounts')
          .update(corePayload)
          .eq('id', accountId)
          .select('*')
          .maybeSingle();

        if (res3.data) {
          updated = { ...res3.data, ...updatePayload };
          error = null;
        } else {
          error = res3.error || error;
        }
      }
    }

    if (!updated) {
      return {
        data: mergedSession as Partial<Account>,
        error: error?.message || 'Schedule update failed',
        success: false,
      };
    }

    // Trigger Pre-Computed Pacing Engine to recalculate pending pin timestamps
    try {
      await rescheduleAccountPendingPins(accountId);
    } catch (e) {
      console.warn('Pre-computed pacing trigger notice:', e);
    }

    return { data: ({ ...mergedSession, ...updated }) as Account, error: null, success: true };
  } catch (err: any) {
    console.warn('updateAccountSchedule failure:', err);
    return { data: mergedSession as Partial<Account>, error: err?.message || 'Schedule update failed', success: false };
  }
}

export const updateAccountScheduling = updateAccountSchedule;

export async function updateAccountAutoBoardSettings(
  accountId: string,
  autoCreate: boolean,
  webhookId?: string | null,
  changedBy: string = 'system'
): Promise<{ success: boolean; error: string | null }> {
  if (!supabase) {
    const acc = mockAccounts.find((a) => a.id === accountId);
    if (acc) {
      acc.auto_create_missing_boards = autoCreate;
      acc.board_creation_webhook_id = webhookId || null;
    }
    return { success: true, error: null };
  }

  try {
    const { error } = await supabase
      .from('accounts')
      .update({
        auto_create_missing_boards: autoCreate,
        board_creation_webhook_id: webhookId || null,
      })
      .eq('id', accountId);

    if (error) return { success: false, error: error.message };

    await supabase.from('audit_log').insert({
      table_name: 'accounts',
      record_id: accountId,
      action: 'UPDATE_AUTO_BOARD_SETTINGS',
      old_data: null,
      new_data: { auto_create_missing_boards: autoCreate, board_creation_webhook_id: webhookId },
      changed_by: changedBy || 'system',
    });

    return { success: true, error: null };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to update auto-board settings' };
  }
}
