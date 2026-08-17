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

const isElectronRenderer = typeof window !== 'undefined' && Boolean(window.electron);
const volatileDesktopStorage = new Map<string, string>();

// Electron never persists a Supabase session in localStorage or a JavaScript
// cookie. The renderer keeps only a volatile copy while the main process owns
// encrypted persistence through safeStorage.
const runtimeAuthStorage = {
  getItem: (key: string): string | null => {
    if (typeof window === 'undefined') return null;
    if (isElectronRenderer) return volatileDesktopStorage.get(key) || null;

    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },

  setItem: (key: string, value: string): void => {
    if (typeof window === 'undefined') return;
    if (isElectronRenderer) {
      volatileDesktopStorage.set(key, value);
      return;
    }

    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Local persistence is best-effort.
    }
  },

  removeItem: (key: string): void => {
    if (typeof window === 'undefined') return;
    if (isElectronRenderer) {
      volatileDesktopStorage.delete(key);
      return;
    }
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Local persistence is best-effort.
    }
  },
};

export const supabase = createClient<Database>(runtimeSupabaseUrl, runtimeSupabaseAnonKey, {
  auth: {
    storage: runtimeAuthStorage,
    autoRefreshToken: isSupabaseConfigured,
    persistSession: isSupabaseConfigured,
    detectSessionInUrl: false,
    flowType: 'pkce',
  },
  ...(!isSupabaseConfigured ? { global: { fetch: offlineCloudFetch } } : {}),
});
