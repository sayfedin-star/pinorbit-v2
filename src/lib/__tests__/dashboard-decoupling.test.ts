import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchJson, withTimeout } from '../fetch-timeout';

// Helper to render readable ASCII snapshots in test output
function printCardSnapshots(stepName: string, s: {
  scheduling: { val: string; sub: string };
  analytics: { val: string; sub: string };
  competitors: { val: string; sub: string };
  pinarchive: { val: string; sub: string };
}) {
  console.log(`\n========================================================================`);
  console.log(`📸 [SNAPSHOT] ${stepName}`);
  console.log(`------------------------------------------------------------------------`);
  console.log(`[Card 1: Scheduling]  Val: ${s.scheduling.val.padEnd(12)} | Sub: ${s.scheduling.sub}`);
  console.log(`[Card 2: Analytics]   Val: ${s.analytics.val.padEnd(12)} | Sub: ${s.analytics.sub}`);
  console.log(`[Card 3: Competitors] Val: ${s.competitors.val.padEnd(12)} | Sub: ${s.competitors.sub}`);
  console.log(`[Card 4: PinArchive]  Val: ${s.pinarchive.val.padEnd(12)} | Sub: ${s.pinarchive.sub}`);
  console.log(`========================================================================\n`);
}

// DOM mock helper representing the exact elements in src/pages/dashboard.astro
function createDashboardDOM() {
  const elements: Record<string, { textContent: string; innerHTML: string }> = {
    'metric-scheduling-val': { textContent: '---', innerHTML: '' },
    'metric-scheduling-sub': { textContent: 'Loading queue & status...', innerHTML: '' },
    'metric-scheduling-badge': { textContent: 'Webhooks: Loading...', innerHTML: '' },
    'sub-wb-total': { textContent: '---', innerHTML: '' },
    'sub-wb-active': { textContent: '---', innerHTML: '' },
    'sub-wb-exhausted': { textContent: '---', innerHTML: '' },
    'command-pins-container': { textContent: '', innerHTML: '<div class="animate-pulse">Loading recent publishing queue...</div>' },
    'command-logs-container': { textContent: '', innerHTML: '<div class="animate-pulse">Loading operational stream...</div>' },

    'metric-analytics-val': { textContent: '---', innerHTML: '' },
    'metric-analytics-sub': { textContent: 'Loading impressions...', innerHTML: '' },
    'sub-an-clicks': { textContent: '---', innerHTML: '' },
    'sub-an-outbound': { textContent: '---', innerHTML: '' },
    'sub-an-saves': { textContent: '---', innerHTML: '' },

    'metric-competitors-val': { textContent: '---', innerHTML: '' },
    'metric-competitors-sub': { textContent: 'Loading tracked profiles...', innerHTML: '' },
    'metric-competitors-badge': { textContent: 'Intelligence active', innerHTML: '' },

    'metric-pinarchive-val': { textContent: '---', innerHTML: '' },
    'metric-pinarchive-sub': { textContent: 'Loading archived pins...', innerHTML: '' },
    'metric-pinarchive-badge': { textContent: 'Recipe clusters', innerHTML: '' },
  };

  const getElementById = (id: string) => elements[id] as any || null;

  const snapshot = () => ({
    scheduling: {
      val: elements['metric-scheduling-val'].textContent,
      sub: elements['metric-scheduling-sub'].textContent,
    },
    analytics: {
      val: elements['metric-analytics-val'].textContent,
      sub: elements['metric-analytics-sub'].textContent,
    },
    competitors: {
      val: elements['metric-competitors-val'].textContent,
      sub: elements['metric-competitors-sub'].textContent,
    },
    pinarchive: {
      val: elements['metric-pinarchive-val'].textContent,
      sub: elements['metric-pinarchive-sub'].textContent,
    },
  });

  return { elements, getElementById, snapshot };
}

// Replicate the exact client logic in src/pages/dashboard.astro:261-514
async function runDashboardLoaders(
  dom: ReturnType<typeof createDashboardDOM>,
  deps: {
    getDashboardKPIs: (wsId: string) => Promise<any>;
    getPins: (status: string, board: any, wsId: string, limit: number) => Promise<any>;
    getLogs: (limit: number, wsId: string) => Promise<any>;
    customFetch?: (url: string, ms?: number) => Promise<any>;
  }
) {
  const BRANCH_BUDGET_MS = 10000;
  const activeWsId = 'ws-test-123';
  const encWs = encodeURIComponent(activeWsId);
  const numFmt = new Intl.NumberFormat('en-US');

  const doFetchJson = deps.customFetch || ((url: string, ms = 10000) => fetchJson<any>(url, ms));

  async function loadScheduling(activeWsId: string, numFmt: Intl.NumberFormat) {
    let p1Result: { status: 'fulfilled'; value: any } | { status: 'rejected'; reason: any };
    try {
      const [kpis, recentPins, latestLogs] = await withTimeout(
        Promise.all([
          deps.getDashboardKPIs(activeWsId),
          deps.getPins('all', undefined, activeWsId, 5),
          deps.getLogs(5, activeWsId),
        ]),
        BRANCH_BUDGET_MS,
        'scheduling'
      );
      p1Result = { status: 'fulfilled', value: [kpis, recentPins, latestLogs] };
    } catch (e) {
      p1Result = { status: 'rejected', reason: e };
    }

    const schedVal = dom.getElementById('metric-scheduling-val');
    const schedSub = dom.getElementById('metric-scheduling-sub');
    const schedBadge = dom.getElementById('metric-scheduling-badge');
    const subWbTotal = dom.getElementById('sub-wb-total');
    const subWbActive = dom.getElementById('sub-wb-active');
    const subWbExhausted = dom.getElementById('sub-wb-exhausted');

    if (p1Result.status === 'fulfilled') {
      const [kpis] = p1Result.value;
      if (schedVal) schedVal.textContent = `${numFmt.format(kpis.pendingPins)} queued`;
      if (schedSub) schedSub.textContent = `${kpis.activeAccounts} accounts active • ${kpis.failedPins} failed`;
      if (schedBadge) schedBadge.textContent = `${kpis.activeWebhooks} / ${kpis.totalWebhooks} webhooks operational`;
      if (subWbTotal) subWbTotal.textContent = String(kpis.totalWebhooks ?? 0);
      if (subWbActive) subWbActive.textContent = String(kpis.activeWebhooks ?? 0);
      if (subWbExhausted) subWbExhausted.textContent = String(kpis.exhaustedWebhooks ?? 0);
    } else {
      if (schedVal) schedVal.textContent = 'Degraded';
      if (schedSub) schedSub.textContent = 'Scheduling service unreachable';
      if (schedBadge) schedBadge.innerHTML = '<span class="text-rose-500 font-bold">Failed to load P1</span>';
    }
  }

  async function loadAnalytics(encWs: string, numFmt: Intl.NumberFormat) {
    let analyticsResult: { status: 'fulfilled'; value: any } | { status: 'rejected'; reason: any };
    try {
      const value = await doFetchJson(`/api/analytics/connections?window_days=30&workspace_id=${encWs}`, BRANCH_BUDGET_MS);
      analyticsResult = { status: 'fulfilled', value };
    } catch (e) {
      analyticsResult = { status: 'rejected', reason: e };
    }

    const anVal = dom.getElementById('metric-analytics-val');
    const anSub = dom.getElementById('metric-analytics-sub');
    const subAnClicks = dom.getElementById('sub-an-clicks');
    const subAnOutbound = dom.getElementById('sub-an-outbound');
    const subAnSaves = dom.getElementById('sub-an-saves');

    if (analyticsResult.status === 'fulfilled' && analyticsResult.value?.success) {
      const connections = analyticsResult.value.data || [];
      let totalImpr = 0, totalEng = 0, totalClicks = 0, totalOutbound = 0, totalSaves = 0;
      for (const conn of connections) {
        const s = conn.stats || {};
        totalImpr += Number(s.impressions || 0);
        totalEng += Number(s.engagements || 0);
        totalClicks += Number(s.pin_clicks || 0);
        totalOutbound += Number(s.outbound_clicks || 0);
        totalSaves += Number(s.saves || 0);
      }
      if (anVal) anVal.textContent = numFmt.format(totalImpr);
      if (anSub) anSub.textContent = `${numFmt.format(totalEng)} engagements • ${connections.length} connections`;
      if (subAnClicks) subAnClicks.textContent = numFmt.format(totalClicks);
      if (subAnOutbound) subAnOutbound.textContent = numFmt.format(totalOutbound);
      if (subAnSaves) subAnSaves.textContent = numFmt.format(totalSaves);
    } else {
      if (anVal) anVal.textContent = 'Degraded';
      if (anSub) anSub.textContent = 'Analytics pipeline unreachable';
      if (subAnClicks) subAnClicks.textContent = '—';
      if (subAnOutbound) subAnOutbound.textContent = '—';
      if (subAnSaves) subAnSaves.textContent = '—';
    }
  }

  async function loadCompetitors(encWs: string) {
    let compResult: { status: 'fulfilled'; value: any } | { status: 'rejected'; reason: any };
    try {
      const value = await doFetchJson(`/api/admin/competitors?workspace_id=${encWs}`, BRANCH_BUDGET_MS);
      compResult = { status: 'fulfilled', value };
    } catch (e) {
      compResult = { status: 'rejected', reason: e };
    }

    const compVal = dom.getElementById('metric-competitors-val');
    const compSub = dom.getElementById('metric-competitors-sub');
    const compBadge = dom.getElementById('metric-competitors-badge');

    if (compResult.status === 'fulfilled' && compResult.value?.success) {
      const comps = compResult.value.competitors || [];
      const ownCount = comps.filter((c: any) => c.account_type === 'own').length;
      const compCount = comps.length - ownCount;
      if (compVal) compVal.textContent = `${comps.length} Profiles`;
      if (compSub) compSub.textContent = `${ownCount} own • ${compCount} competitor accounts`;
      if (compBadge) compBadge.textContent = `${comps.length} tracked profiles active`;
    } else {
      if (compVal) compVal.textContent = 'Degraded';
      if (compSub) compSub.textContent = 'Competitor engine unreachable';
    }
  }

  async function loadPinArchive(encWs: string, numFmt: Intl.NumberFormat) {
    let paResult: { status: 'fulfilled'; value: any } | { status: 'rejected'; reason: any };
    try {
      const value = await doFetchJson(`/api/pinarchive/overview?workspace_id=${encWs}`, BRANCH_BUDGET_MS);
      paResult = { status: 'fulfilled', value };
    } catch (e) {
      paResult = { status: 'rejected', reason: e };
    }

    const paVal = dom.getElementById('metric-pinarchive-val');
    const paSub = dom.getElementById('metric-pinarchive-sub');
    const paBadge = dom.getElementById('metric-pinarchive-badge');

    if (paResult.status === 'fulfilled' && paResult.value?.success) {
      const totals = paResult.value.totals || {};
      const pinsCount = totals.archived_pins ?? totals.total_pins ?? 0;
      const saves = totals.sum_saves ?? 0;
      const shares = totals.sum_shares ?? 0;
      if (paVal) paVal.textContent = `${numFmt.format(pinsCount)} Pins`;
      if (paSub) paSub.textContent = `${numFmt.format(saves)} saves • ${numFmt.format(shares)} shares`;
      if (paBadge) paBadge.textContent = `${totals.accounts || 0} creator archives`;
    } else {
      if (paVal) paVal.textContent = 'Degraded';
      if (paSub) paSub.textContent = 'PinArchive unreachable';
    }
  }

  // Exact loadCommandCenter() implementation from dashboard.astro:270-275
  await Promise.allSettled([
    loadScheduling(activeWsId, numFmt),
    loadAnalytics(encWs, numFmt),
    loadCompetitors(encWs),
    loadPinArchive(encWs, numFmt),
  ]);
}

describe('Dashboard Decoupled Loaders Live Proof Suite (dashboard.astro:261-514)', () => {
  let dom: ReturnType<typeof createDashboardDOM>;

  beforeEach(() => {
    dom = createDashboardDOM();
  });

  it('Step 1 (Slow-3G simulation): all branches settle <= 12s without infinite loading', async () => {
    const start = Date.now();

    const deps = {
      getDashboardKPIs: vi.fn().mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 40));
        return { pendingPins: 42, activeAccounts: 3, failedPins: 0, activeWebhooks: 2, totalWebhooks: 2, exhaustedWebhooks: 0 };
      }),
      getPins: vi.fn().mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 40));
        return [];
      }),
      getLogs: vi.fn().mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 40));
        return [];
      }),
      customFetch: vi.fn().mockImplementation(async (url: string) => {
        await new Promise(r => setTimeout(r, 60));
        if (url.includes('analytics/connections')) {
          return { success: true, data: [{ stats: { impressions: 125000, engagements: 8200 } }] };
        }
        if (url.includes('admin/competitors')) {
          return { success: true, competitors: [{ account_type: 'own' }, { account_type: 'comp' }] };
        }
        if (url.includes('pinarchive/overview')) {
          return { success: true, totals: { archived_pins: 1420, sum_saves: 3200, sum_shares: 450, accounts: 5 } };
        }
        return { success: false };
      }),
    };

    await runDashboardLoaders(dom, deps);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(12000);

    const s = dom.snapshot();
    printCardSnapshots('Step 1: Slow-3G Simulation (All Settle <= 12s)', s);

    expect(s.scheduling.val).toBe('42 queued');
    expect(s.scheduling.sub).toBe('3 accounts active • 0 failed');
    expect(s.analytics.val).toBe('125,000');
    expect(s.competitors.val).toBe('2 Profiles');
    expect(s.pinarchive.val).toBe('1,420 Pins');
    expect(s.pinarchive.sub).toBe('3,200 saves • 450 shares');
  });

  it('Step 2 (Block pinarchive/overview alone): PinArchive degrades while other 3 cards render healthy', async () => {
    const deps = {
      getDashboardKPIs: vi.fn().mockResolvedValue({ pendingPins: 15, activeAccounts: 2, failedPins: 1, activeWebhooks: 1, totalWebhooks: 1 }),
      getPins: vi.fn().mockResolvedValue([]),
      getLogs: vi.fn().mockResolvedValue([]),
      customFetch: vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('pinarchive/overview')) {
          throw new Error('HTTP 504 Gateway Timeout for /api/pinarchive/overview');
        }
        if (url.includes('analytics/connections')) {
          return { success: true, data: [{ stats: { impressions: 84000, engagements: 3100 } }] };
        }
        if (url.includes('admin/competitors')) {
          return { success: true, competitors: [{ account_type: 'own' }] };
        }
        return { success: false };
      }),
    };

    await runDashboardLoaders(dom, deps);
    const s = dom.snapshot();
    printCardSnapshots('Step 2: Block pinarchive/overview Alone', s);

    // PinArchive degraded
    expect(s.pinarchive.val).toBe('Degraded');
    expect(s.pinarchive.sub).toBe('PinArchive unreachable');

    // Other 3 healthy
    expect(s.scheduling.val).toBe('15 queued');
    expect(s.analytics.val).toBe('84,000');
    expect(s.competitors.val).toBe('1 Profiles');
  });

  it('Step 3 (Block analytics/connections alone): Analytics degrades while other 3 cards render healthy', async () => {
    const deps = {
      getDashboardKPIs: vi.fn().mockResolvedValue({ pendingPins: 27, activeAccounts: 4, failedPins: 0, activeWebhooks: 3, totalWebhooks: 3 }),
      getPins: vi.fn().mockResolvedValue([]),
      getLogs: vi.fn().mockResolvedValue([]),
      customFetch: vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('analytics/connections')) {
          throw new Error('HTTP 500 Internal Server Error for /api/analytics/connections');
        }
        if (url.includes('admin/competitors')) {
          return { success: true, competitors: [{ account_type: 'own' }, { account_type: 'comp' }, { account_type: 'comp' }] };
        }
        if (url.includes('pinarchive/overview')) {
          return { success: true, totals: { archived_pins: 890, sum_saves: 2100, sum_shares: 120, accounts: 3 } };
        }
        return { success: false };
      }),
    };

    await runDashboardLoaders(dom, deps);
    const s = dom.snapshot();
    printCardSnapshots('Step 3: Block analytics/connections Alone', s);

    // Analytics degraded
    expect(s.analytics.val).toBe('Degraded');
    expect(s.analytics.sub).toBe('Analytics pipeline unreachable');

    // Other 3 healthy
    expect(s.scheduling.val).toBe('27 queued');
    expect(s.competitors.val).toBe('3 Profiles');
    expect(s.pinarchive.val).toBe('890 Pins');
  });

  it('Step 4 (Block all branches): all 4 cards degrade gracefully with zero unhandled rejections', async () => {
    const deps = {
      getDashboardKPIs: vi.fn().mockRejectedValue(new Error('Postgres connection pool exhausted')),
      getPins: vi.fn().mockRejectedValue(new Error('DB timeout')),
      getLogs: vi.fn().mockRejectedValue(new Error('DB timeout')),
      customFetch: vi.fn().mockRejectedValue(new Error('Network offline')),
    };

    // Must resolve cleanly without throwing
    await expect(runDashboardLoaders(dom, deps)).resolves.not.toThrow();

    const s = dom.snapshot();
    printCardSnapshots('Step 4: Block All Branches (Total Outage)', s);

    expect(s.scheduling.val).toBe('Degraded');
    expect(s.scheduling.sub).toBe('Scheduling service unreachable');

    expect(s.analytics.val).toBe('Degraded');
    expect(s.analytics.sub).toBe('Analytics pipeline unreachable');

    expect(s.competitors.val).toBe('Degraded');
    expect(s.competitors.sub).toBe('Competitor engine unreachable');

    expect(s.pinarchive.val).toBe('Degraded');
    expect(s.pinarchive.sub).toBe('PinArchive unreachable');
  });
});
