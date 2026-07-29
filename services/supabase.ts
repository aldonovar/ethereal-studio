import { createClient } from '@supabase/supabase-js';
import type { Database } from '../types/supabase';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

// The desktop app is local-first. Missing cloud configuration must never stop
// React from mounting, and an offline build must never send auth data to a
// fallback endpoint. This fetch implementation returns a local 503 response.
const offlineCloudFetch: typeof fetch = async () => new Response(
  JSON.stringify({ message: 'Cloud services are not configured in this build.' }),
  {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  }
);

const runtimeSupabaseUrl = supabaseUrl || 'http://127.0.0.1:1';
const runtimeSupabaseAnonKey = supabaseAnonKey || 'dawfi-local-only';

const isOnHollowbits = typeof window !== 'undefined'
  && window.location.hostname.includes('hollowbits.com');

const COOKIE_DOMAIN = 'domain=.hollowbits.com;';
const COOKIE_OPTS = 'path=/; max-age=604800; SameSite=Lax; Secure';

function setCookie(name: string, value: string): void {
  const domainPart = isOnHollowbits ? COOKIE_DOMAIN : '';
  document.cookie = `${name}=${value}; ${domainPart} ${COOKIE_OPTS}`;
}

function getCookie(name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = document.cookie.match(new RegExp('(?:^|; )' + escaped + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

function deleteCookie(name: string): void {
  const expired = 'expires=Thu, 01 Jan 1970 00:00:00 GMT';
  document.cookie = `${name}=; path=/; ${expired}`;
  if (isOnHollowbits) {
    document.cookie = `${name}=; ${COOKIE_DOMAIN} path=/; ${expired}`;
  }
}

const ssoStorage = {
  getItem: (key: string): string | null => {
    if (typeof window === 'undefined') return null;

    try {
      const local = window.localStorage.getItem(key);
      if (local) return local;
    } catch {
      // Private browsing and hardened environments can throw.
    }

    if (typeof document !== 'undefined') {
      const cookieValue = getCookie(key);
      if (cookieValue) {
        try {
          window.localStorage.setItem(key, cookieValue);
        } catch {
          // Local persistence is best-effort.
        }
        return cookieValue;
      }
    }

    return null;
  },

  setItem: (key: string, value: string): void => {
    if (typeof window === 'undefined') return;

    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Local persistence is best-effort.
    }

    if (isOnHollowbits && typeof document !== 'undefined') {
      try {
        const encoded = encodeURIComponent(value);
        if (encoded.length <= 3900) {
          setCookie(key, encoded);
        }
      } catch {
        // Cookie SSO is secondary to localStorage.
      }
    }
  },

  removeItem: (key: string): void => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Local persistence is best-effort.
    }
    if (typeof document !== 'undefined') deleteCookie(key);
  },
};

export const supabase = createClient<Database>(runtimeSupabaseUrl, runtimeSupabaseAnonKey, {
  auth: {
    storage: ssoStorage,
    autoRefreshToken: isSupabaseConfigured,
    persistSession: isSupabaseConfigured,
    detectSessionInUrl: isSupabaseConfigured,
  },
  ...(!isSupabaseConfigured ? { global: { fetch: offlineCloudFetch } } : {}),
});
