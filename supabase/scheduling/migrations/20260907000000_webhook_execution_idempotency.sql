-- Migration: 20260907000000_webhook_execution_idempotency.sql
-- Description: Webhook execution idempotency tracking to prevent duplicate quota usage on network retry

CREATE TABLE IF NOT EXISTS public.webhook_execution_idempotency (
    idempotency_key text PRIMARY KEY,
    webhook_id uuid NOT NULL REFERENCES public.account_webhooks(id) ON DELETE CASCADE,
    count integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.webhook_execution_idempotency ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.webhook_execution_idempotency FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.webhook_execution_idempotency TO service_role;

CREATE INDEX IF NOT EXISTS idx_webhook_execution_idempotency_created_at
    ON public.webhook_execution_idempotency(created_at);

-- Drop 3-argument function to avoid ambiguous signature
DROP FUNCTION IF EXISTS public.increment_webhook_execution(uuid, integer, uuid);

CREATE OR REPLACE FUNCTION public.increment_webhook_execution(
    p_webhook_id uuid,
    p_count integer DEFAULT 1,
    p_workspace_id uuid DEFAULT NULL::uuid,
    p_idempotency_key text DEFAULT NULL::text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF p_idempotency_key IS NOT NULL AND trim(p_idempotency_key) <> '' THEN
        BEGIN
            INSERT INTO public.webhook_execution_idempotency (idempotency_key, webhook_id, count)
            VALUES (p_idempotency_key, p_webhook_id, p_count);
        EXCEPTION WHEN unique_violation THEN
            -- Idempotent duplicate: count was already applied, exit safely
            RETURN;
        END;
    END IF;

    -- Prune entries older than 7 days to keep idempotency table bounded
    DELETE FROM public.webhook_execution_idempotency
    WHERE created_at < now() - interval '7 days';

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

REVOKE ALL ON FUNCTION public.increment_webhook_execution(uuid, integer, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_webhook_execution(uuid, integer, uuid, text) TO service_role;
