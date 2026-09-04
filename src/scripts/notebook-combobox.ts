export interface NotebookLink {
  id?: string;
  url: string;
  label?: string;
  domain?: string;
  slug?: string;
  scope?: 'user' | 'workspace' | string;
  is_default?: boolean;
}

export interface NotebookComboboxOptions {
  container: HTMLElement;
  links: NotebookLink[];
  selectedUrl?: string;
  placeholder?: string;
  serverTotal?: number;
  onSelect: (link: NotebookLink | null) => void;
}

export interface NotebookComboboxInstance {
  getSelectedLink: () => NotebookLink | null;
  setSelectedLink: (link: NotebookLink | null) => void;
  updateLinks: (links: NotebookLink[], serverTotal?: number) => void;
  setServerTotal: (total: number) => void;
  destroy: () => void;
}

function escapeHtml(str: string): string {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Creates an interactive Notebook Combobox instance inside the provided container.
 * Supports keyword search across label/url/slug, domain and shelf filtering,
 * capped 50 preview list, serverTotal support, and compact chip display.
 */
export function createNotebookCombobox(options: NotebookComboboxOptions): NotebookComboboxInstance {
  const { container, placeholder = 'Search label, url, or slug…', onSelect } = options;
  let allLinks = [...(options.links || [])];
  let serverTotal = options.serverTotal !== undefined ? options.serverTotal : allLinks.length;
  let selectedLink: NotebookLink | null = null;

  // Initialize selected link if provided
  if (options.selectedUrl) {
    selectedLink = allLinks.find((l) => l.url === options.selectedUrl) || {
      url: options.selectedUrl,
      label: options.selectedUrl,
      domain: '',
    };
  } else {
    // Check if any link has is_default
    const defLink = allLinks.find((l) => l.is_default);
    if (defLink) {
      selectedLink = defLink;
    }
  }

  // Render initial DOM
  container.innerHTML = `
    <div class="notebook-combobox-wrapper space-y-2 text-xs">
      <!-- Selected Link Chip -->
      <div class="nb-selected-chip ${selectedLink ? 'flex' : 'hidden'} items-center justify-between gap-2 p-2.5 rounded-xl border border-primary/30 bg-primary/5 text-xs">
        <div class="flex items-center gap-2 min-w-0">
          <span class="nb-chip-star text-amber-500 font-bold text-sm shrink-0">${selectedLink?.is_default ? '⭐' : '🔗'}</span>
          <div class="min-w-0">
            <div class="nb-chip-label font-semibold text-foreground truncate">${escapeHtml(selectedLink?.label || 'Selected Link')}</div>
            <div class="nb-chip-url font-mono text-[10px] text-muted-foreground truncate">${escapeHtml(selectedLink?.url || '')} ${selectedLink?.domain ? `(${escapeHtml(selectedLink.domain)})` : ''}</div>
          </div>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <button type="button" class="nb-chip-change-btn text-[11px] text-primary hover:underline font-semibold cursor-pointer">Change</button>
          <button type="button" class="nb-chip-clear-btn text-muted-foreground hover:text-rose-500 p-1 cursor-pointer" title="Clear selection">✕</button>
        </div>
      </div>

      <!-- Combobox Picker Card -->
      <div class="nb-picker-card ${selectedLink ? 'hidden' : 'space-y-2'} rounded-xl border border-border bg-card p-3 shadow-xs">
        <!-- Filter controls -->
        <div class="flex flex-wrap items-center gap-2">
          <div class="relative flex-1 min-w-[130px]">
            <input
              type="text"
              class="nb-search-input w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary pl-7"
              placeholder="${escapeHtml(placeholder)}"
            />
            <svg xmlns="http://www.w3.org/2000/svg" class="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </div>

          <select class="nb-domain-filter rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer max-w-[130px]">
            <option value="">All Domains</option>
          </select>

          <select class="nb-shelf-filter rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer">
            <option value="all">All Shelves</option>
            <option value="user">🌐 Global</option>
            <option value="workspace">🏢 Workspace</option>
          </select>
        </div>

        <!-- Info / Capped notice -->
        <div class="flex items-center justify-between text-[11px] text-muted-foreground px-1">
          <span class="nb-results-count">0 links available</span>
          <span class="nb-cap-notice hidden text-amber-500 font-medium text-[10px]">Showing first 50 — narrow search</span>
        </div>

        <!-- Scrollable list -->
        <div class="nb-results-list max-h-48 overflow-y-auto space-y-1 divide-y divide-border/40 pr-1">
        </div>
      </div>
    </div>
  `;

  const chipEl = container.querySelector('.nb-selected-chip') as HTMLElement;
  const chipStar = container.querySelector('.nb-chip-star') as HTMLElement;
  const chipLabel = container.querySelector('.nb-chip-label') as HTMLElement;
  const chipUrl = container.querySelector('.nb-chip-url') as HTMLElement;
  const chipChangeBtn = container.querySelector('.nb-chip-change-btn') as HTMLElement;
  const chipClearBtn = container.querySelector('.nb-chip-clear-btn') as HTMLElement;

  const pickerCard = container.querySelector('.nb-picker-card') as HTMLElement;
  const searchInput = container.querySelector('.nb-search-input') as HTMLInputElement;
  const domainFilter = container.querySelector('.nb-domain-filter') as HTMLSelectElement;
  const shelfFilter = container.querySelector('.nb-shelf-filter') as HTMLSelectElement;
  const resultsCountEl = container.querySelector('.nb-results-count') as HTMLElement;
  const capNoticeEl = container.querySelector('.nb-cap-notice') as HTMLElement;
  const resultsList = container.querySelector('.nb-results-list') as HTMLElement;

  function populateDomains() {
    if (!domainFilter) return;
    const currentVal = domainFilter.value;
    domainFilter.innerHTML = '<option value="">All Domains</option>';
    const domSet = new Set<string>();
    for (const l of allLinks) {
      if (l.domain) domSet.add(l.domain);
    }
    Array.from(domSet).sort().forEach((dom) => {
      const opt = document.createElement('option');
      opt.value = dom;
      opt.textContent = dom;
      domainFilter.appendChild(opt);
    });
    if (domSet.has(currentVal)) {
      domainFilter.value = currentVal;
    }
  }

  function renderList() {
    if (!resultsList) return;

    const q = (searchInput?.value || '').trim().toLowerCase().replace(/\.html$/i, '');
    const dom = (domainFilter?.value || '').trim().toLowerCase();
    const shelf = (shelfFilter?.value || 'all').toLowerCase();

    let filtered = allLinks.filter((item) => {
      if (shelf !== 'all' && item.scope !== shelf) return false;
      if (dom && (item.domain || '').toLowerCase() !== dom) return false;

      if (q) {
        const normLabel = (item.label || '').toLowerCase().replace(/\.html$/i, '');
        const normUrl = (item.url || '').toLowerCase().replace(/\.html$/i, '');
        const normSlug = (item.slug || '').toLowerCase().replace(/\.html$/i, '');
        if (!normLabel.includes(q) && !normUrl.includes(q) && !normSlug.includes(q)) {
          return false;
        }
      }
      return true;
    });

    filtered.sort((a, b) => {
      if (a.is_default && !b.is_default) return -1;
      if (!a.is_default && b.is_default) return 1;
      return (a.label || '').localeCompare(b.label || '');
    });

    const hasFilter = Boolean(q || dom || shelf !== 'all');
    const totalMatches = filtered.length;
    const effectiveTotal = hasFilter ? totalMatches : Math.max(serverTotal, allLinks.length);
    const capped = filtered.slice(0, 50);

    if (resultsCountEl) {
      resultsCountEl.textContent = `${capped.length} of ${effectiveTotal} links`;
    }
    if (capNoticeEl) {
      if (totalMatches > 50) {
        capNoticeEl.textContent = 'Showing first 50 — narrow search';
        capNoticeEl.classList.remove('hidden');
      } else if (!hasFilter && allLinks.length < serverTotal) {
        capNoticeEl.textContent = `Loaded first ${allLinks.length} of ${serverTotal} — use search`;
        capNoticeEl.classList.remove('hidden');
      } else {
        capNoticeEl.classList.add('hidden');
      }
    }

    if (capped.length === 0) {
      resultsList.innerHTML = '<div class="p-3 text-center text-xs text-muted-foreground">No matching links found.</div>';
      return;
    }

    resultsList.innerHTML = capped.map((item) => {
      const isSelected = selectedLink && selectedLink.url === item.url;
      return `
        <div
          class="nb-item p-2 rounded-lg hover:bg-muted/50 transition-colors cursor-pointer flex items-center justify-between gap-2 ${isSelected ? 'bg-primary/10' : ''}"
          data-url="${escapeHtml(item.url)}"
        >
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              ${item.is_default ? '<span class="text-amber-500 font-bold text-xs shrink-0">⭐</span>' : ''}
              <span class="font-semibold text-foreground truncate text-xs">${escapeHtml(item.label || 'Link')}</span>
              <span class="text-[10px] px-1.5 py-0.2 rounded font-mono bg-muted text-muted-foreground shrink-0">${escapeHtml(item.domain || 'web')}</span>
            </div>
            <div class="font-mono text-[10px] text-muted-foreground truncate">${escapeHtml(item.url)}</div>
          </div>
          <button type="button" class="nb-select-btn text-[11px] font-semibold text-primary shrink-0 hover:underline">Select</button>
        </div>
      `;
    }).join('');

    resultsList.querySelectorAll('.nb-item').forEach((el) => {
      el.addEventListener('click', () => {
        const u = el.getAttribute('data-url');
        const match = allLinks.find((l) => l.url === u);
        if (match) {
          applySelection(match);
        }
      });
    });
  }

  function applySelection(link: NotebookLink | null) {
    selectedLink = link;

    if (link) {
      if (chipStar) chipStar.textContent = link.is_default ? '⭐' : '🔗';
      if (chipLabel) chipLabel.textContent = link.label || 'Selected Link';
      if (chipUrl) chipUrl.textContent = `${link.url} ${link.domain ? `(${link.domain})` : ''}`;

      chipEl?.classList.remove('hidden');
      chipEl?.classList.add('flex');
      pickerCard?.classList.add('hidden');
    } else {
      chipEl?.classList.add('hidden');
      chipEl?.classList.remove('flex');
      pickerCard?.classList.remove('hidden');
    }

    renderList();
    onSelect(selectedLink);
  }

  // Event handlers
  chipChangeBtn?.addEventListener('click', () => {
    pickerCard?.classList.remove('hidden');
    searchInput?.focus();
  });

  chipClearBtn?.addEventListener('click', () => {
    applySelection(null);
  });

  searchInput?.addEventListener('input', renderList);
  domainFilter?.addEventListener('change', renderList);
  shelfFilter?.addEventListener('change', renderList);

  populateDomains();
  renderList();

  // If initially selected, trigger onSelect so parent has it recorded
  if (selectedLink) {
    onSelect(selectedLink);
  }

  return {
    getSelectedLink: () => selectedLink,
    setSelectedLink: (link: NotebookLink | null) => {
      applySelection(link);
    },
    updateLinks: (newLinks: NotebookLink[], newServerTotal?: number) => {
      allLinks = [...(newLinks || [])];
      if (newServerTotal !== undefined) {
        serverTotal = newServerTotal;
      } else {
        serverTotal = Math.max(serverTotal, allLinks.length);
      }
      populateDomains();
      renderList();
    },
    setServerTotal: (total: number) => {
      serverTotal = total;
      renderList();
    },
    destroy: () => {
      container.innerHTML = '';
    },
  };
}
