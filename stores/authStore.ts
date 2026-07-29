import { create } from 'zustand';
import type { AuthChangeEvent, Session, User } from '@supabase/supabase-js';
import { isSupabaseConfigured, supabase } from '../services/supabase';
import type { Profile } from '../types/supabase';

interface AuthState {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  isLoading: boolean;
  requiresMfa: boolean;
  initialize: () => () => void;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  checkMfa: () => Promise<void>;
  handleAuthCallback: (url: string) => Promise<boolean>;
}

async function fetchProfile(userId: string): Promise<Profile | null> {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (error) {
      console.warn('[authStore] Profile fetch failed:', error.message);
      return null;
    }

    return data;
  } catch (error) {
    console.warn('[authStore] Profile fetch exception:', error);
    return null;
  }
}

async function safeMfaCheck(): Promise<boolean> {
  try {
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    return data?.currentLevel === 'aal1' && data?.nextLevel === 'aal2';
  } catch {
    return false;
  }
}

async function exchangeSessionFromCallback(url: string): Promise<Session | null> {
  if (!url || !isSupabaseConfigured) return null;

  const parsed = new URL(url);
  const errorDescription = parsed.searchParams.get('error_description') || parsed.searchParams.get('error');
  if (errorDescription) {
    throw new Error(errorDescription);
  }

  const hashParams = new URLSearchParams(parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash);
  const accessToken = hashParams.get('access_token');
  const refreshToken = hashParams.get('refresh_token');
  if (accessToken && refreshToken) {
    const { data, error } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (error) throw error;
    return data.session;
  }

  const code = parsed.searchParams.get('code');
  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) throw error;
    return data.session;
  }

  return null;
}

async function hydrateSessionState(session: Session | null): Promise<Pick<AuthState, 'session' | 'user' | 'profile' | 'requiresMfa'>> {
  if (!session?.user) {
    return {
      session: null,
      user: null,
      profile: null,
      requiresMfa: false,
    };
  }

  const [requiresMfa, profile] = await Promise.all([
    safeMfaCheck(),
    fetchProfile(session.user.id),
  ]);

  return {
    session,
    user: session.user,
    profile,
    requiresMfa,
  };
}

export const useAuthStore = create<AuthState>((set, get) => ({
  session: null,
  user: null,
  profile: null,
  isLoading: true,
  requiresMfa: false,

  initialize: () => {
    if (!isSupabaseConfigured) {
      const hash = window.location.hash;
      if (hash.includes('access_token=') || hash.includes('refresh_token=')) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
      set({ session: null, user: null, profile: null, requiresMfa: false, isLoading: false });
      return () => undefined;
    }

    const safetyTimeout = window.setTimeout(() => {
      if (get().isLoading) {
        console.warn('[authStore] Safety timeout - forcing isLoading=false');
        set({ isLoading: false });
      }
    }, 5000);

    const hydrate = async () => {
      try {
        const pendingDesktopCallback = await window.electron?.getPendingAuthCallback?.();
        if (pendingDesktopCallback) {
          await exchangeSessionFromCallback(pendingDesktopCallback);
        }

        const hash = window.location.hash;
        if (hash.includes('access_token=') && hash.includes('refresh_token=')) {
          await exchangeSessionFromCallback(window.location.href);
          window.history.replaceState(null, '', window.location.pathname + window.location.search);
        }

        const { data: { session } } = await supabase.auth.getSession();
        const nextState = await hydrateSessionState(session);
        set({ ...nextState, isLoading: false });
      } catch (error) {
        console.error('[authStore] Failed to hydrate session:', error);
        set({ session: null, user: null, profile: null, requiresMfa: false, isLoading: false });
      } finally {
        window.clearTimeout(safetyTimeout);
      }
    };

    void hydrate();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event: AuthChangeEvent, session: Session | null) => {
        if (event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION') return;

        const hydrateChange = async () => {
          try {
            const nextState = await hydrateSessionState(session);
            set({ ...nextState, isLoading: false });
          } catch (error) {
            console.error('[authStore] onAuthStateChange error:', error);
          }
        };

        void hydrateChange();
      }
    );

    return () => {
      window.clearTimeout(safetyTimeout);
      subscription.unsubscribe();
    };
  },

  signOut: async () => {
    set({ isLoading: true });
    if (!isSupabaseConfigured) {
      set({ session: null, user: null, profile: null, requiresMfa: false, isLoading: false });
      return;
    }
    try {
      const { error } = await supabase.auth.signOut();
      if (error) {
        console.error('[authStore] Sign-out error:', error.message);
      }
    } catch (error) {
      console.error('[authStore] Sign-out exception:', error);
    }
    set({ session: null, user: null, profile: null, requiresMfa: false, isLoading: false });
  },

  refreshProfile: async () => {
    const { user } = get();
    if (!user) return;
    const profile = await fetchProfile(user.id);
    set({ profile });
  },

  checkMfa: async () => {
    const requiresMfa = await safeMfaCheck();
    set({ requiresMfa });
  },

  handleAuthCallback: async (url: string) => {
    if (!isSupabaseConfigured) {
      set({ session: null, user: null, profile: null, requiresMfa: false, isLoading: false });
      return false;
    }
    set({ isLoading: true });
    try {
      const session = await exchangeSessionFromCallback(url);
      const fallbackSession = session || (await supabase.auth.getSession()).data.session;
      const nextState = await hydrateSessionState(fallbackSession);
      set({ ...nextState, isLoading: false });
      return Boolean(nextState.session);
    } catch (error) {
      console.error('[authStore] Desktop auth callback failed:', error);
      set({ isLoading: false });
      return false;
    }
  },
}));
