/**
 * PinArchive Formatting & Badging Utilities
 */

import { escapeHtml } from '../ui-helpers';

const cachedFullFormatter = new Intl.NumberFormat('en-US');
const cachedCompactFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export function fmtNumberFull(n: number | string | null | undefined): string {
  const num = Number(n) || 0;
  return cachedFullFormatter.format(num);
}

export function fmtNumberCompact(n: number | string | null | undefined): string {
  const num = Number(n) || 0;
  return cachedCompactFormatter.format(num);
}

export function fmtMetric(
  n: number | string | null | undefined,
  isCompact = false
): string {
  return isCompact ? fmtNumberCompact(n) : fmtNumberFull(n);
}

export function formatNextRun(isoString?: string | null): string {
  if (!isoString) return 'Schedule pending';
  try {
    const nextDate = new Date(isoString);
    const nextMs = nextDate.getTime();
    if (isNaN(nextMs)) return 'Schedule pending';
    const diffMs = nextMs - Date.now();
    const dateStr = nextDate.toISOString().slice(0, 10);
    if (diffMs <= 0) {
      return `Overdue (${dateStr})`;
    }
    const mins = Math.floor(diffMs / 60000);
    if (mins < 60) return `in ${Math.max(1, mins)}m (${dateStr} UTC)`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `in ${hrs}h (${dateStr} UTC)`;
    const days = Math.floor(hrs / 24);
    return `in ${days} days (${dateStr} UTC)`;
  } catch {
    return 'Scheduled';
  }
}

export function formatTooltipNextRun(isoString?: string | null): string {
  if (!isoString) return 'No sync scheduled';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return 'No sync scheduled';
    const yyyyMmDd = d.toISOString().slice(0, 10);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `Next scheduled sync: ${yyyyMmDd} ${hh}:${mm} UTC`;
  } catch {
    return 'No sync scheduled';
  }
}

export function getAvatarStyle(username: string): { bg: string; initial: string } {
  const palettes = [
    'bg-gradient-to-br from-rose-500 to-pink-600',
    'bg-gradient-to-br from-violet-500 to-indigo-600',
    'bg-gradient-to-br from-emerald-500 to-teal-600',
    'bg-gradient-to-br from-sky-500 to-blue-600',
    'bg-gradient-to-br from-amber-500 to-orange-600',
    'bg-gradient-to-br from-fuchsia-500 to-purple-600',
  ];
  let hash = 0;
  const clean = (username || '').replace(/^@/, '');
  for (let i = 0; i < clean.length; i++) {
    hash = (hash + clean.charCodeAt(i)) % palettes.length;
  }
  const initial = clean.slice(0, 2).toUpperCase() || 'PA';
  return { bg: palettes[hash], initial };
}

export function renderLastResultBadges(raw: string | null | undefined): string {
  if (!raw || raw === '—') return '<span class="text-muted-foreground">—</span>';

  const str = String(raw).trim();
  // Tolerant regex matching:
  // New format: pages=5 fetched=247 +3 sheet=131 (app=110, upd=21, unch=116)
  // Old format: pages=5 +3 qual=3 sheet=131
  const m = str.match(
    /^pages=(\d+)(?:\s+fetched=(\d+))?\s+\+(\d+)(?:\s+qual=\d+)?\s+sheet=(\d+)(?:\s+\(app=(\d+),\s*upd=(\d+)(?:,\s*unch=(\d+))?\))?(.*)$/i
  );

  if (!m) {
    // Graceful Fallback: render raw text safely
    return `<span class="text-[11px] text-muted-foreground truncate" title="${escapeHtml(str)}">${escapeHtml(str)}</span>`;
  }

  const pages = m[1];
  const fetched = m[2];
  const newPins = Number(m[3]) || 0;
  const sheet = m[4];
  const app = m[5];
  const upd = m[6];
  const unch = m[7];
  const extra = (m[8] || '').trim();

  const isCircuitBroken = str.includes('circuit-broken');
  const isSheetErr = str.includes('sheet_err');

  let tooltip = `Pages: ${pages}`;
  if (fetched) tooltip += ` (${fetched} pins fetched)`;
  tooltip += ` • DB: +${newPins}`;
  tooltip += ` • Sheet: ${sheet}`;
  if (app !== undefined && upd !== undefined) {
    tooltip += ` (New: ${app}, Updated: ${upd}${unch !== undefined ? `, Unchanged: ${unch}` : ''})`;
  }
  if (extra) tooltip += ` • ${extra}`;

  const dbBadgeClass =
    newPins > 0
      ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20 font-semibold'
      : 'bg-muted text-muted-foreground border-border/50 font-normal';

  return `
    <div class="inline-flex items-center gap-1 flex-wrap text-[10.5px]" title="${escapeHtml(tooltip)}">
      <span class="inline-flex items-center px-1.5 py-0.2 rounded bg-muted text-muted-foreground border border-border/60 font-mono">
        ${pages}p
      </span>
      <span class="inline-flex items-center px-1.5 py-0.2 rounded border ${dbBadgeClass} font-mono">
        +${newPins} DB
      </span>
      <span class="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 font-mono">
        📑 ${sheet}
      </span>
      ${isCircuitBroken ? '<span class="inline-flex items-center px-1 py-0.2 rounded text-[9px] font-bold bg-amber-500/10 text-amber-600 border border-amber-500/20">Breaker</span>' : ''}
      ${isSheetErr ? '<span class="inline-flex items-center px-1 py-0.2 rounded text-[9px] font-bold bg-rose-500/10 text-rose-600 border border-rose-500/20">SheetErr</span>' : ''}
    </div>
  `;
}
