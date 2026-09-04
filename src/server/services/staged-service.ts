import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError } from '../lib/http-error';
import { validateSafeUrl } from '../lib/ssrf-guard';
import { executeRepurposeDispatch, type TargetDestination, type RepurposeSummary } from './repurpose-service';

export interface StagedPinItem {
  id: string;
  workspace_id: string;
  staged_by: string;
  pa_pin_id: string;
  title: string;
  image_url: string;
  original_link: string;
  override_link: string;
  board_name: string;
  status: 'staged' | 'dispatched' | 'cancelled';
  created_at: string;
  updated_at: string;
}

export interface TargetAssignment {
  accountId: string;
  accountLabel: string;
  boardName: string;
  linkUrl?: string;
}

/**
 * Stage Pins (Step 1): Bulk inserts selected pins into pa_staged_pins with status 'staged'.
 */
export async function stagePins(
  paAdmin: SupabaseClient,
  workspaceId: string,
  userId: string,
  pinIds: string[],
  defaults?: { overrideLink?: string; boardName?: string }
): Promise<{ count: number; stagedPins: StagedPinItem[] }> {
  if (!pinIds || pinIds.length === 0) {
    throw new HttpError(400, 'No pin IDs provided to stage.');
  }

  // 1. Fetch original pin records from P4
  const { data: rawPins, error: fetchErr } = await paAdmin
    .from('pa_pins')
    .select('id, title, description, image_url, link, board_name')
    .eq('workspace_id', workspaceId)
    .in('id', pinIds);

  if (fetchErr) {
    throw new HttpError(500, `Failed to fetch pins for staging: ${fetchErr.message}`);
  }

  const validPins = (rawPins || []).filter((p) => p.image_url && p.image_url.trim().length > 0);
  if (validPins.length === 0) {
    throw new HttpError(422, 'None of the selected pins have valid images for staging.');
  }

  let sanitizedOverride = '';
  if (defaults?.overrideLink && defaults.overrideLink.trim().length > 0) {
    const parsed = validateSafeUrl(defaults.overrideLink.trim());
    sanitizedOverride = parsed.toString();
  }

  const rows = validPins.map((p) => ({
    workspace_id: workspaceId,
    staged_by: userId,
    pa_pin_id: p.id,
    title: (p.title || '').trim() || 'Archived Pin',
    image_url: p.image_url,
    original_link: (p.link || '').trim(),
    override_link: sanitizedOverride,
    board_name: defaults?.boardName?.trim() || p.board_name || '',
    status: 'staged' as const,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }));

  const { data: inserted, error: insertErr } = await paAdmin
    .from('pa_staged_pins')
    .insert(rows)
    .select('*');

  if (insertErr) {
    throw new HttpError(500, `Failed to insert staged pins: ${insertErr.message}`);
  }

  return {
    count: (inserted || []).length,
    stagedPins: (inserted || []) as StagedPinItem[],
  };
}

/**
 * Fetch Staged Pins Queue: Gets all pins with status 'staged' for the workspace.
 */
export async function getStagedQueue(
  paAdmin: SupabaseClient,
  workspaceId: string
): Promise<StagedPinItem[]> {
  const { data, error } = await paAdmin
    .from('pa_staged_pins')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('status', 'staged')
    .order('created_at', { ascending: false });

  if (error) {
    throw new HttpError(500, `Failed to fetch staged pins queue: ${error.message}`);
  }

  return (data || []) as StagedPinItem[];
}

/**
 * Update Staged Pin: Modifies details of a staged pin with SSRF defense on override_link.
 */
export async function updateStagedPin(
  paAdmin: SupabaseClient,
  workspaceId: string,
  stagedPinId: string,
  updates: { title?: string; override_link?: string; board_name?: string }
): Promise<StagedPinItem> {
  const updatePayload: any = {
    updated_at: new Date().toISOString(),
  };

  if (typeof updates.title === 'string') {
    updatePayload.title = updates.title.trim();
  }

  if (typeof updates.board_name === 'string') {
    updatePayload.board_name = updates.board_name.trim();
  }

  if (typeof updates.override_link === 'string') {
    const trimmed = updates.override_link.trim();
    if (trimmed.length > 0) {
      const safeUrl = validateSafeUrl(trimmed);
      updatePayload.override_link = safeUrl.toString();
    } else {
      updatePayload.override_link = '';
    }
  }

  const { data, error } = await paAdmin
    .from('pa_staged_pins')
    .update(updatePayload)
    .eq('id', stagedPinId)
    .eq('workspace_id', workspaceId)
    .eq('status', 'staged')
    .select('*')
    .maybeSingle();

  if (error) {
    throw new HttpError(500, `Failed to update staged pin: ${error.message}`);
  }

  if (!data) {
    throw new HttpError(404, 'Staged pin not found or already dispatched/cancelled.');
  }

  return data as StagedPinItem;
}

/**
 * Delete Staged Pin: Removes a pin from the staging queue.
 */
export async function deleteStagedPin(
  paAdmin: SupabaseClient,
  workspaceId: string,
  stagedPinId: string
): Promise<void> {
  const { error } = await paAdmin
    .from('pa_staged_pins')
    .delete()
    .eq('id', stagedPinId)
    .eq('workspace_id', workspaceId);

  if (error) {
    throw new HttpError(500, `Failed to delete staged pin: ${error.message}`);
  }
}

/**
 * Dispatch Staged Pin (Step 2): CAS atomic transition from 'staged' to 'dispatched',
 * builds TargetDestination array with per-account links, and invokes executeRepurposeDispatch.
 */
export async function dispatchStagedPin(
  paAdmin: SupabaseClient,
  p1Admin: SupabaseClient,
  workspaceId: string,
  userId: string,
  stagedPinId: string,
  assignments: TargetAssignment[],
  allowDuplicates = true
): Promise<{ success: boolean; stagedPin: StagedPinItem; summary: RepurposeSummary }> {
  if (!assignments || assignments.length === 0) {
    throw new HttpError(400, 'Please select at least one target account with a destination link.');
  }

  // 1. Atomic CAS update: Transition from 'staged' -> 'dispatched'
  const { data: casWon, error: casErr } = await paAdmin
    .from('pa_staged_pins')
    .update({ status: 'dispatched', updated_at: new Date().toISOString() })
    .eq('id', stagedPinId)
    .eq('workspace_id', workspaceId)
    .eq('status', 'staged')
    .select('*')
    .maybeSingle();

  if (casErr) {
    throw new HttpError(500, `CAS update error on staged pin: ${casErr.message}`);
  }

  if (!casWon) {
    throw new HttpError(409, 'Staged pin is no longer available in the queue (already dispatched or cancelled).', {
      code: 'staged_pin_conflict',
    });
  }

  // 2. Map assignments to TargetDestination array with individual customLink per account
  const targets: TargetDestination[] = [];
  for (const a of assignments) {
    let resolvedLink = (a.linkUrl && a.linkUrl.trim().length > 0)
      ? a.linkUrl.trim()
      : (casWon.override_link && casWon.override_link.trim().length > 0)
      ? casWon.override_link.trim()
      : (casWon.original_link && casWon.original_link.trim().length > 0)
      ? casWon.original_link.trim()
      : '';

    if (resolvedLink) {
      const safe = validateSafeUrl(resolvedLink);
      resolvedLink = safe.toString();
    }

    targets.push({
      accountId: a.accountId,
      accountLabel: a.accountLabel || '',
      boardName: a.boardName || casWon.board_name || '',
      customLink: resolvedLink,
    });
  }

  // 3. Invoke executeRepurposeDispatch
  const batchUuid = crypto.randomUUID();
  try {
    const repurposeRes = await executeRepurposeDispatch(paAdmin, p1Admin, {
      batchUuid,
      workspaceId,
      userId,
      pinIds: [casWon.pa_pin_id],
      targets,
      allowDuplicates,
    });

    return {
      success: true,
      stagedPin: casWon as StagedPinItem,
      summary: repurposeRes.summary,
    };
  } catch (err: any) {
    // 4. Compensation rollback: Revert status to 'staged' so the user does not lose the queued item
    console.error(`[StagedDispatch] Dispatch failed for staged pin ${stagedPinId}. Reverting status to staged:`, err.message);
    try {
      await paAdmin
        .from('pa_staged_pins')
        .update({ status: 'staged', updated_at: new Date().toISOString() })
        .eq('id', stagedPinId)
        .eq('workspace_id', workspaceId);
    } catch (revertErr) {
      console.error(`[StagedDispatch] Failed to revert staged pin status: ${stagedPinId}`, revertErr);
    }
    throw err;
  }
}
