import {
  fetchSettings,
  saveSettings as saveSettingsApi,
  reevaluateCandidates as reevaluateCandidatesApi,
} from '../api-client';
import { fmtNumberFull } from '../format';
import { toast } from '../../ui-helpers';
import type { DashboardState } from './state';

export interface SettingsControllerCallbacks {
  onOverviewRefreshNeeded: () => void;
}

export class SettingsController {
  private state: DashboardState;
  private callbacks: SettingsControllerCallbacks;

  constructor(state: DashboardState, callbacks: SettingsControllerCallbacks) {
    this.state = state;
    this.callbacks = callbacks;
  }

  public init(): void {
    this.setupLogicBarListeners();
    this.setupToggleSwitchListeners();
    this.setupReevaluateButton();
    this.setupSaveButton();
    this.loadSettings();
  }

  public updateCostEstimate(): void {
    const transparencyEl = document.getElementById('transparency-cost-estimate');
    if (!transparencyEl) return;
    const accCount = this.state.rawAccounts.length;
    const stopPagesInp = document.getElementById('setting-discovery-stop-pages') as HTMLInputElement | null;
    const stopPages = parseInt(stopPagesInp?.value || '3', 10) || 3;
    const pagesPerDay = accCount * stopPages;
    const candidatesPerDay = pagesPerDay * 50;
    transparencyEl.textContent = `≈ ${fmtNumberFull(pagesPerDay)} pages/day, ≈ ${fmtNumberFull(candidatesPerDay)} pins/day (${accCount} accounts × ${stopPages} pages)`;
  }

  public async loadSettings(retries = 1): Promise<void> {
    try {
      const json = await fetchSettings();
      if (!json.success) return;

      const ingestCb = document.getElementById('setting-ingest-enabled') as HTMLInputElement | null;
      const ingestLabel = document.getElementById('setting-ingest-label');
      const policySel = document.getElementById('setting-paused-policy') as HTMLSelectElement | null;
      const maxBatchInp = document.getElementById('setting-max-batch') as HTMLInputElement | null;
      const minSavesInp = document.getElementById('setting-min-saves') as HTMLInputElement | null;
      const minRepinsInp = document.getElementById('setting-min-repins') as HTMLInputElement | null;
      const risingAgeInp = document.getElementById('setting-rising-age') as HTMLInputElement | null;
      const risingSavesInp = document.getElementById('setting-rising-saves') as HTMLInputElement | null;
      const refreshMaxPinsInp = document.getElementById('setting-refresh-max-pins') as HTMLInputElement | null;
      const discoveryMaxInp = document.getElementById('setting-discovery-max-pages') as HTMLInputElement | null;
      const discoveryStopInp = document.getElementById('setting-discovery-stop-pages') as HTMLInputElement | null;
      const auditSweepCb = document.getElementById('setting-audit-sweep-enabled') as HTMLInputElement | null;
      const auditSweepLabel = document.getElementById('setting-audit-sweep-label');
      const dailySheetSyncCb = document.getElementById('setting-daily-sheet-sync') as HTMLInputElement | null;
      const dailySheetSyncLabel = document.getElementById('setting-daily-sheet-sync-label');
      const summaryBadge = document.getElementById('settings-summary-badge');

      if (ingestCb) {
        ingestCb.checked = Boolean(json.ingest_enabled);
        if (ingestLabel) {
          ingestLabel.textContent = ingestCb.checked ? 'Active' : 'Disabled';
          ingestLabel.className = `text-[11px] font-bold ${ingestCb.checked ? 'text-emerald-500' : 'text-rose-500'}`;
        }
        if (summaryBadge) {
          summaryBadge.textContent = ingestCb.checked ? '🟢 Ingest Active' : '🔴 Ingest Paused';
          summaryBadge.className = `text-[10px] font-bold px-2 py-0.2 rounded-full border ${
            ingestCb.checked
              ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
              : 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20'
          }`;
        }
      }
      if (policySel) policySel.value = json.paused_account_policy || 'reject';
      if (maxBatchInp) maxBatchInp.value = String(json.max_batch_pins || 500);
      if (minSavesInp) minSavesInp.value = String(json.pin_filter_min_saves ?? 0);
      if (minRepinsInp) minRepinsInp.value = String(json.pin_filter_min_repins ?? 0);
      if (risingAgeInp) risingAgeInp.value = String(json.pin_filter_rising_age_days ?? 14);
      if (risingSavesInp) risingSavesInp.value = String(json.pin_filter_rising_saves ?? 34);
      if (refreshMaxPinsInp) refreshMaxPinsInp.value = String(json.refresh_max_pins ?? 0);
      const refreshMinSavesInp = document.getElementById('setting-refresh-min-saves') as HTMLInputElement | null;
      if (refreshMinSavesInp) refreshMinSavesInp.value = String(json.refresh_min_saves ?? 0);
      if (discoveryMaxInp) discoveryMaxInp.value = String(json.discovery_max_pages ?? 500);
      if (discoveryStopInp) discoveryStopInp.value = String(json.discovery_stop_pages ?? 3);
      if (auditSweepCb) {
        auditSweepCb.checked = json.audit_sweep_enabled !== false;
        if (auditSweepLabel) {
          auditSweepLabel.textContent = auditSweepCb.checked ? 'Active' : 'Off';
          auditSweepLabel.className = `text-xs font-bold ${auditSweepCb.checked ? 'text-emerald-500' : 'text-muted-foreground'}`;
        }
      }

      const githubScheduleCb = document.getElementById('setting-github-schedule') as HTMLInputElement | null;
      const githubScheduleLabel = document.getElementById('setting-github-schedule-label');
      const ghStatusDot = document.getElementById('pipeline-gh-status-dot');
      const ghStatusText = document.getElementById('pipeline-gh-status-text');

      if (githubScheduleCb) {
        githubScheduleCb.checked = json.github_schedule_enabled !== false;
        if (githubScheduleLabel) {
          githubScheduleLabel.textContent = githubScheduleCb.checked ? 'Active' : 'Off';
          githubScheduleLabel.className = `text-xs font-bold ${githubScheduleCb.checked ? 'text-emerald-500' : 'text-muted-foreground'}`;
        }
        if (ghStatusDot && ghStatusText) {
          if (githubScheduleCb.checked) {
            ghStatusDot.className = 'h-1.5 w-1.5 rounded-full bg-primary';
            ghStatusText.innerHTML = 'Daily Pipeline: <strong class="text-foreground">Daily @ 07:00 UTC</strong>';
          } else {
            ghStatusDot.className = 'h-1.5 w-1.5 rounded-full bg-amber-500';
            ghStatusText.innerHTML = 'Daily Pipeline: <strong class="text-amber-500">07:00 UTC (Off · FastCron Only)</strong>';
          }
        }
      }

      if (dailySheetSyncCb) {
        dailySheetSyncCb.checked = Boolean(json.daily_sheet_sync_enabled);
        if (dailySheetSyncLabel) {
          dailySheetSyncLabel.textContent = dailySheetSyncCb.checked ? 'Active' : 'Off';
          dailySheetSyncLabel.className = `text-xs font-bold ${dailySheetSyncCb.checked ? 'text-emerald-500' : 'text-muted-foreground'}`;
        }
      }

      this.updateCostEstimate();
      this.updateLogicBar();
    } catch (e: any) {
      if (
        String(e?.message || '').includes('401') ||
        String(e?.message || '').includes('403') ||
        String(e?.message || '').toLowerCase().includes('admin')
      ) {
        this.state.canAdminSettings = false;
        this.disableSettingsForm();
        return;
      }
      if (retries > 0) {
        setTimeout(() => this.loadSettings(retries - 1), 1500);
        return;
      }
      console.error('Failed to load settings:', e);
    }
  }

  public updateLogicBar(): void {
    const minSaves = parseInt((document.getElementById('setting-min-saves') as HTMLInputElement)?.value || '0', 10);
    const minRepins = parseInt((document.getElementById('setting-min-repins') as HTMLInputElement)?.value || '0', 10);
    const risingAge = parseInt((document.getElementById('setting-rising-age') as HTMLInputElement)?.value || '14', 10);
    const risingSaves = parseInt((document.getElementById('setting-rising-saves') as HTMLInputElement)?.value || '20', 10);
    const logicBar = document.getElementById('pinarchive-logic-bar');
    if (!logicBar) return;

    const parts = [];
    if (minSaves > 0) parts.push(`≥${minSaves} saves`);
    if (minRepins > 0) parts.push(`≥${minRepins} repins`);
    if (risingAge > 0 && risingSaves > 0) parts.push(`<${risingAge}d & ≥${risingSaves} saves`);

    const summaryStr = parts.length > 0 ? parts.join(' OR ') : 'Active rules';
    const descEl = logicBar.querySelector('p');
    if (descEl) {
      descEl.innerHTML = `<strong class="text-primary font-bold">OR Condition Active (${summaryStr}):</strong> Any pin matching <span class="underline decoration-primary/50 underline-offset-2 font-bold">ANY single rule above</span> will be automatically preserved, ranked, and synced to Supabase &amp; Google Sheets.`;
    }
  }

  public setupLogicBarListeners(): void {
    const inputs = document.querySelectorAll(
      '#setting-min-saves, #setting-min-repins, #setting-rising-age, #setting-rising-saves'
    );
    inputs.forEach((el) => {
      el.addEventListener('input', () => this.updateLogicBar());
    });
  }

  public setupToggleSwitchListeners(): void {
    const auditSweepCb = document.getElementById('setting-audit-sweep-enabled') as HTMLInputElement | null;
    const auditSweepLabel = document.getElementById('setting-audit-sweep-label');
    auditSweepCb?.addEventListener('change', () => {
      if (auditSweepLabel) {
        auditSweepLabel.textContent = auditSweepCb.checked ? 'Active' : 'Off';
        auditSweepLabel.className = `text-xs font-bold ${auditSweepCb.checked ? 'text-emerald-500' : 'text-muted-foreground'}`;
      }
    });

    const githubScheduleCb = document.getElementById('setting-github-schedule') as HTMLInputElement | null;
    const githubScheduleLabel = document.getElementById('setting-github-schedule-label');
    const ghStatusDot = document.getElementById('pipeline-gh-status-dot');
    const ghStatusText = document.getElementById('pipeline-gh-status-text');
    githubScheduleCb?.addEventListener('change', () => {
      if (githubScheduleLabel) {
        githubScheduleLabel.textContent = githubScheduleCb.checked ? 'Active' : 'Off';
        githubScheduleLabel.className = `text-xs font-bold ${githubScheduleCb.checked ? 'text-emerald-500' : 'text-muted-foreground'}`;
      }
      if (ghStatusDot && ghStatusText) {
        if (githubScheduleCb.checked) {
          ghStatusDot.className = 'h-2 w-2 rounded-full bg-primary';
          ghStatusText.textContent = 'Daily @ 07:00 UTC';
        } else {
          ghStatusDot.className = 'h-2 w-2 rounded-full bg-amber-500';
          ghStatusText.textContent = 'Off (FastCron Only)';
        }
      }
    });

    const dailySheetSyncCb = document.getElementById('setting-daily-sheet-sync') as HTMLInputElement | null;
    const dailySheetSyncLabel = document.getElementById('setting-daily-sheet-sync-label');
    dailySheetSyncCb?.addEventListener('change', () => {
      if (dailySheetSyncLabel) {
        dailySheetSyncLabel.textContent = dailySheetSyncCb.checked ? 'Active' : 'Off';
        dailySheetSyncLabel.className = `text-xs font-bold ${dailySheetSyncCb.checked ? 'text-emerald-500' : 'text-muted-foreground'}`;
      }
    });

    const masterIngestCb = document.getElementById('setting-ingest-enabled') as HTMLInputElement | null;
    const masterIngestLabel = document.getElementById('setting-ingest-label');
    masterIngestCb?.addEventListener('change', () => {
      if (masterIngestLabel) {
        masterIngestLabel.textContent = masterIngestCb.checked ? 'Active' : 'Paused';
        masterIngestLabel.className = `text-[11px] font-bold ${masterIngestCb.checked ? 'text-emerald-500' : 'text-rose-500'}`;
      }
    });
  }

  public disableSettingsForm(): void {
    const saveBtn = document.getElementById('save-ingest-settings-btn') as HTMLButtonElement | null;
    const reevaluateBtn = document.getElementById('reevaluate-candidates-btn') as HTMLButtonElement | null;
    const runAuditSweepBtn = document.getElementById('run-audit-sweep-now-btn') as HTMLButtonElement | null;
    const roleBadge = document.getElementById('settings-role-badge');
    const inputs = document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
      '#setting-ingest-enabled, #setting-paused-policy, #setting-max-batch, #setting-refresh-max-pins, #setting-refresh-min-saves, #setting-min-saves, #setting-min-repins, #setting-rising-age, #setting-rising-saves, #setting-discovery-max-pages, #setting-discovery-stop-pages, #setting-audit-sweep-enabled, #setting-daily-sheet-sync, #setting-github-schedule, #run-audit-sweep-now-btn'
    );
    inputs.forEach((el) => {
      el.disabled = true;
    });
    if (runAuditSweepBtn) {
      runAuditSweepBtn.disabled = true;
      runAuditSweepBtn.classList.add('hidden');
    }
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.classList.add('hidden');
    }
    if (reevaluateBtn) {
      reevaluateBtn.disabled = true;
      reevaluateBtn.classList.add('hidden');
    }
    if (roleBadge) roleBadge.classList.remove('hidden');
  }

  public async saveSettings(): Promise<void> {
    const ingestCb = document.getElementById('setting-ingest-enabled') as HTMLInputElement | null;
    const policySel = document.getElementById('setting-paused-policy') as HTMLSelectElement | null;
    const maxBatchInp = document.getElementById('setting-max-batch') as HTMLInputElement | null;
    const refreshMaxPinsInp = document.getElementById('setting-refresh-max-pins') as HTMLInputElement | null;
    const refreshMinSavesInp = document.getElementById('setting-refresh-min-saves') as HTMLInputElement | null;
    const minSavesInp = document.getElementById('setting-min-saves') as HTMLInputElement | null;
    const minRepinsInp = document.getElementById('setting-min-repins') as HTMLInputElement | null;
    const risingAgeInp = document.getElementById('setting-rising-age') as HTMLInputElement | null;
    const risingSavesInp = document.getElementById('setting-rising-saves') as HTMLInputElement | null;
    const discoveryMaxInp = document.getElementById('setting-discovery-max-pages') as HTMLInputElement | null;
    const discoveryStopInp = document.getElementById('setting-discovery-stop-pages') as HTMLInputElement | null;
    const auditSweepCb = document.getElementById('setting-audit-sweep-enabled') as HTMLInputElement | null;
    const dailySheetSyncCb = document.getElementById('setting-daily-sheet-sync') as HTMLInputElement | null;
    const githubScheduleCb = document.getElementById('setting-github-schedule') as HTMLInputElement | null;
    const statusMsg = document.getElementById('settings-status-msg');
    const saveBtn = document.getElementById('save-ingest-settings-btn') as HTMLButtonElement | null;
    const summaryBadge = document.getElementById('settings-summary-badge');

    if (!ingestCb || !policySel || !maxBatchInp || !minSavesInp || !minRepinsInp || !risingAgeInp || !risingSavesInp) return;

    if (saveBtn) saveBtn.disabled = true;
    if (statusMsg) {
      statusMsg.textContent = 'Saving...';
      statusMsg.className = 'text-xs font-semibold text-muted-foreground';
    }

    try {
      await saveSettingsApi({
        ingest_enabled: ingestCb.checked,
        paused_account_policy: policySel.value,
        max_batch_pins: parseInt(maxBatchInp.value, 10) || 500,
        refresh_max_pins: parseInt(refreshMaxPinsInp?.value || '0', 10) || 0,
        refresh_min_saves: parseInt(refreshMinSavesInp?.value || '0', 10) || 0,
        pin_filter_min_saves: parseInt(minSavesInp.value, 10) || 0,
        pin_filter_min_repins: parseInt(minRepinsInp.value, 10) || 0,
        pin_filter_rising_age_days: Number.isInteger(parseInt(risingAgeInp.value, 10))
          ? parseInt(risingAgeInp.value, 10)
          : 14,
        pin_filter_rising_saves: Number.isInteger(parseInt(risingSavesInp.value, 10))
          ? parseInt(risingSavesInp.value, 10)
          : 34,
        discovery_max_pages: parseInt(discoveryMaxInp?.value || '500', 10) || 500,
        discovery_stop_pages: parseInt(discoveryStopInp?.value || '3', 10) || 3,
        audit_sweep_enabled: auditSweepCb ? auditSweepCb.checked : true,
        daily_sheet_sync_enabled: dailySheetSyncCb ? dailySheetSyncCb.checked : false,
        github_schedule_enabled: githubScheduleCb ? githubScheduleCb.checked : true,
      });

      if (summaryBadge) {
        summaryBadge.textContent = ingestCb.checked ? '🟢 Ingest Active' : '🔴 Ingest Paused';
        summaryBadge.className = `text-[10px] font-bold px-2 py-0.2 rounded-full border ${
          ingestCb.checked
            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
            : 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20'
        }`;
      }

      this.updateCostEstimate();

      if (statusMsg) {
        statusMsg.textContent = 'Settings saved!';
        statusMsg.className = 'text-xs font-semibold text-emerald-500';
        setTimeout(() => {
          if (statusMsg) statusMsg.textContent = '';
        }, 3000);
      }
    } catch (e: any) {
      if (String(e.message || '').includes('403') || String(e.message || '').toLowerCase().includes('admin')) {
        this.state.canAdminSettings = false;
        this.disableSettingsForm();
        if (statusMsg) {
          statusMsg.textContent = 'Forbidden: Admin access required.';
          statusMsg.className = 'text-xs font-semibold text-rose-500';
        }
        return;
      }
      if (statusMsg) {
        statusMsg.textContent = e.message || 'Save failed';
        statusMsg.className = 'text-xs font-semibold text-rose-500';
      }
    } finally {
      if (saveBtn && this.state.canAdminSettings) saveBtn.disabled = false;
    }
  }

  public setupSaveButton(): void {
    document.getElementById('save-ingest-settings-btn')?.addEventListener('click', () => {
      this.saveSettings();
    });
  }

  public setupReevaluateButton(): void {
    const btn = document.getElementById('reevaluate-candidates-btn') as HTMLButtonElement | null;
    const icon = document.getElementById('reevaluate-icon');
    const text = document.getElementById('reevaluate-btn-text');
    if (!btn) return;

    btn.addEventListener('click', async () => {
      const root = document.getElementById('pinarchive-page-root');
      const workspaceId = root?.getAttribute('data-workspace-id') || '';
      if (!workspaceId) {
        toast('Workspace identifier missing', 'error');
        return;
      }

      const confirmed = confirm(
        'Re-evaluate Candidate Pins?\n\nThis will scan all candidate pins against the active qualification rules (saves, repins, velocity) and synchronize qualified pins to Google Sheets. Do you want to proceed?'
      );
      if (!confirmed) return;

      btn.disabled = true;
      if (icon) icon.classList.add('animate-spin');
      if (text) text.textContent = 'Re-evaluating...';

      try {
        const json = await reevaluateCandidatesApi(workspaceId);
        const synced = json.sheet_synced ?? 0;
        const promoted = json.promoted ?? 0;
        toast(`Re-evaluation complete! (${synced} synced from Sheet, ${promoted} promoted)`, 'success');
        this.callbacks.onOverviewRefreshNeeded();
      } catch (err: any) {
        if (String(err?.message || '').includes('401') || String(err?.message || '').includes('403')) {
          toast('Admin access required to trigger re-evaluation', 'error');
        } else {
          toast(err?.message || 'Network error triggering re-evaluation', 'error');
        }
      } finally {
        if (icon) icon.classList.remove('animate-spin');
        if (text) text.textContent = 'Re-evaluate Candidates';
        btn.disabled = false;
      }
    });
  }
}
