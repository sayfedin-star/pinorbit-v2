-- Migration: 20260922000001_fix_competitor_schedules_unique_constraint.sql
-- Fix [F-07]: Replace partial unique index with a standard unique constraint supported by PostgREST on_conflict

DROP INDEX IF EXISTS public.idx_competitor_schedules_ws_job;

ALTER TABLE public.competitor_schedules 
DROP CONSTRAINT IF EXISTS uq_competitor_schedules_ws_job;

ALTER TABLE public.competitor_schedules 
ADD CONSTRAINT uq_competitor_schedules_ws_job UNIQUE (workspace_id, fastcron_job_id);

SELECT pg_notify('pgrst', 'reload schema');
