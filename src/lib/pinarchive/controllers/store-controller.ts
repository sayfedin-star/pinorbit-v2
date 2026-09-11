import {
  COLUMN_DEFS,
  saveColVisibility,
  resetColVisibility,
  saveDensityPreference,
  saveNumFormatPreference,
  saveSettingsExpandedPreference,
} from '../store';
import type { DashboardState } from './state';

export interface StoreControllerCallbacks {
  onColumnsChanged: () => void;
  onPreferencesChanged: () => void;
}

export class StoreController {
  private state: DashboardState;
  private callbacks: StoreControllerCallbacks;

  constructor(state: DashboardState, callbacks: StoreControllerCallbacks) {
    this.state = state;
    this.callbacks = callbacks;
  }

  public init(): void {
    this.buildColVisibilityMenu();
    this.setupColVisibilityToggle();
    this.setupDensityToggle();
    this.setupNumFormatToggle();
    this.setupSettingsCollapse();
  }

  public buildColVisibilityMenu(): void {
    const colMenu = document.getElementById('pa-col-visibility-menu');
    if (!colMenu) return;

    colMenu.innerHTML = `
      <div class="flex items-center justify-between pb-2 px-1 border-b border-border/80 text-[11px] font-bold text-muted-foreground">
        <span>Toggle Columns</span>
        <button id="reset-pa-cols-btn" class="text-primary hover:underline text-[11px] font-bold cursor-pointer">Reset</button>
      </div>
      <div class="space-y-1 max-h-72 overflow-y-auto pt-1.5 pr-1">
        ${COLUMN_DEFS.map(
          (c) => `
          <label class="flex items-center gap-2.5 px-2 py-1.5 rounded-lg cursor-pointer hover:bg-muted/70 transition-colors text-xs font-semibold text-foreground select-none">
            <input type="checkbox" class="rounded-md accent-primary h-4 w-4 cursor-pointer" data-pa-col-key="${c.key}" ${this.state.colVisible[c.key] ? 'checked' : ''} />
            <span>${c.label}</span>
          </label>`
        ).join('')}
      </div>`;

    document.getElementById('reset-pa-cols-btn')?.addEventListener('click', () => {
      COLUMN_DEFS.forEach((c) => {
        this.state.colVisible[c.key] = c.defaultVisible;
      });
      resetColVisibility();
      this.buildColVisibilityMenu();
      this.callbacks.onColumnsChanged();
    });

    colMenu.querySelectorAll<HTMLInputElement>('input[data-pa-col-key]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const key = cb.dataset.paColKey!;
        this.state.colVisible[key] = cb.checked;
        saveColVisibility(this.state.colVisible);
        this.callbacks.onColumnsChanged();
      });
    });
  }

  public setupColVisibilityToggle(): void {
    const btn = document.getElementById('pa-col-visibility-btn');
    const colMenu = document.getElementById('pa-col-visibility-menu');
    const wrapper = document.getElementById('pa-col-visibility-wrapper');
    if (!btn || !colMenu) return;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      colMenu.classList.toggle('hidden');
    });

    document.addEventListener('click', (e) => {
      if (wrapper && !wrapper.contains(e.target as Node)) {
        colMenu.classList.add('hidden');
      }
    });
  }

  public setupDensityToggle(): void {
    const densityToggleBtn = document.getElementById('pa-density-toggle-btn');
    const densityLabel = document.getElementById('pa-density-label');

    const updateDensityUI = () => {
      if (densityLabel) {
        densityLabel.textContent = this.state.isCompactDensity ? 'Compact' : 'Comfortable';
      }
    };

    updateDensityUI();

    densityToggleBtn?.addEventListener('click', () => {
      this.state.isCompactDensity = !this.state.isCompactDensity;
      saveDensityPreference(this.state.isCompactDensity ? 'compact' : 'comfortable');
      updateDensityUI();
      this.callbacks.onPreferencesChanged();
    });
  }

  public setupNumFormatToggle(): void {
    const numFormatToggleBtn = document.getElementById('pa-num-format-toggle-btn');
    const numFormatLabel = document.getElementById('pa-num-format-label');

    const updateNumFormatUI = () => {
      if (numFormatLabel) {
        numFormatLabel.textContent = this.state.isCompactNumbers ? 'Compact' : 'Full';
      }
    };

    updateNumFormatUI();

    numFormatToggleBtn?.addEventListener('click', () => {
      this.state.isCompactNumbers = !this.state.isCompactNumbers;
      saveNumFormatPreference(this.state.isCompactNumbers ? 'compact' : 'full');
      updateNumFormatUI();
      this.callbacks.onPreferencesChanged();
    });
  }

  public setupSettingsCollapse(): void {
    const toggleBtn = document.getElementById('toggle-settings-collapse-btn');
    const panelBody = document.getElementById('settings-panel-body');
    const collapseIcon = document.getElementById('settings-collapse-icon');
    const collapseText = document.getElementById('settings-collapse-text');
    if (!toggleBtn || !panelBody) return;

    const updateCollapseUI = () => {
      if (this.state.isSettingsExpanded) {
        panelBody.classList.remove('hidden');
        if (collapseIcon) collapseIcon.style.transform = 'rotate(180deg)';
        if (collapseText) collapseText.textContent = 'Collapse';
      } else {
        panelBody.classList.add('hidden');
        if (collapseIcon) collapseIcon.style.transform = 'rotate(0deg)';
        if (collapseText) collapseText.textContent = 'Configure';
      }
    };

    updateCollapseUI();

    toggleBtn.addEventListener('click', () => {
      this.state.isSettingsExpanded = !this.state.isSettingsExpanded;
      saveSettingsExpandedPreference(this.state.isSettingsExpanded);
      updateCollapseUI();
    });
  }
}
