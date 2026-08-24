const nodePath = require('node:path');
const nodeFsConstants = require('node:fs').constants;
const nodeFs = require('node:fs/promises');
const nodeCrypto = require('node:crypto');

const MAX_PROJECT_BUNDLE_BYTES = 1024 * 1024 * 1024;
const PROJECT_BUNDLE_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_PROJECT_BUNDLE_FILENAME_CHARS = 160;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class ProjectBundleIoError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'ProjectBundleIoError';
        this.code = code;
    }
}

const fail = (code, message) => {
    throw new ProjectBundleIoError(code, message);
};

const assertSafeInteger = (value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) => {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        fail('INVALID_PAYLOAD', `${label} no es un entero permitido.`);
    }
    return value;
};

const assertSenderId = (value) => assertSafeInteger(value, 'senderId', { minimum: 1 });

const assertSessionId = (value) => {
    if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) {
        fail('INVALID_SESSION', 'La sesión de archivo no es válida.');
    }
    return value;
};

const assertSha256 = (value, label = 'sha256') => {
    if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
        fail('INVALID_DIGEST', `${label} debe ser una huella SHA-256 hexadecimal válida.`);
    }
    return value;
};

const assertAbsoluteEspPath = (value, pathApi = nodePath) => {
    if (typeof value !== 'string'
        || value.length === 0
        || value.length > 4096
        || value.includes('\0')
        || !pathApi.isAbsolute(value)
        || pathApi.extname(value).toLowerCase() !== '.esp') {
        fail('INVALID_PATH', 'La ruta debe ser un archivo .esp absoluto y válido.');
    }
    return pathApi.normalize(value);
};

const sanitizeProjectBundleFileName = (value) => {
    const rawName = typeof value === 'string' ? value : '';
    const withoutExtension = rawName.replace(/\.esp$/i, '');
    const sanitized = withoutExtension
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
        .replace(/[. ]+$/g, '')
        .trim()
        .slice(0, MAX_PROJECT_BUNDLE_FILENAME_CHARS) || 'Sin-titulo';
    return `${sanitized}.esp`;
};

const toChunkBuffer = (value) => {
    if (value instanceof ArrayBuffer) {
        return Buffer.from(new Uint8Array(value));
    }
    if (ArrayBuffer.isView(value)) {
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    fail('INVALID_PAYLOAD', 'El bloque del proyecto debe ser binario.');
};

const pathExists = async (fsApi, targetPath) => {
    try {
        await fsApi.lstat(targetPath);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
};

class ProjectBundleIoManager {
    constructor(options = {}) {
        this.fs = options.fs || nodeFs;
        this.path = options.path || nodePath;
        this.crypto = options.crypto || nodeCrypto;
        this.platform = options.platform || process.platform;
        this.readFlags = options.readFlags ?? (
            this.platform === 'win32'
                ? nodeFsConstants.O_RDONLY
                : nodeFsConstants.O_RDONLY | (nodeFsConstants.O_NOFOLLOW || 0)
        );
        this.maxBytes = options.maxBytes || MAX_PROJECT_BUNDLE_BYTES;
        this.chunkBytes = options.chunkBytes || PROJECT_BUNDLE_CHUNK_BYTES;
        this.writeSessions = new Map();
        this.readSessions = new Map();
    }

    async beginWrite({ senderId, targetPath, totalBytes, sha256 }) {
        const safeSenderId = assertSenderId(senderId);
        const safeTargetPath = assertAbsoluteEspPath(targetPath, this.path);
        const safeTotalBytes = assertSafeInteger(totalBytes, 'totalBytes', {
            minimum: 1,
            maximum: this.maxBytes,
        });
        const expectedSha256 = assertSha256(sha256);

        await this.closeForSender(safeSenderId);

        const parentDirectory = this.path.dirname(safeTargetPath);
        const parentStats = await this.fs.lstat(parentDirectory);
        if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
            fail('INVALID_PATH', 'El directorio de destino no es válido.');
        }

        if (await pathExists(this.fs, safeTargetPath)) {
            const targetStats = await this.fs.lstat(safeTargetPath);
            if (!targetStats.isFile() || targetStats.isSymbolicLink()) {
                fail('INVALID_PATH', 'El destino existente no es un archivo regular.');
            }
        }

        const sessionId = this.crypto.randomUUID();
        const tempPath = this.path.join(
            parentDirectory,
            `.${this.path.basename(safeTargetPath)}.${sessionId}.tmp`,
        );
        const handle = await this.fs.open(tempPath, 'wx', 0o600);
        this.writeSessions.set(sessionId, {
            senderId: safeSenderId,
            targetPath: safeTargetPath,
            tempPath,
            handle,
            totalBytes: safeTotalBytes,
            expectedSha256,
            sha256: this.crypto.createHash('sha256'),
            offset: 0,
            closed: false,
        });

        return { sessionId, chunkBytes: this.chunkBytes };
    }

    getWriteSession(senderId, sessionId) {
        const safeSenderId = assertSenderId(senderId);
        const safeSessionId = assertSessionId(sessionId);
        const session = this.writeSessions.get(safeSessionId);
        if (!session || session.senderId !== safeSenderId || session.closed) {
            fail('INVALID_SESSION', 'La sesión de escritura no existe o no pertenece a esta ventana.');
        }
        return session;
    }

    async appendWriteChunk({ senderId, sessionId, offset, data, sha256 }) {
        const session = this.getWriteSession(senderId, sessionId);
        const safeOffset = assertSafeInteger(offset, 'offset', { maximum: session.totalBytes });
        if (safeOffset !== session.offset) {
            fail('INVALID_OFFSET', 'El bloque no continúa en el offset esperado.');
        }

        const chunk = toChunkBuffer(data);
        if (chunk.byteLength <= 0 || chunk.byteLength > this.chunkBytes) {
            fail('INVALID_CHUNK', 'El bloque binario está vacío o supera el límite permitido.');
        }
        if (session.offset + chunk.byteLength > session.totalBytes) {
            fail('SIZE_MISMATCH', 'El bloque excede el tamaño declarado del proyecto.');
        }
        const expectedChunkSha256 = assertSha256(sha256, 'sha256 del bloque');
        const actualChunkSha256 = this.crypto.createHash('sha256').update(chunk).digest('hex');
        if (actualChunkSha256 !== expectedChunkSha256) {
            fail('DIGEST_MISMATCH', 'El bloque recibido no coincide con su huella declarada.');
        }

        let written = 0;
        while (written < chunk.byteLength) {
            const result = await session.handle.write(
                chunk,
                written,
                chunk.byteLength - written,
                session.offset + written,
            );
            if (!result || result.bytesWritten <= 0) {
                fail('SHORT_WRITE', 'No se pudo escribir el bloque completo del proyecto.');
            }
            written += result.bytesWritten;
        }
        session.sha256.update(chunk);
        session.offset += written;
        return { nextOffset: session.offset };
    }

    async syncDirectory(directory) {
        let directoryHandle;
        try {
            directoryHandle = await this.fs.open(directory, 'r');
            await directoryHandle.sync();
        } catch {
            // Some Windows/filesystem combinations do not allow directory fsync.
        } finally {
            if (directoryHandle) {
                await directoryHandle.close().catch(() => undefined);
            }
        }
    }

    async sha256File(filePath) {
        const handle = await this.fs.open(filePath, 'r');
        const hash = this.crypto.createHash('sha256');
        const buffer = Buffer.allocUnsafe(this.chunkBytes);
        let offset = 0;
        try {
            while (true) {
                const result = await handle.read(buffer, 0, buffer.byteLength, offset);
                if (!result || result.bytesRead === 0) break;
                hash.update(buffer.subarray(0, result.bytesRead));
                offset += result.bytesRead;
            }
            return hash.digest('hex');
        } finally {
            await handle.close().catch(() => undefined);
        }
    }

    async publishTempFile(session) {
        const parentDirectory = this.path.dirname(session.targetPath);
        const targetExists = await pathExists(this.fs, session.targetPath);
        if (!targetExists) {
            await this.fs.rename(session.tempPath, session.targetPath);
            await this.syncDirectory(parentDirectory);
            return;
        }

        const targetStats = await this.fs.lstat(session.targetPath);
        if (!targetStats.isFile() || targetStats.isSymbolicLink()) {
            fail('INVALID_PATH', 'El destino dejó de ser un archivo regular antes de publicar.');
        }

        const extension = this.path.extname(session.targetPath);
        const stem = session.targetPath.slice(0, -extension.length);
        const backupPath = `${stem}.backup-${Date.now()}-${this.crypto.randomUUID()}${extension}`;
        await this.fs.rename(session.targetPath, backupPath);
        try {
            await this.fs.rename(session.tempPath, session.targetPath);
            await this.syncDirectory(parentDirectory);
            session.backupPath = backupPath;
        } catch (error) {
            await this.fs.rename(backupPath, session.targetPath).catch(() => undefined);
            await this.syncDirectory(parentDirectory);
            throw error;
        }
    }

    async completeWrite({ senderId, sessionId }) {
        const safeSessionId = assertSessionId(sessionId);
        const session = this.getWriteSession(senderId, safeSessionId);
        if (session.offset !== session.totalBytes) {
            fail('SIZE_MISMATCH', 'El proyecto recibido no coincide con el tamaño declarado.');
        }

        try {
            const streamedSha256 = session.sha256.digest('hex');
            if (streamedSha256 !== session.expectedSha256) {
                fail('DIGEST_MISMATCH', 'El proyecto recibido no coincide con su huella SHA-256 declarada.');
            }
            await session.handle.sync();
            await session.handle.close();
            session.closed = true;
            const persistedSha256 = await this.sha256File(session.tempPath);
            if (persistedSha256 !== session.expectedSha256) {
                fail('DIGEST_MISMATCH', 'La copia temporal no superó la verificación SHA-256.');
            }
            await this.publishTempFile(session);
            this.writeSessions.delete(safeSessionId);
            return {
                success: true,
                filePath: this.path.basename(session.targetPath, '.esp'),
                backupFileName: session.backupPath
                    ? this.path.basename(session.backupPath)
                    : undefined,
            };
        } catch (error) {
            session.closed = true;
            this.writeSessions.delete(safeSessionId);
            await session.handle.close().catch(() => undefined);
            await this.fs.unlink(session.tempPath).catch(() => undefined);
            throw error;
        }
    }

    async cancelWrite({ senderId, sessionId }) {
        const safeSenderId = assertSenderId(senderId);
        const safeSessionId = assertSessionId(sessionId);
        const session = this.writeSessions.get(safeSessionId);
        if (!session || session.senderId !== safeSenderId) return false;
        this.writeSessions.delete(safeSessionId);
        session.closed = true;
        await session.handle.close().catch(() => undefined);
        await this.fs.unlink(session.tempPath).catch(() => undefined);
        return true;
    }

    async beginRead({ senderId, filePath }) {
        const safeSenderId = assertSenderId(senderId);
        const safeFilePath = assertAbsoluteEspPath(filePath, this.path);
        await this.closeForSender(safeSenderId);

        const pathStats = await this.fs.lstat(safeFilePath);
        if (!pathStats.isFile() || pathStats.isSymbolicLink()) {
            fail('INVALID_PATH', 'El proyecto seleccionado no es un archivo regular.');
        }
        if (!Number.isSafeInteger(pathStats.size) || pathStats.size <= 0 || pathStats.size > this.maxBytes) {
            fail('ARCHIVE_TOO_LARGE', 'El proyecto está vacío o supera el límite permitido.');
        }

        let handle;
        try {
            handle = await this.fs.open(safeFilePath, this.readFlags);
        } catch (error) {
            if (error?.code === 'ELOOP') {
                fail('FILE_CHANGED', 'El proyecto cambió a un enlace simbólico durante la apertura.');
            }
            throw error;
        }
        const handleStats = await handle.stat();
        if (!handleStats.isFile()
            || handleStats.dev !== pathStats.dev
            || handleStats.ino !== pathStats.ino
            || handleStats.size !== pathStats.size) {
            await handle.close().catch(() => undefined);
            fail('FILE_CHANGED', 'El proyecto cambió mientras se preparaba su lectura.');
        }

        const sessionId = this.crypto.randomUUID();
        this.readSessions.set(sessionId, {
            senderId: safeSenderId,
            filePath: safeFilePath,
            handle,
            totalBytes: handleStats.size,
            offset: 0,
            closed: false,
        });
        return {
            sessionId,
            filename: this.path.basename(safeFilePath),
            totalBytes: handleStats.size,
            chunkBytes: this.chunkBytes,
        };
    }

    getReadSession(senderId, sessionId) {
        const safeSenderId = assertSenderId(senderId);
        const safeSessionId = assertSessionId(sessionId);
        const session = this.readSessions.get(safeSessionId);
        if (!session || session.senderId !== safeSenderId || session.closed) {
            fail('INVALID_SESSION', 'La sesión de lectura no existe o no pertenece a esta ventana.');
        }
        return session;
    }

    async readChunk({ senderId, sessionId, offset, length }) {
        const session = this.getReadSession(senderId, sessionId);
        const safeOffset = assertSafeInteger(offset, 'offset', { maximum: session.totalBytes });
        const safeLength = assertSafeInteger(length, 'length', { minimum: 1, maximum: this.chunkBytes });
        if (safeOffset !== session.offset) {
            fail('INVALID_OFFSET', 'La lectura no continúa en el offset esperado.');
        }
        const remaining = session.totalBytes - session.offset;
        if (remaining <= 0) {
            fail('INVALID_OFFSET', 'No quedan bytes por leer.');
        }

        const requested = Math.min(safeLength, remaining);
        const buffer = Buffer.allocUnsafe(requested);
        const result = await session.handle.read(buffer, 0, requested, session.offset);
        if (!result || result.bytesRead !== requested) {
            fail('SHORT_READ', 'No se pudo leer el bloque completo del proyecto.');
        }
        const chunk = buffer.subarray(0, result.bytesRead);
        const response = new Uint8Array(chunk.byteLength);
        response.set(chunk);
        session.offset += result.bytesRead;
        return {
            offset: safeOffset,
            nextOffset: session.offset,
            data: response.buffer,
        };
    }

    async closeRead({ senderId, sessionId }) {
        const safeSenderId = assertSenderId(senderId);
        const safeSessionId = assertSessionId(sessionId);
        const session = this.readSessions.get(safeSessionId);
        if (!session || session.senderId !== safeSenderId) return false;
        this.readSessions.delete(safeSessionId);
        session.closed = true;
        await session.handle.close().catch(() => undefined);
        return true;
    }

    async closeForSender(senderId) {
        const safeSenderId = assertSenderId(senderId);
        const writes = Array.from(this.writeSessions.entries())
            .filter(([, session]) => session.senderId === safeSenderId)
            .map(([sessionId]) => this.cancelWrite({ senderId: safeSenderId, sessionId }));
        const reads = Array.from(this.readSessions.entries())
            .filter(([, session]) => session.senderId === safeSenderId)
            .map(([sessionId]) => this.closeRead({ senderId: safeSenderId, sessionId }));
        await Promise.allSettled([...writes, ...reads]);
    }

    async closeAll() {
        const senderIds = new Set([
            ...Array.from(this.writeSessions.values(), (session) => session.senderId),
            ...Array.from(this.readSessions.values(), (session) => session.senderId),
        ]);
        await Promise.allSettled(Array.from(senderIds, (senderId) => this.closeForSender(senderId)));
    }
}

module.exports = {
    MAX_PROJECT_BUNDLE_BYTES,
    PROJECT_BUNDLE_CHUNK_BYTES,
    ProjectBundleIoError,
    ProjectBundleIoManager,
    assertAbsoluteEspPath,
    assertSessionId,
    assertSha256,
    sanitizeProjectBundleFileName,
    toChunkBuffer,
};
