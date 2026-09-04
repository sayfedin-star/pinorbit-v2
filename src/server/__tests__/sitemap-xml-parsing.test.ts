import { describe, it, expect, vi, afterEach } from 'vitest';
import { extractDomainAndSlug, fetchAndParseSitemap } from '../services/sitemap-service';
import { HttpError } from '../lib/http-error';

describe('Sitemap XML Parsing & Slug Derivation Suite', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('extractDomainAndSlug', () => {
    it('extracts domain, slug and formats title-cased label from path', () => {
      const result = extractDomainAndSlug('https://myshop.com/products/summer-boho-dress.html');
      expect(result.domain).toBe('myshop.com');
      expect(result.slug).toBe('summer-boho-dress.html');
      expect(result.label).toBe('Summer Boho Dress');
    });

    it('handles root URL with home fallback', () => {
      const result = extractDomainAndSlug('https://example.com/');
      expect(result.domain).toBe('example.com');
      expect(result.slug).toBe('home');
      expect(result.label).toBe('example.com');
    });

    it('replaces underscores and hyphens in slug with spaces', () => {
      const result = extractDomainAndSlug('https://blog.pinorbit.com/recipes/healthy_keto-dinner-ideas');
      expect(result.label).toBe('Healthy Keto Dinner Ideas');
    });
  });

  describe('fetchAndParseSitemap', () => {
    it('parses standard urlset XML correctly', async () => {
      const mockXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/blog/first-post</loc>
    <lastmod>2026-01-01</lastmod>
  </url>
  <url>
    <loc>https://example.com/blog/second-post</loc>
    <lastmod>2026-01-02</lastmod>
  </url>
</urlset>`;

      global.fetch = vi.fn().mockResolvedValue(new Response(mockXml, { status: 200 }));

      const links = await fetchAndParseSitemap('https://example.com/sitemap.xml');
      expect(links).toHaveLength(2);
      expect(links[0].url).toBe('https://example.com/blog/first-post');
      expect(links[0].label).toBe('First Post');
      expect(links[1].url).toBe('https://example.com/blog/second-post');
      expect(links[1].label).toBe('Second Post');
    });

    it('parses nested sitemapindex with recursion cap', async () => {
      const indexXml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/sub-sitemap-1.xml</loc>
  </sitemap>
</sitemapindex>`;

      const subXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/shoes/running-sneakers</loc>
  </url>
</urlset>`;

      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('sitemap.xml')) {
          return Promise.resolve(new Response(indexXml, { status: 200 }));
        }
        return Promise.resolve(new Response(subXml, { status: 200 }));
      });

      const links = await fetchAndParseSitemap('https://example.com/sitemap.xml');
      expect(links).toHaveLength(1);
      expect(links[0].url).toBe('https://example.com/shoes/running-sneakers');
      expect(links[0].label).toBe('Running Sneakers');
    });

    it('returns empty array on non-XML text', async () => {
      global.fetch = vi.fn().mockResolvedValue(new Response('this is not xml', { status: 200 }));

      const links = await fetchAndParseSitemap('https://example.com/sitemap.xml');
      expect(links).toEqual([]);
    });
  });
});
