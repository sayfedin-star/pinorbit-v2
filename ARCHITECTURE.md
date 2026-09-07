# PinOrbit Architecture & System Specification

## 1. System Layer Diagram

```mermaid
flowchart TD
    subgraph UI_Layer [UI Layer: Astro SSR + Tailwind]
        AccountsPage[Accounts Overview /accounts]
        AccountDetails[Account Details /accounts/details?id=...]
        AccountPins[Account Pins /accounts/pins?id=...]
        AccountBoards[Account Boards /accounts/boards?id=...]
        PipelineKit[Board Pipeline Kit /accounts/board-pipeline]
    end

    subgraph API_Funnels [API Funnels: Server-Side Astro Endpoints]
        SchedulesAPI[/api/schedules & /api/schedules/bulk]
        BoardsAPI[/api/boards/action]
        TokensAPI[/api/tokens, /api/tokens/id, /api/fastcron-tokens/id/ping]
        RetentionAPI[/api/internal/pinterest/cleanup-retention]
    end

    subgraph Dispatch_Engine [Dispatch Engine with Strict Guards]
        DispatchEndpoint[/api/internal/pinterest/dispatch-due-pin]
        ScheduleGuard[Window, Timezone & Day-Off Validator]
        AccountCapGuard[Daily Max Pins Cap Checker]
        AtomicClaim[claim_due_pins_simple RPC with SKIP LOCKED]
        OrphanSweep[Per-Workspace Timeout Stale Lock Sweep]
    end

    subgraph FastCron_Engine [FastCron Portable Cron Trigger]
        FastCronExternal[FastCron External Service]
        SelfContainedCron[Portable Cron Expressions / URL Dispatch Tokens]
    end

    subgraph Bridge_Layer [Make.com: Stateless Pinterest Bridge]
        MakeScenario1[Make Scenario 1: Pin Publisher]
        MakeScenario2[Make Scenario 2: Board Provisioner]
        MakeScenario3[Make Scenario 3: Boards Synchronizer]
        PinterestAPI[Pinterest Official API v5]
    end

    subgraph Ingest_Layer [Ingest Callbacks]
        IngestEndpoint[/api/internal/pinterest/ingest]
        SecretAuth[x-ingest-secret Authenticator]
        IdempotencyDedupe[Idempotency Key Deduplication]
    end

    subgraph Database_Layer [Supabase Postgres (P1) + Tenant Isolation]
        RLSPolicies[Row Level Security auth.uid in workspace_memberships]
        Tables[pins, boards, posting_schedules, account_webhooks, workspace_retention_settings, fastcron_tokens, audit_log]
    end

    UI_Layer --> API_Funnels
    FastCronExternal -->|GET with dispatch_token| DispatchEndpoint
    API_Funnels --> Database_Layer
    DispatchEndpoint --> ScheduleGuard --> AccountCapGuard --> OrphanSweep --> AtomicClaim
    AtomicClaim -->|Ticket Push application/json| Bridge_Layer
    Bridge_Layer --> PinterestAPI
    Bridge_Layer -->|Callback event: pin.posted / pin.failed / board.created / boards.list / board.deleted| IngestEndpoint
    IngestEndpoint --> SecretAuth --> IdempotencyDedupe --> Database_Layer
```

---

## 2. Decision Log (Decision log)

### 1. Make.com as Stateless Bridge Only
- **Context:** PinOrbit avoids executing heavy direct OAuth token management or unvetted external SDKs directly inside serverless edge workers.
- **Decision:** Make.com scenarios act strictly as stateless connectors / API proxies to Pinterest. All orchestration logic, queue management, retry scheduling, pacing, state machines, and data stores reside solely in PinOrbit (Supabase + Cloudflare/Astro). Scenarios parse incoming tickets, call Pinterest, and dispatch standard callback events back to `/api/internal/pinterest/ingest`.

### 2. Portable, Self-Contained Cron Expressions & Triggers
- **Context:** FastCron triggers must work reliably without shared server state or tight coupling to local cron processes.
- **Decision:** Schedules generate deterministic, self-contained cron expressions calculated from `window_start`, `window_end`, `interval_minutes`, `active_days`, and `timezone`. When dispatched, FastCron calls the endpoint with unique UUID `dispatch_token` credentials so execution requires zero pre-warmed sessions.

### 3. Write-Only Secrets with Auto-Seeded `TOKEN_KEK`
- **Context:** API tokens (FastCron API tokens, ingest secrets) must never leak to client JavaScript or browser logs.
- **Decision:** Tokens are encrypted at rest using AES-GCM via a cryptographically secure Key Encryption Key (`TOKEN_KEK`). Read endpoints never return decrypted tokens; UI inputs are write-only overrides. Default tokens cascade cleanly: Schedule Token $\rightarrow$ Workspace Token $\rightarrow$ Environment Default.

### 4. Deterministic Idempotency Keys
- **Context:** Network retries, webhook deliveries, and concurrency can cause duplicate pins or boards.
- **Decision:** Every dispatched ticket and callback payload carries an explicit `idempotency_key` (e.g., `pin.post:<pin_id>:<attempt>`, `create:<account_id>:<board_name>`). Supabase upsert rules and ingest handlers deduplicate on this key, preventing race conditions.

### 5. Account-Centric Navigation Architecture & Sidebar Cleanup
- **Context:** Global multi-tenant lists for pins, boards, and schedules created cognitive overload and routing ambiguities.
- **Decision:** Management was reorganized strictly per-account (`/accounts/details?id=...`, `/accounts/pins?id=...`, `/accounts/boards?id=...`). Global `/boards`, `/pins`, and `/schedules` issue 302 redirects to `/accounts`. Sidebar surface was streamlined to 6 primary roots: Dashboard, Accounts, Logs, Competitors, Analytics, Settings.

### 6. Strict Board Retention & Pagination Safety
- **Context:** Pinterest accounts with large numbers of boards (>50) might suffer silent deletion if syncer callbacks pagination failed.
- **Decision:** PinOrbit never automatically deletes boards that are absent from a remote Pinterest sync. Deletion is either explicit Pinterest API delete with confirmation or local row detachment via `delete_local`.

---

## 3. Database Migrations & Versioning (Project 1: Scheduling Authority `eygdoetdwqllvsxpvoex`)

All migrations must be applied sequentially in chronological order matching the filenames in `supabase/scheduling/migrations/`:

| Order | Migration Filename | Core Responsibilities |
|---|---|---|
| 1 | `20260808000000_init_scheduling_tenants_and_auth.sql` | Workspaces, memberships, auth tables, baseline schema |
| 2 | `20260808000001_init_scheduling_accounts_boards_pins.sql` | Accounts, boards, pins, account_webhooks |
| 3 | `20260808000002_init_scheduling_delivery_audit_logs.sql` | Logs, delivery queue, audit records |
| 4 | `20260812000000_harden_membership_bootstrap_and_tier_config_writes.sql` | Membership bootstrap RPCs, tier write security |
| 5 | `20260814000000_workspace_retention_settings.sql` | Workspace retention configurations & timeout settings |
| 6 | `20260815000000_publishing_engine_v2.sql` | Auto-board provisioning, atomic dispatch RPCs (`claim_due_pins_simple`) |
| 7 | `20260816000000_posting_schedules.sql` | `posting_schedules` core table & RLS policies |
| 8 | `20260817000000_posting_schedules_status_extend.sql` | Extend check constraints for statuses (`not_synced`, `error`) |
| 9 | `20260818000000_fastcron_tokens_and_schedule_meta.sql` | `fastcron_tokens` table, 5 RLS policies, metadata columns |
| 10 | `20260819000000_posting_schedules_cron_expression.sql` | `cron_expression` column on `posting_schedules` |
| 11 | `20260820000000_scheduling_perf_indexes.sql` | Foreign key & status lookup performance indexes |
| 12 | `20260821000000_accounts_board_webhook.sql` | `board_webhook_id` on `accounts` for dedicated board webhooks |

---

## 4. Live Make Specification Source

> [!NOTE]
> **Board Pipeline Kit Page:** The interactive page at `/accounts/board-pipeline` (`src/pages/accounts/board-pipeline.astro`) serves as the definitive, executable live specification for all Make.com scenarios.
>
> It dynamically renders verbatim JSON templates for:
> - **Route 1 (Board Creation):** `board.created`
> - **Route 2 (Board Listing & Sync):** `board.created` (per-item bundle iterator) or `boards.list` (bulk array payload)
> - **Route 3 (Board Deletion):** `board.deleted`
> - **Publish Webhooks (Pin Posting):** `pin.posted` (success) & `pin.failed` (error handler route)

---

## 5. Accepted Risks & Architectural Trade-offs

1. **No Rate-Limiter Middleware on Dispatch Endpoints:**
   - *Risk:* Ingestion and dispatch routes receive unthrottled requests.
   - *Mitigation:* Dispatch endpoints require secret UUID tokens (`dispatch_token`) scoped per schedule and ingest routes validate `x-ingest-secret`. Invalid calls immediately terminate with lightweight HTTP 401/403/404 responses before running database operations.
2. **FastCron Token Resolution Order:**
   - *Hierarchy:* Schedule embedded token (`fastcron_token_encrypted`) $\rightarrow$ Schedule Token Row (`fastcron_tokens`) $\rightarrow$ Workspace Default Token (`is_default = true`) $\rightarrow$ Environment Fallback (`FASTCRON_API_TOKEN`).
   - *Mitigation:* Pure evaluator `evaluateTokenCandidates` guarantees deterministic fallback without leaking unencrypted keys.
3. **Workspace Retention & Timeout Clamp Bounds:**
   - *Ranges:* `retention_posted_days` clamped strictly between 1–365 days (default 30); `processing_timeout_minutes` clamped strictly between 5–240 minutes (default 45).
   - *Mitigation:* Server-side clamp helpers in `src/server/services/scheduling-logic.ts` enforce bounds across settings endpoints, orphan recovery sweeps, and retention purge routines.
4. **External Network Timeouts:**
   - *Risk:* Downstream Make.com or Pinterest latency could block worker threads.
   - *Mitigation:* All outgoing HTTP requests employ strict `AbortSignal.timeout(8000)` timeouts wrapped in `try/catch` fallbacks to ensure fail-safe operation.
5. **Multi-Tier SSRF Defense for Sitemap & Link Notebook Inspection:**
   - *Risk:* User-supplied URLs for sitemap import could target cloud internal metadata services (e.g., `169.254.169.254`) or loopback interfaces (`127.0.0.1`, `::1`).
   - *Mitigation:* PinOrbit runs on Cloudflare Pages / Workers edge infrastructure. Outbound `fetch()` requests are filtered by Cloudflare's platform networking layer, which strictly blocks resolution to private RFC 1918, RFC 3927 (link-local), and loopback IP spaces by default. Additionally, application-level URL validation ensures strictly `http:` / `https:` schemes and valid hostnames, preventing SSRF attacks against internal network endpoints.
6. **Concurrent Cross-Batch Duplicate Dispatch Race (Accepted-by-Design):**
   - *Risk:* Two independent batches initiated simultaneously with different `batchUuid`s targeting the exact same pin and account could both pass the initial `checkPriorDispatches` read check and insert duplicate draft pins into P1 before either batch finishes recording stamps to P4 (`pa_pin_dispatches`).
   - *Decision:* Cross-batch distributed locking between P1 and P4 for arbitrary concurrent dispatches is deliberately omitted to prevent distributed lock contention, network partitioning deadlocks, and latency spikes across database boundaries. Pin dispatches are user-initiated with frontend idempotency guards (disabling submit buttons and displaying active state). In the rare event of a concurrent race, P1 pins are created in `draft` status, allowing harmless manual cleanup by the user. Once stamps are committed in P4, all subsequent batches and zombie recovery CAS passes deterministically detect and deduplicate against existing stamps.
7. **Webhook Ingest & Execution Idempotency:**
   - *Design:* Single-statement `INSERT INTO public.webhook_execution_idempotency` with 7-day TTL cleanup in `increment_webhook_execution` RPC prevents duplicate quota deductions on network retries while bounding table storage.
   - *Pin Posting Dedup:* Webhook callback `pin.posted` short-circuits returning HTTP 200 `{ success: true, handled: 'pin_posted_duplicate' }` when `pin.status === 'posted'`, preventing mutation of `posted_at` or duplicate delivery log entries.
8. **ETL Failure Streak Scoping:**
   - *Design:* In-memory tracker keys streaks on `${workspaceId}:${connectionId}:${channel}` ensuring that failure streaks on one connection or channel do not cross-pollute another connection or channel within the same tenant.
9. **PinArchive Safe Default & Pre-CAS Validation:**
   - *Safe Default:* Staged pin dispatches enforce `allowDuplicates = false` across both service and HTTP layer (requiring explicit opt-in for duplicate dispatches).
   - *Pre-CAS Verification:* Destination validation checks target board publishability on P1 prior to CAS acquisition, rolling back or rejecting early while preserving 409 conflict semantics when staged pins are missing or already consumed.
10. **Secret Resolution Parity & Fail-Closed Scoping:**
    - *Parity:* `getEffectiveSecret` strictly throws `HttpError(400, 'Invalid workspace UUID')` when a truthy non-UUID workspace ID is provided, aligning behavior with `getSecretCandidates` and preventing malformed sessions from collapsing into shared global secrets.
11. **Webhook Execution Atomic Reservation Predicate:**
    - *Design:* `increment_webhook_execution` enforces `AND (w.monthly_capacity IS NULL OR w.remaining_capacity >= p_count)` within the atomic update statement on `account_webhooks`.
    - *Missing vs Exhausted Contract:* When 0 rows are updated, an existence check distinguishes non-existent/unauthorized webhooks (silent `RETURN` preserving existing caller contracts) from capacity exhaustion (`RAISE EXCEPTION 'insufficient_capacity' USING ERRCODE = 'P0001'`). In `dispatch-due-pin.ts`, `insufficient_capacity` is handled prior to retrying, safely resetting claimed pins back to `pending` and returning HTTP 503 `no_webhook_capacity`.
12. **Bulk Operation Signaling Envelope Semantics & Staged Asymmetry:**
    - *Competitors Bulk:* `/api/competitors/schedules/bulk.ts` sets `success: successCount > 0` alongside additive helpers `all_succeeded` and `any_succeeded`, ensuring that 0/N failed executions do not report a misleading top-level `success: true` while preserving HTTP 200 and the detailed `results[]` array.
    - *Deliberate Asymmetry:* Staged bulk operations (`/api/pinarchive/staged/dispatch-bulk.ts`) deliberately retain legacy envelope semantics (`success: true` on partial/fail envelope with counts in `dispatched`/`skipped`) to maintain client backward compatibility for batch dispatch consumers.
13. **Competitor Table Cascade Deletion & Tenant Verification:**
    - *Live Constraint Verification:* Verified via Supabase MCP on 2026-09-07 querying `information_schema.referential_constraints` on P2 (`guycnhvwfzdzbpgsnavg`): all child tables (`competitor_settings`, `competitor_boards`, `competitor_snapshots`, `competitor_daily_snapshots`, `competitor_ingestion_jobs`, `competitor_top_pins`) enforce `delete_rule = 'CASCADE'` to `competitors.id`.
    - *Tenant Scoping:* For child tables lacking a dedicated `workspace_id` column (`competitor_snapshots`, `competitor_top_pins`), tenant isolation is strictly anchored by verifying that the parent `competitors` record exists with `workspace_id = activeWorkspaceId` before issuing queries.
14. **Staged Pin CAS Ordering Window Trade-off:**
    - *Ordering Window:* Pre-CAS destination validation checks target board publishability on P1 prior to CAS acquisition. The TOCTOU window between pre-check and CAS status update is closed by post-CAS re-verification with automatic rollback compensation on failure. Holding `dispatched` during destination validation is an accepted trade-off that prioritizes system consistency and prevents double-dispatch.
15. **PinArchive Metrics & Ingest Accounting:**
    - *Accurate Added Count:* `pa_ingest_pin_batch` computes `v_added_count` using the post-deduplicated incoming count from `temp_incoming_pins` (`v_unique_incoming_count - v_updated_count`), preventing duplicate or blank input pins from artificially inflating the `added` counter.
    - *Comments Metric Tracking:* The `inserted_metrics` `WHERE NOT EXISTS` predicate includes `AND pm.comments >= u.comments`, ensuring comment-only metric advances generate telemetry snapshot rows.
16. **Schedule IANA Timezone Validation:**
    - *Validation Boundary:* Competitor schedule creation and update endpoints validate timezones against IANA standards using `Intl.DateTimeFormat`, rejecting non-empty invalid timezones with HTTP 400 at input while preserving resilient `'UTC'` fallbacks when omitted or blank and at execution time.
17. **Analytics Bulk Remote Delete Confirmation & Inherited Granularity:**
    - *Confirmation Contract:* Local database cleanup in `/api/analytics/cron/bulk.ts` strictly gates unlinking cron job IDs and resetting schedule status to `'pending'` on `results[].success === true` (with `!Number.isNaN(n)` guards), preventing local state from decoupling when remote FastCron deletions fail.
    - *Inherited Fan-Out Granularity:* FastCron's `batchDelete` API returns a single aggregate verdict that is fanned across all job IDs within a given token group (`bulk.ts:501-505`). Consequently, the confirmed-only set inherits this batch-level coarseness (it over-clears on false-positive remote batch success and correctly under-clears on remote failure). Note that competitor bulk operations use `success: successCount > 0` alongside additive helper flags, whereas staged bulk operations deliberately retain legacy envelope semantics (`success: true` with count breakdowns) for client compatibility.
18. **PostgREST Query Boundary Capping (`.range(0, 999)`):**
    - *Explicit Bounds:* Unpaginated aggregate queries (`competitors` list in `/api/admin/competitors.ts` and `url` facet query in `/api/links/index.ts`) convert implicit PostgREST 1000-row caps into explicit `.range(0, 999)` bounded reads.
    - *Truncation Posture:* While explicit bounding prevents unbounded memory growth and PostgREST protocol crashes, workspaces with >1000 entities will receive bounded facets and counts. Comprehensive multi-page retrieval continues to be supported via paginated cursor/range endpoints (e.g. `fetchAllLinks` in links Mode B).
19. **Competitor Board Tenant Isolation Scoping:**
    - *Tenant Anchoring:* Queries against `competitor_boards` in `/api/admin/competitors.ts` explicitly filter by `workspace_id = activeWorkspaceId` in addition to `in('competitor_id', ids)`. Even though child records cascade on competitor deletion, explicit tenant predicates enforce defense-in-depth isolation across all administrative aggregation endpoints.
20. **Redacted Error Logging Protocol:**
    - *Confidentiality Guard:* All background handlers and API catch blocks employ typed `catch (e: any)` bindings and emit message-only warnings (`console.warn(..., e?.message)`).
    - *Zero Credential Leakage:* Catch blocks strictly avoid interpolating raw request URLs (which may embed `?secret=` or `?token=` query parameters) or request bodies (which may contain authorization headers or bearer tokens) into server logs.
21. **Maintenance & Repair Endpoints Lifecycle:**
    - *Operational Utility:* Header repair endpoints (`/api/competitors/schedules/repair-headers.ts` and `/api/pinarchive/repair-headers.ts`) are retained without obsolete `TODO(remove-after-verification)` markers as administrative maintenance utilities for re-syncing legacy FastCron webhook headers and validating secret candidate resolution.
