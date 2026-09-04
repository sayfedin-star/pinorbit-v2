import { XMLParser } from 'fast-xml-parser';
import { safeFetchText } from '../lib/ssrf-guard';
import { HttpError } from '../lib/http-error';

export interface ExtractedLink {
  url: string;
  domain: string;
  slug: string;
  label: string;
}

export interface ParsedSitemapResult {
  isIndex: boolean;
  subSitemaps: string[];
  links: ExtractedLink[];
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

export function parseSitemapXml(xmlText: string): ParsedSitemapResult {
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: true,
    trimValues: true,
  });

  let parsed: any;
  try {
    parsed = parser.parse(xmlText);
  } catch (err: any) {
    return { isIndex: false, subSitemaps: [], links: [] };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { isIndex: false, subSitemaps: [], links: [] };
  }

  // 1. Sitemap index (<sitemapindex><sitemap><loc>...</loc></sitemap></sitemapindex>)
  if (parsed.sitemapindex && parsed.sitemapindex.sitemap) {
    const rawSitemaps = Array.isArray(parsed.sitemapindex.sitemap)
      ? parsed.sitemapindex.sitemap
      : [parsed.sitemapindex.sitemap];

    const subSitemaps: string[] = [];
    for (const item of rawSitemaps) {
      const loc = typeof item === 'string' ? item : item?.loc;
      if (loc && typeof loc === 'string' && loc.trim().length > 0) {
        subSitemaps.push(loc.trim());
      }
    }
    return { isIndex: true, subSitemaps, links: [] };
  }

  // 2. Direct urlset (<urlset><url><loc>...</loc></url></urlset>)
  const linksMap = new Map<string, ExtractedLink>();
  if (parsed.urlset && parsed.urlset.url) {
    const urls = Array.isArray(parsed.urlset.url) ? parsed.urlset.url : [parsed.urlset.url];
    for (const item of urls) {
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

  return { isIndex: false, subSitemaps: [], links: Array.from(linksMap.values()) };
}

export async function fetchAndInspectSitemap(url: string): Promise<ParsedSitemapResult> {
  const xmlText = await safeFetchText(url);
  return parseSitemapXml(xmlText);
}

export async function fetchMultipleSubSitemaps(subUrls: string[]): Promise<ExtractedLink[]> {
  const linksMap = new Map<string, ExtractedLink>();
  for (const subUrl of subUrls) {
    try {
      const inspected = await fetchAndInspectSitemap(subUrl);
      for (const link of inspected.links) {
        linksMap.set(link.url, link);
      }
    } catch (err) {
      console.warn(`[Sitemap] Skipping sub-sitemap ${subUrl}:`, err);
    }
  }
  return Array.from(linksMap.values());
}

export async function fetchAndParseSitemap(sitemapUrl: string, maxLinks: number = 500): Promise<ExtractedLink[]> {
  const inspected = await fetchAndInspectSitemap(sitemapUrl);
  if (!inspected.isIndex) {
    return inspected.links.slice(0, maxLinks);
  }

  const linksMap = new Map<string, ExtractedLink>();
  for (const childLoc of inspected.subSitemaps) {
    if (linksMap.size >= maxLinks) break;
    try {
      const childLinks = await fetchAndParseSitemap(childLoc, maxLinks - linksMap.size);
      for (const l of childLinks) {
        linksMap.set(l.url, l);
        if (linksMap.size >= maxLinks) break;
      }
    } catch (childErr) {
      console.warn(`[Sitemap] Skipping child sitemap ${childLoc}:`, childErr);
    }
  }

  return Array.from(linksMap.values());
}
