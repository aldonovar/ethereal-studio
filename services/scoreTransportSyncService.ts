import { Note } from '../types';
import { TransportClockSnapshot } from './transportClockStore';

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export interface ScoreTransportFrame {
    playhead16th: number;
    playheadBarTime: number;
    globalPlayhead16th: number;
    activeNoteIndexes: number[];
    isWithinClip: boolean;
    audiblePitchShiftSemitones: number;
}

export interface ScoreClipTransportContext {
    sourceKind: 'audio' | 'midi';
    clipStartBar: number;
    clipLengthBars: number;
    clipOffsetBars: number;
    playbackRate?: number;
    sourceOriginalBpm?: number;
    noteGridBpm?: number;
    projectBpm?: number;
    isWarped?: boolean;
    clipTransposeSemitones?: number;
    trackTransposeSemitones?: number;
    masterTransposeSemitones?: number;
}

export interface ScoreClipTransportTransform {
    clipStart16th: number;
    clipEnd16th: number;
    clipOffset16th: number;
    sourceGridRate: number;
    audiblePitchShiftSemitones: number;
}

const finiteOr = (value: number | undefined, fallback: number): number => (
    Number.isFinite(value) ? Number(value) : fallback
);
const ARRANGE_BAR_16THS = 16;

export const getMeasure16thsForScore = (timeSignature: [number, number]): number => {
    const numerator = Math.max(1, Math.round(timeSignature[0] || 4));
    const denominator = Math.max(1, Math.round(timeSignature[1] || 4));
    return Math.max(1, numerator * (16 / denominator));
};

export const transportClockToBarTime = (
    snapshot: Pick<TransportClockSnapshot, 'currentBar' | 'currentBeat' | 'currentSixteenth'>
): number => {
    const currentBar = Math.max(1, Math.floor(snapshot.currentBar || 1));
    const currentBeat = Math.max(1, Math.min(4, Math.floor(snapshot.currentBeat || 1)));
    const currentSixteenth = Math.max(1, Math.min(4, Math.floor(snapshot.currentSixteenth || 1)));

    return currentBar + ((currentBeat - 1) / 4) + ((currentSixteenth - 1) / 16);
};

export const barTimeToTimeline16th = (barTime: number, timeSignature: [number, number]): number => {
    const safeBarTime = Math.max(1, Number.isFinite(barTime) ? barTime : 1);
    const wholeBars = Math.floor(safeBarTime) - 1;
    const barFraction = safeBarTime - Math.floor(safeBarTime);
    const measure16ths = getMeasure16thsForScore(timeSignature);

    return Math.max(0, (wholeBars * measure16ths) + (barFraction * measure16ths));
};

export const timeline16thToBarTime = (timeline16th: number, timeSignature: [number, number]): number => {
    const measure16ths = getMeasure16thsForScore(timeSignature);
    const clamped16th = Math.max(0, timeline16th);
    const barIndex = Math.floor(clamped16th / measure16ths);
    const offsetInBar = clamped16th - (barIndex * measure16ths);

    return 1 + barIndex + (offsetInBar / measure16ths);
};

export const getScoreClipTransportTransform = (
    context: ScoreClipTransportContext
): ScoreClipTransportTransform => {
    const safeStartBar = Math.max(1, finiteOr(context.clipStartBar, 1));
    const safeLengthBars = Math.max(1 / 64, finiteOr(context.clipLengthBars, 1));
    const safeOffsetBars = Math.max(0, finiteOr(context.clipOffsetBars, 0));
    // Arrange/audioEngine defines every clip bar as four quarter notes, even if
    // the notation view uses another time signature.
    const clipStart16th = (safeStartBar - 1) * ARRANGE_BAR_16THS;
    const clipEnd16th = clipStart16th + (safeLengthBars * ARRANGE_BAR_16THS);
    const clipOffset16th = safeOffsetBars * ARRANGE_BAR_16THS;

    const clipTranspose = clamp(Math.round(finiteOr(context.clipTransposeSemitones, 0)), -24, 24);
    const trackTranspose = finiteOr(context.trackTransposeSemitones, 0);
    const masterTranspose = finiteOr(context.masterTransposeSemitones, 0);
    const totalTransposeSemitones = clipTranspose + trackTranspose + masterTranspose;

    if (context.sourceKind === 'midi') {
        return {
            clipStart16th,
            clipEnd16th,
            clipOffset16th,
            sourceGridRate: 1,
            audiblePitchShiftSemitones: totalTransposeSemitones
        };
    }

    const playbackRate = clamp(finiteOr(context.playbackRate, 1), 0.25, 4);
    const projectBpm = Math.max(1, finiteOr(context.projectBpm, 120));
    const sourceOriginalBpm = Math.max(1, finiteOr(context.sourceOriginalBpm, projectBpm));
    const noteGridBpm = Math.max(1, finiteOr(context.noteGridBpm, sourceOriginalBpm));
    const transposeRate = context.isWarped ? 1 : Math.pow(2, totalTransposeSemitones / 12);
    const effectiveSourceRate = (projectBpm / sourceOriginalBpm) * playbackRate * transposeRate;

    // audioEngine consumes source seconds at:
    // (projectBpm / sourceOriginalBpm) * playbackRate * transposeRate.
    // Convert that rate into the note grid used by the transcription result.
    const sourceGridRate = Math.max(0.0001, effectiveSourceRate * (noteGridBpm / projectBpm));
    const audiblePitchShiftSemitones = context.isWarped
        ? totalTransposeSemitones
        : 12 * Math.log2(Math.max(0.0001, effectiveSourceRate));

    return {
        clipStart16th,
        clipEnd16th,
        clipOffset16th,
        sourceGridRate,
        audiblePitchShiftSemitones
    };
};

export const globalTimeline16thToScoreSource16th = (
    globalTimeline16th: number,
    context: ScoreClipTransportContext
): number => {
    const transform = getScoreClipTransportTransform(context);
    const clipLocal16th = globalTimeline16th - transform.clipStart16th;
    return (clipLocal16th + transform.clipOffset16th) * transform.sourceGridRate;
};

export const scoreSource16thToGlobalTimeline16th = (
    sourceTimeline16th: number,
    context: ScoreClipTransportContext
): number => {
    const transform = getScoreClipTransportTransform(context);
    const unclamped = transform.clipStart16th
        + (Math.max(0, sourceTimeline16th) / transform.sourceGridRate)
        - transform.clipOffset16th;
    return clamp(unclamped, transform.clipStart16th, transform.clipEnd16th);
};

export const buildScoreTransportFrame = (
    notes: Note[],
    clockSnapshot: TransportClockSnapshot,
    timeSignature: [number, number],
    bpm = 120,
    renderNow = Date.now(),
    clipContext?: ScoreClipTransportContext
): ScoreTransportFrame => {
    const transportGridTimeSignature: [number, number] = clipContext ? [4, 4] : timeSignature;
    const playheadBarTime = transportClockToBarTime(clockSnapshot);
    const basePlayhead16th = barTimeToTimeline16th(playheadBarTime, transportGridTimeSignature);
    const msPer16th = Math.max(1, 60000 / Math.max(1, bpm) / 4);
    const elapsed16ths = clockSnapshot.isPlaying && clockSnapshot.updatedAt > 0
        ? Math.max(0, renderNow - clockSnapshot.updatedAt) / msPer16th
        : 0;
    const globalPlayhead16th = basePlayhead16th + elapsed16ths;
    const transform = clipContext
        ? getScoreClipTransportTransform(clipContext)
        : null;
    const playhead16th = clipContext
        ? globalTimeline16thToScoreSource16th(globalPlayhead16th, clipContext)
        : globalPlayhead16th;
    const isWithinClip = transform
        ? globalPlayhead16th >= transform.clipStart16th && globalPlayhead16th < transform.clipEnd16th
        : true;
    const activeNoteIndexes = notes.reduce<number[]>((indexes, note, index) => {
        const noteStart = note.start;
        const noteEnd = note.start + note.duration;
        if (isWithinClip && playhead16th >= noteStart && playhead16th < noteEnd) {
            indexes.push(index);
        }
        return indexes;
    }, []);

    return {
        playhead16th,
        playheadBarTime,
        globalPlayhead16th,
        activeNoteIndexes,
        isWithinClip,
        audiblePitchShiftSemitones: transform?.audiblePitchShiftSemitones ?? 0
    };
};

export const clampTimelineToSong = (timeline16th: number, total16ths: number): number => {
    return clamp(timeline16th, 0, Math.max(0, total16ths));
};
