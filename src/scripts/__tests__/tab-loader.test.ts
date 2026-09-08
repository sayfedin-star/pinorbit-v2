import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  loadPanelModule,
  PANEL_MODULES,
  loadedPanels,
  resetLoadedPanels,
} from '../tabs';

describe('Analytics Tab Loader Suite', () => {
  beforeEach(() => {
    resetLoadedPanels();
    vi.restoreAllMocks();
  });

  it('initializes with "data" tab already marked as loaded', () => {
    expect(loadedPanels.has('data')).toBe(true);
    expect(loadedPanels.has('pipeline')).toBe(false);
    expect(loadedPanels.has('intelligence')).toBe(false);
    expect(loadedPanels.has('purge')).toBe(false);
  });

  it('does not invoke importer for the "data" tab', async () => {
    const mockDataImporter = vi.fn().mockResolvedValue({});
    const importer = { data: mockDataImporter };

    await loadPanelModule('data', importer);
    expect(mockDataImporter).not.toHaveBeenCalled();
    expect(loadedPanels.has('data')).toBe(true);
  });

  it('dynamically imports the corresponding module on first activation', async () => {
    const mockPipelineImporter = vi.fn().mockResolvedValue({ init: true });
    const importer = { pipeline: mockPipelineImporter };

    await loadPanelModule('pipeline', importer);
    expect(mockPipelineImporter).toHaveBeenCalledTimes(1);
    expect(loadedPanels.has('pipeline')).toBe(true);
  });

  it('does not re-import an already loaded tab module (deduplication)', async () => {
    const mockIntelImporter = vi.fn().mockResolvedValue({ init: true });
    const importer = { intelligence: mockIntelImporter };

    await loadPanelModule('intelligence', importer);
    expect(mockIntelImporter).toHaveBeenCalledTimes(1);
    expect(loadedPanels.has('intelligence')).toBe(true);

    // Second activation: should be a no-op
    await loadPanelModule('intelligence', importer);
    expect(mockIntelImporter).toHaveBeenCalledTimes(1);
  });

  it('handles import failure by logging warning, showing visible error, and allowing retry', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mockErrorImporter = vi.fn().mockRejectedValue(new Error('Network offline'));
    const importer = { purge: mockErrorImporter };

    // Setup minimal DOM for error rendering verification
    const dummyPanel = {
      id: 'panel-purge',
      querySelector: vi.fn().mockReturnValue(null),
      prepend: vi.fn(),
    };
    const dummyTab = {
      getAttribute: vi.fn().mockReturnValue('panel-purge'),
    };
    const originalDoc = (globalThis as any).document;
    (globalThis as any).document = {
      querySelector: vi.fn().mockReturnValue(dummyTab),
      getElementById: vi.fn().mockReturnValue(dummyPanel),
      createElement: vi.fn().mockReturnValue({
        className: '',
        textContent: '',
      }),
    };

    try {
      await loadPanelModule('purge', importer);

      expect(mockErrorImporter).toHaveBeenCalledTimes(1);
      // Crucial: failure must NOT mark tab as loaded
      expect(loadedPanels.has('purge')).toBe(false);
      expect(consoleWarnSpy).toHaveBeenCalled();
      expect(dummyPanel.prepend).toHaveBeenCalled();

      // Retry when network recovers
      mockErrorImporter.mockResolvedValueOnce({ ok: true });
      const dummyErrEl = { remove: vi.fn() };
      dummyPanel.querySelector.mockReturnValue(dummyErrEl);

      await loadPanelModule('purge', importer);
      expect(mockErrorImporter).toHaveBeenCalledTimes(2);
      expect(loadedPanels.has('purge')).toBe(true);
      expect(dummyErrEl.remove).toHaveBeenCalled();
    } finally {
      (globalThis as any).document = originalDoc;
    }
  });

  it('resets loaded panels state completely via resetLoadedPanels for test isolation', async () => {
    const importer = {
      pipeline: vi.fn().mockResolvedValue({}),
      purge: vi.fn().mockResolvedValue({}),
    };

    await loadPanelModule('pipeline', importer);
    await loadPanelModule('purge', importer);
    expect(loadedPanels.has('pipeline')).toBe(true);
    expect(loadedPanels.has('purge')).toBe(true);

    resetLoadedPanels();
    expect(loadedPanels.size).toBe(1);
    expect(loadedPanels.has('data')).toBe(true);
    expect(loadedPanels.has('pipeline')).toBe(false);
    expect(loadedPanels.has('purge')).toBe(false);
  });

  it('ignores unknown tabs gracefully', async () => {
    const importer = { pipeline: vi.fn().mockResolvedValue({}) };
    await loadPanelModule('non_existent_tab', importer);
    expect(loadedPanels.has('non_existent_tab')).toBe(false);
  });

  it('PANEL_MODULES defines pipeline, intelligence, and purge dynamic loaders', () => {
    expect(typeof PANEL_MODULES.pipeline).toBe('function');
    expect(typeof PANEL_MODULES.intelligence).toBe('function');
    expect(typeof PANEL_MODULES.purge).toBe('function');
  });
});
