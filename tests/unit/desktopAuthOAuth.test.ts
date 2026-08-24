// @vitest-environment node

import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const desktopAuth = require('../../electron/desktop-auth.cjs');

const toBase64Url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const ANON_KEY = [
  toBase64Url({ alg: 'HS256', typ: 'JWT' }),
  toBase64Url({ role: 'anon', ref: 'xnmkoybfuyivmiuckpxs' }),
  'test-signature',
].join('.');

const CONFIG = {
  supabaseUrl: 'https://xnmkoybfuyivmiuckpxs.supabase.co',
  redirectUri: 'dawfi://auth/callback',
  now: 1_000,
  randomBytes: (size: number) => Buffer.alloc(size, size),
};

describe('DAW-fi Desktop OAuth handoff', () => {
  it('rejects any Supabase project other than the DAW-fi project', () => {
    expect(() => desktopAuth.createAuthorizationRequest({
      ...CONFIG,
      supabaseUrl: 'https://wrong-project.supabase.co',
    })).toThrowError(expect.objectContaining({ code: 'AUTH_CONFIGURATION_MISMATCH' }));
  });

  it('creates a Google social-login request with S256 PKCE and no key or verifier in the URL', () => {
    const request = desktopAuth.createAuthorizationRequest(CONFIG);
    const url = new URL(request.url);
    const redirectTo = new URL(url.searchParams.get('redirect_to')!);

    expect(url.pathname).toBe('/auth/v1/authorize');
    expect(url.searchParams.get('provider')).toBe('google');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(`${redirectTo.origin}${redirectTo.pathname}`).toBe('https://www.hollowbits.com/desktop-auth');
    expect(redirectTo.searchParams.get('state')).toBe(request.state);
    expect(request.redirectUri).toBe('dawfi://auth/callback');
    expect(url.searchParams.get('code_verifier')).toBeNull();
    expect(url.searchParams.get('apikey')).toBeNull();
    expect(url.searchParams.get('client_id')).toBeNull();
    expect(request.codeVerifier.length).toBeGreaterThanOrEqual(43);
  });

  it('rejects a pending request whose HTTPS bridge was replaced or decorated', () => {
    const request = desktopAuth.createAuthorizationRequest(CONFIG);

    expect(() => desktopAuth.validatePendingRequest({
      ...request,
      redirectTo: `https://evil.example/desktop-auth?state=${request.state}`,
    }, 2_000)).toThrowError(expect.objectContaining({ code: 'AUTH_CALLBACK_INVALID' }));

    expect(() => desktopAuth.validatePendingRequest({
      ...request,
      redirectTo: `${request.redirectTo}&next=https://evil.example`,
    }, 2_000)).toThrowError(expect.objectContaining({ code: 'AUTH_CALLBACK_INVALID' }));
  });

  it('accepts only an anon/publishable key from the DAW-fi project', () => {
    expect(desktopAuth.validatePublishableKey(ANON_KEY)).toBe(ANON_KEY);
    const serviceRoleKey = [
      toBase64Url({ alg: 'HS256', typ: 'JWT' }),
      toBase64Url({ role: 'service_role', ref: 'xnmkoybfuyivmiuckpxs' }),
      'test-signature',
    ].join('.');
    expect(() => desktopAuth.validatePublishableKey(serviceRoleKey))
      .toThrowError(expect.objectContaining({ code: 'AUTH_CONFIGURATION_MISSING' }));
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
    ['code with whitespace', 'dawfi://auth/callback?code=opaque%20code-123&state=expected-state'],
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
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const headers = init.headers as Record<string, string>;
      expect(url).toBe('https://xnmkoybfuyivmiuckpxs.supabase.co/auth/v1/token?grant_type=pkce');
      expect(body).toEqual({ auth_code: 'opaque-code-123', code_verifier: request.codeVerifier });
      expect(headers.apikey).toBe(ANON_KEY);
      expect(headers.Authorization).toBe(`Bearer ${ANON_KEY}`);
      expect(String(init.body)).not.toContain('client_secret');
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
      publishableKey: ANON_KEY,
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
      publishableKey: ANON_KEY,
      fetchImpl: vi.fn(),
      now: 2_000,
    })).rejects.toMatchObject({ code: 'AUTH_DESKTOP_HANDOFF_EXPIRED' });

    const active = desktopAuth.createAuthorizationRequest(CONFIG);
    const replayResponse = vi.fn(async () => new Response(
      JSON.stringify({ error_code: 'flow_state_expired' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    ));
    await expect(desktopAuth.exchangeAuthorizationCode({
      pending: active,
      code: 'opaque-code-123',
      publishableKey: ANON_KEY,
      fetchImpl: replayResponse,
      now: 2_000,
    })).rejects.toMatchObject({ code: 'AUTH_DESKTOP_HANDOFF_REPLAYED' });
  });
});
