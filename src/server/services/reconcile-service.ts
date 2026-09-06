import type { SupabaseClient } from '@supabase/supabase-js';

export interface ReverseReconcileReport {
  scanned_p1_pins: number;
  orphan_p1_pins_count: number;
  orphan_pins: Array<{
    id: string;
    account_id: string;
    title: string;
    created_at: string;
    status: string;
    source_ref: string | null;
  }>;
  cleaned_up: boolean;
}

/**
 * Condition (2): Reverse Reconciliation (P1 pins without P4 stamps)
 * Application-level 2-step process across P1 and P4 (zero cross-DB SQL joins).
 */
export async function runReverseReconciliation(
  p1Admin: SupabaseClient,
  paAdmin: SupabaseClient,
  workspaceId: string,
  cleanup: boolean = false
): Promise<ReverseReconcileReport> {
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Step 1: Query candidate P1 pins older than 24h originating from pinarchive
  const { data: p1Candidates, error: p1Err } = await p1Admin
    .from('pins')
    .select('id, account_id, title, created_at, status, source_ref')
    .eq('workspace_id', workspaceId)
    .eq('source', 'pinarchive')
    .not('source_ref', 'is', null)
    .lt('created_at', twentyFourHoursAgo)
    .limit(500);

  if (p1Err) {
    throw new Error(`Failed to query P1 candidates: ${p1Err.message}`);
  }

  if (!p1Candidates || p1Candidates.length === 0) {
    return {
      scanned_p1_pins: 0,
      orphan_p1_pins_count: 0,
      orphan_pins: [],
      cleaned_up: false,
    };
  }

  const p1Ids = p1Candidates.map((p) => p.id);

  // Step 2: Query P4 stamps for matching p1_pin_id
  const { data: stamps, error: stampsErr } = await paAdmin
    .from('pa_pin_dispatches')
    .select('p1_pin_id')
    .eq('workspace_id', workspaceId)
    .in('p1_pin_id', p1Ids);

  if (stampsErr) {
    throw new Error(`Failed to query P4 stamps: ${stampsErr.message}`);
  }

  const stampedSet = new Set((stamps || []).map((s) => s.p1_pin_id));

  // Filter for P1 pins whose stamps are absent in P4
  const orphans = p1Candidates.filter((p) => !stampedSet.has(p.id));

  let cleanedUp = false;
  if (cleanup && orphans.length > 0) {
    const orphanIds = orphans.map((o) => o.id);
    const { error: deleteErr } = await p1Admin
      .from('pins')
      .delete()
      .in('id', orphanIds)
      .eq('workspace_id', workspaceId);

    if (deleteErr) {
      console.error('[ReverseReconcile] Failed to clean up orphan P1 pins:', deleteErr.message);
    } else {
      cleanedUp = true;
    }
  }

  return {
    scanned_p1_pins: p1Candidates.length,
    orphan_p1_pins_count: orphans.length,
    orphan_pins: orphans,
    cleaned_up: cleanedUp,
  };
}
