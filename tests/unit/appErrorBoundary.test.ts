// @vitest-environment node

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const indexSource = readFileSync(new URL('../../index.tsx', import.meta.url), 'utf8');
const boundarySource = readFileSync(new URL('../../components/AppErrorBoundary.tsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');
const hardwareSettingsSource = readFileSync(new URL('../../components/HardwareSettingsModal.tsx', import.meta.url), 'utf8');

describe('desktop UI recovery boundary', () => {
    it('wraps DesktopRoot before mounting the Electron renderer', () => {
        expect(indexSource).toMatch(/<AppErrorBoundary>[\s\S]*?<DesktopRoot \/>[\s\S]*?<\/AppErrorBoundary>/);
    });

    it('keeps a visible, non-destructive recovery surface', () => {
        expect(boundarySource).toContain('data-app-error-fallback="true"');
        expect(boundarySource).toContain('Tus proyectos locales no se eliminan');
        expect(boundarySource).toContain('Reintentar interfaz');
        expect(boundarySource).toContain('Recargar DAW-fi');
        expect(boundarySource).not.toMatch(/localStorage\.clear|indexedDB\.deleteDatabase/);
    });

    it('keeps common user-facing DAW recovery and hardware copy valid UTF-8', () => {
        expect(`${appSource}\n${hardwareSettingsSource}`).not.toMatch(/Ã|Â|â†|�/);
    });

    it('keeps icon-only DAW tools named and stateful for keyboard and assistive access', () => {
        expect(appSource).toContain('type="button"');
        expect(appSource).toContain('aria-label={label}');
        expect(appSource).toContain('aria-pressed={active}');
    });
});
