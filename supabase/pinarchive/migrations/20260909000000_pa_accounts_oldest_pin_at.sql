-- Backfill oldest discovered pin timestamp per account.
-- Apply manually via Supabase SQL Editor (Project kuuugffvyokywtgmdrfk) or via Supabase MCP.
-- Then reload PostgREST schema cache if the column is not immediately visible.
alter table public.pa_accounts
  add column if not exists oldest_pin_at timestamptz;

comment on column public.pa_accounts.oldest_pin_at is
  'Oldest discovered pin created_at (monotonic min over discovery batches). Written by pinarchive-discovery only; ingest never writes it.';

notify pgrst, 'reload schema';

-- One-time backfill AFTER deploy is intentionally left to the operator:
-- option A (accurate): run GAS account_ages once per workspace and update pa_accounts from the result;
-- option B (gradual): leave NULL; discovery fills it monotonically on subsequent runs (converges fully after first audit_sweep).
-- Do NOT backfill from pa_pins MIN(created_at): pa_pins holds qualifying pins only, while oldest_pin_at semantics are oldest DISCOVERED pin.
