-- Migration: 20260920000000_pa_pins_monotonic_metrics.sql
-- Enforce monotonic metrics at the database storage engine level for pa_pins.
-- Prevents race conditions and out-of-order writes from regressing saves, repins, comments, and shares.

CREATE OR REPLACE FUNCTION public.trg_pa_pins_enforce_monotonic_metrics()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.saves := GREATEST(COALESCE(OLD.saves, 0), COALESCE(NEW.saves, 0));
    NEW.repins := GREATEST(COALESCE(OLD.repins, 0), COALESCE(NEW.repins, 0));
    NEW.comments := GREATEST(COALESCE(OLD.comments, 0), COALESCE(NEW.comments, 0));
    NEW.share_count := GREATEST(COALESCE(OLD.share_count, 0), COALESCE(NEW.share_count, 0));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pa_pins_monotonic_metrics ON public.pa_pins;
CREATE TRIGGER trg_pa_pins_monotonic_metrics
  BEFORE UPDATE ON public.pa_pins
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_pa_pins_enforce_monotonic_metrics();
