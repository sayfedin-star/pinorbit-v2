-- Migration: 20261001000000_pa_account_deltas_24h.sql
-- Description: RPC to compute 24h delta saves and repins aggregated per account and across workspace
-- Target Database: Project 4 (PinArchive) ONLY

CREATE OR REPLACE FUNCTION public.pa_account_deltas_24h(
  p_workspace_id uuid,
  p_account_id uuid DEFAULT NULL
)
RETURNS TABLE (
  account_id uuid,
  delta_saves_24h bigint,
  delta_repins_24h bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH target_accounts AS (
    SELECT a.id AS acc_id
    FROM public.pa_accounts a
    WHERE a.workspace_id = p_workspace_id
      AND (p_account_id IS NULL OR a.id = p_account_id)
  ),
  recent_pins AS (
    SELECT p.id AS pin_ref, p.account_id
    FROM public.pa_pins p
    WHERE p.workspace_id = p_workspace_id
      AND (p_account_id IS NULL OR p.account_id = p_account_id)
  ),
  -- True 24-hour window filter: only consider pins with a snapshot recorded in the last 24 hours
  pins_with_24h AS (
    SELECT DISTINCT pm.pin_ref
    FROM public.pa_pin_metrics pm
    JOIN recent_pins rp ON rp.pin_ref = pm.pin_ref
    WHERE pm.workspace_id = p_workspace_id
      AND pm.recorded_at >= now() - interval '24 hours'
  ),
  ranked_metrics AS (
    SELECT
      pm.pin_ref,
      pm.saves,
      pm.repins,
      row_number() OVER (PARTITION BY pm.pin_ref ORDER BY pm.recorded_at DESC) AS rnum
    FROM public.pa_pin_metrics pm
    JOIN pins_with_24h pw ON pw.pin_ref = pm.pin_ref
    WHERE pm.workspace_id = p_workspace_id
  ),
  pin_deltas AS (
    SELECT
      pin_ref,
      GREATEST(0, (max(CASE WHEN rnum = 1 THEN saves END) - max(CASE WHEN rnum = 2 THEN saves END))) AS delta_saves,
      GREATEST(0, (max(CASE WHEN rnum = 1 THEN repins END) - max(CASE WHEN rnum = 2 THEN repins END))) AS delta_repins
    FROM ranked_metrics
    WHERE rnum <= 2
    GROUP BY pin_ref
    HAVING count(*) >= 2
  ),
  account_pin_sums AS (
    SELECT
      rp.account_id,
      coalesce(sum(pd.delta_saves), 0)::bigint AS delta_saves_24h,
      coalesce(sum(pd.delta_repins), 0)::bigint AS delta_repins_24h
    FROM recent_pins rp
    LEFT JOIN pin_deltas pd ON pd.pin_ref = rp.pin_ref
    GROUP BY rp.account_id
  )
  SELECT
    ta.acc_id AS account_id,
    coalesce(aps.delta_saves_24h, 0)::bigint AS delta_saves_24h,
    coalesce(aps.delta_repins_24h, 0)::bigint AS delta_repins_24h
  FROM target_accounts ta
  LEFT JOIN account_pin_sums aps ON aps.account_id = ta.acc_id;
END;
$$;

REVOKE ALL ON FUNCTION public.pa_account_deltas_24h(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pa_account_deltas_24h(uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
