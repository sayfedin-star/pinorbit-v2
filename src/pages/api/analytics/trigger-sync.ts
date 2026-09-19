export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { fastcronService } from '../../../server/services/fastcron-service';

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};

  if (!user || !schedulingClient) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized: authentication required.' }),
      {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  if (!workspaceId) {
    return new Response(
      JSON.stringify({ success: false, error: 'Active workspace not found in session.' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  let body: any = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return new Response(
      JSON.stringify({ success: false, error: 'Invalid JSON body.' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  const connectionId = body.connection_id;
  const channel = body.channel as 'analytics' | 'top_pins';
  const mode = (body.mode === 'ping' ? 'ping' : 'sync') as 'ping' | 'sync';

  if (!connectionId) {
    return new Response(
      JSON.stringify({ success: false, error: 'connection_id is required.' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  if (channel !== 'analytics' && channel !== 'top_pins') {
    return new Response(
      JSON.stringify({
        success: false,
        error: 'channel must be either "analytics" or "top_pins".',
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  const fromDate = body.from_date || body.start_date;
  const toDate = body.to_date || body.end_date;
  const direct = Boolean(body.direct || body.mode === 'direct');

  if (fromDate && toDate && fromDate > toDate) {
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Validation Error: start_date must be before end_date (identical dates allowed for same-day pull).',
      }),
      {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  try {
    await assertWorkspaceAccess(schedulingClient, workspaceId, user.id);
    const overrides = (fromDate && toDate) || direct
      ? {
          from_date: fromDate,
          to_date: toDate,
          direct,
        }
      : undefined;

    const result = await fastcronService.triggerManualSync(
      workspaceId,
      connectionId,
      channel,
      mode,
      runtimeEnv,
      overrides
    );

    return new Response(JSON.stringify(result), {
      status: result.success ? 200 : 400,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(
      JSON.stringify({
        success: false,
        connection_id: connectionId,
        channel,
        mode,
        error: err.message || 'Failed to trigger sync run.',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
};
