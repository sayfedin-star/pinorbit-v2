-- Migration: 20260910030000_create_pa_account_stats_delta.sql
-- Description: Dedicated account summary table with true O(1) incremental delta trigger, account init trigger, and reconcile routine
-- Target Database: Project 4 (PinArchive) ONLY

-- 1. Create table
CREATE TABLE IF NOT EXISTS public.pa_account_stats (
  workspace_id uuid NOT NULL,
  account_id uuid PRIMARY KEY REFERENCES public.pa_accounts(id) ON DELETE CASCADE,
  pins_count bigint NOT NULL DEFAULT 0,
  archived_count bigint NOT NULL DEFAULT 0,
  sum_saves numeric NOT NULL DEFAULT 0,
  sum_shares numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. Index on workspace_id for instant overview sums
CREATE INDEX IF NOT EXISTS idx_pa_account_stats_ws
  ON public.pa_account_stats(workspace_id);

-- 3. Enable RLS (Aligned with Project 4 server-only service_role pattern)
ALTER TABLE public.pa_account_stats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pa_account_stats_sr ON public.pa_account_stats;
CREATE POLICY pa_account_stats_sr
  ON public.pa_account_stats
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON TABLE public.pa_account_stats FROM PUBLIC;
GRANT ALL ON TABLE public.pa_account_stats TO service_role;

-- 4. Initial Seed & Periodic Reconcile Function (Can be called monthly or after audit_sweep, NEVER by the trigger)
CREATE OR REPLACE FUNCTION public.pa_reconcile_account_stats(p_account_id uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_acc RECORD;
BEGIN
  FOR v_acc IN 
    SELECT a.id, a.workspace_id 
    FROM public.pa_accounts a 
    WHERE (p_account_id IS NULL OR a.id = p_account_id)
  LOOP
    INSERT INTO public.pa_account_stats (
      workspace_id, account_id, pins_count, archived_count, sum_saves, sum_shares, updated_at
    )
    SELECT
      v_acc.workspace_id,
      v_acc.id,
      count(*)::bigint,
      count(*) FILTER (WHERE p.archived_at IS NOT NULL)::bigint,
      coalesce(sum(p.saves), 0)::numeric,
      coalesce(sum(p.share_count), 0)::numeric,
      now()
    FROM public.pa_pins p
    WHERE p.account_id = v_acc.id
    ON CONFLICT (account_id) DO UPDATE SET
      pins_count = EXCLUDED.pins_count,
      archived_count = EXCLUDED.archived_count,
      sum_saves = EXCLUDED.sum_saves,
      sum_shares = EXCLUDED.sum_shares,
      updated_at = now();
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.pa_reconcile_account_stats(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pa_reconcile_account_stats(uuid) TO service_role;

-- Seed all existing accounts initially
SELECT public.pa_reconcile_account_stats();

-- 5. True O(1) Incremental Delta Trigger Function on pa_pins
CREATE OR REPLACE FUNCTION public.trg_pa_pins_delta_stats()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- INSERT: O(1) increment
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.pa_account_stats (
      workspace_id, account_id, pins_count, archived_count, sum_saves, sum_shares, updated_at
    )
    VALUES (
      NEW.workspace_id,
      NEW.account_id,
      1,
      CASE WHEN NEW.archived_at IS NOT NULL THEN 1 ELSE 0 END,
      coalesce(NEW.saves, 0)::numeric,
      coalesce(NEW.share_count, 0)::numeric,
      now()
    )
    ON CONFLICT (account_id) DO UPDATE SET
      pins_count = pa_account_stats.pins_count + 1,
      archived_count = pa_account_stats.archived_count + (CASE WHEN NEW.archived_at IS NOT NULL THEN 1 ELSE 0 END),
      sum_saves = pa_account_stats.sum_saves + coalesce(NEW.saves, 0)::numeric,
      sum_shares = pa_account_stats.sum_shares + coalesce(NEW.share_count, 0)::numeric,
      updated_at = now();
    RETURN NEW;

  -- UPDATE: O(1) delta difference
  ELSIF TG_OP = 'UPDATE' THEN
    -- Fast no-op guard: if relevant metrics and account have not changed, exit immediately
    IF (OLD.account_id IS NOT DISTINCT FROM NEW.account_id)
       AND (OLD.saves IS NOT DISTINCT FROM NEW.saves)
       AND (OLD.share_count IS NOT DISTINCT FROM NEW.share_count)
       AND ((OLD.archived_at IS NULL) = (NEW.archived_at IS NULL)) THEN
      RETURN NEW;
    END IF;

    IF (OLD.account_id = NEW.account_id) THEN
      UPDATE public.pa_account_stats
      SET
        archived_count = GREATEST(0, archived_count + (
          CASE
            WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN 1
            WHEN OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN -1
            ELSE 0
          END
        )),
        sum_saves = GREATEST(0::numeric, sum_saves + (coalesce(NEW.saves, 0)::numeric - coalesce(OLD.saves, 0)::numeric)),
        sum_shares = GREATEST(0::numeric, sum_shares + (coalesce(NEW.share_count, 0)::numeric - coalesce(OLD.share_count, 0)::numeric)),
        updated_at = now()
      WHERE account_id = NEW.account_id;
    ELSE
      -- Account reassignment (rare): decrement old, increment new
      UPDATE public.pa_account_stats
      SET
        pins_count = GREATEST(0, pins_count - 1),
        archived_count = GREATEST(0, archived_count - (CASE WHEN OLD.archived_at IS NOT NULL THEN 1 ELSE 0 END)),
        sum_saves = GREATEST(0::numeric, sum_saves - coalesce(OLD.saves, 0)::numeric),
        sum_shares = GREATEST(0::numeric, sum_shares - coalesce(OLD.share_count, 0)::numeric),
        updated_at = now()
      WHERE account_id = OLD.account_id;

      INSERT INTO public.pa_account_stats (
        workspace_id, account_id, pins_count, archived_count, sum_saves, sum_shares, updated_at
      )
      VALUES (
        NEW.workspace_id,
        NEW.account_id,
        1,
        CASE WHEN NEW.archived_at IS NOT NULL THEN 1 ELSE 0 END,
        coalesce(NEW.saves, 0)::numeric,
        coalesce(NEW.share_count, 0)::numeric,
        now()
      )
      ON CONFLICT (account_id) DO UPDATE SET
        pins_count = pa_account_stats.pins_count + 1,
        archived_count = pa_account_stats.archived_count + (CASE WHEN NEW.archived_at IS NOT NULL THEN 1 ELSE 0 END),
        sum_saves = pa_account_stats.sum_saves + coalesce(NEW.saves, 0)::numeric,
        sum_shares = pa_account_stats.sum_shares + coalesce(NEW.share_count, 0)::numeric,
        updated_at = now();
    END IF;
    RETURN NEW;

  -- DELETE: O(1) decrement
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.pa_account_stats
    SET
      pins_count = GREATEST(0, pins_count - 1),
      archived_count = GREATEST(0, archived_count - (CASE WHEN OLD.archived_at IS NOT NULL THEN 1 ELSE 0 END)),
      sum_saves = GREATEST(0::numeric, sum_saves - coalesce(OLD.saves, 0)::numeric),
      sum_shares = GREATEST(0::numeric, sum_shares - coalesce(OLD.share_count, 0)::numeric),
      updated_at = now()
    WHERE account_id = OLD.account_id;
    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_pa_pins_stats ON public.pa_pins;
CREATE TRIGGER trg_pa_pins_stats
AFTER INSERT OR UPDATE OR DELETE ON public.pa_pins
FOR EACH ROW
EXECUTE FUNCTION public.trg_pa_pins_delta_stats();

-- 6. Trigger on pa_accounts to initialize zero row for newly created accounts
CREATE OR REPLACE FUNCTION public.trg_pa_accounts_init_stats()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.pa_account_stats (
    workspace_id, account_id, pins_count, archived_count, sum_saves, sum_shares, updated_at
  )
  VALUES (
    NEW.workspace_id, NEW.id, 0, 0, 0, 0, now()
  )
  ON CONFLICT (account_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pa_accounts_stats ON public.pa_accounts;
CREATE TRIGGER trg_pa_accounts_stats
AFTER INSERT ON public.pa_accounts
FOR EACH ROW
EXECUTE FUNCTION public.trg_pa_accounts_init_stats();

-- 7. Overview Accelerated RPC
CREATE OR REPLACE FUNCTION public.pa_workspace_sums_fast(p_workspace_id uuid)
RETURNS TABLE (sum_saves numeric, sum_shares numeric, total_pins bigint, archived_pins bigint)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=''
AS $$
  SELECT
    coalesce(sum(sum_saves), 0)::numeric AS sum_saves,
    coalesce(sum(sum_shares), 0)::numeric AS sum_shares,
    coalesce(sum(pins_count), 0)::bigint AS total_pins,
    coalesce(sum(archived_count), 0)::bigint AS archived_pins
  FROM public.pa_account_stats
  WHERE workspace_id = p_workspace_id;
$$;

REVOKE ALL ON FUNCTION public.pa_workspace_sums_fast(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pa_workspace_sums_fast(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

-- DOWN (Rollback Documentation):
-- DROP TRIGGER IF EXISTS trg_pa_pins_stats ON public.pa_pins;
-- DROP FUNCTION IF EXISTS public.trg_pa_pins_delta_stats();
-- DROP TRIGGER IF EXISTS trg_pa_accounts_stats ON public.pa_accounts;
-- DROP FUNCTION IF EXISTS public.trg_pa_accounts_init_stats();
-- DROP FUNCTION IF EXISTS public.pa_workspace_sums_fast(uuid);
-- DROP FUNCTION IF EXISTS public.pa_reconcile_account_stats(uuid);
-- DROP TABLE IF EXISTS public.pa_account_stats CASCADE;
