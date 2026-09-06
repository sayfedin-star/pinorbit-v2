export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { pinnerAnalyticsService } from '../../../server/services/pinner-analytics-service';
import { getAnalyticsKV } from '../../../lib/edge-kv';
import { errorStatus } from '../../../server/lib/http-error';

export const GET: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;

  if (!user || !schedulingClient) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized: authentication required.' }),
      {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  const url = new URL(request.url);
  const workspaceId = url.searchParams.get('workspace_id') || locals.activeWorkspaceId;
  const connectionId = url.searchParams.get('connection_id');
  const rawWindow = parseInt(url.searchParams.get('window_days') || '30', 10);
  const windowDays = isNaN(rawWindow) ? 30 : Math.min(Math.max(rawWindow, 1), 365);
  const bypassCacheParam = url.searchParams.get('cache_bypass') === '1';
  let bypassCache = false;

  if (bypassCacheParam && workspaceId) {
    try {
      const access = await assertWorkspaceAccess(schedulingClient, workspaceId, user.id);
      bypassCache = access.isAdmin || access.isOwner;
    } catch {
      bypassCache = false;
    }
  }

  if (!workspaceId || !connectionId) {
    return new Response(
      JSON.stringify({ error: 'workspace_id and connection_id query parameters are required.' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  try {
    const kvNamespace = getAnalyticsKV(locals);
    const { data, cacheStatus } = await pinnerAnalyticsService.getOverview(
      schedulingClient,
      user.id,
      workspaceId,
      connectionId,
      windowDays,
      kvNamespace,
      bypassCache
    );

    return new Response(JSON.stringify({ success: true, data }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Cache-Status': cacheStatus,
      },
    });
  } catch (err: any) {
    return new Response(
      JSON.stringify({
        success: false,
        error: err.message || 'Failed to retrieve overview metrics.',
      }),
      {
        status: errorStatus(err),
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
};
