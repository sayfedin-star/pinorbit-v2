import { getWorkspaceId } from '../api-client';
import {
  executeBulkPause,
  executeBulkResume,
  executeBulkInterval,
  executeBulkDelete,
  executeBulkDiscovery,
  executeBulkAuditSweep,
  executeBulkSheetSync,
  executeBulkRefresh,
  executeBulkSendToCompetitors,
} from '../bulk-actions';
import { toast } from '../../ui-helpers';
import type { DashboardState } from './state';

export interface BulkControllerCallbacks {
  onAccountsFilterRender: (resetPage?: boolean) => void;
  onOverviewRefreshNeeded: () => void;
}

export class BulkController {
  private state: DashboardState;
  private callbacks: BulkControllerCallbacks;
  private pendingDeleteIds: string[] = [];

  constructor(state: DashboardState, callbacks: BulkControllerCallbacks) {
    this.state = state;
    this.callbacks = callbacks;
  }

  public init(): void {
    this.setupBulkActionButtons();
    this.setupTabSwitching();
  }

  public syncSelectAllCheckbox(): void {
    const selectAllCb = document.getElementById('select-all-accounts-cb') as HTMLInputElement | null;
    if (!selectAllCb) return;
    if (this.state.currentPagedAccounts.length === 0) {
      selectAllCb.checked = false;
      selectAllCb.indeterminate = false;
      return;
    }
    const pageSelectedCount = this.state.currentPagedAccounts.filter((a: any) =>
      this.state.selectedAccounts.has(a.id)
    ).length;
    selectAllCb.checked = pageSelectedCount === this.state.currentPagedAccounts.length;
    selectAllCb.indeterminate = pageSelectedCount > 0 && pageSelectedCount < this.state.currentPagedAccounts.length;
  }

  public updateSelectedAccountsUI(): void {
    const actionBar = document.getElementById('accounts-action-bar');
    const selectedLabel = document.getElementById('accounts-selected-label');
    const count = this.state.selectedAccounts.size;

    if (count > 0) {
      if (actionBar) {
        actionBar.classList.remove('hidden');
        actionBar.classList.add('flex');
      }
      if (selectedLabel) selectedLabel.textContent = `${count} selected`;
    } else {
      if (actionBar) {
        actionBar.classList.add('hidden');
        actionBar.classList.remove('flex');
      }
    }
  }

  public openDeleteAccountsModal(ids: string[]): void {
    this.pendingDeleteIds = ids;
    const modal = document.getElementById('delete-accounts-modal');
    const input = document.getElementById('delete-confirm-input') as HTMLInputElement | null;
    const confirmBtn = document.getElementById('confirm-delete-modal-btn') as HTMLButtonElement | null;
    if (!modal) return;

    if (input) input.value = '';
    if (confirmBtn) confirmBtn.disabled = true;

    modal.classList.remove('hidden');
    if (input) input.focus();
  }

  public closeDeleteAccountsModal(): void {
    const modal = document.getElementById('delete-accounts-modal');
    if (modal) modal.classList.add('hidden');
    this.pendingDeleteIds = [];
  }

  public setupBulkActionButtons(): void {
    document.getElementById('clear-account-selection-btn')?.addEventListener('click', () => {
      this.state.selectedAccounts.clear();
      document
        .querySelectorAll<HTMLInputElement>('input[data-acc-select]')
        .forEach((cb) => {
          cb.checked = false;
        });
      const selectAll = document.getElementById('select-all-accounts-cb') as HTMLInputElement | null;
      if (selectAll) selectAll.checked = false;
      this.updateSelectedAccountsUI();
    });

    document.getElementById('delete-selected-accounts-btn')?.addEventListener('click', () => {
      if (this.state.selectedAccounts.size === 0) return;
      this.openDeleteAccountsModal(Array.from(this.state.selectedAccounts));
    });

    // Bulk Interval Change Listener
    const bulkIntervalSelect = document.getElementById('bulk-interval-select') as HTMLSelectElement | null;
    bulkIntervalSelect?.addEventListener('change', async () => {
      const newDays = parseInt(bulkIntervalSelect.value, 10);
      if (!newDays || this.state.selectedAccounts.size === 0) return;
      const count = this.state.selectedAccounts.size;
      const confirmed = confirm(
        `Change scrape interval to ${newDays} day(s) for ${count} selected account(s)?`
      );
      if (!confirmed) {
        bulkIntervalSelect.value = '';
        return;
      }

      bulkIntervalSelect.disabled = true;
      try {
        const wsId = getWorkspaceId();
        await executeBulkInterval(wsId, Array.from(this.state.selectedAccounts), newDays);
        toast(`Discovery interval set to ${newDays}d for ${count} account(s)!`);
        this.state.rawAccounts.forEach((a) => {
          if (this.state.selectedAccounts.has(a.id)) {
            a.interval_days = newDays;
          }
        });
        this.callbacks.onAccountsFilterRender();
      } catch (err: any) {
        toast(err.message || 'Failed to update interval', 'error');
      } finally {
        bulkIntervalSelect.disabled = false;
        bulkIntervalSelect.value = '';
      }
    });

    document.getElementById('gas-bulk-run-btn')?.addEventListener('click', async () => {
      if (this.state.selectedAccounts.size === 0) return;
      const wsId = getWorkspaceId();
      if (!wsId) {
        toast('Workspace identifier not found', 'error');
        return;
      }

      const selectedUsernames = this.state.rawAccounts
        .filter((a) => this.state.selectedAccounts.has(a.id))
        .map((a) => a.username)
        .filter(Boolean);

      if (selectedUsernames.length === 0) {
        toast('No valid accounts selected', 'error');
        return;
      }

      const confirmed = confirm(
        `Run Pin Discovery on Pinterest for ${selectedUsernames.length} selected account(s)?`
      );
      if (!confirmed) return;

      const btn = document.getElementById('gas-bulk-run-btn') as HTMLButtonElement | null;
      const originalText = btn?.innerHTML || '<span>🧠 Discover Pins</span>';
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<span>⏳ Dispatching…</span>`;
      }

      try {
        const json = await executeBulkDiscovery(wsId, selectedUsernames);
        const failed = (json.results || []).filter((r: any) => !r.ok);
        if (failed.length > 0) {
          toast(`Discovery queued with warnings: ${failed[0]?.error || 'partial error'}`, 'error');
        } else {
          toast(`🧠 Discovery pipeline dispatched for @${selectedUsernames.join(', @')}!`);
        }
        setTimeout(() => this.callbacks.onOverviewRefreshNeeded(), 2000);
      } catch (err: any) {
        toast(err.message || 'Failed to dispatch discovery pipeline', 'error');
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = originalText;
        }
      }
    });

    document.getElementById('audit-sweep-selected-btn')?.addEventListener('click', async () => {
      if (this.state.selectedAccounts.size === 0) return;
      const wsId = getWorkspaceId();
      if (!wsId) {
        toast('Workspace identifier not found', 'error');
        return;
      }

      const selectedUsernames = this.state.rawAccounts
        .filter((a) => this.state.selectedAccounts.has(a.id))
        .map((a) => a.username)
        .filter(Boolean);

      if (selectedUsernames.length === 0) {
        toast('No valid accounts selected', 'error');
        return;
      }

      const confirmed = confirm(
        `Run deep Monthly Audit Sweep for ${selectedUsernames.length} selected account(s)?`
      );
      if (!confirmed) return;

      const btn = document.getElementById('audit-sweep-selected-btn') as HTMLButtonElement | null;
      const originalText = btn?.innerHTML || '<span>🗓️ Audit Sweep Now</span>';
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<span>⏳ Dispatching…</span>`;
      }

      try {
        const json = await executeBulkAuditSweep(wsId, selectedUsernames);
        const failed = (json.results || []).filter((r: any) => !r.ok);
        if (failed.length > 0) {
          toast(`Audit sweep queued with warnings: ${failed[0]?.error || 'partial error'}`, 'error');
        } else {
          toast(`🗓️ Monthly Audit Sweep dispatched for @${selectedUsernames.join(', @')}!`);
        }
        setTimeout(() => this.callbacks.onOverviewRefreshNeeded(), 2000);
      } catch (err: any) {
        toast(err.message || 'Failed to dispatch audit sweep', 'error');
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = originalText;
        }
      }
    });

    document.getElementById('sync-sheet-ages-selected-btn')?.addEventListener('click', async () => {
      const wsId = getWorkspaceId();
      if (!wsId) {
        toast('Workspace identifier not found', 'error');
        return;
      }

      const selectedUsernames = this.state.rawAccounts
        .filter((a) => this.state.selectedAccounts.has(a.id))
        .map((a) => a.username)
        .filter(Boolean);

      const isAll = selectedUsernames.length === 0;
      const confirmMsg = isAll
        ? 'Sync true oldest pin timestamps from Google Sheets for ALL accounts in this workspace?'
        : `Sync true oldest pin timestamps from Google Sheets for ${selectedUsernames.length} selected account(s)?`;

      const confirmed = confirm(confirmMsg);
      if (!confirmed) return;

      const btn = document.getElementById('sync-sheet-ages-selected-btn') as HTMLButtonElement | null;
      const originalText = btn?.innerHTML || '<span>📊 Sync Sheet Ages</span>';
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<span>⏳ Syncing…</span>`;
      }

      try {
        const json = await executeBulkSheetSync(wsId, selectedUsernames);
        const results = json.results || [];
        const updated = results.filter((r: any) => r.ok && r.summary?.oldest_pin_at);
        toast(`📊 Synced oldest pin timestamps for ${updated.length} account(s) from Google Sheets!`);
        setTimeout(() => this.callbacks.onOverviewRefreshNeeded(), 1500);
      } catch (err: any) {
        toast(err.message || 'Failed to sync sheet ages', 'error');
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = originalText;
        }
      }
    });

    document.getElementById('run-audit-sweep-now-btn')?.addEventListener('click', async () => {
      const wsId = getWorkspaceId();
      if (!wsId) {
        toast('Workspace identifier not found', 'error');
        return;
      }

      const confirmed = confirm('Run full workspace Monthly Audit Sweep now for all accounts?');
      if (!confirmed) return;

      const btn = document.getElementById('run-audit-sweep-now-btn') as HTMLButtonElement | null;
      const originalText = btn?.innerHTML || '▶ Run Now';
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '⏳ Dispatching…';
      }

      try {
        const json = await executeBulkAuditSweep(wsId);
        const failed = (json.results || []).filter((r: any) => !r.ok);
        if (failed.length > 0) {
          toast(`Audit sweep queued with warnings: ${failed[0]?.error || 'partial error'}`, 'error');
        } else {
          toast('🗓️ Full workspace Monthly Audit Sweep dispatched!');
        }
        setTimeout(() => this.callbacks.onOverviewRefreshNeeded(), 2000);
      } catch (err: any) {
        toast(err.message || 'Failed to dispatch workspace audit sweep', 'error');
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = originalText;
        }
      }
    });

    document.getElementById('refresh-selected-accounts-btn')?.addEventListener('click', async () => {
      if (this.state.selectedAccounts.size === 0) return;
      const wsId = getWorkspaceId();
      if (!wsId) {
        toast('Workspace identifier not found', 'error');
        return;
      }

      const selectedUsernames = this.state.rawAccounts
        .filter((a) => this.state.selectedAccounts.has(a.id))
        .map((a) => a.username)
        .filter(Boolean);

      if (selectedUsernames.length === 0) {
        toast('No valid accounts selected', 'error');
        return;
      }

      const confirmed = confirm(`Run Fast Metrics Refresh for ${selectedUsernames.length} selected account(s)?`);
      if (!confirmed) return;

      const icon = document.getElementById('refresh-selected-icon');
      const textSpan = document.getElementById('refresh-selected-btn-text');
      const btn = document.getElementById('refresh-selected-accounts-btn') as HTMLButtonElement | null;

      if (icon) icon.classList.add('animate-spin');
      if (textSpan) textSpan.textContent = 'Syncing…';
      if (btn) btn.disabled = true;

      try {
        await executeBulkRefresh(wsId, selectedUsernames);
        toast(`⚡ Fast Refresh dispatched for ${selectedUsernames.length} account(s)!`);
        setTimeout(() => this.callbacks.onOverviewRefreshNeeded(), 2000);
      } catch (err: any) {
        toast(err.message || 'Failed to trigger fast refresh', 'error');
      } finally {
        if (icon) icon.classList.remove('animate-spin');
        if (textSpan) textSpan.textContent = '⚡ Fast Refresh';
        if (btn) btn.disabled = false;
      }
    });

    // Send Selected to Competitor Intelligence
    document.getElementById('send-selected-to-competitors-btn')?.addEventListener('click', async () => {
      if (this.state.selectedAccounts.size === 0) return;
      const count = this.state.selectedAccounts.size;
      const confirmed = confirm(`Send ${count} selected creator account(s) to Competitor Intelligence?`);
      if (!confirmed) return;

      const wsId = getWorkspaceId();
      const selectedUsernames = this.state.rawAccounts
        .filter((a) => this.state.selectedAccounts.has(a.id))
        .map((a) => a.username)
        .filter(Boolean);

      if (selectedUsernames.length === 0) return;

      const btn = document.getElementById('send-selected-to-competitors-btn') as HTMLButtonElement | null;
      if (btn) btn.disabled = true;

      try {
        const json = await executeBulkSendToCompetitors(wsId, selectedUsernames);
        toast(
          `Sent ${json.count || selectedUsernames.length} account(s) to Competitor Intelligence & dispatched scrapers!`
        );
        this.callbacks.onOverviewRefreshNeeded();
      } catch (err: any) {
        toast(err.message || 'Failed to send accounts to Competitor Intelligence', 'error');
      } finally {
        if (btn) btn.disabled = false;
      }
    });

    document.getElementById('gas-bulk-pause-btn')?.addEventListener('click', async () => {
      if (this.state.selectedAccounts.size === 0) return;
      const count = this.state.selectedAccounts.size;
      const confirmed = confirm(`Pause ingestion for ${count} selected account(s)?`);
      if (!confirmed) return;

      try {
        const wsId = getWorkspaceId();
        await executeBulkPause(wsId, Array.from(this.state.selectedAccounts));
        toast(`Paused ingestion for ${count} account(s)`);
        this.state.rawAccounts.forEach((a) => {
          if (this.state.selectedAccounts.has(a.id)) {
            a.ingest_enabled = false;
            a.status = 'paused';
          }
        });
        this.callbacks.onAccountsFilterRender();
      } catch (err: any) {
        toast(err.message || 'Failed to pause accounts', 'error');
      }
    });

    document.getElementById('gas-bulk-resume-btn')?.addEventListener('click', async () => {
      if (this.state.selectedAccounts.size === 0) return;
      const count = this.state.selectedAccounts.size;
      const confirmed = confirm(`Resume ingestion for ${count} selected account(s)?`);
      if (!confirmed) return;

      try {
        const wsId = getWorkspaceId();
        await executeBulkResume(wsId, Array.from(this.state.selectedAccounts));
        toast(`Resumed ingestion for ${count} account(s)`);
        this.state.rawAccounts.forEach((a) => {
          if (this.state.selectedAccounts.has(a.id)) {
            a.ingest_enabled = true;
            a.status = 'active';
          }
        });
        this.callbacks.onAccountsFilterRender();
      } catch (err: any) {
        toast(err.message || 'Failed to resume accounts', 'error');
      }
    });

    // Delete modal inputs
    const confirmInput = document.getElementById('delete-confirm-input') as HTMLInputElement | null;
    const confirmBtn = document.getElementById('confirm-delete-modal-btn') as HTMLButtonElement | null;
    confirmInput?.addEventListener('input', () => {
      if (confirmBtn) confirmBtn.disabled = confirmInput.value.trim().toUpperCase() !== 'DELETE';
    });

    document.getElementById('cancel-delete-modal-btn')?.addEventListener('click', () => {
      this.closeDeleteAccountsModal();
    });

    confirmBtn?.addEventListener('click', async () => {
      if (this.pendingDeleteIds.length === 0) return;
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Deleting…';

      try {
        await executeBulkDelete(this.pendingDeleteIds);
        toast(`Deleted ${this.pendingDeleteIds.length} account(s)`);
        this.closeDeleteAccountsModal();
        this.state.selectedAccounts.clear();
        this.callbacks.onOverviewRefreshNeeded();
      } catch (err: any) {
        toast(err.message || 'Failed to delete accounts', 'error');
      } finally {
        if (confirmBtn) {
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'Delete Accounts';
        }
      }
    });
  }

  public setupTabSwitching(): void {
    const tabAccounts = document.getElementById('pa-tab-btn-accounts');
    const tabAutomation = document.getElementById('pa-tab-btn-automation');
    const viewAccounts = document.getElementById('pa-tab-view-accounts');
    const viewAutomation = document.getElementById('pa-tab-view-automation');

    tabAccounts?.addEventListener('click', () => {
      tabAccounts.className =
        'inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold bg-background text-foreground shadow-2xs transition-all cursor-pointer';
      tabAutomation?.classList.remove('bg-background', 'text-foreground', 'shadow-2xs');
      tabAutomation?.classList.add('text-muted-foreground');
      viewAccounts?.classList.remove('hidden');
      viewAutomation?.classList.add('hidden');
    });

    tabAutomation?.addEventListener('click', () => {
      tabAutomation.className =
        'inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold bg-background text-foreground shadow-2xs transition-all cursor-pointer';
      tabAccounts?.classList.remove('bg-background', 'text-foreground', 'shadow-2xs');
      tabAccounts?.classList.add('text-muted-foreground');
      viewAutomation?.classList.remove('hidden');
      viewAccounts?.classList.add('hidden');
    });
  }
}
