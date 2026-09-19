export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { runRetentionCleanup } from '../../../server/services/retention-cleanup';

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};

  // T1: Null guards before any assertWorkspaceAccess call
  if (!user || !schedulingClient) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: any = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const workspaceId = body.workspace_id || locals.activeWorkspaceId;
  const section = body.section;

  if (!workspaceId || !section || !['p1', 'p2', 'p3', 'p4'].includes(section)) {
    return new Response(
      JSON.stringify({
        error: 'Invalid request: workspace_id and section (p1, p2, p3, or p4) are required',
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  try {
    await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, 'admin');
  } catch (err: any) {
    return new Response(JSON.stringify({ error: 'Forbidden: admin access required' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const payload = await runRetentionCleanup(workspaceId, runtimeEnv, {
      overrides: { [section]: true },
      trigger: 'manual',
    });

    // T3: Return { section, ...payload } without duplicate success: true wrapper
    return new Response(
      JSON.stringify({
        section,
        ...payload,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({
        error: err.message || 'Manual cleanup failed',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
};
