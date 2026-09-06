export const prerender = false;

import type { APIRoute } from 'astro';
import { dbClients } from '../../../server/db/clients';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { HttpError } from '../../../server/lib/http-error';

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export const PATCH: APIRoute = async ({ params, request, locals }) => {
  const { id } = params;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};
  const user = locals.user;
  const workspaceId = locals.activeWorkspaceId;

  if (!id || !user || !workspaceId) {
    return json({ success: false, error: 'Unauthorized.' }, 401);
  }

  const p1Admin = dbClients.getSchedulingAdmin(runtimeEnv);
  const paAdmin = dbClients.getPinArchive(runtimeEnv);

  try {
    // Admin Role Gate: update restricted to workspace admin/owner
    await assertWorkspaceAccess(p1Admin, workspaceId, user.id, 'admin');

    let body: any;
    try {
      body = await request.json();
    } catch {
      return json({ success: false, error: 'Malformed JSON.' }, 400);
    }

    const { label, isDefault, scope } = body || {};
    const targetScope = scope === 'user' ? 'user' : 'workspace';

    if (targetScope === 'user') {
      if (isDefault === true) {
        await paAdmin
          .from('user_links')
          .update({ is_default: false, updated_at: new Date().toISOString() })
          .eq('user_id', user.id)
          .eq('is_default', true);
      }

      const updates: Record<string, any> = { updated_at: new Date().toISOString() };
      if (label !== undefined) updates.label = String(label).trim();
      if (isDefault !== undefined) updates.is_default = Boolean(isDefault);

      const { data, error } = await paAdmin
        .from('user_links')
        .update(updates)
        .eq('id', id)
        .eq('user_id', user.id)
        .select('*')
        .single();

      if (error || !data) {
        return json({ success: false, error: error?.message || 'Link not found.' }, 404);
      }

      return json({ success: true, link: data });
    } else {
      if (isDefault === true) {
        await paAdmin
          .from('workspace_links')
          .update({ is_default: false, updated_at: new Date().toISOString() })
          .eq('workspace_id', workspaceId)
          .eq('is_default', true);
      }

      const updates: Record<string, any> = { updated_at: new Date().toISOString() };
      if (label !== undefined) updates.label = String(label).trim();
      if (isDefault !== undefined) updates.is_default = Boolean(isDefault);

      const { data, error } = await paAdmin
        .from('workspace_links')
        .update(updates)
        .eq('id', id)
        .eq('workspace_id', workspaceId)
        .select('*')
        .single();

      if (error || !data) {
        return json({ success: false, error: error?.message || 'Link not found.' }, 404);
      }

      return json({ success: true, link: data });
    }
  } catch (err: any) {
    if (err instanceof HttpError) {
      return json({ success: false, error: err.message }, err.status);
    }
    return json({ success: false, error: err?.message || 'Server error.' }, 500);
  }
};

export const DELETE: APIRoute = async ({ params, request, locals }) => {
  const { id } = params;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};
  const user = locals.user;
  const workspaceId = locals.activeWorkspaceId;

  if (!id || !user || !workspaceId) {
    return json({ success: false, error: 'Unauthorized.' }, 401);
  }

  const p1Admin = dbClients.getSchedulingAdmin(runtimeEnv);
  const paAdmin = dbClients.getPinArchive(runtimeEnv);

  try {
    // Admin Role Gate: delete restricted to workspace admin/owner
    await assertWorkspaceAccess(p1Admin, workspaceId, user.id, 'admin');

    const urlObj = new URL(request.url);
    const scope = urlObj.searchParams.get('scope') === 'user' ? 'user' : 'workspace';

    if (scope === 'user') {
      const { error } = await paAdmin
        .from('user_links')
        .delete()
        .eq('id', id)
        .eq('user_id', user.id);

      if (error) {
        return json({ success: false, error: error.message }, 500);
      }
      return json({ success: true, deleted_id: id, scope: 'user' });
    } else {
      const { error } = await paAdmin
        .from('workspace_links')
        .delete()
        .eq('id', id)
        .eq('workspace_id', workspaceId);

      if (error) {
        return json({ success: false, error: error.message }, 500);
      }
      return json({ success: true, deleted_id: id, scope: 'workspace' });
    }
  } catch (err: any) {
    if (err instanceof HttpError) {
      return json({ success: false, error: err.message }, err.status);
    }
    return json({ success: false, error: err?.message || 'Server error.' }, 500);
  }
};
