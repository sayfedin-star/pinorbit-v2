-- Migration: 20260908000000_add_source_ref_to_pins.sql
-- Project 1: Scheduling (eygdoetdwqllvsxpvoex)
-- Add source_ref and source_creator to pins for reverse reconciliation tracking

ALTER TABLE public.pins ADD COLUMN IF NOT EXISTS source_ref TEXT;
ALTER TABLE public.pins ADD COLUMN IF NOT EXISTS source_creator TEXT;

CREATE INDEX IF NOT EXISTS idx_pins_source_ref 
  ON public.pins(source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pins_source_creator 
  ON public.pins(source_creator) WHERE source_creator IS NOT NULL;
