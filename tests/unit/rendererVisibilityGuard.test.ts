// @vitest-environment node

import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
type JsdomWindow = Window & typeof globalThis & {
    eval: (script: string) => unknown;
    close: () => void;
};
const JSDOM = (require('jsdom') as {
    JSDOM: new (html?: string, options?: { runScripts?: string }) => { window: JsdomWindow };
}).JSDOM;
const visibilityModule = require('../../electron/renderer-visibility-guard.cjs') as {
    ROOT_HEALTH_CHECK_SCRIPT: string;
    createFallbackInjectionScript: (cause: string) => string;
    createRendererVisibilityGuard: (options: Record<string, unknown>) => {
        dispose: () => void;
        handleUnresponsive: () => Promise<void>;
        inspectNow: () => Promise<void>;
        getState: () => {
            disposed: boolean;
            phase: string;
            autoReloadUsed: boolean;
            fallbackDisplayed: boolean;
            hasPendingTimer: boolean;
            pendingExecutionCount: number;
        };
    };
};

type RootHealth = { healthy: boolean; reason: 'ready' | 'root-empty' | 'root-missing' };
type FakeExecutionResult = RootHealth | Error | 'never';

class FakeWebContents extends EventEmitter {
    readonly reloadIgnoringCache = vi.fn();
    readonly isDestroyed = vi.fn(() => false);
    readonly executedScripts: string[] = [];
    readonly healthResults: FakeExecutionResult[];
    fallbackInjectionMode: 'resolve' | 'reject' | 'never' = 'resolve';

    constructor(healthResults: FakeExecutionResult[]) {
        super();
        this.healthResults = [...healthResults];
    }

    executeJavaScript = vi.fn(async (script: string) => {
        this.executedScripts.push(script);
        if (script.includes('dawfi-renderer-recovery')) {
            if (this.fallbackInjectionMode === 'reject') throw new Error('renderer unavailable');
            if (this.fallbackInjectionMode === 'never') {
                return new Promise<never>(() => undefined);
            }
            return true;
        }

        const result = this.healthResults.shift();
        if (result instanceof Error) throw result;
        if (result === 'never') return new Promise<never>(() => undefined);
        return result ?? { healthy: true, reason: 'ready' };
    });
}

class FakeWindow extends EventEmitter {
    readonly webContents: FakeWebContents;
    readonly isDestroyed = vi.fn(() => false);
    readonly close = vi.fn();

    constructor(webContents: FakeWebContents) {
        super();
        this.webContents = webContents;
    }
}

const healthy = (): RootHealth => ({ healthy: true, reason: 'ready' });
const empty = (): RootHealth => ({ healthy: false, reason: 'root-empty' });
const missing = (): RootHealth => ({ healthy: false, reason: 'root-missing' });

const createGuard = (
    healthResults: FakeExecutionResult[],
    overrides: Record<string, unknown> = {}
) => {
    const webContents = new FakeWebContents(healthResults);
    const win = new FakeWindow(webContents);
    const logger = vi.fn();
    const guard = visibilityModule.createRendererVisibilityGuard({
        win,
        role: 'editor',
        logger,
        initialCheckDelayMs: 10,
        emptyConfirmationDelayMs: 5,
        monitorIntervalMs: 20,
        executionTimeoutMs: 15,
        ...overrides
    });
    return { guard, logger, webContents, win };
};

const finishLoadAndCheck = async (webContents: FakeWebContents) => {
    webContents.emit('did-finish-load');
    await vi.advanceTimersByTimeAsync(10);
};

const confirmEmpty = async () => {
    await vi.advanceTimersByTimeAsync(5);
};

afterEach(() => {
    vi.useRealTimers();
});

describe('renderer visibility guard', () => {
    it('reloads once when #root remains empty after did-finish-load, then shows an actionable fallback', async () => {
        vi.useFakeTimers();
        const { guard, logger, webContents } = createGuard([
            empty(), empty(),
            empty(), empty(),
            missing(), missing()
        ]);

        await finishLoadAndCheck(webContents);
        await confirmEmpty();
        expect(webContents.reloadIgnoringCache).toHaveBeenCalledTimes(1);
        expect(guard.getState().autoReloadUsed).toBe(true);

        webContents.emit('did-start-loading');
        await finishLoadAndCheck(webContents);
        await confirmEmpty();

        expect(webContents.reloadIgnoringCache).toHaveBeenCalledTimes(1);
        expect(guard.getState()).toMatchObject({
            phase: 'fallback',
            fallbackDisplayed: true,
            autoReloadUsed: true
        });

        const fallbackScript = webContents.executedScripts.find((script) => (
            script.includes('dawfi-renderer-recovery')
        ));
        expect(fallbackScript).toContain('La interfaz no pudo mostrarse');
        expect(fallbackScript).toContain('Reintentar carga');
        expect(fallbackScript).toContain('window.location.reload()');

        webContents.emit('did-start-loading');
        await finishLoadAndCheck(webContents);
        await confirmEmpty();
        expect(webContents.reloadIgnoringCache).toHaveBeenCalledTimes(1);
        expect(logger).toHaveBeenCalledWith(expect.objectContaining({ action: 'show-fallback' }));
    });

    it('detects a root that becomes empty after a healthy render', async () => {
        vi.useFakeTimers();
        const { guard, webContents } = createGuard([healthy(), empty(), empty()]);

        await finishLoadAndCheck(webContents);
        expect(guard.getState().phase).toBe('healthy');

        await vi.advanceTimersByTimeAsync(20);
        expect(guard.getState().phase).toBe('confirming-empty');
        await confirmEmpty();

        expect(webContents.reloadIgnoringCache).toHaveBeenCalledTimes(1);
        expect(guard.getState().phase).toBe('reloading');
    });

    it('does not reload for a brief empty root that recovers on confirmation', async () => {
        vi.useFakeTimers();
        const { guard, webContents } = createGuard([healthy(), empty(), healthy()]);

        await finishLoadAndCheck(webContents);
        await vi.advanceTimersByTimeAsync(20);
        await confirmEmpty();

        expect(webContents.reloadIgnoringCache).not.toHaveBeenCalled();
        expect(guard.getState()).toMatchObject({ phase: 'healthy', autoReloadUsed: false });
    });

    it('never exposes an inspection error or URL secret in diagnostics', async () => {
        vi.useFakeTimers();
        const secret = 'super-secret-refresh-token';
        const { logger, webContents } = createGuard([
            new Error(`https://example.invalid/?refresh_token=${secret}`)
        ]);

        await finishLoadAndCheck(webContents);

        expect(webContents.reloadIgnoringCache).toHaveBeenCalledTimes(1);
        expect(logger).toHaveBeenCalledWith({
            role: 'editor',
            cause: 'root-inspection-failed',
            stage: 'did-finish-load',
            action: 'reload-once'
        });
        expect(JSON.stringify(logger.mock.calls)).not.toContain(secret);
        expect(JSON.stringify(logger.mock.calls)).not.toContain('refresh_token');
    });

    it('uses a native actionable fallback if DOM fallback injection is unavailable', async () => {
        vi.useFakeTimers();
        type NativeFallbackActions = {
            cause: string;
            retry: () => void;
            close: () => void;
        };
        const showNativeFallback = vi.fn(async (_actions: NativeFallbackActions) => undefined);
        const { webContents, win } = createGuard(
            [empty(), empty(), empty(), empty()],
            { showNativeFallback }
        );

        await finishLoadAndCheck(webContents);
        await confirmEmpty();
        webContents.emit('did-start-loading');
        webContents.fallbackInjectionMode = 'reject';
        await finishLoadAndCheck(webContents);
        await confirmEmpty();

        expect(showNativeFallback).toHaveBeenCalledTimes(1);
        const actions = showNativeFallback.mock.calls[0][0];
        expect(actions.cause).toBe('root-empty');
        actions.retry();
        expect(webContents.reloadIgnoringCache).toHaveBeenCalledTimes(2);
        actions.close();
        expect(win.close).toHaveBeenCalledTimes(1);
    });

    it('times out a stalled inspection and consumes the automatic reload only once', async () => {
        vi.useFakeTimers();
        const { guard, logger, webContents } = createGuard(['never', 'never']);

        await finishLoadAndCheck(webContents);
        expect(guard.getState().pendingExecutionCount).toBe(1);
        await vi.advanceTimersByTimeAsync(15);

        expect(webContents.reloadIgnoringCache).toHaveBeenCalledTimes(1);
        expect(guard.getState()).toMatchObject({
            phase: 'reloading',
            autoReloadUsed: true,
            pendingExecutionCount: 0
        });
        expect(logger).toHaveBeenCalledWith({
            role: 'editor',
            cause: 'root-inspection-timeout',
            stage: 'did-finish-load',
            action: 'reload-once'
        });

        webContents.emit('did-start-loading');
        await finishLoadAndCheck(webContents);
        await vi.advanceTimersByTimeAsync(15);

        expect(webContents.reloadIgnoringCache).toHaveBeenCalledTimes(1);
        expect(guard.getState()).toMatchObject({ phase: 'fallback', fallbackDisplayed: true });
    });

    it('times out a stalled fallback injection and delegates to the native dialog', async () => {
        vi.useFakeTimers();
        type NativeFallbackActions = {
            cause: string;
            retry: () => void;
            close: () => void;
        };
        const showNativeFallback = vi.fn(async (_actions: NativeFallbackActions) => undefined);
        const { guard, logger, webContents } = createGuard(
            [empty(), empty(), empty(), empty()],
            { showNativeFallback }
        );

        await finishLoadAndCheck(webContents);
        await confirmEmpty();
        webContents.emit('did-start-loading');
        webContents.fallbackInjectionMode = 'never';
        await finishLoadAndCheck(webContents);
        await confirmEmpty();

        expect(guard.getState().pendingExecutionCount).toBe(1);
        await vi.advanceTimersByTimeAsync(15);

        expect(webContents.reloadIgnoringCache).toHaveBeenCalledTimes(1);
        expect(showNativeFallback).toHaveBeenCalledTimes(1);
        expect(logger).toHaveBeenCalledWith({
            role: 'editor',
            cause: 'fallback-injection-timeout',
            stage: 'fallback',
            action: 'show-native-fallback'
        });
        expect(guard.getState().pendingExecutionCount).toBe(0);
    });

    it('handles repeated unresponsive events without creating a reload loop', async () => {
        vi.useFakeTimers();
        const { guard, logger, webContents } = createGuard([]);

        await guard.handleUnresponsive();
        await guard.handleUnresponsive();
        await guard.handleUnresponsive();

        expect(webContents.reloadIgnoringCache).toHaveBeenCalledTimes(1);
        expect(guard.getState()).toMatchObject({
            autoReloadUsed: true,
            phase: 'fallback',
            fallbackDisplayed: true
        });
        expect(logger).toHaveBeenCalledWith({
            role: 'editor',
            cause: 'renderer-unresponsive',
            stage: 'runtime-monitor',
            action: 'reload-once'
        });
        expect(logger).toHaveBeenCalledWith({
            role: 'editor',
            cause: 'renderer-unresponsive',
            stage: 'runtime-monitor',
            action: 'show-fallback'
        });
    });

    it('settles a stalled execution and cancels its timeout during cleanup', async () => {
        vi.useFakeTimers();
        const { guard, webContents, win } = createGuard(['never']);

        await finishLoadAndCheck(webContents);
        expect(guard.getState().pendingExecutionCount).toBe(1);
        win.emit('closed');

        expect(guard.getState()).toMatchObject({
            disposed: true,
            hasPendingTimer: false,
            pendingExecutionCount: 0
        });
        await vi.advanceTimersByTimeAsync(100);
        expect(webContents.reloadIgnoringCache).not.toHaveBeenCalled();
    });

    it('cleans its timer and listeners when the window closes', async () => {
        vi.useFakeTimers();
        const { guard, webContents, win } = createGuard([healthy()]);

        webContents.emit('did-finish-load');
        expect(guard.getState().hasPendingTimer).toBe(true);
        win.emit('closed');

        expect(guard.getState()).toMatchObject({
            disposed: true,
            phase: 'disposed',
            hasPendingTimer: false
        });
        expect(webContents.listenerCount('did-start-loading')).toBe(0);
        expect(webContents.listenerCount('did-finish-load')).toBe(0);
        expect(webContents.listenerCount('destroyed')).toBe(0);

        await vi.advanceTimersByTimeAsync(100);
        expect(webContents.executeJavaScript).not.toHaveBeenCalled();
    });
});

describe('renderer visibility scripts', () => {
    it('executes the root probe and visible fallback against a real DOM', () => {
        const dom = new JSDOM(
            '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
            { runScripts: 'outside-only' }
        );

        const emptyResult = dom.window.eval(visibilityModule.ROOT_HEALTH_CHECK_SCRIPT) as RootHealth;
        expect(emptyResult).toEqual({ healthy: false, reason: 'root-empty' });

        dom.window.document.getElementById('root')?.append(dom.window.document.createElement('main'));
        const healthyResult = dom.window.eval(visibilityModule.ROOT_HEALTH_CHECK_SCRIPT) as RootHealth;
        expect(healthyResult).toEqual({ healthy: true, reason: 'ready' });

        expect(dom.window.eval(visibilityModule.createFallbackInjectionScript('root-empty'))).toBe(true);
        const overlay = dom.window.document.getElementById('dawfi-renderer-recovery');
        expect(overlay?.getAttribute('role')).toBe('alert');
        expect(overlay?.textContent).toContain('La interfaz no pudo mostrarse');
        expect(overlay?.querySelector('button')?.textContent).toBe('Reintentar carga');
        dom.window.close();
    });

    it('checks only root presence/content and keeps fallback diagnostics enumerated', () => {
        expect(visibilityModule.ROOT_HEALTH_CHECK_SCRIPT).toContain("getElementById('root')");
        expect(visibilityModule.ROOT_HEALTH_CHECK_SCRIPT).toContain('root-empty');

        const script = visibilityModule.createFallbackInjectionScript(
            'https://example.invalid/?access_token=never-log-me'
        );
        expect(script).toContain('Diagnóstico: root-inspection-failed');
        expect(script).not.toContain('access_token');
        expect(script).not.toContain('never-log-me');
    });
});
