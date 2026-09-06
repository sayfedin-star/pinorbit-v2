export const prerender = false;

import type { APIRoute } from 'astro';
import { dbClients } from '../../../server/db/clients';
import { assertWorkspaceAccess } from '../../../server/auth/workspace-guard';
import { fetchAndParseSitemap } from '../../../server/services/sitemap-service';
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
    // Admin Role Gate: sitemap import restricted to workspace admin/owner
    await assertWorkspaceAccess(p1Admin, workspaceId, user.id, 'admin');

    let body: any;
    try {
      body = await request.json();
    } catch {
      return json({ success: false, error: 'Malformed JSON.' }, 400);
    }

    const { sitemapUrl, scope, maxLinks } = body || {};
    if (!sitemapUrl || typeof sitemapUrl !== 'string') {
      return json({ success: false, error: 'sitemapUrl string is required.' }, 400);
    }

    const targetScope = scope === 'user' ? 'user' : 'workspace';
    const limit = Math.min(Math.max(Number(maxLinks) || 100, 1), 500);

    // Fetch and parse using SSRF Seven Gates + fast-xml-parser
    const links = await fetchAndParseSitemap(sitemapUrl.trim(), limit);

    if (links.length === 0) {
      return json({ success: true, imported: 0, skipped: 0, message: 'No valid URLs found in sitemap.' });
    }

    let importedCount = 0;
    let skippedCount = 0;

    if (targetScope === 'user') {
      for (const item of links) {
        const { error } = await paAdmin.from('user_links').insert({
          user_id: user.id,
          label: item.label,
          url: item.url,
          is_default: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });

        if (error) {
          if (error.code === '23505') {
            skippedCount++;
          } else {
            console.warn('[Sitemap] Insert error:', error.message);
          }
        } else {
          importedCount++;
        }
      }
    } else {
      for (const item of links) {
        const { error } = await paAdmin.from('workspace_links').insert({
          workspace_id: workspaceId,
          label: item.label,
          url: item.url,
          is_default: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });

        if (error) {
          if (error.code === '23505') {
            skippedCount++;
          } else {
            console.warn('[Sitemap] Insert error:', error.message);
          }
        } else {
          importedCount++;
        }
      }
    }

    return json({
      success: true,
      imported: importedCount,
      skipped: skippedCount,
      total_found: links.length,
      scope: targetScope,
    });
  } catch (err: any) {
    if (err instanceof HttpError) {
      return json({ success: false, error: err.message }, err.status);
    }
    return json({ success: false, error: err?.message || 'Server error.' }, 500);
  }
};
