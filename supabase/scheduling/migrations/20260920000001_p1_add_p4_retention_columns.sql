-- Migration: 20260920000001_p1_add_p4_retention_columns.sql
-- Expand workspace_retention_settings to support PinArchive (P4) retention control
-- All automation defaults to DISABLED (false).

ALTER TABLE public.workspace_retention_settings
  ADD COLUMN IF NOT EXISTS p4_prune_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pa_runs_retention_days INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS pa_metrics_retention_days INTEGER NOT NULL DEFAULT 90;

-- Notify PostgREST schema cache
SELECT pg_notify('pgrst', 'reload schema');
