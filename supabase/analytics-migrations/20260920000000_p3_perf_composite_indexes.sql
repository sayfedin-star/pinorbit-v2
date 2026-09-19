-- ==============================================================================
-- Migration: 20260920000000_p3_perf_composite_indexes.sql
-- Project 3: Analytics (jxdkbwnwtjelznmauwpc)
-- Domain: Composite Covering Indexes for Top Pins, Stale Sweeper Partial Index, Search Path Fix
-- ==============================================================================

-- 1. Partial Index for Ingestion Stale Sweeper (runs on every createIngestionRun)
CREATE INDEX IF NOT EXISTS idx_ingestion_runs_stale_sweeper 
  ON public.analytics_ingestion_runs (workspace_id, connection_id, started_at) 
  WHERE (status = 'processing');

-- 2. Composite Covering Index for Top Pins Windowed Queries
-- Optimizes getTopPins: WHERE workspace_id = $1 AND connection_id = $2 AND sort_by = $3 AND window_start = $4 AND window_end = $5 ORDER BY rank_position ASC
CREATE INDEX IF NOT EXISTS idx_top_pins_ws_conn_sort_window_rank 
  ON public.top_pins_snapshots (workspace_id, connection_id, sort_by, window_start, window_end, rank_position ASC);

-- 3. Composite Covering Index for Top Pins Trend Queries
-- Optimizes getPinTrend: WHERE workspace_id = $1 AND connection_id = $2 AND pin_id = $3 AND sort_by = $4 AND window_end >= $5 ORDER BY window_end ASC
CREATE INDEX IF NOT EXISTS idx_top_pins_ws_conn_pin_trend 
  ON public.top_pins_snapshots (workspace_id, connection_id, pin_id, sort_by, window_end ASC);

-- 4. Fix 0011_function_search_path_mutable on public.daily_totals
CREATE OR REPLACE FUNCTION public.daily_totals(
  p_workspace uuid, 
  p_connection uuid, 
  p_from date DEFAULT NULL::date, 
  p_to date DEFAULT NULL::date
)
RETURNS TABLE(impressions bigint, engagements bigint, outbound_clicks bigint, pin_clicks bigint, saves bigint, ready_days integer, total_rows integer)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $function$
  SELECT COALESCE(SUM(impressions),0), COALESCE(SUM(engagements),0),
         COALESCE(SUM(outbound_clicks),0), COALESCE(SUM(pin_clicks),0),
         COALESCE(SUM(saves),0),
         COUNT(*) FILTER (WHERE data_status = 'READY'),
         COUNT(*)
  FROM public.account_analytics_daily
  WHERE workspace_id = p_workspace AND connection_id = p_connection
    AND (p_from IS NULL OR metric_date >= p_from)
    AND (p_to   IS NULL OR metric_date <= p_to);
$function$;

-- 5. Reload PostgREST schema cache
SELECT pg_notify('pgrst', 'reload schema');
