-- Migration: 20260910000000_add_pa_pins_ws_acc_saves_idx.sql
-- Description: Composite index on pa_pins (workspace_id, account_id, saves DESC)
-- Target Database: Project 4 (PinArchive) ONLY

CREATE INDEX IF NOT EXISTS idx_pa_pins_ws_acc_saves
  ON public.pa_pins (workspace_id, account_id, saves DESC);

NOTIFY pgrst, 'reload schema';

-- DOWN (Rollback Documentation):
-- DROP INDEX IF EXISTS public.idx_pa_pins_ws_acc_saves;
