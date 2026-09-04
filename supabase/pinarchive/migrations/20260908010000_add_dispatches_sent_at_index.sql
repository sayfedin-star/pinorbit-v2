-- Migration: Add keyset cursor index on pa_pin_dispatches (D37)
-- Supports efficient (workspace_id, sent_at DESC, id DESC) keyset tie-breaker for Dispatched Ledger

CREATE INDEX IF NOT EXISTS idx_pa_pin_dispatches_ws_sent_cursor 
  ON public.pa_pin_dispatches (workspace_id, sent_at DESC, id DESC);
