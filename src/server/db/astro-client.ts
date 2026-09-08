import { createServerClient } from '@supabase/ssr';
import type { AstroCookies } from 'astro';
import { supabaseUrl, supabaseAnonKey, isSupabaseConfigured } from '../../lib/supabase-client';

/**
 * Creates a request-scoped Supabase server client for Astro SSR using official @supabase/ssr cookie adapter.
 */
export function createAstroServerClient(
  cookies?: AstroCookies,
  request?: Request,
  responseHeaders?: Headers | any
) {
  if (!isSupabaseConfigured || !supabaseUrl || !supabaseAnonKey) {
    return null;
  }

  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        let rawHeader = '';
        if (request && request.headers && typeof request.headers.get === 'function') {
          rawHeader = request.headers.get('cookie') || '';
        } else if (cookies && (cookies as any).headers) {
          const h = (cookies as any).headers;
          if (typeof h.get === 'function') {
            rawHeader = h.get('cookie') || '';
          } else if (typeof h === 'string') {
            rawHeader = h;
          }
        }

        if (!rawHeader) return [];

        return rawHeader
          .split(';')
          .map((cookieStr) => {
            const parts = cookieStr.trim().split('=');
            if (parts.length < 2) return null;
            const name = parts[0].trim();
            const value = parts.slice(1).join('=').trim();
            return { name, value };
          })
          .filter((c): c is { name: string; value: string } => Boolean(c && c.name));
      },
      setAll(cookiesToSet, headersToSet) {
        // 1. Apply cookies
        if (cookies && typeof cookies.set === 'function') {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookies.set(name, value, options as any);
            });
          } catch (cErr) {
            if (import.meta.env.DEV) {
              console.debug('@supabase/ssr cookies.set suppressed in SSR path:', cErr);
            }
          }
        }

        // 2. Apply Cache-Control / Response headers passed by @supabase/ssr during token refresh
        if (headersToSet && responseHeaders && typeof responseHeaders.set === 'function') {
          try {
            if (typeof (headersToSet as any).forEach === 'function') {
              (headersToSet as any).forEach((val: string, key: string) => {
                responseHeaders.set(key, val);
              });
            } else if (Array.isArray(headersToSet)) {
              (headersToSet as any[]).forEach(({ name, value }: any) => {
                responseHeaders.set(name, value);
              });
            }
          } catch (hErr) {
            if (import.meta.env.DEV) {
              console.debug('@supabase/ssr responseHeaders.set suppressed in SSR path:', hErr);
            }
          }
        }
      },
    },
  });
}
