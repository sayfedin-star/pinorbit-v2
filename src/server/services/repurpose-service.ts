import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError } from '../lib/http-error';

export const CHUNK_SIZE = 50;
export const HEARTBEAT_TIMEOUT_SECONDS = 90;

export interface TargetDestination {
  accountId: string;
  accountLabel: string;
  boardName: string;
  customLink?: string;
}

export interface RepurposeRequest {
  batchUuid: string;
  workspaceId: string;
  userId: string;
  pinIds: string[];
  targets: TargetDestination[];
  linkOverride?: string;
  allowDuplicates?: boolean;
}

export interface RepurposeSummary {
  batch_uuid: string;
  total_stamps: number;
  accounts_count: number;
  pins_count: number;
  skipped_duplicates: number;
  excluded_no_image: number;
  link_used: string;
  completed_at: string;
}

/**
 * Condition (3): Title Fallback Chain
 * NULLIF(TRIM(title),'') -> LEFT(description,60) -> 'Archived Pin'
 */
export function resolvePinTitle(title?: string | null, description?: string | null): string {
  const cleanTitle = title?.trim();
  if (cleanTitle && cleanTitle.length > 0) {
    return cleanTitle;
  }
  const cleanDesc = description?.trim();
  if (cleanDesc && cleanDesc.length > 0) {
    return cleanDesc.slice(0, 60);
  }
  return 'Archived Pin';
}

/**
 * Checks for prior dispatches of pins to target accounts.
 */
export async function checkPriorDispatches(
  paClient: SupabaseClient,
  workspaceId: string,
  pinIds: string[],
  targetAccountIds: string[]
): Promise<{ totalDuplicates: number; duplicates: Array<{ pa_pin_id: string; target_account_id: string; sent_at: string }> }> {
  if (pinIds.length === 0 || targetAccountIds.length === 0) {
    return { totalDuplicates: 0, duplicates: [] };
  }

  const { data, error } = await paClient
    .from('pa_pin_dispatches')
    .select('pa_pin_id, target_account_id, sent_at')
    .eq('workspace_id', workspaceId)
    .in('pa_pin_id', pinIds)
    .in('target_account_id', targetAccountIds);

  if (error) {
    console.warn('[Repurpose] Prior dispatch check warning:', error.message);
    return { totalDuplicates: 0, duplicates: [] };
  }

  return {
    totalDuplicates: (data || []).length,
    duplicates: (data || []) as any[],
  };
}

/**
 * Bidirectional compensation:
 * 1. Delete pins from P1 using tracked IDs.
 * 2. Delete batch from P4 (cascades to pa_pin_dispatches).
 */
export async function executeBidirectionalCompensation(
  p1Admin: SupabaseClient,
  paAdmin: SupabaseClient,
  workspaceId: string,
  batchUuid: string,
  insertedP1PinIds: string[]
): Promise<void> {
  // Step 1: Clean up P1 pins
  if (insertedP1PinIds.length > 0) {
    try {
      await p1Admin
        .from('pins')
        .delete()
        .in('id', insertedP1PinIds)
        .eq('workspace_id', workspaceId);
    } catch (p1Err) {
      console.error(`[Repurpose Compensation] Failed to delete pins from P1 for batch ${batchUuid}:`, p1Err);
    }
  }

  // Step 2: Delete P4 batch (Postgres CASCADE deletes pa_pin_dispatches automatically)
  try {
    await paAdmin
      .from('pa_repurpose_batches')
      .delete()
      .eq('id', batchUuid)
      .eq('workspace_id', workspaceId);
  } catch (paErr) {
    console.error(`[Repurpose Compensation] Failed to delete batch from P4 for batch ${batchUuid}:`, paErr);
  }
}

/**
 * Main Repurpose Orchestrator
 */
export async function executeRepurposeDispatch(
  paAdmin: SupabaseClient,
  p1Admin: SupabaseClient,
  req: RepurposeRequest
): Promise<{ success: boolean; replayed?: boolean; summary: RepurposeSummary }> {
  const { batchUuid, workspaceId, userId, pinIds, targets, linkOverride, allowDuplicates } = req;

  if (!batchUuid || !workspaceId || !userId) {
    throw new HttpError(400, 'batchUuid, workspaceId, and userId are required.');
  }
  if (!pinIds || pinIds.length === 0) {
    throw new HttpError(400, 'No pins selected.');
  }
  if (!targets || targets.length === 0) {
    throw new HttpError(400, 'No target accounts/boards selected.');
  }

  // 1. Check for existing batch (Idempotency & Race Check)
  const { data: existingBatch } = await paAdmin
    .from('pa_repurpose_batches')
    .select('*')
    .eq('id', batchUuid)
    .maybeSingle();

  if (existingBatch) {
    if (existingBatch.status === 'completed' && existingBatch.result_summary) {
      return { success: true, replayed: true, summary: existingBatch.result_summary as RepurposeSummary };
    }

    if (existingBatch.status === 'in_progress') {
      const elapsedSeconds = (Date.now() - new Date(existingBatch.updated_at).getTime()) / 1000;
      if (elapsedSeconds < HEARTBEAT_TIMEOUT_SECONDS) {
        throw new HttpError(409, 'Duplicate batch currently in progress.', {
          code: 'duplicate_in_progress',
          retryable: true,
        });
      }

      // Condition (5): Zombie Reconciliation via single conditional CAS
      const { data: casWon } = await paAdmin
        .from('pa_repurpose_batches')
        .update({ status: 'reconciling', updated_at: new Date().toISOString() })
        .eq('id', batchUuid)
        .eq('status', 'in_progress')
        .select('id')
        .maybeSingle();

      if (!casWon) {
        throw new HttpError(409, 'Duplicate batch currently in progress.', {
          code: 'duplicate_in_progress',
          retryable: true,
        });
      }

      // CAS won: inspect P1 for pins
      const { data: p1Pins } = await p1Admin
        .from('pins')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('source_ref', batchUuid);

      if (p1Pins && p1Pins.length >= existingBatch.pins_count * existingBatch.targets_count) {
        // Pins exist in P1! Finalize as completed
        const recoveredSummary: RepurposeSummary = existingBatch.result_summary || {
          batch_uuid: batchUuid,
          total_stamps: p1Pins.length,
          accounts_count: existingBatch.targets_count,
          pins_count: existingBatch.pins_count,
          skipped_duplicates: 0,
          excluded_no_image: 0,
          link_used: linkOverride || '',
          completed_at: new Date().toISOString(),
        };

        await paAdmin
          .from('pa_repurpose_batches')
          .update({ status: 'completed', result_summary: recoveredSummary, updated_at: new Date().toISOString() })
          .eq('id', batchUuid);

        return { success: true, replayed: true, summary: recoveredSummary };
      } else {
        // Partial or missing: execute compensation rollback
        const p1PinIds = (p1Pins || []).map((p) => p.id);
        await executeBidirectionalCompensation(p1Admin, paAdmin, workspaceId, batchUuid, p1PinIds);
        throw new HttpError(410, 'Zombie batch reconciled and cleaned up. Please retry dispatch.', {
          code: 'zombie_reconciled',
        });
      }
    }

    if (existingBatch.status === 'failed') {
      throw new HttpError(400, 'Batch previously failed. Please initiate with a new batch UUID.');
    }
  }

  // 2. Fetch source pins from P4
  const { data: rawPins, error: pinsErr } = await paAdmin
    .from('pa_pins')
    .select('id, title, description, image_url, link, board_name, account_id, created_at_pinterest')
    .eq('workspace_id', workspaceId)
    .in('id', pinIds);

  if (pinsErr || !rawPins || rawPins.length === 0) {
    throw new HttpError(404, 'No source pins found for repurposing.');
  }

  // Filter valid image pins
  const validPins = rawPins.filter((p) => p.image_url && p.image_url.trim().length > 0);
  const excludedNoImage = rawPins.length - validPins.length;

  if (validPins.length === 0) {
    throw new HttpError(422, 'None of the selected pins have valid images for repurposing.');
  }

  // 3. Duplicate checks if not allowDuplicates
  const targetAccountIds = targets.map((t) => t.accountId);
  let priorDuplicatesSet = new Set<string>();
  if (!allowDuplicates) {
    const { duplicates } = await checkPriorDispatches(paAdmin, workspaceId, pinIds, targetAccountIds);
    priorDuplicatesSet = new Set(duplicates.map((d) => `${d.pa_pin_id}:${d.target_account_id}`));
  }

  // 4. Register batch as in_progress in P4
  const { error: insertBatchErr } = await paAdmin
    .from('pa_repurpose_batches')
    .insert({
      id: batchUuid,
      workspace_id: workspaceId,
      created_by: userId,
      pins_count: validPins.length,
      targets_count: targets.length,
      status: 'in_progress',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

  if (insertBatchErr) {
    if (insertBatchErr.code === '23505') {
      throw new HttpError(409, 'Duplicate batch registration conflict.', {
        code: 'duplicate_in_progress',
        retryable: true,
      });
    }
    throw new HttpError(500, `Failed to initialize repurpose batch: ${insertBatchErr.message}`);
  }

  const insertedP1PinIds: string[] = [];
  let totalStamps = 0;
  let skippedDuplicates = 0;

  try {
    // 5. Construct pins and stamps
    // Link priority: target customLink -> linkOverride -> pin.link -> ''
    // Condition 4: cleared link is stored as ''
    const pinPayloads: any[] = [];
    const dispatchStamps: any[] = [];

    for (const pin of validPins) {
      for (const target of targets) {
        const pairKey = `${pin.id}:${target.accountId}`;
        if (!allowDuplicates && priorDuplicatesSet.has(pairKey)) {
          skippedDuplicates++;
          continue;
        }

        const preGeneratedPinId = crypto.randomUUID();
        insertedP1PinIds.push(preGeneratedPinId);

        // Link Resolution
        let linkToUse = '';
        if (target.customLink && target.customLink.trim().length > 0) {
          linkToUse = target.customLink.trim();
        } else if (linkOverride && linkOverride.trim().length > 0) {
          linkToUse = linkOverride.trim();
        } else if (pin.link && pin.link.trim().length > 0) {
          linkToUse = pin.link.trim();
        }

        // Condition 3: Title fallback chain
        const resolvedTitle = resolvePinTitle(pin.title, pin.description);

        // Prepare P1 pin row
        // Condition (2): source is strictly 'pinarchive'
        pinPayloads.push({
          id: preGeneratedPinId,
          workspace_id: workspaceId,
          account_id: target.accountId,
          board_name: target.boardName,
          title: resolvedTitle,
          description: pin.description || '',
          image_url: pin.image_url,
          link: linkToUse,
          status: 'draft',
          source: 'pinarchive',
          source_ref: batchUuid,
          source_creator: userId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });

        // Prepare P4 dispatch stamp row
        dispatchStamps.push({
          workspace_id: workspaceId,
          batch_id: batchUuid,
          pa_pin_id: pin.id,
          target_account_id: target.accountId,
          target_board_name: target.boardName,
          p1_pin_id: preGeneratedPinId,
          link_used: linkToUse,
          sent_at: new Date().toISOString(),
        });
      }
    }

    if (pinPayloads.length === 0) {
      // All combinations were skipped duplicates
      const emptySummary: RepurposeSummary = {
        batch_uuid: batchUuid,
        total_stamps: 0,
        accounts_count: targets.length,
        pins_count: validPins.length,
        skipped_duplicates: skippedDuplicates,
        excluded_no_image: excludedNoImage,
        link_used: linkOverride || '',
        completed_at: new Date().toISOString(),
      };

      await paAdmin
        .from('pa_repurpose_batches')
        .update({ status: 'completed', result_summary: emptySummary, updated_at: new Date().toISOString() })
        .eq('id', batchUuid);

      return { success: true, summary: emptySummary };
    }

    // 6. Chunked processing (50 items per chunk) with Heartbeat pulse
    for (let i = 0; i < pinPayloads.length; i += CHUNK_SIZE) {
      const p1Chunk = pinPayloads.slice(i, i + CHUNK_SIZE);
      const stampChunk = dispatchStamps.slice(i, i + CHUNK_SIZE);

      // Heartbeat pulse before inserting chunk
      await paAdmin
        .from('pa_repurpose_batches')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', batchUuid);

      // Insert into P1
      const { error: p1InsertErr } = await p1Admin.from('pins').insert(p1Chunk);
      if (p1InsertErr) {
        throw new Error(`P1 pin insert failed on chunk ${Math.floor(i / CHUNK_SIZE) + 1}: ${p1InsertErr.message}`);
      }

      // Insert stamps into P4
      const { error: stampInsertErr } = await paAdmin.from('pa_pin_dispatches').insert(stampChunk);
      if (stampInsertErr) {
        throw new Error(`P4 stamp insert failed on chunk ${Math.floor(i / CHUNK_SIZE) + 1}: ${stampInsertErr.message}`);
      }

      totalStamps += stampChunk.length;
    }

    // 7. Finalize batch as completed in P4
    const summary: RepurposeSummary = {
      batch_uuid: batchUuid,
      total_stamps: totalStamps,
      accounts_count: targets.length,
      pins_count: validPins.length,
      skipped_duplicates: skippedDuplicates,
      excluded_no_image: excludedNoImage,
      link_used: linkOverride || '',
      completed_at: new Date().toISOString(),
    };

    await paAdmin
      .from('pa_repurpose_batches')
      .update({
        status: 'completed',
        result_summary: summary,
        updated_at: new Date().toISOString(),
      })
      .eq('id', batchUuid);

    return { success: true, summary };
  } catch (err: any) {
    // Condition (6): Bidirectional compensation upon failure
    console.error(`[Repurpose] Failure during dispatch. Triggering bidirectional compensation for ${batchUuid}: ${err.message}`);
    await executeBidirectionalCompensation(p1Admin, paAdmin, workspaceId, batchUuid, insertedP1PinIds);

    throw new HttpError(500, `Repurpose failed: ${err.message}. Changes have been compensated and rolled back.`);
  }
}
