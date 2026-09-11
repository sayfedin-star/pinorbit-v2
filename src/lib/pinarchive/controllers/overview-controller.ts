import { getWorkspaceId, fetchOverview, fetchCompetitors } from '../api-client';
import { fmtNumberFull } from '../format';
import { timeAgo } from '../../ui-helpers';
import type { DashboardState } from './state';

export interface OverviewControllerCallbacks {
  onAccountsLoaded: () => void;
  onCompetitorsLoaded: () => void;
  onCostEstimateUpdate: () => void;
}

export class OverviewController {
  private state: DashboardState;
  private callbacks: OverviewControllerCallbacks;
  private loadingWatchdogFired = false;

  constructor(state: DashboardState, callbacks: OverviewControllerCallbacks) {
    this.state = state;
    this.callbacks = callbacks;
  }

  public init(): void {
    this.setupTopRefreshButton();
    this.armLoadingWatchdog();
  }

  public async loadCompetitorUsernames(): Promise<void> {
    try {
      const json = await fetchCompetitors();
      if (json.competitors && Array.isArray(json.competitors)) {
        this.state.competitorMap.clear();
        for (const c of json.competitors) {
          if (c.username) {
            this.state.competitorMap.set(String(c.username).toLowerCase().trim(), {
              id: c.id,
              username: c.username,
            });
          }
        }
        if (this.state.rawAccounts.length > 0) {
          this.callbacks.onCompetitorsLoaded();
        }
      }
    } catch (e) {
      console.warn('Failed to load competitor usernames for PinArchive cross-badging:', e);
    }
  }

  public async loadOverview(retries = 2): Promise<void> {
    const kpiAccounts = document.getElementById('kpi-accounts-count');
    const kpiArchived = document.getElementById('kpi-archived-pins');
    const kpiSaves = document.getElementById('kpi-total-saves');
    const kpiShares = document.getElementById('kpi-total-shares');
    const metaText = document.getElementById('refresh-meta-text');
    const tbody = document.getElementById('accounts-table-body');

    try {
      const wsId = getWorkspaceId();
      const json = await fetchOverview(wsId);

      // FIRE-AND-FORGET: Fetch competitor badges independently without blocking KPIs
      setTimeout(() => this.loadCompetitorUsernames(), 100);

      const totals = json.totals || {};
      const accounts = json.accounts || [];
      this.state.rawAccounts = accounts;

      // Update KPI cards
      if (kpiAccounts) kpiAccounts.textContent = fmtNumberFull(totals.accounts ?? accounts.length);
      if (kpiArchived) kpiArchived.textContent = fmtNumberFull(totals.archived_pins ?? 0);
      if (kpiSaves) kpiSaves.textContent = fmtNumberFull(totals.sum_saves ?? 0);
      if (kpiShares) kpiShares.textContent = fmtNumberFull(totals.sum_shares ?? 0);

      // Meta refresh line
      if (metaText) {
        if (accounts.length > 0 && accounts[0].last_run_at) {
          metaText.textContent = `Last refreshed ${timeAgo(accounts[0].last_run_at)}`;
        } else {
          metaText.textContent = 'No sync runs recorded';
        }
      }

      this.callbacks.onAccountsLoaded();
      this.callbacks.onCostEstimateUpdate();
    } catch (e: any) {
      if (retries > 0) {
        if (tbody) {
          tbody.innerHTML = `<tr><td colspan="11" class="p-8 text-center text-xs text-muted-foreground animate-pulse">Retrying… (attempt ${3 - retries}/2)</td></tr>`;
        }
        setTimeout(() => this.loadOverview(retries - 1), 1500);
        return;
      }
      console.error('Error loading PinArchive overview:', e);

      if (kpiAccounts) kpiAccounts.textContent = '—';
      if (kpiArchived) kpiArchived.textContent = '—';
      if (kpiSaves) kpiSaves.textContent = '—';
      if (kpiShares) kpiShares.textContent = '—';
      if (metaText) metaText.textContent = 'Sync schedule unavailable';

      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="11" class="p-8 text-center text-xs text-rose-500">
           Failed to load accounts. <button id="retry-load-btn" class="underline font-bold cursor-pointer ml-1">Retry</button>
         </td></tr>`;
      }
      document.getElementById('retry-load-btn')?.addEventListener('click', () => {
        if (tbody) tbody.innerHTML = `<tr><td colspan="11" class="p-8 text-center text-xs text-muted-foreground animate-pulse">Loading tracked accounts…</td></tr>`;
        if (kpiAccounts) kpiAccounts.innerHTML = '<div class="h-8 w-12 bg-muted/60 rounded animate-pulse"></div>';
        if (kpiArchived) kpiArchived.innerHTML = '<div class="h-8 w-12 bg-muted/60 rounded animate-pulse"></div>';
        if (kpiSaves) kpiSaves.innerHTML = '<div class="h-8 w-12 bg-muted/60 rounded animate-pulse"></div>';
        if (kpiShares) kpiShares.innerHTML = '<div class="h-8 w-12 bg-muted/60 rounded animate-pulse"></div>';
        if (metaText) metaText.textContent = 'Loading sync schedule...';
        this.loadOverview(2);
      });
    }
  }

  public setupTopRefreshButton(): void {
    document.getElementById('pa-refresh-btn')?.addEventListener('click', () => {
      const icon = document.getElementById('pa-refresh-icon');
      icon?.classList.add('animate-spin');
      this.loadOverview(1).finally(() => {
        setTimeout(() => icon?.classList.remove('animate-spin'), 400);
      });
    });
  }

  public armLoadingWatchdog(): void {
    setTimeout(() => {
      const tbody = document.getElementById('accounts-table-body');
      const stillLoading = tbody && tbody.textContent?.includes('Loading tracked accounts');
      const badge = document.getElementById('refresh-meta-text');
      const badgeStuck = badge && badge.textContent?.includes('Loading sync schedule');
      if ((stillLoading || badgeStuck) && !this.loadingWatchdogFired) {
        this.loadingWatchdogFired = true;
        console.error('[PinArchive] watchdog: loaders did not settle in 30s, forcing error UI');
        if (tbody) {
          tbody.innerHTML = `<tr><td colspan="11" class="p-8 text-center text-xs text-rose-500">
             Failed to load accounts. <button id="retry-load-btn" class="underline font-bold cursor-pointer ml-1">Retry</button>
           </td></tr>`;
        }
        document.getElementById('retry-load-btn')?.addEventListener('click', () => {
          this.loadingWatchdogFired = false;
          if (tbody) tbody.innerHTML = `<tr><td colspan="11" class="p-8 text-center text-xs text-muted-foreground animate-pulse">Loading tracked accounts…</td></tr>`;
          this.loadOverview(2);
          this.armLoadingWatchdog();
        });
        if (badge) badge.textContent = 'Sync schedule unavailable';
      }
    }, 30000);
  }
}
