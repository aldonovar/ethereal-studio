import { Note, ScoreConfidenceRegion } from '../types';
import {
    DEFAULT_SCAN_SETTINGS,
    DetectedMidiNote,
    NoteScanProgress,
    NoteScanResult,
    NoteScanSettings,
    noteScannerService
} from './noteScannerService';
import { normalizeClipNotes } from './pianoScoreConversionService';

export interface PianoTranscriptionResult {
    notes: Note[];
    confidenceRegions: ScoreConfidenceRegion[];
    averageConfidence: number;
    scanResult: NoteScanResult;
}

interface EnvelopeFrame {
    timeSec: number;
    rms: number;
    onset: number;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const midiToFrequency = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);

const sortDetectedNotes = (notes: DetectedMidiNote[]): DetectedMidiNote[] => {
    return [...notes].sort((left, right) => left.start - right.start || right.pitch - left.pitch);
};

const overlapsEnough = (left: DetectedMidiNote, right: DetectedMidiNote, factor = 0.45): boolean => {
    const leftEnd = left.start + left.duration;
    const rightEnd = right.start + right.duration;
    const overlap = Math.min(leftEnd, rightEnd) - Math.max(left.start, right.start);
    return overlap > Math.min(left.duration, right.duration) * factor;
};

const computeRms = (samples: Float32Array): number => {
    if (samples.length === 0) return 0;
    let energy = 0;
    for (let i = 0; i < samples.length; i += 1) {
        energy += samples[i] * samples[i];
    }
    return Math.sqrt(energy / samples.length);
};

const toMono = (buffer: AudioBuffer): Float32Array => {
    if (buffer.numberOfChannels <= 1) {
        return new Float32Array(buffer.getChannelData(0));
    }

    const mono = new Float32Array(buffer.length);
    const inv = 1 / buffer.numberOfChannels;
    for (let i = 0; i < buffer.length; i += 1) {
        let sum = 0;
        for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) {
            sum += buffer.getChannelData(ch)[i];
        }
        mono[i] = sum * inv;
    }
    return mono;
};

const buildEnvelopeFrames = (buffer: AudioBuffer): EnvelopeFrame[] => {
    const mono = toMono(buffer);
    const frameSize = 1024;
    const hopSize = 256;
    const frames: EnvelopeFrame[] = [];
    let previousRms = 0;

    for (let start = 0; start + frameSize <= mono.length; start += hopSize) {
        const frame = mono.subarray(start, start + frameSize);
        const rms = computeRms(frame);
        const onset = Math.max(0, rms - previousRms);
        previousRms = (previousRms * 0.58) + (rms * 0.42);
        frames.push({
            timeSec: (start + (frameSize * 0.5)) / buffer.sampleRate,
            rms,
            onset
        });
    }

    return frames;
};

const findNearestFrameIndex = (frames: EnvelopeFrame[], targetSec: number): number => {
    if (frames.length === 0) return -1;
    let low = 0;
    let high = frames.length - 1;

    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (frames[mid].timeSec < targetSec) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }

    if (low === 0) return low;
    const prev = frames[low - 1];
    const next = frames[low];
    return Math.abs(prev.timeSec - targetSec) <= Math.abs(next.timeSec - targetSec) ? low - 1 : low;
};

const goertzelMagnitude = (samples: Float32Array, sampleRate: number, frequency: number): number => {
    if (samples.length === 0 || frequency <= 0 || frequency >= sampleRate * 0.5) return 0;

    const normalizedBin = (samples.length * frequency) / sampleRate;
    const omega = (2 * Math.PI * normalizedBin) / samples.length;
    const coefficient = 2 * Math.cos(omega);
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;

    for (let i = 0; i < samples.length; i += 1) {
        s0 = samples[i] + (coefficient * s1) - s2;
        s2 = s1;
        s1 = s0;
    }

    return Math.sqrt((s1 * s1) + (s2 * s2) - (coefficient * s1 * s2));
};

const snapPianoChordStarts = (notes: DetectedMidiNote[]): DetectedMidiNote[] => {
    if (notes.length <= 1) return notes;

    const sorted = sortDetectedNotes(notes);
    const output: DetectedMidiNote[] = [];
    const tolerance16th = 0.18;
    let bucket: DetectedMidiNote[] = [];

    const flush = () => {
        if (bucket.length === 0) return;
        if (bucket.length === 1) {
            output.push(bucket[0]);
            bucket = [];
            return;
        }

        const weightedStart = bucket.reduce((sum, note) => sum + (note.start * (0.6 + note.confidence)), 0)
            / bucket.reduce((sum, note) => sum + (0.6 + note.confidence), 0);

        bucket.forEach((note) => {
            output.push({
                ...note,
                start: Math.abs(note.start - weightedStart) <= 0.22 ? weightedStart : note.start
            });
        });

        bucket = [];
    };

    sorted.forEach((note) => {
        if (bucket.length === 0) {
            bucket.push({ ...note });
            return;
        }

        if (Math.abs(note.start - bucket[0].start) <= tolerance16th) {
            bucket.push({ ...note });
            return;
        }

        flush();
        bucket.push({ ...note });
    });
    flush();

    return sortDetectedNotes(output);
};

const stabilizePianoChordDurations = (notes: DetectedMidiNote[]): DetectedMidiNote[] => {
    if (notes.length <= 2) return notes;

    const sorted = sortDetectedNotes(notes);
    const output: DetectedMidiNote[] = [];
    const tolerance16th = 0.18;
    let bucket: DetectedMidiNote[] = [];

    const flush = () => {
        if (bucket.length === 0) return;
        if (bucket.length === 1) {
            output.push(bucket[0]);
            bucket = [];
            return;
        }

        const rankedDurations = [...bucket]
            .map((note) => note.duration)
            .sort((left, right) => left - right);
        const targetDuration = rankedDurations[Math.floor(rankedDurations.length * 0.6)] || rankedDurations[rankedDurations.length - 1] || 0.5;

        bucket.forEach((note) => {
            const shouldExtend = note.duration < targetDuration * 0.78 && note.confidence < 0.78;
            output.push({
                ...note,
                duration: shouldExtend ? Math.max(note.duration, targetDuration * 0.82) : note.duration
            });
        });

        bucket = [];
    };

    sorted.forEach((note) => {
        if (bucket.length === 0) {
            bucket.push({ ...note });
            return;
        }

        if (Math.abs(note.start - bucket[0].start) <= tolerance16th) {
            bucket.push({ ...note });
            return;
        }

        flush();
        bucket.push({ ...note });
    });
    flush();

    return sortDetectedNotes(output);
};

const suppressPianoHarmonicGhosts = (notes: DetectedMidiNote[]): DetectedMidiNote[] => {
    if (notes.length <= 1) return notes;

    const ranked = [...notes].sort((left, right) => right.confidence - left.confidence || right.velocity - left.velocity);
    const accepted: DetectedMidiNote[] = [];

    ranked.forEach((candidate) => {
        const harmonicAnchor = accepted.some((stronger) => {
            if (stronger.pitch >= candidate.pitch) return false;

            const interval = candidate.pitch - stronger.pitch;
            if (interval !== 12 && interval !== 19 && interval !== 24) return false;
            if (Math.abs(stronger.start - candidate.start) > 0.16) return false;
            if (!overlapsEnough(stronger, candidate, 0.42)) return false;

            const confidenceRatio = candidate.confidence / Math.max(0.001, stronger.confidence);
            const ratioLimit = interval === 12 ? 0.76 : interval === 19 ? 0.62 : 0.54;
            const durationCompatible = candidate.duration <= stronger.duration * 1.12;
            const highRegisterGhost = candidate.pitch >= 72 || candidate.confidence <= 0.56;

            return confidenceRatio < ratioLimit && durationCompatible && highRegisterGhost;
        });

        if (!harmonicAnchor) {
            accepted.push(candidate);
        }
    });

    return sortDetectedNotes(accepted);
};

const removeIsolatedPianoNoise = (notes: DetectedMidiNote[], averageConfidence: number): DetectedMidiNote[] => {
    if (notes.length === 0) return notes;

    const confidenceFloor = averageConfidence >= 0.72 ? 0.38 : averageConfidence >= 0.58 ? 0.33 : 0.28;

    return notes.filter((note, index) => {
        if (note.confidence >= confidenceFloor) return true;
        if (note.duration >= 1.35) return true;

        const supportedByNeighbor = notes.some((other, otherIndex) => {
            if (otherIndex === index) return false;
            if (Math.abs(other.start - note.start) > 0.22) return false;
            return Math.abs(other.pitch - note.pitch) <= 12;
        });

        const samePitchContinuation = notes.some((other, otherIndex) => {
            if (otherIndex === index) return false;
            if (other.pitch !== note.pitch) return false;
            return Math.abs(other.start - note.start) <= 0.4;
        });

        return supportedByNeighbor || samePitchContinuation;
    });
};

const refineOnsetsWithEnvelope = (
    notes: DetectedMidiNote[],
    frames: EnvelopeFrame[],
    bpm: number
): DetectedMidiNote[] => {
    if (notes.length === 0 || frames.length === 0) return notes;

    const secondsPer16th = (60 / bpm) / 4;
    const averageOnset = frames.reduce((sum, frame) => sum + frame.onset, 0) / Math.max(1, frames.length);

    return sortDetectedNotes(notes).map((note) => {
        const startSec = note.start * secondsPer16th;
        const centerIndex = findNearestFrameIndex(frames, startSec);
        if (centerIndex === -1) return note;

        const startIndex = Math.max(0, centerIndex - 14);
        const endIndex = Math.min(frames.length - 1, centerIndex + 8);
        let bestFrame = frames[centerIndex];
        let bestScore = (bestFrame.onset * 1.8) + bestFrame.rms;

        for (let i = startIndex; i <= endIndex; i += 1) {
            const frame = frames[i];
            const distancePenalty = Math.abs(frame.timeSec - startSec) * 5.5;
            const score = (frame.onset * 1.95) + (frame.rms * 0.4) - distancePenalty;
            if (score > bestScore) {
                bestFrame = frame;
                bestScore = score;
            }
        }

        if (bestFrame.onset < averageOnset * 0.72 && Math.abs(bestFrame.timeSec - startSec) > 0.035) {
            return note;
        }

        return {
            ...note,
            start: Math.max(0, bestFrame.timeSec / secondsPer16th)
        };
    });
};

const trimDurationsByNeighboringStarts = (
    notes: DetectedMidiNote[],
    bpm: number
): DetectedMidiNote[] => {
    if (notes.length === 0) return notes;

    const secondsPer16th = (60 / bpm) / 4;
    const sorted = sortDetectedNotes(notes);

    return sorted.map((note, index) => {
        const nextRelated = sorted.slice(index + 1).find((candidate) => (
            candidate.start > note.start
            && (candidate.pitch === note.pitch || Math.abs(candidate.pitch - note.pitch) <= 2)
        ));

        if (!nextRelated) return note;

        const gap16th = nextRelated.start - note.start;
        if (gap16th <= 0.18) return note;

        const maxDuration = Math.max(0.18, gap16th - (0.06 / secondsPer16th));
        if (note.duration <= maxDuration) return note;

        return {
            ...note,
            duration: maxDuration
        };
    });
};

const refinePitchAndVelocityFromSpectrum = (
    notes: DetectedMidiNote[],
    buffer: AudioBuffer,
    bpm: number
): DetectedMidiNote[] => {
    if (notes.length === 0) return notes;

    const mono = toMono(buffer);
    const sampleRate = buffer.sampleRate;
    const secondsPer16th = (60 / bpm) / 4;
    const strengthValues: number[] = [];

    const refined = sortDetectedNotes(notes).map((note) => {
        const startSec = note.start * secondsPer16th;
        const attackStartSec = clamp(startSec + 0.008, 0, Math.max(0, buffer.duration - 0.02));
        const attackEndSec = clamp(attackStartSec + 0.095, attackStartSec + 0.02, buffer.duration);
        const attackStart = Math.floor(attackStartSec * sampleRate);
        const attackEnd = Math.max(attackStart + 64, Math.floor(attackEndSec * sampleRate));
        const segment = mono.subarray(attackStart, attackEnd);

        if (segment.length < 128) {
            strengthValues.push(0);
            return note;
        }

        const candidatePitches = [
            note.confidence < 0.62 && note.pitch - 12 >= 21 ? note.pitch - 12 : null,
            note.pitch - 1 >= 21 ? note.pitch - 1 : null,
            note.pitch,
            note.pitch + 1 <= 108 ? note.pitch + 1 : null
        ].filter((value): value is number => typeof value === 'number');

        let bestPitch = note.pitch;
        let bestMagnitude = 0;
        let referenceMagnitude = 0;

        candidatePitches.forEach((pitch) => {
            const magnitude = goertzelMagnitude(segment, sampleRate, midiToFrequency(pitch));
            if (pitch === note.pitch) {
                referenceMagnitude = magnitude;
            }
            if (magnitude > bestMagnitude) {
                bestMagnitude = magnitude;
                bestPitch = pitch;
            }
        });

        const attackStrength = computeRms(segment) + (bestMagnitude / Math.max(1, segment.length * 20));
        strengthValues.push(attackStrength);

        const semitoneShift = Math.abs(bestPitch - note.pitch) === 1 && bestMagnitude > referenceMagnitude * 1.08;
        const octaveDownShift = bestPitch === note.pitch - 12 && bestMagnitude > referenceMagnitude * 1.18;

        return {
            ...note,
            pitch: semitoneShift || octaveDownShift ? bestPitch : note.pitch
        };
    });

    const sortedStrengths = [...strengthValues].sort((left, right) => left - right);
    const lowStrength = sortedStrengths[Math.floor(sortedStrengths.length * 0.1)] || 0;
    const highStrength = sortedStrengths[Math.floor(sortedStrengths.length * 0.9)] || 1;
    const strengthSpan = Math.max(0.00001, highStrength - lowStrength);

    return refined.map((note, index) => {
        const normalizedStrength = clamp((strengthValues[index] - lowStrength) / strengthSpan, 0, 1);
        return {
            ...note,
            velocity: clamp(Math.round(20 + (normalizedStrength * 96) + (note.confidence * 11)), 1, 127),
            confidence: clamp(note.confidence * (0.94 + (normalizedStrength * 0.12)), 0, 1)
        };
    });
};

const refinePianoHqNotes = (
    notes: DetectedMidiNote[],
    averageConfidence: number,
    buffer: AudioBuffer,
    bpm: number
): DetectedMidiNote[] => {
    const envelopeFrames = buildEnvelopeFrames(buffer);
    let refined = sortDetectedNotes(notes);
    refined = refineOnsetsWithEnvelope(refined, envelopeFrames, bpm);
    refined = trimDurationsByNeighboringStarts(refined, bpm);
    refined = snapPianoChordStarts(refined);
    refined = stabilizePianoChordDurations(refined);
    refined = suppressPianoHarmonicGhosts(refined);
    refined = refinePitchAndVelocityFromSpectrum(refined, buffer, bpm);
    refined = removeIsolatedPianoNoise(refined, averageConfidence);
    return sortDetectedNotes(refined);
};

const buildConfidenceRegions = (notes: DetectedMidiNote[]): ScoreConfidenceRegion[] => {
    if (notes.length === 0) return [];

    const bucketMap = new Map<number, number[]>();
    notes.forEach((note) => {
        const measureIndex = Math.floor(note.start / 16);
        const confidences = bucketMap.get(measureIndex) || [];
        confidences.push(note.confidence);
        bucketMap.set(measureIndex, confidences);
    });

    return Array.from(bucketMap.entries())
        .sort((left, right) => left[0] - right[0])
        .map(([measureIndex, confidences]) => {
            const start16th = measureIndex * 16;
            const end16th = start16th + 16;
            const totalConfidence = confidences.reduce((sum, value) => sum + value, 0);
            return {
                id: `confidence-measure-${measureIndex}`,
                start16th,
                end16th,
                confidence: totalConfidence / confidences.length,
                label: confidences.length >= 6 ? 'dense' : 'phrase'
            };
        });
};

const buildPianoDefaults = (settings: Partial<NoteScanSettings>): Partial<NoteScanSettings> => {
    return {
        ...DEFAULT_SCAN_SETTINGS,
        mode: 'polyphonic',
        sensitivity: 0.73,
        maxPolyphony: 10,
        minMidi: 21,
        maxMidi: 108,
        quantize: false,
        quantizeStep16th: 1,
        minDuration16th: 0.4,
        ...settings
    };
};

export const pianoTranscriptionService = {
    async transcribeAudioBuffer(
        buffer: AudioBuffer,
        bpm: number,
        settings: Partial<NoteScanSettings> = {},
        onProgress?: (progress: NoteScanProgress) => void,
        signal?: AbortSignal
    ): Promise<PianoTranscriptionResult> {
        const normalizedSettings = buildPianoDefaults(settings) as NoteScanSettings;

        onProgress?.({
            stage: 'preparing',
            progress: 0.04,
            message: 'Inicializando transcripcion HQ de piano...'
        });

        const baseScanResult = await noteScannerService.scanAudioBuffer(
            buffer,
            bpm,
            normalizedSettings,
            onProgress,
            signal
        );

        onProgress?.({
            stage: 'postprocess',
            progress: 0.9,
            message: 'Midiendo onsets, energía, frecuencias e intensidad del análisis HQ...'
        });

        const refinedDetectedNotes = refinePianoHqNotes(
            baseScanResult.notes,
            baseScanResult.averageConfidence,
            buffer,
            bpm
        );

        const averageConfidence = refinedDetectedNotes.length > 0
            ? refinedDetectedNotes.reduce((sum, note) => sum + note.confidence, 0) / refinedDetectedNotes.length
            : 0;

        const notes = normalizeClipNotes(refinedDetectedNotes.map((note) => ({
            pitch: note.pitch,
            start: note.start,
            duration: note.duration,
            velocity: clamp(Math.round((note.velocity * 0.7) + (note.confidence * 36)), 1, 127)
        })));

        onProgress?.({
            stage: 'done',
            progress: 1,
            message: `Análisis HQ de piano (${notes.length} notas) · confianza del detector ${(averageConfidence * 100).toFixed(0)}%`
        });

        return {
            notes,
            confidenceRegions: buildConfidenceRegions(refinedDetectedNotes),
            averageConfidence,
            scanResult: {
                ...baseScanResult,
                notes: refinedDetectedNotes,
                averageConfidence
            }
        };
    }
};
