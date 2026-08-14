ALTER TABLE public.posting_schedules DROP CONSTRAINT IF EXISTS posting_schedules_status_check;
ALTER TABLE public.posting_schedules ADD CONSTRAINT posting_schedules_status_check
  CHECK (status IN ('active','paused','not_synced','error'));
