import { escapeHtml } from '../ui-helpers';
import { fmtNumberFull } from './format';

export interface PinCardRenderOptions {
  viewMode?: 'winning-pins' | 'topics' | 'account';
  index?: number;
  activeTimeframe?: string;
  isSelected?: boolean;
  strategy?: string;
  deltaVal?: number;
  rankBadgeHtml?: string;
  strategyBadgeHtml?: string;
  stageBadgeHtml?: string;
  anomalyBadgeHtml?: string;
  detailsUrlMaker?: (pin: any) => string;
  activePace?: string;
  deltaBadgeHtml?: string;
  deltaRepinsBadgeHtml?: string;
  isChanged?: boolean;
  username?: string;
}

export function fmtDate(iso?: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return '—';
  }
}

export function renderRankBadge(idx: number): string {
  const rank = idx + 1;
  let bg = 'bg-background/90 text-foreground border-border/80';
  let medal = '';
  if (rank === 1) {
    bg = 'bg-amber-400 text-amber-950 border-amber-500 font-extrabold shadow-amber-500/20';
    medal = '🥇 ';
  } else if (rank === 2) {
    bg = 'bg-slate-200 dark:bg-slate-700 text-slate-900 dark:text-slate-100 border-slate-400 font-extrabold';
    medal = '🥈 ';
  } else if (rank === 3) {
    bg = 'bg-amber-700 text-amber-50 border-amber-800 font-extrabold';
    medal = '🥉 ';
  }
  return `<span class="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-lg text-[10px] font-mono font-bold border shadow-2xs ${bg}">${medal}#${rank}</span>`;
}

export function renderStrategyBadge(strategy: string): string {
  switch (strategy) {
    case 'EVERGREEN':
      return '<span class="text-[9.5px] font-bold px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">🌲 Evergreen</span>';
    case 'ROCKET':
      return '<span class="text-[9.5px] font-bold px-2 py-0.5 rounded-md bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20 animate-pulse">🚀 Rocket</span>';
    case 'VIRALITY':
      return '<span class="text-[9.5px] font-bold px-2 py-0.5 rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">🔁 Virality</span>';
    case 'MATURE':
      return '<span class="text-[9.5px] font-bold px-2 py-0.5 rounded-md bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20">🏛️ Mature</span>';
    default:
      return '<span class="text-[9.5px] font-bold px-2 py-0.5 rounded-md bg-muted text-muted-foreground border border-border">⚖️ Steady</span>';
  }
}

export function renderStageBadge(stage?: string | null, mode: 'topics' | 'account' | 'default' = 'default'): string {
  if (mode === 'topics') {
    switch (stage) {
      case 'NEW':
        return '<span class="text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border border-cyan-500/20">🟢 NEW (≤14d)</span>';
      case 'GROWING':
        return '<span class="text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">🚀 GROWING (≥10/d)</span>';
      case 'MATURE':
        return '<span class="text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20">🟣 MATURE (>14d)</span>';
      case 'COOLING':
        return '<span class="text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">❄️ COOLING (<2/d)</span>';
      default:
        return '<span class="text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-slate-500/10 text-slate-500 border border-slate-500/20">⚪ DORMANT (<0.5/d)</span>';
    }
  }

  if (mode === 'account') {
    switch (stage) {
      case 'NEW':
        return '<span class="text-[9px] font-bold px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border border-cyan-500/20 whitespace-nowrap">🟢 NEW</span>';
      case 'GROWING':
        return '<span class="text-[9px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 whitespace-nowrap">🚀 GROWING</span>';
      case 'MATURE':
        return '<span class="text-[9px] font-bold px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20 whitespace-nowrap">🟣 MATURE</span>';
      case 'COOLING':
        return '<span class="text-[9px] font-bold px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 whitespace-nowrap">❄️ COOLING</span>';
      default:
        return '<span class="text-[9px] font-bold px-2 py-0.5 rounded-full bg-slate-500/10 text-slate-500 border border-slate-500/20 whitespace-nowrap">⚪ DORMANT</span>';
    }
  }

  switch (stage) {
    case 'EVERGREEN':
      return '<span class="text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">🟢 EVERGREEN</span>';
    case 'ROCKET':
      return '<span class="text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-rose-500/10 text-rose-500 border border-rose-500/20 animate-pulse">🚀 ROCKET</span>';
    case 'MATURE':
      return '<span class="text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-purple-500/10 text-purple-500 border border-purple-500/20">🏛️ MATURE</span>';
    default:
      return '<span class="text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-slate-500/10 text-slate-500 border border-slate-500/20">⚪ DORMANT (<0.5/d)</span>';
  }
}

export function renderAnomalyBadge(anomaly?: string | null): string {
  if (anomaly === 'SPIKE') {
    return '<span class="text-[9px] font-bold px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-500 border border-rose-500/20 animate-pulse">🔥 SPIKE</span>';
  }
  if (anomaly === 'COOLING') {
    return '<span class="text-[9px] font-bold px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-500 border border-blue-500/20">❄️ COOLING</span>';
  }
  return '';
}

export function renderDeltaBadge(delta: number, metric: 'saves' | 'repins'): string {
  if (delta === 0) return '';
  const isPos = delta > 0;
  const color = isPos ? 'text-emerald-500 bg-emerald-500/10' : 'text-rose-500 bg-rose-500/10';
  const sign = isPos ? '+' : '';
  return `<span class="inline-flex items-center text-[9px] font-bold px-1 rounded ${color} ml-1 font-mono">${sign}${delta}</span>`;
}

export function renderPinCardHtml(p: any, options: PinCardRenderOptions = {}): string {
  const mode = options.viewMode || 'winning-pins';

  const saves = Number(p.saves || 0);
  const repins = Number(p.repins || 0);
  const velocity = Number(p.velocity || 0);
  const shares = Number(p.share_count || 0);
  const annotations = Array.isArray(p.annotations) ? p.annotations : [];
  const category = p.seo_category || p.board_name || null;
  const pinterestUrl = `https://www.pinterest.com/pin/${p.pin_id}/`;
  const destinationUrl = p.link ? p.link : null;
  const imageUrl = p.image_url || '';
  const pinId = p.id || '';
  const createdDate = fmtDate(p.created_at_pinterest);

  if (mode === 'winning-pins') {
    const index = options.index ?? 0;
    const activeTimeframe = options.activeTimeframe || '24h';
    const deltaVal = Number(options.deltaVal || 0);
    const isSelected = Boolean(options.isSelected);
    const strategy = options.strategy || 'STEADY';
    const rankBadgeHtml = options.rankBadgeHtml ?? renderRankBadge(index);
    const strategyBadgeHtml = options.strategyBadgeHtml ?? renderStrategyBadge(strategy);
    const viralityRatio = saves > 0 ? ((repins / saves) * 100).toFixed(0) : '0';
    const accountDisplay = p.account_username ? `@${p.account_username}` : p.board_name ? `@${p.board_name}` : 'account';

    const tagsHtml = annotations.slice(0, 3).map((a: any) => {
      const name = typeof a === 'string' ? a : a?.name || '';
      if (!name) return '';
      return `
        <span class="inline-flex items-center text-[9.5px] bg-muted/80 text-muted-foreground px-2 py-0.5 rounded-md font-medium truncate max-w-[120px]" title="${escapeHtml(name)}">
          #${escapeHtml(name)}
        </span>
      `;
    }).join('');

    const moreTagsCount = annotations.length > 3 ? annotations.length - 3 : 0;

    return `
      <div class="group rounded-2xl border border-border bg-card overflow-hidden shadow-xs hover:shadow-md hover:border-primary/40 transition-all flex flex-col justify-between relative">
        <!-- Top Overlays: Rank Badge + Compare Checkbox -->
        <div class="absolute top-2.5 left-2.5 z-20 flex items-center gap-1.5">
          ${rankBadgeHtml}
          <span class="inline-flex items-center gap-1 text-[9.5px] font-extrabold px-2 py-0.5 rounded-lg bg-emerald-500/90 text-white shadow-2xs backdrop-blur-xs font-mono">
            +${fmtNumberFull(deltaVal)} <span class="text-[8.5px] opacity-90">${activeTimeframe}</span>
          </span>
        </div>

        <div class="absolute top-2.5 right-2.5 z-20 bg-background/90 backdrop-blur-xs rounded-xl px-2 py-1 border border-border/80 shadow-2xs flex items-center gap-1.5">
          <input
            type="checkbox"
            data-pin-compare="${escapeHtml(pinId)}"
            ${isSelected ? 'checked' : ''}
            class="rounded border-border text-primary focus:ring-primary h-3.5 w-3.5 cursor-pointer"
            id="compare-${escapeHtml(pinId)}"
          />
          <label for="compare-${escapeHtml(pinId)}" class="text-[10px] font-bold text-muted-foreground cursor-pointer select-none">Select</label>
        </div>

        <div>
          <!-- Image preview with hover zoom & Quick Peek Trigger -->
          <div class="relative w-full h-44 bg-muted/50 overflow-hidden flex items-center justify-center block cursor-pointer group/img" data-peek-trigger="${escapeHtml(pinId)}">
            ${imageUrl ? `
              <img
                src="${escapeHtml(imageUrl)}"
                alt="${escapeHtml(p.title || 'Pinterest Pin')}"
                loading="lazy"
                decoding="async"
                class="w-full h-full object-cover object-center group-hover/img:scale-105 transition-transform duration-300"
                onerror="this.style.display='none'; this.nextElementSibling.classList.remove('hidden');"
              />
              <div class="hidden absolute inset-0 flex items-center justify-center text-muted-foreground">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
              </div>
            ` : `
              <div class="flex items-center justify-center text-muted-foreground">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
              </div>
            `}
            
            <!-- Quick Peek Overlay Pill on Hover -->
            <div class="absolute inset-0 bg-black/30 opacity-0 group-hover/img:opacity-100 transition-opacity flex items-center justify-center backdrop-blur-2xs">
              <span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-background/90 text-foreground font-bold text-xs shadow-md border border-border">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
                <span>Quick Peek</span>
              </span>
            </div>

            ${category ? `
              <span class="absolute bottom-2.5 left-2.5 text-[9.5px] font-bold bg-background/90 backdrop-blur-xs text-foreground px-2 py-0.5 rounded-lg shadow-2xs max-w-[150px] truncate border border-border/40" title="${escapeHtml(category)}">
                ${escapeHtml(category)}
              </span>
            ` : ''}
          </div>

          <!-- Card Body -->
          <div class="p-4 space-y-2.5">
            <div class="flex flex-wrap items-center gap-1.5">
              ${strategyBadgeHtml}
              ${p.account_username ? `<span class="inline-flex items-center text-[9.5px] font-bold px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">@${escapeHtml(p.account_username)}</span>` : ''}
              ${p.canonical_pin_id ? '<span class="text-[9.5px] font-bold px-1.5 py-0.5 rounded-md bg-purple-500/10 text-purple-500 border border-purple-500/20">🧬 Cluster</span>' : ''}
            </div>

            <div>
              <h3
                class="text-xs font-bold text-foreground line-clamp-2 hover:text-primary transition-colors cursor-pointer"
                data-peek-trigger="${escapeHtml(pinId)}"
                title="${escapeHtml(p.title || 'Untitled Pin')}"
              >
                ${escapeHtml(p.title || `Pin ${p.pin_id}`)}
              </h3>
              <div class="text-[10px] text-muted-foreground mt-1 flex items-center justify-between">
                <span>Created: <strong class="text-foreground font-medium">${createdDate}</strong></span>
                <span class="text-[10px] font-mono text-muted-foreground">VR: <strong class="text-foreground">${viralityRatio}%</strong></span>
              </div>
            </div>

            <!-- Metrics Grid -->
            <div class="grid grid-cols-3 gap-1.5 pt-1">
              <div class="bg-muted/40 rounded-xl p-1.5 text-center border border-border/50">
                <span class="text-[9px] text-muted-foreground uppercase block font-bold">Saves</span>
                <span class="text-xs font-extrabold text-rose-500 font-mono">${fmtNumberFull(saves)}</span>
              </div>
              <div class="bg-muted/40 rounded-xl p-1.5 text-center border border-border/50">
                <span class="text-[9px] text-muted-foreground uppercase block font-bold">Repins</span>
                <span class="text-xs font-extrabold text-foreground font-mono">${fmtNumberFull(repins)}</span>
              </div>
              <div class="bg-muted/40 rounded-xl p-1.5 text-center border border-border/50">
                <span class="text-[9px] text-muted-foreground uppercase block font-bold">Velocity</span>
                <span class="text-xs font-extrabold text-emerald-500 font-mono">${velocity.toFixed(1)}/d</span>
              </div>
            </div>

            <!-- Compact Tag Row -->
            ${tagsHtml ? `
              <div class="flex flex-wrap items-center gap-1 pt-1">
                ${tagsHtml}
                ${moreTagsCount > 0 ? `<span class="text-[9px] text-muted-foreground font-bold px-1">+${moreTagsCount}</span>` : ''}
              </div>
            ` : ''}
          </div>
        </div>

        <!-- Footer link -->
        <div class="px-4 py-2.5 bg-muted/20 border-t border-border/60 flex items-center justify-between text-[11px] gap-2">
          <span class="text-muted-foreground text-[10.5px] truncate max-w-[110px] font-medium" title="${escapeHtml(accountDisplay)}">${escapeHtml(accountDisplay)}</span>
          <div class="flex items-center gap-2">
            ${destinationUrl ? `
              <a href="${escapeHtml(destinationUrl)}" target="_blank" rel="noopener noreferrer nofollow" class="text-[10.5px] font-medium text-muted-foreground hover:text-foreground hover:underline">
                Site ↗
              </a>
            ` : ''}
            <a href="${escapeHtml(pinterestUrl)}" target="_blank" rel="noopener noreferrer" class="font-bold text-primary hover:underline inline-flex items-center gap-1 text-[11px]">
              <span>Pinterest</span>
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            </a>
          </div>
        </div>
      </div>
    `;
  }

  if (mode === 'topics') {
    const stageBadgeHtml = options.stageBadgeHtml ?? renderStageBadge(p.stage, 'topics');
    const anomalyBadgeHtml = options.anomalyBadgeHtml ?? renderAnomalyBadge(p.anomaly);
    const detailsUrl = options.detailsUrlMaker
      ? options.detailsUrlMaker(p)
      : `/pinarchive/details?id=${encodeURIComponent(pinId)}`;

    const tagsHtml = annotations.slice(0, 3).map((a: any) => {
      const name = typeof a === 'string' ? a : a?.name || '';
      if (!name) return '';
      let targetUrl = '';
      if (typeof a === 'object' && a?.url) {
        targetUrl = `https://www.pinterest.com${a.url.startsWith('/') ? a.url : '/' + a.url}`;
      } else if (typeof a === 'object' && a?.idea_id) {
        targetUrl = `https://www.pinterest.com/ideas/${encodeURIComponent(name)}/${a.idea_id}/`;
      } else {
        targetUrl = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(name)}`;
      }

      return `
        <a
          href="${escapeHtml(targetUrl)}"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex items-center gap-1 text-[10px] bg-primary/10 hover:bg-primary/20 text-primary px-2 py-0.5 rounded-md font-medium truncate max-w-[120px] transition-colors"
          title="${escapeHtml(name)} (Pinterest Idea)"
        >
          <span class="truncate">${escapeHtml(name)}</span>
          <svg xmlns="http://www.w3.org/2000/svg" class="h-2.5 w-2.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </a>
      `;
    }).join('');

    const moreTagsCount = annotations.length > 3 ? annotations.length - 3 : 0;

    return `
      <div class="group rounded-2xl border border-border bg-card overflow-hidden shadow-xs hover:shadow-md hover:border-primary/40 transition-all flex flex-col justify-between relative">
        <div>
          <!-- Image preview -->
          <a href="${escapeHtml(detailsUrl)}" class="relative w-full h-44 bg-muted/50 overflow-hidden flex items-center justify-center block">
            ${imageUrl ? `
              <img
                src="${escapeHtml(imageUrl)}"
                alt="${escapeHtml(p.title || 'Pinterest Pin')}"
                loading="lazy"
                decoding="async"
                class="w-full h-full object-cover object-center group-hover:scale-105 transition-transform duration-300"
                onerror="this.style.display='none'; this.nextElementSibling.classList.remove('hidden');"
              />
              <div class="hidden absolute inset-0 flex items-center justify-center text-muted-foreground">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
              </div>
            ` : `
              <div class="flex items-center justify-center text-muted-foreground">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
              </div>
            `}
            ${category ? `
              <span class="absolute top-2.5 left-2.5 text-[10px] font-bold bg-background/90 backdrop-blur-xs text-foreground px-2 py-0.5 rounded-md shadow-xs max-w-[140px] truncate" title="${escapeHtml(category)}">
                ${escapeHtml(category)}
              </span>
            ` : ''}
          </a>

          <!-- Content -->
          <div class="p-4 space-y-2.5">
            <div class="flex flex-wrap items-center gap-1.5">
              ${stageBadgeHtml}
              ${anomalyBadgeHtml}
            </div>

            <div>
              <a href="${escapeHtml(detailsUrl)}" class="block group/link">
                <h3 class="text-xs font-bold text-foreground line-clamp-2 group-hover/link:text-primary transition-colors" title="${escapeHtml(p.title || 'Untitled Pin')}">
                  ${escapeHtml(p.title || `Pin ${p.pin_id}`)}
                </h3>
              </a>
              <div class="text-[10px] text-muted-foreground mt-1 flex items-center justify-between">
                <span>Created: <strong class="font-medium text-foreground">${createdDate}</strong></span>
                ${p.account_username ? `<span class="text-primary font-medium">@${escapeHtml(p.account_username)}</span>` : ''}
              </div>
            </div>

            <!-- Metrics Row (Full Numbers) -->
            <div class="grid grid-cols-3 gap-1.5 pt-1">
              <div class="bg-muted/40 rounded-xl p-2 text-center border border-border/40">
                <span class="text-[9px] text-muted-foreground uppercase block font-bold">Saves</span>
                <span class="text-xs font-bold text-rose-500 tabular-nums">${fmtNumberFull(saves)}</span>
              </div>
              <div class="bg-muted/40 rounded-xl p-2 text-center border border-border/40">
                <span class="text-[9px] text-muted-foreground uppercase block font-bold">Repins</span>
                <span class="text-xs font-bold text-foreground tabular-nums">${fmtNumberFull(repins)}</span>
              </div>
              <div class="bg-muted/40 rounded-xl p-2 text-center border border-border/40">
                <span class="text-[9px] text-muted-foreground uppercase block font-bold">Velocity</span>
                <span class="text-xs font-bold text-emerald-500 tabular-nums">${velocity.toFixed(1)}/d</span>
              </div>
            </div>

            <!-- Social & Tags -->
            ${shares > 0 ? `
              <div class="flex items-center gap-1 text-[10px] text-blue-500 font-medium">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                <span>${fmtNumberFull(shares)} shares</span>
              </div>
            ` : ''}

            ${tagsHtml ? `
              <div class="flex flex-wrap items-center gap-1 pt-1">
                ${tagsHtml}
                ${moreTagsCount > 0 ? `<span class="text-[9px] text-muted-foreground font-semibold">+${moreTagsCount}</span>` : ''}
              </div>
            ` : ''}
          </div>
        </div>

        <!-- Footer link -->
        <div class="px-4 py-2.5 bg-muted/20 border-t border-border/60 flex items-center justify-between text-[11px] gap-2">
          <span class="text-muted-foreground text-[10px] truncate max-w-[110px]" title="${escapeHtml(p.board_name || '')}">${p.board_name ? escapeHtml(p.board_name) : ''}</span>
          <div class="flex items-center gap-2 shrink-0">
            ${destinationUrl ? `
              <a href="${escapeHtml(destinationUrl)}" target="_blank" rel="noopener noreferrer nofollow" class="text-[10px] font-medium text-muted-foreground hover:text-foreground hover:underline">
                Visit Site ↗
              </a>
            ` : ''}
            <a href="${escapeHtml(pinterestUrl)}" target="_blank" rel="noopener noreferrer" class="font-semibold text-primary hover:underline inline-flex items-center gap-1">
              <span>View</span>
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            </a>
          </div>
        </div>
      </div>
    `;
  }

  // mode === 'account'
  const isChanged = Boolean(options.isChanged);
  const isSelected = Boolean(options.isSelected);
  const stageBadgeHtml = options.stageBadgeHtml ?? renderStageBadge(p.stage, 'account');
  const anomalyBadgeHtml = options.anomalyBadgeHtml ?? renderAnomalyBadge(p.anomaly);
  const deltaBadge = options.deltaBadgeHtml || '';
  const deltaRepinsBadge = options.deltaRepinsBadgeHtml || '';
  const username = options.username || '';
  const detailsUrl = options.detailsUrlMaker
    ? options.detailsUrlMaker(p)
    : `/pinarchive/details?id=${encodeURIComponent(pinId)}${username ? `&from_account=${encodeURIComponent(username)}` : ''}`;

  const tagsHtml = annotations.slice(0, 4).map((a: any) => {
    const name = typeof a === 'string' ? a : a?.name || '';
    if (!name) return '';
    let targetUrl = '';
    if (typeof a === 'object' && a?.url) {
      targetUrl = `https://www.pinterest.com${a.url.startsWith('/') ? a.url : '/' + a.url}`;
    } else if (typeof a === 'object' && a?.idea_id) {
      targetUrl = `https://www.pinterest.com/ideas/${encodeURIComponent(name)}/${a.idea_id}/`;
    } else {
      targetUrl = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(name)}`;
    }

    return `
      <a
        href="${escapeHtml(targetUrl)}"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex items-center gap-1 text-[10px] bg-primary/10 hover:bg-primary/20 text-primary px-2 py-0.5 rounded-md font-medium truncate max-w-[130px] transition-colors"
        title="${escapeHtml(name)} (Pinterest Idea)"
      >
        <span class="truncate">${escapeHtml(name)}</span>
        <svg xmlns="http://www.w3.org/2000/svg" class="h-2.5 w-2.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
      </a>
    `;
  }).join('');

  const moreTagsCount = annotations.length > 4 ? annotations.length - 4 : 0;

  return `
    <div class="group rounded-xl border ${isChanged ? 'bg-emerald-500/[0.06] border-emerald-500/30' : 'border-border bg-card'} overflow-hidden shadow-sm hover:shadow-md hover:border-primary/40 transition-all flex flex-col justify-between relative" data-pin-id="${escapeHtml(pinId)}">
      <div class="absolute top-2.5 right-2.5 z-20 bg-background/85 backdrop-blur-xs rounded-md p-1 border border-border/60 shadow-xs">
        <input type="checkbox" data-pin-id="${escapeHtml(pinId)}" data-pin-pinterest-id="${escapeHtml(p.pin_id)}" data-pin-saves="${saves}" class="pin-checkbox rounded border-border text-primary h-4 w-4 cursor-pointer" ${isSelected ? 'checked' : ''} />
      </div>
      ${isChanged ? '<span class="absolute top-2 left-2 h-2 w-2 rounded-full bg-emerald-500 z-10"></span>' : ''}
      <div>
        <!-- Image preview -->
        <a href="${escapeHtml(detailsUrl)}" class="relative w-full h-44 bg-muted/50 overflow-hidden flex items-center justify-center block">
          ${imageUrl ? `
            <img
              src="${escapeHtml(imageUrl)}"
              alt="${escapeHtml(p.title || 'Pinterest Pin')}"
              loading="lazy"
              decoding="async"
              class="w-full h-full object-cover object-center group-hover:scale-105 transition-transform duration-300"
              onerror="this.style.display='none'; this.nextElementSibling.classList.remove('hidden');"
            />
            <div class="hidden absolute inset-0 flex items-center justify-center text-muted-foreground">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
            </div>
          ` : `
            <div class="flex items-center justify-center text-muted-foreground">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
            </div>
          `}
          ${category ? `
            <span class="absolute top-2.5 left-2.5 text-[10px] font-bold bg-background/90 backdrop-blur-xs text-foreground px-2 py-0.5 rounded-md shadow-xs max-w-[140px] truncate" title="${escapeHtml(category)}">
              ${escapeHtml(category)}
            </span>
          ` : ''}
        </a>

        <!-- Content -->
        <div class="p-4 space-y-2.5">
          <div class="flex flex-wrap items-center gap-1.5">
            ${stageBadgeHtml}
            ${anomalyBadgeHtml}
          </div>

          <div>
            <a href="${escapeHtml(detailsUrl)}" class="block group/link">
              <h3 class="text-xs font-bold text-foreground line-clamp-2 group-hover/link:text-primary transition-colors" title="${escapeHtml(p.title || 'Untitled Pin')}">
                ${escapeHtml(p.title || `Pin ${p.pin_id}`)}
              </h3>
            </a>
            <div class="text-[10px] text-muted-foreground mt-0.5">
              Created: <span class="font-medium text-foreground">${createdDate}</span>
            </div>
          </div>

          <!-- Metrics Row with Saves + Delta and Repins + Delta -->
          <div class="grid grid-cols-3 gap-1.5 pt-1">
            <div class="bg-muted/40 rounded-lg p-1.5 text-center border border-border/40 flex flex-col justify-center items-center">
              <span class="text-[9px] text-muted-foreground uppercase block font-semibold">Saves</span>
              <div class="flex items-center justify-center gap-1 mt-0.5">
                <span class="text-xs font-bold text-rose-500">${fmtNumberFull(saves)}</span>
                ${deltaBadge}
              </div>
            </div>
            <div class="bg-muted/40 rounded-lg p-1.5 text-center border border-border/40 flex flex-col justify-center items-center">
              <span class="text-[9px] text-muted-foreground uppercase block font-semibold">Repins</span>
              <div class="flex items-center justify-center gap-1 mt-0.5">
                <span class="text-xs font-bold text-foreground">${fmtNumberFull(repins)}</span>
                ${deltaRepinsBadge}
              </div>
            </div>
            <div class="bg-muted/40 rounded-lg p-1.5 text-center border border-border/40 flex flex-col justify-center items-center">
              <span class="text-[9px] text-muted-foreground uppercase block font-semibold">Velocity</span>
              <span class="text-xs font-bold text-emerald-500 mt-0.5">${velocity.toFixed(1)}/d</span>
            </div>
          </div>

          <!-- Social & Tags -->
          ${shares > 0 ? `
            <div class="flex items-center gap-1 text-[10px] text-blue-500 font-medium">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
              <span>${fmtNumberFull(shares)} shares</span>
            </div>
          ` : ''}

          ${tagsHtml ? `
            <div class="flex flex-wrap items-center gap-1 pt-1">
              ${tagsHtml}
              ${moreTagsCount > 0 ? `<span class="text-[9px] text-muted-foreground font-semibold">+${moreTagsCount}</span>` : ''}
            </div>
          ` : ''}
        </div>
      </div>

      <!-- Footer link -->
      <div class="px-4 py-2.5 bg-muted/20 border-t border-border/60 flex items-center justify-between text-[11px] gap-2">
        <span class="text-muted-foreground text-[10px] truncate max-w-[100px]">${p.board_name ? escapeHtml(p.board_name) : ''}</span>
        <div class="flex items-center gap-2">
          ${destinationUrl ? `
            <a href="${escapeHtml(destinationUrl)}" target="_blank" rel="noopener noreferrer nofollow" class="text-[10px] font-medium text-muted-foreground hover:text-foreground hover:underline">
              Visit Site ↗
            </a>
          ` : ''}
          <a href="${escapeHtml(pinterestUrl)}" target="_blank" rel="noopener noreferrer" class="font-semibold text-primary hover:underline inline-flex items-center gap-1">
            <span>View on Pinterest</span>
            <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          </a>
        </div>
      </div>
    </div>
  `;
}
