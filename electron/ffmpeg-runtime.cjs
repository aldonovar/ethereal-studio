const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');

const SUPPORTED_AUDIO_IMPORT_EXTENSIONS = Object.freeze([
    'wav',
    'mp3',
    'flac',
    'ogg',
    'oga',
    'opus',
    'aif',
    'aiff',
    'm4a',
    'mp4',
    'aac',
    'webm'
]);

const normalizePackagedBinaryPath = (candidate) => {
    if (typeof candidate !== 'string' || candidate.trim() === '') return null;
    const normalized = candidate.trim();
    return normalized.includes('app.asar')
        ? normalized.replace('app.asar', 'app.asar.unpacked')
        : normalized;
};

const isUsableBinaryFile = (candidate, options = {}) => {
    const normalized = normalizePackagedBinaryPath(candidate);
    if (!normalized) return false;

    const fsAccessSync = options.fsAccessSync || fs.accessSync;
    const platform = options.platform || process.platform;
    try {
        const mode = platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK;
        fsAccessSync(normalized, mode);
        return true;
    } catch {
        return false;
    }
};

const canExecuteSystemFfmpeg = (options = {}) => {
    const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
    try {
        const result = spawnSyncImpl('ffmpeg', ['-version'], {
            stdio: 'ignore',
            windowsHide: true,
            timeout: 3000
        });
        return !result.error && result.status === 0;
    } catch {
        return false;
    }
};

const resolveFfmpegBinary = (options = {}) => {
    const env = options.env || process.env;
    const candidates = [env.DAWFI_FFMPEG_PATH, options.staticPath]
        .map(normalizePackagedBinaryPath)
        .filter(Boolean);

    for (const candidate of candidates) {
        if (isUsableBinaryFile(candidate, options)) return candidate;
    }

    return canExecuteSystemFfmpeg(options) ? 'ffmpeg' : null;
};

const runFfmpeg = (binary, args, options = {}) => new Promise((resolve, reject) => {
    if (!binary) {
        reject(new Error('FFmpeg no está disponible. Reinstala DAW-fi o configura DAWFI_FFMPEG_PATH.'));
        return;
    }

    const spawnImpl = options.spawnImpl || spawn;
    const child = spawnImpl(binary, args, { windowsHide: true });
    const maxStderrBytes = options.maxStderrBytes || 256 * 1024;
    const timeoutMs = options.timeoutMs || 120000;
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
        try {
            child.kill?.('SIGKILL');
        } catch {
            // The close/error handlers below remain the final process cleanup path.
        }
        fail(new Error('FFmpeg excedió el tiempo máximo permitido.'));
    }, timeoutMs);
    timeout.unref?.();

    const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
    };

    child.stderr?.on('data', (chunk) => {
        if (stderr.length >= maxStderrBytes) return;
        stderr += chunk.toString().slice(0, maxStderrBytes - stderr.length);
    });

    child.on('error', (error) => {
        const message = error?.code === 'ENOENT'
            ? 'FFmpeg no está instalado o la build de DAW-fi no incluye su binario.'
            : error?.message || 'No se pudo iniciar FFmpeg.';
        fail(new Error(message));
    });

    child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (code === 0) {
            resolve();
            return;
        }
        reject(new Error(stderr.trim() || `FFmpeg finalizó con código ${code}.`));
    });
});

module.exports = {
    SUPPORTED_AUDIO_IMPORT_EXTENSIONS,
    canExecuteSystemFfmpeg,
    isUsableBinaryFile,
    normalizePackagedBinaryPath,
    resolveFfmpegBinary,
    runFfmpeg
};
