import rawContract from '../config/dawfi-auth.json';

export const DAWFI_AUTH_CONTRACT = Object.freeze({
  ...rawContract,
  scopes: Object.freeze([...rawContract.scopes]),
});

export const buildDesktopEmailConfirmationRedirectUrl = (): string => {
  const callbackUrl = new URL(
    DAWFI_AUTH_CONTRACT.authCallbackPath,
    DAWFI_AUTH_CONTRACT.canonicalAuthOrigin,
  );
  callbackUrl.searchParams.set('next', '/console');
  return callbackUrl.toString();
};

const normalizeOrigin = (rawUrl: string): string | null => {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return null;
  }
};

export const isDawfiSupabaseUrl = (rawUrl: string | undefined): boolean => {
  if (!rawUrl) return false;
  return normalizeOrigin(rawUrl) === DAWFI_AUTH_CONTRACT.supabaseUrl;
};

export const assertDawfiSupabaseUrl = (rawUrl: string): string => {
  if (!isDawfiSupabaseUrl(rawUrl)) {
    throw new Error(
      `DAW-fi está configurado con otro proyecto Supabase; se requiere ${DAWFI_AUTH_CONTRACT.projectRef}.`,
    );
  }
  return DAWFI_AUTH_CONTRACT.supabaseUrl;
};
