-- Migration: Expand pa_runs trigger check constraint to include 'audit_sweep'
ALTER TABLE public.pa_runs DROP CONSTRAINT IF EXISTS pa_runs_trigger_check;
ALTER TABLE public.pa_runs ADD CONSTRAINT pa_runs_trigger_check CHECK (trigger = ANY (ARRAY['cron'::text, 'manual'::text, 'backfill'::text, 'refresh'::text, 'audit_sweep'::text]));
