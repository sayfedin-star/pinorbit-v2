import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildFinalLink, dispatchBulkStagedPins } from '../services/staged-service';
import { getAccountDefaults, setAccountDefault } from '../services/account-defaults-service';
import * as repurposeService from '../services/repurpose-service';

describe('Smart Domain-Swap & Account Defaults Suite (v2.9)', () => {
  const workspaceId = 'ws-swap-123';
  const userId = 'user-swap-456';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('buildFinalLink Engine', () => {
    it('Gate 1: Swaps domain while preserving pathname when chosen is root domain', () => {
      const res = buildFinalLink(
        'https://40aprons.com/15-canned-tuna-recipes/',
        'https://customdomain1.com/'
      );
      expect(res).toBe('https://customdomain1.com/15-canned-tuna-recipes/');
    });

    it('Gate 2: Supports bare domain without protocol and preserves query params and hash', () => {
      const res = buildFinalLink(
        'https://40aprons.com/15-canned-tuna-recipes/?tag=1&sort=asc#nutrition',
        'customdomain1.com'
      );
      expect(res).toBe('https://customdomain1.com/15-canned-tuna-recipes/?tag=1&sort=asc#nutrition');
    });

    it('Gate 3: Keeps chosen URL as-is when user provides an explicit specific path', () => {
      const res = buildFinalLink(
        'https://40aprons.com/15-canned-tuna-recipes/',
        'https://customdomain1.com/specific-subpage-landing/'
      );
      expect(res).toBe('https://customdomain1.com/specific-subpage-landing/');
    });

    it('Gate 4: Returns originalLink when chosen link is empty or null', () => {
      expect(buildFinalLink('https://40aprons.com/tuna-dish', '')).toBe('https://40aprons.com/tuna-dish');
      expect(buildFinalLink('https://40aprons.com/tuna-dish', null)).toBe('https://40aprons.com/tuna-dish');
    });

    it('Gate 5: Rejects SSRF malicious domains and ports', () => {
      expect(() =>
        buildFinalLink('https://40aprons.com/tuna', 'http://169.254.169.254/latest/meta-data')
      ).toThrow();
      expect(() =>
        buildFinalLink('https://40aprons.com/tuna', 'http://localhost:8080')
      ).toThrow();
    });

    it('Gate 6: Fallbacks to root domain URL when originalLink is empty or null', () => {
      expect(buildFinalLink('', 'test.com')).toBe('https://test.com/');
      expect(buildFinalLink(null, 'test.com')).toBe('https://test.com/');
      expect(buildFinalLink('', 'https://customdomain1.com/')).toBe('https://customdomain1.com/');
    });
  });

  describe('Account Defaults Service (AUTO-RULE)', () => {
    it('applies AUTO-RULE when exactly 1 unique domain exists across notebook links', async () => {
      const mockPaAdmin = {
        from: vi.fn((table: string) => {
          if (table === 'pa_account_default_sites') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockResolvedValue({ data: [], error: null }),
            };
          }
          if (table === 'user_links') {
            const userQueryResult: any = {
              data: [
                { url: 'https://40aprons.com/recipe-1' },
                { url: 'https://40aprons.com/recipe-2' },
              ],
              count: 2,
              error: null,
            };
            const queryObj: any = {
              eq: vi.fn().mockResolvedValue(userQueryResult),
              then: (resolve: any) => resolve(userQueryResult),
            };
            return {
              select: vi.fn().mockReturnValue(queryObj),
            };
          }
          if (table === 'workspace_links') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockResolvedValue({
                data: [{ url: 'https://40aprons.com/recipe-3' }],
                error: null,
              }),
            };
          }
          return {};
        }),
      } as any;

      const res = await getAccountDefaults(mockPaAdmin, workspaceId, userId);
      expect(res.domains).toEqual(['40aprons.com']);
      expect(res.singleDomain).toBe('40aprons.com');
      expect(res.defaults).toEqual({});
      expect(res.user_count).toBe(2);
      expect(res.domain_counts).toEqual({ '40aprons.com': 3 });
    });

    it('does not set singleDomain if multiple domains exist', async () => {
      const mockPaAdmin = {
        from: vi.fn((table: string) => {
          if (table === 'pa_account_default_sites') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockResolvedValue({ data: [{ account_id: 'acc-1', default_site: 'https://site1.com' }], error: null }),
            };
          }
          if (table === 'user_links') {
            const userQueryResult: any = {
              data: [
                { url: 'https://site1.com/a' },
                { url: 'https://site2.com/b' },
              ],
              count: 2,
              error: null,
            };
            const queryObj: any = {
              eq: vi.fn().mockResolvedValue(userQueryResult),
              then: (resolve: any) => resolve(userQueryResult),
            };
            return {
              select: vi.fn().mockReturnValue(queryObj),
            };
          }
          if (table === 'workspace_links') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockResolvedValue({ data: [], error: null }),
            };
          }
          return {};
        }),
      } as any;

      const res = await getAccountDefaults(mockPaAdmin, workspaceId);
      expect(res.domains).toEqual(['site1.com', 'site2.com']);
      expect(res.singleDomain).toBeNull();
      expect(res.defaults['acc-1']).toBe('https://site1.com');
    });

    it('sets and upserts account default site with SSRF check', async () => {
      const upsertMock = vi.fn().mockResolvedValue({ error: null });
      const mockPaAdmin = {
        from: vi.fn().mockReturnValue({
          upsert: upsertMock,
        }),
      } as any;

      const res = await setAccountDefault(mockPaAdmin, workspaceId, 'acc-1', 'https://customdomain1.com');
      expect(res.success).toBe(true);
      expect(res.defaultSite).toBe('https://customdomain1.com/');
      expect(upsertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          workspace_id: workspaceId,
          account_id: 'acc-1',
          default_site: 'https://customdomain1.com/',
        }),
        { onConflict: 'workspace_id,account_id' }
      );
    });
  });

  describe('dispatchBulkStagedPins', () => {
    it('dispatches multiple pins and handles partial success on CAS conflict', async () => {
      const mockPins: Record<string, any> = {
        'pin-1': {
          id: 'pin-1',
          workspace_id: workspaceId,
          pa_pin_id: 'pa-pin-10',
          title: 'Tuna Salad',
          original_link: 'https://40aprons.com/tuna-salad/',
          override_link: '',
          board_name: 'Salads',
          status: 'staged',
        },
        // pin-2 will fail CAS (already dispatched or deleted)
      };

      const mockPaAdmin = {
        from: vi.fn((table: string) => {
          if (table === 'pa_staged_pins') {
            return {
              update: vi.fn((updatePayload: any) => ({
                eq: vi.fn((col1: string, val1: string) => ({
                  eq: vi.fn((col2: string, val2: string) => ({
                    eq: vi.fn((col3: string, val3: string) => ({
                      select: vi.fn().mockReturnValue({
                        maybeSingle: vi.fn().mockResolvedValue({
                          data: mockPins[val1] || null,
                          error: null,
                        }),
                      }),
                    })),
                  })),
                })),
              })),
            };
          }
          return {};
        }),
      } as any;

      const spyRepurpose = vi.spyOn(repurposeService, 'executeRepurposeDispatch').mockResolvedValue({
        success: true,
        summary: {
          batch_uuid: 'batch-bulk',
          total_stamps: 1,
          accounts_count: 1,
          pins_count: 1,
          skipped_duplicates: 0,
          excluded_no_image: 0,
          link_used: 'https://customdomain1.com/tuna-salad/',
          completed_at: new Date().toISOString(),
        },
      });

      const res = await dispatchBulkStagedPins(
        mockPaAdmin,
        {} as any,
        workspaceId,
        userId,
        ['pin-1', 'pin-2'],
        [
          {
            accountId: 'acc-1',
            accountLabel: 'Main Account',
            boardName: 'Salads',
            linkUrl: 'https://customdomain1.com/',
          },
        ]
      );

      expect(res.success).toBe(true);
      expect(res.succeeded).toEqual(['pin-1']);
      expect(res.failed).toHaveLength(1);
      expect(res.failed[0].id).toBe('pin-2');

      // Check smart domain swap on the dispatched pin
      expect(spyRepurpose).toHaveBeenCalledWith(
        mockPaAdmin,
        expect.anything(),
        expect.objectContaining({
          pinIds: ['pa-pin-10'],
          targets: [
            expect.objectContaining({
              customLink: 'https://customdomain1.com/tuna-salad/',
            }),
          ],
        })
      );
    });
  });
});
