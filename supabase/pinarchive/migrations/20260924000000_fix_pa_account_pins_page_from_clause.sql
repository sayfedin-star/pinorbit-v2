-- Migration: 20260924000000_fix_pa_account_pins_page_from_clause.sql
-- Description: Fix missing 'FROM numbered n' in pa_account_pins_page lateral metrics CTE, harden pa_ingest_pin_batch annotations deduplication, and enforce service_role execution

-- 1. Fix pa_account_pins_page
CREATE OR REPLACE FUNCTION public.pa_account_pins_page(
  p_workspace_id uuid,
  p_account_id uuid,
  p_q text DEFAULT NULL,
  p_board text DEFAULT NULL,
  p_stage text DEFAULT NULL,
  p_sort text DEFAULT 'saves',
  p_asc boolean DEFAULT false,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_max_saves bigint DEFAULT NULL,
  p_min_saves bigint DEFAULT NULL
)
RETURNS TABLE(
  id uuid,
  pin_id text,
  title text,
  image_url text,
  link text,
  saves bigint,
  repins bigint,
  comments integer,
  share_count bigint,
  reactions jsonb,
  velocity numeric,
  annotations jsonb,
  board_name text,
  seo_category text,
  created_at_pinterest timestamp with time zone,
  archived_at timestamp with time zone,
  first_seen_at timestamp with time zone,
  delta_saves bigint,
  delta_repins bigint,
  delta_saves_3d bigint,
  delta_repins_3d bigint,
  delta_saves_7d bigint,
  delta_repins_7d bigint,
  delta_shares bigint,
  delta_reactions bigint,
  last_snapshot_at timestamp with time zone,
  total_count bigint
)
LANGUAGE plpgsql
STABLE
SET search_path TO ''
AS $$
#variable_conflict use_column
DECLARE
  v_is_delta_sort boolean;
  v_needs_delta_stage boolean;
BEGIN
  v_is_delta_sort := p_sort IN ('delta_saves', 'delta_repins', 'delta_3d', 'delta_saves_3d', 'delta_7d', 'delta_saves_7d');
  -- Only COOLING stage strictly requires delta_saves from pa_pin_metrics; NEW, GROWING, MATURE, DORMANT can use the fast path
  v_needs_delta_stage := upper(trim(coalesce(p_stage, ''))) = 'COOLING';

  IF NOT v_is_delta_sort AND NOT v_needs_delta_stage THEN
    -- FAST PATH: Two-Phase Paging
    -- Phase 1: Filter and paginate pa_pins using indexes without touching pa_pin_metrics
    RETURN QUERY
    WITH paged_pins AS (
      SELECT
        p.id,
        p.pin_id,
        p.title,
        p.image_url,
        p.link,
        p.saves,
        p.repins,
        p.comments,
        p.share_count,
        p.reactions,
        p.velocity,
        p.annotations,
        p.board_name,
        p.seo_category,
        p.created_at_pinterest,
        p.archived_at,
        p.first_seen_at,
        count(*) OVER ()::bigint AS total_count
      FROM public.pa_pins p
      WHERE p.workspace_id = p_workspace_id
        AND p.account_id = p_account_id
        AND (
          p_q IS NULL OR trim(p_q) = ''
          OR p.title ILIKE '%' || trim(p_q) || '%'
          OR p.pin_id ILIKE '%' || trim(p_q) || '%'
          OR p.description ILIKE '%' || trim(p_q) || '%'
        )
        AND (p_board IS NULL OR trim(p_board) = '' OR p.board_name = trim(p_board))
        AND (p_max_saves IS NULL OR p.saves <= p_max_saves)
        AND (p_min_saves IS NULL OR p.saves >= p_min_saves)
        AND (
          p_stage IS NULL OR trim(p_stage) = '' OR
          CASE upper(trim(p_stage))
            WHEN 'NEW' THEN
              (EXTRACT(EPOCH FROM (now() - coalesce(p.created_at_pinterest, p.archived_at, now()))) / 86400.0) <= 14
              AND coalesce(p.velocity, 0) >= 0.5
            WHEN 'GROWING' THEN
              (EXTRACT(EPOCH FROM (now() - coalesce(p.created_at_pinterest, p.archived_at, now()))) / 86400.0) > 14
              AND coalesce(p.velocity, 0) >= 10
            WHEN 'MATURE' THEN
              (EXTRACT(EPOCH FROM (now() - coalesce(p.created_at_pinterest, p.archived_at, now()))) / 86400.0) > 14
              AND coalesce(p.velocity, 0) >= 2
              AND coalesce(p.velocity, 0) < 10
            WHEN 'DORMANT' THEN
              coalesce(p.velocity, 0) < 0.5
              OR (
                (EXTRACT(EPOCH FROM (now() - coalesce(p.created_at_pinterest, p.archived_at, now()))) / 86400.0) > 14
                AND coalesce(p.velocity, 0) < 2
              )
            ELSE true
          END
        )
      ORDER BY
        CASE WHEN NOT coalesce(p_asc, false) AND coalesce(p_sort, 'saves') = 'saves' THEN p.saves END DESC NULLS LAST,
        CASE WHEN coalesce(p_asc, false) AND coalesce(p_sort, 'saves') = 'saves' THEN p.saves END ASC NULLS LAST,
        CASE WHEN NOT coalesce(p_asc, false) AND p_sort = 'repins' THEN p.repins END DESC NULLS LAST,
        CASE WHEN coalesce(p_asc, false) AND p_sort = 'repins' THEN p.repins END ASC NULLS LAST,
        CASE WHEN NOT coalesce(p_asc, false) AND p_sort = 'velocity' THEN p.velocity END DESC NULLS LAST,
        CASE WHEN coalesce(p_asc, false) AND p_sort = 'velocity' THEN p.velocity END ASC NULLS LAST,
        CASE WHEN NOT coalesce(p_asc, false) AND p_sort = 'first_seen_at' THEN p.first_seen_at END DESC NULLS LAST,
        CASE WHEN coalesce(p_asc, false) AND p_sort = 'first_seen_at' THEN p.first_seen_at END ASC NULLS LAST,
        CASE WHEN NOT coalesce(p_asc, false) AND p_sort = 'share_count' THEN p.share_count END DESC NULLS LAST,
        CASE WHEN coalesce(p_asc, false) AND p_sort = 'share_count' THEN p.share_count END ASC NULLS LAST,
        CASE WHEN NOT coalesce(p_asc, false) AND (p_sort = 'created_at_pinterest' OR p_sort = 'newest') THEN p.created_at_pinterest END DESC NULLS LAST,
        CASE WHEN coalesce(p_asc, false) AND (p_sort = 'created_at_pinterest' OR p_sort = 'newest') THEN p.created_at_pinterest END ASC NULLS LAST,
        p.saves DESC,
        p.id ASC
      LIMIT coalesce(p_limit, 50)
      OFFSET coalesce(p_offset, 0)
    )
    -- Phase 2: Compute lateral metrics ONLY for the paged pins
    SELECT
      pp.id,
      pp.pin_id,
      pp.title,
      pp.image_url,
      pp.link,
      pp.saves,
      pp.repins,
      pp.comments,
      pp.share_count,
      pp.reactions,
      pp.velocity,
      pp.annotations,
      pp.board_name,
      pp.seo_category,
      pp.created_at_pinterest,
      pp.archived_at,
      pp.first_seen_at,
      metrics.delta_saves,
      metrics.delta_repins,
      metrics.delta_saves_3d,
      metrics.delta_repins_3d,
      metrics.delta_saves_7d,
      metrics.delta_repins_7d,
      metrics.delta_shares,
      metrics.delta_reactions,
      metrics.last_snapshot_at,
      pp.total_count
    FROM paged_pins pp
    LEFT JOIN LATERAL (
      WITH ordered_snaps AS (
        SELECT pm.recorded_at, pm.saves, pm.repins, pm.shares, pm.reactions_total
        FROM public.pa_pin_metrics pm
        WHERE pm.pin_ref = pp.id
        ORDER BY pm.recorded_at DESC
        LIMIT 10
      ),
      numbered AS (
        SELECT os.*,
               row_number() OVER (ORDER BY os.recorded_at DESC) AS rnum,
               first_value(os.recorded_at) OVER (ORDER BY os.recorded_at DESC) AS t0
        FROM ordered_snaps os
      ),
      ranked AS (
        SELECT n.*,
               CASE WHEN n.rnum > 1 THEN
                 row_number() OVER (
                   PARTITION BY (n.rnum > 1)
                   ORDER BY abs(extract(epoch from (n.t0 - n.recorded_at)) - 259200)
                 )
               END as rank_3d,
               CASE WHEN n.rnum > 1 THEN
                 row_number() OVER (
                   PARTITION BY (n.rnum > 1)
                   ORDER BY abs(extract(epoch from (n.t0 - n.recorded_at)) - 604800)
                 )
               END as rank_7d
        FROM numbered n
      )
      SELECT
        max(CASE WHEN rnum = 1 THEN recorded_at END) AS last_snapshot_at,
        CASE
          WHEN count(*) >= 2 THEN
            (max(CASE WHEN rnum = 1 THEN saves END) - max(CASE WHEN rnum = 2 THEN saves END))
          ELSE 0
        END::bigint AS delta_saves,
        CASE
          WHEN count(*) >= 2 THEN
            GREATEST(0, max(CASE WHEN rnum = 1 THEN repins END) - max(CASE WHEN rnum = 2 THEN repins END))
          ELSE 0
        END::bigint AS delta_repins,
        CASE
          WHEN count(*) >= 2 THEN
            (max(CASE WHEN rnum = 1 THEN saves END) - max(CASE WHEN rank_3d = 1 THEN saves END))
          ELSE 0
        END::bigint AS delta_saves_3d,
        CASE
          WHEN count(*) >= 2 THEN
            GREATEST(0, max(CASE WHEN rnum = 1 THEN repins END) - max(CASE WHEN rank_3d = 1 THEN repins END))
          ELSE 0
        END::bigint AS delta_repins_3d,
        CASE
          WHEN count(*) >= 2 THEN
            (max(CASE WHEN rnum = 1 THEN saves END) - max(CASE WHEN rank_7d = 1 THEN saves END))
          ELSE 0
        END::bigint AS delta_saves_7d,
        CASE
          WHEN count(*) >= 2 THEN
            GREATEST(0, max(CASE WHEN rnum = 1 THEN repins END) - max(CASE WHEN rank_7d = 1 THEN repins END))
          ELSE 0
        END::bigint AS delta_repins_7d,
        CASE
          WHEN count(*) >= 2 THEN
            GREATEST(0, max(CASE WHEN rnum = 1 THEN shares END) - max(CASE WHEN rnum = 2 THEN shares END))
          ELSE 0
        END::bigint AS delta_shares,
        CASE
          WHEN count(*) >= 2 THEN
            GREATEST(0, max(CASE WHEN rnum = 1 THEN reactions_total END) - max(CASE WHEN rnum = 2 THEN reactions_total END))
          ELSE 0
        END::bigint AS delta_reactions
      FROM ranked
    ) metrics ON true
    ORDER BY
      CASE WHEN NOT coalesce(p_asc, false) AND coalesce(p_sort, 'saves') = 'saves' THEN pp.saves END DESC NULLS LAST,
      CASE WHEN coalesce(p_asc, false) AND coalesce(p_sort, 'saves') = 'saves' THEN pp.saves END ASC NULLS LAST,
      CASE WHEN NOT coalesce(p_asc, false) AND p_sort = 'repins' THEN pp.repins END DESC NULLS LAST,
      CASE WHEN coalesce(p_asc, false) AND p_sort = 'repins' THEN pp.repins END ASC NULLS LAST,
      CASE WHEN NOT coalesce(p_asc, false) AND p_sort = 'velocity' THEN pp.velocity END DESC NULLS LAST,
      CASE WHEN coalesce(p_asc, false) AND p_sort = 'velocity' THEN pp.velocity END ASC NULLS LAST,
      CASE WHEN NOT coalesce(p_asc, false) AND p_sort = 'first_seen_at' THEN pp.first_seen_at END DESC NULLS LAST,
      CASE WHEN coalesce(p_asc, false) AND p_sort = 'first_seen_at' THEN pp.first_seen_at END ASC NULLS LAST,
      CASE WHEN NOT coalesce(p_asc, false) AND p_sort = 'share_count' THEN pp.share_count END DESC NULLS LAST,
      CASE WHEN coalesce(p_asc, false) AND p_sort = 'share_count' THEN pp.share_count END ASC NULLS LAST,
      CASE WHEN NOT coalesce(p_asc, false) AND (p_sort = 'created_at_pinterest' OR p_sort = 'newest') THEN pp.created_at_pinterest END DESC NULLS LAST,
      CASE WHEN coalesce(p_asc, false) AND (p_sort = 'created_at_pinterest' OR p_sort = 'newest') THEN pp.created_at_pinterest END ASC NULLS LAST,
      pp.saves DESC,
      pp.id ASC;

  ELSE
    -- SLOW/METRICS PATH: for sorting by delta_saves/repins/3d/7d or filtering by COOLING stage
    RETURN QUERY
    WITH base_pins AS (
      SELECT
        p.id,
        p.pin_id,
        p.title,
        p.image_url,
        p.link,
        p.saves,
        p.repins,
        p.comments,
        p.share_count,
        p.reactions,
        p.velocity,
        p.annotations,
        p.board_name,
        p.seo_category,
        p.created_at_pinterest,
        p.archived_at,
        p.first_seen_at,
        metrics.delta_saves,
        metrics.delta_repins,
        metrics.delta_saves_3d,
        metrics.delta_repins_3d,
        metrics.delta_saves_7d,
        metrics.delta_repins_7d,
        metrics.delta_shares,
        metrics.delta_reactions,
        metrics.last_snapshot_at,
        CASE
          WHEN p.velocity < 0.5 THEN 'DORMANT'
          WHEN p.velocity < 2 AND coalesce(metrics.delta_saves, 0) < 0 THEN 'COOLING'
          WHEN (EXTRACT(EPOCH FROM (now() - coalesce(p.created_at_pinterest, p.archived_at, now()))) / 86400.0) <= 14 THEN 'NEW'
          WHEN p.velocity >= 10 THEN 'GROWING'
          WHEN p.velocity >= 2 THEN 'MATURE'
          ELSE 'DORMANT'
        END AS computed_stage
      FROM public.pa_pins p
      LEFT JOIN LATERAL (
        WITH ordered_snaps AS (
          SELECT pm.recorded_at, pm.saves, pm.repins, pm.shares, pm.reactions_total
          FROM public.pa_pin_metrics pm
          WHERE pm.pin_ref = p.id
          ORDER BY pm.recorded_at DESC
          LIMIT 10
        ),
        numbered AS (
          SELECT os.*,
                 row_number() OVER (ORDER BY os.recorded_at DESC) AS rnum,
                 first_value(os.recorded_at) OVER (ORDER BY os.recorded_at DESC) AS t0
          FROM ordered_snaps os
        ),
        ranked AS (
          SELECT n.*,
                 CASE WHEN n.rnum > 1 THEN
                   row_number() OVER (
                     PARTITION BY (n.rnum > 1)
                     ORDER BY abs(extract(epoch from (n.t0 - n.recorded_at)) - 259200)
                   )
                 END as rank_3d,
                 CASE WHEN n.rnum > 1 THEN
                   row_number() OVER (
                     PARTITION BY (n.rnum > 1)
                     ORDER BY abs(extract(epoch from (n.t0 - n.recorded_at)) - 604800)
                   )
                 END as rank_7d
          FROM numbered n
        )
        SELECT
          max(CASE WHEN rnum = 1 THEN recorded_at END) AS last_snapshot_at,
          CASE
            WHEN count(*) >= 2 THEN
              (max(CASE WHEN rnum = 1 THEN saves END) - max(CASE WHEN rnum = 2 THEN saves END))
            ELSE 0
          END::bigint AS delta_saves,
          CASE
            WHEN count(*) >= 2 THEN
              GREATEST(0, max(CASE WHEN rnum = 1 THEN repins END) - max(CASE WHEN rnum = 2 THEN repins END))
            ELSE 0
          END::bigint AS delta_repins,
          CASE
            WHEN count(*) >= 2 THEN
              (max(CASE WHEN rnum = 1 THEN saves END) - max(CASE WHEN rank_3d = 1 THEN saves END))
            ELSE 0
          END::bigint AS delta_saves_3d,
          CASE
            WHEN count(*) >= 2 THEN
              GREATEST(0, max(CASE WHEN rnum = 1 THEN repins END) - max(CASE WHEN rank_3d = 1 THEN repins END))
            ELSE 0
          END::bigint AS delta_repins_3d,
          CASE
            WHEN count(*) >= 2 THEN
              (max(CASE WHEN rnum = 1 THEN saves END) - max(CASE WHEN rank_7d = 1 THEN saves END))
            ELSE 0
          END::bigint AS delta_saves_7d,
          CASE
            WHEN count(*) >= 2 THEN
              GREATEST(0, max(CASE WHEN rnum = 1 THEN repins END) - max(CASE WHEN rank_7d = 1 THEN repins END))
            ELSE 0
          END::bigint AS delta_repins_7d,
          CASE
            WHEN count(*) >= 2 THEN
              GREATEST(0, max(CASE WHEN rnum = 1 THEN shares END) - max(CASE WHEN rnum = 2 THEN shares END))
            ELSE 0
          END::bigint AS delta_shares,
          CASE
            WHEN count(*) >= 2 THEN
              GREATEST(0, max(CASE WHEN rnum = 1 THEN reactions_total END) - max(CASE WHEN rnum = 2 THEN reactions_total END))
            ELSE 0
          END::bigint AS delta_reactions
        FROM ranked
      ) metrics ON true
      WHERE p.workspace_id = p_workspace_id
        AND p.account_id = p_account_id
        AND (
          p_q IS NULL OR trim(p_q) = ''
          OR p.title ILIKE '%' || trim(p_q) || '%'
          OR p.pin_id ILIKE '%' || trim(p_q) || '%'
          OR p.description ILIKE '%' || trim(p_q) || '%'
        )
        AND (p_board IS NULL OR trim(p_board) = '' OR p.board_name = trim(p_board))
        AND (p_max_saves IS NULL OR p.saves <= p_max_saves)
        AND (p_min_saves IS NULL OR p.saves >= p_min_saves)
    ),
    filtered_pins AS (
      SELECT
        bp.*,
        count(*) OVER ()::bigint AS total_count
      FROM base_pins bp
      WHERE (p_stage IS NULL OR trim(p_stage) = '' OR bp.computed_stage = upper(trim(p_stage)))
    )
    SELECT
      fp.id,
      fp.pin_id,
      fp.title,
      fp.image_url,
      fp.link,
      fp.saves,
      fp.repins,
      fp.comments,
      fp.share_count,
      fp.reactions,
      fp.velocity,
      fp.annotations,
      fp.board_name,
      fp.seo_category,
      fp.created_at_pinterest,
      fp.archived_at,
      fp.first_seen_at,
      fp.delta_saves,
      fp.delta_repins,
      fp.delta_saves_3d,
      fp.delta_repins_3d,
      fp.delta_saves_7d,
      fp.delta_repins_7d,
      fp.delta_shares,
      fp.delta_reactions,
      fp.last_snapshot_at,
      fp.total_count
    FROM filtered_pins fp
    ORDER BY
      CASE WHEN NOT coalesce(p_asc, false) AND coalesce(p_sort, 'saves') = 'saves' THEN fp.saves END DESC NULLS LAST,
      CASE WHEN coalesce(p_asc, false) AND coalesce(p_sort, 'saves') = 'saves' THEN fp.saves END ASC NULLS LAST,
      CASE WHEN NOT coalesce(p_asc, false) AND p_sort = 'repins' THEN fp.repins END DESC NULLS LAST,
      CASE WHEN coalesce(p_asc, false) AND p_sort = 'repins' THEN fp.repins END ASC NULLS LAST,
      CASE WHEN NOT coalesce(p_asc, false) AND p_sort = 'velocity' THEN fp.velocity END DESC NULLS LAST,
      CASE WHEN coalesce(p_asc, false) AND p_sort = 'velocity' THEN fp.velocity END ASC NULLS LAST,
      CASE WHEN NOT coalesce(p_asc, false) AND p_sort = 'first_seen_at' THEN fp.first_seen_at END DESC NULLS LAST,
      CASE WHEN coalesce(p_asc, false) AND p_sort = 'first_seen_at' THEN fp.first_seen_at END ASC NULLS LAST,
      CASE WHEN NOT coalesce(p_asc, false) AND p_sort = 'delta_repins' THEN fp.delta_repins END DESC NULLS LAST,
      CASE WHEN coalesce(p_asc, false) AND p_sort = 'delta_repins' THEN fp.delta_repins END ASC NULLS LAST,
      CASE WHEN NOT coalesce(p_asc, false) AND p_sort = 'share_count' THEN fp.share_count END DESC NULLS LAST,
      CASE WHEN coalesce(p_asc, false) AND p_sort = 'share_count' THEN fp.share_count END ASC NULLS LAST,
      CASE WHEN NOT coalesce(p_asc, false) AND (p_sort = 'created_at_pinterest' OR p_sort = 'newest') THEN fp.created_at_pinterest END DESC NULLS LAST,
      CASE WHEN coalesce(p_asc, false) AND (p_sort = 'created_at_pinterest' OR p_sort = 'newest') THEN fp.created_at_pinterest END ASC NULLS LAST,
      CASE WHEN NOT coalesce(p_asc, false) AND p_sort = 'delta_saves' THEN fp.delta_saves END DESC NULLS LAST,
      CASE WHEN coalesce(p_asc, false) AND p_sort = 'delta_saves' THEN fp.delta_saves END ASC NULLS LAST,
      CASE WHEN NOT coalesce(p_asc, false) AND (p_sort = 'delta_3d' OR p_sort = 'delta_saves_3d') THEN fp.delta_saves_3d END DESC NULLS LAST,
      CASE WHEN coalesce(p_asc, false) AND (p_sort = 'delta_3d' OR p_sort = 'delta_saves_3d') THEN fp.delta_saves_3d END ASC NULLS LAST,
      CASE WHEN NOT coalesce(p_asc, false) AND (p_sort = 'delta_7d' OR p_sort = 'delta_saves_7d') THEN fp.delta_saves_7d END DESC NULLS LAST,
      CASE WHEN coalesce(p_asc, false) AND (p_sort = 'delta_7d' OR p_sort = 'delta_saves_7d') THEN fp.delta_saves_7d END ASC NULLS LAST,
      fp.saves DESC,
      fp.id ASC
    LIMIT coalesce(p_limit, 50)
    OFFSET coalesce(p_offset, 0);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.pa_account_pins_page(uuid, uuid, text, text, text, text, boolean, integer, integer, bigint, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pa_account_pins_page(uuid, uuid, text, text, text, text, boolean, integer, integer, bigint, bigint) TO service_role;

