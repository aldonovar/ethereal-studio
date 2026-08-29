/// <reference lib="webworker" />

import type { NoteScanResult, NoteScanSettings } from '../services/noteScannerService.ts';
import {
    buildPolaritySafeMono,
    calibrateWindowedBounds,
    centsFromMidi,
    findInterpolatedPeak,
    refineEnvelopeBounds
} from '../services/transcriptionPrecisionService.ts';

export interface WorkerScanPayload {
    channels: Float32Array[];
    sampleRate: number;
    bpm: number;
    settings: NoteScanSettings;
}

interface WorkerIncomingMessage {
    type: 'scan';
    payload: WorkerScanPayload;
}

interface WorkerProgressPayload {
    stage: 'preparing' | 'analyzing' | 'postprocess' | 'done';
    progress: number;
    message: string;
}

interface MidiCandidate {
    midi: number;
    frequency: number;
}

interface FrameCandidate {
    midi: number;
    score: number;
    confidence: number;
    frequency: number;
    detuningCents: number;
}

interface ActivePitchState {
    startFrame: number;
    lastSeenFrame: number;
    missFrames: number;
    framesSeen: number;
    peakScore: number;
    confidenceSum: number;
    confidenceCount: number;
    velocityPeak: number;
    frequencyWeightedSum: number;
    frequencyWeight: number;
}

interface ActivePolyItem {
    id: number;
    end: number;
    confidence: number;
}

const workerScope: DedicatedWorkerGlobalScope | null = (
    typeof WorkerGlobalScope !== 'undefined'
    && typeof self !== 'undefined'
    && self instanceof WorkerGlobalScope
) ? self as DedicatedWorkerGlobalScope : null;

const HARMONIC_WEIGHTS = [1, 0.86, 0.62, 0.44, 0.32, 0.22];

const clamp = (value: number, min: number, max: number): number => {
    return Math.min(max, Math.max(min, value));
};

const midiToFrequency = (midi: number): number => {
    return 440 * Math.pow(2, (midi - 69) / 12);
};

const quantizeToGrid = (value: number, gridStep: number): number => {
    return Math.round(value / gridStep) * gridStep;
};

const postProgress = (payload: WorkerProgressPayload) => {
    workerScope?.postMessage({ type: 'progress', payload });
};

const downmixToMono = (channels: Float32Array[]): Float32Array => {
    return buildPolaritySafeMono(channels);
};

const removeDcAndPreEmphasis = (source: Float32Array): Float32Array => {
    if (source.length === 0) return source;

    let mean = 0;
    for (let i = 0; i < source.length; i++) {
        mean += source[i];
    }
    mean /= source.length;

    const output = new Float32Array(source.length);
    output[0] = source[0] - mean;

    for (let i = 1; i < source.length; i++) {
        const centered = source[i] - mean;
        const previousCentered = source[i - 1] - mean;
        // A very strong pre-emphasis erases quiet bass fundamentals whenever an
        // upper octave is present. Keep enough tilt for spectral clarity without
        // turning real low-register voicings into missing-fundamental aliases.
        output[i] = centered - (0.84 * previousCentered);
    }

    return output;
};

const decimateSignal = (source: Float32Array, factor: number): Float32Array => {
    if (factor <= 1) return source;

    const outLength = Math.floor(source.length / factor);
    const output = new Float32Array(outLength);

    for (let i = 0; i < outLength; i++) {
        let sum = 0;
        for (let k = 0; k < factor; k++) {
            sum += source[(i * factor) + k] || 0;
        }
        output[i] = sum / factor;
    }

    return output;
};

const buildHannWindow = (size: number): Float32Array => {
    const window = new Float32Array(size);
    for (let i = 0; i < size; i++) {
        window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
    }
    return window;
};

const fftRadix2 = (real: Float32Array, imag: Float32Array): void => {
    const n = real.length;
    const bits = Math.floor(Math.log2(n));

    for (let i = 0; i < n; i++) {
        let j = 0;
        for (let bit = 0; bit < bits; bit++) {
            j = (j << 1) | ((i >>> bit) & 1);
        }
        if (j > i) {
            const tempR = real[i];
            real[i] = real[j];
            real[j] = tempR;

            const tempI = imag[i];
            imag[i] = imag[j];
            imag[j] = tempI;
        }
    }

    for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1;
        const tableStep = (-2 * Math.PI) / size;

        for (let i = 0; i < n; i += size) {
            for (let j = 0; j < half; j++) {
                const index1 = i + j;
                const index2 = index1 + half;
                const angle = tableStep * j;
                const wr = Math.cos(angle);
                const wi = Math.sin(angle);

                const tr = (wr * real[index2]) - (wi * imag[index2]);
                const ti = (wr * imag[index2]) + (wi * real[index2]);

                real[index2] = real[index1] - tr;
                imag[index2] = imag[index1] - ti;
                real[index1] += tr;
                imag[index1] += ti;
            }
        }
    }
};

const localPeak = (spectrum: Float32Array, center: number, radius: number): number => {
    const start = Math.max(1, Math.floor(center - radius));
    const end = Math.min(spectrum.length - 2, Math.ceil(center + radius));
    let max = 0;

    for (let i = start; i <= end; i++) {
        if (spectrum[i] > max) max = spectrum[i];
    }

    return max;
};

const mergeOverlappingNotes = (notes: NoteScanResult['notes'], mergeGap16th: number): NoteScanResult['notes'] => {
    if (notes.length === 0) return notes;

    const sorted = [...notes].sort((a, b) => a.pitch - b.pitch || a.start - b.start);
    const merged: NoteScanResult['notes'] = [];

    sorted.forEach((note) => {
        const last = merged[merged.length - 1];
        if (!last || last.pitch !== note.pitch) {
            merged.push({ ...note });
            return;
        }

        const lastEnd = last.start + last.duration;
        if (note.start <= lastEnd + mergeGap16th) {
            const mergedEnd = Math.max(lastEnd, note.start + note.duration);
            last.duration = mergedEnd - last.start;
            last.velocity = Math.max(last.velocity, note.velocity);
            last.confidence = (last.confidence + note.confidence) / 2;
            return;
        }

        merged.push({ ...note });
    });

    return merged.sort((a, b) => a.start - b.start || b.pitch - a.pitch);
};

const enforcePolyphonyLimit = (notes: NoteScanResult['notes'], maxPolyphony: number): NoteScanResult['notes'] => {
    if (notes.length === 0 || maxPolyphony <= 0) return notes;

    const sorted = [...notes].sort((a, b) => a.start - b.start || b.pitch - a.pitch);
    const active: ActivePolyItem[] = [];
    const rejected = new Set<number>();

    sorted.forEach((note, id) => {
        const start = note.start;
        const end = note.start + note.duration;

        for (let i = active.length - 1; i >= 0; i--) {
            if (active[i].end <= start + 0.01) {
                active.splice(i, 1);
            }
        }

        if (active.length >= maxPolyphony) {
            let weakestIndex = 0;
            for (let i = 1; i < active.length; i++) {
                if (active[i].confidence < active[weakestIndex].confidence) {
                    weakestIndex = i;
                }
            }

            if (note.confidence <= active[weakestIndex].confidence) {
                rejected.add(id);
                return;
            }

            rejected.add(active[weakestIndex].id);
            active.splice(weakestIndex, 1);
        }

        active.push({ id, end, confidence: note.confidence });
    });

    return sorted.filter((_, id) => !rejected.has(id));
};

export const analyzePolyphonicNotes = (payload: WorkerScanPayload): NoteScanResult => {
    const { channels, bpm, settings } = payload;

    postProgress({ stage: 'preparing', progress: 0.02, message: 'Preparando analisis polifonico...' });

    const mono = downmixToMono(channels);
    const filtered = removeDcAndPreEmphasis(mono);
    const decimation = payload.sampleRate > 32000 ? 2 : 1;
    const signal = decimateSignal(filtered, decimation);
    const sampleRate = payload.sampleRate / decimation;

    const frameSize = settings.mode === 'polyphonic' ? 4096 : 2048;
    const hopSize = settings.mode === 'polyphonic' ? 192 : 256;
    const confirmFrames = settings.mode === 'polyphonic' ? 3 : 2;
    const releaseFrames = settings.mode === 'polyphonic' ? 4 : 3;

    const window = buildHannWindow(frameSize);
    const real = new Float32Array(frameSize);
    const imag = new Float32Array(frameSize);
    const magnitude = new Float32Array((frameSize >> 1) + 1);

    const nyquist = sampleRate * 0.5;
    const binHz = sampleRate / frameSize;

    const minMidi = clamp(Math.round(settings.minMidi), 21, 108);
    const maxMidi = clamp(Math.round(settings.maxMidi), minMidi, 108);
    const midiCandidates: MidiCandidate[] = [];

    for (let midi = minMidi; midi <= maxMidi; midi++) {
        const frequency = midiToFrequency(midi);
        if (frequency < 24 || frequency >= nyquist * 0.98) continue;
        midiCandidates.push({ midi, frequency });
    }

    const totalFrames = Math.max(1, Math.floor((signal.length - frameSize) / hopSize));
    const secondsPer16th = (60 / bpm) / 4;
    const minEnergy = 0.00075 + ((1 - settings.sensitivity) * 0.0038);

    const activeStates = new Map<number, ActivePitchState>();
    const pendingStarts = new Map<number, number>();
    const collectedNotes: NoteScanResult['notes'] = [];
    let analyzedFrames = 0;

    const finalizeNote = (midi: number, state: ActivePitchState) => {
        const coarseBounds = calibrateWindowedBounds(
            state.startFrame,
            state.lastSeenFrame,
            hopSize,
            frameSize,
            sampleRate
        );
        const coarseDuration16th = Math.max(
            0,
            (coarseBounds.endSec - coarseBounds.startSec) / secondsPer16th
        );
        if (coarseDuration16th < settings.minDuration16th) return;

        const { startSec, endSec } = refineEnvelopeBounds(
            signal,
            sampleRate,
            coarseBounds.startSec,
            coarseBounds.endSec,
            Math.min(0.16, (frameSize * 0.58) / sampleRate),
            midiToFrequency(midi)
        );
        const start16th = startSec / secondsPer16th;
        const duration16th = Math.max(0, (endSec - startSec) / secondsPer16th);
        if (duration16th < settings.minDuration16th) return;

        const avgConfidence = clamp(
            state.confidenceCount > 0 ? state.confidenceSum / state.confidenceCount : 0,
            0.08,
            1
        );

        const velocity = clamp(
            Math.round(28 + (state.velocityPeak * 84) + (avgConfidence * 22)),
            1,
            127
        );

        collectedNotes.push({
            pitch: midi,
            start: start16th,
            duration: duration16th,
            velocity,
            confidence: avgConfidence,
            frequency: state.frequencyWeight > 0
                ? state.frequencyWeightedSum / state.frequencyWeight
                : midiToFrequency(midi)
        });
    };

    const scoreFrame = (frameStart: number): { detections: FrameCandidate[]; energyNorm: number } => {
        let energy = 0;

        for (let i = 0; i < frameSize; i++) {
            const sample = signal[frameStart + i] || 0;
            const weighted = sample * window[i];
            real[i] = weighted;
            imag[i] = 0;
            energy += sample * sample;
        }

        const rms = Math.sqrt(energy / frameSize);
        const energyNorm = clamp((rms - minEnergy) / (0.035 + minEnergy), 0, 1);
        if (rms < minEnergy) {
            return { detections: [], energyNorm };
        }

        fftRadix2(real, imag);

        for (let i = 0; i < magnitude.length; i++) {
            const re = real[i];
            const im = imag[i];
            magnitude[i] = (re * re) + (im * im);
        }

        const scores: number[] = new Array(midiCandidates.length).fill(0);
        const estimatedFrequencies: number[] = new Array(midiCandidates.length).fill(0);
        const detunings: number[] = new Array(midiCandidates.length).fill(0);
        let maxScore = 1e-12;
        let sumScore = 0;

        for (let i = 0; i < midiCandidates.length; i++) {
            const { frequency } = midiCandidates[i];

            let score = 0;
            let weightTotal = 0;
            let fundamental = 0;
            let estimatedFrequency = frequency;

            for (let h = 1; h <= HARMONIC_WEIGHTS.length; h++) {
                const harmonicFreq = frequency * h;
                if (harmonicFreq >= nyquist * 0.98) break;

                const bin = harmonicFreq / binHz;
                const peakDetail = findInterpolatedPeak(magnitude, bin, h === 1 ? 2 : 1);
                const peak = peakDetail.magnitude;
                const weight = HARMONIC_WEIGHTS[h - 1];

                score += peak * weight;
                weightTotal += weight;
                if (h === 1) {
                    fundamental = peak;
                    estimatedFrequency = peakDetail.bin * binHz;
                }
            }

            const subPenalty = frequency > 70
                ? localPeak(magnitude, (frequency * 0.5) / binHz, 2) * 0.34
                : 0;

            const harmonicMean = score / Math.max(1e-9, weightTotal);
            const fundamentalPresence = clamp(
                fundamental / Math.max(1e-12, harmonicMean * 1.35),
                0,
                1
            );
            const missingFundamentalGuard = 0.3 + (Math.sqrt(fundamentalPresence) * 0.7);
            let normalizedScore = Math.max(0, (harmonicMean * missingFundamentalGuard) - subPenalty);
            normalizedScore /= Math.pow(frequency, 0.08);

            const detuningCents = centsFromMidi(estimatedFrequency, midiCandidates[i].midi);
            const pitchCloseness = Math.exp(-0.5 * Math.pow(detuningCents / 42, 2));
            normalizedScore *= 0.76 + (pitchCloseness * 0.24);

            scores[i] = normalizedScore;
            estimatedFrequencies[i] = estimatedFrequency;
            detunings[i] = detuningCents;
            sumScore += normalizedScore;
            if (normalizedScore > maxScore) maxScore = normalizedScore;
        }

        const mean = sumScore / Math.max(1, scores.length);
        let variance = 0;
        for (let i = 0; i < scores.length; i++) {
            const diff = scores[i] - mean;
            variance += diff * diff;
        }
        variance /= Math.max(1, scores.length);
        const std = Math.sqrt(variance);

        const ratioFloor = clamp(0.56 - (settings.sensitivity * 0.2), 0.24, 0.56);
        const adaptiveThreshold = mean + (std * (1.42 - (settings.sensitivity * 0.52)));
        const threshold = Math.max(adaptiveThreshold, maxScore * ratioFloor);

        const peaks: FrameCandidate[] = [];
        for (let i = 1; i < scores.length - 1; i++) {
            const score = scores[i];
            if (score < threshold) continue;
            if (score >= scores[i - 1] && score >= scores[i + 1]) {
                const confidence = clamp(
                    (score - threshold) / Math.max(1e-9, maxScore - threshold),
                    0,
                    1
                );

                peaks.push({
                    midi: midiCandidates[i].midi,
                    score,
                    confidence,
                    frequency: estimatedFrequencies[i],
                    detuningCents: detunings[i]
                });
            }
        }

        peaks.sort((a, b) => b.score - a.score);

        const selected: FrameCandidate[] = [];
        for (let i = 0; i < peaks.length; i++) {
            const candidate = peaks[i];

            const semitoneConflict = selected.some((sel) => Math.abs(sel.midi - candidate.midi) <= 1);
            if (semitoneConflict) continue;

            // Do not reject octaves or open voicings from a single spectral frame.
            // A quieter real bass note and a subharmonic alias have indistinguishable
            // score ratios here; temporal confirmation and neural/physical fusion
            // provide safer evidence later in the pipeline.
            selected.push(candidate);
            if (selected.length >= settings.maxPolyphony) break;
        }

        return {
            detections: selected.map((candidate) => ({
                ...candidate,
                confidence: clamp(
                    ((candidate.confidence * 0.8) + (energyNorm * 0.2))
                    * (0.88 + (0.12 * Math.exp(-0.5 * Math.pow(candidate.detuningCents / 50, 2)))),
                    0,
                    1
                )
            })),
            energyNorm
        };
    };

    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
        const frameStart = frameIndex * hopSize;
        const { detections } = scoreFrame(frameStart);

        const frameMap = new Map<number, FrameCandidate>();
        detections.forEach((detection) => frameMap.set(detection.midi, detection));

        const seenInFrame = new Set<number>();

        frameMap.forEach((detection, midi) => {
            seenInFrame.add(midi);
            const active = activeStates.get(midi);
            if (active) {
                active.lastSeenFrame = frameIndex;
                active.missFrames = 0;
                active.framesSeen += 1;
                active.peakScore = Math.max(active.peakScore, detection.score);
                active.confidenceSum += detection.confidence;
                active.confidenceCount += 1;
                active.velocityPeak = Math.max(active.velocityPeak, detection.confidence);
                const frequencyWeight = Math.max(0.05, detection.confidence);
                active.frequencyWeightedSum += detection.frequency * frequencyWeight;
                active.frequencyWeight += frequencyWeight;
                return;
            }

            const pending = (pendingStarts.get(midi) || 0) + 1;
            pendingStarts.set(midi, pending);

            if (pending >= confirmFrames) {
                activeStates.set(midi, {
                    startFrame: Math.max(0, frameIndex - confirmFrames + 1),
                    lastSeenFrame: frameIndex,
                    missFrames: 0,
                    framesSeen: pending,
                    peakScore: detection.score,
                    confidenceSum: detection.confidence,
                    confidenceCount: 1,
                    velocityPeak: detection.confidence,
                    frequencyWeightedSum: detection.frequency * Math.max(0.05, detection.confidence),
                    frequencyWeight: Math.max(0.05, detection.confidence)
                });
                pendingStarts.delete(midi);
            }
        });

        Array.from(pendingStarts.keys()).forEach((midi) => {
            if (!seenInFrame.has(midi)) pendingStarts.delete(midi);
        });

        activeStates.forEach((state, midi) => {
            if (seenInFrame.has(midi)) return;
            state.missFrames += 1;

            if (state.missFrames > releaseFrames) {
                finalizeNote(midi, state);
                activeStates.delete(midi);
            }
        });

        analyzedFrames += 1;

        if (frameIndex % 24 === 0 || frameIndex === totalFrames - 1) {
            const progress = clamp((frameIndex + 1) / totalFrames, 0, 1);
            postProgress({
                stage: 'analyzing',
                progress: 0.05 + (progress * 0.84),
                message: `Analizando notas polifonicas (${Math.round(progress * 100)}%)...`
            });
        }
    }

    activeStates.forEach((state, midi) => finalizeNote(midi, state));

    postProgress({ stage: 'postprocess', progress: 0.92, message: 'Aplicando refinamiento musical...' });

    let refined = mergeOverlappingNotes(collectedNotes, settings.mode === 'polyphonic' ? 0.24 : 0.16)
        .filter((note) => note.duration >= settings.minDuration16th)
        .filter((note) => note.pitch >= minMidi && note.pitch <= maxMidi);

    refined = enforcePolyphonyLimit(refined, settings.maxPolyphony);

    if (settings.quantize) {
        const step = settings.quantizeStep16th;
        refined = refined
            .map((note) => {
                const quantizedStart = Math.max(0, quantizeToGrid(note.start, step));
                const quantizedDuration = Math.max(settings.minDuration16th, quantizeToGrid(note.duration, step));
                return {
                    ...note,
                    start: quantizedStart,
                    duration: quantizedDuration
                };
            })
            .sort((a, b) => a.start - b.start || b.pitch - a.pitch);
    }

    refined = mergeOverlappingNotes(refined, settings.mode === 'polyphonic' ? 0.14 : 0.1);

    const averageConfidence = refined.length > 0
        ? refined.reduce((sum, note) => sum + note.confidence, 0) / refined.length
        : 0;

    const durationSeconds = signal.length / sampleRate;

    postProgress({ stage: 'done', progress: 1, message: `Escaneo completado (${refined.length} notas detectadas).` });

    return {
        notes: refined,
        averageConfidence,
        durationSeconds,
        analyzedFrames,
        settings
    };
};

if (workerScope) workerScope.onmessage = (event: MessageEvent<WorkerIncomingMessage>) => {
    const message = event.data;
    if (!message || message.type !== 'scan') return;

    try {
        const result = analyzePolyphonicNotes(message.payload);
        workerScope.postMessage({ type: 'result', payload: result });
    } catch (error) {
        const messageText = error instanceof Error ? error.message : 'Fallo en analisis polifonico';
        workerScope.postMessage({
            type: 'error',
            payload: { message: messageText }
        });
    }
};

export {};
