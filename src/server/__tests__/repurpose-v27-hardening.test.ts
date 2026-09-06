import { describe, it, expect, vi } from 'vitest';
import { executeRepurposeDispatch } from '../services/repurpose-service';

describe('v2.7 Hardening: Chunk Pre-Flight Abort & Self-Compensation', () => {
  it('aborts dispatch and cleans up pins if batch status changes between chunks', async () => {
    let checkCount = 0;
    let p1DeletedIds: string[] = [];

    const mockPaAdmin: any = {
      from: vi.fn((table: string) => {
        if (table === 'pa_repurpose_batches') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockImplementation(() => {
              checkCount++;
              // First call: initial check -> returns null (new batch)
              if (checkCount === 1) return Promise.resolve({ data: null });
              // Second call: pre-flight check before chunk 1 -> status is 'in_progress'
              if (checkCount === 2) return Promise.resolve({ data: { status: 'in_progress' } });
              // Third call: pre-flight check before chunk 2 -> status was revoked/lost to 'cancelled'
              return Promise.resolve({ data: { status: 'cancelled' } });
            }),
            insert: vi.fn().mockResolvedValue({ error: null }),
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ error: null }),
            }),
          };
        }
        if (table === 'pa_pin_dispatches') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            then: vi.fn((resolve) => resolve({ data: [], error: null })),
            insert: vi.fn().mockResolvedValue({ error: null }),
            delete: vi.fn().mockReturnValue({
              in: vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValue({ error: null }),
              }),
            }),
          };
        }
        if (table === 'pa_pins') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockImplementation(() =>
              Promise.resolve({
                data: pinIds.map((id) => ({
                  id,
                  title: 'Pin Title',
                  description: 'Pin Desc',
                  image_url: 'https://example.com/image.jpg',
                  link: 'https://example.com/source',
                  board_name: 'Source Board',
                  account_id: 'acc-src',
                })),
                error: null,
              })
            ),
          };
        }
        return {};
      }),
    };

    const mockP1Admin: any = {
      from: vi.fn((table: string) => {
        if (table === 'pins') {
          return {
            insert: vi.fn().mockResolvedValue({ error: null }),
            delete: vi.fn().mockImplementation(() => ({
              in: vi.fn().mockImplementation((col: string, ids: string[]) => {
                p1DeletedIds = ids;
                return {
                  eq: vi.fn().mockResolvedValue({ error: null }),
                };
              }),
            })),
          };
        }
        return {};
      }),
    };

    // 70 pins with 1 target -> 2 chunks (CHUNK_SIZE = 50: chunk 1 = 50 pins, chunk 2 = 20 pins)
    const pinIds = Array.from({ length: 70 }, (_, i) => `pin-${i + 1}`);

    await expect(
      executeRepurposeDispatch(mockPaAdmin, mockP1Admin, {
        batchUuid: 'batch-chunk-abort-test',
        workspaceId: 'ws-1',
        userId: 'user-1',
        pinIds,
        targets: [{ accountId: 'acc-1', accountLabel: 'Acc 1', boardName: 'Board 1' }],
      })
    ).rejects.toMatchObject({
      status: 409,
      options: { code: 'batch_ownership_lost' },
    });

    // Verify self-compensation deleted P1 pins
    expect(p1DeletedIds.length).toBe(70);
  });
});

describe('v2.7 Hardening: Combobox Link Selector Filter Logic (1,735 links)', () => {
  // Pure logic replica of the combobox filter algorithm used in RepurposeModal.astro
  function filterAndSortLinks(
    notebookLinks: Array<{ label: string; url: string; domain?: string; slug?: string; scope: string; is_default?: boolean }>,
    searchQuery: string,
    domainFilter: string,
    shelfFilter: string,
    maxDisplay = 50
  ) {
    const q = searchQuery.trim().toLowerCase().replace(/\.html$/i, '');
    const dom = domainFilter.trim().toLowerCase();
    const shelf = shelfFilter.toLowerCase();

    const filtered = notebookLinks.filter((item) => {
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

    return {
      totalMatches: filtered.length,
      capped: filtered.slice(0, maxDisplay),
      isCapped: filtered.length > maxDisplay,
    };
  }

  // Generate 1,735 realistic mock links
  const mock1735Links = Array.from({ length: 1735 }, (_, i) => {
    const isDefault = i === 42; // Link #42 is default star link
    const domain = i % 3 === 0 ? 'example.com' : i % 3 === 1 ? 'mybrand.org' : 'pinorbit.app';
    const scope = i % 2 === 0 ? 'user' : 'workspace';
    const slug = `post-${i + 1}-slug`;
    const label = i === 10 ? 'Special Delicious Recipe' : `Marketing Article ${i + 1}`;
    const url = `https://${domain}/articles/${slug}.html`;
    return { label, url, domain, slug, scope, is_default: isDefault };
  });

  it('caps 1,735 unfiltered links at max 50 items', () => {
    const result = filterAndSortLinks(mock1735Links, '', '', 'all', 50);
    expect(result.totalMatches).toBe(1735);
    expect(result.capped.length).toBe(50);
    expect(result.isCapped).toBe(true);
  });

  it('places is_default star link at index 0 of results', () => {
    const result = filterAndSortLinks(mock1735Links, '', '', 'all', 50);
    expect(result.capped[0].is_default).toBe(true);
    expect(result.capped[0].slug).toBe('post-43-slug');
  });

  it('filters by search query matching label (e.g., "recipe")', () => {
    const result = filterAndSortLinks(mock1735Links, 'recipe', '', 'all', 50);
    expect(result.totalMatches).toBe(1);
    expect(result.capped[0].label).toBe('Special Delicious Recipe');
    expect(result.isCapped).toBe(false);
  });

  it('filters by search query matching slug without .html extension', () => {
    const result = filterAndSortLinks(mock1735Links, 'post-100-slug', '', 'all', 50);
    expect(result.totalMatches).toBe(1);
    expect(result.capped[0].slug).toBe('post-100-slug');
  });

  it('filters by domain strictly', () => {
    const result = filterAndSortLinks(mock1735Links, '', 'mybrand.org', 'all', 50);
    expect(result.totalMatches).toBeGreaterThan(500);
    expect(result.capped.every((l) => l.domain === 'mybrand.org')).toBe(true);
    expect(result.capped.length).toBe(50);
  });

  it('filters by shelf scope (workspace only)', () => {
    const result = filterAndSortLinks(mock1735Links, '', '', 'workspace', 50);
    expect(result.capped.every((l) => l.scope === 'workspace')).toBe(true);
  });
});
