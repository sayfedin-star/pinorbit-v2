import type { SupabaseClient } from '@supabase/supabase-js';
import { resolvePinTitle } from './repurpose-service';

export interface DispatchedLedgerOptions {
  workspaceId: string;
  accountId?: string;
  timeframe?: '7d' | '30d' | '90d' | 'all';
  batchStatus?: 'all' | 'completed' | 'failed' | 'in_progress';
  publishStatus?: 'all' | 'draft' | 'posted' | 'failed' | 'missing';
  cursor?: { sent_at: string; id: string };
  limit?: number;
}

export interface DispatchedLedgerItem {
  id: string;
  batch_id: string;
  pa_pin_id: string;
  pin_title: string;
  pin_image_url: string;
  target_account_id: string;
  target_account_label: string;
  target_board_name: string;
  link_used: string;
  p1_pin_id: string;
  sent_at: string;
  sent_by?: string | null;
  batch_status: string;
  publish_status: 'draft' | 'posted' | 'failed' | 'missing' | 'unknown';
  publish_error?: string | null;
}

export interface DispatchedLedgerResult {
  items: DispatchedLedgerItem[];
  next_cursor: { sent_at: string; id: string } | null;
  has_more: boolean;
  p1_degraded: boolean;
}

export async function fetchDispatchesLedger(
  paAdmin: SupabaseClient,
  p1Admin: SupabaseClient,
  options: DispatchedLedgerOptions
): Promise<DispatchedLedgerResult> {
  const { workspaceId, accountId, timeframe = '30d', batchStatus = 'all', publishStatus = 'all', cursor, limit = 50 } = options;
  const pageLimit = Math.min(Math.max(limit, 1), 100);

  // Step 1: Query P4 stamps
  let query = paAdmin
    .from('pa_pin_dispatches')
    .select('id, batch_id, pa_pin_id, target_account_id, target_account_label, target_board_name, link_used, p1_pin_id, sent_at, sent_by')
    .eq('workspace_id', workspaceId);

  if (accountId && accountId.trim().length > 0) {
    query = query.eq('target_account_id', accountId.trim());
  }

  if (timeframe && timeframe !== 'all') {
    const days = timeframe === '7d' ? 7 : timeframe === '30d' ? 30 : 90;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    query = query.gte('sent_at', cutoff);
  }

  if (cursor && cursor.sent_at && cursor.id) {
    // Keyset condition: sent_at < cursorSentAt OR (sent_at = cursorSentAt AND id < cursorId)
    query = query.or(`sent_at.lt."${cursor.sent_at}",and(sent_at.eq."${cursor.sent_at}",id.lt."${cursor.id}")`);
  }

  query = query
    .order('sent_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(pageLimit + 1);

  const { data: rawStamps, error: stampsErr } = await query;
  if (stampsErr) {
    throw new Error(`Failed to query dispatches stamps: ${stampsErr.message}`);
  }

  const stamps = rawStamps || [];
  const hasMore = stamps.length > pageLimit;
  const pageStamps = hasMore ? stamps.slice(0, pageLimit) : stamps;

  if (pageStamps.length === 0) {
    return {
      items: [],
      next_cursor: null,
      has_more: false,
      p1_degraded: false,
    };
  }

  // Fetch associated pin details from pa_pins
  const paPinIds = [...new Set(pageStamps.map((s) => s.pa_pin_id).filter(Boolean))];
  const { data: pinsData } = await paAdmin
    .from('pa_pins')
    .select('id, title, description, image_url')
    .in('id', paPinIds);

  const pinsMap = new Map<string, any>();
  for (const pin of pinsData || []) {
    pinsMap.set(pin.id, pin);
  }

  // Fetch associated batch statuses from pa_repurpose_batches
  const batchIds = [...new Set(pageStamps.map((s) => s.batch_id).filter(Boolean))];
  const { data: batchesData } = await paAdmin
    .from('pa_repurpose_batches')
    .select('id, status')
    .in('id', batchIds);

  const batchesMap = new Map<string, string>();
  for (const b of batchesData || []) {
    batchesMap.set(b.id, b.status);
  }

  // Step 2: Batch query P1 pins for publishing status (Graceful degradation)
  const p1PinIds = [...new Set(pageStamps.map((s) => s.p1_pin_id).filter(Boolean))];
  const p1PinsMap = new Map<string, { status: string; error_message?: string | null }>();
  let p1Degraded = false;

  if (p1PinIds.length > 0) {
    try {
      const { data: p1Pins, error: p1Err } = await p1Admin
        .from('pins')
        .select('id, status, error_message')
        .eq('workspace_id', workspaceId)
        .in('id', p1PinIds);

      if (p1Err) {
        console.warn('[DispatchedLedger] P1 query returned error:', p1Err.message);
        p1Degraded = true;
      } else if (p1Pins) {
        for (const p of p1Pins) {
          p1PinsMap.set(p.id, { status: p.status, error_message: p.error_message });
        }
      }
    } catch (err: any) {
      console.warn('[DispatchedLedger] P1 query failed (graceful degradation):', err.message);
      p1Degraded = true;
    }
  }

  // Compose items with 2-dimensional status
  let items: DispatchedLedgerItem[] = pageStamps.map((stamp) => {
    const pin = pinsMap.get(stamp.pa_pin_id);
    const resolvedTitle = resolvePinTitle(pin?.title, pin?.description);
    const batchState = batchesMap.get(stamp.batch_id) || 'completed';

    let pubStatus: 'draft' | 'posted' | 'failed' | 'missing' | 'unknown' = 'missing';
    let pubError: string | null = null;

    if (p1PinsMap.has(stamp.p1_pin_id)) {
      const p1Info = p1PinsMap.get(stamp.p1_pin_id)!;
      const rawStatus = (p1Info.status || '').toLowerCase();
      if (rawStatus === 'posted' || rawStatus === 'published') {
        pubStatus = 'posted';
      } else if (rawStatus === 'failed' || rawStatus === 'error') {
        pubStatus = 'failed';
      } else {
        pubStatus = 'draft';
      }
      pubError = p1Info.error_message || null;
    } else if (p1Degraded) {
      pubStatus = 'unknown';
    } else {
      pubStatus = 'missing';
    }

    return {
      id: stamp.id,
      batch_id: stamp.batch_id,
      pa_pin_id: stamp.pa_pin_id,
      pin_title: resolvedTitle,
      pin_image_url: pin?.image_url || '',
      target_account_id: stamp.target_account_id,
      target_account_label: stamp.target_account_label || 'Account',
      target_board_name: stamp.target_board_name || 'Board',
      link_used: stamp.link_used || '',
      p1_pin_id: stamp.p1_pin_id,
      sent_at: stamp.sent_at,
      sent_by: stamp.sent_by || null,
      batch_status: batchState,
      publish_status: pubStatus,
      publish_error: pubError,
    };
  });

  // Apply in-memory status filters
  if (batchStatus && batchStatus !== 'all') {
    items = items.filter((item) => item.batch_status.toLowerCase() === batchStatus.toLowerCase());
  }

  if (publishStatus && publishStatus !== 'all') {
    items = items.filter((item) => item.publish_status.toLowerCase() === publishStatus.toLowerCase());
  }

  const lastItem = pageStamps[pageStamps.length - 1];
  const nextCursor = hasMore && lastItem ? { sent_at: lastItem.sent_at, id: lastItem.id } : null;

  return {
    items,
    next_cursor: nextCursor,
    has_more: hasMore,
    p1_degraded: p1Degraded,
  };
}
