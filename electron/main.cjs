const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const crypto = require('node:crypto');
const {
    BENCHMARK_MODE,
    parseLiveCaptureConfig,
    resolveBenchmarkArtifactPath,
    sanitizeBenchmarkStatus
} = require('./benchmarkBridge.cjs');
const {
    DAWFI_AUTH_CONTRACT,
    DesktopAuthError,
    createAuthorizationRequest,
    exchangeAuthorizationCode,
    parseAuthorizationCallback,
    parseTokenResponse,
    toPublicAuthError,
    validatePublishableKey,
    validatePendingRequest
} = require('./desktop-auth.cjs');
const { createAuthCallbackCoordinator } = require('./desktop-auth-callback-coordinator.cjs');
const {
    SUPPORTED_AUDIO_IMPORT_EXTENSIONS,
    resolveFfmpegBinary,
    runFfmpeg: runFfmpegProcess
} = require('./ffmpeg-runtime.cjs');
const {
    MAX_AUDIO_IMPORT_FILE_BYTES,
    assertAudioImportSelectionCount
} = require('./audio-import-policy.cjs');
const { createRendererVisibilityGuard } = require('./renderer-visibility-guard.cjs');
const {
    NativeBridgeSecurityError,
    attachTrustedNavigation,
    isTrustedRendererUrl,
    requireTrustedIpcSender
} = require('./native-bridge-security.cjs');
const {
    NativeFileGrantError,
    NativeFileGrantManager
} = require('./native-file-grants.cjs');
const {
    MAX_PROJECT_BUNDLE_BYTES,
    ProjectBundleIoError,
    ProjectBundleIoManager,
    assertSha256,
    sanitizeProjectBundleFileName
} = require('./project-bundle-io.cjs');
const {
    getDesktopProductTitle,
    normalizeDesktopEditorRequest
} = require('./desktop-product-surface.cjs');

const AUDIO_FORMATS = new Set(['wav', 'aiff', 'flac', 'mp3']);
const AUDIO_MIME_BY_FORMAT = {
    wav: 'audio/wav',
    aiff: 'audio/aiff',
    flac: 'audio/flac',
    mp3: 'audio/mpeg'
};

let ffmpegStaticPath = null;
try {
    ffmpegStaticPath = require('ffmpeg-static');
} catch (error) {
    console.warn('FFmpeg static binary is not available.', error);
}

const ffmpegBinaryPath = resolveFfmpegBinary({ staticPath: ffmpegStaticPath });
if (!ffmpegBinaryPath) {
    console.warn('No usable FFmpeg binary was found. Advanced import fallback is disabled.');
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

const runFfmpeg = (args) => runFfmpegProcess(ffmpegBinaryPath, args);

const DIRECTORY_SCAN_LIMIT = 10000;
const MAX_DIRECT_FILE_READ_BYTES = MAX_AUDIO_IMPORT_FILE_BYTES;
const MAX_IMPORT_FILE_BYTES = MAX_AUDIO_IMPORT_FILE_BYTES;
const projectBundleIo = new ProjectBundleIoManager();
const nativeFileGrants = new NativeFileGrantManager({
    audioExtensions: SUPPORTED_AUDIO_IMPORT_EXTENSIONS,
    scanExtensions: [...SUPPORTED_AUDIO_IMPORT_EXTENSIONS, 'vst3', 'dll'],
    maxAudioBytes: MAX_DIRECT_FILE_READ_BYTES,
    scanLimit: DIRECTORY_SCAN_LIMIT
});
const rendererRoles = new Map();
const rendererEntryPath = path.resolve(__dirname, '../dist/index.html');

let mainWindow = null;
let hubWindow = null;
let editorWindow = null;
let editorProduct = null;
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

const isTrustedRuntimeUrl = (url) => isTrustedRendererUrl(url, {
    isDev: isDevRuntime(),
    devOrigin: 'http://localhost:3000',
    rendererFilePath: rendererEntryPath
});

const requireNativeSender = (event, allowedRoles) => {
    return requireTrustedIpcSender(event, {
        roles: rendererRoles,
        allowedRoles,
        isTrustedUrl: isTrustedRuntimeUrl
    });
};

const runProjectBundleOperation = async (label, operation) => {
    try {
        return await operation();
    } catch (error) {
        logMainError(label, error);
        if (error instanceof ProjectBundleIoError || error instanceof NativeBridgeSecurityError) {
            throw new Error(error.message);
        }
        throw new Error('No se pudo completar la operación segura del proyecto .esp.');
    }
};

process.on('uncaughtException', (error) => {
    logMainError('uncaughtException', error);
});

process.on('unhandledRejection', (reason) => {
    logMainError('unhandledRejection', reason);
});

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
    requireNativeSender(event, ['editor']);
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
    requireNativeSender(event, ['editor']);
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

ipcMain.handle('project-bundle-write-start', async (event, payload) => (
    runProjectBundleOperation('project-bundle-write-start', async () => {
        requireNativeSender(event, ['editor']);
        const totalBytes = payload?.totalBytes;
        if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0 || totalBytes > MAX_PROJECT_BUNDLE_BYTES) {
            throw new ProjectBundleIoError('INVALID_PAYLOAD', 'El tamaño declarado del proyecto no es válido.');
        }
        const sha256 = assertSha256(payload?.sha256);
        const defaultName = sanitizeProjectBundleFileName(payload?.defaultName);
        const win = BrowserWindow.fromWebContents(event.sender);
        const { canceled, filePath } = await dialog.showSaveDialog(win, {
            title: 'Guardar Proyecto DAW-fi',
            defaultPath: defaultName,
            filters: [{ name: 'DAW-fi Portable Project', extensions: ['esp'] }]
        });
        if (canceled || !filePath) return { canceled: true };

        const targetPath = path.extname(filePath).toLowerCase() === '.esp'
            ? filePath
            : `${filePath}.esp`;
        const session = await projectBundleIo.beginWrite({
            senderId: event.sender.id,
            targetPath,
            totalBytes,
            sha256
        });
        return { canceled: false, ...session };
    })
));

ipcMain.handle('project-bundle-write-chunk', async (event, payload) => (
    runProjectBundleOperation('project-bundle-write-chunk', async () => {
        requireNativeSender(event, ['editor']);
        return await projectBundleIo.appendWriteChunk({
            senderId: event.sender.id,
            sessionId: payload?.sessionId,
            offset: payload?.offset,
            data: payload?.data,
            sha256: payload?.sha256
        });
    })
));

ipcMain.handle('project-bundle-write-complete', async (event, payload) => (
    runProjectBundleOperation('project-bundle-write-complete', async () => {
        requireNativeSender(event, ['editor']);
        return await projectBundleIo.completeWrite({
            senderId: event.sender.id,
            sessionId: payload?.sessionId
        });
    })
));

ipcMain.handle('project-bundle-write-cancel', async (event, payload) => (
    runProjectBundleOperation('project-bundle-write-cancel', async () => {
        requireNativeSender(event, ['editor']);
        return { success: await projectBundleIo.cancelWrite({
            senderId: event.sender.id,
            sessionId: payload?.sessionId
        }) };
    })
));

ipcMain.handle('project-bundle-read-start', async (event) => (
    runProjectBundleOperation('project-bundle-read-start', async () => {
        requireNativeSender(event, ['editor']);
        const win = BrowserWindow.fromWebContents(event.sender);
        const result = await dialog.showOpenDialog(win, {
            title: 'Abrir Proyecto DAW-fi',
            properties: ['openFile'],
            filters: [{ name: 'DAW-fi Portable Project', extensions: ['esp'] }]
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        return await projectBundleIo.beginRead({
            senderId: event.sender.id,
            filePath: result.filePaths[0]
        });
    })
));

ipcMain.handle('project-bundle-read-chunk', async (event, payload) => (
    runProjectBundleOperation('project-bundle-read-chunk', async () => {
        requireNativeSender(event, ['editor']);
        return await projectBundleIo.readChunk({
            senderId: event.sender.id,
            sessionId: payload?.sessionId,
            offset: payload?.offset,
            length: payload?.length
        });
    })
));

ipcMain.handle('project-bundle-read-close', async (event, payload) => (
    runProjectBundleOperation('project-bundle-read-close', async () => {
        requireNativeSender(event, ['editor']);
        return { success: await projectBundleIo.closeRead({
            senderId: event.sender.id,
            sessionId: payload?.sessionId
        }) };
    })
));

// Select Audio Files
ipcMain.handle('select-files', async (event) => {
    requireNativeSender(event, ['editor']);
    const win = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: 'Importar Audio',
        properties: ['openFile', 'multiSelections'],
        filters: [
            { name: 'Audio Files', extensions: [...SUPPORTED_AUDIO_IMPORT_EXTENSIONS] }
        ]
    });

    if (!canceled && filePaths && filePaths.length > 0) {
        assertAudioImportSelectionCount(filePaths.length);

        const files = [];

        for (const filePath of filePaths) {
            files.push(await nativeFileGrants.grantSelectedAudioFile(event.sender.id, filePath));
        }

        return files;
    }
    return [];
});

ipcMain.handle('read-file-from-path', async (event, rawFilePath) => {
    requireNativeSender(event, ['editor']);
    try {
        return await nativeFileGrants.readGrantedAudioFile(event.sender.id, rawFilePath);
    } catch (error) {
        const code = error instanceof NativeFileGrantError ? error.code : 'READ_FAILED';
        console.error(`read-file-from-path failed (${code})`);
        return null;
    }
});

ipcMain.handle('select-directory', async (event) => {
    requireNativeSender(event, ['editor']);
    const win = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: 'Seleccionar carpeta',
        properties: ['openDirectory']
    });

    if (canceled || !filePaths || filePaths.length === 0) {
        return null;
    }

    return await nativeFileGrants.grantDirectory(event.sender.id, filePaths[0]);
});

ipcMain.handle('scan-directory-files', async (event, payload) => {
    requireNativeSender(event, ['editor']);
    const directory = typeof payload?.directory === 'string' ? payload.directory : '';
    if (!directory) return [];

    try {
        return await nativeFileGrants.scanGrantedDirectory(
            event.sender.id,
            directory,
            payload?.extensions
        );
    } catch (error) {
        const code = error instanceof NativeFileGrantError ? error.code : 'SCAN_FAILED';
        console.error(`scan-directory-files failed (${code})`);
        return [];
    }
});

ipcMain.handle('transcode-audio', async (event, payload) => {
    requireNativeSender(event, ['editor']);
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
    if (inputBuffer.length > MAX_IMPORT_FILE_BYTES) {
        return { success: false, error: 'El audio supera el limite de 512 MB para transcodificacion.' };
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
            '-nostdin',
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
    const senderId = win.webContents.id;
    rendererRoles.set(senderId, role);
    attachTrustedNavigation(win, isTrustedRuntimeUrl);
    win.webContents.once('destroyed', () => {
        rendererRoles.delete(senderId);
        nativeFileGrants.clearSender(senderId);
        void projectBundleIo.closeForSender(senderId);
    });
    const notifyState = () => broadcastWindowState(win);
    const rendererVisibilityGuard = createRendererVisibilityGuard({
        win,
        role,
        logger: ({ role: safeRole, cause, stage, action }) => {
            console.error(
                `[main:${safeRole}-renderer-visibility] cause=${cause} stage=${stage} action=${action}`
            );
        },
        showNativeFallback: async ({ retry, close }) => {
            if (!win || win.isDestroyed()) return;
            const result = await dialog.showMessageBox(win, {
                type: 'error',
                title: 'DAW-fi',
                message: 'La interfaz de DAW-fi no pudo mostrarse.',
                detail: 'La recuperación automática terminó sin contenido visible. Puedes reintentar la carga o cerrar esta ventana.',
                buttons: ['Reintentar carga', 'Cerrar DAW-fi'],
                defaultId: 0,
                cancelId: 1,
                noLink: true
            });
            if (!win || win.isDestroyed()) return;
            if (result.response === 0) {
                retry();
            } else {
                close();
            }
        }
    });
    win.on('maximize', notifyState);
    win.on('unmaximize', notifyState);
    win.on('minimize', notifyState);
    win.on('restore', notifyState);
    win.on('enter-full-screen', notifyState);
    win.on('leave-full-screen', notifyState);
    win.webContents.on('did-finish-load', notifyState);
    win.on('unresponsive', () => {
        logMainError(`${role}-window-unresponsive`, 'Renderer no responde.');
        void rendererVisibilityGuard.handleUnresponsive();
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
    const normalized = normalizeDesktopEditorRequest(request);
    return {
        product: normalized.product,
        project: normalized.projectId,
        token: normalized.shareToken,
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
    const rendererRequest = normalizeEditorRequest(request);
    const requestedProduct = rendererRequest.product;
    if (editorWindow && !editorWindow.isDestroyed()) {
        if (editorProduct !== requestedProduct) {
            editorProduct = requestedProduct;
            editorWindow.setTitle(getDesktopProductTitle(requestedProduct));
            loadRendererSurface(editorWindow, 'editor', rendererRequest);
        }
        editorWindow.focus();
        return editorWindow;
    }

    const windowIcon = getWindowIcon();
    editorWindow = new BrowserWindow({
        title: getDesktopProductTitle(requestedProduct),
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
    editorProduct = requestedProduct;
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
        editorProduct = null;
        mainWindow = hubWindow;
        if (!liveBenchmarkRuntime.enabled && hubWindow && !hubWindow.isDestroyed()) {
            showHubWindow();
        }
    });

    if (hubWindow && !hubWindow.isDestroyed() && !liveBenchmarkRuntime.enabled) {
        hubWindow.hide();
    }

    loadRendererSurface(editorWindow, 'editor', rendererRequest);

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

const AUTH_PROTOCOL = new URL(DAWFI_AUTH_CONTRACT.desktopRedirectUri).protocol.slice(0, -1);
const LEGACY_AUTH_PROTOCOL = new URL(DAWFI_AUTH_CONTRACT.legacyDesktopRedirectUri).protocol.slice(0, -1);
const DESKTOP_AUTH_REDIRECT_URI = DAWFI_AUTH_CONTRACT.desktopRedirectUri;
const DESKTOP_AUTH_SUPABASE_URL = process.env.DAWFI_SUPABASE_URL
    || process.env.VITE_SUPABASE_URL
    || DAWFI_AUTH_CONTRACT.supabaseUrl;
const DESKTOP_AUTH_PUBLISHABLE_KEY = process.env.DAWFI_SUPABASE_PUBLISHABLE_KEY || '';
const AUTH_PENDING_FILE = 'desktop-auth-pending.bin';
const AUTH_SESSION_FILE = 'desktop-auth-session.bin';
const AUTH_REQUEST_TIMEOUT_MS = 15_000;
const consumedAuthStates = new Map();
const authCallbackCoordinator = createAuthCallbackCoordinator();

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

const processAuthCallbackOnce = async (rawUrl) => {
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
                publishableKey: DESKTOP_AUTH_PUBLISHABLE_KEY,
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

const processAuthCallback = (rawUrl) => {
    const callbackState = readCallbackState(rawUrl);
    const stateDigest = callbackState ? digestAuthState(callbackState) : '';
    return authCallbackCoordinator.run(
        stateDigest,
        () => processAuthCallbackOnce(rawUrl)
    );
};

const deliverAuthCallback = (url) => {
    if (!url) return;
    if (!app.isReady()) {
        pendingAuthCallbackUrl = url;
        return;
    }
    void processAuthCallback(url);
};

ipcMain.handle('desktop-open-editor', async (event, request) => {
    requireNativeSender(event, ['hub']);
    try {
        createEditorWindow(request);
        return { success: true };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logMainError('desktop-open-editor', message);
        return { success: false, error: message };
    }
});

ipcMain.handle('desktop-show-hub', async (event) => {
    requireNativeSender(event, ['editor']);
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
        validatePublishableKey(DESKTOP_AUTH_PUBLISHABLE_KEY);
        const authRequest = createAuthorizationRequest({
            supabaseUrl: DESKTOP_AUTH_SUPABASE_URL,
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

app.on('will-quit', () => {
    void projectBundleIo.closeAll();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
