const nodePath = require('node:path');
const nodeFs = require('node:fs/promises');
const nodeFsConstants = require('node:fs').constants;

const DEFAULT_MAX_AUDIO_BYTES = 512 * 1024 * 1024;
const DEFAULT_SCAN_LIMIT = 10000;
const MAX_PATH_CHARS = 4096;

class NativeFileGrantError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'NativeFileGrantError';
        this.code = code;
    }
}

const fail = (code, message) => {
    throw new NativeFileGrantError(code, message);
};

const normalizeExtension = (value) => (
    typeof value === 'string' ? value.trim().toLowerCase().replace(/^\./, '') : ''
);

const assertSenderId = (senderId) => {
    if (!Number.isSafeInteger(senderId) || senderId <= 0) {
        fail('INVALID_SENDER', 'La ventana no tiene una identidad válida.');
    }
    return senderId;
};

const assertAbsolutePath = (value, pathApi = nodePath) => {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized
        || normalized.length > MAX_PATH_CHARS
        || normalized.includes('\0')
        || !pathApi.isAbsolute(normalized)) {
        fail('INVALID_PATH', 'La ruta solicitada no es válida.');
    }
    return pathApi.normalize(normalized);
};

const isWithinRoot = (root, candidate, pathApi = nodePath) => {
    const relative = pathApi.relative(root, candidate);
    return relative === '' || (
        relative !== '..'
        && !relative.startsWith(`..${pathApi.sep}`)
        && !pathApi.isAbsolute(relative)
    );
};

class NativeFileGrantManager {
    constructor(options = {}) {
        this.fs = options.fs || nodeFs;
        this.path = options.path || nodePath;
        this.platform = options.platform || process.platform;
        this.constants = options.constants || nodeFsConstants;
        this.maxAudioBytes = options.maxAudioBytes || DEFAULT_MAX_AUDIO_BYTES;
        this.scanLimit = options.scanLimit || DEFAULT_SCAN_LIMIT;
        this.audioExtensions = new Set(
            (options.audioExtensions || []).map(normalizeExtension).filter(Boolean),
        );
        this.scanExtensions = new Set(
            (options.scanExtensions || options.audioExtensions || []).map(normalizeExtension).filter(Boolean),
        );
        this.senderGrants = new Map();
    }

    grantsFor(senderId) {
        const safeSenderId = assertSenderId(senderId);
        let grants = this.senderGrants.get(safeSenderId);
        if (!grants) {
            grants = { files: new Map(), roots: new Set() };
            this.senderGrants.set(safeSenderId, grants);
        }
        return grants;
    }

    clearSender(senderId) {
        this.senderGrants.delete(assertSenderId(senderId));
    }

    assertAudioExtension(filePath) {
        const extension = normalizeExtension(this.path.extname(filePath));
        if (!this.audioExtensions.has(extension)) {
            fail('UNSUPPORTED_AUDIO', 'El archivo no usa un formato de audio admitido.');
        }
        return extension;
    }

    async openVerifiedRegularFile(rawPath) {
        const filePath = assertAbsolutePath(rawPath, this.path);
        const before = await this.fs.lstat(filePath);
        if (!before.isFile() || before.isSymbolicLink()) {
            fail('INVALID_PATH', 'La ruta no corresponde a un archivo regular sin enlaces.');
        }

        const canonicalPath = await this.fs.realpath(filePath);
        const flags = this.constants.O_RDONLY | (
            this.platform === 'win32' ? 0 : (this.constants.O_NOFOLLOW || 0)
        );
        let handle;
        try {
            handle = await this.fs.open(filePath, flags);
        } catch (error) {
            if (error?.code === 'ELOOP') {
                fail('FILE_CHANGED', 'El archivo cambió a un enlace durante la apertura.');
            }
            throw error;
        }

        try {
            const opened = await handle.stat();
            if (!opened.isFile()
                || opened.dev !== before.dev
                || opened.ino !== before.ino
                || opened.size !== before.size) {
                fail('FILE_CHANGED', 'El archivo cambió entre su validación y apertura.');
            }
            return { canonicalPath, handle, stats: opened };
        } catch (error) {
            await handle.close().catch(() => undefined);
            throw error;
        }
    }

    async verifyDirectory(rawPath) {
        const directory = assertAbsolutePath(rawPath, this.path);
        const before = await this.fs.lstat(directory);
        if (!before.isDirectory() || before.isSymbolicLink()) {
            fail('INVALID_PATH', 'La ruta no corresponde a una carpeta regular sin enlaces.');
        }
        const canonicalPath = await this.fs.realpath(directory);

        if (this.platform !== 'win32') {
            let handle;
            try {
                const flags = this.constants.O_RDONLY
                    | (this.constants.O_DIRECTORY || 0)
                    | (this.constants.O_NOFOLLOW || 0);
                handle = await this.fs.open(directory, flags);
                const opened = await handle.stat();
                if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) {
                    fail('FILE_CHANGED', 'La carpeta cambió entre su validación y apertura.');
                }
            } finally {
                if (handle) await handle.close().catch(() => undefined);
            }
        }
        return canonicalPath;
    }

    async grantSelectedAudioFile(senderId, rawPath) {
        this.assertAudioExtension(rawPath);
        const opened = await this.openVerifiedRegularFile(rawPath);
        try {
            if (opened.stats.size <= 0 || opened.stats.size > this.maxAudioBytes) {
                fail('AUDIO_TOO_LARGE', 'El audio está vacío o supera el límite permitido.');
            }
            this.grantsFor(senderId).files.set(opened.canonicalPath, {
                dev: opened.stats.dev,
                ino: opened.stats.ino,
            });
            return {
                name: this.path.basename(opened.canonicalPath),
                path: opened.canonicalPath,
                size: opened.stats.size,
            };
        } finally {
            await opened.handle.close().catch(() => undefined);
        }
    }

    async grantDirectory(senderId, rawPath) {
        const canonicalPath = await this.verifyDirectory(rawPath);
        this.grantsFor(senderId).roots.add(canonicalPath);
        return canonicalPath;
    }

    async resolveGrantedDirectory(senderId, rawPath) {
        const canonicalPath = await this.verifyDirectory(rawPath);
        const grants = this.grantsFor(senderId);
        if (!Array.from(grants.roots).some((root) => isWithinRoot(root, canonicalPath, this.path))) {
            fail('PATH_NOT_GRANTED', 'La carpeta no fue autorizada por el selector nativo.');
        }
        return canonicalPath;
    }

    async readGrantedAudioFile(senderId, rawPath) {
        this.assertAudioExtension(rawPath);
        const requestedPath = assertAbsolutePath(rawPath, this.path);
        const requestedCanonicalPath = await this.fs.realpath(requestedPath);
        const initialGrants = this.grantsFor(senderId);
        const initiallyAuthorized = initialGrants.files.has(requestedCanonicalPath)
            || Array.from(initialGrants.roots).some((root) => (
                isWithinRoot(root, requestedCanonicalPath, this.path)
            ));
        if (!initiallyAuthorized) {
            fail('PATH_NOT_GRANTED', 'El archivo no fue autorizado por un selector nativo.');
        }
        const opened = await this.openVerifiedRegularFile(rawPath);
        try {
            const grants = this.grantsFor(senderId);
            const explicitGrant = grants.files.get(opened.canonicalPath);
            const authorized = Boolean(
                explicitGrant
                && explicitGrant.dev === opened.stats.dev
                && explicitGrant.ino === opened.stats.ino
            ) || Array.from(grants.roots).some((root) => (
                isWithinRoot(root, opened.canonicalPath, this.path)
            ));
            if (!authorized) {
                fail('PATH_NOT_GRANTED', 'El archivo no fue autorizado por un selector nativo.');
            }
            if (opened.stats.size <= 0 || opened.stats.size > this.maxAudioBytes) {
                fail('AUDIO_TOO_LARGE', 'El audio está vacío o supera el límite permitido.');
            }
            const buffer = await opened.handle.readFile();
            if (buffer.byteLength !== opened.stats.size) {
                fail('FILE_CHANGED', 'El audio cambió durante su lectura.');
            }
            return {
                name: this.path.basename(opened.canonicalPath),
                path: opened.canonicalPath,
                data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
            };
        } finally {
            await opened.handle.close().catch(() => undefined);
        }
    }

    async scanGrantedDirectory(senderId, rawDirectory, requestedExtensions) {
        const root = await this.resolveGrantedDirectory(senderId, rawDirectory);
        const extensions = new Set(
            (Array.isArray(requestedExtensions) ? requestedExtensions : [])
                .map(normalizeExtension)
                .filter((extension) => this.scanExtensions.has(extension)),
        );
        if (extensions.size === 0) return [];

        const queue = [root];
        const collected = [];
        while (queue.length > 0 && collected.length < this.scanLimit) {
            const current = queue.pop();
            if (!current) continue;
            let canonicalDirectory;
            try {
                canonicalDirectory = await this.verifyDirectory(current);
            } catch {
                continue;
            }
            if (!isWithinRoot(root, canonicalDirectory, this.path)) continue;

            let entries;
            try {
                entries = await this.fs.readdir(canonicalDirectory, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const entry of entries) {
                if (collected.length >= this.scanLimit) break;
                const fullPath = this.path.join(canonicalDirectory, entry.name);
                if (entry.isSymbolicLink?.()) continue;
                if (entry.isDirectory()) {
                    queue.push(fullPath);
                    continue;
                }
                if (!entry.isFile()) continue;
                const extension = normalizeExtension(this.path.extname(entry.name));
                if (!extensions.has(extension)) continue;

                let opened;
                try {
                    opened = await this.openVerifiedRegularFile(fullPath);
                    if (!isWithinRoot(root, opened.canonicalPath, this.path)) continue;
                    if (this.audioExtensions.has(extension)) {
                        if (opened.stats.size <= 0 || opened.stats.size > this.maxAudioBytes) continue;
                        this.grantsFor(senderId).files.set(opened.canonicalPath, {
                            dev: opened.stats.dev,
                            ino: opened.stats.ino,
                        });
                    }
                    collected.push({
                        name: this.path.basename(opened.canonicalPath),
                        path: opened.canonicalPath,
                        size: opened.stats.size,
                    });
                } catch {
                    // An individual raced, linked or unreadable entry does not abort the complete scan.
                } finally {
                    if (opened?.handle) await opened.handle.close().catch(() => undefined);
                }
            }
        }
        return collected;
    }
}

module.exports = {
    DEFAULT_MAX_AUDIO_BYTES,
    NativeFileGrantError,
    NativeFileGrantManager,
    assertAbsolutePath,
    isWithinRoot,
    normalizeExtension,
};
