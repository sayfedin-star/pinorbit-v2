-- Migration: 20260910020000_add_pg_trgm_pa_pins_title_idx.sql
-- Description: Enable pg_trgm in extensions schema and create GIN trigram index on pa_pins (title)
-- Target Database: Project 4 (PinArchive) ONLY

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

CREATE INDEX IF NOT EXISTS idx_pa_pins_title_trgm
  ON public.pa_pins USING gin (title extensions.gin_trgm_ops);

NOTIFY pgrst, 'reload schema';

-- DOWN (Rollback Documentation):
-- DROP INDEX IF EXISTS public.idx_pa_pins_title_trgm;
