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
        AND (p_q IS NULL OR trim(p_q) = '' OR p.title ILIKE '%' || trim(p_q) || '%')
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
        AND (p_q IS NULL OR trim(p_q) = '' OR p.title ILIKE '%' || trim(p_q) || '%')
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

-- 2. Update pa_ingest_pin_batch to ensure DISTINCT ON deduplication for annotations merging
CREATE OR REPLACE FUNCTION public.pa_ingest_pin_batch(
  p_workspace_id uuid,
  p_account_id uuid,
  p_fetched_at timestamp with time zone,
  p_pins jsonb
)
RETURNS TABLE(
  inserted_count integer,
  updated_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
#variable_conflict use_column
DECLARE
  v_inserted_count integer := 0;
  v_updated_count integer := 0;
BEGIN
  -- Temporary table or CTE for deterministic upsert
  WITH raw_input AS (
    SELECT *
    FROM jsonb_to_recordset(p_pins) AS tip(
      pin_id text,
      node_id text,
      title text,
      description text,
      link text,
      utm_link text,
      domain text,
      board_id text,
      board_name text,
      created_at_pinterest timestamp with time zone,
      image_url text,
      image_signature text,
      dominant_color text,
      is_video boolean,
      is_product boolean,
      price numeric,
      currency text,
      site_name text,
      saves bigint,
      repins bigint,
      comments integer,
      reactions jsonb,
      velocity numeric,
      promoted boolean,
      annotations jsonb,
      seo_category text,
      canonical_pin_id text,
      seo_alt_text text,
      share_count bigint,
      board_pin_count integer,
      board_last_modified_at timestamp with time zone
    )
    ORDER BY tip.pin_id ASC
  ),
  upserted AS (
    INSERT INTO public.pa_pins (
      workspace_id,
      account_id,
      pin_id,
      node_id,
      title,
      description,
      link,
      utm_link,
      domain,
      board_id,
      board_name,
      created_at_pinterest,
      image_url,
      image_signature,
      dominant_color,
      is_video,
      is_product,
      price,
      currency,
      site_name,
      saves,
      repins,
      comments,
      reactions,
      velocity,
      promoted,
      first_seen_at,
      last_updated_at,
      archived_at,
      annotations,
      seo_category,
      canonical_pin_id,
      seo_alt_text,
      share_count,
      board_pin_count,
      board_last_modified_at
    )
    SELECT
      p_workspace_id,
      p_account_id,
      tip.pin_id,
      tip.node_id,
      tip.title,
      tip.description,
      tip.link,
      tip.utm_link,
      tip.domain,
      tip.board_id,
      tip.board_name,
      tip.created_at_pinterest,
      tip.image_url,
      tip.image_signature,
      tip.dominant_color,
      coalesce(tip.is_video, false),
      coalesce(tip.is_product, false),
      tip.price,
      tip.currency,
      tip.site_name,
      coalesce(tip.saves, 0),
      coalesce(tip.repins, 0),
      coalesce(tip.comments, 0),
      coalesce(tip.reactions, '{}'::jsonb),
      coalesce(tip.velocity, 0),
      coalesce(tip.promoted, false),
      p_fetched_at,
      p_fetched_at,
      p_fetched_at,
      coalesce(tip.annotations, '[]'::jsonb),
      tip.seo_category,
      tip.canonical_pin_id,
      tip.seo_alt_text,
      coalesce(tip.share_count, 0),
      tip.board_pin_count,
      tip.board_last_modified_at
    FROM raw_input tip
    ON CONFLICT (workspace_id, pin_id)
    DO UPDATE SET
      saves = excluded.saves,
      repins = excluded.repins,
      comments = excluded.comments,
      velocity = excluded.velocity,
      title = coalesce(excluded.title, pa_pins.title),
      description = coalesce(excluded.description, pa_pins.description),
      link = coalesce(excluded.link, pa_pins.link),
      board_id = coalesce(excluded.board_id, pa_pins.board_id),
      board_name = coalesce(excluded.board_name, pa_pins.board_name),
      image_url = coalesce(excluded.image_url, pa_pins.image_url),
      is_video = excluded.is_video,
      is_product = excluded.is_product,
      price = coalesce(excluded.price, pa_pins.price),
      currency = coalesce(excluded.currency, pa_pins.currency),
      site_name = coalesce(excluded.site_name, pa_pins.site_name),
      share_count = GREATEST(coalesce(excluded.share_count, 0), coalesce(pa_pins.share_count, 0)),
      last_updated_at = p_fetched_at,
      reactions = CASE
        WHEN excluded.reactions IS NOT NULL
             AND excluded.reactions <> '{}'::jsonb
             AND coalesce((excluded.reactions->>'total')::bigint, 0) >= coalesce((pa_pins.reactions->>'total')::bigint, 0)
        THEN excluded.reactions
        ELSE pa_pins.reactions
      END,
      annotations = CASE
        WHEN excluded.annotations IS NOT NULL AND excluded.annotations <> '[]'::jsonb AND pa_pins.annotations IS NOT NULL AND pa_pins.annotations <> '[]'::jsonb THEN
          (
            SELECT coalesce(jsonb_agg(
              jsonb_build_object(
                'name', merged.name,
                'idea_id', merged.idea_id,
                'url', merged.url
              )
            ), '[]'::jsonb)
            FROM (
              SELECT DISTINCT ON (coalesce(e->>'name', t->>'name'))
                coalesce(e->>'name', t->>'name') AS name,
                coalesce(e->>'idea_id', t->>'idea_id') AS idea_id,
                coalesce(e->>'url', t->>'url') AS url
              FROM jsonb_array_elements(pa_pins.annotations) t
              FULL OUTER JOIN jsonb_array_elements(excluded.annotations) e
                ON (t->>'name') = (e->>'name')
              WHERE coalesce(e->>'name', t->>'name') IS NOT NULL
            ) merged
          )
        WHEN excluded.annotations IS NOT NULL AND excluded.annotations <> '[]'::jsonb THEN excluded.annotations
        ELSE pa_pins.annotations
      END,
      board_pin_count = coalesce(excluded.board_pin_count, pa_pins.board_pin_count),
      board_last_modified_at = coalesce(excluded.board_last_modified_at, pa_pins.board_last_modified_at),
      seo_category = coalesce(excluded.seo_category, pa_pins.seo_category),
      canonical_pin_id = coalesce(excluded.canonical_pin_id, pa_pins.canonical_pin_id),
      utm_link = coalesce(excluded.utm_link, pa_pins.utm_link),
      image_signature = coalesce(excluded.image_signature, pa_pins.image_signature),
      dominant_color = coalesce(excluded.dominant_color, pa_pins.dominant_color),
      seo_alt_text = coalesce(excluded.seo_alt_text, pa_pins.seo_alt_text)
    RETURNING id, workspace_id, saves, repins, comments, share_count, reactions
  ),
  inserted_metrics AS (
    INSERT INTO public.pa_pin_metrics (
      workspace_id,
      pin_ref,
      recorded_at,
      saves,
      repins,
      comments,
      shares,
      reactions_total
    )
    SELECT
      u.workspace_id,
      u.id,
      p_fetched_at,
      u.saves,
      u.repins,
      u.comments,
      u.share_count,
      coalesce((u.reactions->>'total')::bigint, 0)
    FROM upserted u
    ON CONFLICT (pin_ref, recorded_at) DO NOTHING
    RETURNING id
  )
  SELECT
    (SELECT count(*)::integer FROM upserted WHERE last_updated_at = first_seen_at),
    (SELECT count(*)::integer FROM upserted WHERE last_updated_at <> first_seen_at)
  INTO v_inserted_count, v_updated_count;

  RETURN QUERY SELECT coalesce(v_inserted_count, 0), coalesce(v_updated_count, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.pa_ingest_pin_batch(uuid, uuid, timestamp with time zone, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pa_ingest_pin_batch(uuid, uuid, timestamp with time zone, jsonb) TO service_role;
