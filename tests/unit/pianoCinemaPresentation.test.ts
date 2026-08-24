import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import PianoCinema from '../../components/PianoCinema';
import { Note } from '../../types';

const NOTES: Note[] = [
    { pitch: 48, start: 0, duration: 2, velocity: 72 },
    { pitch: 60, start: 4, duration: 2.5, velocity: 118 },
    { pitch: 76, start: 8, duration: 3, velocity: 102 }
];

const renderCinema = (overrides: Partial<React.ComponentProps<typeof PianoCinema>> = {}): string => {
    return renderToStaticMarkup(React.createElement(PianoCinema, {
        notes: NOTES,
        playhead16th: 0,
        bpm: 124,
        isPlaying: false,
        total16ths: 128,
        selectedNoteKey: null,
        activeNoteIndexes: [],
        livePitches: [],
        sustainActive: false,
        ...overrides
    }));
};

describe('PianoCinema workstation presentation', () => {
    it('renders a restrained full-width scene and keyboard on the same horizontal coordinate system', () => {
        const markup = renderCinema();

        expect(markup).toContain('data-piano-cinema="workstation"');
        expect(markup).toContain('data-piano-cinema-stage="true"');
        expect(markup).toContain('data-piano-cinema-surface="workstation"');
        expect(markup).toContain('data-piano-cinema-lane-grid="true"');
        expect(markup).toContain('data-piano-cinema-playhead="true"');
        expect(markup).toContain('data-piano-cinema-keyboard="true"');
        expect(markup.match(/preserveAspectRatio="none"/g)).toHaveLength(2);
        expect(markup).toContain('motion-reduce:transition-none');
        expect(markup.match(/data-piano-cinema-note-body="true"/g)).toHaveLength(NOTES.length);
        expect(markup).not.toContain('aurora');
        expect(markup).not.toContain('active-glow');
        expect(markup).not.toContain('data-piano-cinema-note-trail');
    });

    it('uses a subtle functional reflection for active and live pitches', () => {
        const markup = renderCinema({
            activeNoteIndexes: [1],
            livePitches: [76],
            sustainActive: true
        });

        expect(markup).toContain('data-piano-cinema-key-reflection="C4"');
        expect(markup).toContain('data-piano-cinema-key-reflection="E5"');
        expect(markup).toContain('Sustain On');
        expect(markup).toContain('Live 1');
    });

    it('bounds ribbon marker density for long projects', () => {
        const markup = renderCinema({ total16ths: 16 * 2000 });
        const markerCount = markup.match(/data-piano-cinema-ribbon-marker=/g)?.length ?? 0;

        expect(markerCount).toBeGreaterThan(0);
        expect(markerCount).toBeLessThanOrEqual(48);
        expect(markup).toContain('aria-valuemax="32000"');
    });

    it('keeps transport navigation and note inspection accessible', () => {
        const markup = renderCinema();

        expect(markup).toContain('role="slider"');
        expect(markup).toContain('aria-label="Posición del transporte de Falling Notes"');
        expect(markup).toContain('role="button"');
        expect(markup).toContain('aria-label="C4, inicio 4.00, duración 2.50, velocidad 118"');
        expect(markup).toContain('aria-label="Velocidad de la nota seleccionada"');
    });

    it('retains the provided empty-state guidance', () => {
        const markup = renderCinema({
            notes: [],
            emptyTitle: 'Importa una interpretación',
            emptyMessage: 'Las notas aparecerán aquí cuando termine el análisis.'
        });

        expect(markup).toContain('Importa una interpretación');
        expect(markup).toContain('Las notas aparecerán aquí cuando termine el análisis.');
    });
});
