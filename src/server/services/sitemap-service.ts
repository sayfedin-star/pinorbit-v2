import { XMLParser } from 'fast-xml-parser';
import { safeFetchText } from '../lib/ssrf-guard';
import { HttpError } from '../lib/http-error';

export interface ExtractedLink {
  url: string;
  domain: string;
  slug: string;
  label: string;
}

export function extractDomainAndSlug(rawUrl: string): ExtractedLink {
  const parsed = new URL(rawUrl);
  const domain = parsed.hostname;
  
  // Clean pathname
  const pathParts = parsed.pathname.split('/').filter(Boolean);
  const rawSlug = pathParts.length > 0 ? pathParts[pathParts.length - 1] : '';
  const cleanSlug = rawSlug
    .replace(/\.(html|php|asp|htm)$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();

  const label = cleanSlug.length > 0
    ? cleanSlug
        .split(' ')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ')
    : domain;

  return {
    url: parsed.toString(),
    domain,
    slug: rawSlug || 'home',
    label,
  };
}

export async function fetchAndParseSitemap(sitemapUrl: string, maxLinks: number = 500): Promise<ExtractedLink[]> {
  const xmlText = await safeFetchText(sitemapUrl);
  
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: true,
    trimValues: true,
  });

  let parsed: any;
  try {
    parsed = parser.parse(xmlText);
  } catch (err: any) {
    throw new HttpError(422, `Failed to parse XML sitemap: ${err.message}`);
  }

  const linksMap = new Map<string, ExtractedLink>();

  // 1. Direct urlset (<urlset><url><loc>...</loc></url></urlset>)
  if (parsed.urlset && parsed.urlset.url) {
    const urls = Array.isArray(parsed.urlset.url) ? parsed.urlset.url : [parsed.urlset.url];
    for (const item of urls) {
      if (linksMap.size >= maxLinks) break;
      const loc = typeof item === 'string' ? item : item?.loc;
      if (loc && typeof loc === 'string') {
        try {
          const link = extractDomainAndSlug(loc.trim());
          linksMap.set(link.url, link);
        } catch {
          // ignore malformed loc URLs
        }
      }
    }
  }

  // 2. Sitemap index (<sitemapindex><sitemap><loc>...</loc></sitemap></sitemapindex>)
  if (parsed.sitemapindex && parsed.sitemapindex.sitemap && linksMap.size < maxLinks) {
    const sitemaps = Array.isArray(parsed.sitemapindex.sitemap)
      ? parsed.sitemapindex.sitemap
      : [parsed.sitemapindex.sitemap];

    // Fetch up to 3 child sitemaps to prevent excessive execution
    const childSitemaps = sitemaps.slice(0, 3);
    for (const child of childSitemaps) {
      if (linksMap.size >= maxLinks) break;
      const childLoc = typeof child === 'string' ? child : child?.loc;
      if (childLoc && typeof childLoc === 'string') {
        try {
          const childLinks = await fetchAndParseSitemap(childLoc.trim(), maxLinks - linksMap.size);
          for (const l of childLinks) {
            linksMap.set(l.url, l);
            if (linksMap.size >= maxLinks) break;
          }
        } catch (childErr) {
          console.warn(`[Sitemap] Skipping child sitemap ${childLoc}:`, childErr);
        }
      }
    }
  }

  return Array.from(linksMap.values());
}
