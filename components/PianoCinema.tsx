import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Note } from '../types';
import { buildScoreNoteKey, normalizeMidiVelocity } from '../services/pianoScoreConversionService';
import { midiNoteLabel } from '../services/synthesiaLayoutService';

interface PianoCinemaProps {
    notes: Note[];
    playhead16th: number;
    bpm: number;
    isPlaying: boolean;
    total16ths: number;
    selectedNoteKey: string | null;
    activeNoteIndexes: number[];
    livePitches: number[];
    sustainActive: boolean;
    zoom?: number;
    emptyTitle?: string;
    emptyMessage?: string;
    onSelectNoteKey?: (noteKey: string | null) => void;
    onSeekToTimeline16th?: (timeline16th: number) => void;
    onUpdateNote?: (noteIndex: number, nextNote: Note) => void;
}

interface PianoLaneNote extends Note {
    index: number;
    noteKey: string;
}

type DragMode = 'move' | 'trim-duration';

interface DragState {
    noteIndex: number;
    mode: DragMode;
    originPointerY: number;
    originStart: number;
    originDuration: number;
    originPitch: number;
}

const PIANO_MIN_MIDI = 21;
const PIANO_MAX_MIDI = 108;
const WHITE_KEY_SET = new Set([0, 2, 4, 5, 7, 9, 11]);
const BLACK_KEY_SET = new Set([1, 3, 6, 8, 10]);
const MAX_RIBBON_MARKERS = 48;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const isBlackKey = (pitch: number): boolean => BLACK_KEY_SET.has(((pitch % 12) + 12) % 12);

const buildKeyboardLayout = (minPitch: number, maxPitch: number) => {
    const layoutMinPitch = isBlackKey(minPitch) ? Math.max(PIANO_MIN_MIDI, minPitch - 1) : minPitch;
    const layoutMaxPitch = isBlackKey(maxPitch) ? Math.min(PIANO_MAX_MIDI, maxPitch + 1) : maxPitch;
    const keyFrames = new Map<number, { x: number; width: number; center: number; black: boolean }>();
    const whiteKeys: Array<{ pitch: number; x: number; width: number }> = [];
    const blackKeys: Array<{ pitch: number; x: number; width: number }> = [];
    const whiteKeyWidth = 28;
    const blackKeyWidth = 18;
    let whiteIndex = 0;

    for (let pitch = layoutMinPitch; pitch <= layoutMaxPitch; pitch += 1) {
        if (WHITE_KEY_SET.has(pitch % 12)) {
            const x = whiteIndex * whiteKeyWidth;
            whiteKeys.push({ pitch, x, width: whiteKeyWidth });
            keyFrames.set(pitch, {
                x,
                width: whiteKeyWidth,
                center: x + (whiteKeyWidth / 2),
                black: false
            });
            whiteIndex += 1;
        }
    }

    for (let pitch = layoutMinPitch; pitch <= layoutMaxPitch; pitch += 1) {
        if (!isBlackKey(pitch)) continue;
        const previousWhite = pitch - 1;
        const frame = keyFrames.get(previousWhite);
        if (!frame) continue;
        const x = frame.x + (frame.width * 0.68);
        blackKeys.push({ pitch, x, width: blackKeyWidth });
        keyFrames.set(pitch, {
            x,
            width: blackKeyWidth,
            center: x + (blackKeyWidth / 2),
            black: true
        });
    }

    return {
        width: whiteKeys.length * whiteKeyWidth,
        whiteKeys,
        blackKeys,
        keyFrames
    };
};

const findNearestPitch = (x: number, keyFrames: Map<number, { center: number }>): number => {
    let closestPitch = 60;
    let closestDistance = Number.POSITIVE_INFINITY;

    keyFrames.forEach((frame, pitch) => {
        const distance = Math.abs(frame.center - x);
        if (distance < closestDistance) {
            closestDistance = distance;
            closestPitch = pitch;
        }
    });

    return closestPitch;
};

const PianoCinema: React.FC<PianoCinemaProps> = ({
    notes,
    playhead16th,
    bpm,
    isPlaying,
    total16ths,
    selectedNoteKey,
    activeNoteIndexes,
    livePitches,
    sustainActive,
    zoom = 1,
    emptyTitle = 'Sin material en Piano Cinema',
    emptyMessage = 'Cuando haya notas, el editor inferior seguira el transporte en tiempo real.',
    onSelectNoteKey,
    onSeekToTimeline16th,
    onUpdateNote
}) => {
    const pitchRange = useMemo(() => {
        const allPitches = [...notes.map((note) => note.pitch), ...livePitches];
        if (allPitches.length === 0) {
            return { min: 36, max: 84 };
        }

        let min = clamp(Math.min(...allPitches) - 3, PIANO_MIN_MIDI, PIANO_MAX_MIDI);
        let max = clamp(Math.max(...allPitches) + 4, PIANO_MIN_MIDI, PIANO_MAX_MIDI);
        const minimumSpan = 28;

        if ((max - min) < minimumSpan) {
            const center = (min + max) / 2;
            min = clamp(Math.floor(center - (minimumSpan / 2)), PIANO_MIN_MIDI, PIANO_MAX_MIDI - minimumSpan);
            max = clamp(min + minimumSpan, PIANO_MIN_MIDI + minimumSpan, PIANO_MAX_MIDI);
        }

        return { min, max };
    }, [livePitches, notes]);

    const keyboard = useMemo(() => buildKeyboardLayout(pitchRange.min, pitchRange.max), [pitchRange.max, pitchRange.min]);
    const idPrefix = useId().replace(/:/g, '');
    const svgRef = useRef<SVGSVGElement>(null);
    const motionLayerRef = useRef<SVGGElement>(null);
    const ribbonPlayheadRef = useRef<SVGLineElement>(null);
    const [dragState, setDragState] = useState<DragState | null>(null);

    const laneNotes = useMemo<PianoLaneNote[]>(() => {
        return [...notes]
            .map((note, index) => ({
                ...note,
                index,
                noteKey: buildScoreNoteKey(note, index)
            }))
            .sort((left, right) => left.start - right.start || left.pitch - right.pitch);
    }, [notes]);

    const selectedNote = useMemo(() => {
        return laneNotes.find((note) => note.noteKey === selectedNoteKey) || null;
    }, [laneNotes, selectedNoteKey]);

    const activeIndexSet = useMemo(() => new Set(activeNoteIndexes), [activeNoteIndexes]);
    const livePitchSet = useMemo(() => new Set(livePitches), [livePitches]);
    const activePitchSet = useMemo(() => {
        const pitches = new Set(livePitches);
        laneNotes.forEach((note) => {
            if (activeIndexSet.has(note.index)) pitches.add(note.pitch);
        });
        return pitches;
    }, [activeIndexSet, laneNotes, livePitches]);
    const pixelsPer16th = 16 * zoom;
    const lookAhead16ths = 56;
    const lookBehind16ths = 8;
    const headerHeight = 36;
    const mainHeight = 500;
    const keyboardHeight = 72;
    const noteViewportHeight = mainHeight - keyboardHeight;
    const keyboardTop = noteViewportHeight + 18;
    const totalBars = Math.max(1, Math.ceil(total16ths / 16));
    const ribbonMarkerStep = Math.max(1, Math.ceil(totalBars / MAX_RIBBON_MARKERS));
    const ribbonMarkers = useMemo(() => {
        const markers: number[] = [];
        for (let bar = 0; bar < totalBars; bar += ribbonMarkerStep) markers.push(bar);
        return markers;
    }, [ribbonMarkerStep, totalBars]);
    const musicalBar = Math.max(1, Math.floor(playhead16th / 16) + 1);
    const musicalBeat = Math.max(1, Math.floor((playhead16th % 16) / 4) + 1);
    const stageTitleId = `${idPrefix}-piano-cinema-title`;
    const stageDescriptionId = `${idPrefix}-piano-cinema-description`;

    useEffect(() => {
        const msPer16th = Math.max(1, 60000 / Math.max(1, bpm) / 4);
        const startedAt = performance.now();
        const basePlayhead16th = playhead16th;
        let frameId = 0;

        const paint = () => {
            const elapsed16ths = isPlaying ? (performance.now() - startedAt) / msPer16th : 0;
            const current16th = basePlayhead16th + elapsed16ths;
            const clamped16th = clamp(current16th, 0, Math.max(16, total16ths));

            if (motionLayerRef.current) {
                motionLayerRef.current.setAttribute('transform', `translate(0 ${clamped16th * pixelsPer16th})`);
            }

            const ribbonX = (clamped16th / Math.max(16, total16ths)) * keyboard.width;
            ribbonPlayheadRef.current?.setAttribute('x1', String(ribbonX));
            ribbonPlayheadRef.current?.setAttribute('x2', String(ribbonX));

            if (isPlaying) {
                frameId = window.requestAnimationFrame(paint);
            }
        };

        paint();
        return () => window.cancelAnimationFrame(frameId);
    }, [bpm, isPlaying, keyboard.width, pixelsPer16th, playhead16th, total16ths]);

    useEffect(() => {
        if (!dragState) return;

        const handlePointerMove = (event: PointerEvent) => {
            if (!svgRef.current || !dragState) return;
            const rect = svgRef.current.getBoundingClientRect();
            const viewScaleY = mainHeight / rect.height;
            const viewScaleX = keyboard.width / rect.width;
            const pointerY = (event.clientY - rect.top) * viewScaleY;
            const pointerX = (event.clientX - rect.left) * viewScaleX;
            const targetPitch = clamp(findNearestPitch(pointerX, keyboard.keyFrames), PIANO_MIN_MIDI, PIANO_MAX_MIDI);
            const delta16th = (dragState.originPointerY - pointerY) / pixelsPer16th;
            const targetStart = clamp(dragState.originStart - delta16th, 0, Math.max(0, total16ths));

            if (dragState.mode === 'move') {
                onUpdateNote?.(dragState.noteIndex, {
                    pitch: targetPitch,
                    start: Math.round(targetStart * 4) / 4,
                    duration: dragState.originDuration,
                    velocity: normalizeMidiVelocity(notes[dragState.noteIndex]?.velocity ?? 96)
                });
                return;
            }

            const targetDuration = clamp(((keyboardTop - pointerY) / pixelsPer16th), 0.25, 64);
            onUpdateNote?.(dragState.noteIndex, {
                pitch: dragState.originPitch,
                start: dragState.originStart,
                duration: Math.round(targetDuration * 4) / 4,
                velocity: normalizeMidiVelocity(notes[dragState.noteIndex]?.velocity ?? 96)
            });
        };

        const handlePointerUp = () => {
            setDragState(null);
        };

        window.addEventListener('pointermove', handlePointerMove);
        window.addEventListener('pointerup', handlePointerUp);
        return () => {
            window.removeEventListener('pointermove', handlePointerMove);
            window.removeEventListener('pointerup', handlePointerUp);
        };
    }, [dragState, keyboard.keyFrames, keyboard.width, keyboardTop, mainHeight, notes, onUpdateNote, pixelsPer16th, total16ths]);

    const handleSeekRibbonClick = (event: React.MouseEvent<SVGSVGElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
        onSeekToTimeline16th?.(ratio * Math.max(16, total16ths));
    };

    const handleSeekRibbonKeyDown = (event: React.KeyboardEvent<SVGSVGElement>) => {
        let nextPlayhead: number | null = null;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') nextPlayhead = playhead16th - 1;
        if (event.key === 'ArrowRight' || event.key === 'ArrowUp') nextPlayhead = playhead16th + 1;
        if (event.key === 'PageDown') nextPlayhead = playhead16th - 16;
        if (event.key === 'PageUp') nextPlayhead = playhead16th + 16;
        if (event.key === 'Home') nextPlayhead = 0;
        if (event.key === 'End') nextPlayhead = Math.max(16, total16ths);
        if (nextPlayhead === null) return;
        event.preventDefault();
        onSeekToTimeline16th?.(clamp(nextPlayhead, 0, Math.max(16, total16ths)));
    };

    return (
        <div
            data-piano-cinema="workstation"
            className="flex h-full w-full flex-col overflow-hidden rounded-sm border border-[#2b2e33] bg-[#111214]"
        >
            <div className="flex h-10 shrink-0 items-center justify-between border-b border-[#303238] bg-[#1b1d21] px-3">
                <div className="flex min-w-0 items-center gap-3">
                    <span className="h-4 w-1 rounded-[1px] bg-cyan-300/75" aria-hidden="true" />
                    <div className="min-w-0">
                        <div className="truncate text-[10px] font-bold uppercase tracking-[0.18em] text-[#d5d8dd]">Falling Notes</div>
                        <div className="mt-0.5 truncate text-[8px] font-medium uppercase tracking-[0.14em] text-[#777c84]">Piano editor</div>
                    </div>
                </div>

                <div className="flex items-center gap-1.5 text-[8px] font-semibold uppercase tracking-[0.12em]">
                    <span className="hidden rounded-sm border border-[#33363c] bg-[#15171a] px-2 py-1 text-[#9499a1] sm:inline-flex">
                        {bpm.toFixed(0)} BPM
                    </span>
                    <span className="rounded-sm border border-[#33363c] bg-[#15171a] px-2 py-1 text-[#9499a1]">
                        {laneNotes.length} notas
                    </span>
                    <span className={`rounded-sm border px-2 py-1 ${sustainActive ? 'border-cyan-300/35 bg-cyan-300/[0.08] text-cyan-100/85' : 'border-[#33363c] bg-[#15171a] text-[#686d74]'}`}>
                        Sustain {sustainActive ? 'On' : 'Off'}
                    </span>
                    {livePitches.length > 0 && (
                        <span className="inline-flex items-center gap-1.5 rounded-sm border border-cyan-300/35 bg-cyan-300/[0.08] px-2 py-1 text-cyan-100/85">
                            <span className="h-1.5 w-1.5 rounded-full bg-cyan-300" aria-hidden="true" />
                            Live {livePitches.length}
                        </span>
                    )}
                </div>
            </div>

            <div className="shrink-0 border-b border-[#292c31] bg-[#15171a] p-2">
                <svg
                    data-piano-cinema-ribbon="true"
                    className="h-9 w-full cursor-pointer rounded-[2px] outline-none ring-cyan-300/40 transition-shadow focus-visible:ring-1 motion-reduce:transition-none"
                    viewBox={`0 0 ${keyboard.width} ${headerHeight}`}
                    preserveAspectRatio="none"
                    onClick={handleSeekRibbonClick}
                    onKeyDown={handleSeekRibbonKeyDown}
                    role="slider"
                    tabIndex={0}
                    aria-label="Posición del transporte de Falling Notes"
                    aria-valuemin={0}
                    aria-valuemax={Math.max(16, total16ths)}
                    aria-valuenow={clamp(playhead16th, 0, Math.max(16, total16ths))}
                    aria-valuetext={`Compás ${musicalBar}, pulso ${musicalBeat}`}
                >
                    <defs>
                        <linearGradient id={`${idPrefix}-ribbon-bg`} x1="0%" y1="0%" x2="0%" y2="100%">
                            <stop offset="0%" stopColor="#111316" />
                            <stop offset="100%" stopColor="#0c0e10" />
                        </linearGradient>
                    </defs>
                    <rect x={0} y={0} width={keyboard.width} height={headerHeight} rx={2} fill={`url(#${idPrefix}-ribbon-bg)`} />
                    <rect
                        x={0}
                        y={headerHeight - 3}
                        width={(clamp(playhead16th, 0, Math.max(16, total16ths)) / Math.max(16, total16ths)) * keyboard.width}
                        height={2}
                        fill="rgba(103,232,249,0.46)"
                    />
                    {ribbonMarkers.map((bar) => {
                        const x = (bar / totalBars) * keyboard.width;
                        return (
                            <g key={`seek-bar-${bar}`} data-piano-cinema-ribbon-marker={bar + 1}>
                                <line x1={x} y1={7} x2={x} y2={29} stroke="rgba(148,153,161,0.24)" strokeWidth={bar % 4 === 0 ? 1 : 0.65} />
                                <text x={x + 4} y={14} fill="rgba(174,178,185,0.62)" fontSize={8} fontWeight={600}>
                                    {bar + 1}
                                </text>
                            </g>
                        );
                    })}
                    <line
                        ref={ribbonPlayheadRef}
                        data-piano-cinema-playhead="true"
                        x1={(clamp(playhead16th, 0, Math.max(16, total16ths)) / Math.max(16, total16ths)) * keyboard.width}
                        y1={3}
                        x2={(clamp(playhead16th, 0, Math.max(16, total16ths)) / Math.max(16, total16ths)) * keyboard.width}
                        y2={33}
                        stroke="rgba(103,232,249,0.9)"
                        strokeWidth={2}
                    />
                </svg>
            </div>

            <div className="relative min-h-0 flex-1 overflow-hidden bg-[#0d0f11] p-2">
                <svg
                    ref={svgRef}
                    data-piano-cinema-stage="true"
                    data-piano-cinema-surface="workstation"
                    className="block h-full w-full rounded-[2px] bg-[#101214]"
                    viewBox={`0 0 ${keyboard.width} ${mainHeight}`}
                    preserveAspectRatio="none"
                    role="group"
                    aria-labelledby={`${stageTitleId} ${stageDescriptionId}`}
                >
                    <title id={stageTitleId}>Visualizador Falling Notes</title>
                    <desc id={stageDescriptionId}>Notas musicales descienden hacia un teclado sincronizado con el transporte. Las notas se pueden seleccionar, mover y redimensionar.</desc>
                    <defs>
                        <linearGradient id={`${idPrefix}-stage-bg`} x1="0%" y1="0%" x2="0%" y2="100%">
                            <stop offset="0%" stopColor="#15171a" />
                            <stop offset="100%" stopColor="#0e1012" />
                        </linearGradient>
                        <linearGradient id={`${idPrefix}-note-idle`} x1="0%" y1="0%" x2="0%" y2="100%">
                            <stop offset="0%" stopColor="#b2b7bf" />
                            <stop offset="100%" stopColor="#727983" />
                        </linearGradient>
                        <linearGradient id={`${idPrefix}-note-active`} x1="0%" y1="0%" x2="0%" y2="100%">
                            <stop offset="0%" stopColor="#d5f8fb" />
                            <stop offset="100%" stopColor="#55c6cf" />
                        </linearGradient>
                        <linearGradient id={`${idPrefix}-white-key`} x1="0%" y1="0%" x2="0%" y2="100%">
                            <stop offset="0%" stopColor="#e5e7e9" />
                            <stop offset="72%" stopColor="#c9cdd1" />
                            <stop offset="100%" stopColor="#aeb3b8" />
                        </linearGradient>
                        <linearGradient id={`${idPrefix}-white-key-active`} x1="0%" y1="0%" x2="0%" y2="100%">
                            <stop offset="0%" stopColor="#e7fafb" />
                            <stop offset="100%" stopColor="#78cbd1" />
                        </linearGradient>
                        <linearGradient id={`${idPrefix}-black-key`} x1="0%" y1="0%" x2="0%" y2="100%">
                            <stop offset="0%" stopColor="#34383e" />
                            <stop offset="100%" stopColor="#111316" />
                        </linearGradient>
                        <linearGradient id={`${idPrefix}-black-key-active`} x1="0%" y1="0%" x2="0%" y2="100%">
                            <stop offset="0%" stopColor="#9de4e8" />
                            <stop offset="100%" stopColor="#388f96" />
                        </linearGradient>
                        <linearGradient id={`${idPrefix}-key-reflection`} x1="0%" y1="100%" x2="0%" y2="0%">
                            <stop offset="0%" stopColor="rgba(103,232,249,0.13)" />
                            <stop offset="100%" stopColor="rgba(103,232,249,0)" />
                        </linearGradient>
                    </defs>

                    <rect x={0} y={0} width={keyboard.width} height={mainHeight} fill={`url(#${idPrefix}-stage-bg)`} />

                    <g data-piano-cinema-lane-grid="true" aria-hidden="true">
                        {keyboard.whiteKeys.map((key, index) => (
                            <React.Fragment key={`lane-${key.pitch}`}>
                                <rect
                                    x={key.x}
                                    y={0}
                                    width={key.width}
                                    height={keyboardTop}
                                    fill={index % 2 === 0 ? 'rgba(255,255,255,0.012)' : 'rgba(0,0,0,0.035)'}
                                />
                                <line
                                    x1={key.x}
                                    y1={0}
                                    x2={key.x}
                                    y2={keyboardTop}
                                    stroke="rgba(148,153,161,0.08)"
                                    strokeWidth={0.6}
                                />
                            </React.Fragment>
                        ))}
                    </g>

                    <g ref={motionLayerRef} style={{ willChange: 'transform' }}>
                        {Array.from({ length: Math.ceil((lookAhead16ths + lookBehind16ths) / 4) }, (_, index) => {
                            const timeline16th = playhead16th - lookBehind16ths + (index * 4);
                            const y = keyboardTop - (timeline16th * pixelsPer16th);
                            const isBar = index % 4 === 0;
                            return (
                                <line
                                    key={`grid-${index}`}
                                    x1={0}
                                    y1={y}
                                    x2={keyboard.width}
                                    y2={y}
                                    stroke={isBar ? 'rgba(187,191,198,0.18)' : 'rgba(148,153,161,0.09)'}
                                    strokeWidth={isBar ? 1 : 0.65}
                                    aria-hidden="true"
                                />
                            );
                        })}

                        {laneNotes.map((note) => {
                            const frame = keyboard.keyFrames.get(note.pitch);
                            if (!frame) return null;

                            const relativeNoteBottom = keyboardTop - ((note.start - playhead16th) * pixelsPer16th);
                            const noteHeight = Math.max(8, note.duration * pixelsPer16th);
                            const noteBottom = keyboardTop - (note.start * pixelsPer16th);
                            const noteTop = noteBottom - noteHeight;

                            if (relativeNoteBottom < -24 || (relativeNoteBottom - noteHeight) > noteViewportHeight + 48) {
                                return null;
                            }

                            const isSelected = note.noteKey === selectedNoteKey;
                            const isActive = activeIndexSet.has(note.index) || livePitchSet.has(note.pitch);
                            const velocity = normalizeMidiVelocity(note.velocity);
                            const noteWidth = frame.black ? frame.width + 4 : frame.width - 4;
                            const noteX = frame.black ? frame.x - 2 : frame.x + 2;

                            return (
                                <g key={note.noteKey} data-piano-cinema-note={midiNoteLabel(note.pitch)}>
                                    <rect
                                        x={noteX + 1.5}
                                        y={noteTop + 2}
                                        width={noteWidth}
                                        height={noteHeight}
                                        rx={2}
                                        fill="rgba(0,0,0,0.34)"
                                        pointerEvents="none"
                                    />
                                    <rect
                                        data-piano-cinema-note-body="true"
                                        x={noteX}
                                        y={noteTop}
                                        width={noteWidth}
                                        height={noteHeight}
                                        rx={2}
                                        fill={`url(#${idPrefix}-${isActive ? 'note-active' : 'note-idle'})`}
                                        opacity={isSelected || isActive ? 1 : 0.68 + ((velocity / 127) * 0.24)}
                                        stroke={isSelected ? '#67e8f9' : isActive ? 'rgba(207,250,254,0.8)' : 'rgba(17,19,22,0.82)'}
                                        strokeWidth={isSelected ? 1.6 : 0.8}
                                        className="cursor-pointer outline-none"
                                        role="button"
                                        tabIndex={isSelected || (!selectedNoteKey && note.index === laneNotes[0]?.index) ? 0 : -1}
                                        aria-label={`${midiNoteLabel(note.pitch)}, inicio ${note.start.toFixed(2)}, duración ${note.duration.toFixed(2)}, velocidad ${velocity}`}
                                        aria-pressed={isSelected}
                                        onKeyDown={(event) => {
                                            if (event.key !== 'Enter' && event.key !== ' ') return;
                                            event.preventDefault();
                                            onSelectNoteKey?.(note.noteKey);
                                        }}
                                        onPointerDown={(event) => {
                                            onSelectNoteKey?.(note.noteKey);
                                            setDragState({
                                                noteIndex: note.index,
                                                mode: 'move',
                                                originPointerY: ((event.clientY - event.currentTarget.getBoundingClientRect().top) + (event.currentTarget.getBoundingClientRect().top - svgRef.current!.getBoundingClientRect().top)) * (mainHeight / svgRef.current!.getBoundingClientRect().height),
                                                originStart: note.start,
                                                originDuration: note.duration,
                                                originPitch: note.pitch
                                            });
                                        }}
                                    />
                                    <rect
                                        x={noteX + 1}
                                        y={noteTop + 1}
                                        width={Math.max(1, (noteWidth - 2) * (velocity / 127))}
                                        height={2.5}
                                        rx={1}
                                        fill={isActive ? 'rgba(255,255,255,0.82)' : 'rgba(239,241,244,0.56)'}
                                        pointerEvents="none"
                                    />
                                    {noteHeight >= 24 && (
                                        <text
                                            x={noteX + (noteWidth / 2)}
                                            y={noteTop + 14}
                                            textAnchor="middle"
                                            fill={isActive ? 'rgba(16,42,45,0.86)' : 'rgba(24,27,31,0.82)'}
                                            fontSize={7}
                                            fontWeight={700}
                                            pointerEvents="none"
                                        >
                                            {midiNoteLabel(note.pitch)}
                                        </text>
                                    )}
                                    <rect
                                        x={noteX}
                                        y={noteTop}
                                        width={noteWidth}
                                        height={5}
                                        rx={2}
                                        fill="rgba(255,255,255,0.01)"
                                        className="cursor-ns-resize"
                                        aria-hidden="true"
                                        onPointerDown={(event) => {
                                            event.stopPropagation();
                                            onSelectNoteKey?.(note.noteKey);
                                            setDragState({
                                                noteIndex: note.index,
                                                mode: 'trim-duration',
                                                originPointerY: ((event.clientY - event.currentTarget.getBoundingClientRect().top) + (event.currentTarget.getBoundingClientRect().top - svgRef.current!.getBoundingClientRect().top)) * (mainHeight / svgRef.current!.getBoundingClientRect().height),
                                                originStart: note.start,
                                                originDuration: note.duration,
                                                originPitch: note.pitch
                                            });
                                        }}
                                    />
                                </g>
                            );
                        })}
                    </g>

                    <g aria-hidden="true">
                        {Array.from(activePitchSet).map((pitch) => {
                            const frame = keyboard.keyFrames.get(pitch);
                            if (!frame) return null;
                            return (
                                <rect
                                    key={`key-reflection-${pitch}`}
                                    data-piano-cinema-key-reflection={midiNoteLabel(pitch)}
                                    x={frame.x}
                                    y={keyboardTop - 22}
                                    width={frame.width}
                                    height={22}
                                    fill={`url(#${idPrefix}-key-reflection)`}
                                />
                            );
                        })}
                    </g>

                    <line x1={0} y1={keyboardTop} x2={keyboard.width} y2={keyboardTop} stroke="rgba(103,232,249,0.72)" strokeWidth={1.4} />
                    <rect x={0} y={keyboardTop + keyboardHeight - 3} width={keyboard.width} height={4} fill="rgba(0,0,0,0.48)" />

                    <g data-piano-cinema-keyboard="true">
                        {keyboard.whiteKeys.map((key) => {
                            const isLit = activePitchSet.has(key.pitch);
                            return (
                                <g key={`white-${key.pitch}`}>
                                    <rect
                                        data-piano-key={midiNoteLabel(key.pitch)}
                                        x={key.x}
                                        y={keyboardTop}
                                        width={key.width}
                                        height={keyboardHeight}
                                        rx={1}
                                        fill={`url(#${idPrefix}-${isLit ? 'white-key-active' : 'white-key'})`}
                                        stroke={isLit ? 'rgba(70,160,168,0.78)' : 'rgba(32,35,39,0.48)'}
                                        strokeWidth={isLit ? 1.1 : 0.75}
                                    />
                                    <line
                                        x1={key.x + 1.5}
                                        y1={keyboardTop + keyboardHeight - 7}
                                        x2={key.x + key.width - 1.5}
                                        y2={keyboardTop + keyboardHeight - 7}
                                        stroke="rgba(56,60,66,0.18)"
                                        strokeWidth={1}
                                    />
                                    {key.pitch % 12 === 0 && (
                                        <text
                                            x={key.x + (key.width / 2)}
                                            y={keyboardTop + keyboardHeight - 11}
                                            textAnchor="middle"
                                            fill="rgba(45,49,54,0.65)"
                                            fontSize={7}
                                            fontWeight={700}
                                            pointerEvents="none"
                                        >
                                            {midiNoteLabel(key.pitch)}
                                        </text>
                                    )}
                                </g>
                            );
                        })}

                        {keyboard.blackKeys.map((key) => {
                            const isLit = activePitchSet.has(key.pitch);
                            return (
                                <g key={`black-${key.pitch}`}>
                                    <rect
                                        x={key.x + 1}
                                        y={keyboardTop + 2}
                                        width={key.width}
                                        height={keyboardHeight * 0.62}
                                        rx={2}
                                        fill="rgba(0,0,0,0.42)"
                                    />
                                    <rect
                                        data-piano-key={midiNoteLabel(key.pitch)}
                                        x={key.x}
                                        y={keyboardTop}
                                        width={key.width}
                                        height={keyboardHeight * 0.62}
                                        rx={2}
                                        fill={`url(#${idPrefix}-${isLit ? 'black-key-active' : 'black-key'})`}
                                        stroke={isLit ? 'rgba(207,250,254,0.55)' : 'rgba(255,255,255,0.08)'}
                                        strokeWidth={isLit ? 1 : 0.65}
                                    />
                                </g>
                            );
                        })}
                    </g>
                </svg>

                <div className="pointer-events-none absolute left-4 top-4 rounded-sm border border-[#33363b] bg-[#17191c]/92 px-2 py-1 text-[8px] font-semibold uppercase tracking-[0.12em] text-[#a1a6ad]">
                    {musicalBar}.{musicalBeat}
                </div>
                <div className="pointer-events-none absolute right-4 top-4 rounded-sm border border-[#33363b] bg-[#17191c]/92 px-2 py-1 text-[8px] font-semibold uppercase tracking-[0.12em] text-[#858a92]">
                    {midiNoteLabel(pitchRange.min)} — {midiNoteLabel(pitchRange.max)}
                </div>

                {laneNotes.length === 0 && livePitches.length === 0 && (
                    <div className="pointer-events-none absolute inset-6 flex items-center justify-center">
                        <div className="max-w-xl rounded-sm border border-dashed border-[#3b3e44] bg-[#17191c]/96 px-6 py-5 text-center">
                            <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#b2b6bc]">{emptyTitle}</div>
                            <div className="mt-2 text-sm leading-6 text-[#7f848b]">{emptyMessage}</div>
                        </div>
                    </div>
                )}
            </div>

            <div className="flex min-h-10 shrink-0 items-center justify-between gap-4 border-t border-[#2d3035] bg-[#181a1d] px-3 py-2 text-xs text-[#b2b6bc]">
                <div className="flex min-w-0 items-center gap-3">
                    <span className="rounded-sm border border-[#383b41] bg-[#121416] px-2 py-1 text-[8px] font-bold uppercase tracking-[0.12em] text-[#7f848b]">
                        Note
                    </span>
                    <span className="truncate text-[11px] text-[#9a9fa6]">
                        {selectedNote
                            ? `${midiNoteLabel(selectedNote.pitch)} · Pitch ${selectedNote.pitch} · Start ${selectedNote.start.toFixed(2)} · Dur ${selectedNote.duration.toFixed(2)}`
                            : 'Selecciona una nota para editarla desde el piano inferior.'}
                    </span>
                </div>

                <label className="flex shrink-0 items-center gap-2">
                    <span className="text-[8px] font-bold uppercase tracking-[0.12em] text-[#72777e]">Velocity</span>
                    <input
                        type="range"
                        min={1}
                        max={127}
                        value={selectedNote ? normalizeMidiVelocity(selectedNote.velocity) : 96}
                        disabled={!selectedNote}
                        aria-label="Velocidad de la nota seleccionada"
                        onChange={(event) => {
                            if (!selectedNote) return;
                            onUpdateNote?.(selectedNote.index, {
                                pitch: selectedNote.pitch,
                                start: selectedNote.start,
                                duration: selectedNote.duration,
                                velocity: normalizeMidiVelocity(Number(event.target.value))
                            });
                        }}
                        className="h-1.5 w-24 cursor-pointer accent-cyan-300 disabled:cursor-not-allowed disabled:opacity-35"
                    />
                </label>
            </div>
        </div>
    );
};

export default React.memo(PianoCinema);
