export const prerender = false;

import type { APIRoute } from 'astro';
import { dbClients } from '../../../../server/db/clients';
import { assertWorkspaceAccess } from '../../../../server/auth/workspace-guard';
import { updateStagedPin, deleteStagedPin } from '../../../../server/services/staged-service';
import { HttpError } from '../../../../server/lib/http-error';

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export const PATCH: APIRoute = async ({ params, request, locals }) => {
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};
  const user = locals.user;
  const workspaceId = locals.activeWorkspaceId;
  const stagedPinId = params.id;

  if (!user || !workspaceId) {
    return json({ success: false, error: 'Unauthorized.' }, 401);
  }

  if (!stagedPinId) {
    return json({ success: false, error: 'Staged pin ID is required.' }, 400);
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

    const { title, override_link, board_name } = body || {};

    const updated = await updateStagedPin(paAdmin, workspaceId, stagedPinId, {
      title,
      override_link,
      board_name,
    });

    return json({ success: true, stagedPin: updated });
  } catch (err: any) {
    if (err instanceof HttpError) {
      return json({ success: false, error: err.message }, err.status);
    }
    return json({ success: false, error: err?.message || 'Server error.' }, 500);
  }
};

export const DELETE: APIRoute = async ({ params, locals }) => {
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};
  const user = locals.user;
  const workspaceId = locals.activeWorkspaceId;
  const stagedPinId = params.id;

  if (!user || !workspaceId) {
    return json({ success: false, error: 'Unauthorized.' }, 401);
  }

  if (!stagedPinId) {
    return json({ success: false, error: 'Staged pin ID is required.' }, 400);
  }

  const p1Admin = dbClients.getSchedulingAdmin(runtimeEnv);
  const paAdmin = dbClients.getPinArchive(runtimeEnv);

  try {
    await assertWorkspaceAccess(p1Admin, workspaceId, user.id, 'admin');

    await deleteStagedPin(paAdmin, workspaceId, stagedPinId);

    return json({ success: true, message: 'Staged pin deleted from queue.' });
  } catch (err: any) {
    if (err instanceof HttpError) {
      return json({ success: false, error: err.message }, err.status);
    }
    return json({ success: false, error: err?.message || 'Server error.' }, 500);
  }
};
