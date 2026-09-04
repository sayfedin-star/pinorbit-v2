-- Migration: Create Dispatch Queue (Staged Pins) Table
CREATE TABLE IF NOT EXISTS public.pa_staged_pins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  staged_by UUID NOT NULL,
  pa_pin_id UUID NOT NULL REFERENCES public.pa_pins(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  image_url TEXT NOT NULL,
  original_link TEXT NOT NULL DEFAULT '',
  override_link TEXT NOT NULL DEFAULT '',
  board_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'dispatched', 'cancelled')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pa_staged_pins_ws_status 
  ON public.pa_staged_pins (workspace_id, status, created_at DESC);

-- Enable RLS
ALTER TABLE public.pa_staged_pins ENABLE ROW LEVEL SECURITY;

-- Service role bypass policy for backend access
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'public' 
      AND tablename = 'pa_staged_pins' 
      AND policyname = 'service_role_all_pa_staged_pins'
  ) THEN
    CREATE POLICY "service_role_all_pa_staged_pins"
      ON public.pa_staged_pins
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;
