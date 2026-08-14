export const prerender = false;

import type { APIRoute } from 'astro';
import { validateUserSession } from '../../../server/auth/session';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { dbClients } from '../../../server/db/clients';
import { syncPublishingSchedule } from '../../../server/services/fastcron-service';

export const GET: APIRoute = async ({ locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};

  if (!user || !schedulingClient) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  if (!workspaceId) {
    return new Response(JSON.stringify({ error: 'Active workspace not found' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    await assertWorkspaceAccess(schedulingClient, workspaceId, user.id);
    const adminClient = dbClients.getSchedulingAdmin(runtimeEnv);
    const { data, error } = await adminClient
      .from('posting_schedules')
      .select('*, accounts(account_name)')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return new Response(JSON.stringify(data || []), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Failed to fetch schedules' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  const schedulingClient = locals.supabase;
  const workspaceId = locals.activeWorkspaceId;
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};

  if (!user || !schedulingClient) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  if (!workspaceId) {
    return new Response(JSON.stringify({ error: 'Active workspace not found' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  let body: any = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  if (!body.account_id) {
    return new Response(JSON.stringify({ error: 'account_id is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    await assertWorkspaceAccess(schedulingClient, workspaceId, user.id, 'admin');
    const adminClient = dbClients.getSchedulingAdmin(runtimeEnv);
    const dispatch_token = crypto.randomUUID();
    const newRow = {
      workspace_id: workspaceId,
      account_id: body.account_id,
      label: body.label || '',
      webhook_id: body.webhook_id || null,
      timezone: body.timezone || 'UTC',
      window_start: body.window_start || '09:00',
      window_end: body.window_end || '21:00',
      interval_minutes: body.interval_minutes ?? 36,
      random_delay_minutes: body.random_delay_minutes ?? 0,
      active_days: body.active_days || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
      started_at: body.started_at || null,
      batch: body.batch ?? 1,
      status: 'not_synced',
      dispatch_token,
      fastcron_job_id: null,
      fastcron_token_encrypted: body.fastcron_token_encrypted || null,
    };
    const { data: inserted, error: insertErr } = await adminClient.from('posting_schedules').insert(newRow).select().single();
    if (insertErr || !inserted) throw insertErr || new Error('Insert failed');
    const syncResult = await syncPublishingSchedule(inserted, runtimeEnv);
    if (!syncResult.success) {
      await adminClient.from('posting_schedules').update({ status: 'error' }).eq('id', inserted.id);
    } else {
      await adminClient.from('posting_schedules').update({ status: 'active', fastcron_job_id: syncResult.job_id }).eq('id', inserted.id);
    }
    return new Response(JSON.stringify({ ...inserted, job_id: syncResult.job_id }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Failed to create schedule' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
