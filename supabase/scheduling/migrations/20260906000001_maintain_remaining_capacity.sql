-- ==============================================================================
-- Migration: 20260906000001_maintain_remaining_capacity.sql
-- Project: Project 1 (Scheduling: eygdoetdwqllvsxpvoex)
-- Description: Resyncs monthly_usage with executions_used on account_webhooks so that
--              generated column remaining_capacity (monthly_capacity - monthly_usage)
--              accurately reflects remaining quota, and reinforces increment_webhook_execution.
-- ==============================================================================

-- 1. Resync existing monthly_usage with executions_used so generated column remaining_capacity evaluates accurately
UPDATE public.account_webhooks
SET monthly_usage = executions_used
WHERE monthly_usage IS DISTINCT FROM executions_used;

-- 2. Reinforce increment_webhook_execution plpgsql function
CREATE OR REPLACE FUNCTION public.increment_webhook_execution(
  p_webhook_id uuid,
  p_count integer DEFAULT 1,
  p_workspace_id uuid DEFAULT NULL::uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE public.account_webhooks w
  SET executions_used = COALESCE(w.executions_used, 0) + p_count,
      monthly_usage = COALESCE(w.monthly_usage, 0) + p_count,
      last_used_at = now(),
      updated_at = now()
  FROM public.accounts a
  WHERE w.id = p_webhook_id
    AND w.account_id = a.id
    AND (p_workspace_id IS NULL OR a.workspace_id = p_workspace_id);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.increment_webhook_execution(UUID, INTEGER, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_webhook_execution(UUID, INTEGER, UUID) TO service_role;
