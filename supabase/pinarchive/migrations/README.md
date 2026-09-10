| 1 | 20260822000000_pinarchive_schema.sql | Initial PinArchive schema (pa_accounts, pa_pins, pa_pin_metrics, pa_runs) | None | Apply manually via Supabase SQL Editor (Project kuuugffvyokywtgmdrfk) |
| 2 | 20260823000000_pinarchive_relay_enrichment.sql | annotations/SEO/social/board/follower enrichment, pa_runs trigger includes 'refresh' | 20260822000000 | Apply manually via Supabase SQL Editor (Project kuuugffvyokywtgmdrfk) |
| 3 | 20260823000000_pinarchive_notes.sql | Manual notes and notes_updated_at columns on pa_pins | 20260823000000 | Apply manually via Supabase SQL Editor (Project kuuugffvyokywtgmdrfk) |
| 8 | 20260901000000_pa_overview_sums_rpc.sql | pa_workspace_sums RPC for overview KPI sums | 20260831120000 | Apply via Supabase MCP (Project kuuugffvyokywtgmdrfk) |
| 9 | 20260909000000_pa_accounts_oldest_pin_at.sql | oldest_pin_at on pa_accounts (monotonic, discovery-written) | 20260901000000 | Apply manually via Supabase SQL Editor (Project kuuugffvyokywtgmdrfk) |
| 10 | 20260910000000_add_pa_pins_ws_acc_saves_idx.sql | Composite index on pa_pins (workspace_id, account_id, saves DESC) | 20260909010000 | Apply via Supabase MCP / SQL Editor (Project kuuugffvyokywtgmdrfk) |
| 11 | 20260910010000_add_pa_pins_annotations_gin_idx.sql | GIN index on pa_pins (annotations) for JSON containment | 20260910000000 | Apply via Supabase MCP / SQL Editor (Project kuuugffvyokywtgmdrfk) |
| 12 | 20260910040000_update_pa_topic_pins_limit.sql | Add pagination, total_count, and dual-indexed @> to pa_topic_pins | 20260910010000 | Apply via Supabase MCP / SQL Editor (Project kuuugffvyokywtgmdrfk) |




