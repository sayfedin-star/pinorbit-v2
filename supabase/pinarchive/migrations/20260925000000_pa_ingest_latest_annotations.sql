-- Migration: 20260925000000_pa_ingest_latest_annotations.sql
-- Description: Drop ambiguous legacy 4-arg pa_ingest_pin_batch overload, prune 54 redundant identical snapshots, and update authoritative 5-arg RPC with two-phase annotations normalization and stale tag elimination
-- Target Database: Project 4 (PinArchive) ONLY

-- 1. Prune redundant identical consecutive metric snapshots (safety cleanup)
WITH duplicates AS (
  SELECT id
  FROM (
    SELECT
      id,
      saves = LAG(saves) OVER w
        AND repins = LAG(repins) OVER w
        AND comments = LAG(comments) OVER w
        AND shares = LAG(shares) OVER w
        AND reactions_total = LAG(reactions_total) OVER w AS is_duplicate
    FROM public.pa_pin_metrics
    WINDOW w AS (PARTITION BY pin_ref ORDER BY recorded_at ASC)
  ) sub
  WHERE is_duplicate = true
)
DELETE FROM public.pa_pin_metrics
WHERE id IN (SELECT id FROM duplicates);

-- 2. Drop ambiguous legacy 4-argument overload to eliminate PostgreSQL ERROR 42725
DROP FUNCTION IF EXISTS public.pa_ingest_pin_batch(uuid, uuid, timestamp with time zone, jsonb);

-- 3. Define authoritative pa_ingest_pin_batch
CREATE OR REPLACE FUNCTION public.pa_ingest_pin_batch(
  p_workspace_id uuid,
  p_account_id uuid,
  p_fetched_at timestamp with time zone,
  p_pins jsonb,
  p_dry_run boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
#variable_conflict use_column
DECLARE
  v_pins_count int := 0;
  v_unique_incoming_count int := 0;
  v_added_count int := 0;
  v_updated_count int := 0;
  v_snapshots_count int := 0;
  v_archived_ids text[] := ARRAY[]::text[];
BEGIN
  IF p_pins IS NULL OR jsonb_typeof(p_pins) <> 'array' OR jsonb_array_length(p_pins) = 0 THEN
    RETURN jsonb_build_object(
      'success', true,
      'added', 0,
      'updated', 0,
      'snapshots', 0,
      'archived_pin_ids', '[]'::jsonb
    );
  END IF;

  v_pins_count := jsonb_array_length(p_pins);

  CREATE TEMP TABLE temp_incoming_pins ON COMMIT DROP AS
  SELECT DISTINCT ON (r.pin_id)
    p_workspace_id AS workspace_id,
    p_account_id AS account_id,
    r.pin_id,
    r.node_id,
    r.title,
    r.description,
    r.link,
    r.utm_link,
    r.domain,
    r.board_id,
    r.board_name,
    r.created_at_pinterest,
    r.image_url,
    r.image_signature,
    r.dominant_color,
    coalesce(r.is_video, false) AS is_video,
    coalesce(r.is_product, false) AS is_product,
    r.price,
    r.currency,
    r.site_name,
    coalesce(r.saves, 0)::bigint AS saves,
    coalesce(r.repins, 0)::bigint AS repins,
    coalesce(r.comments, 0)::int AS comments,
    r.reactions,
    coalesce(r.velocity, 0)::numeric AS velocity,
    coalesce(r.promoted, false) AS promoted,
    r.share_count,
    r.archived_at,
    CASE
      WHEN r.annotations IS NOT NULL AND jsonb_typeof(r.annotations) = 'array' AND r.annotations <> '[]'::jsonb THEN
        (
          SELECT coalesce(jsonb_agg(
            jsonb_build_object(
              'name', trim(cleaned.name_val),
              'idea_id', CASE WHEN jsonb_typeof(cleaned.e) = 'object' THEN cleaned.e->>'idea_id' ELSE NULL END,
              'url', CASE WHEN jsonb_typeof(cleaned.e) = 'object' THEN cleaned.e->>'url' ELSE NULL END
            )
          ), '[]'::jsonb)
          FROM (
            SELECT DISTINCT ON (lower(trim(nv.name_val)))
              e, nv.name_val
            FROM jsonb_array_elements(r.annotations) e,
            LATERAL (
              SELECT CASE
                WHEN jsonb_typeof(e) = 'string' THEN e #>> '{}'
                WHEN jsonb_typeof(e) = 'object' THEN e->>'name'
                ELSE NULL
              END AS name_val
            ) nv
            WHERE nv.name_val IS NOT NULL AND trim(nv.name_val) <> ''
            ORDER BY lower(trim(nv.name_val)), (CASE WHEN jsonb_typeof(e) = 'object' AND e->>'url' IS NOT NULL THEN 1 ELSE 0 END) DESC
          ) cleaned
        )
      ELSE '[]'::jsonb
    END AS annotations,
    r.board_pin_count,
    r.board_last_modified_at,
    r.seo_category,
    r.canonical_pin_id,
    r.seo_alt_text
  FROM jsonb_to_recordset(p_pins) AS r(
    pin_id text,
    node_id text,
    title text,
    description text,
    link text,
    utm_link text,
    domain text,
    board_id text,
    board_name text,
    created_at_pinterest timestamptz,
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
    comments int,
    reactions jsonb,
    velocity numeric,
    promoted boolean,
    share_count bigint,
    archived_at timestamptz,
    annotations jsonb,
    board_pin_count int,
    board_last_modified_at timestamptz,
    seo_category text,
    canonical_pin_id text,
    seo_alt_text text
  )
  WHERE r.pin_id IS NOT NULL AND trim(r.pin_id) <> ''
  ORDER BY r.pin_id, coalesce(r.saves, 0) DESC;

  SELECT count(*)::int INTO v_unique_incoming_count FROM temp_incoming_pins;

  SELECT count(*)::int INTO v_updated_count
  FROM temp_incoming_pins tip
  JOIN public.pa_pins p ON p.workspace_id = tip.workspace_id AND p.pin_id = tip.pin_id;

  v_added_count := v_unique_incoming_count - v_updated_count;

  SELECT coalesce(array_agg(tip.pin_id), ARRAY[]::text[]) INTO v_archived_ids
  FROM temp_incoming_pins tip;

  IF p_dry_run THEN
    RETURN jsonb_build_object(
      'dry_run', true,
      'incoming_count', v_pins_count,
      'added', v_added_count,
      'updated', v_updated_count,
      'snapshots', 0,
      'archived_pin_ids', to_jsonb(v_archived_ids)
    );
  END IF;

  WITH upserted AS (
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
      share_count,
      first_seen_at,
      last_updated_at,
      archived_at,
      annotations,
      board_pin_count,
      board_last_modified_at,
      seo_category,
      canonical_pin_id,
      seo_alt_text
    )
    SELECT
      tip.workspace_id,
      tip.account_id,
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
      tip.is_video,
      tip.is_product,
      tip.price,
      tip.currency,
      tip.site_name,
      tip.saves,
      tip.repins,
      tip.comments,
      coalesce(tip.reactions, '{}'::jsonb),
      tip.velocity,
      tip.promoted,
      coalesce(tip.share_count, 0),
      p_fetched_at AS first_seen_at,
      p_fetched_at AS last_updated_at,
      coalesce(tip.archived_at, p_fetched_at) AS archived_at,
      coalesce(tip.annotations, '[]'::jsonb),
      tip.board_pin_count,
      tip.board_last_modified_at,
      tip.seo_category,
      tip.canonical_pin_id,
      tip.seo_alt_text
    FROM temp_incoming_pins tip
    ORDER BY tip.pin_id ASC
    ON CONFLICT (workspace_id, pin_id) DO UPDATE SET
      -- Preserve monotonic max for lifetime cumulative metrics
      saves = GREATEST(coalesce(excluded.saves, 0), coalesce(pa_pins.saves, 0)),
      repins = GREATEST(coalesce(excluded.repins, 0), coalesce(pa_pins.repins, 0)),
      comments = GREATEST(coalesce(excluded.comments, 0), coalesce(pa_pins.comments, 0)),
      velocity = CASE
        WHEN excluded.saves >= pa_pins.saves AND excluded.velocity > 0 THEN excluded.velocity
        WHEN pa_pins.velocity > 0 THEN pa_pins.velocity
        ELSE excluded.velocity
      END,
      title = coalesce(excluded.title, pa_pins.title),
      description = coalesce(excluded.description, pa_pins.description),
      link = coalesce(excluded.link, pa_pins.link),
      domain = coalesce(excluded.domain, pa_pins.domain),
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
        WHEN excluded.annotations IS NOT NULL AND jsonb_typeof(excluded.annotations) = 'array' AND excluded.annotations <> '[]'::jsonb THEN
          (
            SELECT coalesce(jsonb_agg(
              jsonb_build_object(
                'name', e->>'name',
                'idea_id', coalesce(e->>'idea_id', prev.idea_id),
                'url', coalesce(e->>'url', prev.url)
              )
            ), '[]'::jsonb)
            FROM jsonb_array_elements(excluded.annotations) e
            LEFT JOIN LATERAL (
              SELECT
                t->>'idea_id' AS idea_id,
                t->>'url' AS url
              FROM jsonb_array_elements(
                CASE
                  WHEN pa_pins.annotations IS NOT NULL AND jsonb_typeof(pa_pins.annotations) = 'array'
                  THEN pa_pins.annotations
                  ELSE '[]'::jsonb
                END
              ) t
              WHERE lower(trim(t->>'name')) = lower(trim(e->>'name'))
              LIMIT 1
            ) prev ON true
          )
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
    WHERE NOT EXISTS (
      SELECT 1 FROM (
        SELECT pm.saves, pm.repins, pm.shares, pm.comments, pm.reactions_total
        FROM public.pa_pin_metrics pm
        WHERE pm.pin_ref = u.id
        ORDER BY pm.recorded_at DESC
        LIMIT 1
      ) pm
      WHERE pm.saves >= u.saves
        AND pm.repins >= u.repins
        AND pm.shares >= u.share_count
        AND pm.comments >= u.comments
        AND pm.reactions_total >= coalesce((u.reactions->>'total')::bigint, 0)
    )
    ON CONFLICT (pin_ref, recorded_at) DO NOTHING
    RETURNING id
  )
  SELECT count(*)::int INTO v_snapshots_count FROM inserted_metrics;

  RETURN jsonb_build_object(
    'success', true,
    'added', v_added_count,
    'updated', v_updated_count,
    'snapshots', v_snapshots_count,
    'archived_pin_ids', to_jsonb(v_archived_ids)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pa_ingest_pin_batch(uuid, uuid, timestamp with time zone, jsonb, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pa_ingest_pin_batch(uuid, uuid, timestamp with time zone, jsonb, boolean) TO service_role;
