-- Migration: 20260922000002_competitor_rpc_aggregates.sql
-- Description: Adds get_competitor_board_counts and get_latest_competitor_snapshots RPCs for high-performance dashboard queries

-- 1. get_competitor_board_counts: Returns exact board counts per competitor in a workspace using Index-Only Scan
CREATE OR REPLACE FUNCTION public.get_competitor_board_counts(p_workspace_id uuid)
RETURNS TABLE (
  competitor_id uuid,
  board_count bigint
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT competitor_id, count(*)::bigint
  FROM public.competitor_boards
  WHERE workspace_id = p_workspace_id
  GROUP BY competitor_id;
$$;

REVOKE ALL ON FUNCTION public.get_competitor_board_counts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_competitor_board_counts(uuid) TO service_role, authenticated;

-- 2. get_latest_competitor_snapshots: Returns up to 2 latest snapshots per competitor in a single lateral query
CREATE OR REPLACE FUNCTION public.get_latest_competitor_snapshots(p_competitor_ids uuid[])
RETURNS TABLE (
  competitor_id uuid,
  profile_reach bigint,
  profile_views bigint,
  follower_count integer,
  pin_count integer,
  recorded_at timestamp with time zone
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT s.competitor_id, s.profile_reach, s.profile_views, s.follower_count, s.pin_count, s.recorded_at
  FROM unnest(p_competitor_ids) AS cid
  CROSS JOIN LATERAL (
    SELECT cs.competitor_id, cs.profile_reach, cs.profile_views, cs.follower_count, cs.pin_count, cs.recorded_at
    FROM public.competitor_snapshots cs
    WHERE cs.competitor_id = cid
    ORDER BY cs.recorded_at DESC
    LIMIT 2
  ) s;
$$;

REVOKE ALL ON FUNCTION public.get_latest_competitor_snapshots(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_latest_competitor_snapshots(uuid[]) TO service_role, authenticated;

-- 3. Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
