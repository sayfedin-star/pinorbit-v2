// Client UI rendering helpers for status badges, dates, webhook masking, and loading states

export function renderStatusBadge(status: string | boolean, customLabel?: string, size: 'sm' | 'md' = 'sm'): string {
  let normalized = typeof status === 'boolean'
    ? (status ? 'active' : 'inactive')
    : String(status || '').toLowerCase();

  let variantStyles = 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20';
  let dotColor = 'bg-slate-500';

  if (['posted', 'success', 'active', 'true'].includes(normalized)) {
    variantStyles = 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20';
    dotColor = 'bg-emerald-500';
  } else if (['processing'].includes(normalized)) {
    variantStyles = 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20';
    dotColor = 'bg-sky-500 animate-pulse';
  } else if (['pending'].includes(normalized)) {
    variantStyles = 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20';
    dotColor = 'bg-amber-500';
  } else if (['failed', 'error', 'inactive', 'false'].includes(normalized)) {
    variantStyles = 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20';
    dotColor = 'bg-rose-500';
  }

  const sizeStyles = size === 'sm' ? 'px-2.5 py-0.5 text-xs font-medium' : 'px-3 py-1 text-sm font-medium';
  const label = customLabel || normalized.charAt(0).toUpperCase() + normalized.slice(1);

  return `<span class="inline-flex items-center gap-1.5 rounded-full border transition-colors ${variantStyles} ${sizeStyles}">
    <span class="h-1.5 w-1.5 rounded-full ${dotColor}"></span>
    ${escapeHtml(label)}
  </span>`;
}

export function formatDate(dateString: string | null | undefined): string {
  if (!dateString) return '-';
  try {
    const d = new Date(dateString);
    if (isNaN(d.getTime())) return '-';
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '-';
  }
}

export function formatTime(dateString: string | null | undefined): string {
  if (!dateString) return '-';
  try {
    const d = new Date(dateString);
    if (isNaN(d.getTime())) return '-';
    return d.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '-';
  }
}

export function maskWebhookUrl(url: string | null | undefined): string {
  if (!url) return '-';
  try {
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (path.length > 8) {
      const maskedPath = path.substring(0, 4) + '••••' + path.substring(path.length - 4);
      return `${parsed.origin}${maskedPath}`;
    }
    return `${parsed.origin}/••••••••`;
  } catch {
    if (url.length > 12) {
      return url.substring(0, 8) + '••••' + url.substring(url.length - 4);
    }
    return '••••••••';
  }
}

export function formatNumber(num: number | null | undefined): string {
  if (num === null || num === undefined || isNaN(num)) return '0';
  return num.toLocaleString('en-US');
}

export function escapeHtml(str: string | null | undefined): string {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}



export function renderEmptyStateHTML(title: string, description: string, icon: 'folder' | 'inbox' | 'alert-circle' = 'inbox'): string {
  let iconSvg = '';
  if (icon === 'folder') {
    iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L8.6 3.3A2 2 0 0 0 6.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`;
  } else if (icon === 'inbox') {
    iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>`;
  } else {
    iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="17"/></svg>`;
  }

  return `
    <div class="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/50 p-12 text-center">
      <div class="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground mb-4">
        ${iconSvg}
      </div>
      <h3 class="text-base font-semibold text-foreground mb-1">${escapeHtml(title)}</h3>
      <p class="text-sm text-muted-foreground max-w-sm">${escapeHtml(description)}</p>
    </div>
  `;
}

/**
 * Hardened client-side fetch helper that ensures:
 * 1. Checks res.ok AND Content-Type includes application/json before parsing.
 * 2. Redirects to /login on 401/403.
 * 3. Shows "Endpoint unavailable - redeploy required" on 404.
 * 4. Shows "HTTP {status}" on non-JSON / error responses. Never exposes raw stack traces.
 */
export async function safeFetchJson<T = any>(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(input, init);

  if (res.status === 401 || res.status === 403) {
    if (typeof window !== 'undefined') {
      window.location.href = '/login';
    }
    throw new Error(`HTTP ${res.status}: Unauthorized or forbidden. Redirecting to login.`);
  }

  if (res.status === 404) {
    throw new Error('HTTP 404: Endpoint unavailable - redeploy required');
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error(`HTTP ${res.status}: Server returned non-JSON response (${contentType || 'empty'})`);
  }

  const data = await res.json();

  if (!res.ok) {
    const errorMsg = data?.error || data?.message || res.statusText || 'Request failed';
    throw new Error(`HTTP ${res.status}: ${errorMsg}`);
  }

  return data as T;
}

export interface ConnectionHealthSummary {
  consecutive_failures: number;
  last_success_at: string | null;
  total_runs: number;
  health_status: 'healthy' | 'warning' | 'critical' | 'revoked';
}

export function calculateConnectionHealth(
  runs: Array<{ status: string; started_at: string }>,
  isRevoked = false
): ConnectionHealthSummary {
  if (isRevoked) {
    return {
      consecutive_failures: 0,
      last_success_at: null,
      total_runs: runs?.length || 0,
      health_status: 'revoked',
    };
  }

  if (!runs || runs.length === 0) {
    return {
      consecutive_failures: 0,
      last_success_at: null,
      total_runs: 0,
      health_status: 'healthy',
    };
  }

  let consecutiveFailures = 0;
  for (const run of runs) {
    if (run.status === 'failed') {
      consecutiveFailures++;
    } else {
      break;
    }
  }

  const lastSuccess = runs.find((r) => r.status === 'completed' || r.status === 'success');

  let healthStatus: 'healthy' | 'warning' | 'critical' = 'healthy';
  if (consecutiveFailures >= 3) {
    healthStatus = 'critical';
  } else if (consecutiveFailures >= 1) {
    healthStatus = 'warning';
  }

  return {
    consecutive_failures: consecutiveFailures,
    last_success_at: lastSuccess?.started_at || null,
    total_runs: runs.length,
    health_status: healthStatus,
  };
}

export function humanAgeFromOldestPin(oldestIso: string | null | undefined, nowMs = Date.now()): string {
  if (!oldestIso) return "—";
  const t = Date.parse(oldestIso);
  if (!Number.isFinite(t)) return "—";
  const days = Math.max(0, Math.floor((nowMs - t) / 86_400_000));
  const y = Math.floor(days / 365), m = Math.floor((days % 365) / 30), d = days % 30;
  if (y > 0) return `${y}y ${m}m`;
  if (m > 0) return `${m}m ${d}d`;
  return `${d}d`;
}

export async function apiJSON<T = any>(input: RequestInfo | URL, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers || {});
  if (!headers.has('Content-Type') && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(input, { ...init, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as any)?.error || (data as any)?.message || `HTTP ${res.status}`);
  }
  return data as T;
}

export function cleanPinterestUsername(input: string | null | undefined): string {
  let u = String(input || '').trim();
  u = u.replace(/^(https?:\/\/)?(www\.)?pinterest\.[a-z.]+\//i, '');
  u = u.replace(/\/.*$/, '');
  u = u.replace(/^@+/, '').trim();
  return u;
}

export function timeAgo(iso?: string | null, fallback = '—'): string {
  if (!iso) return fallback;
  const time = new Date(iso).getTime();
  if (isNaN(time)) return fallback;
  const ms = Date.now() - time;
  if (ms < 0) return 'just now';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

export function toast(message: string, type: 'success' | 'error' | 'info' = 'success'): void {
  if (typeof document === 'undefined') return;
  let root = document.getElementById('toast-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'toast-root';
    root.setAttribute('aria-live', 'polite');
    root.className = 'fixed bottom-4 right-4 z-[70] flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)]';
    document.body.appendChild(root);
  }
  const colors = {
    success: 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
    error: 'border-rose-500/40 text-rose-600 dark:text-rose-400',
    info: 'border-primary/40 text-primary',
  };
  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  const el = document.createElement('div');
  el.className = `flex items-start gap-2.5 rounded-xl border bg-card p-3 text-xs font-semibold shadow-lg ${colors[type]} transition-all animate-in fade-in slide-in-from-bottom-2`;
  el.innerHTML = `<span class="flex-shrink-0 font-bold">${icons[type]}</span><span class="flex-1 text-foreground">${escapeHtml(message)}</span>
    <button class="text-muted-foreground hover:text-foreground cursor-pointer" aria-label="Dismiss">✕</button>`;
  el.querySelector('button')?.addEventListener('click', () => el.remove());
  root.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .3s';
    setTimeout(() => el.remove(), 300);
  }, 4000);
}

export async function copyToClipboard(text: string, btn?: HTMLElement | null): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.clipboard) {
    toast('Clipboard not available', 'error');
    return false;
  }
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const orig = btn.innerHTML;
      btn.innerHTML = '<span class="text-emerald-500 font-bold">✓</span>';
      setTimeout(() => {
        btn.innerHTML = orig;
      }, 1200);
    }
    toast(`Copied "${text}" to clipboard!`);
    return true;
  } catch {
    toast('Failed to copy', 'error');
    return false;
  }
}

export * from './cron-helper';
export * from './format-audit';
