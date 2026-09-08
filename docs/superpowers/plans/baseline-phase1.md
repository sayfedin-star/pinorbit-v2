# Phase 1 Baseline: Client Bundle Measurements & Import Leaks

**Captured on:** 2026-09-08  
**Worktree:** `pinorbit_performance_security_audit`  
**Command:** `npm run build` (`astro build`)

---

## 1. Top 10 Client JS Bundles (`dist/_astro/*.js`)

| Rank | File Name | Raw Size | Gzip Size | Description / Notes |
|:---|:---|:---|:---|:---|
| 1 | `auth.B7w9KKlh.js` | 268.12 kB | 70.53 kB | Client auth bundle pulled into all layouts via `Topbar.astro` |
| 2 | `hoisted.BZv0f2Zv.js` | 93.00 kB | 22.13 kB | Heavy client script bundle (`accounts/details.astro` + domain imports) |
| 3 | `hoisted.DUHmIAzg.js` | 81.05 kB | 20.00 kB | Heavy client script bundle |
| 4 | `hoisted.BZnMdNWf.js` | 76.71 kB | 18.82 kB | Client script bundle |
| 5 | `hoisted.BwErWSZf.js` | 63.28 kB | 14.72 kB | Client script bundle |
| 6 | `hoisted.CSKhRqZU.js` | 52.81 kB | 14.44 kB | Client script bundle |
| 7 | `hoisted.DBV_GpOv.js` | 45.30 kB | 10.61 kB | Client script bundle |
| 8 | `hoisted.BSLmBYOo.js` | 39.49 kB | 9.95 kB | Client script bundle |
| 9 | `hoisted.CA_erCi2.js` | 38.25 kB | 10.48 kB | Client script bundle |
| 10 | `hoisted.D9g5pU-4.js` | 34.51 kB | 9.24 kB | Client script bundle |

*Additional notable client bundle:*
- `WorkspaceSwitcher.astro_astro_type_script_index_0_lang.Dim89rEa.js`: 14.28 kB (gzip: 3.95 kB)

---

## 2. Verified Client Import Leak Call-Sites

The following call-sites import domain or server-adjacent logic directly into client `<script>` blocks or layouts:

1. **`src/components/Topbar.astro:217`**
   - Import: `signOut` from `../lib/auth.ts`
   - Leaks: `auth.ts` imports monolithic `supabase.ts`, pulling client auth bundle into every layout.

2. **`src/components/WorkspaceSwitcher.astro:191-192`**
   - Imports: `src/lib/workspaces.ts` and `src/lib/workspaces-client.ts`
   - Leaks: Pulled `supabase.ts` and server SSR types into the switcher script.

3. **`src/pages/dashboard.astro:247-250`**
   - Client imports from monolithic `../lib/supabase.ts` (`getDashboardKPIs`, `getAccounts`, `getPins`).

4. **`src/pages/scheduling/index.astro:167-170`**
   - Client imports from `../../lib/supabase.ts`.

5. **`src/pages/accounts/details.astro:1014-1032`**
   - Client imports 16 domain functions from `../../lib/supabase.ts` (`getAccountDetails`, `getAccountPinStats`, `getAccountPins`, `getAccountBoards`, `getAccountRecentLogs`, `getAccountWebhookSummary`, `getAccountWebhooks`, `createAccountWebhook`, `updateAccountWebhook`, `toggleAccountWebhookActive`, `deleteAccountWebhook`, `setPrimaryWebhook`, `updateAccountSchedule`, `updateAccountScheduling`, `updateAccountDailyLimit`, `toggleAccountActive`, `rescheduleAccountPendingPins`).

6. **`src/pages/accounts/pins.astro:277-286`**
   - Client imports from `../../lib/supabase.ts`.

7. **`src/pages/accounts/boards.astro:266-274`**
   - Client imports from `../../lib/supabase.ts`.

8. **`src/pages/login.astro:120`**
   - Client imports `signIn` from `../lib/auth.ts`.
