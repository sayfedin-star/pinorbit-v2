/**
 * PinArchive Table Rendering Module
 * Pure HTML string generators preserving 100% byte-for-byte identical element IDs,
 * CSS classes, and data-* attributes.
 */

import { escapeHtml, humanAgeFromOldestPin, timeAgo } from '../ui-helpers';
import { fmtMetric, getAvatarStyle, renderLastResultBadges, formatNextRun, formatTooltipNextRun } from './format';

export interface RenderStripOptions {
  colVisible: Record<string, boolean>;
  selectedAccounts: Set<string>;
  isCompactDensity: boolean;
  isCompactNumbers: boolean;
  competitorMap?: Map<string, { id: string; username: string }>;
}

export function renderTableHeaderHtml(colVisible: Record<string, boolean>): string {
  let headersHtml = `
    <tr>
      <th class="py-3 px-4 w-10 text-center">
        <input
          type="checkbox"
          id="select-all-accounts-cb"
          class="rounded border-border text-primary focus:ring-primary h-3.5 w-3.5 cursor-pointer accent-primary"
          title="Select all accounts"
        />
      </th>
      <th class="py-3 px-4 font-semibold text-foreground">Creator Account</th>
  `;

  if (colVisible.followers) headersHtml += `<th class="py-3 px-4 font-semibold text-right">Followers</th>`;
  if (colVisible.archived_pins) headersHtml += `<th class="py-3 px-4 font-semibold text-right">Archived Pins</th>`;
  if (colVisible.account_age) headersHtml += `<th class="py-3 px-4 font-semibold">Account Age</th>`;
  if (colVisible.interval_days) headersHtml += `<th class="py-3 px-4 font-semibold">Interval</th>`;
  if (colVisible.delta_changed) headersHtml += `<th class="py-3 px-4 font-semibold text-right">Recent Δ</th>`;
  if (colVisible.last_sync) headersHtml += `<th class="py-3 px-4 font-semibold">Last Sync</th>`;
  if (colVisible.backfill_status) headersHtml += `<th class="py-3 px-4 font-semibold">Backfill</th>`;
  if (colVisible.backfill_cursor) headersHtml += `<th class="py-3 px-4 font-semibold">Cursor</th>`;
  if (colVisible.last_result) headersHtml += `<th class="py-3 px-4 font-semibold">Last Result</th>`;

  headersHtml += `
    </tr>
  `;

  return headersHtml;
}

export function renderEmptyAccountsRowHtml(hasRawAccounts: boolean): string {
  return `
    <tr>
      <td colspan="11" class="p-12 text-center text-xs text-muted-foreground bg-muted/10">
        <div class="flex flex-col items-center gap-2 max-w-sm mx-auto">
          <span class="text-2xl">🔍</span>
          <span class="font-bold text-foreground">${hasRawAccounts ? 'No accounts match active filters' : 'No accounts tracked in archive yet'}</span>
          <p class="text-[11px] text-muted-foreground">Adjust your search term or status filters to view tracked accounts.</p>
        </div>
      </td>
    </tr>
  `;
}

export function renderAccountsStripHtml(
  accounts: any[],
  options: RenderStripOptions
): string {
  const {
    colVisible,
    selectedAccounts,
    isCompactDensity,
    isCompactNumbers,
    competitorMap = new Map(),
  } = options;

  if (accounts.length === 0) {
    return renderEmptyAccountsRowHtml(false);
  }

  const padClass = isCompactDensity ? 'py-2 px-4' : 'py-3.5 px-4';
  const avatarSize = isCompactDensity ? 'h-7 w-7 text-[10px]' : 'h-8 w-8 text-[11px]';

  return accounts
    .map((acc: any) => {
      const isChecked = selectedAccounts.has(acc.id);
      const { bg: avatarBg, initial } = getAvatarStyle(acc.username || '');
      const isPaused = acc.status === 'paused' || (acc.status === 'active' && acc.ingest_enabled === false);
      const isError = ['cookie_expired', 'error'].includes(acc.status);
      const statusBadge = isPaused
        ? `<button type="button" data-acc-status-toggle="${escapeHtml(acc.id)}" data-current-status="paused" class="inline-flex items-center justify-center text-xs hover:scale-125 transition-transform cursor-pointer p-0.5" title="Paused (Click to Resume Ingest)">⏸</button>`
        : isError
        ? `<span class="inline-flex items-center text-[9.5px] font-bold uppercase px-1.5 py-0.2 rounded-full bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20" title="${escapeHtml(acc.status)}">⚠️ ${escapeHtml(acc.status)}</span>`
        : `<button type="button" data-acc-status-toggle="${escapeHtml(acc.id)}" data-current-status="active" class="inline-flex items-center justify-center text-[10px] hover:scale-125 transition-transform cursor-pointer p-0.5" title="Active (Click to Pause Ingest)">🟢</button>`;
      const changed = Number(acc.changed_last_refresh ?? 0);
      const total = Number(acc.checked_last_refresh ?? (acc.db_pins_count !== undefined ? acc.db_pins_count : (acc.pins_count ?? 0)));
      const archCount = acc.db_pins_count !== undefined ? acc.db_pins_count : (acc.pins_count ?? 0);

      let dynamicCells = '';

      if (colVisible.followers) {
        dynamicCells += `<td class="${padClass} text-right font-semibold text-foreground font-mono tabular-nums">${fmtMetric(acc.follower_count, isCompactNumbers)}</td>`;
      }

      if (colVisible.archived_pins) {
        dynamicCells += `
          <td class="${padClass} text-right font-semibold text-emerald-600 dark:text-emerald-400 font-mono tabular-nums">
            <span title="Total archived pins with verified metrics">${fmtMetric(archCount, isCompactNumbers)}</span>
          </td>`;
      }

      if (colVisible.account_age) {
        const humanAge = humanAgeFromOldestPin(acc.oldest_pin_at);
        const exactDateUtc = acc.oldest_pin_at ? new Date(acc.oldest_pin_at).toUTCString() : '';
        const tooltip = exactDateUtc ? `Oldest known pin (sheet): ${exactDateUtc}` : 'No known pins in sheet';
        const ageBadge = acc.oldest_pin_at
          ? `<span class="inline-flex items-center px-2 py-0.5 rounded-md bg-muted font-mono text-[11px] font-medium text-foreground border border-border/60" title="${escapeHtml(tooltip)}">${escapeHtml(humanAge)}</span>`
          : `<span class="text-muted-foreground text-xs" title="${escapeHtml(tooltip)}">—</span>`;
        dynamicCells += `<td class="${padClass} whitespace-nowrap">${ageBadge}</td>`;
      }

      if (colVisible.interval_days) {
        const currentDays = Number(acc.interval_days || 1);
        dynamicCells += `
          <td class="${padClass} font-medium text-foreground">
            <div class="relative inline-flex items-center">
              <select
                class="interval-select appearance-none cursor-pointer inline-flex items-center gap-1 pl-2 pr-5 py-0.5 rounded-lg bg-muted hover:bg-muted/80 text-[11px] font-bold border border-border/60 transition-colors focus:ring-1 focus:ring-primary focus:outline-none shadow-2xs"
                data-username="${escapeHtml(acc.username || '')}"
                data-account-id="${escapeHtml(acc.id || '')}"
                data-prev-days="${currentDays}"
                title="Click to change discovery interval"
              >
                <option value="1" ${currentDays === 1 ? 'selected' : ''}>1d</option>
                <option value="2" ${currentDays === 2 ? 'selected' : ''}>2d</option>
                <option value="3" ${currentDays === 3 ? 'selected' : ''}>3d</option>
                <option value="5" ${currentDays === 5 ? 'selected' : ''}>5d</option>
                <option value="7" ${currentDays === 7 ? 'selected' : ''}>7d</option>
                <option value="14" ${currentDays === 14 ? 'selected' : ''}>14d</option>
                <option value="30" ${currentDays === 30 ? 'selected' : ''}>30d</option>
              </select>
              <div class="pointer-events-none absolute right-1.5 flex items-center text-muted-foreground">
                <svg class="h-2.5 w-2.5" viewBox="0 0 20 20" fill="currentColor">
                  <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 10.94l3.71-3.71a.75.75 0 111.06 1.06l-4.24 4.25a.75.75 0 01-1.06 0L5.21 8.27a.75.75 0 01.02-1.06z" clip-rule="evenodd"/>
                </svg>
              </div>
            </div>
          </td>
        `;
      }

      if (colVisible.delta_changed) {
        const deltaBadge = changed > 0
          ? `<span class="inline-flex items-center gap-1 font-bold text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20" title="${changed} of ${total} pins updated in last refresh">+${fmtMetric(changed, isCompactNumbers)} pins</span>`
          : `<span class="text-[11px] text-muted-foreground" title="No pins changed in last refresh">0 change</span>`;
        dynamicCells += `<td class="${padClass} text-right font-mono tabular-nums">${deltaBadge}</td>`;
      }

      if (colVisible.last_sync) {
        const nextStr = formatNextRun(acc.next_run_at);
        dynamicCells += `
          <td class="${padClass} whitespace-nowrap">
            <div class="text-[11px] font-medium text-foreground">
              ${acc.last_run_at ? timeAgo(acc.last_run_at) : '<span class="text-muted-foreground/60">Never</span>'}
            </div>
            <div class="text-[10px] text-muted-foreground mt-0.5" title="${escapeHtml(formatTooltipNextRun(acc.next_run_at))}">
              <span>Next: ${nextStr}</span>
            </div>
          </td>
        `;
      }

      if (colVisible.backfill_status) {
        const isDone = acc.backfill_status === 'done';
        const isProg = acc.backfill_status === 'in_progress';
        dynamicCells += `
          <td class="${padClass}">
            <span class="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${
              isDone
                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20'
                : isProg
                ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 animate-pulse'
                : 'bg-muted text-muted-foreground'
            }">
              ${escapeHtml(acc.backfill_status || 'pending')}
            </span>
          </td>
        `;
      }

      if (colVisible.backfill_cursor) {
        const cur = acc.backfill_cursor ? String(acc.backfill_cursor) : '—';
        const shortCur = cur.length > 12 ? cur.slice(0, 10) + '…' : cur;
        dynamicCells += `<td class="${padClass} font-mono text-[10px] text-muted-foreground" title="${escapeHtml(cur)}">${escapeHtml(shortCur)}</td>`;
      }

      if (colVisible.last_result) {
        dynamicCells += `<td class="${padClass} max-w-[240px] whitespace-nowrap">${renderLastResultBadges(acc.last_result)}</td>`;
      }

      const compInfo = competitorMap.get((acc.username || '').toLowerCase().trim());
      const isCompetitor = Boolean(compInfo);
      const compHref = compInfo?.id ? `/competitors/details?id=${encodeURIComponent(compInfo.id)}` : '/competitors';
      const compBadge = isCompetitor
        ? `<a href="${compHref}" title="View @${escapeHtml(acc.username)} in Competitor Intelligence" class="inline-flex items-center justify-center h-5 w-5 rounded-md bg-blue-500/10 hover:bg-blue-500/20 text-blue-600 dark:text-blue-400 border border-blue-500/30 transition-colors shadow-2xs shrink-0">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          </a>`
        : '';

      return `
        <tr class="${isChecked ? 'bg-primary/5 font-medium' : 'hover:bg-muted/40'} transition-colors group">
          <td class="${padClass} text-center w-10">
            <input
              type="checkbox"
              data-acc-select="${escapeHtml(acc.id)}"
              ${isChecked ? 'checked' : ''}
              class="rounded border-border text-primary focus:ring-primary h-3.5 w-3.5 cursor-pointer accent-primary"
              id="acc-check-${escapeHtml(acc.id)}"
            />
          </td>
          <td class="${padClass}">
            <div class="flex items-center gap-2.5">
              <div class="${avatarSize} rounded-xl ${avatarBg} text-white font-bold flex items-center justify-center shrink-0 shadow-2xs uppercase tracking-tight">
                ${initial}
              </div>
              <div class="flex flex-col min-w-0">
                <div class="flex items-center gap-1.5 flex-wrap">
                  <a href="/pinarchive/account/${encodeURIComponent(acc.username)}" class="font-bold text-foreground hover:text-primary transition-colors truncate max-w-[180px]">
                    @${escapeHtml(acc.username)}
                  </a>
                  <button data-pa-copy-handle="${escapeHtml(acc.username)}" class="opacity-40 hover:opacity-100 transition-opacity p-0.5" title="Copy username">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                  </button>
                  <a href="https://www.pinterest.com/${escapeHtml(acc.username)}/" target="_blank" rel="noopener noreferrer" class="text-muted-foreground/60 hover:text-primary transition-colors p-0.5" title="View on Pinterest">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                  </a>
                  ${compBadge}
                  ${statusBadge}
                </div>
              </div>
            </div>
          </td>
          ${dynamicCells}
        </tr>
      `;
    })
    .join('');
}
