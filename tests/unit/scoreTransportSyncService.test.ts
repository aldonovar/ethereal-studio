import { describe, expect, it } from 'vitest';
import type { Note } from '../../types';
import {
    buildScoreTransportFrame,
    getScoreClipTransportTransform,
    globalTimeline16thToScoreSource16th,
    scoreSource16thToGlobalTimeline16th,
    timeline16thToBarTime,
    type ScoreClipTransportContext
} from '../../services/scoreTransportSyncService';
import type { TransportClockSnapshot } from '../../services/transportClockStore';

const clockAt = (
    currentBar: number,
    currentBeat = 1,
    currentSixteenth = 1
): TransportClockSnapshot => ({
    currentBar,
    currentBeat,
    currentSixteenth,
    isPlaying: false,
    updatedAt: 0
});

const audioContext = (
    patch: Partial<ScoreClipTransportContext> = {}
): ScoreClipTransportContext => ({
    sourceKind: 'audio',
    clipStartBar: 1,
    clipLengthBars: 4,
    clipOffsetBars: 0,
    playbackRate: 1,
    sourceOriginalBpm: 120,
    noteGridBpm: 120,
    projectBpm: 120,
    isWarped: true,
    clipTransposeSemitones: 0,
    trackTransposeSemitones: 0,
    masterTransposeSemitones: 0,
    ...patch
});

describe('scoreTransportSyncService Arrange clip mapping', () => {
    it('preserves notation time-signature conversion outside Arrange clip context', () => {
        expect(timeline16thToBarTime(12, [3, 4])).toBe(2);
        expect(timeline16thToBarTime(16, [4, 4])).toBe(2);
    });

    it('maps clip start, offset and playbackRate into source-note time and seeks back exactly', () => {
        const context = audioContext({
            clipStartBar: 3,
            clipLengthBars: 2,
            clipOffsetBars: 0.5,
            playbackRate: 1.5
        });

        expect(globalTimeline16thToScoreSource16th(32, context)).toBeCloseTo(12, 8);
        expect(globalTimeline16thToScoreSource16th(40, context)).toBeCloseTo(24, 8);
        expect(scoreSource16thToGlobalTimeline16th(12, context)).toBeCloseTo(32, 8);
        expect(scoreSource16thToGlobalTimeline16th(24, context)).toBeCloseTo(40, 8);
        expect(scoreSource16thToGlobalTimeline16th(1_000, context)).toBe(64);
    });

    it('uses transpose in native timing but keeps warped timing independent from pitch', () => {
        const native = getScoreClipTransportTransform(audioContext({
            isWarped: false,
            clipTransposeSemitones: 12
        }));
        const warped = getScoreClipTransportTransform(audioContext({
            isWarped: true,
            clipTransposeSemitones: 12
        }));

        expect(native.sourceGridRate).toBeCloseTo(2, 8);
        expect(native.audiblePitchShiftSemitones).toBeCloseTo(12, 8);
        expect(warped.sourceGridRate).toBeCloseTo(1, 8);
        expect(warped.audiblePitchShiftSemitones).toBeCloseTo(12, 8);
    });

    it('matches the engine BPM ratio in the grid used by a fresh transcription', () => {
        const context = audioContext({
            projectBpm: 60,
            sourceOriginalBpm: 120,
            noteGridBpm: 60,
            playbackRate: 1,
            isWarped: true
        });

        expect(getScoreClipTransportTransform(context).sourceGridRate).toBeCloseTo(0.5, 8);
        expect(globalTimeline16thToScoreSource16th(8, context)).toBeCloseTo(4, 8);
    });

    it('never lights notes outside the clip window and uses half-open note ends', () => {
        const notes: Note[] = [{ pitch: 60, start: 8, duration: 4, velocity: 100 }];
        const context = audioContext({ clipStartBar: 3, clipLengthBars: 1, clipOffsetBars: 0.5 });

        const before = buildScoreTransportFrame(notes, clockAt(2), [3, 4], 120, 0, context);
        const atStart = buildScoreTransportFrame(notes, clockAt(3), [3, 4], 120, 0, context);
        const after = buildScoreTransportFrame(notes, clockAt(4), [3, 4], 120, 0, context);
        const atNoteEnd = buildScoreTransportFrame(
            notes,
            clockAt(3, 2, 1),
            [3, 4],
            120,
            0,
            context
        );

        expect(before.globalPlayhead16th).toBe(16);
        expect(before.activeNoteIndexes).toEqual([]);
        expect(atStart.globalPlayhead16th).toBe(32);
        expect(atStart.playhead16th).toBe(8);
        expect(atStart.activeNoteIndexes).toEqual([0]);
        expect(atNoteEnd.playhead16th).toBe(12);
        expect(atNoteEnd.activeNoteIndexes).toEqual([]);
        expect(after.globalPlayhead16th).toBe(48);
        expect(after.activeNoteIndexes).toEqual([]);
    });
});
