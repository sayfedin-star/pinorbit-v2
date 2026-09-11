/**
 * PinArchive Client State & LocalStorage Store
 */

export interface ColDef {
  key: string;
  label: string;
  defaultVisible: boolean;
  align?: 'left' | 'right' | 'center';
}

export const COLUMN_DEFS: ColDef[] = [
  { key: 'followers',       label: 'Followers',       defaultVisible: true,  align: 'right' },
  { key: 'archived_pins',   label: 'Archived Pins',   defaultVisible: true,  align: 'right' },
  { key: 'account_age',     label: 'Account Age',     defaultVisible: true,  align: 'left' },
  { key: 'interval_days',   label: 'Sync Interval',   defaultVisible: true,  align: 'left' },
  { key: 'delta_changed',   label: 'Recent Δ',        defaultVisible: true,  align: 'right' },
  { key: 'last_sync',       label: 'Last Sync',       defaultVisible: true,  align: 'left' },
  { key: 'backfill_status', label: 'Backfill Status', defaultVisible: false, align: 'left' },
  { key: 'backfill_cursor', label: 'Backfill Cursor', defaultVisible: false, align: 'left' },
  { key: 'last_result',     label: 'Last Result',     defaultVisible: false, align: 'left' },
];

export function getDefaultColVisibility(): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const def of COLUMN_DEFS) {
    result[def.key] = def.defaultVisible;
  }
  return result;
}

export function loadColVisibility(): Record<string, boolean> {
  const defaults = getDefaultColVisibility();
  if (typeof localStorage === 'undefined') return defaults;

  try {
    const saved =
      localStorage.getItem('po_pa_cols_v5') ||
      localStorage.getItem('po_pa_cols_v4');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ...defaults, ...parsed };
      }
    }
  } catch {}

  return defaults;
}

export function saveColVisibility(cols: Record<string, boolean>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem('po_pa_cols_v5', JSON.stringify(cols));
  } catch {}
}

export function resetColVisibility(): Record<string, boolean> {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('po_pa_cols_v5');
    localStorage.removeItem('po_pa_cols_v4');
  }
  return getDefaultColVisibility();
}

export function loadDensityPreference(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem('pa_density') === 'compact';
}

export function saveDensityPreference(isCompact: boolean): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem('pa_density', isCompact ? 'compact' : 'comfortable');
}

export function loadNumFormatPreference(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem('pa_num_fmt') === 'compact';
}

export function saveNumFormatPreference(isCompact: boolean): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem('pa_num_fmt', isCompact ? 'compact' : 'full');
}

export function loadSettingsExpandedPreference(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem('pa_settings_expanded') === 'true';
}

export function saveSettingsExpandedPreference(isExpanded: boolean): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem('pa_settings_expanded', String(isExpanded));
}
