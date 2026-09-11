import { filterAccounts } from '../filters';
import {
  renderTableHeaderHtml,
  renderAccountsStripHtml,
  renderEmptyAccountsRowHtml,
} from '../table-render';
import {
  getWorkspaceId,
  toggleAccountsIngest,
  updateAccountsInterval,
} from '../api-client';
import { paginateItems, type PaginationResult } from '../../pagination-helper';
import { copyToClipboard, toast } from '../../ui-helpers';
import type { DashboardState } from './state';

export interface AccountsControllerCallbacks {
  onSelectionChanged: () => void;
  onOpenDeleteModal: (ids: string[]) => void;
  onOverviewRefreshNeeded: () => void;
}

export class AccountsController {
  private state: DashboardState;
  private callbacks: AccountsControllerCallbacks;
  private delegatedListenersAttached = false;
  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(state: DashboardState, callbacks: AccountsControllerCallbacks) {
    this.state = state;
    this.callbacks = callbacks;
  }

  public init(): void {
    this.setupStatusTabs();
    this.setupSearchAndIntervalFilters();
    this.setupPaginationButtons();
    this.setupKeyboardShortcuts();
  }

  public filterAndRenderAccounts(resetPage = false): void {
    if (resetPage) {
      this.state.accountsCurrentPage = 1;
    }
    const filtered = filterAccounts(this.state.rawAccounts, {
      activeStatusTab: this.state.activeStatusTab,
      selectedInterval: this.state.selectedInterval,
      accountSearchTerm: this.state.accountSearchTerm,
    });

    this.state.currentFilteredAccounts = filtered;
    const paginated = paginateItems(filtered, this.state.accountsCurrentPage, this.state.pageSize);
    this.state.accountsCurrentPage = paginated.currentPage;
    this.state.currentPagedAccounts = paginated.pagedItems;

    this.renderAccountsStrip(paginated.pagedItems, paginated);
    this.updateAccountsPaginationUI(paginated);
  }

  public renderTableHeader(): void {
    const thead = document.querySelector('#pinarchive-accounts-table thead');
    if (!thead) return;

    thead.innerHTML = renderTableHeaderHtml(this.state.colVisible);

    document.getElementById('select-all-accounts-cb')?.addEventListener('change', (e) => {
      const checked = (e.target as HTMLInputElement).checked;
      this.state.currentPagedAccounts.forEach((acc: any) => {
        if (checked) {
          this.state.selectedAccounts.add(acc.id);
        } else {
          this.state.selectedAccounts.delete(acc.id);
        }
      });
      const inputs = document.querySelectorAll<HTMLInputElement>('#accounts-table-body input[data-acc-select]');
      inputs.forEach((cb) => {
        cb.checked = checked;
      });
      this.callbacks.onSelectionChanged();
    });
  }

  public renderAccountsStrip(accounts: any[], paginated?: PaginationResult<any>): void {
    const tbody = document.getElementById('accounts-table-body');
    const stripCount = document.getElementById('accounts-strip-count');
    const total = paginated
      ? paginated.totalItems
      : this.state.currentFilteredAccounts.length || accounts.length;
    if (stripCount) stripCount.textContent = `${total} ${total === 1 ? 'Account' : 'Accounts'}`;

    if (!tbody) return;

    if (accounts.length === 0) {
      tbody.innerHTML = renderEmptyAccountsRowHtml(this.state.rawAccounts.length > 0);
      return;
    }

    tbody.innerHTML = renderAccountsStripHtml(accounts, {
      colVisible: this.state.colVisible,
      selectedAccounts: this.state.selectedAccounts,
      isCompactDensity: this.state.isCompactDensity,
      isCompactNumbers: this.state.isCompactNumbers,
      competitorMap: this.state.competitorMap,
    });

    this.setupDelegatedTableListeners();
  }

  public updateAccountsPaginationUI(paginated: PaginationResult<any>): void {
    const pageStartEl = document.getElementById('accounts-page-start');
    const pageEndEl = document.getElementById('accounts-page-end');
    const totalCountEl = document.getElementById('accounts-total-count');
    const currentPageEl = document.getElementById('accounts-current-page');
    const totalPagesEl = document.getElementById('accounts-total-pages');
    const prevBtn = document.getElementById('accounts-prev-page-btn') as HTMLButtonElement | null;
    const nextBtn = document.getElementById('accounts-next-page-btn') as HTMLButtonElement | null;

    if (pageStartEl) pageStartEl.textContent = String(paginated.pageStart);
    if (pageEndEl) pageEndEl.textContent = String(paginated.pageEnd);
    if (totalCountEl) totalCountEl.textContent = String(paginated.totalItems);
    if (currentPageEl) currentPageEl.textContent = String(paginated.currentPage);
    if (totalPagesEl) totalPagesEl.textContent = String(paginated.totalPages);

    if (prevBtn) prevBtn.disabled = !paginated.hasPrev;
    if (nextBtn) nextBtn.disabled = !paginated.hasNext;

    this.callbacks.onSelectionChanged();
  }

  public setupDelegatedTableListeners(): void {
    if (this.delegatedListenersAttached) return;
    const tbody = document.getElementById('accounts-table-body');
    if (!tbody) return;

    tbody.addEventListener('change', (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      if (target.matches('input[data-acc-select]')) {
        const cb = target as HTMLInputElement;
        const id = cb.getAttribute('data-acc-select');
        if (!id) return;
        if (cb.checked) this.state.selectedAccounts.add(id);
        else this.state.selectedAccounts.delete(id);
        this.callbacks.onSelectionChanged();
        return;
      }

      if (target.matches('.interval-select')) {
        this.handleIntervalChange(target as HTMLSelectElement);
        return;
      }

      if (target.matches('input[data-acc-ingest-toggle]')) {
        this.handleIngestSwitchToggle(target as HTMLInputElement);
        return;
      }
    });

    tbody.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      const toggleBtn = target.closest<HTMLElement>('[data-acc-status-toggle]');
      if (toggleBtn) {
        e.stopPropagation();
        this.handleAccountStatusToggle(toggleBtn);
        return;
      }

      const copyBtn = target.closest<HTMLElement>('[data-pa-copy-handle]');
      if (copyBtn) {
        e.stopPropagation();
        const handle = copyBtn.getAttribute('data-pa-copy-handle') || copyBtn.dataset.paCopyHandle;
        if (handle) copyToClipboard(handle, copyBtn);
        return;
      }

      const compBtn = target.closest<HTMLButtonElement>('[data-send-to-comp-user]');
      if (compBtn) {
        e.stopPropagation();
        this.handleSendToCompetitor(compBtn);
        return;
      }

      const delBtn = target.closest<HTMLButtonElement>('[data-single-delete-acc-id]');
      if (delBtn) {
        e.stopPropagation();
        const id = delBtn.getAttribute('data-single-delete-acc-id');
        if (id) this.callbacks.onOpenDeleteModal([id]);
        return;
      }
    });

    this.delegatedListenersAttached = true;
  }

  private async handleAccountStatusToggle(btn: HTMLElement): Promise<void> {
    const id = btn.getAttribute('data-acc-status-toggle');
    const currentStatus = btn.getAttribute('data-current-status');
    if (!id) return;
    const enabled = currentStatus === 'paused';

    btn.style.opacity = '0.4';
    btn.style.pointerEvents = 'none';

    try {
      const wsId = getWorkspaceId();
      await toggleAccountsIngest(wsId, [id], enabled);
      const target = this.state.rawAccounts.find((a) => a.id === id);
      if (target) {
        target.ingest_enabled = enabled;
        target.status = enabled ? 'active' : 'paused';
      }
      toast(`@${target?.username || 'Account'} is now ${enabled ? 'active' : 'paused'}`);
      this.filterAndRenderAccounts(false);
    } catch (e: any) {
      if (String(e.message || '').includes('403')) {
        toast('Admin access required to toggle account ingestion.', 'error');
      } else {
        toast(e.message || 'Error updating account status', 'error');
      }
    } finally {
      btn.style.opacity = '1';
      btn.style.pointerEvents = 'auto';
    }
  }

  private async handleIngestSwitchToggle(cb: HTMLInputElement): Promise<void> {
    const id = cb.getAttribute('data-acc-ingest-toggle');
    if (!id) return;
    const enabled = cb.checked;
    cb.disabled = true;

    try {
      const wsId = getWorkspaceId();
      await toggleAccountsIngest(wsId, [id], enabled);
      const target = this.state.rawAccounts.find((a) => a.id === id);
      if (target) {
        target.ingest_enabled = enabled;
        target.status = enabled ? 'active' : 'paused';
      }
      toast(`@${target?.username || 'Account'} is now ${enabled ? 'active' : 'paused'}`);
      this.filterAndRenderAccounts(false);
    } catch (e: any) {
      cb.checked = !enabled;
      if (String(e.message || '').includes('403')) {
        toast('Admin access required to toggle account ingestion.', 'error');
      } else {
        toast(e.message || 'Error updating account status', 'error');
      }
    } finally {
      cb.disabled = false;
    }
  }

  private async handleIntervalChange(sel: HTMLSelectElement): Promise<void> {
    const username = sel.getAttribute('data-username');
    const accountId = sel.getAttribute('data-account-id');
    const prevDays = sel.getAttribute('data-prev-days');
    const newDays = parseInt(sel.value, 10);
    if (!newDays) return;

    sel.disabled = true;
    try {
      const wsId = getWorkspaceId();
      const json = await updateAccountsInterval(wsId, {
        account_id: accountId || undefined,
        username: username || undefined,
        interval_days: newDays,
      });
      sel.setAttribute('data-prev-days', String(newDays));
      const target = this.state.rawAccounts.find(
        (a) => (accountId && a.id === accountId) || (username && a.username === username)
      );
      if (target) {
        target.interval_days = newDays;
        if (json.next_run_dates && (json.next_run_dates[target.id] || json.next_run_dates[target.username])) {
          target.next_run_at = json.next_run_dates[target.id] || json.next_run_dates[target.username];
        }
      }
      toast(`Discovery interval for @${username || 'account'} set to ${newDays}d`);
      this.filterAndRenderAccounts(false);
    } catch (e: any) {
      sel.value = prevDays || '3';
      toast(e.message || 'Error updating interval', 'error');
    } finally {
      sel.disabled = false;
    }
  }

  private async handleSendToCompetitor(btn: HTMLButtonElement): Promise<void> {
    const username = btn.getAttribute('data-send-to-comp-user');
    if (!username) return;

    const confirmed = confirm(`Track @${username} in Competitor Intelligence?`);
    if (!confirmed) return;

    const root = document.getElementById('pinarchive-page-root');
    const wsId = root?.getAttribute('data-workspace-id');

    btn.disabled = true;
    try {
      const res = await fetch('/api/admin/competitors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: wsId,
          username,
          account_type: 'competitor',
        }),
      });
      const json = await res.json();
      if (res.ok && json.success) {
        toast(`Sent @${username} to Competitor Intelligence & dispatched scraper!`);
        const compId = json.competitor?.id || json.competitors?.[0]?.id;
        fetch('/api/admin/competitor-ops', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'dispatch',
            workspace_id: wsId,
            competitor_id: compId || undefined,
            target_username: username,
            trigger: 'pinarchive_send',
            force: true,
          }),
        }).catch(console.warn);

        this.callbacks.onOverviewRefreshNeeded();
      } else {
        toast(json.error || 'Failed to send account to Competitor Intelligence', 'error');
      }
    } catch (err: any) {
      toast(err.message || 'Network error', 'error');
    } finally {
      btn.disabled = false;
    }
  }

  private setupStatusTabs(): void {
    const statusTabBtns = document.querySelectorAll<HTMLButtonElement>('.pa-status-tab-btn');
    const syncStatusTabClasses = () => {
      statusTabBtns.forEach((b) => {
        const tabKey = b.dataset.statusTab || 'all';
        const active = tabKey === this.state.activeStatusTab;
        b.className = active
          ? 'pa-status-tab-btn rounded-lg px-3 py-1.5 text-xs font-semibold bg-background text-foreground shadow-2xs transition-all whitespace-nowrap'
          : 'pa-status-tab-btn rounded-lg px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground transition-all whitespace-nowrap';
      });
    };

    statusTabBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        this.state.activeStatusTab = (btn.dataset.statusTab as any) || 'all';
        syncStatusTabClasses();
        this.filterAndRenderAccounts(true);
      });
    });
  }

  private setupSearchAndIntervalFilters(): void {
    const searchInput = document.getElementById('account-search-input') as HTMLInputElement | null;
    const searchClearBtn = document.getElementById('pa-search-clear-btn');
    const intervalFilterSelect = document.getElementById('pa-interval-filter') as HTMLSelectElement | null;

    searchInput?.addEventListener('input', () => {
      const val = searchInput.value.trim();
      if (val) searchClearBtn?.classList.remove('hidden');
      else searchClearBtn?.classList.add('hidden');

      if (this.searchDebounceTimer) clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = setTimeout(() => {
        this.state.accountSearchTerm = val;
        this.filterAndRenderAccounts(true);
      }, 250);
    });

    searchClearBtn?.addEventListener('click', () => {
      if (this.searchDebounceTimer) clearTimeout(this.searchDebounceTimer);
      if (searchInput) searchInput.value = '';
      this.state.accountSearchTerm = '';
      searchClearBtn?.classList.add('hidden');
      this.filterAndRenderAccounts(true);
    });

    intervalFilterSelect?.addEventListener('change', () => {
      this.state.selectedInterval = intervalFilterSelect.value;
      this.filterAndRenderAccounts(true);
    });
  }

  private setupPaginationButtons(): void {
    document.getElementById('accounts-prev-page-btn')?.addEventListener('click', () => {
      if (this.state.accountsCurrentPage > 1) {
        this.state.accountsCurrentPage--;
        this.filterAndRenderAccounts(false);
      }
    });

    document.getElementById('accounts-next-page-btn')?.addEventListener('click', () => {
      const totalPages = Math.max(1, Math.ceil(this.state.currentFilteredAccounts.length / this.state.pageSize));
      if (this.state.accountsCurrentPage < totalPages) {
        this.state.accountsCurrentPage++;
        this.filterAndRenderAccounts(false);
      }
    });
  }

  private setupKeyboardShortcuts(): void {
    const searchInput = document.getElementById('account-search-input') as HTMLInputElement | null;
    document.addEventListener('keydown', (e) => {
      if (
        e.key === '/' &&
        document.activeElement !== searchInput &&
        !(document.activeElement instanceof HTMLInputElement) &&
        !(document.activeElement instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        searchInput?.focus();
        searchInput?.select();
      }
    });
  }
}
