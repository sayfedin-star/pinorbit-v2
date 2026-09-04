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

export const GET: APIRoute = async ({ locals, url }) => {
  const runtimeEnv = (locals as any)?.runtime?.env || (locals as any)?.runtimeEnv || {};
  const user = locals.user;
  const workspaceId = locals.activeWorkspaceId;

  if (!user || !workspaceId) {
    return json({ success: false, error: 'Unauthorized.' }, 401);
  }

  const p1Admin = dbClients.getSchedulingAdmin(runtimeEnv);
  const paAdmin = dbClients.getPinArchive(runtimeEnv);

  try {
    await assertWorkspaceAccess(p1Admin, workspaceId, user.id, 'member');

    // Fetch user links (Global)
    const { data: userLinks } = await paAdmin
      .from('user_links')
      .select('*')
      .eq('user_id', user.id)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: false });

    // Fetch workspace links (Workspace scoped)
    const { data: wsLinks } = await paAdmin
      .from('workspace_links')
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: false });

    // Dynamically derive domain and slug for display (Condition 5)
    const formatLink = (item: any) => {
      try {
        const derived = extractDomainAndSlug(item.url);
        return { ...item, domain: derived.domain, slug: derived.slug };
      } catch {
        return { ...item, domain: '', slug: '' };
      }
    };

    return json({
      success: true,
      user_links: (userLinks || []).map(formatLink),
      workspace_links: (wsLinks || []).map(formatLink),
    });
  } catch (err: any) {
    if (err instanceof HttpError) {
      return json({ success: false, error: err.message }, err.status);
    }
    return json({ success: false, error: err?.message || 'Server error.' }, 500);
  }
};

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

    const { url: rawUrl, label: rawLabel, scope, isDefault } = body || {};
    if (!rawUrl || typeof rawUrl !== 'string') {
      return json({ success: false, error: 'url is required.' }, 400);
    }

    // SSRF Protocol & Format check
    const parsed = validateSafeUrl(rawUrl);
    const derived = extractDomainAndSlug(parsed.toString());
    const label = (rawLabel && typeof rawLabel === 'string' && rawLabel.trim().length > 0)
      ? rawLabel.trim()
      : derived.label;

    const targetScope = scope === 'user' ? 'user' : 'workspace';
    const makeDefault = Boolean(isDefault);

    if (targetScope === 'user') {
      // Clear previous user default if new default requested
      if (makeDefault) {
        await paAdmin
          .from('user_links')
          .update({ is_default: false, updated_at: new Date().toISOString() })
          .eq('user_id', user.id)
          .eq('is_default', true);
      }

      const { data, error } = await paAdmin
        .from('user_links')
        .insert({
          user_id: user.id,
          label,
          url: parsed.toString(),
          is_default: makeDefault,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select('*')
        .single();

      if (error) {
        if (error.code === '23505') {
          return json({ success: false, error: 'This URL already exists in your user links.' }, 409);
        }
        return json({ success: false, error: error.message }, 500);
      }

      return json({ success: true, link: { ...data, domain: derived.domain, slug: derived.slug } }, 201);
    } else {
      // Workspace scope
      if (makeDefault) {
        await paAdmin
          .from('workspace_links')
          .update({ is_default: false, updated_at: new Date().toISOString() })
          .eq('workspace_id', workspaceId)
          .eq('is_default', true);
      }

      const { data, error } = await paAdmin
        .from('workspace_links')
        .insert({
          workspace_id: workspaceId,
          label,
          url: parsed.toString(),
          is_default: makeDefault,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select('*')
        .single();

      if (error) {
        if (error.code === '23505') {
          return json({ success: false, error: 'This URL already exists in this workspace.' }, 409);
        }
        return json({ success: false, error: error.message }, 500);
      }

      return json({ success: true, link: { ...data, domain: derived.domain, slug: derived.slug } }, 201);
    }
  } catch (err: any) {
    if (err instanceof HttpError) {
      return json({ success: false, error: err.message }, err.status);
    }
    return json({ success: false, error: err?.message || 'Server error.' }, 500);
  }
};
