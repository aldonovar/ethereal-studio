// @vitest-environment node

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readSource = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');
const workspaceSource = readSource('../../components/PianoScoreWorkspace.tsx');
const cinemaSource = readSource('../../components/PianoCinema.tsx');

describe('Piano Score mobile surface', () => {
    it('uses one touch-selectable score/keys panel instead of crushing both vertically', () => {
        expect(workspaceSource).toContain("useState<'score' | 'keys'>");
        expect(workspaceSource).toContain('md:hidden');
        expect(workspaceSource).toContain("mobilePanel === 'score'");
        expect(workspaceSource).toContain("mobilePanel === 'keys'");
        expect(workspaceSource).toContain('role="tablist"');
        expect(workspaceSource).toContain('aria-selected={mobilePanel');
        expect(workspaceSource).toContain('h-11 md:h-8');
        expect(workspaceSource).toContain('h-11 w-11');
        expect(workspaceSource).toContain('overflow-x-auto');
        expect(workspaceSource).toContain('overscroll-x-contain');
        expect(cinemaSource).toContain('h-11 w-full');
    });

    it('keeps note drags captured and cancellable on touch hardware', () => {
        expect(cinemaSource).toContain('touch-none');
        expect(cinemaSource).toContain('svgRef.current?.setPointerCapture?.(event.pointerId)');
        expect(cinemaSource).toContain('releasePointerCapture(event.pointerId)');
        expect(cinemaSource).toContain('onLostPointerCapture');
        expect(cinemaSource).toContain("addEventListener('pointercancel'");
        expect(cinemaSource).toContain('event.pointerId !== dragState.pointerId');
    });
});
