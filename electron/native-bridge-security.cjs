const nodePath = require('node:path');
const { fileURLToPath } = require('node:url');

class NativeBridgeSecurityError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'NativeBridgeSecurityError';
        this.code = code;
    }
}

const isTrustedRendererUrl = (rawUrl, options = {}) => {
    if (typeof rawUrl !== 'string' || rawUrl.length === 0) return false;
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return false;
    }

    if (options.isDev) {
        return parsed.origin === (options.devOrigin || 'http://localhost:3000');
    }

    if (parsed.protocol !== 'file:' || typeof options.rendererFilePath !== 'string') return false;
    try {
        return nodePath.resolve(fileURLToPath(parsed)) === nodePath.resolve(options.rendererFilePath);
    } catch {
        return false;
    }
};

const requireTrustedIpcSender = (event, options = {}) => {
    const sender = event?.sender;
    const senderFrame = event?.senderFrame;
    const senderId = sender?.id;
    const role = options.roles?.get(senderId);
    const allowedRoles = Array.isArray(options.allowedRoles) ? options.allowedRoles : [];

    if (!Number.isSafeInteger(senderId)
        || !senderFrame
        || senderFrame !== sender.mainFrame
        || !allowedRoles.includes(role)
        || typeof options.isTrustedUrl !== 'function'
        || !options.isTrustedUrl(senderFrame.url)) {
        throw new NativeBridgeSecurityError(
            'UNTRUSTED_IPC_SENDER',
            'La ventana que solicitó acceso nativo no está autorizada.',
        );
    }
    return { senderId, role };
};

const attachTrustedNavigation = (win, isTrustedUrl) => {
    win.webContents.on('will-navigate', (event, url) => {
        if (!isTrustedUrl(url)) event.preventDefault();
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
};

module.exports = {
    NativeBridgeSecurityError,
    attachTrustedNavigation,
    isTrustedRendererUrl,
    requireTrustedIpcSender,
};
