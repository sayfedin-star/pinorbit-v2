export const prerender = false;

import type { APIRoute } from 'astro';
import { dbClients } from '../../../../server/db/clients';
import { assertWorkspaceAccess } from '../../../../server/auth/workspace-guard';
import { runReverseReconciliation } from '../../../../server/services/reconcile-service';
import { HttpError } from '../../../../server/lib/http-error';

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export const POST: APIRoute = async ({ request, locals }) => {
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};
  const user = locals.user;
  const workspaceId = locals.activeWorkspaceId;

  if (!user || !workspaceId) {
    return json({ success: false, error: 'Unauthorized.' }, 401);
  }

  const p1Admin = dbClients.getSchedulingAdmin(runtimeEnv);
  const paAdmin = dbClients.getPinArchive(runtimeEnv);

  try {
    // Admin Role Gate: reverse reconciliation restricted to workspace admin/owner
    await assertWorkspaceAccess(p1Admin, workspaceId, user.id, 'admin');

    let body: any = {};
    try {
      body = await request.json();
    } catch {
      // optional empty body
    }

    const cleanup = Boolean(body?.cleanup);
    const report = await runReverseReconciliation(p1Admin, paAdmin, workspaceId, cleanup);

    return json({ success: true, ...report });
  } catch (err: any) {
    if (err instanceof HttpError) {
      return json({ success: false, error: err.message }, err.status);
    }
    return json({ success: false, error: err?.message || 'Server error.' }, 500);
  }
};
