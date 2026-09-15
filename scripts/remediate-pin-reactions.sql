-- PinArchive Data Remediation: Healing Corrupted Reactions & Eliminating Zero-Drops
-- Run once on PinArchive P4 database to fix historical 0-drops and align pa_pins reactions.

-- 1. Repair pa_pin_metrics snapshots:
-- Replace false 0 values with the maximum known reaction count recorded for that pin up to that snapshot time.
WITH max_prior AS (
  SELECT
    pm.id AS metric_id,
    (
      SELECT MAX(prev.reactions_total)
      FROM public.pa_pin_metrics prev
      WHERE prev.pin_ref = pm.pin_ref
        AND prev.recorded_at <= pm.recorded_at
        AND prev.reactions_total > 0
    ) AS computed_max
  FROM public.pa_pin_metrics pm
  WHERE pm.reactions_total = 0
)
UPDATE public.pa_pin_metrics pm
SET reactions_total = mp.computed_max
FROM max_prior mp
WHERE pm.id = mp.metric_id
  AND mp.computed_max IS NOT NULL
  AND mp.computed_max > 0;

-- 2. Repair pa_pins:
-- Restore pa_pins.reactions to the maximum historical reaction count recorded in snapshots.
WITH max_metrics AS (
  SELECT pin_ref, MAX(reactions_total) AS max_reactions
  FROM public.pa_pin_metrics
  WHERE reactions_total > 0
  GROUP BY pin_ref
)
UPDATE public.pa_pins p
SET reactions = jsonb_build_object('total', m.max_reactions, 'type_1', m.max_reactions)
FROM max_metrics m
WHERE p.id = m.pin_ref
  AND coalesce((p.reactions->>'total')::bigint, 0) < m.max_reactions;
