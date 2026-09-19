-- ==============================================================================
-- Migration: 20260920000001_p4_retention_index.sql
-- Project 4: PinArchive (kuuugffvyokywtgmdrfk)
-- Domain: Index for Retention Cleanup on pa_pin_metrics
-- ==============================================================================

CREATE INDEX IF NOT EXISTS idx_pa_pin_metrics_ws_recorded 
  ON public.pa_pin_metrics (workspace_id, recorded_at DESC);

SELECT pg_notify('pgrst', 'reload schema');
