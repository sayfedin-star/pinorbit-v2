-- Migration: 20260920000002_p1_retention_range_check_constraints.sql
-- Add strict CHECK constraints to prevent accidental zero-wipe or out-of-range values in workspace_retention_settings.

ALTER TABLE public.workspace_retention_settings
  DROP CONSTRAINT IF EXISTS chk_retention_posted_days,
  DROP CONSTRAINT IF EXISTS chk_retention_terminal_days,
  DROP CONSTRAINT IF EXISTS chk_retention_logs_days,
  DROP CONSTRAINT IF EXISTS chk_import_sessions_days,
  DROP CONSTRAINT IF EXISTS chk_processing_timeout_minutes,
  DROP CONSTRAINT IF EXISTS chk_competitor_snapshots_days,
  DROP CONSTRAINT IF EXISTS chk_competitor_jobs_days,
  DROP CONSTRAINT IF EXISTS chk_ingestion_runs_days,
  DROP CONSTRAINT IF EXISTS chk_top_pins_raw_days,
  DROP CONSTRAINT IF EXISTS chk_analytics_daily_keep_days,
  DROP CONSTRAINT IF EXISTS chk_pa_runs_retention_days,
  DROP CONSTRAINT IF EXISTS chk_pa_metrics_retention_days;

ALTER TABLE public.workspace_retention_settings
  ADD CONSTRAINT chk_retention_posted_days
    CHECK (retention_posted_days >= 1 AND retention_posted_days <= 365),
  ADD CONSTRAINT chk_retention_terminal_days
    CHECK (retention_terminal_days >= 1 AND retention_terminal_days <= 365),
  ADD CONSTRAINT chk_retention_logs_days
    CHECK (retention_logs_days >= 1 AND retention_logs_days <= 180),
  ADD CONSTRAINT chk_import_sessions_days
    CHECK (import_sessions_days >= 1 AND import_sessions_days <= 365),
  ADD CONSTRAINT chk_processing_timeout_minutes
    CHECK (processing_timeout_minutes >= 5 AND processing_timeout_minutes <= 240),
  ADD CONSTRAINT chk_competitor_snapshots_days
    CHECK (competitor_snapshots_days >= 1 AND competitor_snapshots_days <= 365),
  ADD CONSTRAINT chk_competitor_jobs_days
    CHECK (competitor_jobs_days >= 1 AND competitor_jobs_days <= 180),
  ADD CONSTRAINT chk_ingestion_runs_days
    CHECK (ingestion_runs_days >= 1 AND ingestion_runs_days <= 365),
  ADD CONSTRAINT chk_top_pins_raw_days
    CHECK (top_pins_raw_days >= 1 AND top_pins_raw_days <= 730),
  ADD CONSTRAINT chk_analytics_daily_keep_days
    CHECK (analytics_daily_keep_days IS NULL OR (analytics_daily_keep_days >= 1 AND analytics_daily_keep_days <= 730)),
  ADD CONSTRAINT chk_pa_runs_retention_days
    CHECK (pa_runs_retention_days >= 1 AND pa_runs_retention_days <= 365),
  ADD CONSTRAINT chk_pa_metrics_retention_days
    CHECK (pa_metrics_retention_days >= 1 AND pa_metrics_retention_days <= 365);

SELECT pg_notify('pgrst', 'reload schema');
