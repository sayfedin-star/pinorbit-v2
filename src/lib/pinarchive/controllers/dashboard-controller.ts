import { createDashboardState, type DashboardState } from './state';
import { StoreController } from './store-controller';
import { OverviewController } from './overview-controller';
import { SettingsController } from './settings-controller';
import { BulkController } from './bulk-controller';
import { AccountsController } from './accounts-controller';
import { cleanPinterestUsername, toast } from '../../ui-helpers';

export class DashboardController {
  public state: DashboardState;
  public storeController: StoreController;
  public overviewController: OverviewController;
  public settingsController: SettingsController;
  public bulkController: BulkController;
  public accountsController: AccountsController;

  constructor() {
    this.state = createDashboardState();

    this.storeController = new StoreController(this.state, {
      onColumnsChanged: () => {
        this.accountsController.renderTableHeader();
        this.accountsController.filterAndRenderAccounts(false);
      },
      onPreferencesChanged: () => {
        this.accountsController.filterAndRenderAccounts(false);
      },
    });

    this.overviewController = new OverviewController(this.state, {
      onAccountsLoaded: () => {
        this.accountsController.renderTableHeader();
        this.accountsController.filterAndRenderAccounts(true);
      },
      onCompetitorsLoaded: () => {
        this.accountsController.renderAccountsStrip(this.state.currentPagedAccounts);
      },
      onCostEstimateUpdate: () => {
        this.settingsController.updateCostEstimate();
      },
    });

    this.settingsController = new SettingsController(this.state, {
      onOverviewRefreshNeeded: () => {
        this.overviewController.loadOverview(1);
      },
    });

    this.bulkController = new BulkController(this.state, {
      onAccountsFilterRender: (resetPage?: boolean) => {
        this.accountsController.filterAndRenderAccounts(resetPage);
      },
      onOverviewRefreshNeeded: () => {
        this.overviewController.loadOverview(1);
      },
    });

    this.accountsController = new AccountsController(this.state, {
      onSelectionChanged: () => {
        this.bulkController.updateSelectedAccountsUI();
        this.bulkController.syncSelectAllCheckbox();
      },
      onOpenDeleteModal: (ids: string[]) => {
        this.bulkController.openDeleteAccountsModal(ids);
      },
      onOverviewRefreshNeeded: () => {
        this.overviewController.loadOverview(1);
      },
    });
  }

  public init(): void {
    console.info('[PinArchive] init start', {
      href: typeof location !== 'undefined' ? location.href : '',
      t: new Date().toISOString(),
    });
    const safe = (name: string, fn: () => void) => {
      try {
        fn();
      } catch (e) {
        console.error(`[PinArchive] init step failed: ${name}`, e);
      }
    };

    safe('storeController.init', () => this.storeController.init());
    safe('settingsController.init', () => this.settingsController.init());
    safe('bulkController.init', () => this.bulkController.init());
    safe('accountsController.init', () => this.accountsController.init());
    safe('overviewController.init', () => this.overviewController.init());
    safe('setupArchitectureGuideModal', () => this.setupArchitectureGuideModal());
    safe('setupAddCreatorModal', () => this.setupAddCreatorModal());
    safe('accountsController.renderTableHeader', () => this.accountsController.renderTableHeader());
    safe('overviewController.loadOverview', () => this.overviewController.loadOverview(2));
  }

  public setupArchitectureGuideModal(): void {
    const modal = document.getElementById('architecture-guide-modal');
    const openBtn = document.getElementById('open-architecture-guide-btn');
    const bannerBtn = document.getElementById('open-architecture-guide-banner-btn');
    const closeBtn = document.getElementById('close-architecture-guide-modal-btn');
    const doneBtn = document.getElementById('done-architecture-guide-modal-btn');
    const backdrop = document.getElementById('architecture-guide-backdrop');

    const tabBtnMaster = document.getElementById('guide-tab-btn-master');
    const tabBtnScheduler = document.getElementById('guide-tab-btn-scheduler');
    const tabBtnMatrix = document.getElementById('guide-tab-btn-matrix');

    const tabViewMaster = document.getElementById('guide-tab-view-master');
    const tabViewScheduler = document.getElementById('guide-tab-view-scheduler');
    const tabViewMatrix = document.getElementById('guide-tab-view-matrix');

    function openModal() {
      modal?.classList.remove('hidden');
      modal?.classList.add('flex');
    }

    function closeModal() {
      modal?.classList.add('hidden');
      modal?.classList.remove('flex');
    }

    openBtn?.addEventListener('click', openModal);
    bannerBtn?.addEventListener('click', openModal);
    closeBtn?.addEventListener('click', closeModal);
    doneBtn?.addEventListener('click', closeModal);
    backdrop?.addEventListener('click', closeModal);

    function switchTab(activeBtn: HTMLElement | null, activeView: HTMLElement | null) {
      [tabBtnMaster, tabBtnScheduler, tabBtnMatrix].forEach((btn) => {
        btn?.classList.remove('bg-background', 'text-foreground', 'shadow-2xs');
        btn?.classList.add('text-muted-foreground');
      });
      [tabViewMaster, tabViewScheduler, tabViewMatrix].forEach((view) => {
        view?.classList.add('hidden');
      });

      activeBtn?.classList.remove('text-muted-foreground');
      activeBtn?.classList.add('bg-background', 'text-foreground', 'shadow-2xs');
      activeView?.classList.remove('hidden');
    }

    tabBtnMaster?.addEventListener('click', () => switchTab(tabBtnMaster, tabViewMaster));
    tabBtnScheduler?.addEventListener('click', () => switchTab(tabBtnScheduler, tabViewScheduler));
    tabBtnMatrix?.addEventListener('click', () => switchTab(tabBtnMatrix, tabViewMatrix));
  }

  public setupAddCreatorModal(): void {
    const modal = document.getElementById('add-creator-modal');
    const openBtn = document.getElementById('open-add-creator-modal');
    const closeBtn = document.getElementById('close-add-creator-modal-btn');
    const cancelBtn = document.getElementById('cancel-add-creator-modal-btn');
    const form = document.getElementById('add-creator-form') as HTMLFormElement | null;
    const usernameInput = document.getElementById('new-creator-username') as HTMLInputElement | null;
    const intervalSelect = document.getElementById('new-creator-interval') as HTMLSelectElement | null;
    const syncCheckbox = document.getElementById('sync-to-competitors-checkbox') as HTMLInputElement | null;
    const runDiscoveryCheckbox = document.getElementById('run-discovery-now-checkbox') as HTMLInputElement | null;
    const errorDiv = document.getElementById('add-creator-error');
    const submitBtn = document.getElementById('submit-add-creator-btn') as HTMLButtonElement | null;

    function openModal() {
      if (form) form.reset();
      if (intervalSelect) intervalSelect.value = '1';
      if (syncCheckbox) syncCheckbox.checked = true;
      if (runDiscoveryCheckbox) runDiscoveryCheckbox.checked = true;
      if (errorDiv) {
        errorDiv.textContent = '';
        errorDiv.classList.add('hidden');
      }
      modal?.classList.remove('hidden');
      modal?.classList.add('flex');
      usernameInput?.focus();
    }

    function closeModal() {
      modal?.classList.add('hidden');
      modal?.classList.remove('flex');
    }

    openBtn?.addEventListener('click', openModal);
    closeBtn?.addEventListener('click', closeModal);
    cancelBtn?.addEventListener('click', closeModal);

    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!usernameInput) return;
      const rawUser = usernameInput.value.trim();
      const cleanUser = cleanPinterestUsername(rawUser);

      if (!cleanUser) {
        if (errorDiv) {
          errorDiv.textContent = 'Please enter a valid Pinterest username or URL.';
          errorDiv.classList.remove('hidden');
        }
        return;
      }

      const root = document.getElementById('pinarchive-page-root');
      const wsId = root?.getAttribute('data-workspace-id');
      const intervalVal = Number(intervalSelect?.value || 1);
      const syncToComp = Boolean(syncCheckbox?.checked);
      const runDiscovery = Boolean(runDiscoveryCheckbox?.checked);

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Tracking…';
      }
      if (errorDiv) errorDiv.classList.add('hidden');

      try {
        // 1. Import into PinArchive
        const paRes = await fetch('/api/pinarchive/accounts-import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspace_id: wsId,
            accounts: [{ username: cleanUser, interval_days: intervalVal }],
            dispatch: false,
          }),
        });
        const paJson = await paRes.json();
        if (!paRes.ok || !paJson.success) {
          throw new Error(paJson.error || 'Failed to add account to PinArchive');
        }

        // 2. Optionally sync to Competitor Intelligence & dispatch immediate scraper
        if (syncToComp) {
          try {
            const compRes = await fetch('/api/admin/competitors', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                workspace_id: wsId,
                username: cleanUser,
                account_type: 'competitor',
              }),
            });
            const compJson = await compRes.json();
            const compId = compJson?.competitor?.id || compJson?.competitors?.[0]?.id;

            // Immediately dispatch Competitor Scraper workflow on GitHub Actions
            fetch('/api/admin/competitor-ops', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'dispatch',
                workspace_id: wsId,
                competitor_id: compId || undefined,
                target_username: cleanUser,
                trigger: 'creator_modal',
                force: true,
              }),
            }).catch(console.warn);
          } catch (compErr) {
            console.warn('Competitor sync/dispatch deferred:', compErr);
          }
        }

        // 3. Optionally dispatch initial Discover Pins immediately
        if (runDiscovery) {
          try {
            await fetch('/api/pinarchive/accounts-gas', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'run_now',
                workspace_id: wsId,
                usernames: [cleanUser],
              }),
            });
          } catch (gasErr) {
            console.warn('Discover pins immediate dispatch deferred:', gasErr);
          }
        }

        const toastDetails = [
          'PinArchive added',
          runDiscovery ? 'Discover Pins dispatched' : null,
          syncToComp ? 'Competitor Scraper dispatched' : null,
        ]
          .filter(Boolean)
          .join(' • ');

        toast(`Started tracking @${cleanUser}! (${toastDetails})`);
        closeModal();
        this.overviewController.loadOverview(1);
      } catch (err: any) {
        if (errorDiv) {
          errorDiv.textContent = err.message || 'Error tracking creator';
          errorDiv.classList.remove('hidden');
        }
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.innerHTML = '<span>+ Track Creator</span>';
        }
      }
    });
  }
}

let activeDashboardInstance: DashboardController | null = null;

export function initPinArchiveDashboard(): DashboardController | null {
  if (typeof document === 'undefined') return null;
  const runInit = (): DashboardController | null => {
    const root = document.getElementById('pinarchive-page-root');
    if (!root) return null;

    if (root.getAttribute('data-pa-initialized') === 'true' && activeDashboardInstance) {
      activeDashboardInstance.overviewController.loadOverview(1);
      activeDashboardInstance.settingsController.loadSettings();
      return activeDashboardInstance;
    }

    root.setAttribute('data-pa-initialized', 'true');
    activeDashboardInstance = new DashboardController();
    activeDashboardInstance.init();
    return activeDashboardInstance;
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      runInit();
    });
  } else {
    runInit();
  }

  document.addEventListener('astro:page-load', () => {
    runInit();
  });

  return activeDashboardInstance;
}
