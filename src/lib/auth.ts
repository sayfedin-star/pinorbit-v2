import { supabase, isSupabaseConfigured } from './supabase-client';
import type { User, Session } from '@supabase/supabase-js';

export async function getCurrentSession(): Promise<Session | null> {
  if (!supabase) return null;
  try {
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error) {
      console.warn('Error fetching session:', error);
      return null;
    }
    return session;
  } catch (err) {
    console.error('Session check failed:', err);
    return null;
  }
}

/**
 * Checks authentication client-side.
 * If Supabase is configured and user is not authenticated, redirects to /login.
 */
export async function requireAuth(redirectPath: string = '/login'): Promise<boolean> {
  if (typeof window === 'undefined') return true;

  if (!isSupabaseConfigured || !supabase) {
    return true;
  }

  const session = await getCurrentSession();
  if (!session) {
    const currentUrl = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `${redirectPath}?redirect=${currentUrl}`;
    return false;
  }

  return true;
}

export async function signIn(email: string, password: string) {
  if (!supabase) {
    throw new Error('Supabase client is not configured.');
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    throw error;
  }

  return data;
}

export async function signOut() {
  if (supabase) {
    try {
      await supabase.auth.signOut({ scope: 'local' });
    } catch (err) {
      console.warn('Error signing out locally:', err);
    }
  }

  if (typeof window !== 'undefined') {
    window.location.href = '/login';
  }
}

export function onAuthStateChange(callback: (event: string, session: Session | null) => void) {
  if (!supabase) return { unsubscribe: () => {} };
  
  const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
    callback(event, session);
  });

  return subscription;
}
