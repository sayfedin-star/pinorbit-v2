export const prerender = false;

import type { APIRoute } from 'astro';
import { dbClients } from '../../../server/db/clients';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { validateSafeUrl } from '../../../server/lib/ssrf-guard';
import { extractDomainAndSlug } from '../../../server/services/sitemap-service';
import { HttpError } from '../../../server/lib/http-error';

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
    // Admin Role Gate: link mutation restricted to workspace admin/owner
    await assertWorkspaceAccess(p1Admin, workspaceId, user.id, 'admin');

    let body: any;
    try {
      body = await request.json();
    } catch {
      return json({ success: false, error: 'Malformed JSON.' }, 400);
    }

    const { items, urls: legacyUrls, scope } = body || {};
    const rawList = Array.isArray(items) ? items : Array.isArray(legacyUrls) ? legacyUrls : [];

    if (rawList.length === 0) {
      return json({ success: false, error: 'No items provided for bulk import.' }, 400);
    }

    const targetScope = scope === 'user' ? 'user' : 'workspace';
    const targetTable = targetScope === 'user' ? 'user_links' : 'workspace_links';
    const filterCol = targetScope === 'user' ? 'user_id' : 'workspace_id';
    const filterVal = targetScope === 'user' ? user.id : workspaceId;

    // Deduplicate in-memory by valid URL
    const validatedMap = new Map<string, { url: string; label: string }>();

    for (const entry of rawList) {
      const rawUrl = typeof entry === 'string' ? entry : entry?.url;
      const rawLabel = typeof entry === 'object' ? entry?.label : undefined;

      if (!rawUrl || typeof rawUrl !== 'string') continue;

      try {
        const parsed = validateSafeUrl(rawUrl.trim());
        const normUrl = parsed.toString();
        const derived = extractDomainAndSlug(normUrl);
        const label = (rawLabel && typeof rawLabel === 'string' && rawLabel.trim().length > 0)
          ? rawLabel.trim()
          : derived.label;

        if (!validatedMap.has(normUrl)) {
          validatedMap.set(normUrl, { url: normUrl, label });
        }
      } catch {
        // Skip invalid non-http(s) or malformed URLs
      }
    }

    const uniqueEntries = Array.from(validatedMap.values());
    let importedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    // Process in honest chunks of 100
    const chunkSize = 100;
    for (let i = 0; i < uniqueEntries.length; i += chunkSize) {
      const chunk = uniqueEntries.slice(i, i + chunkSize);
      const chunkUrls = chunk.map((c) => c.url);

      const { data: existingRows } = await paAdmin
        .from(targetTable)
        .select('url')
        .eq(filterCol, filterVal)
        .in('url', chunkUrls);

      const existingSet = new Set((existingRows || []).map((r: any) => r.url));
      const toInsert: any[] = [];

      for (const item of chunk) {
        if (existingSet.has(item.url)) {
          skippedCount++;
        } else {
          toInsert.push({
            [filterCol]: filterVal,
            label: item.label,
            url: item.url,
            is_default: false,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
        }
      }

      if (toInsert.length > 0) {
        const { error: insertErr } = await paAdmin.from(targetTable).insert(toInsert);
        if (insertErr) {
          for (const row of toInsert) {
            const { error: singleErr } = await paAdmin.from(targetTable).insert(row);
            if (singleErr) {
              if (singleErr.code === '23505') skippedCount++;
              else failedCount++;
            } else {
              importedCount++;
            }
          }
        } else {
          importedCount += toInsert.length;
        }
      }
    }

    return json({
      success: true,
      imported: importedCount,
      skipped: skippedCount,
      failed: failedCount,
      total: uniqueEntries.length,
      scope: targetScope,
    });
  } catch (err: any) {
    if (err instanceof HttpError) {
      return json({ success: false, error: err.message }, err.status);
    }
    return json({ success: false, error: err?.message || 'Server error in bulk link import.' }, 500);
  }
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};
  const user = locals.user;
  const workspaceId = locals.activeWorkspaceId;

  if (!user || !workspaceId) {
    return json({ success: false, error: 'Unauthorized.' }, 401);
  }

  const p1Admin = dbClients.getSchedulingAdmin(runtimeEnv);
  const paAdmin = dbClients.getPinArchive(runtimeEnv);

  try {
    await assertWorkspaceAccess(p1Admin, workspaceId, user.id, 'admin');

    let body: any;
    try {
      body = await request.json();
    } catch {
      return json({ success: false, error: 'Malformed JSON.' }, 400);
    }

    const { ids, scope } = body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return json({ success: false, error: 'ids array is required.' }, 400);
    }

    const targetScope = scope === 'user' ? 'user' : 'workspace';
    const targetTable = targetScope === 'user' ? 'user_links' : 'workspace_links';
    const filterCol = targetScope === 'user' ? 'user_id' : 'workspace_id';
    const filterVal = targetScope === 'user' ? user.id : workspaceId;

    let totalDeleted = 0;
    const chunkSize = 100;

    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const { error, count } = await paAdmin
        .from(targetTable)
        .delete({ count: 'exact' })
        .eq(filterCol, filterVal)
        .in('id', chunk);

      if (error) {
        return json({ success: false, error: error.message }, 500);
      }
      totalDeleted += (count ?? chunk.length);
    }

    return json({
      success: true,
      deleted: totalDeleted,
      scope: targetScope,
    });
  } catch (err: any) {
    if (err instanceof HttpError) {
      return json({ success: false, error: err.message }, err.status);
    }
    return json({ success: false, error: err?.message || 'Server error in bulk link delete.' }, 500);
  }
};
