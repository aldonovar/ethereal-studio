const crypto = require('node:crypto');
const DAWFI_AUTH_CONTRACT = require('../config/dawfi-auth.json');

const DEFAULT_AUTH_TTL_MS = 5 * 60 * 1000;
const MAX_TOKEN_LENGTH = 32 * 1024;
const OAUTH_CODE_PATTERN = /^[A-Za-z0-9._~-]{8,4096}$/;

class DesktopAuthError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'DesktopAuthError';
        this.code = code;
    }
}

const fail = (code, message) => {
    throw new DesktopAuthError(code, message);
};

const toBase64Url = (value) => Buffer.from(value).toString('base64url');

const normalizeSupabaseOrigin = (rawUrl) => {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        fail('AUTH_CONFIGURATION_MISSING', 'La URL de autenticación no es válida.');
    }

    const isLocalDevelopment = parsed.protocol === 'http:'
        && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
    if (parsed.protocol !== 'https:' && !isLocalDevelopment) {
        fail('AUTH_CONFIGURATION_MISSING', 'La autenticación requiere HTTPS.');
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        fail('AUTH_CONFIGURATION_MISSING', 'La URL de autenticación contiene datos no permitidos.');
    }

    return parsed.origin;
};

const normalizeDawfiSupabaseOrigin = (rawUrl) => {
    const origin = normalizeSupabaseOrigin(rawUrl);
    if (origin !== DAWFI_AUTH_CONTRACT.supabaseUrl) {
        fail(
            'AUTH_CONFIGURATION_MISMATCH',
            `DAW-fi requiere el proyecto Supabase ${DAWFI_AUTH_CONTRACT.projectRef}.`
        );
    }
    return origin;
};

const normalizeRedirectUri = (rawUri) => {
    let parsed;
    try {
        parsed = new URL(rawUri);
    } catch {
        fail('AUTH_CONFIGURATION_MISSING', 'El callback de Desktop no es válido.');
    }

    if (!['dawfi:', 'hollowbits:'].includes(parsed.protocol)) {
        fail('AUTH_CONFIGURATION_MISSING', 'El callback de Desktop usa un protocolo no permitido.');
    }
    if (parsed.hostname !== 'auth' || parsed.pathname !== '/callback') {
        fail('AUTH_CONFIGURATION_MISSING', 'El callback de Desktop no coincide con la ruta autorizada.');
    }
    if (parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) {
        fail('AUTH_CONFIGURATION_MISSING', 'El callback de Desktop debe ser una URL exacta.');
    }

    return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`;
};

const normalizeDesktopBridgeUrl = (rawUrl = DAWFI_AUTH_CONTRACT.desktopBridgeUrl) => {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        fail('AUTH_CONFIGURATION_MISSING', 'El puente web de Desktop no es válido.');
    }

    const expected = new URL(DAWFI_AUTH_CONTRACT.desktopBridgeUrl);
    if (
        parsed.protocol !== 'https:'
        || parsed.origin !== expected.origin
        || parsed.pathname !== expected.pathname
        || parsed.username
        || parsed.password
        || parsed.port
        || parsed.search
        || parsed.hash
    ) {
        fail('AUTH_CONFIGURATION_MISMATCH', 'El puente web de Desktop no coincide con DAW-fi.');
    }

    return `${parsed.origin}${parsed.pathname}`;
};

const validatePublishableKey = (publishableKey) => {
    const normalized = typeof publishableKey === 'string' ? publishableKey.trim() : '';
    if (/^sb_publishable_[A-Za-z0-9_-]{20,512}$/.test(normalized)) {
        return normalized;
    }

    const jwtParts = normalized.split('.');
    if (jwtParts.length === 3 && jwtParts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) {
        try {
            const payload = JSON.parse(Buffer.from(jwtParts[1], 'base64url').toString('utf8'));
            if (payload?.role === 'anon' && (!payload.ref || payload.ref === DAWFI_AUTH_CONTRACT.projectRef)) {
                return normalized;
            }
        } catch {
            // Fall through to the public configuration error below.
        }
    }

    fail(
        'AUTH_CONFIGURATION_MISSING',
        'DAW-fi Desktop no tiene cargada la clave pública del proyecto restaurado.'
    );
};

const createAuthorizationRequest = ({
    supabaseUrl = DAWFI_AUTH_CONTRACT.supabaseUrl,
    redirectUri = DAWFI_AUTH_CONTRACT.desktopRedirectUri,
    now = Date.now(),
    ttlMs = DEFAULT_AUTH_TTL_MS,
    randomBytes = crypto.randomBytes,
} = {}) => {
    const origin = normalizeDawfiSupabaseOrigin(supabaseUrl);
    const normalizedRedirectUri = normalizeRedirectUri(redirectUri);
    const desktopBridgeUrl = normalizeDesktopBridgeUrl();
    const state = toBase64Url(randomBytes(32));
    const codeVerifier = toBase64Url(randomBytes(48));
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
    const createdAt = Number(now);

    if (!Number.isFinite(createdAt) || !Number.isFinite(ttlMs) || ttlMs <= 0) {
        fail('AUTH_CONFIGURATION_MISSING', 'La configuración temporal de OAuth no es válida.');
    }

    const redirectTo = new URL(desktopBridgeUrl);
    redirectTo.searchParams.set('state', state);

    const authorizeUrl = new URL(DAWFI_AUTH_CONTRACT.socialAuthorizationPath, origin);
    authorizeUrl.searchParams.set('provider', 'google');
    authorizeUrl.searchParams.set('redirect_to', redirectTo.toString());
    authorizeUrl.searchParams.set('code_challenge', codeChallenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('prompt', 'select_account');

    return {
        url: authorizeUrl.toString(),
        state,
        codeVerifier,
        redirectUri: normalizedRedirectUri,
        redirectTo: redirectTo.toString(),
        supabaseOrigin: origin,
        createdAt,
        expiresAt: createdAt + ttlMs,
    };
};

const getUniqueSearchParams = (parsed) => {
    const params = new Map();
    for (const [key, value] of parsed.searchParams.entries()) {
        if (params.has(key)) {
            fail('AUTH_CALLBACK_INVALID', 'El callback contiene parámetros duplicados.');
        }
        params.set(key, value);
    }
    return params;
};

const assertAllowedKeys = (params, allowedKeys) => {
    for (const key of params.keys()) {
        if (!allowedKeys.has(key)) {
            fail('AUTH_CALLBACK_INVALID', 'El callback contiene parámetros no permitidos.');
        }
    }
};

const parseAuthorizationCallback = (rawUrl, { expectedState, redirectUri }) => {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        fail('AUTH_CALLBACK_INVALID', 'El callback de autenticación no es una URL válida.');
    }

    const expectedRedirect = normalizeRedirectUri(redirectUri);
    const actualRedirect = `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`;
    if (actualRedirect !== expectedRedirect) {
        fail('AUTH_CALLBACK_INVALID', 'El callback no coincide con DAW-fi Desktop.');
    }
    if (parsed.username || parsed.password || parsed.port || parsed.hash) {
        fail('AUTH_CALLBACK_INVALID', 'El callback contiene datos no permitidos.');
    }

    const params = getUniqueSearchParams(parsed);
    const state = params.get('state') || '';
    if (!state || !expectedState || state !== expectedState) {
        fail('AUTH_STATE_MISMATCH', 'La respuesta no coincide con la solicitud iniciada por DAW-fi.');
    }

    const code = params.get('code');
    const providerError = params.get('error');
    if (code && providerError) {
        fail('AUTH_CALLBACK_INVALID', 'El callback contiene resultados incompatibles.');
    }

    if (code) {
        assertAllowedKeys(params, new Set(['code', 'state']));
        if (!OAUTH_CODE_PATTERN.test(code)) {
            fail('AUTH_CALLBACK_INVALID', 'El código de autorización no es válido.');
        }
        return { kind: 'success', code };
    }

    if (providerError) {
        assertAllowedKeys(params, new Set(['error', 'error_description', 'state']));
        const description = params.get('error_description') || 'La autorización fue cancelada.';
        return {
            kind: 'error',
            code: providerError === 'access_denied' ? 'AUTH_USER_CANCELLED' : 'AUTH_CALLBACK_INVALID',
            message: description.slice(0, 300),
        };
    }

    fail('AUTH_CALLBACK_INVALID', 'El callback no incluyó un código de autorización.');
};

const validatePendingRequest = (pending, now = Date.now()) => {
    if (!pending || typeof pending !== 'object') {
        fail('AUTH_CALLBACK_INVALID', 'No existe una solicitud de acceso pendiente.');
    }
    if (!Number.isFinite(pending.expiresAt) || now > pending.expiresAt) {
        fail('AUTH_DESKTOP_HANDOFF_EXPIRED', 'La solicitud de acceso expiró. Iníciala nuevamente.');
    }
    normalizeDawfiSupabaseOrigin(pending.supabaseOrigin);
    normalizeRedirectUri(pending.redirectUri);
    if (typeof pending.state !== 'string' || pending.state.length < 32) {
        fail('AUTH_CALLBACK_INVALID', 'La solicitud de acceso no contiene un estado válido.');
    }
    if (typeof pending.codeVerifier !== 'string' || pending.codeVerifier.length < 43 || pending.codeVerifier.length > 128) {
        fail('AUTH_CALLBACK_INVALID', 'La solicitud de acceso no contiene un verificador PKCE válido.');
    }
    let redirectTo;
    try {
        redirectTo = new URL(pending.redirectTo);
    } catch {
        fail('AUTH_CALLBACK_INVALID', 'La solicitud de acceso no contiene un retorno válido.');
    }
    const desktopBridgeUrl = normalizeDesktopBridgeUrl();
    if (
        `${redirectTo.origin}${redirectTo.pathname}` !== desktopBridgeUrl
        || redirectTo.protocol !== 'https:'
        || redirectTo.username
        || redirectTo.password
        || redirectTo.port
        || redirectTo.searchParams.getAll('state').length !== 1
        || redirectTo.searchParams.get('state') !== pending.state
        || [...redirectTo.searchParams.keys()].some((key) => key !== 'state')
        || redirectTo.hash
    ) {
        fail('AUTH_CALLBACK_INVALID', 'La solicitud de acceso no coincide con su retorno protegido.');
    }
    return pending;
};

const parseTokenResponse = (payload, now = Date.now()) => {
    const accessToken = typeof payload?.access_token === 'string' ? payload.access_token : '';
    const refreshToken = typeof payload?.refresh_token === 'string' ? payload.refresh_token : '';
    const expiresIn = Number(payload?.expires_in);
    const tokenType = typeof payload?.token_type === 'string' ? payload.token_type.toLowerCase() : '';

    if (
        accessToken.length < 20
        || accessToken.length > MAX_TOKEN_LENGTH
        || refreshToken.length < 20
        || refreshToken.length > MAX_TOKEN_LENGTH
        || !Number.isFinite(expiresIn)
        || expiresIn <= 0
        || tokenType !== 'bearer'
    ) {
        fail('AUTH_CALLBACK_INVALID', 'El servidor devolvió una sesión incompleta.');
    }

    return {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: expiresIn,
        expires_at: Math.floor(now / 1000) + Math.floor(expiresIn),
        token_type: 'bearer',
    };
};

const exchangeAuthorizationCode = async ({
    pending,
    code,
    publishableKey,
    fetchImpl = globalThis.fetch,
    signal,
    now = Date.now(),
}) => {
    validatePendingRequest(pending, now);
    const publicKey = validatePublishableKey(publishableKey);
    if (typeof fetchImpl !== 'function') {
        fail('AUTH_NETWORK_UNAVAILABLE', 'No existe un cliente HTTPS disponible.');
    }
    if (typeof code !== 'string' || !OAUTH_CODE_PATTERN.test(code)) {
        fail('AUTH_CALLBACK_INVALID', 'El código de autorización no es válido.');
    }

    const body = JSON.stringify({
        auth_code: code,
        code_verifier: pending.codeVerifier,
    });

    let response;
    try {
        response = await fetchImpl(`${pending.supabaseOrigin}${DAWFI_AUTH_CONTRACT.socialTokenPath}?grant_type=pkce`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                apikey: publicKey,
                Authorization: `Bearer ${publicKey}`,
            },
            body,
            signal,
        });
    } catch {
        fail('AUTH_NETWORK_UNAVAILABLE', 'No se pudo contactar al servidor de autenticación.');
    }

    let payload = null;
    try {
        payload = await response.json();
    } catch {
        payload = null;
    }

    if (!response.ok) {
        const remoteCode = typeof payload?.error === 'string' ? payload.error : '';
        const remoteErrorCode = typeof payload?.error_code === 'string' ? payload.error_code : '';
        if (
            remoteCode === 'invalid_grant'
            || remoteErrorCode === 'bad_code_verifier'
            || remoteErrorCode === 'flow_state_expired'
            || remoteErrorCode === 'flow_state_not_found'
        ) {
            fail('AUTH_DESKTOP_HANDOFF_REPLAYED', 'El código expiró o ya fue utilizado.');
        }
        fail('AUTH_CALLBACK_INVALID', 'El servidor rechazó la autorización de Desktop.');
    }

    return parseTokenResponse(payload, now);
};

const toPublicAuthError = (error) => {
    if (error instanceof DesktopAuthError) {
        return { code: error.code, message: error.message };
    }
    return {
        code: 'AUTH_CALLBACK_INVALID',
        message: 'No se pudo completar la autenticación de Desktop.',
    };
};

module.exports = {
    DAWFI_AUTH_CONTRACT,
    DEFAULT_AUTH_TTL_MS,
    DesktopAuthError,
    createAuthorizationRequest,
    exchangeAuthorizationCode,
    normalizeRedirectUri,
    normalizeDesktopBridgeUrl,
    normalizeDawfiSupabaseOrigin,
    normalizeSupabaseOrigin,
    parseAuthorizationCallback,
    parseTokenResponse,
    toPublicAuthError,
    validatePublishableKey,
    validatePendingRequest,
};
