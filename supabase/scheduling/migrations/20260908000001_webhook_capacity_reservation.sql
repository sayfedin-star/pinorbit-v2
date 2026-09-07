-- Migration: Add atomic capacity reservation predicate to increment_webhook_execution
-- Prevents concurrent overdrawing beyond monthly_capacity while preserving silent no-op for missing webhooks

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
DECLARE
    v_updated_rows integer;
    v_exists boolean;
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
      AND (p_workspace_id IS NULL OR a.workspace_id = p_workspace_id)
      AND (w.monthly_capacity IS NULL OR w.remaining_capacity >= p_count);

    GET DIAGNOSTICS v_updated_rows = ROW_COUNT;

    IF v_updated_rows = 0 THEN
        -- Check whether webhook exists and belongs to workspace
        SELECT EXISTS (
            SELECT 1
            FROM public.account_webhooks w
            JOIN public.accounts a ON w.account_id = a.id
            WHERE w.id = p_webhook_id
              AND (p_workspace_id IS NULL OR a.workspace_id = p_workspace_id)
        ) INTO v_exists;

        IF NOT v_exists THEN
            -- Webhook missing/unauthorized: delete inserted idempotency key and return silently (preserves existing caller contract)
            IF p_idempotency_key IS NOT NULL AND trim(p_idempotency_key) <> '' THEN
                DELETE FROM public.webhook_execution_idempotency
                WHERE idempotency_key = p_idempotency_key;
            END IF;
            RETURN;
        ELSE
            -- Webhook exists but capacity exhausted: clean up idempotency record and raise exception
            IF p_idempotency_key IS NOT NULL AND trim(p_idempotency_key) <> '' THEN
                DELETE FROM public.webhook_execution_idempotency
                WHERE idempotency_key = p_idempotency_key;
            END IF;
            RAISE EXCEPTION 'insufficient_capacity' USING ERRCODE = 'P0001';
        END IF;
    END IF;
END;
$function$;

-- Preserve permissions
REVOKE ALL ON FUNCTION public.increment_webhook_execution(uuid, integer, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_webhook_execution(uuid, integer, uuid, text) TO service_role;
