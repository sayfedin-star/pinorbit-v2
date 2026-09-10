-- Migration: 20260910010000_add_pa_pins_annotations_gin_idx.sql
-- Description: GIN index on pa_pins (annotations) for JSON containment queries
-- Target Database: Project 4 (PinArchive) ONLY

CREATE INDEX IF NOT EXISTS idx_pa_pins_annotations_gin
  ON public.pa_pins USING gin (annotations jsonb_path_ops);

NOTIFY pgrst, 'reload schema';

-- DOWN (Rollback Documentation):
-- DROP INDEX IF EXISTS public.idx_pa_pins_annotations_gin;
