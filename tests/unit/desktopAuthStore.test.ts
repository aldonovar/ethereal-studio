import type { Session } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAuthenticatorAssuranceLevel: vi.fn(),
  profileSingle: vi.fn(),
  setSession: vi.fn(),
}));

vi.mock('../../services/supabase', () => ({
  isSupabaseConfigured: true,
  supabase: {
    auth: {
      setSession: mocks.setSession,
      mfa: {
        getAuthenticatorAssuranceLevel: mocks.getAuthenticatorAssuranceLevel,
      },
    },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: mocks.profileSingle,
        })),
      })),
    })),
  },
}));

import { useAuthStore } from '../../stores/authStore';

const session = {
  access_token: 'a'.repeat(64),
  refresh_token: 'opaque-id-12',
  expires_in: 3_600,
  expires_at: 4_600,
  token_type: 'bearer',
  user: {
    id: 'auth-user-1',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'artist@example.test',
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-08-24T00:00:00.000Z',
  },
} as Session;

describe('Desktop auth renderer handoff', () => {
  beforeEach(() => {
    useAuthStore.setState({
      session: null,
      user: null,
      profile: null,
      isLoading: false,
      requiresMfa: false,
      desktopAuthPending: true,
      desktopAuthError: null,
    });
    mocks.setSession.mockResolvedValue({ data: { session }, error: null });
    mocks.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal1' },
      error: null,
    });
    mocks.profileSingle.mockResolvedValue({
      data: {
        id: session.user.id,
        username: 'artist',
        full_name: 'DAW-fi Artist',
        avatar_url: null,
        updated_at: null,
        tier: 'free',
      },
      error: null,
    });
  });

  it('hydrates a valid callback once and treats the same request id as an idempotent duplicate', async () => {
    const callback = {
      success: true,
      requestId: 'renderer-request-dedupe-1',
      session: {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_in: session.expires_in,
        expires_at: session.expires_at,
        token_type: session.token_type,
      },
    } as const;

    await expect(useAuthStore.getState().handleAuthCallback(callback)).resolves.toBe(true);
    await expect(useAuthStore.getState().handleAuthCallback(callback)).resolves.toBe(true);

    expect(mocks.setSession).toHaveBeenCalledOnce();
    expect(useAuthStore.getState()).toMatchObject({
      session,
      user: session.user,
      desktopAuthPending: false,
      desktopAuthError: null,
    });
  });

  it('does not let a late protocol replay warning overwrite an established session', async () => {
    useAuthStore.setState({
      session,
      user: session.user,
      desktopAuthPending: true,
      desktopAuthError: null,
    });

    await expect(useAuthStore.getState().handleAuthCallback({
      success: false,
      errorCode: 'AUTH_DESKTOP_HANDOFF_REPLAYED',
      error: 'Este código de acceso ya fue utilizado.',
    })).resolves.toBe(true);

    expect(useAuthStore.getState()).toMatchObject({
      session,
      user: session.user,
      desktopAuthPending: false,
      desktopAuthError: null,
      isLoading: false,
    });
  });
});
