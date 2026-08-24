const { contextBridge, ipcRenderer } = require('electron');
const { normalizeDesktopEditorRequest } = require('./desktop-product-surface.cjs');

const MAX_PROJECT_BUNDLE_BYTES = 1024 * 1024 * 1024;
const PROJECT_BUNDLE_CHUNK_BYTES = 4 * 1024 * 1024;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const assertSafeInteger = (value, label, minimum, maximum) => {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new TypeError(`${label} no es válido.`);
    }
};

const assertProjectSession = (sessionId) => {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
        throw new TypeError('La sesión de proyecto no es válida.');
    }
};

const assertSha256 = (value) => {
    if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
        throw new TypeError('La huella SHA-256 no es válida.');
    }
};

const normalizeChunk = (data) => {
    if (data instanceof ArrayBuffer) return data;
    if (ArrayBuffer.isView(data)) {
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }
    throw new TypeError('El bloque del proyecto debe ser binario.');
};

contextBridge.exposeInMainWorld('electron', {
    platform: process.platform,
    minimize: () => ipcRenderer.send('window-minimize'),
    maximize: () => ipcRenderer.send('window-maximize'),
    close: () => ipcRenderer.send('window-close'),
    getWindowState: () => ipcRenderer.invoke('window-get-state'),
    onWindowStateChange: (callback) => {
        const handler = (_event, payload) => {
            callback(payload);
        };

        ipcRenderer.on('window-state-changed', handler);
        return () => ipcRenderer.removeListener('window-state-changed', handler);
    },
    openEditor: (request) => ipcRenderer.invoke('desktop-open-editor', normalizeDesktopEditorRequest(request)),
    showHub: () => ipcRenderer.invoke('desktop-show-hub'),
    openDesktopAuth: (request) => ipcRenderer.invoke('desktop-open-auth', request),
    cancelDesktopAuth: () => ipcRenderer.invoke('desktop-cancel-auth'),
    openExternalUrl: (url) => ipcRenderer.invoke('desktop-open-external-url', url),
    getPendingAuthCallback: () => ipcRenderer.invoke('desktop-get-pending-auth-callback'),
    getPersistedAuthSession: () => ipcRenderer.invoke('desktop-get-auth-session'),
    persistAuthSession: (session) => ipcRenderer.invoke('desktop-persist-auth-session', session),
    clearPersistedAuthSession: () => ipcRenderer.invoke('desktop-clear-auth-session'),
    onAuthCallback: (callback) => {
        const handler = (_event, payload) => {
            callback(payload);
        };

        ipcRenderer.on('desktop-auth-callback', handler);
        return () => ipcRenderer.removeListener('desktop-auth-callback', handler);
    },
    onHubRefresh: (callback) => {
        const handler = () => {
            callback();
        };

        ipcRenderer.on('desktop-hub-refresh', handler);
        return () => ipcRenderer.removeListener('desktop-hub-refresh', handler);
    },

    // File System Bridges
    saveProject: (data, filename) => ipcRenderer.invoke('save-project', data, filename),
    openProject: () => ipcRenderer.invoke('open-project'),
    beginProjectSave: (request) => {
        if (!request || typeof request.defaultName !== 'string' || request.defaultName.length > 256) {
            throw new TypeError('El nombre del proyecto no es válido.');
        }
        assertSafeInteger(request.totalBytes, 'totalBytes', 1, MAX_PROJECT_BUNDLE_BYTES);
        assertSha256(request.sha256);
        return ipcRenderer.invoke('project-bundle-write-start', {
            defaultName: request.defaultName,
            totalBytes: request.totalBytes,
            sha256: request.sha256,
        });
    },
    writeProjectSaveChunk: (request) => {
        if (!request) throw new TypeError('Falta el bloque del proyecto.');
        assertProjectSession(request.sessionId);
        assertSafeInteger(request.offset, 'offset', 0, MAX_PROJECT_BUNDLE_BYTES);
        assertSha256(request.sha256);
        const data = normalizeChunk(request.data);
        assertSafeInteger(data.byteLength, 'data.byteLength', 1, PROJECT_BUNDLE_CHUNK_BYTES);
        return ipcRenderer.invoke('project-bundle-write-chunk', {
            sessionId: request.sessionId,
            offset: request.offset,
            data,
            sha256: request.sha256,
        });
    },
    completeProjectSave: (request) => {
        assertProjectSession(request?.sessionId);
        return ipcRenderer.invoke('project-bundle-write-complete', { sessionId: request.sessionId });
    },
    cancelProjectSave: (request) => {
        assertProjectSession(request?.sessionId);
        return ipcRenderer.invoke('project-bundle-write-cancel', { sessionId: request.sessionId });
    },
    beginProjectRead: () => ipcRenderer.invoke('project-bundle-read-start'),
    readProjectChunk: (request) => {
        if (!request) throw new TypeError('Falta la solicitud de lectura.');
        assertProjectSession(request.sessionId);
        assertSafeInteger(request.offset, 'offset', 0, MAX_PROJECT_BUNDLE_BYTES);
        assertSafeInteger(request.length, 'length', 1, PROJECT_BUNDLE_CHUNK_BYTES);
        return ipcRenderer.invoke('project-bundle-read-chunk', {
            sessionId: request.sessionId,
            offset: request.offset,
            length: request.length,
        });
    },
    closeProjectRead: (request) => {
        assertProjectSession(request?.sessionId);
        return ipcRenderer.invoke('project-bundle-read-close', { sessionId: request.sessionId });
    },
    selectFiles: () => ipcRenderer.invoke('select-files'),
    readFileFromPath: (filePath) => ipcRenderer.invoke('read-file-from-path', filePath),
    selectDirectory: () => ipcRenderer.invoke('select-directory'),
    scanDirectoryFiles: (request) => ipcRenderer.invoke('scan-directory-files', request),
    transcodeAudio: (request) => ipcRenderer.invoke('transcode-audio', request),
    onBenchmarkStart: (callback) => {
        const handler = (_event, payload) => {
            callback(payload);
        };

        ipcRenderer.on('benchmark-start', handler);
        ipcRenderer.invoke('benchmark-get-config')
            .then((config) => {
                if (config) {
                    callback(config);
                }
            })
            .catch(() => {
                // Non-blocking bootstrap path.
            });

        return () => {
            ipcRenderer.removeListener('benchmark-start', handler);
        };
    },
    publishBenchmarkArtifact: (name, payload) => (
        ipcRenderer.invoke('benchmark-publish-artifact', { name, payload })
    ),
    publishBenchmarkStatus: (status, details) => (
        ipcRenderer.invoke('benchmark-publish-status', { status, details })
    ),
});
