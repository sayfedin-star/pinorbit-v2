import {
  loadColVisibility,
  loadDensityPreference,
  loadNumFormatPreference,
  loadSettingsExpandedPreference,
} from '../store';

export interface DashboardState {
  rawAccounts: any[];
  selectedAccounts: Set<string>;
  competitorMap: Map<string, { id: string; username: string }>;
  activeStatusTab: 'all' | 'active' | 'paused';
  accountSearchTerm: string;
  selectedInterval: string;
  isCompactNumbers: boolean;
  isCompactDensity: boolean;
  isSettingsExpanded: boolean;
  colVisible: Record<string, boolean>;
  accountsCurrentPage: number;
  currentFilteredAccounts: any[];
  currentPagedAccounts: any[];
  canAdminSettings: boolean;
  pageSize: number;
}

export function createDashboardState(): DashboardState {
  return {
    rawAccounts: [],
    selectedAccounts: new Set<string>(),
    competitorMap: new Map<string, { id: string; username: string }>(),
    activeStatusTab: 'all',
    accountSearchTerm: '',
    selectedInterval: 'all',
    isCompactNumbers: loadNumFormatPreference(),
    isCompactDensity: loadDensityPreference(),
    isSettingsExpanded: loadSettingsExpandedPreference(),
    colVisible: loadColVisibility(),
    accountsCurrentPage: 1,
    currentFilteredAccounts: [],
    currentPagedAccounts: [],
    canAdminSettings: true,
    pageSize: 50,
  };
}
