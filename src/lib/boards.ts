import { supabase } from './supabase-client';
import {
  mockAccounts,
  mockBoards,
  matchesWorkspace,
  type RawBoard,
} from './supabase-mock';
import type { Board } from './types';

export interface CreateBoardOptions {
  accountId: string;
  boardName: string;
  webhookId?: string | null;
  triggerSource?: 'import_manual' | 'import_auto' | 'account_details_manual';
}

export interface CreateBoardResult {
  success: boolean;
  board?: Board;
  reused?: boolean;
  error?: string;
  pinterest_board_id?: string;
}

export async function getBoards(workspaceId?: string): Promise<Board[]> {
  if (!supabase) {
    return workspaceId ? mockBoards.filter((b) => matchesWorkspace(b.workspace_id, workspaceId)) : mockBoards;
  }
  try {
    let query = supabase
      .from('boards')
      .select('*, accounts(account_name)')
      .order('created_at', { ascending: false });

    if (workspaceId) {
      query = query.eq('workspace_id', workspaceId);
    }

    const { data, error } = await query;

    if (error) {
      let basicQuery = supabase
        .from('boards')
        .select('*')
        .order('created_at', { ascending: false });

      if (workspaceId) {
        basicQuery = basicQuery.eq('workspace_id', workspaceId);
      }

      const { data: basicData, error: basicErr } = await basicQuery;

      if (basicErr || !basicData) throw basicErr || new Error('No data');
      return basicData as Board[];
    }

    if (!data) return [];
    return (data as RawBoard[]).map((b) => ({
      ...b,
      account_name: b.accounts?.account_name || 'Account #' + b.account_id.slice(0, 6),
    }));
  } catch (err) {
    console.warn('Supabase fetch boards error, using fallback:', err);
    return workspaceId ? mockBoards.filter((b) => matchesWorkspace(b.workspace_id, workspaceId)) : mockBoards;
  }
}

// Fetch Boards for specific account
export async function getBoardsForAccount(accountId: string): Promise<Board[]> {
  if (!supabase) {
    return mockBoards.filter((b) => b.account_id === accountId);
  }
  try {
    const { data, error } = await supabase
      .from('boards')
      .select('*')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return (data as Board[]) || [];
  } catch (err) {
    console.warn('Supabase fetch boards for account error, using fallback:', err);
    return mockBoards.filter((b) => b.account_id === accountId);
  }
}

export async function getBulkAccountBoards(accountIds: string[]): Promise<Map<string, Board[]>> {
  const map = new Map<string, Board[]>();
  if (!accountIds || accountIds.length === 0) return map;

  if (!supabase) {
    mockBoards.forEach((b) => {
      if (accountIds.includes(b.account_id)) {
        const list = map.get(b.account_id) || [];
        list.push(b);
        map.set(b.account_id, list);
      }
    });
    return map;
  }

  try {
    const { data, error } = await supabase
      .from('boards')
      .select('*, accounts(account_name)')
      .in('account_id', accountIds)
      .order('created_at', { ascending: false });

    if (error || !data) return map;

    (data as RawBoard[]).forEach((raw) => {
      const b: Board = {
        ...raw,
        account_name: raw.accounts?.account_name || 'Account #' + raw.account_id.slice(0, 6),
      };
      const list = map.get(b.account_id) || [];
      list.push(b);
      map.set(b.account_id, list);
    });
    return map;
  } catch (err) {
    console.warn('Supabase fetch boards error, using fallback:', err);
    return map;
  }
}

export async function createBoard(payload: {
  account_id: string;
  board_name: string;
  board_id: string;
}): Promise<{ data: Board | null; error: string | null }> {
  if (!supabase) {
    const acc = mockAccounts.find((a) => a.id === payload.account_id);
    const newBoard: Board = {
      id: 'board-' + Date.now(),
      account_id: payload.account_id,
      board_name: payload.board_name,
      board_id: payload.board_id,
      created_at: new Date().toISOString(),
      account_name: acc?.account_name || 'Account',
    };
    mockBoards.unshift(newBoard);
    if (acc) {
      acc.boards_count = (acc.boards_count || 0) + 1;
    }
    return { data: newBoard, error: null };
  }

  const { data, error } = await supabase
    .from('boards')
    .insert({
      account_id: payload.account_id,
      board_name: payload.board_name,
      board_id: payload.board_id,
    })
    .select('*')
    .single();

  if (error) {
    return { data: null, error: error.message };
  }
  return { data: data as Board, error: null };
}

export async function updateBoard(
  id: string,
  payload: {
    board_name: string;
    board_id: string;
    account_id?: string;
  }
): Promise<{ data: Board | null; error: string | null }> {
  if (!supabase) {
    const target = mockBoards.find((b) => b.id === id);
    if (target) {
      target.board_name = payload.board_name;
      target.board_id = payload.board_id;
      if (payload.account_id) {
        target.account_id = payload.account_id;
        const acc = mockAccounts.find((a) => a.id === payload.account_id);
        if (acc) target.account_name = acc.account_name;
      }
      return { data: target, error: null };
    }
    return { data: null, error: 'Board not found' };
  }

  const updateData: { board_name: string; board_id: string; account_id?: string } = {
    board_name: payload.board_name,
    board_id: payload.board_id,
  };
  if (payload.account_id) {
    updateData.account_id = payload.account_id;
  }

  const { data, error } = await supabase
    .from('boards')
    .update(updateData)
    .eq('id', id)
    .select('*')
    .single();

  if (error) {
    return { data: null, error: error.message };
  }
  return { data: data as Board, error: null };
}

export async function getAccountBoards(accountId: string): Promise<Board[]> {
  if (!supabase) {
    return mockBoards.filter((b) => b.account_id === accountId);
  }
  try {
    const { data, error } = await supabase
      .from('boards')
      .select('*')
      .eq('account_id', accountId)
      .order('board_name', { ascending: true });
    if (error || !data) return mockBoards.filter((b) => b.account_id === accountId);
    return data as Board[];
  } catch (err) {
    console.warn(`Supabase getAccountBoards error for ${accountId}:`, err);
    return mockBoards.filter((b) => b.account_id === accountId);
  }
}

export async function createBoardViaWebhook(options: CreateBoardOptions): Promise<CreateBoardResult> {
  const { accountId, boardName, webhookId } = options;

  if (!boardName || !boardName.trim()) {
    return { success: false, error: 'Board name is required' };
  }

  const rawTrimmed = boardName.trim();
  const normalizedName = rawTrimmed.toLowerCase();

  // 1. Client-side Idempotency Pre-check
  const existingBoards = await getAccountBoards(accountId);
  const matchedBoard = existingBoards.find((b) => b.board_name.trim().toLowerCase() === normalizedName);

  if (matchedBoard) {
    return {
      success: true,
      board: matchedBoard,
      reused: true,
      pinterest_board_id: matchedBoard.pinterest_board_id || matchedBoard.board_id,
    };
  }

  // 2. Dispatch via server funnel /api/boards/action
  try {
    const res = await fetch('/api/boards/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: accountId,
        action: 'create',
        board_name: rawTrimmed,
        webhook_id: webhookId || undefined,
      }),
    });
    const d = await res.json();
    if (!res.ok) {
      return { success: false, error: d.error || 'Failed to dispatch board creation' };
    }
    return {
      success: true,
      board: {
        id: `board-${Date.now()}`,
        account_id: accountId,
        board_name: rawTrimmed,
        board_id: '',
        pinterest_board_id: '',
        created_via: 'webhook_auto_create',
        created_via_webhook_id: webhookId || null,
        created_at: new Date().toISOString(),
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to dispatch board creation' };
  }
}

export async function bulkCreateMissingBoardsViaWebhook(params: {
  accountId: string;
  boardNames: string[];
  webhookId?: string | null;
  triggerSource?: 'import_manual' | 'import_auto';
}): Promise<{
  createdCount: number;
  reusedCount: number;
  failedCount: number;
  boards: Board[];
  errors: string[];
}> {
  const { accountId, boardNames, webhookId, triggerSource = 'import_manual' } = params;
  const uniqueNames = Array.from(new Set(boardNames.map((n) => n.trim()).filter((n) => n.length > 0)));

  let createdCount = 0;
  let reusedCount = 0;
  let failedCount = 0;
  const createdBoards: Board[] = [];
  const errors: string[] = [];

  // Batch process board creation in chunks of 5 to avoid HTTP socket exhaustion
  const BATCH_SIZE = 5;
  for (let i = 0; i < uniqueNames.length; i += BATCH_SIZE) {
    const chunk = uniqueNames.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      chunk.map((name) =>
        createBoardViaWebhook({
          accountId,
          boardName: name,
          webhookId,
          triggerSource,
        })
      )
    );

    results.forEach((res) => {
      if (res.success && res.board) {
        createdBoards.push(res.board);
        if (res.reused) reusedCount++;
        else createdCount++;
      } else {
        failedCount++;
        if (res.error) errors.push(res.error);
      }
    });
  }

  return {
    createdCount,
    reusedCount,
    failedCount,
    boards: createdBoards,
    errors,
  };
}
