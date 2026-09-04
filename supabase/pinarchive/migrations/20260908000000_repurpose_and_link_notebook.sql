-- Migration: 20260908000000_repurpose_and_link_notebook.sql
-- Project 4: PinArchive (kuuugffvyokywtgmdrfk)
-- Architecture: D33 State Table + Passport Stamps + Independent Link Tables (Zero NULLs)
-- Security: Strict service_role lockdown pattern (no authenticated policies)

-- 1. Create pa_repurpose_batches table (D33 State Table)
CREATE TABLE IF NOT EXISTS public.pa_repurpose_batches (
  id UUID PRIMARY KEY, -- client-generated batch_uuid
  workspace_id UUID NOT NULL,
  user_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed', 'reconciling')) DEFAULT 'in_progress',
  pins_count INTEGER NOT NULL DEFAULT 0,
  targets_count INTEGER NOT NULL DEFAULT 0,
  result_summary JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pa_repurpose_batches_ws 
  ON public.pa_repurpose_batches(workspace_id);
CREATE INDEX IF NOT EXISTS idx_pa_repurpose_batches_status_updated 
  ON public.pa_repurpose_batches(status, updated_at);

ALTER TABLE public.pa_repurpose_batches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow service_role full access on pa_repurpose_batches" ON public.pa_repurpose_batches;
CREATE POLICY "Allow service_role full access on pa_repurpose_batches"
  ON public.pa_repurpose_batches
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 2. Create pa_pin_dispatches table (Passport Stamps)
CREATE TABLE IF NOT EXISTS public.pa_pin_dispatches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES public.pa_repurpose_batches(id) ON DELETE CASCADE,
  pa_pin_id UUID NOT NULL REFERENCES public.pa_pins(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL,
  target_account_id UUID NOT NULL,
  target_account_label TEXT NOT NULL,
  target_board_name TEXT NOT NULL,
  link_used TEXT NOT NULL DEFAULT '',
  p1_pin_id UUID NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_by UUID, -- nullable for automated/system dispatches
  CONSTRAINT uq_pa_pin_dispatches_batch UNIQUE(batch_id, pa_pin_id, target_account_id)
);

CREATE INDEX IF NOT EXISTS idx_pa_pin_dispatches_pin 
  ON public.pa_pin_dispatches(pa_pin_id);
CREATE INDEX IF NOT EXISTS idx_pa_pin_dispatches_workspace 
  ON public.pa_pin_dispatches(workspace_id);
CREATE INDEX IF NOT EXISTS idx_pa_pin_dispatches_acc_pin 
  ON public.pa_pin_dispatches(target_account_id, pa_pin_id);
CREATE INDEX IF NOT EXISTS idx_pa_pin_dispatches_p1_pin 
  ON public.pa_pin_dispatches(p1_pin_id);

ALTER TABLE public.pa_pin_dispatches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow service_role full access on pa_pin_dispatches" ON public.pa_pin_dispatches;
CREATE POLICY "Allow service_role full access on pa_pin_dispatches"
  ON public.pa_pin_dispatches
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 3. Create user_links table (Independent Global User Links, Zero NULLs)
CREATE TABLE IF NOT EXISTS public.user_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_user_links_user_url UNIQUE(user_id, url)
);

CREATE INDEX IF NOT EXISTS idx_user_links_user 
  ON public.user_links(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_links_default_star 
  ON public.user_links(user_id) WHERE is_default = true;

ALTER TABLE public.user_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow service_role full access on user_links" ON public.user_links;
CREATE POLICY "Allow service_role full access on user_links"
  ON public.user_links
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 4. Create workspace_links table (Independent Workspace Links, Zero NULLs, No FK)
CREATE TABLE IF NOT EXISTS public.workspace_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_workspace_links_ws_url UNIQUE(workspace_id, url)
);

CREATE INDEX IF NOT EXISTS idx_workspace_links_ws 
  ON public.workspace_links(workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_links_default_star 
  ON public.workspace_links(workspace_id) WHERE is_default = true;

ALTER TABLE public.workspace_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow service_role full access on workspace_links" ON public.workspace_links;
CREATE POLICY "Allow service_role full access on workspace_links"
  ON public.workspace_links
  FOR ALL TO service_role USING (true) WITH CHECK (true);
