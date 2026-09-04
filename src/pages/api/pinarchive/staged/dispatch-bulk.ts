export const prerender = false;
// Endpoint: POST /api/pinarchive/staged/dispatch-bulk (v2.9)

import type { APIRoute } from 'astro';
import { dbClients } from '../../../../server/db/clients';
import { assertWorkspaceAccess } from '../../../../server/auth/workspace-guard';
import { dispatchBulkStagedPins } from '../../../../server/services/staged-service';
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
    await assertWorkspaceAccess(p1Admin, workspaceId, user.id, 'admin');

    let body: any;
    try {
      body = await request.json();
    } catch {
      return json({ success: false, error: 'Malformed JSON payload.' }, 400);
    }

    const { stagedPinIds, assignments, allowDuplicates } = body || {};

    if (!Array.isArray(stagedPinIds) || stagedPinIds.length === 0) {
      return json({ success: false, error: 'stagedPinIds array is required.' }, 400);
    }

    if (!Array.isArray(assignments) || assignments.length === 0) {
      return json({ success: false, error: 'assignments array is required with at least one target account.' }, 400);
    }

    const result = await dispatchBulkStagedPins(
      paAdmin,
      p1Admin,
      workspaceId,
      user.id,
      stagedPinIds,
      assignments,
      allowDuplicates !== false
    );

    return json({
      success: true,
      message: `Dispatched ${result.succeeded.length} of ${result.total_requested} pins successfully.`,
      succeeded: result.succeeded,
      failed: result.failed,
      total_requested: result.total_requested,
    });
  } catch (err: any) {
    if (err instanceof HttpError) {
      return json({ success: false, error: err.message }, err.status);
    }
    return json({ success: false, error: err?.message || 'Server error.' }, 500);
  }
};
