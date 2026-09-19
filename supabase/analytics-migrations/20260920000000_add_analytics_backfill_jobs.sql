-- ============================================================================
-- Migration: Add analytics_backfill_jobs to Project 3 (Analytics)
-- Project: Project 3 (Analytics Data Warehouse & Control Plane - jxdkbwnwtjelznmauwpc)
-- Purpose: Persistent background execution tracking for FastCron Recurring Loop
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.analytics_backfill_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  connection_id UUID NOT NULL
    REFERENCES public.analytics_connections(id) ON DELETE CASCADE,
  channel TEXT NOT NULL
    CHECK (channel IN ('account_analytics', 'top_pins')),
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'paused', 'completed', 'failed', 'cancelled')),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  current_date DATE NOT NULL,
  total_days INTEGER NOT NULL CHECK (total_days > 0),
  completed_days INTEGER NOT NULL DEFAULT 0 CHECK (completed_days >= 0),
  failed_days INTEGER NOT NULL DEFAULT 0 CHECK (failed_days >= 0),
  interval_minutes INTEGER NOT NULL DEFAULT 1 CHECK (interval_minutes >= 1),
  fastcron_job_id BIGINT,
  last_run_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_backfill_dates CHECK (start_date <= end_date)
);

-- Indexes for efficient lookup of active/recent jobs
CREATE INDEX IF NOT EXISTS idx_backfill_jobs_conn_status
  ON public.analytics_backfill_jobs (connection_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_backfill_jobs_ws_status
  ON public.analytics_backfill_jobs (workspace_id, status, created_at DESC);

-- Enable Row-Level Security
ALTER TABLE public.analytics_backfill_jobs ENABLE ROW LEVEL SECURITY;

-- Service Role Full Access Policy
DROP POLICY IF EXISTS "service_role_analytics_backfill_jobs_all" ON public.analytics_backfill_jobs;
CREATE POLICY "service_role_analytics_backfill_jobs_all"
  ON public.analytics_backfill_jobs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
