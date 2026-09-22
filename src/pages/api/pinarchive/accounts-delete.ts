export const prerender = false;
import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { dbClients } from '../../../server/db/clients';
import { errorStatus } from '../../../server/lib/http-error';

// Route: /api/pinarchive/accounts-delete (POST) - Bulk delete archived accounts with cascade cleanup
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (o: any, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { 'Content-Type': 'application/json' },
  });

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  if (!user || !schedulingClient) {
    return json({ success: false, error: 'Unauthorized: missing session' }, 401);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'Invalid JSON payload' }, 400);
  }

  const workspaceId = body.workspace_id || locals.activeWorkspaceId;
  if (!workspaceId) {
    return json({ success: false, error: 'Unauthorized: missing workspace identifier' }, 401);
  }
  if (!UUID_REGEX.test(workspaceId)) {
    return json({ success: false, error: 'Invalid workspace identifier format.' }, 400);
  }

  let wsCtx;
  try {
    wsCtx = await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, 'admin');
  } catch (e: any) {
    return json({ success: false, error: e.message || 'Forbidden: Admin access required' }, errorStatus(e));
  }

  const rawAccountIds = body.account_ids;
  if (!Array.isArray(rawAccountIds) || rawAccountIds.length === 0) {
    return json({ success: false, error: 'account_ids must be a non-empty array of UUIDs.' }, 400);
  }

  for (const id of rawAccountIds) {
    if (typeof id !== 'string' || !UUID_REGEX.test(id)) {
      return json({ success: false, error: `Invalid account identifier format: ${id}` }, 400);
    }
  }

  const accountIds = Array.from(new Set(rawAccountIds));

  try {
    const db = dbClients.getPinArchive(locals.runtime?.env);

    // 1. Count accounts to be deleted in safe chunks of 100
    let totalCount = 0;
    const CHUNK_SIZE = 100;
    for (let i = 0; i < accountIds.length; i += CHUNK_SIZE) {
      const chunk = accountIds.slice(i, i + CHUNK_SIZE);
      const { count, error: countErr } = await db
        .from('pa_accounts')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', wsCtx.workspaceId)
        .in('id', chunk);

      if (countErr) {
        return json({ success: false, error: countErr.message }, 500);
      }
      totalCount += (count || 0);
    }

    if (totalCount === 0) {
      return json({ success: true, deleted: 0, message: 'No matching accounts found in workspace.' });
    }

    // 2. Delete accounts (FK cascades handle pa_pins, pa_pin_metrics, pa_runs)
    // Y5 deferred: GAS v2.6.3 will add delete_account handler; UI Pause guard (v1.2) is active
    for (let i = 0; i < accountIds.length; i += CHUNK_SIZE) {
      const chunk = accountIds.slice(i, i + CHUNK_SIZE);
      const { error: delErr } = await db
        .from('pa_accounts')
        .delete()
        .eq('workspace_id', wsCtx.workspaceId)
        .in('id', chunk);

      if (delErr) {
        return json({ success: false, error: delErr.message }, 500);
      }
    }

    return json({
      success: true,
      deleted: totalCount,
    });
  } catch (e: any) {
    return json({ success: false, error: e.message || 'Internal Server Error' }, 500);
  }
};
