'use strict';

const DEFAULT_INITIAL_CHECK_DELAY_MS = 1200;
const DEFAULT_EMPTY_CONFIRMATION_DELAY_MS = 350;
const DEFAULT_MONITOR_INTERVAL_MS = 1500;
const DEFAULT_EXECUTION_TIMEOUT_MS = 2500;

const SAFE_CAUSES = new Set([
    'root-missing',
    'root-empty',
    'root-inspection-failed',
    'root-inspection-timeout',
    'fallback-injection-failed',
    'fallback-injection-timeout',
    'renderer-unresponsive',
    'native-fallback-failed'
]);

const SAFE_STAGES = new Set([
    'did-finish-load',
    'empty-confirmation',
    'runtime-monitor',
    'fallback'
]);

const SAFE_ACTIONS = new Set([
    'confirm-empty',
    'reload-once',
    'show-fallback',
    'show-native-fallback'
]);

const ROOT_HEALTH_CHECK_SCRIPT = `(() => {
    const root = document.getElementById('root');
    if (!root) {
        return { healthy: false, reason: 'root-missing' };
    }

    const hasRenderableChild = Array.from(root.childNodes).some((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) return true;
        return node.nodeType === Node.TEXT_NODE && Boolean(node.textContent && node.textContent.trim());
    });

    return hasRenderableChild
        ? { healthy: true, reason: 'ready' }
        : { healthy: false, reason: 'root-empty' };
})()`;

const normalizeCause = (cause) => SAFE_CAUSES.has(cause) ? cause : 'root-inspection-failed';
const normalizeStage = (stage) => SAFE_STAGES.has(stage) ? stage : 'runtime-monitor';
const normalizeAction = (action) => SAFE_ACTIONS.has(action) ? action : 'show-fallback';
const normalizeRole = (role) => {
    if (typeof role !== 'string') return 'window';
    const normalized = role.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    return normalized || 'window';
};

const createInternalError = (code) => {
    const error = new Error(code);
    error.code = code;
    return error;
};

const isExecutionTimeout = (error) => error?.code === 'renderer-script-timeout';

const createFallbackInjectionScript = (cause) => {
    const safeCause = normalizeCause(cause);
    return `(() => {
        const existing = document.getElementById('dawfi-renderer-recovery');
        if (existing) return true;

        const style = document.createElement('style');
        style.id = 'dawfi-renderer-recovery-style';
        style.textContent = [
            '#dawfi-renderer-recovery{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:24px;background:#17181b;color:#f0f0f1;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
            '#dawfi-renderer-recovery *{box-sizing:border-box}',
            '#dawfi-renderer-recovery .panel{width:min(520px,100%);border:1px solid #3a3c40;background:#222428;padding:28px;box-shadow:0 16px 48px rgba(0,0,0,.35)}',
            '#dawfi-renderer-recovery .eyebrow{margin:0 0 18px;color:#aeb1b7;font:600 11px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.16em;text-transform:uppercase}',
            '#dawfi-renderer-recovery h1{margin:0 0 10px;font-size:22px;line-height:1.25;font-weight:650;letter-spacing:-.02em}',
            '#dawfi-renderer-recovery p{margin:0;color:#b8bbc1;font-size:14px;line-height:1.6}',
            '#dawfi-renderer-recovery .code{margin-top:18px;padding:10px 12px;border:1px solid #393b40;background:#1b1c1f;color:#9da1a8;font:12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}',
            '#dawfi-renderer-recovery button{width:100%;min-height:44px;margin-top:20px;border:1px solid #d5d7da;background:#e5e6e8;color:#151619;font:650 12px/1 ui-sans-serif,system-ui;letter-spacing:.1em;text-transform:uppercase;cursor:pointer}',
            '#dawfi-renderer-recovery button:hover{background:#fff}',
            '#dawfi-renderer-recovery button:focus-visible{outline:2px solid #7bdff2;outline-offset:3px}'
        ].join('');

        const overlay = document.createElement('section');
        overlay.id = 'dawfi-renderer-recovery';
        overlay.setAttribute('role', 'alert');
        overlay.setAttribute('aria-live', 'assertive');

        const panel = document.createElement('div');
        panel.className = 'panel';

        const eyebrow = document.createElement('p');
        eyebrow.className = 'eyebrow';
        eyebrow.textContent = 'DAW-fi / Recuperación de interfaz';

        const heading = document.createElement('h1');
        heading.textContent = 'La interfaz no pudo mostrarse';

        const detail = document.createElement('p');
        detail.textContent = 'DAW-fi intentó recuperar la ventana automáticamente. Puedes volver a cargarla de forma segura.';

        const code = document.createElement('div');
        code.className = 'code';
        code.textContent = 'Diagnóstico: ${safeCause}';

        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = 'Reintentar carga';
        retry.addEventListener('click', () => window.location.reload());

        panel.append(eyebrow, heading, detail, code, retry);
        overlay.append(panel);
        document.head.append(style);
        document.body.append(overlay);
        retry.focus();
        return true;
    })()`;
};

const createRendererVisibilityGuard = ({
    win,
    role = 'window',
    logger = () => undefined,
    showNativeFallback,
    initialCheckDelayMs = DEFAULT_INITIAL_CHECK_DELAY_MS,
    emptyConfirmationDelayMs = DEFAULT_EMPTY_CONFIRMATION_DELAY_MS,
    monitorIntervalMs = DEFAULT_MONITOR_INTERVAL_MS,
    executionTimeoutMs = DEFAULT_EXECUTION_TIMEOUT_MS,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout
}) => {
    if (!win || !win.webContents) {
        throw new TypeError('A BrowserWindow-compatible object is required.');
    }

    const safeRole = normalizeRole(role);
    const webContents = win.webContents;
    let disposed = false;
    let timer = null;
    let generation = 0;
    let autoReloadUsed = false;
    let fallbackDisplayed = false;
    let phase = 'idle';
    const pendingExecutionCancels = new Set();

    const emitDiagnostic = (cause, stage, action) => {
        logger({
            role: safeRole,
            cause: normalizeCause(cause),
            stage: normalizeStage(stage),
            action: normalizeAction(action)
        });
    };

    const isUnavailable = () => (
        disposed
        || (typeof win.isDestroyed === 'function' && win.isDestroyed())
        || (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed())
    );

    const clearTimer = () => {
        if (timer !== null) {
            clearTimeoutFn(timer);
            timer = null;
        }
    };

    const executeRendererScript = (script) => new Promise((resolve, reject) => {
        if (isUnavailable()) {
            reject(createInternalError('renderer-guard-disposed'));
            return;
        }

        let settled = false;
        let executionTimer = null;

        const settle = (callback, value) => {
            if (settled) return;
            settled = true;
            if (executionTimer !== null) {
                clearTimeoutFn(executionTimer);
                executionTimer = null;
            }
            pendingExecutionCancels.delete(cancel);
            callback(value);
        };

        const cancel = () => settle(reject, createInternalError('renderer-guard-disposed'));
        pendingExecutionCancels.add(cancel);
        executionTimer = setTimeoutFn(
            () => settle(reject, createInternalError('renderer-script-timeout')),
            Math.max(1, executionTimeoutMs)
        );

        let execution;
        try {
            execution = webContents.executeJavaScript(script, true);
        } catch (error) {
            settle(reject, error);
            return;
        }

        Promise.resolve(execution).then(
            (value) => settle(resolve, value),
            (error) => settle(reject, error)
        );
    });

    const cancelPendingExecutions = () => {
        for (const cancel of [...pendingExecutionCancels]) {
            cancel();
        }
    };

    const scheduleInspection = (stage, delayMs, expectedGeneration = generation) => {
        clearTimer();
        if (isUnavailable()) return;
        timer = setTimeoutFn(() => {
            timer = null;
            void inspect(stage, expectedGeneration);
        }, Math.max(0, delayMs));
    };

    const showFallback = async (cause, stage, expectedGeneration) => {
        if (isUnavailable() || expectedGeneration !== generation || fallbackDisplayed) return;

        phase = 'fallback';
        fallbackDisplayed = true;
        emitDiagnostic(cause, stage, 'show-fallback');

        try {
            await executeRendererScript(createFallbackInjectionScript(cause));
            return;
        } catch (error) {
            emitDiagnostic(
                isExecutionTimeout(error) ? 'fallback-injection-timeout' : 'fallback-injection-failed',
                'fallback',
                'show-native-fallback'
            );
        }

        if (typeof showNativeFallback !== 'function' || isUnavailable()) return;
        try {
            await showNativeFallback({
                cause: normalizeCause(cause),
                retry: () => {
                    if (isUnavailable()) return;
                    fallbackDisplayed = false;
                    phase = 'manual-retry';
                    webContents.reloadIgnoringCache();
                },
                close: () => {
                    if (!isUnavailable() && typeof win.close === 'function') win.close();
                }
            });
        } catch {
            emitDiagnostic('native-fallback-failed', 'fallback', 'show-native-fallback');
        }
    };

    const recover = async (cause, stage, expectedGeneration) => {
        if (isUnavailable() || expectedGeneration !== generation) return;
        clearTimer();

        if (!autoReloadUsed) {
            autoReloadUsed = true;
            phase = 'reloading';
            emitDiagnostic(cause, stage, 'reload-once');
            webContents.reloadIgnoringCache();
            return;
        }

        await showFallback(cause, stage, expectedGeneration);
    };

    async function inspect(stage, expectedGeneration = generation) {
        if (isUnavailable() || expectedGeneration !== generation) return;

        let health;
        try {
            health = await executeRendererScript(ROOT_HEALTH_CHECK_SCRIPT);
        } catch (error) {
            await recover(
                isExecutionTimeout(error) ? 'root-inspection-timeout' : 'root-inspection-failed',
                stage,
                expectedGeneration
            );
            return;
        }

        if (isUnavailable() || expectedGeneration !== generation) return;

        if (health && health.healthy === true) {
            fallbackDisplayed = false;
            phase = 'healthy';
            scheduleInspection('runtime-monitor', monitorIntervalMs, expectedGeneration);
            return;
        }

        const cause = normalizeCause(health?.reason);
        if (stage !== 'empty-confirmation') {
            phase = 'confirming-empty';
            emitDiagnostic(cause, stage, 'confirm-empty');
            scheduleInspection('empty-confirmation', emptyConfirmationDelayMs, expectedGeneration);
            return;
        }

        await recover(cause, stage, expectedGeneration);
    }

    const onDidStartLoading = () => {
        generation += 1;
        phase = 'loading';
        fallbackDisplayed = false;
        clearTimer();
        cancelPendingExecutions();
    };

    const onDidFinishLoad = () => {
        generation += 1;
        phase = 'waiting-for-root';
        fallbackDisplayed = false;
        clearTimer();
        scheduleInspection('did-finish-load', initialCheckDelayMs, generation);
    };

    const handleUnresponsive = async () => {
        if (isUnavailable()) return;
        await recover('renderer-unresponsive', 'runtime-monitor', generation);
    };

    const dispose = () => {
        if (disposed) return;
        disposed = true;
        phase = 'disposed';
        generation += 1;
        clearTimer();
        cancelPendingExecutions();
        webContents.removeListener?.('did-start-loading', onDidStartLoading);
        webContents.removeListener?.('did-finish-load', onDidFinishLoad);
        webContents.removeListener?.('destroyed', dispose);
        win.removeListener?.('closed', dispose);
    };

    webContents.on('did-start-loading', onDidStartLoading);
    webContents.on('did-finish-load', onDidFinishLoad);
    webContents.once('destroyed', dispose);
    win.once('closed', dispose);

    return {
        dispose,
        handleUnresponsive,
        inspectNow: () => inspect('runtime-monitor', generation),
        getState: () => ({
            disposed,
            phase,
            autoReloadUsed,
            fallbackDisplayed,
            hasPendingTimer: timer !== null,
            pendingExecutionCount: pendingExecutionCancels.size
        })
    };
};

module.exports = {
    DEFAULT_EMPTY_CONFIRMATION_DELAY_MS,
    DEFAULT_EXECUTION_TIMEOUT_MS,
    DEFAULT_INITIAL_CHECK_DELAY_MS,
    DEFAULT_MONITOR_INTERVAL_MS,
    ROOT_HEALTH_CHECK_SCRIPT,
    createFallbackInjectionScript,
    createRendererVisibilityGuard
};
