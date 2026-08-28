import { create } from 'zustand';
import type { AuthChangeEvent, Session, User } from '@supabase/supabase-js';
import { isSupabaseConfigured, supabase } from '../services/supabase';
import type {
  DesktopAuthCallbackResult,
  DesktopAuthErrorCode,
  DesktopAuthSessionPayload,
} from '../types';
import type { Profile } from '../types/supabase';

interface DesktopAuthFeedback {
  code?: DesktopAuthErrorCode;
  message: string;
}

interface AuthState {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  isLoading: boolean;
  requiresMfa: boolean;
  desktopAuthPending: boolean;
  desktopAuthError: DesktopAuthFeedback | null;
  initialize: () => () => void;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  checkMfa: () => Promise<void>;
  setDesktopAuthPending: (pending: boolean) => void;
  clearDesktopAuthError: () => void;
  handleAuthCallback: (result: DesktopAuthCallbackResult) => Promise<boolean>;
}

const processedDesktopAuthRequests = new Set<string>();

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

function toDesktopSessionPayload(session: Session): DesktopAuthSessionPayload {
  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: session.expires_in,
    expires_at: session.expires_at,
    token_type: session.token_type,
  };
}

async function establishDesktopSession(payload: DesktopAuthSessionPayload | null | undefined): Promise<Session | null> {
  if (!payload?.access_token || !payload.refresh_token || !isSupabaseConfigured) return null;
  const { data, error } = await supabase.auth.setSession({
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
  });
  if (error) throw error;
  return data.session;
}

async function persistSessionInMain(session: Session | null): Promise<void> {
  const host = window.electron;
  if (!host) return;
  if (!session) {
    await host.clearPersistedAuthSession?.();
    return;
  }
  await host.persistAuthSession?.(toDesktopSessionPayload(session));
}

function removeCredentialsFromRendererUrl(): void {
  const search = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '');
  const sensitiveKeys = ['access_token', 'refresh_token', 'code'];
  const hasSensitiveValue = sensitiveKeys.some((key) => search.has(key) || hash.has(key));
  if (!hasSensitiveValue) return;

  for (const key of sensitiveKeys) {
    search.delete(key);
    hash.delete(key);
  }
  const nextSearch = search.toString();
  const nextHash = hash.toString();
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${nextHash ? `#${nextHash}` : ''}`,
  );
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
  desktopAuthPending: false,
  desktopAuthError: null,

  initialize: () => {
    removeCredentialsFromRendererUrl();

    if (!isSupabaseConfigured) {
      set({
        session: null,
        user: null,
        profile: null,
        requiresMfa: false,
        desktopAuthPending: false,
        isLoading: false,
      });
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
        let restoredSession: Session | null = null;
        const pendingResult = await window.electron?.getPendingAuthCallback?.();
        if (pendingResult) {
          if (pendingResult.success) {
            restoredSession = await establishDesktopSession(pendingResult.session);
          } else {
            set({
              desktopAuthPending: false,
              desktopAuthError: {
                code: pendingResult.errorCode,
                message: pendingResult.error || 'No se pudo completar el acceso con Google.',
              },
            });
          }
        }

        if (!restoredSession) {
          const persistedSession = await window.electron?.getPersistedAuthSession?.();
          restoredSession = await establishDesktopSession(persistedSession);
        }

        const session = restoredSession || (await supabase.auth.getSession()).data.session;
        const nextState = await hydrateSessionState(session);
        set({ ...nextState, desktopAuthPending: false, isLoading: false });
      } catch (error) {
        console.error('[authStore] Failed to hydrate session:', error);
        set({
          session: null,
          user: null,
          profile: null,
          requiresMfa: false,
          desktopAuthPending: false,
          isLoading: false,
        });
      } finally {
        window.clearTimeout(safetyTimeout);
      }
    };

    void hydrate();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event: AuthChangeEvent, session: Session | null) => {
        if (event === 'SIGNED_OUT') {
          void persistSessionInMain(null);
        } else if (session && event !== 'INITIAL_SESSION') {
          void persistSessionInMain(session);
        }

        if (event === 'INITIAL_SESSION') return;

        const hydrateChange = async () => {
          try {
            const nextState = await hydrateSessionState(session);
            set({ ...nextState, isLoading: false });
          } catch (error) {
            console.error('[authStore] onAuthStateChange error:', error);
          }
        };

        void hydrateChange();
      },
    );

    return () => {
      window.clearTimeout(safetyTimeout);
      subscription.unsubscribe();
    };
  },

  signOut: async () => {
    set({ isLoading: true });
    if (!isSupabaseConfigured) {
      await window.electron?.clearPersistedAuthSession?.();
      set({ session: null, user: null, profile: null, requiresMfa: false, isLoading: false });
      return;
    }
    try {
      // Keep the button's promise: it signs out this installation only.
      // Revoking other devices is an explicit account-security action.
      const { error } = await supabase.auth.signOut({ scope: 'local' });
      if (error) {
        console.error('[authStore] Sign-out error:', error.message);
      }
    } catch (error) {
      console.error('[authStore] Sign-out exception:', error);
    }
    await window.electron?.clearPersistedAuthSession?.();
    set({
      session: null,
      user: null,
      profile: null,
      requiresMfa: false,
      desktopAuthPending: false,
      desktopAuthError: null,
      isLoading: false,
    });
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

  setDesktopAuthPending: (pending) => set({
    desktopAuthPending: pending,
    ...(pending ? { desktopAuthError: null } : {}),
  }),

  clearDesktopAuthError: () => set({ desktopAuthError: null }),

  handleAuthCallback: async (result) => {
    if (result.requestId && processedDesktopAuthRequests.has(result.requestId)) {
      return Boolean(get().session);
    }
    if (result.requestId) {
      processedDesktopAuthRequests.add(result.requestId);
      if (processedDesktopAuthRequests.size > 32) {
        processedDesktopAuthRequests.delete(processedDesktopAuthRequests.values().next().value as string);
      }
    }

    if (!result.success || !result.session) {
      // A browser may dispatch the same custom-protocol callback more than once
      // (automatic attempt plus a manual retry). Once a valid session exists, a
      // late replay notice must never replace that successful authenticated state.
      if (result.errorCode === 'AUTH_DESKTOP_HANDOFF_REPLAYED' && get().session) {
        set({
          desktopAuthPending: false,
          desktopAuthError: null,
          isLoading: false,
        });
        return true;
      }

      set({
        desktopAuthPending: false,
        desktopAuthError: {
          code: result.errorCode,
          message: result.error || 'No se pudo completar el acceso con Google.',
        },
        isLoading: false,
      });
      return false;
    }
    if (!isSupabaseConfigured) {
      set({
        session: null,
        user: null,
        profile: null,
        requiresMfa: false,
        desktopAuthPending: false,
        isLoading: false,
      });
      return false;
    }

    set({ isLoading: true, desktopAuthPending: false, desktopAuthError: null });
    try {
      const session = await establishDesktopSession(result.session);
      const nextState = await hydrateSessionState(session);
      set({ ...nextState, isLoading: false });
      return Boolean(nextState.session);
    } catch (error) {
      console.error('[authStore] Desktop auth callback failed:', error);
      set({
        desktopAuthError: {
          code: 'AUTH_CALLBACK_INVALID',
          message: 'La sesión fue recibida, pero no pudo validarse.',
        },
        isLoading: false,
      });
      return false;
    }
  },
}));
