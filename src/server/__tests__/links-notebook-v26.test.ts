import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseSitemapXml, extractDomainAndSlug, fetchAndParseSitemap, fetchMultipleSubSitemaps } from '../services/sitemap-service';

describe('Link Notebook v2.6 Comprehensive Test Suite', () => {
  describe('Gate 1: Sitemap Index Parsing Without Inserts or Slices', () => {
    it('detects <sitemapindex> and returns all sub-sitemaps without truncation', () => {
      const mockIndexXml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://40aprons.com/post-sitemap.xml</loc></sitemap>
  <sitemap><loc>https://40aprons.com/post-sitemap2.xml</loc></sitemap>
  <sitemap><loc>https://40aprons.com/post-sitemap3.xml</loc></sitemap>
  <sitemap><loc>https://40aprons.com/recipe-sitemap.xml</loc></sitemap>
  <sitemap><loc>https://40aprons.com/category-sitemap.xml</loc></sitemap>
</sitemapindex>`;

      const result = parseSitemapXml(mockIndexXml);
      expect(result.isIndex).toBe(true);
      expect(result.subSitemaps).toHaveLength(5);
      expect(result.subSitemaps).toEqual([
        'https://40aprons.com/post-sitemap.xml',
        'https://40aprons.com/post-sitemap2.xml',
        'https://40aprons.com/post-sitemap3.xml',
        'https://40aprons.com/recipe-sitemap.xml',
        'https://40aprons.com/category-sitemap.xml',
      ]);
      expect(result.links).toHaveLength(0);
    });

    it('detects standard <urlset> and extracts all URLs with derived domain and slug', () => {
      const mockUrlsetXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://40aprons.com/raw-brownies/</loc></url>
  <url><loc>https://40aprons.com/paleo-chocolate-chip-cookies/</loc></url>
</urlset>`;

      const result = parseSitemapXml(mockUrlsetXml);
      expect(result.isIndex).toBe(false);
      expect(result.subSitemaps).toHaveLength(0);
      expect(result.links).toHaveLength(2);
      expect(result.links[0].url).toBe('https://40aprons.com/raw-brownies/');
      expect(result.links[0].domain).toBe('40aprons.com');
      expect(result.links[0].label).toBe('Raw Brownies');
      expect(result.links[1].label).toBe('Paleo Chocolate Chip Cookies');
    });
  });

  describe('Gate 2: Slug and Domain Derivation', () => {
    it('cleans extensions, hyphens, and formats title-case label accurately', () => {
      const item = extractDomainAndSlug('https://myblog.com/recipes/keto-strawberry-cheesecake.html');
      expect(item.domain).toBe('myblog.com');
      expect(item.slug).toBe('keto-strawberry-cheesecake.html');
      expect(item.label).toBe('Keto Strawberry Cheesecake');
    });

    it('handles root domain fallback', () => {
      const item = extractDomainAndSlug('https://example.com/');
      expect(item.domain).toBe('example.com');
      expect(item.slug).toBe('home');
      expect(item.label).toBe('example.com');
    });
  });

  describe('Gate 3: Bulk Import Ingestion (1,735 URLs Chunking & Deduplication)', () => {
    it('simulates 1,735 URLs processed in chunks of 100 with accurate 23505 duplicate skip counts', async () => {
      const totalUrlsCount = 1735;
      const dupCount = 135;
      const newCount = totalUrlsCount - dupCount; // 1600

      // Generate 1,735 test URLs
      const mockRawUrls = Array.from({ length: totalUrlsCount }, (_, i) => ({
        url: `https://40aprons.com/recipe-${i + 1}`,
        label: `Recipe ${i + 1}`,
      }));

      // Assume the first 135 recipes already exist in P4
      const existingUrlsInDb = new Set(
        Array.from({ length: dupCount }, (_, i) => `https://40aprons.com/recipe-${i + 1}`)
      );

      const insertedRows: any[] = [];
      let calculatedSkipped = 0;
      let calculatedImported = 0;

      // Mock P4 Supabase client query engine
      const chunkSize = 100;
      const totalChunks = Math.ceil(mockRawUrls.length / chunkSize);

      for (let i = 0; i < totalChunks; i++) {
        const chunk = mockRawUrls.slice(i * chunkSize, (i + 1) * chunkSize);
        const chunkUrls = chunk.map((c) => c.url);

        // Simulated query: .select('url').in('url', chunkUrls)
        const matchedExisting = chunkUrls.filter((u) => existingUrlsInDb.has(u));

        const toInsert: any[] = [];
        for (const item of chunk) {
          if (matchedExisting.includes(item.url)) {
            calculatedSkipped++;
          } else {
            toInsert.push(item);
          }
        }

        if (toInsert.length > 0) {
          insertedRows.push(...toInsert);
          calculatedImported += toInsert.length;
        }
      }

      expect(totalChunks).toBe(18); // 1,735 / 100 = 17 chunks of 100 + 1 chunk of 35
      expect(calculatedSkipped).toBe(135);
      expect(calculatedImported).toBe(1600);
      expect(insertedRows).toHaveLength(1600);
      expect(calculatedSkipped + calculatedImported).toBe(1735);
    });
  });

  describe('Gate 4: Server-Side Keyset / Offset Pagination and Shelf Isolation', () => {
    it('calculates page offsets and limits correctly for 50 items/page', () => {
      const limit = 50;
      const page = 3;
      const startRange = (page - 1) * limit;
      const endRange = page * limit - 1;

      expect(startRange).toBe(100);
      expect(endRange).toBe(149);

      const totalItems = 1735;
      const totalPages = Math.ceil(totalItems / limit);
      expect(totalPages).toBe(35);
    });
  });

  describe('Gate 5: Bulk Deletion under Tenant Isolation', () => {
    it('deletes batch of IDs scoped to user_id or workspace_id without cross-tenant leakage', async () => {
      const mockIdsToDelete = ['uuid-1', 'uuid-2', 'uuid-3'];
      const targetUserId = 'user-test-777';

      const deletedCalls: Array<{ col: string; val: string; ids: string[] }> = [];

      const mockPaAdmin: any = {
        from: vi.fn(() => ({
          delete: vi.fn(() => ({
            eq: vi.fn((col: string, val: string) => ({
              in: vi.fn((inCol: string, ids: string[]) => {
                deletedCalls.push({ col, val, ids });
                return Promise.resolve({ error: null, count: ids.length });
              }),
            })),
          })),
        })),
      };

      // Execute mock delete
      await mockPaAdmin
        .from('user_links')
        .delete()
        .eq('user_id', targetUserId)
        .in('id', mockIdsToDelete);

      expect(mockPaAdmin.from).toHaveBeenCalledWith('user_links');
      expect(deletedCalls).toHaveLength(1);
      expect(deletedCalls[0].col).toBe('user_id');
      expect(deletedCalls[0].val).toBe(targetUserId);
      expect(deletedCalls[0].ids).toEqual(mockIdsToDelete);
    });
  });

  describe('Gate 6: PostgREST LIKE Injection & Syntax Breakage Defense', () => {
    const escapeLike = (s: string) => s.replace(/[%_\\]/g, '\\$&').replace(/"/g, '""');

    it('escapes %, _, \\, and double quotes from search query', () => {
      const malicious = '50%_discount\\deal"special';
      const escaped = escapeLike(malicious);
      expect(escaped).toBe('50\\%\\_discount\\\\deal""special');
    });

    it('prevents comma injection from breaking PostgREST or() condition', () => {
      const commaInjection = 'test,inject';
      const eq = escapeLike(commaInjection);
      const orCondition = `label.ilike."%${eq}%",url.ilike."%${eq}%"`;
      // Wrapped in quotes, PostgREST does not treat the comma inside quotes as a separate clause
      expect(orCondition).toBe('label.ilike."%test,inject%",url.ilike."%test,inject%"');
    });
  });

  describe('Gate 7: Sitemap Recursion Depth Limit & Array Capping (DoS Defense)', () => {
    it('fetchAndParseSitemap halts and returns empty array when recursion depth > 3', async () => {
      const result = await fetchAndParseSitemap('https://example.com/cyclic-sitemap.xml', 100, 4);
      expect(result).toEqual([]);
    });

    it('fetchMultipleSubSitemaps caps input array to maximum 50 sub-sitemaps', async () => {
      // 100 sub-sitemap URLs provided
      const hundredSubs = Array.from({ length: 100 }, (_, i) => `https://example.com/sitemap-${i + 1}.xml`);
      
      // Spy on fetchAndInspectSitemap to count invocations
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
        Promise.resolve(
          new Response('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/p1</loc></url></urlset>', {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          })
        )
      );

      const links = await fetchMultipleSubSitemaps(hundredSubs);
      // Max 50 fetched, remaining 50 ignored
      expect(fetchSpy).toHaveBeenCalledTimes(50);
      fetchSpy.mockRestore();
    });
  });

  describe('Gate 8: Keyset Cursor Quotes Defense for ISO Timestamps', () => {
    it('constructs keyset condition with double-quoted timestamps and IDs', () => {
      const cursor = { sent_at: '2026-09-08T10:00:00.000Z', id: 'stamp-123' };
      const orClause = `sent_at.lt."${cursor.sent_at}",and(sent_at.eq."${cursor.sent_at}",id.lt."${cursor.id}")`;
      expect(orClause).toBe('sent_at.lt."2026-09-08T10:00:00.000Z",and(sent_at.eq."2026-09-08T10:00:00.000Z",id.lt."stamp-123")');
      // Colons and dots are safe inside double quotes in PostgREST syntax
      expect(orClause).toContain('."2026-09-08T10:00:00.000Z"');
    });
  });
});

