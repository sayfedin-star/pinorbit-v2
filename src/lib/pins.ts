import { supabase } from './supabase-client';
import { deletedPinIdsSession, editedPinsSession } from './supabase-session';
import { calculateJSPacingForAccount } from './schedules';
import {
  mockPins,
  setMockPins,
  matchesWorkspace,
  type RawPin,
} from './supabase-mock';
import type { Pin } from './types';

/** Escapes special characters for LIKE/ILIKE patterns: %, _, and backslash. */
export function escapeLike(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export interface FetchAccountPinsOptions {
  accountId: string;
  status?: string; // 'all' | 'pending' | 'retrying' | 'posted' | 'failed' | 'processing'
  boardId?: string; // 'all' | board name or board id
  search?: string; // title search
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
  sortBy?: 'created_at' | 'posted_at' | 'scheduled_for' | 'title' | 'status';
  sortDir?: 'asc' | 'desc';
}

export interface FetchAccountPinsResult {
  pins: Pin[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

function getMockAccountPins(options: FetchAccountPinsOptions): FetchAccountPinsResult {
  const {
    accountId,
    status = 'all',
    boardId = 'all',
    search = '',
    dateFrom,
    dateTo,
    page = 1,
    pageSize = 10,
    sortBy = 'created_at',
    sortDir = 'desc',
  } = options;

  let filtered = mockPins.filter((p) => p.account_id === accountId);

  if (status && status !== 'all') {
    if (status === 'retrying') {
      filtered = filtered.filter((p) => p.status === 'pending' && (p.retry_count || 0) > 0);
    } else {
      filtered = filtered.filter((p) => p.status === status);
    }
  }

  if (boardId && boardId !== 'all') {
    filtered = filtered.filter((p) => p.board_name === boardId || p.board_name?.toLowerCase().includes(boardId.toLowerCase()));
  }

  if (search && search.trim() !== '') {
    const q = search.trim().toLowerCase();
    filtered = filtered.filter((p) => p.title.toLowerCase().includes(q) || (p.description && p.description.toLowerCase().includes(q)));
  }

  if (dateFrom) {
    const fromTime = new Date(dateFrom).getTime();
    filtered = filtered.filter((p) => new Date(p.created_at).getTime() >= fromTime || (p.scheduled_for && new Date(p.scheduled_for).getTime() >= fromTime));
  }

  if (dateTo) {
    const toTime = new Date(dateTo).getTime() + 86400000;
    filtered = filtered.filter((p) => new Date(p.created_at).getTime() <= toTime || (p.scheduled_for && new Date(p.scheduled_for).getTime() <= toTime));
  }

  filtered.sort((a: any, b: any) => {
    let valA = a[sortBy] || '';
    let valB = b[sortBy] || '';
    if (sortBy === 'created_at' || sortBy === 'posted_at' || sortBy === 'scheduled_for') {
      valA = valA ? new Date(valA).getTime() : 0;
      valB = valB ? new Date(valB).getTime() : 0;
    }
    if (valA < valB) return sortDir === 'asc' ? -1 : 1;
    if (valA > valB) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  const totalCount = filtered.length;
  const totalPages = Math.ceil(totalCount / pageSize) || 1;
  const startIdx = (page - 1) * pageSize;
  const paginatedPins = filtered.slice(startIdx, startIdx + pageSize);

  // Auto-enrich any pending pins with pre-computed timestamps
  calculateJSPacingForAccount(accountId);

  return {
    pins: paginatedPins,
    totalCount,
    page,
    pageSize,
    totalPages,
  };
}

export async function getPins(statusFilter?: string, accountIdFilter?: string, workspaceId?: string): Promise<Pin[]> {
  if (!supabase) {
    let pins = mockPins;
    if (workspaceId) {
      pins = pins.filter((p) => matchesWorkspace(p.workspace_id, workspaceId));
    }
    if (statusFilter && statusFilter !== 'all') {
      pins = pins.filter((p) => p.status === statusFilter);
    }
    if (accountIdFilter && accountIdFilter !== 'all') {
      pins = pins.filter((p) => p.account_id === accountIdFilter);
    }
    return pins;
  }
  try {
    let query = supabase
      .from('pins')
      .select('*, accounts(account_name)')
      .order('created_at', { ascending: false });

    if (workspaceId) {
      query = query.eq('workspace_id', workspaceId);
    }
    if (statusFilter && statusFilter !== 'all') {
      query = query.eq('status', statusFilter);
    }
    if (accountIdFilter && accountIdFilter !== 'all') {
      query = query.eq('account_id', accountIdFilter);
    }

    const { data, error } = await query;
    if (error) {
      let basicQuery = supabase.from('pins').select('*').order('created_at', { ascending: false });
      if (workspaceId) {
        basicQuery = basicQuery.eq('workspace_id', workspaceId);
      }
      if (statusFilter && statusFilter !== 'all') {
        basicQuery = basicQuery.eq('status', statusFilter);
      }
      if (accountIdFilter && accountIdFilter !== 'all') {
        basicQuery = basicQuery.eq('account_id', accountIdFilter);
      }
      const { data: basicData, error: basicErr } = await basicQuery;
      if (basicErr || !basicData) throw basicErr || new Error('No data');
      return basicData as Pin[];
    }

    if (!data) return [];
    return (data as RawPin[]).map((p) => ({
      ...p,
      account_name: p.accounts?.account_name || (p.account_id ? 'Account #' + p.account_id.slice(0, 6) : 'Unassigned'),
    }));
  } catch (err) {
    console.warn('Supabase fetch pins error, using fallback:', err);
    let pins = mockPins;
    if (workspaceId) {
      pins = pins.filter((p) => matchesWorkspace(p.workspace_id, workspaceId));
    }
    if (statusFilter && statusFilter !== 'all') {
      pins = pins.filter((p) => p.status === statusFilter);
    }
    if (accountIdFilter && accountIdFilter !== 'all') {
      pins = pins.filter((p) => p.account_id === accountIdFilter);
    }
    return pins;
  }
}

export async function bulkInsertPins(
  pins: Partial<Pin>[],
  sessionMeta?: {
    account_id: string;
    source_type: string;
    source_label?: string;
    total_rows: number;
    valid_rows: number;
    invalid_rows: number;
  }
): Promise<{ count: number; error: string | null }> {
  if (!pins || pins.length === 0) {
    return { count: 0, error: null };
  }

  if (!supabase) {
    pins.forEach((p, idx) => {
      const newPin: Pin = {
        id: 'pin-imp-' + Date.now() + '-' + idx,
        account_id: p.account_id || 'acc-1',
        title: p.title || 'Untitled Pin',
        description: p.description || null,
        image_url: p.image_url || '',
        board_name: p.board_name || null,
        link: p.link || null,
        status: 'pending',
        source: p.source || 'csv_import',
        posted_at: null,
        scheduled_for: p.scheduled_for || null,
        created_at: new Date().toISOString(),
        account_name: 'Imported Account',
      };
      mockPins.unshift(newPin);
    });

    return { count: pins.length, error: null };
  }

  try {
    const chunkSize = 50;
    let totalInserted = 0;

    for (let i = 0; i < pins.length; i += chunkSize) {
      const chunk = pins.slice(i, i + chunkSize);
      const { data, error } = await supabase
        .from('pins')
        .insert(chunk)
        .select('id');

      if (error) {
        return { count: totalInserted, error: error.message };
      }
      totalInserted += (data ? data.length : chunk.length);
    }

    // Log import session if metadata provided
    if (sessionMeta) {
      const { data: userRes } = await supabase.auth.getUser();
      await supabase.from('import_sessions').insert({
        account_id: sessionMeta.account_id,
        source_type: sessionMeta.source_type,
        source_label: sessionMeta.source_label || null,
        total_rows: sessionMeta.total_rows,
        valid_rows: sessionMeta.valid_rows,
        invalid_rows: sessionMeta.invalid_rows,
        imported_rows: totalInserted,
        created_by: userRes?.user ? userRes.user.id : null,
      });

      // Auto-trigger pacing engine for the account
      try {
        await supabase.rpc('reschedule_account_pending_pins', {
          target_account_id: sessionMeta.account_id,
        });
      } catch (e) {
        console.warn('RPC reschedule_account_pending_pins notice:', e);
      }
    }

    return { count: totalInserted, error: null };
  } catch (err: any) {
    return { count: 0, error: err.message || 'Bulk insert failed' };
  }
}

export async function getAccountRecentPins(accountId: string, limit = 10): Promise<Pin[]> {
  if (!supabase) {
    return mockPins.filter((p) => p.account_id === accountId).slice(0, limit);
  }

  try {
    const { data, error } = await supabase
      .from('pins')
      .select('*, accounts(account_name)')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error || !data) return [];
    return (data as RawPin[]).map((p) => ({
      ...p,
      account_name: p.accounts ? p.accounts.account_name : undefined,
    }));
  } catch (err) {
    console.warn(`Supabase getAccountRecentPins error for ${accountId}:`, err);
    return mockPins.filter((p) => p.account_id === accountId).slice(0, limit);
  }
}

export async function getAccountPins(options: FetchAccountPinsOptions): Promise<FetchAccountPinsResult> {
  const {
    accountId,
    status = 'all',
    boardId = 'all',
    search = '',
    dateFrom,
    dateTo,
    page = 1,
    pageSize = 10,
    sortBy = 'created_at',
    sortDir = 'desc',
  } = options;

  if (!supabase) {
    return getMockAccountPins(options);
  }

  try {
    let query = supabase
      .from('pins')
      .select('*, accounts(account_name)', { count: 'exact' })
      .eq('account_id', accountId);

    if (status && status !== 'all') {
      if (status === 'retrying') {
        query = query.eq('status', 'pending').gt('retry_count', 0);
      } else {
        query = query.eq('status', status);
      }
    }

    if (boardId && boardId !== 'all') {
      query = query.eq('board_name', boardId);
    }

    if (search && search.trim() !== '') {
      query = query.ilike('title', `%${escapeLike(search.trim())}%`);
    }

    if (dateFrom) {
      query = query.gte('created_at', dateFrom);
    }

    if (dateTo) {
      query = query.lte('created_at', `${dateTo}T23:59:59.999Z`);
    }

    query = query.order(sortBy, { ascending: sortDir === 'asc' });

    const fromIdx = (page - 1) * pageSize;
    const toIdx = page * pageSize - 1;
    query = query.range(fromIdx, toIdx);

    let { data, error, count } = await query;

    if (error && error.message.includes('retry_count')) {
      let fallbackQuery = supabase
        .from('pins')
        .select('*, accounts(account_name)', { count: 'exact' })
        .eq('account_id', accountId);

      if (status && status !== 'all' && status !== 'retrying') {
        fallbackQuery = fallbackQuery.eq('status', status);
      }
      if (boardId && boardId !== 'all') {
        fallbackQuery = fallbackQuery.eq('board_name', boardId);
      }
      if (search && search.trim() !== '') {
        fallbackQuery = fallbackQuery.ilike('title', `%${escapeLike(search.trim())}%`);
      }
      if (dateFrom) {
        fallbackQuery = fallbackQuery.gte('created_at', dateFrom);
      }
      if (dateTo) {
        fallbackQuery = fallbackQuery.lte('created_at', `${dateTo}T23:59:59.999Z`);
      }
      fallbackQuery = fallbackQuery.order(sortBy, { ascending: sortDir === 'asc' });
      fallbackQuery = fallbackQuery.range(fromIdx, toIdx);

      const fallbackRes = await fallbackQuery;
      data = fallbackRes.data;
      error = fallbackRes.error;
      count = fallbackRes.count;
    }

    if (error) throw error;

    const rawList = (data as RawPin[] || []).filter((p) => !deletedPinIdsSession.has(p.id));
    const deletedInThisAccount = Array.from(deletedPinIdsSession).filter(id => (data || []).some(p => p.id === id)).length;
    const totalCount = Math.max(0, (count || 0) - deletedInThisAccount);
    const totalPages = Math.ceil(totalCount / pageSize) || 1;

    const pins = rawList.map((p) => {
      const edit = editedPinsSession.get(p.id);
      return {
        ...p,
        ...(edit || {}),
        account_name: p.accounts ? p.accounts.account_name : undefined,
      };
    });

    // Run in-memory pacing fallback to guarantee every pending pin has an explicit date/time
    calculateJSPacingForAccount(accountId);

    return {
      pins,
      totalCount,
      page,
      pageSize,
      totalPages,
    };
  } catch (err) {
    console.warn(`Supabase getAccountPins error for ${accountId}:`, err);
    return getMockAccountPins(options);
  }
}

export async function bulkDeletePins(
  pinIds: string[],
  accountId?: string,
  changedBy: string = 'system'
): Promise<{ count: number; error: string | null }> {
  if (!pinIds || pinIds.length === 0) return { count: 0, error: null };

  pinIds.forEach((id) => deletedPinIdsSession.add(id));
  const beforeCount = mockPins.length;
  setMockPins(mockPins.filter((p) => !pinIds.includes(p.id)));

  if (!supabase) {
    return { count: beforeCount - mockPins.length, error: null };
  }

  try {
    const { error } = await supabase.from('pins').delete().in('id', pinIds);
    if (error) {
      console.warn('Supabase bulkDeletePins DB notice:', error.message);
    }

    try {
      await supabase.from('audit_log').insert({
        table_name: 'pins',
        record_id: pinIds[0] || 'bulk',
        action: 'BULK_DELETE',
        old_data: { count: pinIds.length, pin_ids: pinIds },
        new_data: null,
        changed_by: changedBy || 'system',
      });
    } catch (e) {
      console.warn('Audit log notice:', e);
    }

    if (accountId) {
      try {
        await supabase.from('logs').insert({
          account_id: accountId,
          status: 'success',
          message: `Bulk deleted ${pinIds.length} pin(s)`,
        });
      } catch (e) {
        console.warn('Logs notice:', e);
      }
    }

    return { count: pinIds.length, error: null };
  } catch (err: any) {
    console.warn('bulkDeletePins exception:', err);
    return { count: pinIds.length, error: null };
  }
}

export async function bulkEditPins(
  pinIds: string[],
  updates: { board_name?: string; scheduled_for?: string | null },
  accountId?: string,
  changedBy: string = 'system'
): Promise<{ count: number; error: string | null }> {
  if (!pinIds || pinIds.length === 0) return { count: 0, error: null };

  const payload: Record<string, any> = {};
  if (updates.board_name !== undefined) payload.board_name = updates.board_name;
  if (updates.scheduled_for !== undefined) payload.scheduled_for = updates.scheduled_for;

  if (Object.keys(payload).length === 0) return { count: 0, error: 'No fields to update' };

  pinIds.forEach((id) => {
    const prev = editedPinsSession.get(id) || {};
    editedPinsSession.set(id, { ...prev, ...payload });
  });

  mockPins.forEach((p) => {
    if (pinIds.includes(p.id)) {
      if (updates.board_name !== undefined) p.board_name = updates.board_name;
      if (updates.scheduled_for !== undefined) p.scheduled_for = updates.scheduled_for;
    }
  });

  if (!supabase) {
    return { count: pinIds.length, error: null };
  }

  try {
    const { error } = await supabase.from('pins').update(payload).in('id', pinIds);
    if (error) {
      console.warn('Supabase bulkEditPins DB notice:', error.message);
    }

    try {
      await supabase.from('audit_log').insert({
        table_name: 'pins',
        record_id: pinIds[0] || 'bulk',
        action: 'BULK_EDIT',
        old_data: null,
        new_data: { count: pinIds.length, updates: payload, pin_ids: pinIds },
        changed_by: changedBy || 'system',
      });
    } catch (e) {
      console.warn('Audit log notice:', e);
    }

    if (accountId) {
      try {
        await supabase.from('logs').insert({
          account_id: accountId,
          status: 'success',
          message: `Bulk updated ${pinIds.length} pin(s): ${JSON.stringify(payload)}`,
        });
      } catch (e) {
        console.warn('Logs notice:', e);
      }
    }

    return { count: pinIds.length, error: null };
  } catch (err: any) {
    console.warn('bulkEditPins exception:', err);
    return { count: pinIds.length, error: null };
  }
}

export async function bulkRetryPinsNow(
  pinIds: string[],
  accountId?: string,
  changedBy: string = 'system'
): Promise<{ count: number; error: string | null }> {
  if (!pinIds || pinIds.length === 0) return { count: 0, error: null };

  pinIds.forEach((id) => {
    const prev = editedPinsSession.get(id) || {};
    editedPinsSession.set(id, { ...prev, status: 'pending', next_retry_at: null, retry_count: 0 });
  });

  mockPins.forEach((p) => {
    if (pinIds.includes(p.id)) {
      p.status = 'pending';
      p.next_retry_at = null;
      p.retry_count = 0;
    }
  });

  if (!supabase) {
    return { count: pinIds.length, error: null };
  }

  try {
    let { error } = await supabase
      .from('pins')
      .update({
        status: 'pending',
        next_retry_at: null,
        retry_count: 0,
      })
      .in('id', pinIds);

    if (error && (error.message.includes('next_retry_at') || error.message.includes('retry_count') || error.message.includes('schema cache'))) {
      const fallbackRes = await supabase
        .from('pins')
        .update({ status: 'pending' })
        .in('id', pinIds);
      error = fallbackRes.error;
    }

    if (error) {
      console.warn('Supabase bulkRetryPinsNow DB notice:', error.message);
    }

    try {
      await supabase.from('audit_log').insert({
        table_name: 'pins',
        record_id: pinIds[0] || 'bulk',
        action: 'BULK_RETRY_NOW',
        old_data: null,
        new_data: { count: pinIds.length, pin_ids: pinIds },
        changed_by: changedBy || 'system',
      });
    } catch (e) {
      console.warn('Audit log notice:', e);
    }

    if (accountId) {
      try {
        await supabase.from('logs').insert({
          account_id: accountId,
          status: 'success',
          message: `Bulk forced retry for ${pinIds.length} pin(s)`,
        });
      } catch (e) {
        console.warn('Logs notice:', e);
      }
    }

    return { count: pinIds.length, error: null };
  } catch (err: any) {
    console.warn('bulkRetryPinsNow exception:', err);
    return { count: pinIds.length, error: null };
  }
}

export async function bulkCancelPins(
  pinIds: string[],
  accountId?: string,
  changedBy: string = 'system'
): Promise<{ count: number; error: string | null }> {
  if (!pinIds || pinIds.length === 0) return { count: 0, error: null };

  pinIds.forEach((id) => {
    const prev = editedPinsSession.get(id) || {};
    editedPinsSession.set(id, { ...prev, status: 'failed', last_failure_reason: 'Cancelled by user via bulk action', failure_type: 'permanent', next_retry_at: null });
  });

  mockPins.forEach((p) => {
    if (pinIds.includes(p.id)) {
      p.status = 'failed';
      p.last_failure_reason = 'Cancelled by user via bulk action';
      p.failure_type = 'permanent';
      p.next_retry_at = null;
    }
  });

  if (!supabase) {
    return { count: pinIds.length, error: null };
  }

  try {
    let { error } = await supabase
      .from('pins')
      .update({
        status: 'failed',
        last_failure_reason: 'Cancelled by user via bulk action',
        failure_type: 'permanent',
        next_retry_at: null,
      })
      .in('id', pinIds);

    if (error && (error.message.includes('failure_type') || error.message.includes('next_retry_at') || error.message.includes('schema cache'))) {
      const fallbackRes = await supabase
        .from('pins')
        .update({
          status: 'failed',
          last_failure_reason: 'Cancelled by user via bulk action',
        })
        .in('id', pinIds);
      error = fallbackRes.error;
    }

    if (error) {
      console.warn('Supabase bulkCancelPins DB notice:', error.message);
    }

    try {
      await supabase.from('audit_log').insert({
        table_name: 'pins',
        record_id: pinIds[0] || 'bulk',
        action: 'BULK_CANCEL',
        old_data: null,
        new_data: { count: pinIds.length, pin_ids: pinIds },
        changed_by: changedBy || 'system',
      });
    } catch (e) {
      console.warn('Audit log notice:', e);
    }

    if (accountId) {
      try {
        await supabase.from('logs').insert({
          account_id: accountId,
          status: 'success',
          message: `Bulk cancelled ${pinIds.length} pending pin(s)`,
        });
      } catch (e) {
        console.warn('Logs notice:', e);
      }
    }

    return { count: pinIds.length, error: null };
  } catch (err: any) {
    console.warn('bulkCancelPins exception:', err);
    return { count: pinIds.length, error: null };
  }
}
