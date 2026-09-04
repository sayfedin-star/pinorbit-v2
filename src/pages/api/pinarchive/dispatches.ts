export const prerender = false;

import type { APIRoute } from 'astro';
import { dbClients } from '../../../server/db/clients';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { fetchDispatchesLedger, type DispatchedLedgerOptions } from '../../../server/services/dispatched-service';
import { HttpError } from '../../../server/lib/http-error';

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export const GET: APIRoute = async ({ request, locals, url }) => {
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};
  const user = locals.user;
  const workspaceId = locals.activeWorkspaceId;

  if (!user || !workspaceId) {
    return json({ success: false, error: 'Unauthorized.' }, 401);
  }

  const p1Admin = dbClients.getSchedulingAdmin(runtimeEnv);
  const paAdmin = dbClients.getPinArchive(runtimeEnv);

  try {
    // Security Gate: member role is sufficient for read-only ledger access
    await assertWorkspaceAccess(p1Admin, workspaceId, user.id, 'member');

    const params = url.searchParams;
    const accountId = params.get('accountId') || undefined;
    const timeframe = (params.get('timeframe') as any) || '30d';
    const batchStatus = (params.get('batchStatus') as any) || 'all';
    const publishStatus = (params.get('publishStatus') as any) || 'all';
    const limit = parseInt(params.get('limit') || '50', 10);

    let cursor: { sent_at: string; id: string } | undefined = undefined;
    const cursorParam = params.get('cursor');
    if (cursorParam) {
      try {
        const decoded = JSON.parse(
          cursorParam.startsWith('{') ? cursorParam : atob(cursorParam)
        );
        if (decoded.sent_at && decoded.id) {
          cursor = { sent_at: String(decoded.sent_at), id: String(decoded.id) };
        }
      } catch {
        // invalid cursor, ignore
      }
    }

    const result = await fetchDispatchesLedger(paAdmin, p1Admin, {
      workspaceId,
      accountId,
      timeframe,
      batchStatus,
      publishStatus,
      cursor,
      limit,
    });

    return json({
      success: true,
      ...result,
    });
  } catch (err: any) {
    if (err instanceof HttpError) {
      return json({ success: false, error: err.message }, err.status);
    }
    return json({ success: false, error: err?.message || 'Server error loading dispatches ledger.' }, 500);
  }
};
