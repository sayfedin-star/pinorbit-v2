-- Migration: 20260907000002_extend_pa_account_pin_counts_oldest_pin.sql
-- Description: Extend pa_account_pin_counts to return oldest_pin_at (min created_at_pinterest) from pa_pins for reliable Account Age fallback

DROP FUNCTION IF EXISTS public.pa_account_pin_counts(uuid);

CREATE OR REPLACE FUNCTION public.pa_account_pin_counts(p_workspace_id uuid)
RETURNS TABLE (account_id uuid, pins bigint, archived bigint, oldest_pin_at timestamp with time zone)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT
    account_id,
    count(*)::bigint AS pins,
    count(archived_at)::bigint AS archived,
    min(created_at_pinterest) AS oldest_pin_at
  FROM public.pa_pins
  WHERE workspace_id = p_workspace_id
  GROUP BY account_id;
$$;

REVOKE ALL ON FUNCTION public.pa_account_pin_counts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pa_account_pin_counts(uuid) TO service_role;
