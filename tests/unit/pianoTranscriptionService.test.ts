// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    DEFAULT_SCAN_SETTINGS,
    noteScannerService,
    type NoteScanResult
} from '../../services/noteScannerService';
import { pianoTranscriptionService } from '../../services/pianoTranscriptionService';

const makeAudioBuffer = (): AudioBuffer => {
    const sampleRate = 8_000;
    const samples = new Float32Array(sampleRate);
    for (let index = 0; index < samples.length; index += 1) {
        samples[index] = Math.sin((2 * Math.PI * 220 * index) / sampleRate) * 0.08;
    }

    return {
        duration: 1,
        length: samples.length,
        numberOfChannels: 1,
        sampleRate,
        getChannelData: () => samples
    } as unknown as AudioBuffer;
};

const denseHighConfidenceResult = (): NoteScanResult => ({
    notes: [
        { pitch: 48, start: 0, duration: 2, velocity: 96, confidence: 0.94, frequency: 130.81 },
        { pitch: 60, start: 0, duration: 2, velocity: 104, confidence: 0.96, frequency: 261.63 },
        { pitch: 64, start: 0, duration: 2, velocity: 101, confidence: 0.95, frequency: 329.63 },
        { pitch: 67, start: 0, duration: 2, velocity: 99, confidence: 0.93, frequency: 392 }
    ],
    averageConfidence: 0.945,
    durationSeconds: 1,
    analyzedFrames: 172,
    settings: {
        ...DEFAULT_SCAN_SETTINGS,
        mode: 'polyphonic',
        maxPolyphony: 10
    },
    backendUsed: 'webgl+physical',
    scanElapsedMs: 12,
    processedChunks: 1
});

describe('pianoTranscriptionService canonical HQ route', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('invokes the neural-plus-physical scanner exactly once even for a dense, high-confidence result', async () => {
        const directWorkerConstructor = vi.fn();
        class UnexpectedDirectPhysicalWorker {
            constructor() {
                directWorkerConstructor();
                throw new Error('HQ must not start a separate FFT-only worker.');
            }
        }
        vi.stubGlobal('Worker', UnexpectedDirectPhysicalWorker);

        const canonicalResult = denseHighConfidenceResult();
        const scannerSpy = vi.spyOn(noteScannerService, 'scanAudioBuffer')
            .mockResolvedValue(canonicalResult);

        const result = await pianoTranscriptionService.transcribeAudioBuffer(
            makeAudioBuffer(),
            120
        );

        expect(scannerSpy).toHaveBeenCalledTimes(1);
        expect(scannerSpy.mock.calls[0]?.[2]).toMatchObject({
            mode: 'polyphonic',
            maxPolyphony: 10
        });
        expect(directWorkerConstructor).not.toHaveBeenCalled();
        expect(result.scanResult.backendUsed).toBe('webgl+physical');
    });

    it('does not retry or fall back to an FFT-only result when the canonical HQ scanner fails', async () => {
        const failure = new Error('Basic Pitch model unavailable');
        const scannerSpy = vi.spyOn(noteScannerService, 'scanAudioBuffer')
            .mockRejectedValue(failure);

        await expect(
            pianoTranscriptionService.transcribeAudioBuffer(makeAudioBuffer(), 120)
        ).rejects.toBe(failure);

        expect(scannerSpy).toHaveBeenCalledTimes(1);
    });
});
