import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrackType, type Note, type ScoreWorkspaceState, type Track, type TransportState } from '../../types';
import { createDefaultScoreWorkspace } from '../../services/pianoScoreConversionService';

const mocks = vi.hoisted(() => ({
    transcribeAudioBuffer: vi.fn()
}));

vi.mock('../../services/pianoTranscriptionService', () => ({
    pianoTranscriptionService: {
        transcribeAudioBuffer: mocks.transcribeAudioBuffer
    }
}));

vi.mock('../../components/ScoreViewport', () => ({ default: () => null }));
vi.mock('../../components/PianoCinema', () => ({ default: () => null }));

import PianoScoreWorkspace from '../../components/PianoScoreWorkspace';

const makeClip = (id: string) => ({
    id,
    name: `Audio ${id}`,
    color: '#8b5cf6',
    notes: [] as Note[],
    start: 1,
    length: 4,
    offset: 0,
    fadeIn: 0,
    fadeOut: 0,
    gain: 1,
    playbackRate: 1,
    originalBpm: 120,
    buffer: { duration: 4 } as AudioBuffer
});

const track: Track = {
    id: 'audio-track',
    name: 'Piano stem',
    type: TrackType.AUDIO,
    color: '#8b5cf6',
    volume: 0,
    pan: 0,
    reverb: 0,
    transpose: 0,
    monitor: 'auto',
    isMuted: false,
    isSoloed: false,
    isArmed: false,
    clips: [makeClip('clip-a'), makeClip('clip-b')],
    sessionClips: [],
    devices: []
};

const transport: TransportState = {
    isPlaying: false,
    isRecording: false,
    loopMode: 'off',
    bpm: 120,
    timeSignature: [4, 4],
    currentBar: 1,
    currentBeat: 1,
    currentSixteenth: 1,
    masterTranspose: 0,
    gridSize: 0.25,
    snapToGrid: true,
    scaleRoot: 0,
    scaleType: 'chromatic'
};

const workspaces: ScoreWorkspaceState[] = ['clip-a', 'clip-b'].map((clipId) => (
    createDefaultScoreWorkspace('audio-track', clipId, `Score ${clipId}`, 'audio-derived')
));

const transcriptionResult = {
    notes: [{ pitch: 60, start: 0, duration: 1, velocity: 100 }],
    confidenceRegions: [],
    averageConfidence: 0.9,
    scanResult: {
        notes: [],
        confidenceRegions: [],
        averageConfidence: 0.9
    }
};

const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
};

describe('PianoScoreWorkspace transcription ownership', () => {
    let container: HTMLDivElement;
    let root: Root;
    const onScoreWorkspacesChange = vi.fn();

    const renderWorkspace = (selectedClipId: string) => {
        flushSync(() => {
            root.render(React.createElement(PianoScoreWorkspace, {
                isOpen: true,
                tracks: [track],
                transport,
                selectedTrackId: track.id,
                selectedClipId,
                scoreWorkspaces: workspaces,
                onClose: vi.fn(),
                onScoreWorkspacesChange,
                onCreateMidiTrackFromScore: vi.fn(() => null),
                onUpdateMidiClip: vi.fn(() => true),
                onSelectSource: vi.fn(),
                onPlay: vi.fn(),
                onPause: vi.fn(),
                onStop: vi.fn(),
                onSeekToBarTime: vi.fn()
            }));
        });
    };

    const buttonWithText = (text: string): HTMLButtonElement => {
        const button = Array.from(container.querySelectorAll('button'))
            .find((candidate) => candidate.textContent?.includes(text));
        if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button: ${text}`);
        return button;
    };

    beforeEach(() => {
        mocks.transcribeAudioBuffer.mockReset();
        onScoreWorkspacesChange.mockReset();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        flushSync(() => root.unmount());
        container.remove();
    });

    it('aborts the previous source and ignores a late transcription result', async () => {
        const pending = deferred<typeof transcriptionResult>();
        mocks.transcribeAudioBuffer.mockReturnValueOnce(pending.promise);
        renderWorkspace('clip-a');

        flushSync(() => buttonWithText('Analizar Piano').click());
        const sourceSelect = container.querySelector('select[aria-label="Fuente musical de Score-fi y Keys-fi"]');
        expect(sourceSelect).toBeInstanceOf(HTMLSelectElement);
        expect((sourceSelect as HTMLSelectElement).disabled).toBe(true);
        expect(buttonWithText('Cancelar analisis')).toBeInstanceOf(HTMLButtonElement);

        const signal = mocks.transcribeAudioBuffer.mock.calls[0]?.[4] as AbortSignal;
        expect(signal.aborted).toBe(false);

        renderWorkspace('clip-b');
        expect(signal.aborted).toBe(true);

        pending.resolve(transcriptionResult);
        await pending.promise;
        await Promise.resolve();
        flushSync(() => undefined);

        expect(onScoreWorkspacesChange).not.toHaveBeenCalled();
        expect(container.textContent).not.toContain('Commit MIDI');
    });

    it('offers an explicit cancel action and restores source selection', async () => {
        mocks.transcribeAudioBuffer.mockImplementationOnce((
            _buffer: AudioBuffer,
            _bpm: number,
            _settings: unknown,
            _onProgress: unknown,
            signal: AbortSignal
        ) => new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        }));
        renderWorkspace('clip-a');

        flushSync(() => buttonWithText('Analizar Piano').click());
        flushSync(() => {
            buttonWithText('Cancelar analisis').click();
        });
        await Promise.resolve();
        flushSync(() => undefined);

        const sourceSelect = container.querySelector('select[aria-label="Fuente musical de Score-fi y Keys-fi"]') as HTMLSelectElement;
        expect(sourceSelect.disabled).toBe(false);
        expect(container.textContent).toContain('Transcripcion cancelada');
        expect(container.textContent).not.toContain('Cancelar analisis');
    });
});
