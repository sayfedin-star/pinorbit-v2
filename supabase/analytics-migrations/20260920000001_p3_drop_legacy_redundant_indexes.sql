-- ==============================================================================
-- Migration: 20260920000001_p3_drop_legacy_redundant_indexes.sql
-- Project 3: Analytics (jxdkbwnwtjelznmauwpc)
-- Domain: Drop redundant non-tenant legacy indexes to save ~11MB of disk space and reduce ingestion write amplification
-- ==============================================================================

DROP INDEX IF EXISTS public.idx_top_pins_windowed;
DROP INDEX IF EXISTS public.idx_top_pins_pin_timeline;
DROP INDEX IF EXISTS public.idx_top_pins_pin_trend;

-- Reload PostgREST schema cache
SELECT pg_notify('pgrst', 'reload schema');
