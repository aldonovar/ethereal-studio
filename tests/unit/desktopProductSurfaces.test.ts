// @vitest-environment node

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
    getDesktopProductTitle,
    normalizeDesktopEditorRequest,
    normalizeDesktopProduct,
} = require('../../electron/desktop-product-surface.cjs') as {
    getDesktopProductTitle: (value?: unknown) => string;
    normalizeDesktopEditorRequest: (value?: unknown) => {
        product: 'studio' | 'score' | 'keys';
        projectId?: string;
        shareToken?: string;
    };
    normalizeDesktopProduct: (value?: unknown) => 'studio' | 'score' | 'keys';
};

const readSource = (relativePath: string): string => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

describe('desktop product surface contract', () => {
    it('allowlists the three products and defaults only an omitted product to studio', () => {
        expect(normalizeDesktopProduct()).toBe('studio');
        expect(normalizeDesktopProduct('studio')).toBe('studio');
        expect(normalizeDesktopProduct('score')).toBe('score');
        expect(normalizeDesktopProduct('keys')).toBe('keys');
        expect(() => normalizeDesktopProduct('admin')).toThrowError(/no está autorizada/i);
        expect(() => normalizeDesktopProduct('keys&surface=hub')).toThrowError(/no está autorizada/i);
        expect(() => normalizeDesktopProduct({ toString: () => 'score' })).toThrowError(/no está autorizada/i);
    });

    it('normalizes the whole IPC payload without passing unknown or malformed identifiers', () => {
        expect(normalizeDesktopEditorRequest()).toEqual({ product: 'studio' });
        expect(normalizeDesktopEditorRequest({ product: 'score', projectId: 'project-1' })).toEqual({
            product: 'score',
            projectId: 'project-1',
            shareToken: undefined,
        });
        expect(() => normalizeDesktopEditorRequest('score')).toThrowError(/solicitud/i);
        expect(() => normalizeDesktopEditorRequest({ product: 'keys', projectId: ' project-1' })).toThrowError(/proyecto/i);
        expect(() => normalizeDesktopEditorRequest({ product: 'studio', shareToken: 'x'.repeat(257) })).toThrowError(/token/i);
    });

    it('maps each authorized product to its independent window title', () => {
        expect(getDesktopProductTitle('studio')).toBe('DAW-fi Studio');
        expect(getDesktopProductTitle('score')).toBe('Score-fi');
        expect(getDesktopProductTitle('keys')).toBe('Keys-fi');
    });
});

describe('desktop product surface integration', () => {
    const mainSource = readSource('../../electron/main.cjs');
    const preloadSource = readSource('../../electron/preload.cjs');
    const appSource = readSource('../../App.tsx');
    const hubSource = readSource('../../components/desktop/DesktopHub.tsx');
    const workspaceSource = readSource('../../components/PianoScoreWorkspace.tsx');
    const cinemaSource = readSource('../../components/PianoCinema.tsx');

    it('keeps the privileged route hub-only and forwards only normalized product queries', () => {
        const openHandlerStart = mainSource.indexOf("ipcMain.handle('desktop-open-editor'");
        const showHubHandlerStart = mainSource.indexOf("ipcMain.handle('desktop-show-hub'");
        const authHandlerStart = mainSource.indexOf("ipcMain.handle('desktop-open-auth'");
        const openHandlerSource = mainSource.slice(openHandlerStart, showHubHandlerStart);
        const showHubHandlerSource = mainSource.slice(showHubHandlerStart, authHandlerStart);
        expect(openHandlerSource).toContain("requireNativeSender(event, ['hub'])");
        expect(showHubHandlerSource).toContain("requireNativeSender(event, ['editor'])");
        expect(mainSource).toContain('normalizeDesktopEditorRequest(request)');
        expect(mainSource).toContain("loadRendererSurface(editorWindow, 'editor', rendererRequest)");
        expect(preloadSource).toContain("ipcRenderer.invoke('desktop-open-editor', normalizeDesktopEditorRequest(request))");
    });

    it('exposes all three independent products from Studio Hub with accessible actions', () => {
        for (const product of ['studio', 'score', 'keys']) {
            expect(hubSource).toContain(`data-desktop-product="${product}"`);
            expect(hubSource).toContain(`onClick={() => openProduct('${product}')}`);
        }
        expect(hubSource).toContain('aria-label="Abrir DAW-fi Studio"');
        expect(hubSource).toContain('aria-label="Abrir Score-fi"');
        expect(hubSource).toContain('aria-label="Abrir Keys-fi"');
    });

    it('selects a focused score or keys surface while retaining the combined Studio tool', () => {
        expect(appSource).toContain("desktopProduct === 'score' ? 'score' : desktopProduct === 'keys' ? 'keys' : 'combined'");
        expect(workspaceSource).toContain("surfaceMode?: PianoScoreSurfaceMode");
        expect(workspaceSource).toContain("const showScoreSurface = surfaceMode !== 'keys'");
        expect(workspaceSource).toContain("const showKeysSurface = surfaceMode !== 'score'");
        expect(workspaceSource).toContain("aria-label={showSurfaceTabs ? undefined : 'Score-fi'}");
        expect(workspaceSource).toContain("aria-label={showSurfaceTabs ? undefined : 'Keys-fi'}");
    });

    it('contains no former product name in any user-facing music surface source', () => {
        const visibleSurfaceSource = [appSource, hubSource, workspaceSource, cinemaSource].join('\n');
        const retiredProductName = ['Falling', 'Notes'].join(' ');
        expect(visibleSurfaceSource.toLowerCase()).not.toContain(retiredProductName.toLowerCase());
        expect(cinemaSource).toContain('Visualizador Keys-fi');
        expect(workspaceSource).toContain('Score-fi · Keys-fi');
    });
});
