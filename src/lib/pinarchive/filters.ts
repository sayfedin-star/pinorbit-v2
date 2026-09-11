/**
 * PinArchive Account Filtering Utilities
 */

export interface AccountFilterOptions {
  activeStatusTab?: 'all' | 'active' | 'paused';
  selectedInterval?: string;
  accountSearchTerm?: string;
}

export function matchesStatusTab(
  acc: any,
  tab: 'all' | 'active' | 'paused' = 'all'
): boolean {
  if (tab === 'active') {
    return acc.status === 'active' && acc.ingest_enabled !== false;
  }
  if (tab === 'paused') {
    return acc.status === 'paused' || acc.ingest_enabled === false;
  }
  return true;
}

export function matchesInterval(acc: any, interval = 'all'): boolean {
  if (!interval || interval === 'all') return true;
  return String(acc.interval_days || 1) === interval;
}

export function matchesSearch(acc: any, term: string): boolean {
  if (!term || !term.trim()) return true;
  const cleanTerm = term.toLowerCase().trim();
  const username = String(acc.username || '').toLowerCase();
  const status = String(acc.status || '').toLowerCase();
  return username.includes(cleanTerm) || status.includes(cleanTerm);
}

export function filterAccounts(
  accounts: any[],
  options: AccountFilterOptions
): any[] {
  const {
    activeStatusTab = 'all',
    selectedInterval = 'all',
    accountSearchTerm = '',
  } = options;

  return accounts.filter((acc) => {
    if (!matchesStatusTab(acc, activeStatusTab)) return false;
    if (!matchesInterval(acc, selectedInterval)) return false;
    if (!matchesSearch(acc, accountSearchTerm)) return false;
    return true;
  });
}
