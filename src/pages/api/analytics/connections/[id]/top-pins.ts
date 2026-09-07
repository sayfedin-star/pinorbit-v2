export const prerender = false;

import type { APIRoute } from 'astro';
import { pinnerAnalyticsService } from '../../../../../server/services/pinner-analytics-service';
import type { PinnerSortBy } from '../../../../../lib/types';
import { getAnalyticsKV } from '../../../../../lib/edge-kv';
import { errorStatus } from '../../../../../server/lib/http-error';
import { assertWorkspaceAccess } from '../../../../../server/auth/workspace-guard';

export const GET: APIRoute = async ({ params, request, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const connectionId = params.id;

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

  if (!connectionId) {
    return new Response(
      JSON.stringify({ success: false, error: 'connection ID parameter is required.' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  const url = new URL(request.url);
  const sortBy = (url.searchParams.get('sort_by') || 'IMPRESSION').toUpperCase() as PinnerSortBy;
  const SORT_MODES = ['IMPRESSION', 'OUTBOUND_CLICK', 'SAVE', 'ENGAGEMENT', 'PIN_CLICK'];
  if (!SORT_MODES.includes(sortBy)) {
    return new Response(
      JSON.stringify({ success: false, error: 'Invalid sort_by mode.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }
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

  const rawPage = parseInt(url.searchParams.get('page') || '1', 10);
  const page = isNaN(rawPage) ? 1 : Math.max(1, rawPage);
  const rawPageSize = parseInt(url.searchParams.get('page_size') || '25', 10);
  const pageSize = isNaN(rawPageSize) ? 25 : Math.min(100, Math.max(1, rawPageSize));
  const query = (url.searchParams.get('q') || '').toLowerCase().trim();

  try {
    const kvNamespace = getAnalyticsKV(locals);
    const { data, cacheStatus } = await pinnerAnalyticsService.getTopPinsServerPaginated(
      schedulingClient,
      user.id,
      workspaceId,
      connectionId,
      sortBy,
      limit,
      kvNamespace,
      bypassCache,
      fromDate,
      toDate,
      page,
      pageSize,
      query
    );

    return new Response(JSON.stringify({ 
      success: true, 
      data: {
        rows: data.rows,
        total: data.total,
        window: data.window,
      }
    }), {
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
