export const prerender = false;

import type { APIRoute } from 'astro';
import { dbClients } from '../../../../server/db/clients';
import { assertWorkspaceAccess } from '../../../../server/auth/workspace-guard';
import { validateSafeUrl } from '../../../../server/lib/ssrf-guard';
import {
  fetchAndInspectSitemap,
  fetchMultipleSubSitemaps,
  type ExtractedLink,
} from '../../../../server/services/sitemap-service';
import { HttpError } from '../../../../server/lib/http-error';

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export const POST: APIRoute = async ({ request, locals }) => {
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};
  const user = locals.user;
  const workspaceId = locals.activeWorkspaceId;

  if (!user || !workspaceId) {
    return json({ success: false, error: 'Unauthorized.' }, 401);
  }

  const p1Admin = dbClients.getSchedulingAdmin(runtimeEnv);
  const paAdmin = dbClients.getPinArchive(runtimeEnv);

  try {
    // Member access is sufficient for reading / parsing sitemaps
    await assertWorkspaceAccess(p1Admin, workspaceId, user.id, 'member');

    let body: any;
    try {
      body = await request.json();
    } catch {
      return json({ success: false, error: 'Malformed JSON.' }, 400);
    }

    const { sitemapUrl, subSitemaps, scope } = body || {};
    const targetScope = scope === 'user' ? 'user' : 'workspace';
    const targetTable = targetScope === 'user' ? 'user_links' : 'workspace_links';
    const filterCol = targetScope === 'user' ? 'user_id' : 'workspace_id';
    const filterVal = targetScope === 'user' ? user.id : workspaceId;

    // Mode A: User selected specific sub-sitemaps from an index
    if (Array.isArray(subSitemaps) && subSitemaps.length > 0) {
      for (const subUrl of subSitemaps) {
        validateSafeUrl(subUrl);
      }

      const extractedLinks = await fetchMultipleSubSitemaps(subSitemaps);
      const duplicateInfo = await checkDuplicates(paAdmin, targetTable, filterCol, filterVal, extractedLinks);

      return json({
        success: true,
        is_index: false,
        urls: duplicateInfo.items,
        total_found: duplicateInfo.items.length,
        new_count: duplicateInfo.newCount,
        dup_count: duplicateInfo.dupCount,
        scope: targetScope,
      });
    }

    // Mode B: Single sitemap URL provided
    if (!sitemapUrl || typeof sitemapUrl !== 'string') {
      return json({ success: false, error: 'sitemapUrl or subSitemaps array is required.' }, 400);
    }

    validateSafeUrl(sitemapUrl.trim());
    const inspected = await fetchAndInspectSitemap(sitemapUrl.trim());

    if (inspected.isIndex) {
      return json({
        success: true,
        is_index: true,
        sub_sitemaps: inspected.subSitemaps,
        total_sub_sitemaps: inspected.subSitemaps.length,
        scope: targetScope,
      });
    }

    // Single standard urlset
    const duplicateInfo = await checkDuplicates(paAdmin, targetTable, filterCol, filterVal, inspected.links);

    return json({
      success: true,
      is_index: false,
      urls: duplicateInfo.items,
      total_found: duplicateInfo.items.length,
      new_count: duplicateInfo.newCount,
      dup_count: duplicateInfo.dupCount,
      scope: targetScope,
    });
  } catch (err: any) {
    if (err instanceof HttpError) {
      return json({ success: false, error: err.message }, err.status);
    }
    return json({ success: false, error: err?.message || 'Server error parsing sitemap.' }, 500);
  }
};

async function checkDuplicates(
  paAdmin: any,
  table: string,
  col: string,
  val: string,
  links: ExtractedLink[]
) {
  if (links.length === 0) {
    return { items: [], newCount: 0, dupCount: 0 };
  }

  const urls = links.map((l) => l.url);
  const existingSet = new Set<string>();

  const chunkSize = 500;
  for (let i = 0; i < urls.length; i += chunkSize) {
    const chunk = urls.slice(i, i + chunkSize);
    const { data } = await paAdmin
      .from(table)
      .select('url')
      .eq(col, val)
      .in('url', chunk);

    if (data) {
      for (const row of data) {
        existingSet.add(row.url);
      }
    }
  }

  let newCount = 0;
  let dupCount = 0;

  const items = links.map((l) => {
    const isDup = existingSet.has(l.url);
    if (isDup) dupCount++;
    else newCount++;
    return {
      url: l.url,
      label: l.label,
      domain: l.domain,
      is_duplicate: isDup,
    };
  });

  return { items, newCount, dupCount };
}
