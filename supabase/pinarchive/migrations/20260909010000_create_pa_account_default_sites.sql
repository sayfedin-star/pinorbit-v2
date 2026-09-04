-- Migration: 20260909010000_create_pa_account_default_sites.sql
-- Description: Create pa_account_default_sites table to store per-account default destination sites/domains (v2.9)

CREATE TABLE IF NOT EXISTS public.pa_account_default_sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  account_id UUID NOT NULL,
  default_site TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_pa_account_default_sites UNIQUE(workspace_id, account_id)
);

-- Enable RLS
ALTER TABLE public.pa_account_default_sites ENABLE ROW LEVEL SECURITY;

-- Service role full access policy
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'pa_account_default_sites'
      AND policyname = 'service_role_all_pa_account_default_sites'
  ) THEN
    CREATE POLICY "service_role_all_pa_account_default_sites"
      ON public.pa_account_default_sites
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- Workspace index
CREATE INDEX IF NOT EXISTS idx_pa_account_default_sites_ws
  ON public.pa_account_default_sites(workspace_id);
