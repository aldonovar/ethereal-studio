// @vitest-environment node

import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const desktopAuth = require('../../electron/desktop-auth.cjs');

const CONFIG = {
  supabaseUrl: 'https://example.supabase.co',
  clientId: 'dawfi-desktop-public-client',
  redirectUri: 'dawfi://auth/callback',
  now: 1_000,
  randomBytes: (size: number) => Buffer.alloc(size, size),
};

describe('DAW-fi Desktop OAuth handoff', () => {
  it('creates an authorization-code request with S256 PKCE and no verifier in the URL', () => {
    const request = desktopAuth.createAuthorizationRequest(CONFIG);
    const url = new URL(request.url);

    expect(url.pathname).toBe('/auth/v1/oauth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe('dawfi://auth/callback');
    expect(url.searchParams.get('state')).toBe(request.state);
    expect(url.searchParams.get('code_verifier')).toBeNull();
    expect(request.codeVerifier.length).toBeGreaterThanOrEqual(43);
  });

  it('accepts only the exact callback, code and matching state', () => {
    const result = desktopAuth.parseAuthorizationCallback(
      'dawfi://auth/callback?code=opaque-code-123&state=expected-state',
      { expectedState: 'expected-state', redirectUri: 'dawfi://auth/callback' },
    );

    expect(result).toEqual({ kind: 'success', code: 'opaque-code-123' });
  });

  it.each([
    ['missing state', 'dawfi://auth/callback?code=opaque-code-123'],
    ['wrong state', 'dawfi://auth/callback?code=opaque-code-123&state=attacker'],
    ['URL fragment', 'dawfi://auth/callback?code=opaque-code-123&state=expected-state#access_token=leak'],
    ['unexpected token', 'dawfi://auth/callback?code=opaque-code-123&state=expected-state&access_token=leak'],
    ['duplicate state', 'dawfi://auth/callback?code=opaque-code-123&state=expected-state&state=expected-state'],
    ['wrong protocol', 'https://auth/callback?code=opaque-code-123&state=expected-state'],
  ])('rejects %s', (_label, url) => {
    expect(() => desktopAuth.parseAuthorizationCallback(url, {
      expectedState: 'expected-state',
      redirectUri: 'dawfi://auth/callback',
    })).toThrow();
  });

  it('supports the legacy protocol only when it is the exact pending redirect', () => {
    expect(desktopAuth.parseAuthorizationCallback(
      'hollowbits://auth/callback?code=opaque-code-123&state=legacy-state',
      { expectedState: 'legacy-state', redirectUri: 'hollowbits://auth/callback' },
    )).toEqual({ kind: 'success', code: 'opaque-code-123' });
  });

  it('exchanges the code over HTTPS with the verifier and never sends a client secret', async () => {
    const request = desktopAuth.createAuthorizationRequest(CONFIG);
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = init.body as URLSearchParams;
      expect(body.get('code_verifier')).toBe(request.codeVerifier);
      expect(body.get('client_secret')).toBeNull();
      expect(body.get('grant_type')).toBe('authorization_code');
      return new Response(JSON.stringify({
        access_token: 'a'.repeat(64),
        refresh_token: 'r'.repeat(64),
        expires_in: 3600,
        token_type: 'bearer',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const session = await desktopAuth.exchangeAuthorizationCode({
      pending: request,
      code: 'opaque-code-123',
      fetchImpl: fetchMock,
      now: 2_000,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(session).toMatchObject({
      access_token: 'a'.repeat(64),
      refresh_token: 'r'.repeat(64),
      token_type: 'bearer',
    });
  });

  it('rejects expired and replayed authorization codes with typed errors', async () => {
    const expired = desktopAuth.createAuthorizationRequest({ ...CONFIG, ttlMs: 50 });
    await expect(desktopAuth.exchangeAuthorizationCode({
      pending: expired,
      code: 'opaque-code-123',
      fetchImpl: vi.fn(),
      now: 2_000,
    })).rejects.toMatchObject({ code: 'AUTH_DESKTOP_HANDOFF_EXPIRED' });

    const active = desktopAuth.createAuthorizationRequest(CONFIG);
    const replayResponse = vi.fn(async () => new Response(
      JSON.stringify({ error: 'invalid_grant' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    ));
    await expect(desktopAuth.exchangeAuthorizationCode({
      pending: active,
      code: 'opaque-code-123',
      fetchImpl: replayResponse,
      now: 2_000,
    })).rejects.toMatchObject({ code: 'AUTH_DESKTOP_HANDOFF_REPLAYED' });
  });
});
