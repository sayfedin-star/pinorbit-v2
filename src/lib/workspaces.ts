import { supabase, isSupabaseConfigured } from './supabase-client';
import { ACTIVE_WORKSPACE_COOKIE, DEFAULT_WORKSPACE_ID } from './constants/workspaces';
import type { Workspace } from './types';

export { ACTIVE_WORKSPACE_COOKIE, DEFAULT_WORKSPACE_ID } from './constants/workspaces';

export const DEFAULT_WORKSPACE: Workspace = {
  id: DEFAULT_WORKSPACE_ID,
  name: 'Default Workspace',
  slug: 'default',
  created_at: new Date('2026-08-01T00:00:00Z').toISOString(),
  updated_at: new Date('2026-08-01T00:00:00Z').toISOString(),
};

/**
 * Returns the constant Default Workspace ID.
 */
export function getDefaultWorkspaceId(): string {
  return DEFAULT_WORKSPACE_ID;
}

/**
 * Fetches all available workspaces for the current user/admin session.
 * Safe to call from Astro frontmatter (SSR) and client side.
 * In SSR, pass `Astro.locals.supabase` for authenticated request-scoped tenant isolation.
 */
export async function getWorkspaces(
  client?: any
): Promise<Workspace[]> {
  if (!isSupabaseConfigured) {
    return [DEFAULT_WORKSPACE];
  }

  let activeClient = (client && typeof client.from === 'function') ? client : supabase;

  if (!activeClient) {
    return [DEFAULT_WORKSPACE];
  }

  try {
    const { data, error } = await activeClient
      .from('workspaces')
      .select('*')
      .order('created_at', { ascending: true });

    if (error || !data || data.length === 0) {
      return [DEFAULT_WORKSPACE];
    }

    return data as Workspace[];
  } catch (err) {
    console.warn('Error fetching workspaces from Supabase, falling back to default:', err);
    return [DEFAULT_WORKSPACE];
  }
}

/**
 * Extracts active workspace ID from Astro cookies, string cookie header, or client document.cookie.
 * Safe for both server side (Astro frontmatter) and client side.
 */
export function getActiveWorkspaceId(cookies?: any): string {
  // 1. Astro cookies object passed in frontmatter
  if (cookies && typeof cookies.get === 'function') {
    const val =
      cookies.get(ACTIVE_WORKSPACE_COOKIE)?.value ??
      cookies.get('pinorbit_workspace_id')?.value;
    if (val) return val;
  }

  // 2. Raw Cookie Header string
  if (typeof cookies === 'string') {
    const match =
      cookies.match(new RegExp(`(?:^|; )${ACTIVE_WORKSPACE_COOKIE}=([^;]*)`)) ??
      cookies.match(/(?:^|; )pinorbit_workspace_id=([^;]*)/);
    if (match && match[1]) return decodeURIComponent(match[1]);
  }

  // 3. Browser environment fallback
  if (typeof document !== 'undefined' && document.cookie) {
    const match =
      document.cookie.match(new RegExp(`(?:^|; )${ACTIVE_WORKSPACE_COOKIE}=([^;]*)`)) ??
      document.cookie.match(/(?:^|; )pinorbit_workspace_id=([^;]*)/);
    if (match && match[1]) return decodeURIComponent(match[1]);
  }

  return DEFAULT_WORKSPACE_ID;
}
