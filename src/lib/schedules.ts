import { supabase } from './supabase-client';
import { editedPinsSession } from './supabase-session';
import { mockAccounts, mockPins } from './supabase-mock';

/**
 * In-memory pacing engine calculation for mock/preview data.
 * Computes concrete sequential scheduled_for timestamps for all pending pins on an account.
 */
export function calculateJSPacingForAccount(accountId: string): number {
  const acc = mockAccounts.find((a) => a.id === accountId);
  const winStart = acc?.posting_window_start || '09:00';
  const winEnd = acc?.posting_window_end || '21:00';
  const intervalMins = acc?.posting_interval_minutes || 30;
  const delayMins = acc?.random_delay_minutes || 0;
  let activeDays = acc?.active_days || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  if (typeof activeDays === 'string') {
    activeDays = (activeDays as string).replace(/[{}"']/g, '').split(',').map((d) => d.trim()).filter(Boolean);
  }

  const dayMap: Record<number, string> = { 0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat' };

  // Find latest posted_at for account
  const postedPins = mockPins
    .filter((p) => p.account_id === accountId && p.status === 'posted' && p.posted_at)
    .sort((a, b) => new Date(b.posted_at!).getTime() - new Date(a.posted_at!).getTime());

  let currTime = new Date();
  if (postedPins.length > 0) {
    const latestMs = new Date(postedPins[0].posted_at!).getTime() + intervalMins * 60000;
    if (latestMs > currTime.getTime()) {
      currTime = new Date(latestMs);
    }
  }

  const accountPendingPins = mockPins
    .filter((p) => p.account_id === accountId && p.status === 'pending')
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  let updatedCount = 0;

  for (const pin of accountPendingPins) {
    const jitterMins = delayMins > 0 ? Math.floor(Math.random() * (delayMins + 1)) : 0;
    const stepMins = intervalMins + jitterMins;

    let loopGuard = 0;
    while (loopGuard < 1000) {
      loopGuard++;
      const dayName = dayMap[currTime.getDay()];
      if (Array.isArray(activeDays) && activeDays.length > 0 && !activeDays.includes(dayName)) {
        currTime.setDate(currTime.getDate() + 1);
        const [sH, sM] = winStart.split(':').map(Number);
        currTime.setHours(sH || 9, sM || 0, 0, 0);
        continue;
      }

      const curH = currTime.getHours();
      const curM = currTime.getMinutes();
      const curTotal = curH * 60 + curM;

      const [sH, sM] = winStart.split(':').map(Number);
      const [eH, eM] = winEnd.split(':').map(Number);
      const startTotal = (sH || 9) * 60 + (sM || 0);
      const endTotal = (eH || 21) * 60 + (eM || 0);

      if (startTotal <= endTotal) {
        if (curTotal < startTotal) {
          currTime.setHours(sH || 9, sM || 0, 0, 0);
          continue;
        }
        if (curTotal > endTotal) {
          currTime.setDate(currTime.getDate() + 1);
          currTime.setHours(sH || 9, sM || 0, 0, 0);
          continue;
        }
      } else {
        if (curTotal > endTotal && curTotal < startTotal) {
          currTime.setHours(sH || 9, sM || 0, 0, 0);
          continue;
        }
      }

      break;
    }

    const scheduledIso = currTime.toISOString();
    pin.scheduled_for = scheduledIso;

    // Also sync session map
    const prev = editedPinsSession.get(pin.id) || {};
    editedPinsSession.set(pin.id, { ...prev, scheduled_for: scheduledIso });

    updatedCount++;
    currTime = new Date(currTime.getTime() + stepMins * 60000);
  }

  return updatedCount;
}

/**
 * Invokes PL/pgSQL RPC function to recalculate and store concrete scheduled_for timestamps
 * for all pending pins on a given account based on window, interval, and active days.
 */
export async function rescheduleAccountPendingPins(accountId: string): Promise<{ count: number; error: string | null }> {
  if (!accountId) return { count: 0, error: 'Account ID required' };

  // Always compute in-memory state for mock / local state
  const jsCount = calculateJSPacingForAccount(accountId);

  if (!supabase) {
    return { count: jsCount, error: null };
  }

  try {
    // 1. Try RPC function first if deployed in Supabase
    const { data: rpcData, error: rpcError } = await supabase.rpc('reschedule_account_pending_pins', {
      target_account_id: accountId,
    });

    if (!rpcError && (typeof rpcData === 'number' || rpcData === null)) {
      return { count: typeof rpcData === 'number' ? rpcData : jsCount, error: null };
    }

    console.warn('[schedules] RPC reschedule_account_pending_pins unavailable, entering REST fallback:', rpcError);

    // 2. Direct REST API Fallback: Update Supabase database directly
    const { data: accountData } = await supabase
      .from('accounts')
      .select('posting_window_start, posting_window_end, posting_interval_minutes, random_delay_minutes, active_days')
      .eq('id', accountId)
      .maybeSingle();

    const winStart = accountData?.posting_window_start || '09:00';
    const winEnd = accountData?.posting_window_end || '21:00';
    const intervalMins = accountData?.posting_interval_minutes || 30;
    const delayMins = accountData?.random_delay_minutes || 0;
    let activeDays = accountData?.active_days || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    if (typeof activeDays === 'string') {
      activeDays = (activeDays as string).replace(/[{}"']/g, '').split(',').map((d) => d.trim()).filter(Boolean);
    }

    const dayMap: Record<number, string> = { 0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat' };

    // Fetch latest posted timestamp
    const { data: latestPostedData } = await supabase
      .from('pins')
      .select('posted_at')
      .eq('account_id', accountId)
      .eq('status', 'posted')
      .order('posted_at', { ascending: false })
      .limit(1);

    let currTime = new Date();
    if (latestPostedData && latestPostedData.length > 0 && latestPostedData[0].posted_at) {
      const latestMs = new Date(latestPostedData[0].posted_at).getTime() + intervalMins * 60000;
      if (latestMs > currTime.getTime()) {
        currTime = new Date(latestMs);
      }
    }

    // Fetch all pending pins for account
    const { data: pendingPins, error: fetchErr } = await supabase
      .from('pins')
      .select('id, created_at, scheduled_for')
      .eq('account_id', accountId)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(1000);

    if (fetchErr || !pendingPins || pendingPins.length === 0) {
      return { count: jsCount, error: null };
    }

    const updates: { id: string; scheduled_for: string }[] = [];

    for (const pin of pendingPins) {
      const jitterMins = delayMins > 0 ? Math.floor(Math.random() * (delayMins + 1)) : 0;
      const stepMins = intervalMins + jitterMins;

      let loopGuard = 0;
      while (loopGuard < 1000) {
        loopGuard++;
        const dayName = dayMap[currTime.getDay()];
        if (Array.isArray(activeDays) && activeDays.length > 0 && !activeDays.includes(dayName)) {
          currTime.setDate(currTime.getDate() + 1);
          const [sH, sM] = winStart.split(':').map(Number);
          currTime.setHours(sH || 9, sM || 0, 0, 0);
          continue;
        }

        const curH = currTime.getHours();
        const curM = currTime.getMinutes();
        const curTotal = curH * 60 + curM;

        const [sH, sM] = winStart.split(':').map(Number);
        const [eH, eM] = winEnd.split(':').map(Number);
        const startTotal = (sH || 9) * 60 + (sM || 0);
        const endTotal = (eH || 21) * 60 + (eM || 0);

        if (startTotal <= endTotal) {
          if (curTotal < startTotal) {
            currTime.setHours(sH || 9, sM || 0, 0, 0);
            continue;
          }
          if (curTotal > endTotal) {
            currTime.setDate(currTime.getDate() + 1);
            currTime.setHours(sH || 9, sM || 0, 0, 0);
            continue;
          }
        } else {
          if (curTotal > endTotal && curTotal < startTotal) {
            currTime.setHours(sH || 9, sM || 0, 0, 0);
            continue;
          }
        }

        break;
      }

      const scheduledIso = currTime.toISOString();
      updates.push({
        id: pin.id,
        scheduled_for: scheduledIso,
      });

      currTime = new Date(currTime.getTime() + stepMins * 60000);
    }

    // Direct batch updates in chunks of 50
    for (let i = 0; i < updates.length; i += 50) {
      const chunk = updates.slice(i, i + 50);
      await Promise.all(
        chunk.map((item) =>
          supabase!.from('pins')
            .update({ scheduled_for: item.scheduled_for })
            .eq('id', item.id)
        )
      );
    }

    return { count: updates.length, error: null };
  } catch (err: any) {
    console.warn('rescheduleAccountPendingPins direct fallback exception:', err);
    return { count: jsCount, error: null };
  }
}
