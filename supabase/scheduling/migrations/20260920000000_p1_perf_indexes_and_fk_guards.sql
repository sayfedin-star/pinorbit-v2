-- ==============================================================================
-- Migration: 20260920000000_p1_perf_indexes_and_fk_guards.sql
-- Project 1: Scheduling (eygdoetdwqllvsxpvoex)
-- Domain: Covering FK Indexes, Queue Composite Indexes, RLS InitPlan & Subquery Optimization
-- ==============================================================================

-- 1. Foreign Key Covering Indexes (Eliminates 7 unindexed FK warnings and table scans)
CREATE INDEX IF NOT EXISTS idx_posting_schedules_webhook_id 
  ON public.posting_schedules (webhook_id) 
  WHERE webhook_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_accounts_board_webhook_id 
  ON public.accounts (board_webhook_id) 
  WHERE board_webhook_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_logs_workspace_id 
  ON public.logs (workspace_id) 
  WHERE workspace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_board_prov_requests_ws 
  ON public.board_provisioning_requests (workspace_id);

CREATE INDEX IF NOT EXISTS idx_import_sessions_account 
  ON public.import_sessions (account_id);

CREATE INDEX IF NOT EXISTS idx_import_sessions_created_by 
  ON public.import_sessions (created_by);

CREATE INDEX IF NOT EXISTS idx_webhook_idempotency_webhook_id 
  ON public.webhook_execution_idempotency (webhook_id);

-- 2. Composite Performance Indexes on Pins Queue
-- Optimizes getPins(workspaceId, { status, scheduled_for })
CREATE INDEX IF NOT EXISTS idx_pins_ws_status_scheduled 
  ON public.pins (workspace_id, status, scheduled_for ASC NULLS LAST);

-- Optimizes getPins(workspaceId, { accountId, status, scheduled_for })
CREATE INDEX IF NOT EXISTS idx_pins_ws_acc_status_scheduled 
  ON public.pins (workspace_id, account_id, status, scheduled_for ASC NULLS LAST);

-- Optimizes claim_due_pins_simple atomic dispatch (FOR UPDATE SKIP LOCKED)
CREATE INDEX IF NOT EXISTS idx_pins_claim_pending_created 
  ON public.pins (account_id, created_at ASC) 
  WHERE (status = 'pending');

-- Optimizes repurpose reverse reconciliation batch lookups
CREATE INDEX IF NOT EXISTS idx_pins_ws_source_ref 
  ON public.pins (workspace_id, source_ref) 
  WHERE source_ref IS NOT NULL;

-- 3. Fix auth_rls_initplan and multiple_permissive_policies on workspace_retention_settings
DROP POLICY IF EXISTS "Users can view retention settings in their workspaces" ON public.workspace_retention_settings;
DROP POLICY IF EXISTS "Admins can manage retention settings in their workspaces" ON public.workspace_retention_settings;

CREATE POLICY "Users can view retention settings in their workspaces" 
  ON public.workspace_retention_settings FOR SELECT TO authenticated 
  USING (workspace_id IN (
    SELECT wm.workspace_id FROM public.workspace_memberships wm 
    WHERE wm.user_id = (SELECT auth.uid())
  ));

CREATE POLICY "Admins can insert retention settings in their workspaces" 
  ON public.workspace_retention_settings FOR INSERT TO authenticated 
  WITH CHECK (workspace_id IN (
    SELECT wm.workspace_id FROM public.workspace_memberships wm 
    WHERE wm.user_id = (SELECT auth.uid()) AND wm.role = 'admin'
  ));

CREATE POLICY "Admins can update retention settings in their workspaces" 
  ON public.workspace_retention_settings FOR UPDATE TO authenticated 
  USING (workspace_id IN (
    SELECT wm.workspace_id FROM public.workspace_memberships wm 
    WHERE wm.user_id = (SELECT auth.uid()) AND wm.role = 'admin'
  ))
  WITH CHECK (workspace_id IN (
    SELECT wm.workspace_id FROM public.workspace_memberships wm 
    WHERE wm.user_id = (SELECT auth.uid()) AND wm.role = 'admin'
  ));

CREATE POLICY "Admins can delete retention settings in their workspaces" 
  ON public.workspace_retention_settings FOR DELETE TO authenticated 
  USING (workspace_id IN (
    SELECT wm.workspace_id FROM public.workspace_memberships wm 
    WHERE wm.user_id = (SELECT auth.uid()) AND wm.role = 'admin'
  ));

-- 4. Denormalize workspace_id to account_webhooks & account_posting_windows for 10x faster RLS
ALTER TABLE public.account_webhooks 
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE;

ALTER TABLE public.account_posting_windows 
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE;

-- Backfill from parent accounts
UPDATE public.account_webhooks w
SET workspace_id = a.workspace_id
FROM public.accounts a
WHERE w.account_id = a.id AND w.workspace_id IS NULL;

UPDATE public.account_posting_windows pw
SET workspace_id = a.workspace_id
FROM public.accounts a
WHERE pw.account_id = a.id AND pw.workspace_id IS NULL;

-- Auto-sync triggers for new child inserts
CREATE OR REPLACE FUNCTION public.sync_account_child_workspace_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.workspace_id IS NULL THEN
        SELECT workspace_id INTO NEW.workspace_id FROM public.accounts WHERE id = NEW.account_id;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_webhook_workspace_id ON public.account_webhooks;
CREATE TRIGGER trg_sync_webhook_workspace_id
    BEFORE INSERT OR UPDATE ON public.account_webhooks
    FOR EACH ROW EXECUTE FUNCTION public.sync_account_child_workspace_id();

DROP TRIGGER IF EXISTS trg_sync_posting_window_workspace_id ON public.account_posting_windows;
CREATE TRIGGER trg_sync_posting_window_workspace_id
    BEFORE INSERT OR UPDATE ON public.account_posting_windows
    FOR EACH ROW EXECUTE FUNCTION public.sync_account_child_workspace_id();

-- Indexes for direct workspace RLS checks
CREATE INDEX IF NOT EXISTS idx_account_webhooks_ws ON public.account_webhooks (workspace_id);
CREATE INDEX IF NOT EXISTS idx_account_posting_windows_ws ON public.account_posting_windows (workspace_id);

-- Update RLS policies to use direct workspace check instead of per-row EXISTS subquery
DROP POLICY IF EXISTS "Workspace members read account webhooks" ON public.account_webhooks;
CREATE POLICY "Workspace members read account webhooks" 
  ON public.account_webhooks FOR SELECT TO authenticated 
  USING (public.is_workspace_member(workspace_id));

DROP POLICY IF EXISTS "Workspace admins insert account webhooks" ON public.account_webhooks;
CREATE POLICY "Workspace admins insert account webhooks" 
  ON public.account_webhooks FOR INSERT TO authenticated 
  WITH CHECK (public.is_workspace_admin(workspace_id));

DROP POLICY IF EXISTS "Workspace admins update account webhooks" ON public.account_webhooks;
CREATE POLICY "Workspace admins update account webhooks" 
  ON public.account_webhooks FOR UPDATE TO authenticated 
  USING (public.is_workspace_admin(workspace_id))
  WITH CHECK (public.is_workspace_admin(workspace_id));

DROP POLICY IF EXISTS "Workspace admins delete account webhooks" ON public.account_webhooks;
CREATE POLICY "Workspace admins delete account webhooks" 
  ON public.account_webhooks FOR DELETE TO authenticated 
  USING (public.is_workspace_admin(workspace_id));

DROP POLICY IF EXISTS "Workspace members can access account posting windows" ON public.account_posting_windows;
DROP POLICY IF EXISTS "Workspace members read account posting windows" ON public.account_posting_windows;
DROP POLICY IF EXISTS "Workspace admins insert account posting windows" ON public.account_posting_windows;
DROP POLICY IF EXISTS "Workspace admins update account posting windows" ON public.account_posting_windows;
DROP POLICY IF EXISTS "Workspace admins delete account posting windows" ON public.account_posting_windows;

CREATE POLICY "Workspace members read account posting windows" 
  ON public.account_posting_windows FOR SELECT TO authenticated 
  USING (public.is_workspace_member(workspace_id));

CREATE POLICY "Workspace admins insert account posting windows" 
  ON public.account_posting_windows FOR INSERT TO authenticated 
  WITH CHECK (public.is_workspace_admin(workspace_id));

CREATE POLICY "Workspace admins update account posting windows" 
  ON public.account_posting_windows FOR UPDATE TO authenticated 
  USING (public.is_workspace_admin(workspace_id))
  WITH CHECK (public.is_workspace_admin(workspace_id));

CREATE POLICY "Workspace admins delete account posting windows" 
  ON public.account_posting_windows FOR DELETE TO authenticated 
  USING (public.is_workspace_admin(workspace_id));

-- 5. Add Service Role policy to webhook_execution_idempotency (clears 0008_rls_enabled_no_policy)
DROP POLICY IF EXISTS "service_role_all_webhook_execution_idempotency" ON public.webhook_execution_idempotency;
CREATE POLICY "service_role_all_webhook_execution_idempotency" 
  ON public.webhook_execution_idempotency 
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 6. Reload PostgREST schema cache
SELECT pg_notify('pgrst', 'reload schema');
