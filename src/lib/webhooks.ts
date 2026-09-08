import { supabase } from './supabase-client';
import {
  mockWebhooks,
  setMockWebhooks,
} from './supabase-mock';
import type { AccountWebhook, AccountWebhookSummary } from './types';

// 2. Fetch Account Webhooks
export async function getAccountWebhooks(accountId?: string, workspaceId?: string): Promise<AccountWebhook[]> {
  if (!supabase) {
    if (!accountId) return mockWebhooks;
    return mockWebhooks.filter((w) => w.account_id === accountId);
  }
  try {
    let query = supabase
      .from('account_webhooks')
      .select('*')
      .order('priority', { ascending: true })
      .order('created_at', { ascending: true });

    if (accountId) {
      query = query.eq('account_id', accountId);
    } else if (workspaceId) {
      const { data: accs } = await supabase.from('accounts').select('id').eq('workspace_id', workspaceId);
      if (accs && accs.length > 0) {
        const accIds = accs.map((a: any) => a.id);
        query = query.in('account_id', accIds);
      } else {
        return [];
      }
    }

    const { data, error } = await query;
    if (error) throw error;
    return (data as AccountWebhook[]) || [];
  } catch (err) {
    console.warn('Supabase fetch account_webhooks error, using fallback:', err);
    if (!accountId) return mockWebhooks;
    return mockWebhooks.filter((w) => w.account_id === accountId);
  }
}

export async function getBulkAccountWebhooks(accountIds: string[]): Promise<Map<string, AccountWebhook[]>> {
  const map = new Map<string, AccountWebhook[]>();
  if (!accountIds || accountIds.length === 0) return map;

  if (!supabase) {
    mockWebhooks.forEach((w) => {
      if (accountIds.includes(w.account_id)) {
        const list = map.get(w.account_id) || [];
        list.push(w);
        map.set(w.account_id, list);
      }
    });
    return map;
  }

  try {
    const { data, error } = await supabase
      .from('account_webhooks')
      .select('*')
      .in('account_id', accountIds)
      .order('priority', { ascending: true })
      .order('created_at', { ascending: true });

    if (error || !data) return map;

    (data as AccountWebhook[]).forEach((w) => {
      const list = map.get(w.account_id) || [];
      list.push(w);
      map.set(w.account_id, list);
    });
    return map;
  } catch (err) {
    console.warn('Supabase getBulkAccountWebhooks error:', err);
    return map;
  }
}

export async function createAccountWebhook(payload: {
  account_id: string;
  label: string;
  webhook_url: string;
  monthly_capacity?: number;
  priority?: number;
  is_active?: boolean;
  is_primary?: boolean;
}): Promise<{ data: AccountWebhook | null; error: string | null }> {
  if (!supabase) {
    if (payload.is_primary) {
      mockWebhooks.forEach((w) => {
        if (w.account_id === payload.account_id) w.is_primary = false;
      });
    }

    const cap = payload.monthly_capacity ?? 500;
    const newHook: AccountWebhook = {
      id: 'hook-' + Date.now(),
      account_id: payload.account_id,
      label: payload.label,
      webhook_url: payload.webhook_url,
      monthly_capacity: cap,
      monthly_usage: 0,
      remaining_capacity: cap,
      priority: payload.priority ?? 1,
      is_active: payload.is_active ?? true,
      is_primary: payload.is_primary ?? false,
      last_used_at: null,
      last_failed_at: null,
      last_failure_reason: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    mockWebhooks.unshift(newHook);
    return { data: newHook, error: null };
  }

  try {
    if (payload.is_primary) {
      await supabase
        .from('account_webhooks')
        .update({ is_primary: false })
        .eq('account_id', payload.account_id);
    }

    const { data, error } = await supabase
      .from('account_webhooks')
      .insert({
        account_id: payload.account_id,
        label: payload.label,
        webhook_url: payload.webhook_url,
        monthly_capacity: payload.monthly_capacity ?? 500,
        priority: payload.priority ?? 1,
        is_active: payload.is_active ?? true,
        is_primary: payload.is_primary ?? false,
      })
      .select('*')
      .single();

    if (error) return { data: null, error: error.message };
    return { data: data as AccountWebhook, error: null };
  } catch (err: any) {
    return { data: null, error: err.message || 'Error creating webhook' };
  }
}

export async function updateAccountWebhook(
  id: string,
  payload: Partial<{
    label: string;
    webhook_url: string;
    monthly_capacity: number;
    monthly_usage: number;
    priority: number;
    is_active: boolean;
    is_primary: boolean;
    last_failure_reason: string | null;
  }>
): Promise<{ data: AccountWebhook | null; error: string | null }> {
  if (!supabase) {
    const target = mockWebhooks.find((w) => w.id === id);
    if (target) {
      if (payload.is_primary) {
        mockWebhooks.forEach((w) => {
          if (w.account_id === target.account_id) w.is_primary = false;
        });
      }
      Object.assign(target, payload);
      target.remaining_capacity = target.monthly_capacity - target.monthly_usage;
      target.updated_at = new Date().toISOString();
      return { data: target, error: null };
    }
    return { data: null, error: 'Webhook not found' };
  }

  try {
    if (payload.is_primary) {
      const { data: targetHook } = await supabase
        .from('account_webhooks')
        .select('account_id')
        .eq('id', id)
        .single();

      if (targetHook) {
        await supabase
          .from('account_webhooks')
          .update({ is_primary: false })
          .eq('account_id', targetHook.account_id);
      }
    }

    const { data, error } = await supabase
      .from('account_webhooks')
      .update(payload)
      .eq('id', id)
      .select('*')
      .single();

    if (error) return { data: null, error: error.message };
    return { data: data as AccountWebhook, error: null };
  } catch (err: any) {
    return { data: null, error: err.message || 'Error updating webhook' };
  }
}

export async function setPrimaryWebhook(
  id: string,
  accountId: string
): Promise<{ success: boolean; error: string | null }> {
  if (!supabase) {
    mockWebhooks.forEach((w) => {
      if (w.account_id === accountId) {
        w.is_primary = w.id === id;
      }
    });
    return { success: true, error: null };
  }

  try {
    await supabase
      .from('account_webhooks')
      .update({ is_primary: false })
      .eq('account_id', accountId);

    const { error } = await supabase
      .from('account_webhooks')
      .update({ is_primary: true })
      .eq('id', id);

    if (error) return { success: false, error: error.message };
    return { success: true, error: null };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed setting primary webhook' };
  }
}

export async function toggleAccountWebhookActive(
  id: string,
  is_active: boolean
): Promise<{ data: AccountWebhook | null; error: string | null }> {
  return updateAccountWebhook(id, { is_active });
}

export async function deleteAccountWebhook(
  id: string,
  workspaceId?: string
): Promise<{ success: boolean; error: string | null }> {
  if (!supabase) {
    setMockWebhooks(mockWebhooks.filter((w) => w.id !== id));
    return { success: true, error: null };
  }
  try {
    let query = supabase.from('account_webhooks').delete().eq('id', id);
    if (workspaceId) {
      query = query.eq('workspace_id', workspaceId);
    }
    const { error } = await query;
    if (error) return { success: false, error: error.message };
    return { success: true, error: null };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to delete webhook' };
  }
}

export async function getAccountWebhookSummary(accountId: string): Promise<AccountWebhookSummary> {
  const webhooks = await getAccountWebhooks(accountId);
  const totalWebhooks = webhooks.length;
  const activeWebhooks = webhooks.filter((w) => w.is_active).length;
  const primaryHook = webhooks.find((w) => w.is_primary);
  const primaryWebhookLabel = primaryHook ? primaryHook.label : 'None';
  const totalRemainingCapacity = webhooks
    .filter((w) => w.is_active)
    .reduce((sum, w) => sum + (w.remaining_capacity || 0), 0);

  return {
    totalWebhooks,
    activeWebhooks,
    primaryWebhookLabel,
    totalRemainingCapacity,
  };
}
