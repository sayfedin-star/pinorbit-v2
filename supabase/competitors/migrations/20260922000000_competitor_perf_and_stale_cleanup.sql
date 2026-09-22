-- ==============================================================================
-- Migration: 20260922000000_competitor_perf_and_stale_cleanup.sql
-- Project: Project 2 (Competitors Intelligence)
-- Domain: Automation, Performance, Concurrency & Self-Heal
-- ==============================================================================

-- 1. Add github_schedule_enabled column to competitor_pipeline_settings
ALTER TABLE public.competitor_pipeline_settings 
ADD COLUMN IF NOT EXISTS github_schedule_enabled BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.competitor_pipeline_settings.github_schedule_enabled 
IS 'Enables or disables GitHub Actions built-in scheduled pipeline runs (02:00 UTC) for this workspace';

-- 2. Create LRU composite index on pinterest_cookies for fast cookie picking
CREATE INDEX IF NOT EXISTS idx_pinterest_cookies_lru 
ON public.pinterest_cookies (workspace_id, is_active, last_used_at NULLS FIRST, created_at);

-- 3. Atomic Cookie Picker Function with FOR UPDATE SKIP LOCKED
CREATE OR REPLACE FUNCTION public.pick_vault_cookie(p_workspace_id UUID)
RETURNS TABLE (
  id UUID,
  cookie_value TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id UUID;
  v_val TEXT;
BEGIN
  SELECT c.id, c.cookie_value
  INTO v_id, v_val
  FROM public.pinterest_cookies c
  WHERE c.workspace_id = p_workspace_id
    AND c.is_active = true
  ORDER BY c.last_used_at ASC NULLS FIRST, c.created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_id IS NOT NULL THEN
    UPDATE public.pinterest_cookies
    SET last_used_at = NOW(),
        updated_at = NOW()
    WHERE public.pinterest_cookies.id = v_id;

    RETURN QUERY SELECT v_id, v_val;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.pick_vault_cookie(UUID) FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.pick_vault_cookie(UUID) TO service_role;

-- 4. Cleanup Stale Competitor Jobs Function (> 30 minutes in running status)
CREATE OR REPLACE FUNCTION public.cleanup_stale_competitor_jobs(p_interval_minutes INT DEFAULT 30)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count INT := 0;
BEGIN
  WITH updated AS (
    UPDATE public.competitor_ingestion_jobs
    SET status = 'failed',
        error_message = 'Job timed out in running status (> ' || p_interval_minutes || ' minutes)',
        completed_at = NOW()
    WHERE status = 'running'
      AND COALESCE(started_at, created_at) < NOW() - (p_interval_minutes || ' minutes')::INTERVAL
    RETURNING id
  )
  SELECT count(*) INTO v_count FROM updated;
  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cleanup_stale_competitor_jobs(INT) FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.cleanup_stale_competitor_jobs(INT) TO service_role;

-- 5. Reload PostgREST schema cache
SELECT pg_notify('pgrst', 'reload schema');
