-- Migration: 20260911010000_p4_concurrent_indexes.sql
-- Description: Concurrent composite and partial indexes for PinArchive P4 performance & multi-tenant isolation
-- Target Database: Project 4 (PinArchive) ONLY (kuuugffvyokywtgmdrfk)
-- Note: Apply outside a transaction block (e.g. Supabase Dashboard SQL Editor).

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dispatches_ws_pin_acc
  ON public.pa_pin_dispatches (workspace_id, pa_pin_id, target_account_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pins_ws_acc_board
  ON public.pa_pins (workspace_id, account_id, board_name);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pins_arch_null
  ON public.pa_pins (workspace_id)
  WHERE archived_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dispatches_ws_p1
  ON public.pa_pin_dispatches (workspace_id, p1_pin_id);

NOTIFY pgrst, 'reload schema';

-- DOWN (Rollback Documentation):
-- DROP INDEX CONCURRENTLY IF EXISTS public.idx_dispatches_ws_pin_acc;
-- DROP INDEX CONCURRENTLY IF EXISTS public.idx_pins_ws_acc_board;
-- DROP INDEX CONCURRENTLY IF EXISTS public.idx_pins_arch_null;
-- DROP INDEX CONCURRENTLY IF EXISTS public.idx_dispatches_ws_p1;
