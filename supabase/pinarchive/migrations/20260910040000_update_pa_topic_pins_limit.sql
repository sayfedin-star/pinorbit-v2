-- Migration: 20260910040000_update_pa_topic_pins_limit.sql
-- Description: Add pagination, total_count, and dual-indexed @> condition to pa_topic_pins RPC
-- Target Database: Project 4 (PinArchive) ONLY

DROP FUNCTION IF EXISTS public.pa_topic_pins(uuid, text, uuid, text);

CREATE OR REPLACE FUNCTION public.pa_topic_pins(
  p_workspace_id uuid,
  p_name text,
  p_account_id uuid DEFAULT NULL,
  p_board text DEFAULT NULL,
  p_limit int DEFAULT 50,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  pin_id text,
  title text,
  image_url text,
  link text,
  saves bigint,
  repins bigint,
  comments int,
  share_count bigint,
  velocity numeric,
  annotations jsonb,
  seo_category text,
  canonical_pin_id text,
  archived_at timestamptz,
  board_name text,
  board_id text,
  account_id uuid,
  is_video boolean,
  created_at_pinterest timestamptz,
  notes text,
  total_count bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH matched AS (
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
      p.velocity,
      p.annotations,
      p.seo_category,
      p.canonical_pin_id,
      p.archived_at,
      p.board_name,
      p.board_id,
      p.account_id,
      p.is_video,
      p.created_at_pinterest,
      p.notes,
      count(*) OVER ()::bigint AS total_count
    FROM public.pa_pins p
    WHERE p.workspace_id = p_workspace_id
      AND (
        p.annotations @> jsonb_build_array(jsonb_build_object('name', p_name))
        OR p.annotations @> to_jsonb(ARRAY[p_name])
      )
      AND (p_account_id IS NULL OR p.account_id = p_account_id)
      AND (p_board IS NULL OR trim(p_board) = '' OR p.board_name = trim(p_board))
  )
  SELECT
    m.id,
    m.pin_id,
    m.title,
    m.image_url,
    m.link,
    m.saves,
    m.repins,
    m.comments,
    m.share_count,
    m.velocity,
    m.annotations,
    m.seo_category,
    m.canonical_pin_id,
    m.archived_at,
    m.board_name,
    m.board_id,
    m.account_id,
    m.is_video,
    m.created_at_pinterest,
    m.notes,
    m.total_count
  FROM matched m
  ORDER BY m.saves DESC
  LIMIT LEAST(coalesce(p_limit, 50), 200)
  OFFSET GREATEST(coalesce(p_offset, 0), 0);
$$;

REVOKE ALL ON FUNCTION public.pa_topic_pins(uuid, text, uuid, text, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pa_topic_pins(uuid, text, uuid, text, int, int) TO service_role;

NOTIFY pgrst, 'reload schema';

-- DOWN (Rollback Documentation):
-- DROP FUNCTION IF EXISTS public.pa_topic_pins(uuid, text, uuid, text, int, int);
