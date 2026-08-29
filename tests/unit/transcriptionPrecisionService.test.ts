// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
    buildPolaritySafeMono,
    centsFromMidi,
    findInterpolatedPeak,
    refineEnvelopeBounds
} from '../../services/transcriptionPrecisionService';
import {
    analyzePolyphonicNotes,
    type WorkerScanPayload
} from '../../workers/note-transcriber.worker';

const SAMPLE_RATE = 16_000;
const BPM = 120;
const SECONDS_PER_16TH = (60 / BPM) / 4;

interface ToneEvent {
    midi: number;
    start: number;
    end: number;
    amplitude?: number;
}

const midiToFrequency = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);

const renderTones = (events: ToneEvent[], durationSeconds: number): Float32Array => {
    const samples = new Float32Array(Math.ceil(durationSeconds * SAMPLE_RATE));
    const attackSeconds = 0.012;
    const releaseSeconds = 0.045;

    for (let index = 0; index < samples.length; index++) {
        const time = index / SAMPLE_RATE;
        let value = 0;

        events.forEach((event) => {
            if (time < event.start || time >= event.end) return;
            const attack = Math.min(1, (time - event.start) / attackSeconds);
            const release = Math.min(1, (event.end - time) / releaseSeconds);
            const envelope = Math.sin(Math.min(attack, release) * Math.PI * 0.5) ** 2;
            const phase = 2 * Math.PI * midiToFrequency(event.midi) * (time - event.start);
            const amplitude = event.amplitude ?? 0.5;
            // Piano-like partials make this fixture exercise harmonic rejection too.
            value += amplitude * envelope * (
                Math.sin(phase)
                + (Math.sin(phase * 2) * 0.24)
                + (Math.sin(phase * 3) * 0.09)
            );
        });

        samples[index] = Math.max(-1, Math.min(1, value));
    }

    return samples;
};

const analyze = (events: ToneEvent[], durationSeconds = 1.4) => {
    const payload: WorkerScanPayload = {
        channels: [renderTones(events, durationSeconds)],
        sampleRate: SAMPLE_RATE,
        bpm: BPM,
        settings: {
            mode: 'polyphonic',
            sensitivity: 0.78,
            minMidi: 21,
            maxMidi: 108,
            maxPolyphony: 6,
            quantize: false,
            quantizeStep16th: 1,
            minDuration16th: 0.25
        }
    };
    return analyzePolyphonicNotes(payload);
};

const startSeconds = (note: { start: number }) => note.start * SECONDS_PER_16TH;
const durationSeconds = (note: { duration: number }) => note.duration * SECONDS_PER_16TH;

describe('Keys-fi transcription precision', () => {
    it('preserves strongly anti-phase stereo instead of cancelling the track', () => {
        const left = renderTones([{ midi: 69, start: 0, end: 0.5 }], 0.5);
        const right = Float32Array.from(left, (sample) => -sample);
        const mono = buildPolaritySafeMono([left, right]);

        const peak = mono.reduce((highest, sample) => Math.max(highest, Math.abs(sample)), 0);
        expect(peak).toBeGreaterThan(0.35);
    });

    it('interpolates spectral frequency between FFT bins within musical cents tolerance', () => {
        const spectrum = new Float32Array(64);
        spectrum[20] = 4;
        spectrum[21] = 10;
        spectrum[22] = 7;
        const peak = findInterpolatedPeak(spectrum, 21, 2);

        expect(peak.bin).toBeGreaterThan(21);
        expect(peak.bin).toBeLessThan(21.5);
    });

    it('keeps a quiet note attached to its own onset instead of a louder retrigger', () => {
        const signal = renderTones([
            { midi: 60, start: 0.35, end: 0.48, amplitude: 0.12 },
            { midi: 60, start: 0.5, end: 0.8, amplitude: 0.65 }
        ], 1.1);
        const bounds = refineEnvelopeBounds(
            signal,
            SAMPLE_RATE,
            0.38,
            0.49,
            0.16,
            midiToFrequency(60)
        );

        expect(Math.abs(bounds.startSec - 0.35)).toBeLessThanOrEqual(0.035);
        expect(bounds.endSec).toBeLessThan(0.5);
    });

    it('reuses narrow-band kernels within a bounded postprocess budget', () => {
        const signal = renderTones([
            { midi: 33, start: 0.1, end: 1.9, amplitude: 0.25 }
        ], 2);
        const startedAt = performance.now();
        for (let index = 0; index < 120; index++) {
            refineEnvelopeBounds(signal, SAMPLE_RATE, 0.8, 1.2, 0.16, midiToFrequency(33));
        }
        expect(performance.now() - startedAt).toBeLessThan(600);
    });

    it('detects A4 with calibrated onset, duration and sub-bin frequency', () => {
        const expected = { midi: 69, start: 0.25, end: 0.92 };
        const result = analyze([expected]);
        const note = result.notes.find((candidate) => candidate.pitch === expected.midi);

        expect(note, JSON.stringify(result.notes)).toBeDefined();
        expect(Math.abs(startSeconds(note!) - expected.start)).toBeLessThanOrEqual(0.09);
        expect(Math.abs(durationSeconds(note!) - (expected.end - expected.start))).toBeLessThanOrEqual(0.12);
        expect(Math.abs(centsFromMidi(note!.frequency, expected.midi))).toBeLessThanOrEqual(24);
    });

    it('keeps the three simultaneous notes of a C-major chord aligned', () => {
        const chord = [60, 64, 67].map((midi) => ({ midi, start: 0.22, end: 0.98, amplitude: 0.27 }));
        const result = analyze(chord, 1.35);
        const detected = chord.map(({ midi }) => result.notes.find((note) => note.pitch === midi));

        expect(detected.every(Boolean), JSON.stringify(result.notes)).toBe(true);
        const onsets = detected.map((note) => startSeconds(note!));
        expect(Math.max(...onsets) - Math.min(...onsets)).toBeLessThanOrEqual(0.035);
        onsets.forEach((onset) => expect(Math.abs(onset - 0.22)).toBeLessThanOrEqual(0.1));
        expect(
            result.notes.filter((note) => note.confidence >= 0.2).map((note) => note.pitch).sort((a, b) => a - b)
        ).toEqual([60, 64, 67]);
    });

    it('retains a quiet bass under a real two-octave voicing', () => {
        const voicing: ToneEvent[] = [
            { midi: 48, start: 0.22, end: 0.98, amplitude: 0.24 },
            { midi: 72, start: 0.22, end: 0.98, amplitude: 0.45 }
        ];
        const result = analyze(voicing, 1.35);
        const stablePitches = result.notes
            .filter((note) => note.confidence >= 0.16)
            .map((note) => note.pitch);

        expect(stablePitches, JSON.stringify(result.notes)).toContain(48);
        expect(stablePitches, JSON.stringify(result.notes)).toContain(72);
    });

    it('separates a C-major melody into stable, ordered onsets', () => {
        const melody: ToneEvent[] = [
            { midi: 60, start: 0.12, end: 0.42 },
            { midi: 64, start: 0.52, end: 0.82 },
            { midi: 67, start: 0.92, end: 1.22 }
        ];
        const result = analyze(melody, 1.5);
        const detected = melody.map(({ midi }) => result.notes.find((note) => note.pitch === midi));

        expect(detected.every(Boolean), JSON.stringify(result.notes)).toBe(true);
        const onsets = detected.map((note) => startSeconds(note!));
        expect(onsets[0]).toBeLessThan(onsets[1]);
        expect(onsets[1]).toBeLessThan(onsets[2]);
        onsets.forEach((onset, index) => {
            expect(
                Math.abs(onset - melody[index].start),
                `expected ${melody[index].midi}@${melody[index].start.toFixed(3)}s, got ${onset.toFixed(3)}s; ${JSON.stringify(result.notes)}`
            ).toBeLessThanOrEqual(0.1);
        });
        expect(result.notes.filter((note) => note.confidence >= 0.25).map((note) => note.pitch)).toEqual([60, 64, 67]);
    });
});
