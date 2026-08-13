CREATE TABLE IF NOT EXISTS public.posting_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  webhook_id UUID REFERENCES public.account_webhooks(id) ON DELETE SET NULL,
  label TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  window_start TIME NOT NULL DEFAULT '09:00',
  window_end TIME NOT NULL DEFAULT '21:00',
  interval_minutes INTEGER NOT NULL DEFAULT 36 CHECK (interval_minutes BETWEEN 1 AND 1440),
  random_delay_minutes INTEGER NOT NULL DEFAULT 0 CHECK (random_delay_minutes BETWEEN 0 AND 60),
  active_days TEXT[] NOT NULL DEFAULT '{Mon,Tue,Wed,Thu,Fri,Sat,Sun}',
  started_at TIMESTAMPTZ,
  batch INTEGER NOT NULL DEFAULT 1 CHECK (batch BETWEEN 1 AND 10),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  dispatch_token TEXT NOT NULL,
  fastcron_job_id TEXT,
  fastcron_token_encrypted TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.posting_schedules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members read posting schedules" ON public.posting_schedules FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));
CREATE POLICY "Admins insert posting schedules" ON public.posting_schedules FOR INSERT TO authenticated WITH CHECK (public.is_workspace_admin(workspace_id));
CREATE POLICY "Admins update posting schedules" ON public.posting_schedules FOR UPDATE TO authenticated USING (public.is_workspace_admin(workspace_id)) WITH CHECK (public.is_workspace_admin(workspace_id));
CREATE POLICY "Admins delete posting schedules" ON public.posting_schedules FOR DELETE TO authenticated USING (public.is_workspace_admin(workspace_id));
CREATE POLICY "Service all posting schedules" ON public.posting_schedules FOR ALL TO service_role USING (true) WITH CHECK (true);
