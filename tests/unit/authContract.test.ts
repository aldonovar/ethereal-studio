// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  assertDawfiSupabaseUrl,
  buildDesktopEmailConfirmationRedirectUrl,
  DAWFI_AUTH_CONTRACT,
  isDawfiSupabaseUrl,
} from '../../services/authContract';

describe('DAW-fi unified auth contract', () => {
  it('pins every desktop OAuth endpoint to the restored DAW-fi project', () => {
    expect(DAWFI_AUTH_CONTRACT).toMatchObject({
      projectRef: 'xnmkoybfuyivmiuckpxs',
      supabaseUrl: 'https://xnmkoybfuyivmiuckpxs.supabase.co',
      socialAuthorizationPath: '/auth/v1/authorize',
      socialTokenPath: '/auth/v1/token',
      oauthAuthorizationPath: '/auth/v1/oauth/authorize',
      oauthTokenPath: '/auth/v1/oauth/token',
      oauthConsentPath: '/oauth/consent',
      authCallbackPath: '/auth/callback',
      siteOrigin: 'https://www.hollowbits.com',
      canonicalAuthOrigin: 'https://play.hollowbits.com',
      desktopBridgeUrl: 'https://www.hollowbits.com/desktop-auth',
      desktopRedirectUri: 'dawfi://auth/callback',
      scopes: ['openid', 'email', 'profile'],
    });
  });

  it('normalizes the canonical URL and rejects another project', () => {
    expect(isDawfiSupabaseUrl('https://xnmkoybfuyivmiuckpxs.supabase.co/')).toBe(true);
    expect(assertDawfiSupabaseUrl('https://xnmkoybfuyivmiuckpxs.supabase.co/path'))
      .toBe(DAWFI_AUTH_CONTRACT.supabaseUrl);
    expect(() => assertDawfiSupabaseUrl('https://wrong-project.supabase.co'))
      .toThrow(/xnmkoybfuyivmiuckpxs/);
  });

  it('routes desktop email confirmation through the explicit PKCE callback', () => {
    const redirect = new URL(buildDesktopEmailConfirmationRedirectUrl());

    expect(redirect.origin).toBe('https://play.hollowbits.com');
    expect(redirect.pathname).toBe('/auth/callback');
    expect(redirect.searchParams.get('next')).toBe('/console');
    expect(redirect.searchParams.has('verified')).toBe(false);
  });
});
