import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDashboardState } from '../controllers/state';
import { DashboardController, initPinArchiveDashboard } from '../controllers/dashboard-controller';

describe('PinArchive Dashboard Controller Suite', () => {
  it('creates initial DashboardState with correct defaults and preferences', () => {
    const state = createDashboardState();
    expect(state.rawAccounts).toEqual([]);
    expect(state.selectedAccounts.size).toBe(0);
    expect(state.competitorMap.size).toBe(0);
    expect(state.activeStatusTab).toBe('all');
    expect(state.selectedInterval).toBe('all');
    expect(state.accountSearchTerm).toBe('');
    expect(state.pageSize).toBe(50);
    expect(state.accountsCurrentPage).toBe(1);
    expect(state.canAdminSettings).toBe(true);
    expect(typeof state.isCompactNumbers).toBe('boolean');
    expect(typeof state.isCompactDensity).toBe('boolean');
    expect(typeof state.isSettingsExpanded).toBe('boolean');
    expect(typeof state.colVisible).toBe('object');
  });

  it('instantiates DashboardController with all 5 sub-controllers wired', () => {
    const controller = new DashboardController();
    expect(controller.state).toBeDefined();
    expect(controller.storeController).toBeDefined();
    expect(controller.overviewController).toBeDefined();
    expect(controller.settingsController).toBeDefined();
    expect(controller.bulkController).toBeDefined();
    expect(controller.accountsController).toBeDefined();
  });

  it('returns null safely in server / non-window environment', () => {
    const result = initPinArchiveDashboard();
    expect(result).toBeNull();
  });

  describe('DOM Environment', () => {
    let mockRoot: any;
    let originalDocument: any;

    beforeEach(() => {
      originalDocument = (globalThis as any).document;
      mockRoot = {
        getAttribute: vi.fn(),
        setAttribute: vi.fn(),
      };
      (globalThis as any).document = {
        readyState: 'complete',
        getElementById: vi.fn((id: string) => {
          if (id === 'pinarchive-page-root') return mockRoot;
          return null;
        }),
        querySelector: vi.fn(() => null),
        querySelectorAll: vi.fn(() => []),
        addEventListener: vi.fn(),
      };
    });

    afterEach(() => {
      (globalThis as any).document = originalDocument;
    });

    it('initializes root attribute and returns controller instance on first call', () => {
      mockRoot.getAttribute.mockReturnValue(null);
      const instance = initPinArchiveDashboard();
      expect(instance).toBeDefined();
      expect(mockRoot.setAttribute).toHaveBeenCalledWith('data-pa-initialized', 'true');
    });

    it('is idempotent under double-fire and skips re-initializing data-pa-initialized root', () => {
      mockRoot.getAttribute.mockReturnValue('true');
      const secondInstance = initPinArchiveDashboard();
      expect(secondInstance).toBeDefined();
      // Should not call setAttribute again
      expect(mockRoot.setAttribute).not.toHaveBeenCalled();
    });
  });
});
