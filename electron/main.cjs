const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const {
    BENCHMARK_MODE,
    parseLiveCaptureConfig,
    resolveBenchmarkArtifactPath,
    sanitizeBenchmarkStatus
} = require('./benchmarkBridge.cjs');
const {
    DesktopAuthError,
    createAuthorizationRequest,
    exchangeAuthorizationCode,
    parseAuthorizationCallback,
    parseTokenResponse,
    toPublicAuthError,
    validatePendingRequest
} = require('./desktop-auth.cjs');

const AUDIO_FORMATS = new Set(['wav', 'aiff', 'flac', 'mp3']);
const AUDIO_MIME_BY_FORMAT = {
    wav: 'audio/wav',
    aiff: 'audio/aiff',
    flac: 'audio/flac',
    mp3: 'audio/mpeg'
};

let ffmpegBinaryPath = null;
try {
    const resolved = require('ffmpeg-static');
    if (resolved) {
        ffmpegBinaryPath = resolved.includes('app.asar')
            ? resolved.replace('app.asar', 'app.asar.unpacked')
            : resolved;
    }
} catch (error) {
    ffmpegBinaryPath = null;
    console.warn('FFmpeg static binary is not available.', error);
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const toNodeBuffer = (value) => {
    if (!value) return null;
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
    if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    if (typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) {
        return Buffer.from(value.data);
    }
    return null;
};

const getCodecArgs = (format, bitDepth) => {
    if (format === 'wav') {
        const codec = bitDepth === 32 ? 'pcm_f32le' : bitDepth === 24 ? 'pcm_s24le' : 'pcm_s16le';
        return ['-c:a', codec];
    }

    if (format === 'aiff') {
        const codec = bitDepth === 32 ? 'pcm_f32be' : bitDepth === 24 ? 'pcm_s24be' : 'pcm_s16be';
        return ['-c:a', codec];
    }

    if (format === 'flac') {
        const sampleFmt = bitDepth <= 16 ? 's16' : 's32';
        return ['-c:a', 'flac', '-compression_level', '8', '-sample_fmt', sampleFmt];
    }

    return ['-c:a', 'libmp3lame', '-b:a', '320k', '-joint_stereo', '1'];
};

const runFfmpeg = (args) => new Promise((resolve, reject) => {
    if (!ffmpegBinaryPath) {
        reject(new Error('FFmpeg no esta disponible en esta build.'));
        return;
    }

    const child = spawn(ffmpegBinaryPath, args, {
        windowsHide: true
    });

    let stderr = '';

    child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
    });

    child.on('error', (error) => {
        reject(error);
    });

    child.on('close', (code) => {
        if (code === 0) {
            resolve();
            return;
        }

        reject(new Error(stderr || `FFmpeg finalizo con codigo ${code}.`));
    });
});

const DIRECTORY_SCAN_LIMIT = 10000;
const MAX_DIRECT_FILE_READ_BYTES = 512 * 1024 * 1024;
const MAX_IMPORT_FILE_BYTES = 256 * 1024 * 1024;
const MAX_IMPORT_BATCH_BYTES = 1024 * 1024 * 1024;

let mainWindow = null;
let hubWindow = null;
let editorWindow = null;
let pendingAuthCallbackUrl = null;
let pendingAuthCallbackResult = null;
let pendingDesktopAuthRequest = null;
let volatileDesktopAuthSession = null;
const liveBenchmarkConfig = parseLiveCaptureConfig(process.argv, process.env);
const liveBenchmarkRuntime = {
    enabled: Boolean(liveBenchmarkConfig),
    startedAt: 0,
    completedAt: 0,
    status: 'idle'
};

const logMainError = (label, error) => {
    const message = error instanceof Error
        ? `${error.message}\n${error.stack || ''}`.trim()
        : String(error);
    console.error(`[main:${label}] ${message}`);
};

process.on('uncaughtException', (error) => {
    logMainError('uncaughtException', error);
});

process.on('unhandledRejection', (reason) => {
    logMainError('unhandledRejection', reason);
});

const sanitizeExtensions = (extensions) => {
    if (!Array.isArray(extensions)) return new Set();

    return new Set(
        extensions
            .filter((entry) => typeof entry === 'string')
            .map((entry) => entry.trim().toLowerCase().replace(/^\./, ''))
            .filter((entry) => entry.length > 0)
    );
};

const scanDirectoryRecursive = async (rootDirectory, allowedExtensions) => {
    const queue = [rootDirectory];
    const collected = [];

    while (queue.length > 0 && collected.length < DIRECTORY_SCAN_LIMIT) {
        const current = queue.pop();
        if (!current) continue;

        let entries = [];
        try {
            entries = await fs.readdir(current, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (collected.length >= DIRECTORY_SCAN_LIMIT) break;

            const fullPath = path.join(current, entry.name);

            if (entry.isDirectory()) {
                queue.push(fullPath);
                continue;
            }

            if (!entry.isFile()) continue;

            const extension = path.extname(entry.name).toLowerCase().replace(/^\./, '');
            if (allowedExtensions.size > 0 && !allowedExtensions.has(extension)) {
                continue;
            }

            let size = 0;
            try {
                const fileStats = await fs.stat(fullPath);
                size = fileStats.size;
            } catch {
                size = 0;
            }

            collected.push({
                name: entry.name,
                path: fullPath,
                size
            });
        }
    }

    return collected;
};

const serializeWindowState = (win) => {
    if (!win) {
        return {
            isMaximized: false,
            isMinimized: false,
            isFullScreen: false
        };
    }

    return {
        isMaximized: win.isMaximized(),
        isMinimized: win.isMinimized(),
        isFullScreen: win.isFullScreen()
    };
};

const broadcastWindowState = (win) => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('window-state-changed', serializeWindowState(win));
};

// IPC Handlers
ipcMain.on('window-minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.minimize();
});
ipcMain.on('window-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win?.isMaximized()) {
        win.unmaximize();
    } else {
        win?.maximize();
    }
    broadcastWindowState(win);
});
ipcMain.on('window-close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.close();
});
ipcMain.handle('window-get-state', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return serializeWindowState(win);
});

ipcMain.handle('benchmark-get-config', () => {
    if (!liveBenchmarkRuntime.enabled || !liveBenchmarkConfig) {
        return null;
    }
    return {
        tracks: liveBenchmarkConfig.tracks,
        scenes: liveBenchmarkConfig.scenes,
        quantizeBars: liveBenchmarkConfig.quantizeBars,
        durationMinutes: liveBenchmarkConfig.durationMinutes,
        recordingCycles: liveBenchmarkConfig.recordingCycles,
        timeoutMs: liveBenchmarkConfig.timeoutMs,
        seed: liveBenchmarkConfig.seed
    };
});

ipcMain.handle('benchmark-publish-artifact', async (_event, payload) => {
    if (!liveBenchmarkRuntime.enabled) {
        return { success: false, error: 'Benchmark mode is disabled.' };
    }

    const name = typeof payload?.name === 'string' ? payload.name : '';
    const resolved = resolveBenchmarkArtifactPath(name, process.cwd());
    if (!resolved) {
        return { success: false, error: `Artifact '${name}' is not whitelisted.` };
    }

    const artifactPayload = payload?.payload;
    if (artifactPayload === undefined) {
        return { success: false, error: 'Missing artifact payload.' };
    }

    try {
        const serializedPayload = (
            artifactPayload
            && typeof artifactPayload === 'object'
            && Object.prototype.hasOwnProperty.call(artifactPayload, 'payload')
        )
            ? artifactPayload.payload
            : artifactPayload;

        await fs.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
        await fs.writeFile(resolved.absolutePath, JSON.stringify(serializedPayload, null, 2), 'utf8');
        console.log(`[benchmark] artifact '${name}' -> ${resolved.absolutePath}`);
        return { success: true, filePath: resolved.absolutePath };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[benchmark] failed writing '${name}': ${message}`);
        return { success: false, error: message };
    }
});

ipcMain.handle('benchmark-publish-status', async (_event, payload) => {
    if (!liveBenchmarkRuntime.enabled) {
        return { success: false, error: 'Benchmark mode is disabled.' };
    }

    const sanitized = sanitizeBenchmarkStatus(payload);
    if (!sanitized) {
        return { success: false, error: 'Invalid benchmark status payload.' };
    }

    const now = Date.now();
    if (liveBenchmarkRuntime.startedAt === 0) {
        liveBenchmarkRuntime.startedAt = now;
    }
    liveBenchmarkRuntime.status = sanitized.status;
    if (sanitized.status === 'success' || sanitized.status === 'fail') {
        liveBenchmarkRuntime.completedAt = now;
    }

    const envelope = {
        mode: BENCHMARK_MODE,
        status: sanitized.status,
        at: now,
        details: sanitized.details
    };

    console.log(`[benchmark] status=${sanitized.status}`);
    console.log(`BENCHMARK_STATUS:${JSON.stringify(envelope)}`);

    if (sanitized.status === 'success' || sanitized.status === 'fail') {
        const exitCode = sanitized.status === 'success' ? 0 : 1;
        process.exitCode = exitCode;
        setTimeout(() => {
            const benchmarkWindow = editorWindow || mainWindow;
            if (benchmarkWindow && !benchmarkWindow.isDestroyed()) {
                benchmarkWindow.close();
            }
            app.exit(exitCode);
        }, 150);
    }

    return { success: true };
});

// --- File System Handlers ---

// Save Project
ipcMain.handle('save-project', async (event, data, defaultName) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
        title: 'Guardar Proyecto Hollow Bits',
        defaultPath: defaultName || 'Sin-titulo.esp',
        filters: [{ name: 'Hollow Bits Project', extensions: ['esp'] }]
    });

    if (canceled || !filePath) {
        return { success: false };
    }

    await fs.writeFile(filePath, data, 'utf-8');
    return { success: true, filePath: path.basename(filePath, '.esp') };
});

// Open Project
ipcMain.handle('open-project', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const { filePaths } = await dialog.showOpenDialog(win, {
        title: 'Abrir Proyecto',
        properties: ['openFile'],
        filters: [{ name: 'Hollow Bits Project', extensions: ['esp'] }]
    });

    if (filePaths && filePaths.length > 0) {
        const content = await fs.readFile(filePaths[0], 'utf-8');
        const filename = path.basename(filePaths[0]); // Extract filename
        return { text: content, filename };
    }
    return null;
});

// Select Audio Files
ipcMain.handle('select-files', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const { filePaths } = await dialog.showOpenDialog(win, {
        title: 'Importar Audio',
        properties: ['openFile', 'multiSelections'],
        filters: [
            { name: 'Audio Files', extensions: ['wav', 'mp3', 'aif', 'aiff', 'flac', 'ogg'] }
        ]
    });

    if (filePaths && filePaths.length > 0) {
        const files = [];
        let accumulatedSize = 0;

        for (const filePath of filePaths) {
            const stats = await fs.stat(filePath);
            if (!stats.isFile()) {
                continue;
            }

            if (stats.size > MAX_IMPORT_FILE_BYTES) {
                throw new Error(`El archivo ${path.basename(filePath)} supera el limite de 256 MB.`);
            }

            accumulatedSize += stats.size;
            if (accumulatedSize > MAX_IMPORT_BATCH_BYTES) {
                throw new Error('La importacion supera el limite de 1 GB por lote. Importa menos archivos por tanda.');
            }

            const buffer = await fs.readFile(filePath);
            const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

            files.push({
                name: path.basename(filePath),
                path: filePath,
                data
            });
        }

        return files;
    }
    return [];
});

ipcMain.handle('read-file-from-path', async (_event, rawFilePath) => {
    const filePath = typeof rawFilePath === 'string' ? rawFilePath.trim() : '';
    if (!filePath) return null;

    try {
        const stats = await fs.stat(filePath);
        if (!stats.isFile()) return null;
        if (stats.size > MAX_DIRECT_FILE_READ_BYTES) {
            throw new Error('El archivo excede el tamano permitido para carga directa.');
        }

        const buffer = await fs.readFile(filePath);
        const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

        return {
            name: path.basename(filePath),
            path: filePath,
            data
        };
    } catch (error) {
        console.error('read-file-from-path failed', error);
        return null;
    }
});

ipcMain.handle('select-directory', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: 'Seleccionar carpeta',
        properties: ['openDirectory']
    });

    if (canceled || !filePaths || filePaths.length === 0) {
        return null;
    }

    return filePaths[0];
});

ipcMain.handle('scan-directory-files', async (_event, payload) => {
    const directory = typeof payload?.directory === 'string' ? payload.directory : '';
    if (!directory) return [];

    try {
        const stats = await fs.stat(directory);
        if (!stats.isDirectory()) return [];
    } catch {
        return [];
    }

    const extensions = sanitizeExtensions(payload?.extensions);
    const files = await scanDirectoryRecursive(directory, extensions);
    return files;
});

ipcMain.handle('transcode-audio', async (_event, payload) => {
    const format = String(payload?.outputFormat || '').toLowerCase();
    if (!AUDIO_FORMATS.has(format)) {
        return { success: false, error: 'Formato de salida invalido.' };
    }

    if (!ffmpegBinaryPath) {
        return { success: false, error: 'FFmpeg no esta disponible en esta build.' };
    }

    const inputBuffer = toNodeBuffer(payload?.inputData);
    if (!inputBuffer || inputBuffer.length === 0) {
        return { success: false, error: 'No se recibieron datos de audio validos.' };
    }

    const requestedBitDepth = clamp(Number(payload?.bitDepth || 16), 16, 32);
    const bitDepth = requestedBitDepth <= 16 ? 16 : requestedBitDepth <= 24 ? 24 : 32;
    const requestedSampleRate = clamp(Number(payload?.sampleRate || 44100), 8000, 192000);
    const sampleRate = format === 'mp3' ? Math.min(48000, requestedSampleRate) : requestedSampleRate;

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hollowbits-export-'));
    const inputPath = path.join(tempDir, 'input.wav');
    const outputPath = path.join(tempDir, `output.${format}`);

    try {
        await fs.writeFile(inputPath, inputBuffer);

        const codecArgs = getCodecArgs(format, bitDepth);
        const ffmpegArgs = [
            '-hide_banner',
            '-loglevel', 'error',
            '-y',
            '-i', inputPath,
            '-ar', String(sampleRate),
            '-ac', '2',
            ...codecArgs,
            outputPath
        ];

        await runFfmpeg(ffmpegArgs);
        const outputBuffer = await fs.readFile(outputPath);
        const data = outputBuffer.buffer.slice(outputBuffer.byteOffset, outputBuffer.byteOffset + outputBuffer.byteLength);

        return {
            success: true,
            data,
            extension: format,
            mimeType: AUDIO_MIME_BY_FORMAT[format]
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Fallo el proceso de transcodificacion.';
        return { success: false, error: message };
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});


// Handle creating/removing shortcuts on Windows when installing/uninstalling.
try {
    if (require('electron-squirrel-startup')) {
        app.quit();
    }
} catch (e) {
    // Config not critical for dev
}

const isDevRuntime = () => process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

const getWindowIcon = () => (app.isPackaged ? undefined : path.join(__dirname, '../build/icon.png'));

const toRendererQuery = (surface, params = {}) => {
    const query = { surface };
    for (const [key, value] of Object.entries(params)) {
        if (typeof value === 'string' && value.trim()) {
            query[key] = value.trim();
        }
    }
    return query;
};

const loadRendererSurface = (win, surface, params = {}) => {
    const query = toRendererQuery(surface, params);

    if (isDevRuntime()) {
        const search = new URLSearchParams(query);
        win.loadURL(`http://localhost:3000?${search.toString()}`);
        return;
    }

    win.loadFile(path.join(__dirname, '../dist/index.html'), { query });
};

const attachWindowLifecycle = (win, role) => {
    const notifyState = () => broadcastWindowState(win);
    win.on('maximize', notifyState);
    win.on('unmaximize', notifyState);
    win.on('minimize', notifyState);
    win.on('restore', notifyState);
    win.on('enter-full-screen', notifyState);
    win.on('leave-full-screen', notifyState);
    win.webContents.on('did-finish-load', notifyState);
    win.on('unresponsive', () => {
        logMainError(`${role}-window-unresponsive`, 'Renderer no responde.');
    });
    win.webContents.on('render-process-gone', (_event, details) => {
        logMainError(`${role}-render-process-gone`, `${details.reason} (exitCode=${details.exitCode})`);
    });
    win.webContents.on('did-fail-load', (_event, code, description, validatedURL) => {
        logMainError(`${role}-did-fail-load`, `code=${code} url=${validatedURL} reason=${description}`);
    });
};

const createHubWindow = () => {
    const windowIcon = app.isPackaged ? undefined : path.join(__dirname, '../build/icon.png');

    if (hubWindow && !hubWindow.isDestroyed()) {
        if (!hubWindow.isVisible()) hubWindow.show();
        hubWindow.focus();
        return hubWindow;
    }

    hubWindow = new BrowserWindow({
        title: 'DAW-fi',
        width: 1320,
        height: 860,
        minWidth: 1040,
        minHeight: 720,
        icon: windowIcon,
        frame: false,
        transparent: false,
        backgroundColor: '#0f1118',
        show: false,
        thickFrame: true,
        roundedCorners: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        autoHideMenuBar: true,
    });
    mainWindow = hubWindow;

    attachWindowLifecycle(hubWindow, 'hub');
    hubWindow.on('closed', () => {
        hubWindow = null;
        if (!editorWindow) {
            mainWindow = null;
        }
    });

    loadRendererSurface(hubWindow, 'hub');

    hubWindow.once('ready-to-show', () => {
        if (!hubWindow || hubWindow.isDestroyed()) return;
        hubWindow.show();
        broadcastWindowState(hubWindow);
    });

    return hubWindow;
};

const normalizeEditorRequest = (request) => {
    if (!request || typeof request !== 'object') return {};
    return {
        project: typeof request.projectId === 'string' ? request.projectId : undefined,
        token: typeof request.shareToken === 'string' ? request.shareToken : undefined,
        localPath: typeof request.localPath === 'string' ? request.localPath : undefined,
    };
};

const showHubWindow = () => {
    const hub = createHubWindow();
    if (hub && !hub.isDestroyed()) {
        if (!hub.isVisible()) hub.show();
        hub.focus();
        hub.webContents.send('desktop-hub-refresh');
    }
};

const createEditorWindow = (request = {}) => {
    if (editorWindow && !editorWindow.isDestroyed()) {
        editorWindow.focus();
        return editorWindow;
    }

    const windowIcon = getWindowIcon();
    editorWindow = new BrowserWindow({
        title: 'DAW-fi',
        width: 1400,
        height: 900,
        minWidth: 1120,
        minHeight: 720,
        icon: windowIcon,
        frame: false,
        transparent: false,
        backgroundColor: '#0f1118',
        show: false,
        thickFrame: true,
        roundedCorners: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        autoHideMenuBar: true,
    });
    mainWindow = editorWindow;

    attachWindowLifecycle(editorWindow, 'editor');
    editorWindow.webContents.on('did-finish-load', () => {
        try {
            editorWindow.webContents.setAudioMuted(false);
        } catch {
            // keep running even if platform does not support call
        }

        if (liveBenchmarkRuntime.enabled && liveBenchmarkConfig) {
            console.log(`[benchmark] mode=${BENCHMARK_MODE} config=${JSON.stringify(liveBenchmarkConfig)}`);
            editorWindow.webContents.send('benchmark-start', {
                tracks: liveBenchmarkConfig.tracks,
                scenes: liveBenchmarkConfig.scenes,
                quantizeBars: liveBenchmarkConfig.quantizeBars,
                durationMinutes: liveBenchmarkConfig.durationMinutes,
                recordingCycles: liveBenchmarkConfig.recordingCycles,
                timeoutMs: liveBenchmarkConfig.timeoutMs,
                seed: liveBenchmarkConfig.seed
            });
        }
    });

    editorWindow.on('closed', () => {
        editorWindow = null;
        mainWindow = hubWindow;
        if (!liveBenchmarkRuntime.enabled && hubWindow && !hubWindow.isDestroyed()) {
            showHubWindow();
        }
    });

    if (hubWindow && !hubWindow.isDestroyed() && !liveBenchmarkRuntime.enabled) {
        hubWindow.hide();
    }

    loadRendererSurface(editorWindow, 'editor', normalizeEditorRequest(request));

    editorWindow.once('ready-to-show', () => {
        if (!editorWindow || editorWindow.isDestroyed()) return;
        try {
            editorWindow.webContents.setAudioMuted(false);
        } catch {
            // keep running even if platform does not support call
        }
        if (!liveBenchmarkRuntime.enabled) {
            editorWindow.show();
        }
        broadcastWindowState(editorWindow);
    });

    return editorWindow;
};

const AUTH_PROTOCOL = 'dawfi';
const LEGACY_AUTH_PROTOCOL = 'hollowbits';
const DESKTOP_AUTH_REDIRECT_URI = `${AUTH_PROTOCOL}://auth/callback`;
const DESKTOP_AUTH_SUPABASE_URL = process.env.DAWFI_SUPABASE_URL
    || process.env.VITE_SUPABASE_URL
    || 'https://xnmkoybfuyivmiuckpxs.supabase.co';
const DESKTOP_AUTH_CLIENT_ID = process.env.DAWFI_DESKTOP_OAUTH_CLIENT_ID || '';
const AUTH_PENDING_FILE = 'desktop-auth-pending.bin';
const AUTH_SESSION_FILE = 'desktop-auth-session.bin';
const AUTH_REQUEST_TIMEOUT_MS = 15_000;
const consumedAuthStates = new Map();

const isSecureStorageAvailable = () => {
    if (!safeStorage.isEncryptionAvailable()) return false;
    if (typeof safeStorage.getSelectedStorageBackend === 'function') {
        return safeStorage.getSelectedStorageBackend() !== 'basic_text';
    }
    return true;
};

const getAuthRecordPath = (filename) => path.join(app.getPath('userData'), filename);

const writeEncryptedAuthRecord = async (filename, payload) => {
    if (!isSecureStorageAvailable()) return false;
    const encrypted = safeStorage.encryptString(JSON.stringify(payload));
    const filePath = getAuthRecordPath(filename);
    await fs.writeFile(filePath, encrypted, { mode: 0o600 });
    await fs.chmod(filePath, 0o600).catch(() => undefined);
    return true;
};

const readEncryptedAuthRecord = async (filename) => {
    if (!isSecureStorageAvailable()) return null;
    try {
        const encrypted = await fs.readFile(getAuthRecordPath(filename));
        return JSON.parse(safeStorage.decryptString(encrypted));
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            await fs.unlink(getAuthRecordPath(filename)).catch(() => undefined);
        }
        return null;
    }
};

const removeAuthRecord = async (filename) => {
    await fs.unlink(getAuthRecordPath(filename)).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
    });
};

const persistPendingAuthRequest = async (request) => {
    pendingDesktopAuthRequest = request;
    await writeEncryptedAuthRecord(AUTH_PENDING_FILE, { version: 1, request });
};

const readPendingAuthRequest = async () => {
    if (pendingDesktopAuthRequest) return pendingDesktopAuthRequest;
    const record = await readEncryptedAuthRecord(AUTH_PENDING_FILE);
    const request = record?.version === 1 ? record.request : null;
    if (!request) return null;
    try {
        validatePendingRequest(request);
        pendingDesktopAuthRequest = request;
        return request;
    } catch {
        await removeAuthRecord(AUTH_PENDING_FILE);
        return null;
    }
};

const clearPendingAuthRequest = async () => {
    pendingDesktopAuthRequest = null;
    await removeAuthRecord(AUTH_PENDING_FILE);
};

const normalizeDesktopSession = (session) => parseTokenResponse({
    access_token: session?.access_token,
    refresh_token: session?.refresh_token,
    expires_in: session?.expires_in || 3600,
    token_type: session?.token_type || 'bearer'
});

const persistDesktopAuthSession = async (session) => {
    const normalized = normalizeDesktopSession(session);
    volatileDesktopAuthSession = normalized;
    const encrypted = await writeEncryptedAuthRecord(AUTH_SESSION_FILE, {
        version: 1,
        session: normalized
    });
    return { session: normalized, persistence: encrypted ? 'encrypted' : 'memory' };
};

const readDesktopAuthSession = async () => {
    if (volatileDesktopAuthSession) return volatileDesktopAuthSession;
    const record = await readEncryptedAuthRecord(AUTH_SESSION_FILE);
    if (record?.version !== 1 || !record.session) return null;
    try {
        volatileDesktopAuthSession = normalizeDesktopSession(record.session);
        return volatileDesktopAuthSession;
    } catch {
        await removeAuthRecord(AUTH_SESSION_FILE);
        return null;
    }
};

const clearDesktopAuthSession = async () => {
    volatileDesktopAuthSession = null;
    await removeAuthRecord(AUTH_SESSION_FILE);
};

const findAuthCallbackUrl = (argv) => {
    if (!Array.isArray(argv)) return null;
    return argv.find((entry) => (
        typeof entry === 'string'
        && (entry.startsWith(`${AUTH_PROTOCOL}://`) || entry.startsWith(`${LEGACY_AUTH_PROTOCOL}://`))
    )) || null;
};

const digestAuthState = (state) => crypto.createHash('sha256').update(state, 'utf8').digest('hex');

const pruneConsumedAuthStates = () => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [digest, consumedAt] of consumedAuthStates.entries()) {
        if (consumedAt < cutoff) consumedAuthStates.delete(digest);
    }
};

const readCallbackState = (rawUrl) => {
    try {
        const parsed = new URL(rawUrl);
        return parsed.searchParams.get('state') || '';
    } catch {
        return '';
    }
};

const sendDesktopAuthResult = (payload) => {
    pendingAuthCallbackResult = payload;
    const target = hubWindow && !hubWindow.isDestroyed() ? hubWindow : createHubWindow();
    if (!target || target.isDestroyed()) return;
    if (!target.isVisible()) target.show();
    target.focus();
    target.webContents.send('desktop-auth-callback', payload);
};

const processAuthCallback = async (rawUrl) => {
    pruneConsumedAuthStates();
    const pending = await readPendingAuthRequest();
    if (!pending) {
        const callbackState = readCallbackState(rawUrl);
        const replayed = callbackState && consumedAuthStates.has(digestAuthState(callbackState));
        sendDesktopAuthResult({
            success: false,
            errorCode: replayed ? 'AUTH_DESKTOP_HANDOFF_REPLAYED' : 'AUTH_CALLBACK_INVALID',
            error: replayed
                ? 'Este código de acceso ya fue utilizado.'
                : 'No existe una solicitud de acceso pendiente.'
        });
        return;
    }

    try {
        validatePendingRequest(pending);
        const parsed = parseAuthorizationCallback(rawUrl, {
            expectedState: pending.state,
            redirectUri: pending.redirectUri
        });

        if (parsed.kind === 'error') {
            consumedAuthStates.set(digestAuthState(pending.state), Date.now());
            await clearPendingAuthRequest();
            sendDesktopAuthResult({
                success: false,
                requestId: pending.requestId,
                errorCode: parsed.code,
                error: parsed.message
            });
            return;
        }

        consumedAuthStates.set(digestAuthState(pending.state), Date.now());
        await clearPendingAuthRequest();

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), AUTH_REQUEST_TIMEOUT_MS);
        let session;
        try {
            session = await exchangeAuthorizationCode({
                pending,
                code: parsed.code,
                signal: controller.signal
            });
        } finally {
            clearTimeout(timeout);
        }

        const persisted = await persistDesktopAuthSession(session);
        sendDesktopAuthResult({
            success: true,
            requestId: pending.requestId,
            session: persisted.session,
            persistence: persisted.persistence
        });
    } catch (error) {
        const publicError = toPublicAuthError(error);
        if (publicError.code === 'AUTH_DESKTOP_HANDOFF_EXPIRED') {
            await clearPendingAuthRequest();
        }
        sendDesktopAuthResult({
            success: false,
            requestId: pending.requestId,
            errorCode: publicError.code,
            error: publicError.message
        });
    }
};

const deliverAuthCallback = (url) => {
    if (!url) return;
    if (!app.isReady()) {
        pendingAuthCallbackUrl = url;
        return;
    }
    void processAuthCallback(url);
};

ipcMain.handle('desktop-open-editor', async (_event, request) => {
    try {
        createEditorWindow(request);
        return { success: true };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logMainError('desktop-open-editor', message);
        return { success: false, error: message };
    }
});

ipcMain.handle('desktop-show-hub', async () => {
    try {
        if (editorWindow && !editorWindow.isDestroyed()) {
            editorWindow.close();
        } else {
            showHubWindow();
        }
        return { success: true };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logMainError('desktop-show-hub', message);
        return { success: false, error: message };
    }
});

ipcMain.handle('desktop-open-auth', async (_event, request) => {
    try {
        const authRequest = createAuthorizationRequest({
            supabaseUrl: DESKTOP_AUTH_SUPABASE_URL,
            clientId: DESKTOP_AUTH_CLIENT_ID,
            redirectUri: DESKTOP_AUTH_REDIRECT_URI
        });
        const pending = {
            ...authRequest,
            url: undefined,
            requestId: crypto.randomUUID(),
            mode: request?.mode === 'signup' ? 'signup' : 'login'
        };
        await persistPendingAuthRequest(pending);
        await shell.openExternal(authRequest.url);
        return {
            success: true,
            requestId: pending.requestId,
            persistence: isSecureStorageAvailable() ? 'encrypted' : 'memory'
        };
    } catch (error) {
        await clearPendingAuthRequest().catch(() => undefined);
        const publicError = toPublicAuthError(error);
        return {
            success: false,
            errorCode: publicError.code,
            error: publicError.message
        };
    }
});

ipcMain.handle('desktop-cancel-auth', async () => {
    await clearPendingAuthRequest();
    return { success: true };
});

ipcMain.handle('desktop-open-external-url', async (_event, rawUrl) => {
    const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    if (!/^https?:\/\//i.test(url)) {
        return { success: false, error: 'Unsupported external URL.' };
    }

    try {
        await shell.openExternal(url);
        return { success: true };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: message };
    }
});

ipcMain.handle('desktop-get-pending-auth-callback', async () => {
    const result = pendingAuthCallbackResult;
    pendingAuthCallbackResult = null;
    return result;
});

ipcMain.handle('desktop-get-auth-session', async () => readDesktopAuthSession());

ipcMain.handle('desktop-persist-auth-session', async (_event, session) => {
    try {
        const persisted = await persistDesktopAuthSession(session);
        return { success: true, persistence: persisted.persistence };
    } catch {
        return {
            success: false,
            errorCode: 'AUTH_CALLBACK_INVALID',
            error: 'La sesión recibida no es válida.'
        };
    }
});

ipcMain.handle('desktop-clear-auth-session', async () => {
    await clearDesktopAuthSession();
    return { success: true };
});

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    app.quit();
} else {
    app.on('second-instance', (_event, argv) => {
        const callbackUrl = findAuthCallbackUrl(argv);
        if (callbackUrl) {
            deliverAuthCallback(callbackUrl);
        } else {
            showHubWindow();
        }
    });
}

app.on('open-url', (event, url) => {
    event.preventDefault();
    deliverAuthCallback(url);
});

app.whenReady().then(() => {
    if (process.defaultApp) {
        app.setAsDefaultProtocolClient(AUTH_PROTOCOL, process.execPath, [path.resolve(process.argv[1] || '')]);
        app.setAsDefaultProtocolClient(LEGACY_AUTH_PROTOCOL, process.execPath, [path.resolve(process.argv[1] || '')]);
    } else {
        app.setAsDefaultProtocolClient(AUTH_PROTOCOL);
        app.setAsDefaultProtocolClient(LEGACY_AUTH_PROTOCOL);
    }

    const initialAuthCallback = findAuthCallbackUrl(process.argv);
    if (initialAuthCallback) {
        pendingAuthCallbackUrl = initialAuthCallback;
    }

    if (liveBenchmarkRuntime.enabled) {
        createEditorWindow();
    } else {
        createHubWindow();
    }

    if (pendingAuthCallbackUrl) {
        const callbackUrl = pendingAuthCallbackUrl;
        pendingAuthCallbackUrl = null;
        void processAuthCallback(callbackUrl);
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createHubWindow();
        }
    });
});

app.on('child-process-gone', (_event, details) => {
    logMainError('child-process-gone', `${details.type} (${details.reason}, exitCode=${details.exitCode})`);
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
