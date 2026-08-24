// @vitest-environment node

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../components/Transport.tsx', import.meta.url), 'utf8');

const actionButton = (action: string): string => {
    const marker = `data-transport-action="${action}"`;
    const markerIndex = source.indexOf(marker);
    expect(markerIndex, `missing ${action} transport action`).toBeGreaterThanOrEqual(0);
    const start = source.lastIndexOf('<button', markerIndex);
    const end = source.indexOf('</button>', markerIndex);
    expect(start, `missing ${action} button start`).toBeGreaterThanOrEqual(0);
    expect(end, `missing ${action} button end`).toBeGreaterThan(markerIndex);
    return source.slice(start, end + '</button>'.length);
};

describe('Transport control contract', () => {
    it.each([
        ['rewind', 'onSkipStart', 'Volver al inicio'],
        ['stop', 'onStop', 'Detener y volver al inicio'],
        ['play', 'onPlay', 'Reproducir'],
        ['pause', 'onPause', 'Pausar']
    ])('wires %s directly to %s with an accessible name', (action, callback, label) => {
        const button = actionButton(action);
        expect(button).toContain('type="button"');
        expect(button).toContain(`onClick={${callback}}`);
        expect(button).toContain(`aria-label="${label}"`);
    });

    it('exposes mutually coherent playback, pause and stopped visuals', () => {
        expect(source).toContain('const isPlaybackActive = transport.isPlaying;');
        expect(source).toContain('const isPaused = !transport.isPlaying && !transport.isRecording && !engineIsPlaying && hasResumeOffset;');
        expect(source).toContain('const isStopped = !transport.isPlaying && !transport.isRecording && !engineIsPlaying && !hasResumeOffset;');
        expect(actionButton('play')).toContain('aria-pressed={isPlaybackActive}');
        expect(actionButton('pause')).toContain('aria-pressed={isPaused}');
        expect(actionButton('stop')).toContain('aria-pressed={isStopped}');
    });

    it('groups the controls and keeps a visible keyboard focus treatment', () => {
        expect(source).toContain('role="group" aria-label="Controles de transporte"');
        expect(source).toContain('focus-visible:ring-2');
    });
});
