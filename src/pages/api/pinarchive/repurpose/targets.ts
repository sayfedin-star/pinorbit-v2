export const prerender = false;

import type { APIRoute } from 'astro';
import { dbClients } from '../../../../server/db/clients';
import { assertWorkspaceAccess } from '../../../../server/auth/workspace-guard';
import { HttpError } from '../../../../server/lib/http-error';

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export const GET: APIRoute = async ({ locals }) => {
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};
  const user = locals.user;
  const workspaceId = locals.activeWorkspaceId;

  if (!user || !workspaceId) {
    return json({ success: false, error: 'Unauthorized.' }, 401);
  }

  const p1Admin = dbClients.getSchedulingAdmin(runtimeEnv);

  try {
    await assertWorkspaceAccess(p1Admin, workspaceId, user.id, 'member');

    // 1. Fetch active accounts
    const { data: accounts, error: accErr } = await p1Admin
      .from('accounts')
      .select('id, name, username, is_active')
      .eq('workspace_id', workspaceId)
      .eq('is_active', true)
      .order('name', { ascending: true });

    if (accErr) {
      return json({ success: false, error: accErr.message }, 500);
    }

    const accountIds = (accounts || []).map((a) => a.id);

    // 2. Fetch publishable boards (Condition 10: pinterest_board_id IS NOT NULL)
    const { data: boards, error: boardErr } = await p1Admin
      .from('boards')
      .select('id, account_id, board_name, pinterest_board_id')
      .eq('workspace_id', workspaceId)
      .in('account_id', accountIds)
      .not('pinterest_board_id', 'is', null)
      .order('board_name', { ascending: true });

    if (boardErr) {
      return json({ success: false, error: boardErr.message }, 500);
    }

    const boardsByAccount = new Map<string, Array<{ id: string; board_name: string; pinterest_board_id: string }>>();
    for (const b of boards || []) {
      if (!boardsByAccount.has(b.account_id)) {
        boardsByAccount.set(b.account_id, []);
      }
      boardsByAccount.get(b.account_id)!.push(b);
    }

    const targets = (accounts || []).map((acc) => ({
      id: acc.id,
      name: acc.name || acc.username,
      username: acc.username,
      boards: boardsByAccount.get(acc.id) || [],
    }));

    return json({ success: true, targets });
  } catch (err: any) {
    if (err instanceof HttpError) {
      return json({ success: false, error: err.message }, err.status);
    }
    return json({ success: false, error: err?.message || 'Server error.' }, 500);
  }
};
