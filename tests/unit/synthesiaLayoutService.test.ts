// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { buildSynthesiaPitchViewport, midiNoteLabel } from '../../services/synthesiaLayoutService';

describe('Synthesia viewport', () => {
    it('magnifies a normal melody while retaining three octaves of context', () => {
        const viewport = buildSynthesiaPitchViewport([{ pitch: 60 }, { pitch: 64 }, { pitch: 67 }]);

        expect(viewport.minPitch).toBeLessThanOrEqual(60);
        expect(viewport.maxPitch).toBeGreaterThanOrEqual(67);
        expect(viewport.maxPitch - viewport.minPitch).toBe(36);
        expect(viewport.maxPitch - viewport.minPitch).toBeLessThan(87);
    });

    it('clamps extreme piano registers without hiding detected notes', () => {
        const viewport = buildSynthesiaPitchViewport([{ pitch: 21 }, { pitch: 108 }]);
        expect(viewport).toMatchObject({ minPitch: 21, maxPitch: 108, noteCount: 2 });
    });

    it('uses the same clamped pitches that the visualizer renders', () => {
        const viewport = buildSynthesiaPitchViewport([{ pitch: 60 }, { pitch: 110 }]);
        expect(viewport.minPitch).toBeLessThanOrEqual(60);
        expect(viewport.maxPitch).toBe(108);
        expect(viewport.noteCount).toBe(2);
    });

    it('creates stable musician-readable pitch labels', () => {
        expect(midiNoteLabel(21)).toBe('A0');
        expect(midiNoteLabel(60)).toBe('C4');
        expect(midiNoteLabel(108)).toBe('C8');
    });
});
