export const prerender = false;

import type { APIRoute } from 'astro';
import { pinnerAnalyticsService } from '../../../server/services/pinner-analytics-service';
import type { PinnerSortBy } from '../../../lib/types';
import { getAnalyticsKV } from '../../../lib/edge-kv';
import { errorStatus } from '../../../server/lib/http-error';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';

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
  const sortBy = (url.searchParams.get('sort_by') || 'IMPRESSION').toUpperCase() as PinnerSortBy;
  const rawLimit = parseInt(url.searchParams.get('limit') || '50', 10);
  const limit = isNaN(rawLimit) ? 50 : Math.min(Math.max(rawLimit, 1), 100);
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
  const fromDate = url.searchParams.get('from_date') || undefined;
  const toDate = url.searchParams.get('to_date') || undefined;

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
    const { data, cacheStatus } = await pinnerAnalyticsService.getTopPins(
      schedulingClient,
      user.id,
      workspaceId,
      connectionId,
      sortBy,
      limit,
      kvNamespace,
      bypassCache,
      fromDate,
      toDate
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
        error: err.message || 'Failed to retrieve top pins.',
      }),
      {
        status: errorStatus(err),
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
};
