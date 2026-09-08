import { supabase } from './supabase-client';
import {
  mockLogs,
  mockAuditLogs,
  mockImportSessions,
  matchesWorkspace,
  type RawLog,
} from './supabase-mock';
import type { Log, AuditLog, ImportSession, PinDeliveryLog } from './types';

// 5. Fetch Logs
export async function getLogs(limit = 50, workspaceId?: string): Promise<Log[]> {
  if (!supabase) return mockLogs.slice(0, limit);
  try {
    let query = supabase
      .from('logs')
      .select('*, accounts(account_name), pins(title), account_webhooks(label)')
      .order('created_at', { ascending: false });

    if (workspaceId) {
      query = query.eq('workspace_id', workspaceId);
    }

    query = query.limit(limit);

    const { data, error } = await query;

    if (error) {
      let basicQuery = supabase
        .from('logs')
        .select('*')
        .order('created_at', { ascending: false });

      if (workspaceId) {
        basicQuery = basicQuery.eq('workspace_id', workspaceId);
      }

      basicQuery = basicQuery.limit(limit);

      const { data: basicData, error: basicErr } = await basicQuery;

      if (basicErr || !basicData) throw basicErr || new Error('No data');
      return basicData as Log[];
    }

    if (!data) return [];
    return (data as RawLog[]).map((l) => ({
      ...l,
      account_name: l.accounts?.account_name || (l.account_id ? 'Account #' + l.account_id.slice(0, 6) : 'System'),
      pin_title: l.pins?.title || 'System Operation',
      webhook_label: l.account_webhooks?.label || 'Default Webhook',
    }));
  } catch (err) {
    console.warn('Supabase fetch logs error, using fallback:', err);
    return mockLogs.slice(0, limit);
  }
}

// 5a. Count Logs (Head count for dashboard KPIs)
export async function countLogs(workspaceId?: string): Promise<number> {
  if (!supabase) {
    if (workspaceId) {
      return mockLogs.filter((l) => matchesWorkspace(l.workspace_id, workspaceId)).length;
    }
    return mockLogs.length;
  }
  try {
    let query = supabase
      .from('logs')
      .select('id', { count: 'exact', head: true });

    if (workspaceId) {
      query = query.eq('workspace_id', workspaceId);
    }

    const { count, error } = await query;
    if (error) throw error;
    return count ?? 0;
  } catch (err) {
    console.warn('Supabase count logs error, using fallback:', err);
    if (workspaceId) {
      return mockLogs.filter((l) => matchesWorkspace(l.workspace_id, workspaceId)).length;
    }
    return mockLogs.length;
  }
}

// 5b. Fetch Pin Delivery Logs (Typed Read Helper for pin_delivery_logs table)
export async function getPinDeliveryLogs(limit = 50, pinId?: string, workspaceId?: string): Promise<PinDeliveryLog[]> {
  if (!supabase) return [];
  try {
    let query = supabase
      .from('pin_delivery_logs')
      .select('*, pins(title, account_id, accounts(account_name))')
      .order('created_at', { ascending: false });

    if (pinId) {
      query = query.eq('pin_id', pinId);
    }

    query = query.limit(limit);

    const { data, error } = await query;

    if (error) {
      let basicQuery = supabase
        .from('pin_delivery_logs')
        .select('*')
        .order('created_at', { ascending: false });

      if (pinId) {
        basicQuery = basicQuery.eq('pin_id', pinId);
      }

      basicQuery = basicQuery.limit(limit);

      const { data: basicData, error: basicErr } = await basicQuery;
      if (basicErr || !basicData) throw basicErr || new Error('No delivery log data');
      return basicData as PinDeliveryLog[];
    }

    if (!data) return [];
    return data.map((item: any) => ({
      id: item.id,
      pin_id: item.pin_id,
      attempt_no: item.attempt_no,
      event_type: item.event_type,
      provider: item.provider,
      http_status: item.http_status,
      error_code: item.error_code,
      error_message: item.error_message,
      response_excerpt: item.response_excerpt,
      metadata: item.metadata,
      created_at: item.created_at,
      pin_title: item.pins?.title || 'Pin #' + item.pin_id.slice(0, 8),
      account_name: item.pins?.accounts?.account_name || 'System Account',
    }));
  } catch (err) {
    console.warn('Supabase fetch pin delivery logs error:', err);
    return [];
  }
}

// 6. Fetch Audit Logs
export async function getAuditLogs(limit = 100): Promise<AuditLog[]> {
  if (!supabase) return mockAuditLogs.slice(0, limit);
  try {
    const { data, error } = await supabase
      .from('audit_log')
      .select('*')
      .order('changed_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return (data as AuditLog[]) || [];
  } catch (err) {
    console.warn('Supabase fetch audit logs error, using fallback:', err);
    return mockAuditLogs.slice(0, limit);
  }
}

// 7. Fetch Import Sessions History
export async function getImportSessions(limit = 10, workspaceId?: string): Promise<ImportSession[]> {
  if (!supabase) return mockImportSessions.slice(0, limit);
  try {
    let query = supabase
      .from('import_sessions')
      .select('*, accounts(account_name)')
      .order('created_at', { ascending: false });

    if (workspaceId) {
      query = query.eq('workspace_id', workspaceId);
    }

    query = query.limit(limit);

    const { data, error } = await query;

    if (error) throw error;
    return (data as any[]).map((s) => ({
      ...s,
      account_name: s.accounts?.account_name || 'Account #' + s.account_id.slice(0, 6),
    }));
  } catch (err) {
    console.warn('Supabase fetch import_sessions error, using fallback:', err);
    return mockImportSessions.slice(0, limit);
  }
}

// 20. Fetch Account Recent Logs
export async function getAccountRecentLogs(accountId: string, limit = 10): Promise<Log[]> {
  if (!supabase) {
    return mockLogs.filter((l) => l.account_id === accountId).slice(0, limit);
  }

  try {
    const { data, error } = await supabase
      .from('logs')
      .select('*, accounts(account_name), pins(title), account_webhooks(label)')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error || !data) return [];
    return (data as RawLog[]).map((l) => ({
      ...l,
      account_name: l.accounts ? l.accounts.account_name : undefined,
      pin_title: l.pins ? l.pins.title : undefined,
      webhook_label: l.account_webhooks ? l.account_webhooks.label : undefined,
    }));
  } catch (err) {
    console.warn(`Supabase getAccountRecentLogs error for ${accountId}:`, err);
    return mockLogs.filter((l) => l.account_id === accountId).slice(0, limit);
  }
}
