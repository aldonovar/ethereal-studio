import { Note } from '../types';
import { buildPolaritySafeMono } from './transcriptionPrecisionService';

export type NoteScanMode = 'quick' | 'polyphonic';

export interface NoteScanSettings {
    mode: NoteScanMode;
    sensitivity: number;
    minMidi: number;
    maxMidi: number;
    maxPolyphony: number;
    quantize: boolean;
    quantizeStep16th: number;
    minDuration16th: number;
}

export interface DetectedMidiNote extends Note {
    confidence: number;
    frequency: number;
}

export interface NoteScanProgress {
    stage: 'preparing' | 'analyzing' | 'postprocess' | 'done';
    progress: number;
    message: string;
}

export interface NoteScanResult {
    notes: DetectedMidiNote[];
    averageConfidence: number;
    durationSeconds: number;
    analyzedFrames: number;
    settings: NoteScanSettings;
    backendUsed?: string;
    scanElapsedMs?: number;
    processedChunks?: number;
}

type TensorflowRuntime = typeof import('@tensorflow/tfjs');

const assetPath = (relativePath: string): string => {
    const base = import.meta.env.BASE_URL || '/';
    const normalizedBase = base.endsWith('/') ? base : `${base}/`;
    return `${normalizedBase}${relativePath.replace(/^\/+/, '')}`;
};

const MODEL_PATH = assetPath('models/basic-pitch/model.json');
const MODEL_SAMPLE_RATE = 22050;
const CHUNK_SECONDS = 18;
const CHUNK_OVERLAP_SECONDS = 1.1;
const ANALYZE_PROGRESS_START = 0.1;
const ANALYZE_PROGRESS_SPAN = 0.78;

export const DEFAULT_SCAN_SETTINGS: NoteScanSettings = {
    mode: 'polyphonic',
    sensitivity: 0.72,
    minMidi: 21,
    maxMidi: 108,
    maxPolyphony: 5,
    quantize: false,
    quantizeStep16th: 1,
    minDuration16th: 0.5
};

interface TimedCandidate {
    pitchMidi: number;
    startTimeSeconds: number;
    durationSeconds: number;
    amplitude: number;
    source?: 'neural' | 'physical';
    support: number;
}

interface ActiveWindowNote {
    endSec: number;
    confidence: number;
    index: number;
}

interface ChordBucket {
    start: number;
    notes: DetectedMidiNote[];
}

interface WorkerProgressMessage {
    type: 'progress';
    payload: NoteScanProgress;
}

interface WorkerResultMessage {
    type: 'result';
    payload: NoteScanResult;
}

interface WorkerErrorMessage {
    type: 'error';
    payload: {
        message: string;
    };
}

type WorkerOutgoingMessage = WorkerProgressMessage | WorkerResultMessage | WorkerErrorMessage;

const clamp = (value: number, min: number, max: number): number => {
    return Math.min(max, Math.max(min, value));
};

const midiToFrequency = (midi: number): number => {
    return 440 * Math.pow(2, (midi - 69) / 12);
};

const quantizeToGrid = (value: number, step: number): number => {
    return Math.round(value / step) * step;
};

const formatDurationCompact = (seconds: number): string => {
    if (!isFinite(seconds) || seconds <= 0) return '0s';
    if (seconds < 1) return '<1s';
    if (seconds < 60) return `${Math.round(seconds)}s`;

    const minutes = Math.floor(seconds / 60);
    const remSeconds = Math.round(seconds % 60);
    return `${minutes}m ${String(remSeconds).padStart(2, '0')}s`;
};

const resampleLinear = (input: Float32Array, inputSampleRate: number, targetSampleRate: number): Float32Array => {
    if (inputSampleRate === targetSampleRate) {
        return input;
    }

    const ratio = inputSampleRate / targetSampleRate;
    const outputLength = Math.max(1, Math.floor(input.length / ratio));
    const output = new Float32Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
        const sourcePos = i * ratio;
        const left = Math.floor(sourcePos);
        const right = Math.min(input.length - 1, left + 1);
        const frac = sourcePos - left;
        output[i] = input[left] + ((input[right] - input[left]) * frac);
    }

    return output;
};

const yieldToMain = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
    });
};

const computeRms = (buffer: Float32Array): number => {
    if (buffer.length === 0) return 0;

    let energy = 0;
    for (let i = 0; i < buffer.length; i++) {
        const sample = buffer[i];
        energy += sample * sample;
    }

    return Math.sqrt(energy / buffer.length);
};

const toMono = (buffer: AudioBuffer): Float32Array => {
    const channels = Array.from(
        { length: buffer.numberOfChannels },
        (_, channel) => buffer.getChannelData(channel)
    );
    return buildPolaritySafeMono(channels);
};

const enforcePolyphony = (notes: DetectedMidiNote[], maxPolyphony: number): DetectedMidiNote[] => {
    if (maxPolyphony <= 0 || notes.length === 0) return notes;

    const sorted = [...notes].sort((a, b) => a.start - b.start || b.pitch - a.pitch);
    const active: ActiveWindowNote[] = [];
    const rejected = new Set<number>();

    sorted.forEach((note, index) => {
        const start = note.start;
        const end = note.start + note.duration;

        for (let i = active.length - 1; i >= 0; i--) {
            if (active[i].endSec <= start + 0.01) {
                active.splice(i, 1);
            }
        }

        if (active.length >= maxPolyphony) {
            let weakest = 0;
            for (let i = 1; i < active.length; i++) {
                if (active[i].confidence < active[weakest].confidence) weakest = i;
            }

            if (note.confidence <= active[weakest].confidence) {
                rejected.add(index);
                return;
            }

            rejected.add(active[weakest].index);
            active.splice(weakest, 1);
        }

        active.push({ endSec: end, confidence: note.confidence, index });
    });

    return sorted.filter((_, index) => !rejected.has(index));
};

const mergeNearNotes = (notes: DetectedMidiNote[]): DetectedMidiNote[] => {
    if (notes.length === 0) return notes;

    const sorted = [...notes].sort((a, b) => a.pitch - b.pitch || a.start - b.start);
    const merged: DetectedMidiNote[] = [];

    sorted.forEach((note) => {
        const last = merged[merged.length - 1];
        if (!last || last.pitch !== note.pitch) {
            merged.push({ ...note });
            return;
        }

        const lastEnd = last.start + last.duration;
        if (note.start <= lastEnd + 0.16) {
            const end = Math.max(lastEnd, note.start + note.duration);
            last.duration = end - last.start;
            last.velocity = Math.max(last.velocity, note.velocity);
            last.confidence = clamp((last.confidence + note.confidence) * 0.5, 0, 1);
            return;
        }

        merged.push({ ...note });
    });

    return merged.sort((a, b) => a.start - b.start || b.pitch - a.pitch);
};

const removeWeakTransientNotes = (
    notes: DetectedMidiNote[],
    settings: NoteScanSettings
): DetectedMidiNote[] => {
    if (notes.length === 0) return notes;

    const confidenceFloor = clamp(0.42 - (settings.sensitivity * 0.26), 0.14, 0.4);
    const shortNoteCutoff = settings.minDuration16th * 1.5;

    return notes.filter((note) => {
        if (note.confidence >= confidenceFloor) return true;
        return note.duration > shortNoteCutoff;
    });
};

const trimSamePitchOverlaps = (notes: DetectedMidiNote[]): DetectedMidiNote[] => {
    if (notes.length === 0) return notes;

    const sorted = [...notes].sort((a, b) => a.pitch - b.pitch || a.start - b.start);
    const cleaned: DetectedMidiNote[] = [];

    sorted.forEach((note) => {
        const last = cleaned[cleaned.length - 1];
        if (!last || last.pitch !== note.pitch) {
            cleaned.push({ ...note });
            return;
        }

        const lastEnd = last.start + last.duration;
        const noteEnd = note.start + note.duration;
        const overlap = lastEnd - note.start;

        if (overlap > 0.08) {
            if (note.confidence > last.confidence + 0.06) {
                last.duration = Math.max(0.02, note.start - last.start);
                cleaned.push({ ...note });
            } else {
                const extendedEnd = Math.max(lastEnd, noteEnd);
                last.duration = Math.max(0.02, extendedEnd - last.start);
                last.velocity = Math.max(last.velocity, note.velocity);
                last.confidence = Math.max(last.confidence, note.confidence * 0.96);
            }
            return;
        }

        cleaned.push({ ...note });
    });

    return cleaned.filter((note) => note.duration > 0.02);
};

const collapseChordBuckets = (notes: DetectedMidiNote[], maxPolyphony: number): DetectedMidiNote[] => {
    if (notes.length === 0) return notes;

    const sorted = [...notes].sort((a, b) => a.start - b.start || b.confidence - a.confidence);
    const buckets: ChordBucket[] = [];
    const startTolerance16th = 0.26;

    sorted.forEach((note) => {
        const bucket = buckets[buckets.length - 1];
        if (!bucket || Math.abs(note.start - bucket.start) > startTolerance16th) {
            buckets.push({ start: note.start, notes: [{ ...note }] });
            return;
        }

        bucket.notes.push({ ...note });
    });

    const output: DetectedMidiNote[] = [];

    buckets.forEach((bucket) => {
        const ranked = bucket.notes.sort((a, b) => b.confidence - a.confidence || b.velocity - a.velocity);
        const kept: DetectedMidiNote[] = [];

        ranked.forEach((candidate) => {
            const octaveConflict = kept.some((existing) => {
                const isOctave = Math.abs(existing.pitch - candidate.pitch) % 12 === 0;
                if (!isOctave) return false;

                const existingEnd = existing.start + existing.duration;
                const candidateEnd = candidate.start + candidate.duration;
                const overlap = Math.min(existingEnd, candidateEnd) - Math.max(existing.start, candidate.start);
                return overlap > 0.18 && candidate.confidence < existing.confidence * 0.82;
            });

            if (!octaveConflict) {
                kept.push(candidate);
            }
        });

        output.push(...kept.slice(0, maxPolyphony));
    });

    return output.sort((a, b) => a.start - b.start || b.pitch - a.pitch);
};

const dedupeCandidateEvents = (candidates: TimedCandidate[]): TimedCandidate[] => {
    if (candidates.length <= 1) return candidates;

    const sorted = [...candidates].sort((a, b) => a.pitchMidi - b.pitchMidi || a.startTimeSeconds - b.startTimeSeconds);
    const deduped: TimedCandidate[] = [];

    sorted.forEach((candidate) => {
        const last = deduped[deduped.length - 1];
        if (!last || last.pitchMidi !== candidate.pitchMidi) {
            deduped.push({ ...candidate, support: Math.max(1, candidate.support || 1) });
            return;
        }

        const startDiff = Math.abs(candidate.startTimeSeconds - last.startTimeSeconds);
        const endLast = last.startTimeSeconds + last.durationSeconds;
        const endCandidate = candidate.startTimeSeconds + candidate.durationSeconds;
        const overlap = Math.min(endLast, endCandidate) - Math.max(last.startTimeSeconds, candidate.startTimeSeconds);

        if (startDiff <= 0.035 || overlap > Math.min(last.durationSeconds, candidate.durationSeconds) * 0.68) {
            last.startTimeSeconds = Math.min(last.startTimeSeconds, candidate.startTimeSeconds);
            last.durationSeconds = Math.max(endLast, endCandidate) - last.startTimeSeconds;
            last.amplitude = clamp((last.amplitude * 0.82) + (candidate.amplitude * 0.34), 0, 1);
            last.support += Math.max(1, candidate.support || 1);
            if (candidate.source === 'physical') {
                last.source = 'physical';
            }
            return;
        }

        deduped.push({ ...candidate, support: Math.max(1, candidate.support || 1) });
    });

    return deduped.sort((a, b) => a.startTimeSeconds - b.startTimeSeconds || b.pitchMidi - a.pitchMidi);
};

const overlapSeconds = (a: TimedCandidate, b: TimedCandidate): number => {
    const aEnd = a.startTimeSeconds + a.durationSeconds;
    const bEnd = b.startTimeSeconds + b.durationSeconds;
    return Math.max(0, Math.min(aEnd, bEnd) - Math.max(a.startTimeSeconds, b.startTimeSeconds));
};

const mapDetectedNotesToTimedCandidates = (
    notes: DetectedMidiNote[],
    bpm: number,
    source: 'physical' | 'neural',
    weight = 1
): TimedCandidate[] => {
    const secondsPer16th = (60 / bpm) / 4;
    return notes.map((note) => {
        const confidence = clamp(note.confidence, 0, 1);
        const velocityNorm = clamp(note.velocity / 127, 0, 1);
        return {
            pitchMidi: clamp(Math.round(note.pitch), 21, 108),
            startTimeSeconds: Math.max(0, note.start * secondsPer16th),
            durationSeconds: Math.max(0.02, note.duration * secondsPer16th),
            amplitude: clamp(((confidence * 0.8) + (velocityNorm * 0.2)) * weight, 0, 1),
            source,
            support: 1
        };
    });
};

const fuseNeuralAndPhysicalCandidates = (
    neuralCandidates: TimedCandidate[],
    physicalCandidates: TimedCandidate[]
): TimedCandidate[] => {
    if (physicalCandidates.length === 0) {
        return neuralCandidates;
    }

    const merged: TimedCandidate[] = neuralCandidates.map((candidate) => ({ ...candidate, source: 'neural' }));

    physicalCandidates.forEach((physical) => {
        let bestIndex = -1;
        let bestScore = -1;

        for (let i = 0; i < merged.length; i++) {
            const neural = merged[i];
            const startDiff = Math.abs(neural.startTimeSeconds - physical.startTimeSeconds);
            if (startDiff > 0.14) continue;

            const overlap = overlapSeconds(neural, physical);
            if (overlap <= 0.03) continue;

            const pitchDiff = Math.abs(neural.pitchMidi - physical.pitchMidi);
            if (pitchDiff > 12) continue;

            const overlapNorm = overlap / Math.max(0.08, Math.min(neural.durationSeconds, physical.durationSeconds));
            const score = ((1 - (startDiff / 0.14)) * 0.5)
                + (clamp(overlapNorm, 0, 1.4) * 0.35)
                + ((1 - (pitchDiff / 12)) * 0.15);

            if (score > bestScore) {
                bestScore = score;
                bestIndex = i;
            }
        }

        if (bestIndex === -1) {
            return;
        }

        const target = merged[bestIndex];
        const pitchDiffSigned = physical.pitchMidi - target.pitchMidi;

        if (Math.abs(pitchDiffSigned) <= 1) {
            const neuralWeight = clamp(target.amplitude, 0.05, 1);
            const physicalWeight = clamp(physical.amplitude * 1.12, 0.05, 1.2);
            const totalWeight = neuralWeight + physicalWeight;

            target.startTimeSeconds = ((target.startTimeSeconds * neuralWeight) + (physical.startTimeSeconds * physicalWeight)) / totalWeight;
            target.durationSeconds = Math.max(
                target.durationSeconds,
                (target.durationSeconds * 0.6) + (physical.durationSeconds * 0.7)
            );
            target.amplitude = clamp((target.amplitude * 0.72) + (physical.amplitude * 0.56) + 0.02, 0, 1);
            target.support += Math.max(1, physical.support || 1);
            return;
        }

        if (pitchDiffSigned === -12) {
            const shouldDownshift = physical.pitchMidi <= 67
                && physical.amplitude >= target.amplitude * 0.72
                && target.durationSeconds >= 0.08;

            if (shouldDownshift) {
                target.pitchMidi = physical.pitchMidi;
                target.startTimeSeconds = (target.startTimeSeconds + physical.startTimeSeconds) * 0.5;
                target.durationSeconds = Math.max(target.durationSeconds, physical.durationSeconds * 0.92);
                target.amplitude = clamp((target.amplitude * 0.46) + (physical.amplitude * 0.78), 0, 1);
                target.source = 'physical';
                target.support += Math.max(1, physical.support || 1);
                return;
            }
        }
    });

    const sorted = merged
        .map((candidate) => ({
            ...candidate,
            pitchMidi: clamp(Math.round(candidate.pitchMidi), 21, 108),
            durationSeconds: Math.max(0.02, candidate.durationSeconds),
            amplitude: clamp(candidate.amplitude, 0, 1),
            support: Math.max(1, candidate.support || 1)
        }))
        .sort((a, b) => a.startTimeSeconds - b.startTimeSeconds || a.pitchMidi - b.pitchMidi);

    const pruned: TimedCandidate[] = [];
    sorted.forEach((candidate) => {
        const upperGhost = pruned.some((accepted) => {
            const octaveAbove = candidate.pitchMidi - accepted.pitchMidi === 12;
            if (!octaveAbove) return false;

            const startDiff = Math.abs(candidate.startTimeSeconds - accepted.startTimeSeconds);
            if (startDiff > 0.09) return false;

            const overlap = overlapSeconds(candidate, accepted);
            if (overlap <= Math.min(candidate.durationSeconds, accepted.durationSeconds) * 0.55) return false;

            return candidate.amplitude < accepted.amplitude * 0.64
                && candidate.durationSeconds <= accepted.durationSeconds * 1.12;
        });

        if (!upperGhost) {
            pruned.push(candidate);
        }
    });

    return dedupeCandidateEvents(pruned);
};

const inferGlobalOctaveShift = (
    neuralCandidates: TimedCandidate[],
    physicalCandidates: TimedCandidate[]
): number => {
    if (neuralCandidates.length < 16) return 0;

    const strongNeural = neuralCandidates.filter((candidate) => candidate.amplitude >= 0.46 && candidate.durationSeconds >= 0.07);
    if (strongNeural.length < 12) return 0;

    if (physicalCandidates.length >= 8) {
        let nearUnisonMatches = 0;
        let downOctaveMatches = 0;

        strongNeural.forEach((neural) => {
            let best: TimedCandidate | null = null;
            let bestScore = -1;

            for (const physical of physicalCandidates) {
                const startDiff = Math.abs(neural.startTimeSeconds - physical.startTimeSeconds);
                if (startDiff > 0.16) continue;

                const overlap = overlapSeconds(neural, physical);
                if (overlap <= 0.03) continue;

                const pitchDiff = physical.pitchMidi - neural.pitchMidi;
                if (Math.abs(pitchDiff) > 14) continue;

                const score = (1 - (startDiff / 0.16)) + (1 - (Math.abs(pitchDiff) / 14));
                if (score > bestScore) {
                    bestScore = score;
                    best = physical;
                }
            }

            if (!best) return;
            const diff = best.pitchMidi - neural.pitchMidi;
            if (Math.abs(diff) <= 2) {
                nearUnisonMatches += 1;
                return;
            }
            if (diff >= -14 && diff <= -10) {
                downOctaveMatches += 1;
            }
        });

        if (
            downOctaveMatches >= 8
            && downOctaveMatches > nearUnisonMatches * 1.18
        ) {
            return -12;
        }
    }

    const sortedByPitch = [...strongNeural].sort((a, b) => a.pitchMidi - b.pitchMidi);
    const pitch10 = sortedByPitch[Math.floor(sortedByPitch.length * 0.1)]?.pitchMidi ?? 0;
    const lowRegisterCount = strongNeural.filter((candidate) => candidate.pitchMidi <= 33).length;
    const lowRegisterRatio = lowRegisterCount / Math.max(1, strongNeural.length);

    let comparable = 0;
    let lowerOctaveSupport = 0;
    let upperOctaveSupport = 0;

    strongNeural.forEach((candidate) => {
        if (candidate.pitchMidi < 34 || candidate.pitchMidi > 96) return;

        const lowerCompanion = strongNeural.some((other) => {
            if (other.pitchMidi !== candidate.pitchMidi - 12) return false;
            if (Math.abs(other.startTimeSeconds - candidate.startTimeSeconds) > 0.1) return false;
            const overlap = overlapSeconds(candidate, other);
            if (overlap <= Math.min(candidate.durationSeconds, other.durationSeconds) * 0.4) return false;
            return other.amplitude >= candidate.amplitude * 0.52;
        });

        const upperCompanion = strongNeural.some((other) => {
            if (other.pitchMidi !== candidate.pitchMidi + 12) return false;
            if (Math.abs(other.startTimeSeconds - candidate.startTimeSeconds) > 0.1) return false;
            const overlap = overlapSeconds(candidate, other);
            if (overlap <= Math.min(candidate.durationSeconds, other.durationSeconds) * 0.4) return false;
            return other.amplitude >= candidate.amplitude * 0.72;
        });

        if (lowerCompanion || upperCompanion) {
            comparable += 1;
        }
        if (lowerCompanion) lowerOctaveSupport += 1;
        if (upperCompanion) upperOctaveSupport += 1;
    });

    if (
        comparable >= 12
        && lowerOctaveSupport >= 8
        && lowerOctaveSupport >= upperOctaveSupport * 1.3
        && (pitch10 >= 37 || lowRegisterRatio < 0.05)
    ) {
        return -12;
    }

    return 0;
};

const applyPrecisionLockCandidateFilter = (
    candidates: TimedCandidate[],
    settings: NoteScanSettings
): TimedCandidate[] => {
    if (candidates.length === 0) return candidates;

    const sorted = [...candidates]
        .map((candidate) => ({
            ...candidate,
            support: Math.max(1, candidate.support || 1),
            amplitude: clamp(candidate.amplitude, 0, 1),
            durationSeconds: Math.max(0.02, candidate.durationSeconds)
        }))
        .sort((a, b) => a.startTimeSeconds - b.startTimeSeconds || b.pitchMidi - a.pitchMidi);

    return sorted.filter((candidate, index) => {
        const support = candidate.support;
        const pitch = candidate.pitchMidi;
        const amplitude = candidate.amplitude;
        const durationSeconds = candidate.durationSeconds;

        const baseFloor = pitch <= 52 ? 0.55 : pitch >= 84 ? 0.67 : 0.61;
        const sensitivityNudge = clamp((settings.sensitivity - 0.72) * 0.18, -0.03, 0.04);
        const amplitudeFloor = clamp(baseFloor - sensitivityNudge, 0.5, 0.76);

        const adjacentSupport = sorted.some((other, otherIndex) => {
            if (otherIndex === index) return false;
            if (Math.abs(other.pitchMidi - pitch) > 2) return false;
            if (Math.abs(other.startTimeSeconds - candidate.startTimeSeconds) > 0.075) return false;
            const overlap = overlapSeconds(other, candidate);
            return overlap > Math.min(other.durationSeconds, durationSeconds) * 0.4;
        });

        const strongOctaveAnchor = sorted.some((other, otherIndex) => {
            if (otherIndex === index) return false;
            if (Math.abs(other.pitchMidi - pitch) !== 12) return false;
            if (Math.abs(other.startTimeSeconds - candidate.startTimeSeconds) > 0.11) return false;
            const overlap = overlapSeconds(other, candidate);
            if (overlap <= Math.min(other.durationSeconds, durationSeconds) * 0.52) return false;
            return other.amplitude >= amplitude * 1.15;
        });

        if (durationSeconds <= 0.05 && support <= 1 && amplitude < amplitudeFloor + 0.08) {
            return false;
        }

        if (support <= 1 && amplitude < amplitudeFloor && !adjacentSupport) {
            return false;
        }

        if (strongOctaveAnchor && support <= 1 && amplitude < amplitudeFloor + 0.05) {
            return false;
        }

        return true;
    });
};

const pruneRapidRetriggers = (
    notes: DetectedMidiNote[],
    settings: NoteScanSettings
): DetectedMidiNote[] => {
    if (notes.length === 0) return notes;

    const sorted = [...notes].sort((a, b) => a.pitch - b.pitch || a.start - b.start);
    const output: DetectedMidiNote[] = [];
    const shortDurationCutoff = settings.minDuration16th * 1.45;

    sorted.forEach((note) => {
        const last = output[output.length - 1];
        if (!last || last.pitch !== note.pitch) {
            output.push({ ...note });
            return;
        }

        const lastEnd = last.start + last.duration;
        const gap = note.start - lastEnd;
        if (gap >= -0.02 && gap <= 0.2 && note.duration <= shortDurationCutoff) {
            if (note.confidence <= last.confidence * 1.05) {
                return;
            }

            last.duration = Math.max(0.02, note.start - last.start);
            output.push({ ...note });
            return;
        }

        output.push({ ...note });
    });

    return output.filter((note) => note.duration > 0.02);
};

const suppressOctaveGhostsGlobal = (notes: DetectedMidiNote[]): DetectedMidiNote[] => {
    if (notes.length === 0) return notes;

    const ranked = [...notes].sort((a, b) => b.confidence - a.confidence || b.velocity - a.velocity);
    const accepted: DetectedMidiNote[] = [];

    ranked.forEach((candidate) => {
        const ghost = accepted.some((stronger) => {
            const isOctave = Math.abs(stronger.pitch - candidate.pitch) % 12 === 0;
            if (!isOctave) return false;

            const strongerEnd = stronger.start + stronger.duration;
            const candidateEnd = candidate.start + candidate.duration;
            const overlap = Math.min(strongerEnd, candidateEnd) - Math.max(stronger.start, candidate.start);

            if (overlap <= 0.2 || Math.abs(stronger.start - candidate.start) >= 0.32) {
                return false;
            }

            const confidenceRatio = candidate.confidence / Math.max(0.001, stronger.confidence);
            const candidateIsLower = candidate.pitch < stronger.pitch;

            if (candidateIsLower) {
                const inBassOrMidRegister = candidate.pitch <= 64;
                const similarLength = candidate.duration >= stronger.duration * 0.78;

                if (inBassOrMidRegister && similarLength) {
                    return confidenceRatio < 0.46;
                }

                return confidenceRatio < 0.62
                    && candidate.duration <= stronger.duration * 1.15;
            }

            return confidenceRatio < 0.86
                && candidate.duration <= stronger.duration * 1.22;
        });

        if (!ghost) {
            accepted.push(candidate);
        }
    });

    return accepted.sort((a, b) => a.start - b.start || b.pitch - a.pitch);
};

const alignChordOnsets = (notes: DetectedMidiNote[]): DetectedMidiNote[] => {
    if (notes.length <= 1) return notes;

    const sorted = [...notes].sort((a, b) => a.start - b.start || b.pitch - a.pitch);
    const output: DetectedMidiNote[] = [];
    const startTolerance16th = 0.16;

    let bucket: DetectedMidiNote[] = [];
    const flush = () => {
        if (bucket.length === 0) return;
        if (bucket.length === 1) {
            output.push(bucket[0]);
            bucket = [];
            return;
        }

        const weightedStart = bucket.reduce((sum, note) => sum + (note.start * (0.65 + note.confidence)), 0)
            / bucket.reduce((sum, note) => sum + (0.65 + note.confidence), 0);

        bucket.forEach((note) => {
            output.push({
                ...note,
                start: Math.abs(note.start - weightedStart) <= 0.2 ? weightedStart : note.start
            });
        });

        bucket = [];
    };

    sorted.forEach((note) => {
        if (bucket.length === 0) {
            bucket.push({ ...note });
            return;
        }

        const anchor = bucket[0].start;
        if (Math.abs(note.start - anchor) <= startTolerance16th) {
            bucket.push({ ...note });
            return;
        }

        flush();
        bucket.push({ ...note });
    });
    flush();

    return output.sort((a, b) => a.start - b.start || b.pitch - a.pitch);
};

const stabilizeChordDurations = (notes: DetectedMidiNote[]): DetectedMidiNote[] => {
    if (notes.length <= 2) return notes;

    const sorted = [...notes].sort((a, b) => a.start - b.start || b.pitch - a.pitch);
    const output: DetectedMidiNote[] = [];
    const startTolerance16th = 0.16;

    let bucket: DetectedMidiNote[] = [];
    const flush = () => {
        if (bucket.length === 0) return;
        if (bucket.length === 1) {
            output.push(bucket[0]);
            bucket = [];
            return;
        }

        const rankedDurations = [...bucket]
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, Math.max(2, Math.floor(bucket.length * 0.7)))
            .map((note) => note.duration)
            .sort((a, b) => a - b);

        const medianDuration = rankedDurations[Math.floor(rankedDurations.length * 0.5)] || 0;

        bucket.forEach((note) => {
            const minTargetDuration = medianDuration * 0.52;
            if (medianDuration > 0 && note.duration < minTargetDuration && note.confidence < 0.7) {
                output.push({
                    ...note,
                    duration: minTargetDuration
                });
                return;
            }

            output.push(note);
        });

        bucket = [];
    };

    sorted.forEach((note) => {
        if (bucket.length === 0) {
            bucket.push({ ...note });
            return;
        }

        const anchor = bucket[0].start;
        if (Math.abs(note.start - anchor) <= startTolerance16th) {
            bucket.push({ ...note });
            return;
        }

        flush();
        bucket.push({ ...note });
    });

    flush();
    return output.sort((a, b) => a.start - b.start || b.pitch - a.pitch);
};

const filterAdjacentSemitoneGhosts = (notes: DetectedMidiNote[]): DetectedMidiNote[] => {
    if (notes.length <= 1) return notes;

    const sorted = [...notes].sort((a, b) => a.start - b.start || b.confidence - a.confidence);
    const kept: DetectedMidiNote[] = [];

    sorted.forEach((candidate) => {
        const hasConflict = kept.some((existing) => {
            const semitone = Math.abs(existing.pitch - candidate.pitch) === 1;
            if (!semitone) return false;

            const existingEnd = existing.start + existing.duration;
            const candidateEnd = candidate.start + candidate.duration;
            const overlap = Math.min(existingEnd, candidateEnd) - Math.max(existing.start, candidate.start);

            return overlap > 0.16
                && Math.abs(existing.start - candidate.start) < 0.24
                && candidate.confidence < existing.confidence * 0.74
                && candidate.duration < existing.duration * 1.12;
        });

        if (!hasConflict) {
            kept.push(candidate);
        }
    });

    return kept.sort((a, b) => a.start - b.start || b.pitch - a.pitch);
};

class NoteScannerService {
    private basicPitch: {
        evaluateModel: (
            resampledBuffer: AudioBuffer | Float32Array,
            onComplete: (frames: number[][], onsets: number[][], conotours: number[][]) => void,
            percentCallback: (percent: number) => void
        ) => Promise<void>;
    } | null = null;

    private basicPitchTools: {
        outputToNotesPoly: typeof import('@spotify/basic-pitch').outputToNotesPoly;
        addPitchBendsToNoteEvents: typeof import('@spotify/basic-pitch').addPitchBendsToNoteEvents;
        noteFramesToTime: typeof import('@spotify/basic-pitch').noteFramesToTime;
    } | null = null;

    private tfRuntime: TensorflowRuntime | null = null;
    private activeBackend: string | null = null;
    private modelBackend: string | null = null;

    private resetModelCache(): void {
        this.basicPitch = null;
        this.basicPitchTools = null;
        this.modelBackend = null;
    }

    private async ensureTensorflowBackend(forceCpu = false): Promise<void> {
        if (!this.tfRuntime) {
            this.tfRuntime = await import('@tensorflow/tfjs');
        }

        const tf = this.tfRuntime;
        const candidates = forceCpu ? ['cpu'] : ['webgl', 'cpu'];

        for (const backend of candidates) {
            try {
                if (tf.getBackend() !== backend) {
                    const switched = await tf.setBackend(backend);
                    if (!switched) continue;
                }

                await tf.ready();
                if (tf.getBackend() === backend) {
                    this.activeBackend = backend;
                    return;
                }
            } catch {
                // Try next backend candidate.
            }
        }

        const detectedBackend = tf.getBackend();
        if (detectedBackend) {
            this.activeBackend = detectedBackend;
            return;
        }

        throw new Error('No se pudo inicializar TensorFlow para el scanner.');
    }

    private isGpuShaderError(error: unknown): boolean {
        const message = error instanceof Error
            ? `${error.message} ${error.stack ?? ''}`
            : String(error);

        return /fragment\s+shader|compile\s+shader|webgl|glsl|gpu/i.test(message);
    }

    private assertNotAborted(signal?: AbortSignal): void {
        if (signal?.aborted) {
            throw new Error('Escaneo cancelado por el usuario.');
        }
    }

    private currentBackendLabel(): string {
        return (this.activeBackend || this.modelBackend || 'desconocido').toUpperCase();
    }

    private normalizeSettings(settings: Partial<NoteScanSettings>): NoteScanSettings {
        const merged: NoteScanSettings = {
            ...DEFAULT_SCAN_SETTINGS,
            ...settings
        };

        const minMidi = clamp(Math.round(merged.minMidi), 21, 108);
        const maxMidi = clamp(Math.round(merged.maxMidi), minMidi, 108);

        return {
            ...merged,
            sensitivity: clamp(merged.sensitivity, 0.1, 1),
            minMidi,
            maxMidi,
            maxPolyphony: clamp(Math.round(merged.maxPolyphony), 1, 10),
            quantizeStep16th: clamp(merged.quantizeStep16th, 0.25, 16),
            minDuration16th: clamp(merged.minDuration16th, 0.125, 64)
        };
    }

    private async runPhysicalRefinementWorker(
        buffer: AudioBuffer,
        bpm: number,
        settings: NoteScanSettings,
        onProgress?: (progress: NoteScanProgress) => void,
        signal?: AbortSignal
    ): Promise<DetectedMidiNote[]> {
        if (typeof Worker === 'undefined') {
            return [];
        }

        return await new Promise<DetectedMidiNote[]>((resolve, reject) => {
            const worker = new Worker(new URL('../workers/note-transcriber.worker.ts', import.meta.url), {
                type: 'module'
            });

            let settled = false;

            const cleanup = () => {
                signal?.removeEventListener('abort', handleAbort);
                worker.onmessage = null;
                worker.onerror = null;
                worker.terminate();
            };

            const finishResolve = (notes: DetectedMidiNote[]) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(notes);
            };

            const finishReject = (error: unknown) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(error instanceof Error ? error : new Error(String(error)));
            };

            const handleAbort = () => {
                finishReject(new Error('Escaneo cancelado por el usuario.'));
            };

            signal?.addEventListener('abort', handleAbort, { once: true });

            worker.onmessage = (event: MessageEvent<WorkerOutgoingMessage>) => {
                const message = event.data;
                if (!message) return;

                if (message.type === 'progress') {
                    const payload = message.payload;
                    onProgress?.({
                        stage: 'postprocess',
                        progress: 0.9 + (clamp(payload.progress, 0, 1) * 0.08),
                        message: `Validacion fisica: ${payload.message}`
                    });
                    return;
                }

                if (message.type === 'error') {
                    finishReject(new Error(message.payload.message || 'Fallo en validacion fisica.'));
                    return;
                }

                finishResolve(message.payload.notes || []);
            };

            worker.onerror = (event: ErrorEvent) => {
                finishReject(new Error(event.message || 'Fallo en el worker de validacion fisica.'));
            };

            const channels: Float32Array[] = [];
            const transferables: Transferable[] = [];

            for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
                const copied = new Float32Array(buffer.getChannelData(channel));
                channels.push(copied);
                transferables.push(copied.buffer);
            }

            worker.postMessage({
                type: 'scan',
                payload: {
                    channels,
                    sampleRate: buffer.sampleRate,
                    bpm,
                    settings
                }
            }, transferables);
        });
    }

    private async ensureModel(forceCpuBackend = false): Promise<typeof this.basicPitch> {
        await this.ensureTensorflowBackend(forceCpuBackend);

        if (this.basicPitch && this.basicPitchTools && this.modelBackend === this.activeBackend) {
            return this.basicPitch;
        }

        const basicPitchModule = await import('@spotify/basic-pitch');
        this.basicPitch = new basicPitchModule.BasicPitch(MODEL_PATH);
        this.basicPitchTools = {
            outputToNotesPoly: basicPitchModule.outputToNotesPoly,
            addPitchBendsToNoteEvents: basicPitchModule.addPitchBendsToNoteEvents,
            noteFramesToTime: basicPitchModule.noteFramesToTime
        };
        this.modelBackend = this.activeBackend;

        return this.basicPitch;
    }

    private convertToDetectedNotes(
        candidates: TimedCandidate[],
        bpm: number,
        settings: NoteScanSettings
    ): DetectedMidiNote[] {
        const secondsPer16th = (60 / bpm) / 4;

        let converted = candidates
            .filter((candidate) => candidate.pitchMidi >= settings.minMidi && candidate.pitchMidi <= settings.maxMidi)
            .map((candidate) => {
                const start16th = candidate.startTimeSeconds / secondsPer16th;
                const duration16th = Math.max(settings.minDuration16th, candidate.durationSeconds / secondsPer16th);
                const confidence = clamp(candidate.amplitude, 0, 1);

                return {
                    pitch: candidate.pitchMidi,
                    start: start16th,
                    duration: duration16th,
                    velocity: clamp(Math.round(22 + (confidence * 105)), 1, 127),
                    confidence,
                    frequency: midiToFrequency(candidate.pitchMidi)
                };
            })
            .filter((note) => note.duration >= settings.minDuration16th)
            .sort((a, b) => a.start - b.start || b.pitch - a.pitch);

        converted = mergeNearNotes(converted);
        converted = trimSamePitchOverlaps(converted);
        converted = removeWeakTransientNotes(converted, settings);
        converted = pruneRapidRetriggers(converted, settings);
        converted = alignChordOnsets(converted);
        converted = stabilizeChordDurations(converted);
        converted = filterAdjacentSemitoneGhosts(converted);
        converted = suppressOctaveGhostsGlobal(converted);
        converted = collapseChordBuckets(converted, settings.maxPolyphony);
        converted = enforcePolyphony(converted, settings.maxPolyphony);

        if (settings.quantize) {
            converted = converted
                .map((note) => {
                    const quantizedStart = Math.max(0, quantizeToGrid(note.start, settings.quantizeStep16th));
                    const quantizedDuration = Math.max(settings.minDuration16th, quantizeToGrid(note.duration, settings.quantizeStep16th));
                    return {
                        ...note,
                        start: quantizedStart,
                        duration: quantizedDuration
                    };
                })
                .sort((a, b) => a.start - b.start || b.pitch - a.pitch);
        }

        return mergeNearNotes(converted);
    }

    async scanAudioBuffer(
        buffer: AudioBuffer,
        bpm: number,
        settings: Partial<NoteScanSettings> = {},
        onProgress?: (progress: NoteScanProgress) => void,
        signal?: AbortSignal
    ): Promise<NoteScanResult> {
        if (!buffer || buffer.length === 0) {
            throw new Error('Audio buffer invalido para escaneo de notas.');
        }

        const scanStartedAt = Date.now();
        const normalizedSettings = this.normalizeSettings(settings);
        const onsetThreshold = clamp(0.64 - (normalizedSettings.sensitivity * 0.22), 0.36, 0.62);
        const frameThreshold = clamp(0.52 - (normalizedSettings.sensitivity * 0.2), 0.26, 0.5);
        const minNoteLenFrames = normalizedSettings.mode === 'polyphonic' ? 10 : 7;
        const energyTolerance = normalizedSettings.mode === 'polyphonic' ? 8 : 6;
        const minFrequency = midiToFrequency(normalizedSettings.minMidi);
        const maxFrequency = midiToFrequency(normalizedSettings.maxMidi);

        onProgress?.({ stage: 'preparing', progress: 0.02, message: 'Inicializando scanner polifonico HQ...' });
        this.assertNotAborted(signal);

        let model = await this.ensureModel();
        if (!model || !this.basicPitchTools) {
            throw new Error('No se pudo inicializar el motor Basic Pitch.');
        }

        onProgress?.({ stage: 'preparing', progress: 0.05, message: `Motor neural listo (${this.currentBackendLabel()}).` });

        const mono = toMono(buffer);
        const monoForModel = resampleLinear(mono, buffer.sampleRate, MODEL_SAMPLE_RATE);

        this.assertNotAborted(signal);
        onProgress?.({
            stage: 'preparing',
            progress: 0.09,
            message: `Audio preparado (${buffer.duration.toFixed(1)}s) para escaneo completo.`
        });

        const chunkSizeSamples = Math.max(Math.floor(MODEL_SAMPLE_RATE * 6), Math.floor(MODEL_SAMPLE_RATE * CHUNK_SECONDS));
        const overlapSamples = Math.min(Math.floor(MODEL_SAMPLE_RATE * CHUNK_OVERLAP_SECONDS), Math.floor(chunkSizeSamples * 0.4));
        const stepSamples = Math.max(1, chunkSizeSamples - overlapSamples);
        const totalChunks = Math.max(1, Math.ceil(Math.max(1, monoForModel.length - overlapSamples) / stepSamples));
        const overlapTrimSeconds = (overlapSamples / MODEL_SAMPLE_RATE) * 0.55;

        const candidates: TimedCandidate[] = [];
        let analyzedFrames = 0;
        let processedChunks = 0;
        let fallbackToCpuUsed = false;

        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
            this.assertNotAborted(signal);

            const chunkStartSample = chunkIndex * stepSamples;
            if (chunkStartSample >= monoForModel.length) {
                break;
            }

            const chunkEndSample = Math.min(monoForModel.length, chunkStartSample + chunkSizeSamples);
            const chunk = monoForModel.slice(chunkStartSample, chunkEndSample);
            const chunkOffsetSeconds = chunkStartSample / MODEL_SAMPLE_RATE;

            let frames: number[][] = [];
            let onsets: number[][] = [];
            let contours: number[][] = [];

            const evaluateChunk = async (scannerModel: NonNullable<typeof this.basicPitch>) => {
                frames = [];
                onsets = [];
                contours = [];

                await scannerModel.evaluateModel(
                    chunk,
                    (predFrames, predOnsets, predContours) => {
                        if (predFrames.length > 0) frames.push(...predFrames);
                        if (predOnsets.length > 0) onsets.push(...predOnsets);
                        if (predContours.length > 0) contours.push(...predContours);
                    },
                    (percent) => {
                        this.assertNotAborted(signal);
                        const localProgress = Math.max(0.02, clamp(percent, 0, 1));
                        const globalProgress = (chunkIndex + localProgress) / totalChunks;
                        const elapsedSeconds = Math.max(0.001, (Date.now() - scanStartedAt) / 1000);
                        const etaSeconds = globalProgress > 0.02
                            ? (elapsedSeconds * (1 - globalProgress)) / globalProgress
                            : 0;

                        onProgress?.({
                            stage: 'analyzing',
                            progress: ANALYZE_PROGRESS_START + (globalProgress * ANALYZE_PROGRESS_SPAN),
                            message: `Analizando ${chunkIndex + 1}/${totalChunks} · ${this.currentBackendLabel()} · ETA ${formatDurationCompact(etaSeconds)} (${Math.round(globalProgress * 100)}%)`
                        });
                    }
                );
            };

            try {
                await evaluateChunk(model);
            } catch (chunkError) {
                this.assertNotAborted(signal);

                if (!this.isGpuShaderError(chunkError) || this.activeBackend === 'cpu') {
                    throw chunkError;
                }

                onProgress?.({
                    stage: 'analyzing',
                    progress: ANALYZE_PROGRESS_START + (((chunkIndex + 0.06) / totalChunks) * ANALYZE_PROGRESS_SPAN),
                    message: 'GPU incompatible detectada. Cambiando a modo CPU estable...'
                });

                this.resetModelCache();
                model = await this.ensureModel(true);
                if (!model) {
                    throw new Error('No se pudo reintentar el escaneo en modo CPU.');
                }

                fallbackToCpuUsed = true;
                await evaluateChunk(model);
            }

            analyzedFrames += frames.length;
            processedChunks += 1;

            const tools = this.basicPitchTools;
            if (!tools) {
                throw new Error('Herramientas de postproceso no disponibles en scanner.');
            }

            const chunkRms = computeRms(chunk);
            const energyNorm = clamp((chunkRms - 0.01) / 0.11, 0, 1);
            const adaptiveOnsetThreshold = clamp(
                onsetThreshold + (0.05 - (energyNorm * 0.08)),
                0.28,
                0.7
            );
            const adaptiveFrameThreshold = clamp(
                frameThreshold + (0.04 - (energyNorm * 0.06)),
                0.2,
                0.6
            );
            const adaptiveMinNoteLenFrames = Math.max(
                6,
                Math.round(minNoteLenFrames + (energyNorm < 0.22 ? 2 : energyNorm > 0.78 ? -1 : 0))
            );
            const adaptiveEnergyTolerance = energyTolerance + (energyNorm > 0.8 ? 1 : 0);
            const localStartTrim = chunkIndex === 0 ? 0 : overlapTrimSeconds;

            const decodeProfiles: Array<{
                onset: number;
                frame: number;
                minLen: number;
                energy: number;
                bendsTolerance: number;
                weight: number;
            }> = [
                    {
                        onset: adaptiveOnsetThreshold,
                        frame: adaptiveFrameThreshold,
                        minLen: adaptiveMinNoteLenFrames,
                        energy: adaptiveEnergyTolerance,
                        bendsTolerance: 6,
                        weight: 1
                    },
                    {
                        onset: clamp(adaptiveOnsetThreshold + 0.045, 0.32, 0.76),
                        frame: clamp(adaptiveFrameThreshold + 0.035, 0.24, 0.64),
                        minLen: adaptiveMinNoteLenFrames + 1,
                        energy: Math.max(3, adaptiveEnergyTolerance - 1),
                        bendsTolerance: 5,
                        weight: 0.88
                    }
                ];

            decodeProfiles.forEach((profile) => {
                const noteEvents = tools.outputToNotesPoly(
                    frames,
                    onsets,
                    profile.onset,
                    profile.frame,
                    profile.minLen,
                    true,
                    maxFrequency,
                    minFrequency,
                    true,
                    profile.energy
                );

                const noteEventsWithBends = tools.addPitchBendsToNoteEvents(contours, noteEvents, profile.bendsTolerance);
                const noteEventTimes = tools.noteFramesToTime(noteEventsWithBends);

                noteEventTimes.forEach((noteEvent) => {
                    if (noteEvent.startTimeSeconds < localStartTrim) return;

                    candidates.push({
                        pitchMidi: Math.round(noteEvent.pitchMidi),
                        startTimeSeconds: chunkOffsetSeconds + Math.max(0, noteEvent.startTimeSeconds),
                        durationSeconds: Math.max(0.02, noteEvent.durationSeconds),
                        amplitude: clamp(noteEvent.amplitude * profile.weight, 0, 1),
                        source: 'neural',
                        support: 1
                    });
                });
            });

            await yieldToMain();
        }

        this.assertNotAborted(signal);
        onProgress?.({ stage: 'postprocess', progress: 0.9, message: 'Fusionando pasadas neuronales...' });

        const refinedNeuralCandidates = dedupeCandidateEvents(candidates);
        let fusedCandidates = refinedNeuralCandidates;
        let physicalCandidates: TimedCandidate[] = [];
        let physicalNotesCount = 0;

        try {
            this.assertNotAborted(signal);
            onProgress?.({
                stage: 'postprocess',
                progress: 0.91,
                message: 'Validando fundamental/armonicos con detector fisico...'
            });

            const physicalNotes = await this.runPhysicalRefinementWorker(
                buffer,
                bpm,
                normalizedSettings,
                onProgress,
                signal
            );

            physicalNotesCount = physicalNotes.length;
            physicalCandidates = mapDetectedNotesToTimedCandidates(physicalNotes, bpm, 'physical', 0.96);
            fusedCandidates = fuseNeuralAndPhysicalCandidates(refinedNeuralCandidates, physicalCandidates);
        } catch (physicalError) {
            this.assertNotAborted(signal);

            const message = physicalError instanceof Error
                ? physicalError.message
                : 'Validacion fisica no disponible. Continuamos con motor neural.';

            onProgress?.({
                stage: 'postprocess',
                progress: 0.97,
                message
            });
        }

        const octaveShift = inferGlobalOctaveShift(refinedNeuralCandidates, physicalCandidates);
        if (octaveShift !== 0) {
            fusedCandidates = fusedCandidates.map((candidate) => ({
                ...candidate,
                pitchMidi: clamp(candidate.pitchMidi + octaveShift, normalizedSettings.minMidi, normalizedSettings.maxMidi)
            }));

            onProgress?.({
                stage: 'postprocess',
                progress: 0.985,
                message: 'Ajuste automatico de octava aplicado para alinear notas reales.'
            });
        }

        const precisionLockedCandidates = applyPrecisionLockCandidateFilter(fusedCandidates, normalizedSettings);
        const notes = this.convertToDetectedNotes(precisionLockedCandidates, bpm, normalizedSettings);
        const averageConfidence = notes.length > 0
            ? notes.reduce((sum, note) => sum + note.confidence, 0) / notes.length
            : 0;

        const scanElapsedMs = Date.now() - scanStartedAt;
        const backendUsed = this.currentBackendLabel().toLowerCase();
        const fallbackLabel = fallbackToCpuUsed ? ' · fallback CPU' : '';

        onProgress?.({
            stage: 'done',
            progress: 1,
            message: `Escaneo completado (${notes.length} notas) · ${this.currentBackendLabel()} + FISICO (${physicalNotesCount})${octaveShift !== 0 ? ' · OCTAVA AUTO' : ''} · ${formatDurationCompact(scanElapsedMs / 1000)}${fallbackLabel}`
        });

        return {
            notes,
            averageConfidence,
            durationSeconds: buffer.duration,
            analyzedFrames,
            settings: normalizedSettings,
            backendUsed,
            scanElapsedMs,
            processedChunks
        };
    }
}

export const noteScannerService = new NoteScannerService();
