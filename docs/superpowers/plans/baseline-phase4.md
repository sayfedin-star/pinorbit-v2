# Phase 4 Baseline: Client Bundle Measurements for `analytics/[id]`

**Captured on:** 2026-09-08  
**Worktree:** `pinorbit_performance_security_audit`  
**Page Route:** `/analytics/[id]` (`src/pages/analytics/[id].astro`)  
**Command:** `npm run build` (`astro build`)

---

## 1. Source Script Sizes (`src/scripts/`)

| Script | Associated Tab | Initial Visibility | Source Size (Raw) | Share of Total |
| :--- | :--- | :--- | :--- | :--- |
| `tabs.ts` | Navigation / Hash Routing | Visible (Always) | 1.21 KB (1,239 B) | 0.8% |
| `analytics-tables.ts` | Data & Analytics (`#panel-data`) | Visible (Default) | 21.28 KB (21,788 B) | 14.9% |
| `pipeline-controls.ts` | Pipeline & Automation (`#panel-pipe`) | `hidden` | 58.47 KB (59,873 B) | 41.0% |
| `pin-intelligence.ts` | Pin Intelligence (`#panel-intel`) | `hidden` | 50.31 KB (51,522 B) | 35.3% |
| `purge-controls.ts` | Data Purge (`#panel-purge`) | `hidden` | 11.45 KB (11,721 B) | 8.0% |
| **Total** | | | **142.72 KB (146,143 B)** | **100%** |

### Key Observations
- The 3 hidden tabs (`pipeline-controls.ts` + `pin-intelligence.ts` + `purge-controls.ts`) account for **120.23 KB (84.2%)** of the client script payload.
- Only **22.49 KB (15.8%)** is needed for initial rendering of the active "Data & Analytics" tab.

---

## 2. Production Build Output (`dist/_astro/`)

In the baseline build, Astro hoists all 5 scripts into a single monolithic bundle:

| Artifact | Raw Size | Gzip Size | Status |
| :--- | :--- | :--- | :--- |
| `dist/_astro/hoisted.Dfzq_Hr9.js` | 92.96 kB (93,054 B) | 22.14 kB | Evaluated synchronously on initial page load |

### Execution Behavior
- When a user navigates to `/analytics/[id]`, all 5 scripts execute immediately.
- `pipeline-controls.ts` registers event handlers and initiates sync checkers for hidden DOM nodes.
- `pin-intelligence.ts` initializes state machines and table managers for hidden DOM nodes.
- `purge-controls.ts` attaches listeners for hidden deletion modals.

---

## 3. Target Optimization Profile

- **Initial Entry Load:** `tabs.ts` + `analytics-tables.ts` only (~22.5 KB source, dedicated bundle).
- **Deferred Chunks:** Dynamic on-demand `import()` for `pipeline-controls`, `pin-intelligence`, and `purge-controls` upon first tab activation.
- **Expected Initial Payload Reduction:** ~84% reduction in executed tab logic on page entry.
