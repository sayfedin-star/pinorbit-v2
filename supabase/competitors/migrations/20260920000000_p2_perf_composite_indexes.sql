-- ==============================================================================
-- Migration: 20260920000000_p2_perf_composite_indexes.sql
-- Project 2: Competitors (guycnhvwfzdzbpgsnavg)
-- Domain: Unindexed FK & Composite Covering Indexes for Boards and Competitor Feeds
-- ==============================================================================

-- 1. Foreign Key Covering Index (Clears 0001_unindexed_foreign_keys)
CREATE INDEX IF NOT EXISTS idx_competitor_schedules_fastcron_token 
  ON public.competitor_schedules (fastcron_token_id) 
  WHERE fastcron_token_id IS NOT NULL;

-- 2. Composite Covering Indexes for Boards Querying (7k+ rows)
-- Optimizes listCompetitorBoards: WHERE workspace_id = $1 AND competitor_id = $2 ORDER BY pin_count DESC
CREATE INDEX IF NOT EXISTS idx_competitor_boards_ws_comp_pin_count 
  ON public.competitor_boards (workspace_id, competitor_id, pin_count DESC NULLS LAST);

-- Optimizes board activity queries: WHERE workspace_id = $1 AND competitor_id = $2 ORDER BY last_pinned_at DESC
CREATE INDEX IF NOT EXISTS idx_competitor_boards_ws_comp_activity 
  ON public.competitor_boards (workspace_id, competitor_id, last_pinned_at DESC NULLS LAST);

-- 3. Composite Covering Indexes for Competitors List & Feed
-- Optimizes listCompetitors: WHERE workspace_id = $1 ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_competitors_ws_created_at 
  ON public.competitors (workspace_id, created_at DESC);

-- Optimizes leaderboard/reach sorting: WHERE workspace_id = $1 ORDER BY profile_reach DESC
CREATE INDEX IF NOT EXISTS idx_competitors_ws_reach 
  ON public.competitors (workspace_id, profile_reach DESC NULLS LAST);

-- 4. Reload PostgREST schema cache
SELECT pg_notify('pgrst', 'reload schema');
