-- ==============================================================================
-- Migration: 20260930000000_increment_competitor_job_processed.sql
-- Project: Project 2 (Competitors Intelligence)
-- Domain: Automation, Concurrency, Sharded Matrix Telemetry
-- ==============================================================================

-- Atomic Increment for competitor_ingestion_jobs across parallel matrix shards
CREATE OR REPLACE FUNCTION public.increment_competitor_job_processed(p_job_id UUID, p_inc INT DEFAULT 1)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    new_count INT;
BEGIN
    UPDATE public.competitor_ingestion_jobs
    SET items_processed = COALESCE(items_processed, 0) + p_inc
    WHERE id = p_job_id
    RETURNING items_processed INTO new_count;
    RETURN new_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.increment_competitor_job_processed(UUID, INT) FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_competitor_job_processed(UUID, INT) TO service_role;

-- Reload PostgREST schema cache
SELECT pg_notify('pgrst', 'reload schema');
