export interface PitchLike {
    pitch: number;
}

export interface SynthesiaPitchViewport {
    minPitch: number;
    maxPitch: number;
    noteCount: number;
    label: string;
}

const PIANO_MIN_MIDI = 21;
const PIANO_MAX_MIDI = 108;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export const normalizePianoPitch = (midi: number): number | null => {
    if (!Number.isFinite(midi)) return null;
    return clamp(Math.round(midi), PIANO_MIN_MIDI, PIANO_MAX_MIDI);
};

export const midiNoteLabel = (midi: number): string => {
    const safe = clamp(Math.round(midi), 0, 127);
    return `${NOTE_NAMES[safe % 12]}${Math.floor(safe / 12) - 1}`;
};

/**
 * Frames the actual song register instead of compressing every transcription into
 * all 88 keys. A three-octave minimum keeps spatial context while making ordinary
 * melodies and chords large enough to read and correct.
 */
export const buildSynthesiaPitchViewport = (notes: readonly PitchLike[]): SynthesiaPitchViewport => {
    const pitches = notes
        .map((note) => normalizePianoPitch(note.pitch))
        .filter((pitch): pitch is number => pitch !== null);

    if (pitches.length === 0) {
        return {
            minPitch: PIANO_MIN_MIDI,
            maxPitch: PIANO_MAX_MIDI,
            noteCount: 0,
            label: `${midiNoteLabel(PIANO_MIN_MIDI)}–${midiNoteLabel(PIANO_MAX_MIDI)}`
        };
    }

    const detectedMin = Math.min(...pitches);
    const detectedMax = Math.max(...pitches);
    const detectedSpan = detectedMax - detectedMin;
    const viewportSpan = detectedSpan > 60
        ? detectedSpan
        : clamp(detectedSpan + 10, 36, 60);
    const centre = (detectedMin + detectedMax) * 0.5;

    let minPitch = Math.floor(centre - (viewportSpan * 0.5));
    let maxPitch = minPitch + viewportSpan;

    if (minPitch < PIANO_MIN_MIDI) {
        maxPitch += PIANO_MIN_MIDI - minPitch;
        minPitch = PIANO_MIN_MIDI;
    }
    if (maxPitch > PIANO_MAX_MIDI) {
        minPitch -= maxPitch - PIANO_MAX_MIDI;
        maxPitch = PIANO_MAX_MIDI;
    }

    minPitch = clamp(minPitch, PIANO_MIN_MIDI, PIANO_MAX_MIDI);
    maxPitch = clamp(maxPitch, minPitch, PIANO_MAX_MIDI);

    return {
        minPitch,
        maxPitch,
        noteCount: pitches.length,
        label: `${midiNoteLabel(minPitch)}–${midiNoteLabel(maxPitch)}`
    };
};
