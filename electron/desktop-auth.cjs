const crypto = require('node:crypto');

const DEFAULT_AUTH_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SCOPES = 'openid email profile';
const MAX_TOKEN_LENGTH = 32 * 1024;

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

const validateClientId = (clientId) => {
    const normalized = typeof clientId === 'string' ? clientId.trim() : '';
    if (!/^[A-Za-z0-9._~-]{8,200}$/.test(normalized)) {
        fail('AUTH_CONFIGURATION_MISSING', 'DAW-fi Desktop todavía no tiene un cliente OAuth público configurado.');
    }
    return normalized;
};

const createAuthorizationRequest = ({
    supabaseUrl,
    clientId,
    redirectUri = 'dawfi://auth/callback',
    now = Date.now(),
    ttlMs = DEFAULT_AUTH_TTL_MS,
    randomBytes = crypto.randomBytes,
}) => {
    const origin = normalizeSupabaseOrigin(supabaseUrl);
    const normalizedClientId = validateClientId(clientId);
    const normalizedRedirectUri = normalizeRedirectUri(redirectUri);
    const state = toBase64Url(randomBytes(32));
    const codeVerifier = toBase64Url(randomBytes(48));
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
    const createdAt = Number(now);

    if (!Number.isFinite(createdAt) || !Number.isFinite(ttlMs) || ttlMs <= 0) {
        fail('AUTH_CONFIGURATION_MISSING', 'La configuración temporal de OAuth no es válida.');
    }

    const authorizeUrl = new URL('/auth/v1/oauth/authorize', origin);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', normalizedClientId);
    authorizeUrl.searchParams.set('redirect_uri', normalizedRedirectUri);
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('code_challenge', codeChallenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('scope', DEFAULT_SCOPES);

    return {
        url: authorizeUrl.toString(),
        state,
        codeVerifier,
        clientId: normalizedClientId,
        redirectUri: normalizedRedirectUri,
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
        if (code.length < 8 || code.length > 4096) {
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
    validateClientId(pending.clientId);
    normalizeSupabaseOrigin(pending.supabaseOrigin);
    normalizeRedirectUri(pending.redirectUri);
    if (typeof pending.state !== 'string' || pending.state.length < 32) {
        fail('AUTH_CALLBACK_INVALID', 'La solicitud de acceso no contiene un estado válido.');
    }
    if (typeof pending.codeVerifier !== 'string' || pending.codeVerifier.length < 43 || pending.codeVerifier.length > 128) {
        fail('AUTH_CALLBACK_INVALID', 'La solicitud de acceso no contiene un verificador PKCE válido.');
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
    fetchImpl = globalThis.fetch,
    signal,
    now = Date.now(),
}) => {
    validatePendingRequest(pending, now);
    if (typeof fetchImpl !== 'function') {
        fail('AUTH_NETWORK_UNAVAILABLE', 'No existe un cliente HTTPS disponible.');
    }
    if (typeof code !== 'string' || code.length < 8 || code.length > 4096) {
        fail('AUTH_CALLBACK_INVALID', 'El código de autorización no es válido.');
    }

    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: pending.clientId,
        redirect_uri: pending.redirectUri,
        code_verifier: pending.codeVerifier,
    });

    let response;
    try {
        response = await fetchImpl(`${pending.supabaseOrigin}/auth/v1/oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
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
        if (remoteCode === 'invalid_grant') {
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
    DEFAULT_AUTH_TTL_MS,
    DesktopAuthError,
    createAuthorizationRequest,
    exchangeAuthorizationCode,
    normalizeRedirectUri,
    normalizeSupabaseOrigin,
    parseAuthorizationCallback,
    parseTokenResponse,
    toPublicAuthError,
    validatePendingRequest,
};
