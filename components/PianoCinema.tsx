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
const STAR_FIELD = [
    [0.04, 0.12, 0.8], [0.09, 0.3, 0.45], [0.14, 0.2, 0.62], [0.2, 0.08, 0.4],
    [0.26, 0.35, 0.74], [0.31, 0.17, 0.48], [0.38, 0.27, 0.82], [0.43, 0.1, 0.52],
    [0.49, 0.32, 0.58], [0.56, 0.15, 0.78], [0.62, 0.25, 0.42], [0.67, 0.07, 0.66],
    [0.73, 0.33, 0.54], [0.78, 0.18, 0.86], [0.84, 0.28, 0.5], [0.89, 0.1, 0.72],
    [0.94, 0.23, 0.46], [0.98, 0.36, 0.64]
] as const;

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

const noteGradientFamily = (pitch: number, minPitch: number, maxPitch: number): 'low' | 'mid' | 'high' => {
    const ratio = (pitch - minPitch) / Math.max(1, maxPitch - minPitch);
    if (ratio < 0.34) return 'low';
    if (ratio > 0.68) return 'high';
    return 'mid';
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
            data-piano-cinema="premium"
            className="relative flex h-full w-full flex-col overflow-hidden rounded-md border border-cyan-300/15 bg-[#070912] shadow-[0_18px_70px_rgba(1,4,15,0.62)]"
        >
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-[radial-gradient(circle_at_50%_-30%,rgba(34,211,238,0.16),transparent_58%)]"
            />

            <div className="relative z-10 flex h-11 shrink-0 items-center justify-between border-b border-white/[0.07] bg-[#080a12]/95 px-3.5">
                <div className="flex min-w-0 items-center gap-2.5">
                    <div
                        aria-hidden="true"
                        className="relative grid h-6 w-6 place-items-center rounded-md border border-cyan-300/25 bg-cyan-300/[0.06] shadow-[0_0_18px_rgba(34,211,238,0.13)]"
                    >
                        <span className="absolute h-2.5 w-px -translate-x-1 bg-gradient-to-b from-fuchsia-300 to-transparent" />
                        <span className="absolute h-4 w-px translate-x-0.5 bg-gradient-to-b from-cyan-200 to-transparent" />
                        <span className="absolute h-2 w-px translate-x-1.5 bg-gradient-to-b from-violet-300 to-transparent" />
                    </div>
                    <div className="min-w-0 leading-none">
                        <div className="truncate text-[10px] font-black uppercase tracking-[0.26em] text-slate-100">Falling Notes</div>
                        <div className="mt-1 truncate text-[8px] font-semibold uppercase tracking-[0.22em] text-cyan-200/45">Piano Cinema</div>
                    </div>
                </div>

                <div className="flex items-center gap-1.5">
                    <span className="hidden rounded-full border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-[8px] font-bold uppercase tracking-[0.16em] text-slate-400 sm:inline-flex">
                        {bpm.toFixed(0)} BPM
                    </span>
                    <span className="rounded-full border border-violet-300/20 bg-violet-400/[0.08] px-2 py-1 text-[8px] font-bold uppercase tracking-[0.16em] text-violet-100/80">
                        {laneNotes.length} notas
                    </span>
                    <span className={`rounded-full border px-2 py-1 text-[8px] font-bold uppercase tracking-[0.16em] ${sustainActive ? 'border-cyan-300/35 bg-cyan-300/[0.12] text-cyan-100 shadow-[0_0_16px_rgba(34,211,238,0.12)]' : 'border-white/[0.08] bg-white/[0.03] text-slate-500'}`}>
                        Sustain {sustainActive ? 'On' : 'Off'}
                    </span>
                    {livePitches.length > 0 && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300/35 bg-emerald-300/[0.1] px-2 py-1 text-[8px] font-black uppercase tracking-[0.16em] text-emerald-100">
                            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_8px_rgba(110,231,183,0.9)]" />
                            Live {livePitches.length}
                        </span>
                    )}
                </div>
            </div>

            <div className="relative z-10 shrink-0 border-b border-white/[0.06] bg-[#090c16]/94 p-2">
                <svg
                    data-piano-cinema-ribbon="true"
                    className="h-9 w-full cursor-pointer rounded-md outline-none ring-cyan-300/40 transition-shadow focus-visible:ring-2 motion-reduce:transition-none"
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
                        <linearGradient id={`${idPrefix}-ribbon-bg`} x1="0%" y1="0%" x2="100%" y2="0%">
                            <stop offset="0%" stopColor="#080b16" />
                            <stop offset="48%" stopColor="#111126" />
                            <stop offset="100%" stopColor="#100817" />
                        </linearGradient>
                        <linearGradient id={`${idPrefix}-ribbon-progress`} x1="0%" y1="0%" x2="100%" y2="0%">
                            <stop offset="0%" stopColor="rgba(34,211,238,0.18)" />
                            <stop offset="55%" stopColor="rgba(99,102,241,0.2)" />
                            <stop offset="100%" stopColor="rgba(236,72,153,0.2)" />
                        </linearGradient>
                    </defs>
                    <rect x={0} y={0} width={keyboard.width} height={headerHeight} rx={5} fill={`url(#${idPrefix}-ribbon-bg)`} />
                    <rect
                        x={0}
                        y={0}
                        width={(clamp(playhead16th, 0, Math.max(16, total16ths)) / Math.max(16, total16ths)) * keyboard.width}
                        height={headerHeight}
                        rx={5}
                        fill={`url(#${idPrefix}-ribbon-progress)`}
                    />
                    <line x1={0} y1={headerHeight - 3} x2={keyboard.width} y2={headerHeight - 3} stroke="rgba(148,163,184,0.08)" strokeWidth={1} />
                    {ribbonMarkers.map((bar) => {
                        const x = (bar / totalBars) * keyboard.width;
                        return (
                            <g key={`seek-bar-${bar}`} data-piano-cinema-ribbon-marker={bar + 1}>
                                <line x1={x} y1={7} x2={x} y2={30} stroke="rgba(148,163,184,0.22)" strokeWidth={bar % 4 === 0 ? 1.15 : 0.7} />
                                <text x={x + 4} y={14} fill="rgba(203,213,225,0.52)" fontSize={8} fontWeight={700} letterSpacing="0.12em">
                                    {bar + 1}
                                </text>
                            </g>
                        );
                    })}
                    <line
                        ref={ribbonPlayheadRef}
                        x1={(clamp(playhead16th, 0, Math.max(16, total16ths)) / Math.max(16, total16ths)) * keyboard.width}
                        y1={3}
                        x2={(clamp(playhead16th, 0, Math.max(16, total16ths)) / Math.max(16, total16ths)) * keyboard.width}
                        y2={33}
                        stroke="rgba(52,211,242,0.95)"
                        strokeWidth={2.5}
                    />
                    <circle
                        cx={(clamp(playhead16th, 0, Math.max(16, total16ths)) / Math.max(16, total16ths)) * keyboard.width}
                        cy={4}
                        r={2.8}
                        fill="#cffafe"
                    />
                </svg>
            </div>

            <div className="relative min-h-0 flex-1 overflow-hidden bg-[#060812] p-2">
                <svg
                    ref={svgRef}
                    data-piano-cinema-stage="true"
                    className="block h-full w-full rounded-md bg-[#050711] shadow-[inset_0_0_60px_rgba(0,0,0,0.72)]"
                    viewBox={`0 0 ${keyboard.width} ${mainHeight}`}
                    preserveAspectRatio="none"
                    role="group"
                    aria-labelledby={`${stageTitleId} ${stageDescriptionId}`}
                >
                    <title id={stageTitleId}>Visualizador Falling Notes</title>
                    <desc id={stageDescriptionId}>Notas musicales descienden hacia un teclado sincronizado con el transporte. Las notas se pueden seleccionar, mover y redimensionar.</desc>
                    <defs>
                        <linearGradient id={`${idPrefix}-stage-bg`} x1="0%" y1="0%" x2="0%" y2="100%">
                            <stop offset="0%" stopColor="#050714" />
                            <stop offset="44%" stopColor="#090b1d" />
                            <stop offset="78%" stopColor="#0b1020" />
                            <stop offset="100%" stopColor="#05070d" />
                        </linearGradient>
                        <radialGradient id={`${idPrefix}-aurora-left`} cx="0%" cy="22%" r="72%">
                            <stop offset="0%" stopColor="rgba(56,189,248,0.2)" />
                            <stop offset="55%" stopColor="rgba(37,99,235,0.05)" />
                            <stop offset="100%" stopColor="rgba(2,6,23,0)" />
                        </radialGradient>
                        <radialGradient id={`${idPrefix}-aurora-right`} cx="100%" cy="26%" r="72%">
                            <stop offset="0%" stopColor="rgba(217,70,239,0.17)" />
                            <stop offset="58%" stopColor="rgba(124,58,237,0.045)" />
                            <stop offset="100%" stopColor="rgba(2,6,23,0)" />
                        </radialGradient>
                        <linearGradient id={`${idPrefix}-horizon`} x1="0%" y1="0%" x2="0%" y2="100%">
                            <stop offset="0%" stopColor="rgba(34,211,238,0)" />
                            <stop offset="44%" stopColor="rgba(34,211,238,0.16)" />
                            <stop offset="100%" stopColor="rgba(99,102,241,0)" />
                        </linearGradient>
                        <linearGradient id={`${idPrefix}-note-low`} x1="0%" y1="0%" x2="0%" y2="100%">
                            <stop offset="0%" stopColor="#f0abfc" />
                            <stop offset="48%" stopColor="#c026d3" />
                            <stop offset="100%" stopColor="#7c3aed" />
                        </linearGradient>
                        <linearGradient id={`${idPrefix}-note-mid`} x1="0%" y1="0%" x2="0%" y2="100%">
                            <stop offset="0%" stopColor="#cffafe" />
                            <stop offset="42%" stopColor="#22d3ee" />
                            <stop offset="100%" stopColor="#4f46e5" />
                        </linearGradient>
                        <linearGradient id={`${idPrefix}-note-high`} x1="0%" y1="0%" x2="0%" y2="100%">
                            <stop offset="0%" stopColor="#fce7f3" />
                            <stop offset="42%" stopColor="#fb7185" />
                            <stop offset="100%" stopColor="#db2777" />
                        </linearGradient>
                        <linearGradient id={`${idPrefix}-note-trail`} x1="0%" y1="0%" x2="0%" y2="100%">
                            <stop offset="0%" stopColor="rgba(129,140,248,0)" />
                            <stop offset="68%" stopColor="rgba(129,140,248,0.1)" />
                            <stop offset="100%" stopColor="rgba(103,232,249,0.34)" />
                        </linearGradient>
                        <linearGradient id={`${idPrefix}-white-key`} x1="0%" y1="0%" x2="0%" y2="100%">
                            <stop offset="0%" stopColor="#f8fafc" />
                            <stop offset="58%" stopColor="#dbe4ee" />
                            <stop offset="100%" stopColor="#94a3b8" />
                        </linearGradient>
                        <linearGradient id={`${idPrefix}-white-key-active`} x1="0%" y1="0%" x2="0%" y2="100%">
                            <stop offset="0%" stopColor="#ecfeff" />
                            <stop offset="45%" stopColor="#67e8f9" />
                            <stop offset="100%" stopColor="#6366f1" />
                        </linearGradient>
                        <linearGradient id={`${idPrefix}-black-key`} x1="0%" y1="0%" x2="0%" y2="100%">
                            <stop offset="0%" stopColor="#293245" />
                            <stop offset="24%" stopColor="#0f172a" />
                            <stop offset="100%" stopColor="#02040a" />
                        </linearGradient>
                        <linearGradient id={`${idPrefix}-black-key-active`} x1="0%" y1="0%" x2="0%" y2="100%">
                            <stop offset="0%" stopColor="#cffafe" />
                            <stop offset="46%" stopColor="#22d3ee" />
                            <stop offset="100%" stopColor="#4338ca" />
                        </linearGradient>
                        <linearGradient id={`${idPrefix}-key-reflection`} x1="0%" y1="100%" x2="0%" y2="0%">
                            <stop offset="0%" stopColor="rgba(103,232,249,0.24)" />
                            <stop offset="100%" stopColor="rgba(103,232,249,0)" />
                        </linearGradient>
                        <radialGradient id={`${idPrefix}-vignette`} cx="50%" cy="48%" r="72%">
                            <stop offset="58%" stopColor="rgba(2,6,23,0)" />
                            <stop offset="100%" stopColor="rgba(0,0,0,0.62)" />
                        </radialGradient>
                        <filter id={`${idPrefix}-active-glow`} x="-80%" y="-30%" width="260%" height="180%" colorInterpolationFilters="sRGB">
                            <feGaussianBlur stdDeviation="4" result="blur" />
                            <feMerge>
                                <feMergeNode in="blur" />
                                <feMergeNode in="SourceGraphic" />
                            </feMerge>
                        </filter>
                    </defs>

                    <rect x={0} y={0} width={keyboard.width} height={mainHeight} fill={`url(#${idPrefix}-stage-bg)`} />
                    <rect x={0} y={0} width={keyboard.width} height={noteViewportHeight} fill={`url(#${idPrefix}-aurora-left)`} />
                    <rect x={0} y={0} width={keyboard.width} height={noteViewportHeight} fill={`url(#${idPrefix}-aurora-right)`} />

                    <g aria-hidden="true" opacity={0.9}>
                        {STAR_FIELD.map(([xRatio, yRatio, opacity], index) => (
                            <circle
                                key={`star-${index}`}
                                cx={xRatio * keyboard.width}
                                cy={yRatio * noteViewportHeight}
                                r={index % 5 === 0 ? 1.15 : 0.7}
                                fill={index % 3 === 0 ? '#a5f3fc' : '#ddd6fe'}
                                opacity={opacity}
                            />
                        ))}
                    </g>

                    <g aria-hidden="true" data-piano-cinema-depth-grid="true">
                        <rect x={0} y={48} width={keyboard.width} height={96} fill={`url(#${idPrefix}-horizon)`} opacity={0.68} />
                        <line x1={0} y1={82} x2={keyboard.width} y2={82} stroke="rgba(103,232,249,0.2)" strokeWidth={0.75} />
                        {keyboard.whiteKeys.filter((_, index) => index % 2 === 0).map((key) => {
                            const center = key.x + (key.width / 2);
                            const horizonX = (keyboard.width / 2) + ((center - (keyboard.width / 2)) * 0.12);
                            return (
                                <line
                                    key={`perspective-lane-${key.pitch}`}
                                    x1={horizonX}
                                    y1={82}
                                    x2={center}
                                    y2={keyboardTop}
                                    stroke="rgba(99,102,241,0.11)"
                                    strokeWidth={0.75}
                                />
                            );
                        })}
                        {Array.from({ length: 9 }, (_, index) => {
                            const ratio = (index + 1) / 10;
                            const y = 82 + ((keyboardTop - 82) * Math.pow(ratio, 1.82));
                            return (
                                <line
                                    key={`depth-band-${index}`}
                                    x1={0}
                                    y1={y}
                                    x2={keyboard.width}
                                    y2={y}
                                    stroke="rgba(129,140,248,0.11)"
                                    strokeWidth={index > 6 ? 1 : 0.65}
                                />
                            );
                        })}
                    </g>

                    <g ref={motionLayerRef} style={{ willChange: 'transform' }}>
                        {Array.from({ length: Math.ceil((lookAhead16ths + lookBehind16ths) / 4) }, (_, index) => {
                            const timeline16th = playhead16th - lookBehind16ths + (index * 4);
                            const y = keyboardTop - (timeline16th * pixelsPer16th);
                            return (
                                <g key={`grid-${index}`} aria-hidden="true">
                                    <line
                                        x1={0}
                                        y1={y}
                                        x2={keyboard.width}
                                        y2={y}
                                        stroke={index % 4 === 0 ? 'rgba(103,232,249,0.19)' : 'rgba(148,163,184,0.08)'}
                                        strokeWidth={index % 4 === 0 ? 1.1 : 0.65}
                                    />
                                </g>
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
                            const trailLength = clamp(12 + (velocity * 0.28) + (noteHeight * 0.35), 18, 92);
                            const family = noteGradientFamily(note.pitch, pitchRange.min, pitchRange.max);
                            const fillId = `${idPrefix}-note-${family}`;

                            return (
                                <g
                                    key={note.noteKey}
                                    data-piano-cinema-note={midiNoteLabel(note.pitch)}
                                    filter={isSelected || isActive ? `url(#${idPrefix}-active-glow)` : undefined}
                                >
                                    <rect
                                        data-piano-cinema-note-trail="true"
                                        x={noteX + (noteWidth * 0.16)}
                                        y={noteTop - trailLength}
                                        width={noteWidth * 0.68}
                                        height={trailLength + 5}
                                        rx={noteWidth * 0.3}
                                        fill={`url(#${idPrefix}-note-trail)`}
                                        opacity={isActive ? 0.88 : 0.34 + ((velocity / 127) * 0.2)}
                                        pointerEvents="none"
                                    />
                                    <rect
                                        x={noteX + 2}
                                        y={noteTop + 4}
                                        width={noteWidth}
                                        height={noteHeight}
                                        rx={4}
                                        fill="rgba(2,6,23,0.66)"
                                        opacity={0.72}
                                        pointerEvents="none"
                                    />
                                    <rect
                                        x={noteX - 1.5}
                                        y={noteTop - 1.5}
                                        width={noteWidth + 3}
                                        height={noteHeight + 3}
                                        rx={5}
                                        fill={isActive ? 'rgba(207,250,254,0.25)' : 'rgba(129,140,248,0.1)'}
                                        opacity={isSelected || isActive ? 1 : 0.55}
                                        pointerEvents="none"
                                    />
                                    <rect
                                        x={noteX}
                                        y={noteTop}
                                        width={noteWidth}
                                        height={noteHeight}
                                        rx={4}
                                        fill={`url(#${fillId})`}
                                        opacity={isSelected || isActive ? 1 : 0.72 + ((velocity / 127) * 0.22)}
                                        stroke={isSelected ? '#f8fafc' : isActive ? '#cffafe' : 'rgba(15,23,42,0.72)'}
                                        strokeWidth={isSelected ? 1.8 : isActive ? 1.25 : 0.8}
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
                                        x={noteX + 1.5}
                                        y={noteTop + 1.5}
                                        width={Math.max(1, noteWidth - 3)}
                                        height={Math.min(4, Math.max(2, noteHeight * 0.18))}
                                        rx={2}
                                        fill="rgba(255,255,255,0.75)"
                                        opacity={0.74}
                                        pointerEvents="none"
                                    />
                                    {noteHeight >= 24 && (
                                        <text
                                            x={noteX + (noteWidth / 2)}
                                            y={noteTop + 15}
                                            textAnchor="middle"
                                            fill="rgba(255,255,255,0.86)"
                                            fontSize={7}
                                            fontWeight={800}
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
                                        fill="rgba(248,250,252,0.01)"
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
                                <g key={`key-reflection-${pitch}`} data-piano-cinema-key-reflection={midiNoteLabel(pitch)} filter={`url(#${idPrefix}-active-glow)`}>
                                    <rect
                                        x={frame.x}
                                        y={keyboardTop - 52}
                                        width={frame.width}
                                        height={52}
                                        fill={`url(#${idPrefix}-key-reflection)`}
                                        opacity={0.82}
                                    />
                                    <ellipse cx={frame.center} cy={keyboardTop} rx={frame.width * 0.72} ry={7} fill="rgba(207,250,254,0.58)" />
                                </g>
                            );
                        })}
                    </g>

                    <line x1={0} y1={keyboardTop - 1} x2={keyboard.width} y2={keyboardTop - 1} stroke="rgba(207,250,254,0.3)" strokeWidth={5} opacity={0.42} />
                    <line x1={0} y1={keyboardTop} x2={keyboard.width} y2={keyboardTop} stroke="rgba(103,232,249,0.96)" strokeWidth={1.6} />
                    <rect x={0} y={keyboardTop + keyboardHeight - 4} width={keyboard.width} height={8} fill="rgba(0,0,0,0.72)" />

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
                                        rx={1.5}
                                        fill={`url(#${idPrefix}-${isLit ? 'white-key-active' : 'white-key'})`}
                                        stroke={isLit ? 'rgba(207,250,254,0.86)' : 'rgba(15,23,42,0.48)'}
                                        strokeWidth={isLit ? 1.2 : 0.8}
                                    />
                                    <line
                                        x1={key.x + 2}
                                        y1={keyboardTop + 3}
                                        x2={key.x + key.width - 2}
                                        y2={keyboardTop + 3}
                                        stroke={isLit ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.6)'}
                                        strokeWidth={1}
                                    />
                                    <rect
                                        x={key.x + 1}
                                        y={keyboardTop + keyboardHeight - 8}
                                        width={key.width - 2}
                                        height={7}
                                        rx={1}
                                        fill={isLit ? 'rgba(49,46,129,0.36)' : 'rgba(30,41,59,0.16)'}
                                    />
                                    {key.pitch % 12 === 0 && (
                                        <text
                                            x={key.x + (key.width / 2)}
                                            y={keyboardTop + keyboardHeight - 12}
                                            textAnchor="middle"
                                            fill={isLit ? 'rgba(15,23,42,0.84)' : 'rgba(51,65,85,0.68)'}
                                            fontSize={7}
                                            fontWeight={800}
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
                                <g key={`black-${key.pitch}`} filter={isLit ? `url(#${idPrefix}-active-glow)` : undefined}>
                                    <rect
                                        data-piano-key={midiNoteLabel(key.pitch)}
                                        x={key.x + 1.4}
                                        y={keyboardTop + 2.5}
                                        width={key.width}
                                        height={keyboardHeight * 0.62}
                                        rx={3}
                                        fill="rgba(0,0,0,0.55)"
                                    />
                                    <rect
                                        x={key.x}
                                        y={keyboardTop}
                                        width={key.width}
                                        height={keyboardHeight * 0.62}
                                        rx={3}
                                        fill={`url(#${idPrefix}-${isLit ? 'black-key-active' : 'black-key'})`}
                                        stroke={isLit ? 'rgba(207,250,254,0.78)' : 'rgba(255,255,255,0.09)'}
                                        strokeWidth={isLit ? 1.15 : 0.7}
                                    />
                                    <line
                                        x1={key.x + 3}
                                        y1={keyboardTop + 4}
                                        x2={key.x + key.width - 3}
                                        y2={keyboardTop + 4}
                                        stroke={isLit ? 'rgba(255,255,255,0.82)' : 'rgba(255,255,255,0.18)'}
                                        strokeWidth={1}
                                    />
                                </g>
                            );
                        })}
                    </g>

                    <rect x={0} y={0} width={keyboard.width} height={mainHeight} fill={`url(#${idPrefix}-vignette)`} pointerEvents="none" />
                </svg>

                <div className="pointer-events-none absolute left-4 top-4 flex items-center gap-2 rounded-full border border-white/[0.08] bg-[#050713]/75 px-2.5 py-1.5 text-[8px] font-bold uppercase tracking-[0.18em] text-slate-300 shadow-lg backdrop-blur-sm">
                    <span className="h-1.5 w-1.5 rounded-full bg-cyan-300 shadow-[0_0_8px_rgba(103,232,249,0.9)]" />
                    Compás {musicalBar}.{musicalBeat}
                </div>
                <div className="pointer-events-none absolute right-4 top-4 rounded-full border border-white/[0.08] bg-[#050713]/75 px-2.5 py-1.5 text-[8px] font-bold uppercase tracking-[0.18em] text-slate-400 shadow-lg backdrop-blur-sm">
                    {midiNoteLabel(pitchRange.min)} — {midiNoteLabel(pitchRange.max)}
                </div>

                {laneNotes.length === 0 && livePitches.length === 0 && (
                    <div className="pointer-events-none absolute inset-6 flex items-center justify-center">
                        <div className="max-w-xl rounded-xl border border-cyan-200/15 bg-[#070a15]/88 px-7 py-6 text-center shadow-[0_20px_70px_rgba(0,0,0,0.5),0_0_36px_rgba(34,211,238,0.06)] backdrop-blur-md">
                            <div aria-hidden="true" className="mx-auto mb-4 flex h-10 w-20 items-end justify-center gap-1 rounded-full border border-white/[0.06] bg-white/[0.025] px-4 pb-2">
                                {[9, 18, 13, 25, 16, 21].map((height, index) => (
                                    <span
                                        key={`empty-note-${index}`}
                                        className="w-1 rounded-full bg-gradient-to-t from-violet-500 to-cyan-200"
                                        style={{ height }}
                                    />
                                ))}
                            </div>
                            <div className="text-[10px] font-black uppercase tracking-[0.24em] text-slate-200">{emptyTitle}</div>
                            <div className="mt-2 text-sm leading-6 text-slate-400">{emptyMessage}</div>
                        </div>
                    </div>
                )}
            </div>

            <div className="relative z-10 flex min-h-11 shrink-0 items-center justify-between gap-4 border-t border-white/[0.07] bg-[#080a12]/96 px-3.5 py-2 text-xs text-slate-300">
                <div className="flex min-w-0 items-center gap-3">
                    <span className="rounded-full border border-cyan-300/15 bg-cyan-300/[0.05] px-2 py-1 text-[8px] font-black uppercase tracking-[0.18em] text-cyan-100/70">
                        Note Inspector
                    </span>
                    <span className="truncate text-[11px] text-slate-400">
                        {selectedNote
                            ? `${midiNoteLabel(selectedNote.pitch)} · Pitch ${selectedNote.pitch} · Start ${selectedNote.start.toFixed(2)} · Dur ${selectedNote.duration.toFixed(2)}`
                            : 'Selecciona una nota para editarla desde el piano inferior.'}
                    </span>
                </div>

                <div className="flex shrink-0 items-center gap-3">
                    <label className="flex items-center gap-2">
                        <span className="text-[8px] font-black uppercase tracking-[0.18em] text-slate-500">Velocity</span>
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
        </div>
    );
};

export default React.memo(PianoCinema);
