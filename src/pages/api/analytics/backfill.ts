export const prerender = false;

import type { APIRoute } from 'astro';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { analyticsDb } from '../../../server/db/analytics';
import { fastcronService } from '../../../server/services/fastcron-service';

/**
 * Public User-Facing Backfill Management API.
 * Supports:
 * - GET: Fetch active backfill job for a connection
 * - POST action='start': Launch a Cloud Background Backfill via FastCron
 * - POST action='pause': Pause the FastCron recurring job
 * - POST action='resume': Resume the FastCron recurring job
 * - POST action='cancel': Cancel and delete the FastCron recurring job
 */
export const GET: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};

  if (!user || !schedulingClient) {
    return new Response(
      JSON.stringify({ success: false, error: 'Unauthorized: authentication required.' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (!workspaceId) {
    return new Response(
      JSON.stringify({ success: false, error: 'Active workspace not found in session.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const url = new URL(request.url);
  const connectionId = url.searchParams.get('connection_id');
  const channel = (url.searchParams.get('channel') || 'top_pins') as 'account_analytics' | 'top_pins';

  if (!connectionId) {
    return new Response(
      JSON.stringify({ success: false, error: 'connection_id is required.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    await assertWorkspaceAccess(schedulingClient, workspaceId, user.id);
    const job = await analyticsDb.getActiveBackfillJob(workspaceId, connectionId, channel, runtimeEnv);
    return new Response(
      JSON.stringify({ success: true, data: job }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: err.message || 'Internal server error.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};

  if (!user || !schedulingClient) {
    return new Response(
      JSON.stringify({ success: false, error: 'Unauthorized: authentication required.' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (!workspaceId) {
    return new Response(
      JSON.stringify({ success: false, error: 'Active workspace not found in session.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let body: any = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return new Response(
      JSON.stringify({ success: false, error: 'Invalid JSON body.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const action = body.action || 'start';

  try {
    await assertWorkspaceAccess(schedulingClient, workspaceId, user.id);

    if (action === 'start') {
      const connectionId = body.connection_id;
      const channel = (body.channel || 'top_pins') as 'account_analytics' | 'top_pins';
      const fromDate = body.from_date || body.start_date;
      const toDate = body.to_date || body.end_date;
      const intervalMinutes = Math.max(1, parseInt(body.interval_minutes, 10) || 1);

      if (!connectionId) {
        return new Response(
          JSON.stringify({ success: false, error: 'connection_id is required.' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (!fromDate || !toDate) {
        return new Response(
          JSON.stringify({ success: false, error: 'Both from_date and to_date are required.' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (fromDate > toDate) {
        return new Response(
          JSON.stringify({ success: false, error: 'from_date must be before or equal to to_date.' }),
          { status: 422, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // 90-Day Lookback Guard for Pinterest API
      const now = new Date();
      const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 90, 0, 0, 0));
      const cutoffStr = cutoff.toISOString().split('T')[0];
      if (fromDate < cutoffStr) {
        return new Response(
          JSON.stringify({
            success: false,
            error: `Pinterest API Limit: Start date cannot be older than 90 days from today (Earliest allowed: ${cutoffStr}).`,
          }),
          { status: 422, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Check for active job
      const existing = await analyticsDb.getActiveBackfillJob(workspaceId, connectionId, channel, runtimeEnv);
      if (existing) {
        return new Response(
          JSON.stringify({
            success: false,
            error: `An active backfill job (${existing.id}) is already ${existing.status}. Pause, resume, or cancel it first.`,
            data: existing,
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Calculate total days
      const [sY, sM, sD] = fromDate.split('-').map(Number);
      const [eY, eM, eD] = toDate.split('-').map(Number);
      const sUtc = Date.UTC(sY, sM - 1, sD);
      const eUtc = Date.UTC(eY, eM - 1, eD);
      const totalDays = Math.round((eUtc - sUtc) / (24 * 60 * 60 * 1000)) + 1;

      // 1. Create DB record
      const job = await analyticsDb.createBackfillJob({
        workspaceId,
        connectionId,
        channel,
        startDate: fromDate,
        endDate: toDate,
        totalDays,
        intervalMinutes,
      }, runtimeEnv);

      // 2. Register FastCron recurring job
      const cronRes = await fastcronService.createBackfillCronJob(
        workspaceId,
        connectionId,
        job.id,
        intervalMinutes,
        runtimeEnv
      );

      if (!cronRes.success || !cronRes.jobId) {
        await analyticsDb.updateBackfillJob(job.id, {
          status: 'failed',
          error_details: { error: cronRes.error || 'Failed to create FastCron job' },
        }, runtimeEnv);

        return new Response(
          JSON.stringify({
            success: false,
            error: `Failed to register FastCron job: ${cronRes.error || 'Unknown error'}`,
          }),
          { status: 502, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // 3. Link FastCron job ID in DB
      const updatedJob = await analyticsDb.updateBackfillJob(job.id, {
        fastcron_job_id: cronRes.jobId,
      }, runtimeEnv);

      return new Response(
        JSON.stringify({
          success: true,
          message: `Cloud background backfill successfully started (${totalDays} days). FastCron job #${cronRes.jobId} created.`,
          data: updatedJob,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (action === 'pause') {
      const jobId = body.job_id;
      if (!jobId) {
        return new Response(
          JSON.stringify({ success: false, error: 'job_id is required.' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const job = await analyticsDb.getBackfillJobById(jobId, runtimeEnv);
      if (!job || job.workspace_id !== workspaceId) {
        return new Response(
          JSON.stringify({ success: false, error: 'Job not found.' }),
          { status: 404, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (job.fastcron_job_id) {
        await fastcronService.pauseBackfillCronJob(workspaceId, job.fastcron_job_id, runtimeEnv, job.connection_id);
      }

      const updated = await analyticsDb.updateBackfillJob(job.id, { status: 'paused' }, runtimeEnv);
      return new Response(
        JSON.stringify({ success: true, message: 'Backfill paused.', data: updated }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (action === 'resume') {
      const jobId = body.job_id;
      if (!jobId) {
        return new Response(
          JSON.stringify({ success: false, error: 'job_id is required.' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const job = await analyticsDb.getBackfillJobById(jobId, runtimeEnv);
      if (!job || job.workspace_id !== workspaceId) {
        return new Response(
          JSON.stringify({ success: false, error: 'Job not found.' }),
          { status: 404, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (job.fastcron_job_id) {
        await fastcronService.resumeBackfillCronJob(workspaceId, job.fastcron_job_id, runtimeEnv, job.connection_id);
      }

      const updated = await analyticsDb.updateBackfillJob(job.id, { status: 'running' }, runtimeEnv);
      return new Response(
        JSON.stringify({ success: true, message: 'Backfill resumed.', data: updated }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (action === 'cancel') {
      const jobId = body.job_id;
      if (!jobId) {
        return new Response(
          JSON.stringify({ success: false, error: 'job_id is required.' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const job = await analyticsDb.getBackfillJobById(jobId, runtimeEnv);
      if (!job || job.workspace_id !== workspaceId) {
        return new Response(
          JSON.stringify({ success: false, error: 'Job not found.' }),
          { status: 404, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (job.fastcron_job_id) {
        await fastcronService.deleteBackfillCronJob(workspaceId, job.fastcron_job_id, runtimeEnv, job.connection_id);
      }

      const updated = await analyticsDb.updateBackfillJob(job.id, { status: 'cancelled' }, runtimeEnv);
      return new Response(
        JSON.stringify({ success: true, message: 'Backfill cancelled and FastCron job deleted.', data: updated }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ success: false, error: `Invalid action "${action}". Allowed: start, pause, resume, cancel.` }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: err.message || 'Internal server error.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
