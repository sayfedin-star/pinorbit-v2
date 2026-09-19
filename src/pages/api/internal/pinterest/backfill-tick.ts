export const prerender = false;

import type { APIRoute } from 'astro';
import { analyticsDb } from '../../../../server/db/analytics';
import { verifyIngestSecret } from '../../../../server/services/webhook-secrets';
import { fastcronService, SORT_MODES } from '../../../../server/services/fastcron-service';
import { validateSafeUrl } from '../../../../server/lib/ssrf-guard';

/**
 * Server-Only Internal Backfill Tick Endpoint.
 * Invoked on a recurring schedule (e.g. every 1 minute) by FastCron.
 *
 * Execution logic:
 * 1. Authenticates request via x-ingest-secret.
 * 2. Fetches backfill job and performs defensive cleanup (cron_delete if already finished).
 * 3. Atomically claims the tick (concurrency guard).
 * 4. Dispatches the current day to Make.com channel webhook URL.
 * 5. Advances current_date to next day (using UTC midday date math).
 * 6. If the final day was processed, marks job completed and auto-deletes the FastCron recurring job.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};

  try {
    // 1. Authenticate immediately via secret header presence
    const ingestSecret = request.headers.get('x-ingest-secret') || request.headers.get('x-dispatch-secret');
    if (!ingestSecret) {
      return new Response(
        JSON.stringify({ success: false, error: 'Unauthorized: missing authentication header.' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 2. Parse JSON body
    let body: Record<string, any>;
    try {
      const text = await request.text();
      if (!text || text.trim().length === 0) {
        return new Response(
          JSON.stringify({ success: false, error: 'Empty request payload.' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      body = JSON.parse(text);
    } catch (err: any) {
      return new Response(
        JSON.stringify({ success: false, error: 'Malformed JSON payload: ' + err.message }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const backfillJobId = body.backfill_job_id;
    if (!backfillJobId) {
      return new Response(
        JSON.stringify({ success: false, error: 'backfill_job_id is required.' }),
        { status: 422, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 3. Fetch the backfill job
    const job = await analyticsDb.getBackfillJobById(backfillJobId, runtimeEnv);
    if (!job) {
      return new Response(
        JSON.stringify({ success: false, error: 'Backfill job not found.' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 4. Authenticate secret against workspace secret
    const authVerif = await verifyIngestSecret(ingestSecret, job.workspace_id, runtimeEnv);
    if (!authVerif.valid) {
      return new Response(
        JSON.stringify({ success: false, error: 'Unauthorized: invalid authentication secret.' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 5. Defensive Cleanup Guard: if job is already terminated, ensure FastCron job is deleted
    if (job.status === 'completed' || job.status === 'cancelled' || job.status === 'failed') {
      if (job.fastcron_job_id) {
        await fastcronService.deleteBackfillCronJob(job.workspace_id, job.fastcron_job_id, runtimeEnv, job.connection_id);
      }
      return new Response(
        JSON.stringify({
          success: true,
          message: `Backfill job ${job.id} is already ${job.status}. Cleaned up FastCron job.`,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (job.status === 'paused') {
      return new Response(
        JSON.stringify({
          success: true,
          message: `Backfill job ${job.id} is currently paused. Skipping tick.`,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 6. Concurrency Guard: Atomically claim tick
    const claimedJob = await analyticsDb.claimBackfillTick(job.id, runtimeEnv);
    if (!claimedJob) {
      return new Response(
        JSON.stringify({
          success: true,
          message: 'Tick execution already in progress or executed within last 30s. Skipping duplicate.',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 7. Fetch connection details and resolve webhook
    const connection = await analyticsDb.getWorkspaceConnection(claimedJob.workspace_id, claimedJob.connection_id);
    if (!connection) {
      await analyticsDb.updateBackfillJob(claimedJob.id, {
        status: 'failed',
        error_details: { error: 'Connection not found or has been deleted.' },
      }, runtimeEnv);
      if (claimedJob.fastcron_job_id) {
        await fastcronService.deleteBackfillCronJob(claimedJob.workspace_id, claimedJob.fastcron_job_id, runtimeEnv, claimedJob.connection_id);
      }
      return new Response(
        JSON.stringify({ success: false, error: 'Connection not found.' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const isTopPins = claimedJob.channel === 'top_pins';
    const webhookUrl = isTopPins
      ? connection.top_pins_webhook_url
      : connection.analytics_webhook_url;

    if (!webhookUrl) {
      await analyticsDb.updateBackfillJob(claimedJob.id, {
        status: 'failed',
        error_details: { error: 'Webhook URL not configured for channel.' },
      }, runtimeEnv);
      if (claimedJob.fastcron_job_id) {
        await fastcronService.deleteBackfillCronJob(claimedJob.workspace_id, claimedJob.fastcron_job_id, runtimeEnv, claimedJob.connection_id);
      }
      return new Response(
        JSON.stringify({ success: false, error: 'Webhook URL not configured.' }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 8. Dispatch single day to Make.com
    const currentDay = claimedJob.current_date;
    const endDay = claimedJob.end_date;
    const isLastDay = currentDay >= endDay;

    const effectiveSortModes = connection.top_pins_sort_modes && connection.top_pins_sort_modes.length > 0
      ? connection.top_pins_sort_modes
      : SORT_MODES;

    const payload: Record<string, any> = {
      job_type: 'backfill',
      channel: claimedJob.channel,
      connection_id: connection.id,
      start_date: currentDay,
      end_date: currentDay,
      backfill_job_id: claimedJob.id,
    };

    if (isTopPins) {
      payload.top_pins_start_offset_days = connection.top_pins_start_offset_days ?? 7;
      payload.top_pins_end_offset_days = connection.top_pins_end_offset_days ?? 2;
      payload.num_of_pins = connection.top_pins_num_of_pins || 50;
      payload.sort_modes = effectiveSortModes;
    } else {
      payload.analytics_start_offset_days = connection.analytics_start_offset_days ?? 7;
      payload.analytics_end_offset_days = connection.analytics_end_offset_days ?? 1;
    }

    let dispatchSuccess = false;
    let dispatchError: string | undefined;

    try {
      validateSafeUrl(webhookUrl);
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });

      dispatchSuccess = res.ok;
      if (!res.ok) {
        dispatchError = `Make.com returned HTTP ${res.status}`;
      }
    } catch (err: any) {
      dispatchSuccess = false;
      dispatchError = `Dispatch failed: ${err.message || 'Network error'}`;
    }

    // 9. Compute next day using UTC midday math
    let nextDateStr = currentDay;
    if (!isLastDay) {
      const [y, m, d] = currentDay.split('-').map(Number);
      const nextDate = new Date(Date.UTC(y, m - 1, d + 1, 12, 0, 0));
      nextDateStr = nextDate.toISOString().split('T')[0];
    }

    // 10. Advance job in DB
    const updatedJob = await analyticsDb.advanceBackfillJob(
      claimedJob.id,
      {
        nextDate: nextDateStr,
        isFinished: isLastDay,
        failed: !dispatchSuccess,
        error: dispatchError,
      },
      runtimeEnv
    );

    // 11. If finished, auto-destruct the FastCron recurring job
    if (isLastDay && claimedJob.fastcron_job_id) {
      await fastcronService.deleteBackfillCronJob(
        claimedJob.workspace_id,
        claimedJob.fastcron_job_id,
        runtimeEnv,
        claimedJob.connection_id
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        processed_date: currentDay,
        next_date: nextDateStr,
        is_finished: isLastDay,
        dispatch_status: dispatchSuccess ? 'success' : 'failed',
        error: dispatchError,
        job: updatedJob,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (fatalErr: any) {
    return new Response(
      JSON.stringify({
        success: false,
        error: `Internal tick failure: ${fatalErr.message || 'Unknown error'}`,
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
