export const prerender = false;
import type { APIRoute } from 'astro';
import { dbClients, hasSchedulingSecretKey } from '../../../../server/db/clients';

const json = (o: any, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ request, locals }) => {
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};
  let body: any = {};
  try { body = JSON.parse((await request.text()) || '{}'); } catch { return json({ success: false, error: 'Malformed JSON payload.' }, 400); }

  const scheduleId = typeof body.schedule_id === 'string' ? body.schedule_id : '';
  const token = typeof body.dispatch_token === 'string' ? body.dispatch_token : '';
  if (!scheduleId || !token) return json({ success: false, error: 'schedule_id and dispatch_token are required.' }, 400);
  if (!hasSchedulingSecretKey(runtimeEnv)) return json({ success: false, error: 'SCHEDULING_SUPABASE_SECRET_KEY not configured; dispatch disabled.' }, 503);

  const admin = dbClients.getSchedulingAdmin(runtimeEnv);

  // 1) Load schedule + authenticate via per-schedule dispatch token
  const { data: schedule } = await admin.from('posting_schedules').select('*').eq('id', scheduleId).maybeSingle();
  if (!schedule || schedule.dispatch_token !== token) return json({ success: false, error: 'Unauthorized: invalid schedule or dispatch token.' }, 401);
  if (schedule.status !== 'active') return json({ success: true, dispatched: false, reason: 'paused' });
  if (schedule.started_at && new Date(schedule.started_at).getTime() > Date.now()) return json({ success: true, dispatched: false, reason: 'not_started' });

  const accountId = schedule.account_id;
  const workspaceId = schedule.workspace_id;

  // 2) Stale lock recovery
  const staleCut = new Date(Date.now() - 10 * 60000).toISOString();
  await admin.from('pins').update({ status: 'pending', processing_started_at: null, updated_at: new Date().toISOString() })
    .eq('status', 'processing').lt('processing_started_at', staleCut).then(() => {});

  // 3) Account + daily cap
  const { data: account } = await admin.from('accounts').select('*').eq('id', accountId).maybeSingle();
  if (!account || account.is_active === false) return json({ success: true, dispatched: false, reason: 'account_inactive' });
  const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
  const { count: postedToday } = await admin.from('pins').select('*', { count: 'exact', head: true })
    .eq('account_id', accountId).eq('status', 'posted').gte('posted_at', todayStart.toISOString());
  if ((postedToday ?? 0) >= (account.max_pins_per_day ?? 20)) return json({ success: true, dispatched: false, reason: 'cap_reached' });

  // 4) Atomic claim
  const { data: claimed } = await admin.rpc('claim_due_pins_simple', { p_account_id: accountId, p_limit: schedule.batch ?? 1 });
  if (!claimed || claimed.length === 0) return json({ success: true, dispatched: false, reason: 'no_due_pins' });

  // 5) Webhook channel (schedule's channel first, then any with capacity)
  const { data: hooks } = await admin.from('account_webhooks').select('*').eq('account_id', accountId).eq('is_active', true).order('priority', { ascending: true });
  const hook = (hooks || []).find((h: any) => h.id === schedule.webhook_id && (h.remaining_capacity ?? 0) > 0)
    || (hooks || []).find((h: any) => (h.remaining_capacity ?? 0) > 0);
  if (!hook?.webhook_url) {
    for (const c of claimed) await admin.from('pins').update({ status: 'pending', processing_started_at: null, updated_at: new Date().toISOString() }).eq('id', c.id);
    return json({ success: true, dispatched: false, reason: 'no_webhook_capacity' });
  }

  // 6) Board resolution + push tickets to Make
  let dispatched = 0; let skipped = 0;
  for (const c of claimed) {
    const { data: pin } = await admin.from('pins').select('*').eq('id', c.id).single();
    if (!pin) { skipped++; continue; }
    let boardId: string | null = null;
    if (pin.board_name) {
      const { data: board } = await admin.from('boards').select('pinterest_board_id')
        .eq('account_id', accountId).ilike('board_name', String(pin.board_name))
        .not('pinterest_board_id', 'is', null).maybeSingle();
      boardId = board?.pinterest_board_id || null;
    }
    if (!boardId) {
      if (account.auto_create_missing_boards && pin.board_name) {
        const idem = `board.create:${accountId}:${String(pin.board_name).toLowerCase()}`;
        await admin.from('board_provisioning_requests').upsert({ workspace_id: workspaceId, account_id: accountId, board_name: pin.board_name, idempotency_key: idem, status: 'provisioning', webhook_id: hook.id }, { onConflict: 'idempotency_key' }).then(() => {});
        await fetch(hook.webhook_url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ event: 'board.create', idempotency_key: idem, account_id: accountId, workspace_id: workspaceId, board_name: pin.board_name, webhook_id: hook.id }), signal: AbortSignal.timeout(8000) }).catch(() => {});
      }
      await admin.from('pins').update({ status: 'pending', processing_started_at: null, updated_at: new Date().toISOString() }).eq('id', c.id);
      skipped++; continue;
    }
    await fetch(hook.webhook_url, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        event: 'pin.post',
        idempotency_key: `pin.post:${pin.id}:${pin.attempts}`,
        pin_id: pin.id, workspace_id: workspaceId, account_id: accountId,
        title: pin.title, description: pin.description, image_url: pin.image_url, link: pin.link,
        board_name: pin.board_name, board_id: boardId,
      }),
      signal: AbortSignal.timeout(8000),
    }).catch(() => {});
    dispatched++;
  }
  return json({ success: true, dispatched, skipped });
};
