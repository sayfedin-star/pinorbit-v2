import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createBrowserClient } from '@supabase/ssr';

function getSchedulingUrl(): string {
  // 1. Check SSR / Process environment variables
  if (typeof process !== 'undefined' && process.env) {
    if (process.env.PUBLIC_SCHEDULING_SUPABASE_URL) return process.env.PUBLIC_SCHEDULING_SUPABASE_URL;
    if (process.env.SCHEDULING_SUPABASE_URL) return process.env.SCHEDULING_SUPABASE_URL;
  }
  // 2. Check explicit client-safe public variable
  if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.PUBLIC_SCHEDULING_SUPABASE_URL) {
    return import.meta.env.PUBLIC_SCHEDULING_SUPABASE_URL;
  }
  return 'https://eygdoetdwqllvsxpvoex.supabase.co';
}

function getSchedulingPublishableKey(): string {
  // 1. Check SSR / Process environment variables
  if (typeof process !== 'undefined' && process.env) {
    if (process.env.PUBLIC_SCHEDULING_SUPABASE_PUBLISHABLE_KEY) return process.env.PUBLIC_SCHEDULING_SUPABASE_PUBLISHABLE_KEY;
    if (process.env.SCHEDULING_SUPABASE_PUBLISHABLE_KEY) return process.env.SCHEDULING_SUPABASE_PUBLISHABLE_KEY;
  }
  // 2. Check explicit client-safe public variable
  if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.PUBLIC_SCHEDULING_SUPABASE_PUBLISHABLE_KEY) {
    return import.meta.env.PUBLIC_SCHEDULING_SUPABASE_PUBLISHABLE_KEY;
  }
  return 'sb_publishable_efxKrwXCOaj9CM5oxD-WjA_jqvB5iGD';
}

export const supabaseUrl = getSchedulingUrl();
export const supabaseAnonKey = getSchedulingPublishableKey();

export const isSupabaseConfigured = Boolean(
  supabaseUrl &&
  supabaseAnonKey &&
  supabaseUrl !== 'https://your-project-id.supabase.co' &&
  supabaseUrl !== 'https://your-project-1.supabase.co'
);

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? (typeof window !== 'undefined'
      ? createBrowserClient(supabaseUrl, supabaseAnonKey, {
          cookieOptions: {
            path: '/',
            sameSite: 'lax',
            secure: typeof window !== 'undefined' && window.location.protocol === 'https:',
          },
        })
      : createClient(supabaseUrl, supabaseAnonKey))
  : null;
