export const PANEL_MODULES: Record<string, () => Promise<unknown>> = {
  // @ts-ignore - pipeline-controls is executed for side-effects
  pipeline: () => import('./pipeline-controls'),
  intelligence: () => import('./pin-intelligence'),
  // @ts-ignore - purge-controls is executed for side-effects
  purge: () => import('./purge-controls'),
};

export const loadedPanels = new Set<string>(['data']);

export function resetLoadedPanels(): void {
  loadedPanels.clear();
  loadedPanels.add('data');
}

export async function loadPanelModule(
  tab: string,
  importer: Record<string, () => Promise<unknown>> = PANEL_MODULES,
  panelsSet: Set<string> = loadedPanels
): Promise<void> {
  if (tab === 'data' || panelsSet.has(tab) || !importer[tab]) return;

  try {
    await importer[tab]();
    panelsSet.add(tab);

    if (typeof document !== 'undefined') {
      const tabBtn = document.querySelector(`[data-tab="${tab}"]`);
      const panelId = tabBtn?.getAttribute('aria-controls');
      const panel = panelId ? document.getElementById(panelId) : null;
      const prevErr = panel?.querySelector('.tab-load-error');
      if (prevErr) prevErr.remove();
    }
  } catch (err) {
    console.warn(`Panel module '${tab}' failed to load, will retry on next open`, err);

    if (typeof document !== 'undefined') {
      const tabBtn = document.querySelector(`[data-tab="${tab}"]`);
      const panelId = tabBtn?.getAttribute('aria-controls');
      const panel = panelId ? document.getElementById(panelId) : null;
      if (panel) {
        let errEl = panel.querySelector('.tab-load-error');
        if (!errEl) {
          errEl = document.createElement('div');
          errEl.className =
            'tab-load-error mb-4 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive flex items-center justify-between';
          panel.prepend(errEl);
        }
        errEl.textContent = 'Failed to load panel module. Click tab again to retry.';
      }
    }
  }
}

export function initTabs(): void {
  if (typeof document === 'undefined') return;

  const tabs = document.querySelectorAll('[role="tab"]');
  const panels = document.querySelectorAll('[role="tabpanel"]');
  const hash = window.location.hash;

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.getAttribute('data-tab') || '';
      const target = tab.getAttribute('aria-controls');

      panels.forEach(p => ((p as HTMLElement).hidden = p.id !== target));
      tabs.forEach(t => {
        const selected = t === tab;
        t.setAttribute('aria-selected', String(selected));
        if (selected) {
          t.className = 'rounded-lg px-4 py-1.5 text-xs font-bold bg-primary text-primary-foreground shadow-sm';
        } else {
          t.className = 'rounded-lg px-4 py-1.5 text-xs font-semibold text-muted-foreground';
        }
      });
      window.history.replaceState(null, '', `#${tabName}`);

      if (tabName && tabName !== 'data') {
        loadPanelModule(tabName);
      }
    });
  });

  if (hash === '#pipeline') {
    document.querySelector('[data-tab="pipeline"]')?.dispatchEvent(new Event('click'));
  } else if (hash === '#intelligence' || hash === '#intel') {
    document.querySelector('[data-tab="intelligence"]')?.dispatchEvent(new Event('click'));
  } else if (hash === '#purge' || hash === '#data-purge') {
    document.querySelector('[data-tab="purge"]')?.dispatchEvent(new Event('click'));
  }
}

if (typeof document !== 'undefined') {
  initTabs();
}

