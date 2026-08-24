
import React, { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import { AudioClipEditorViewState, Clip, Note, PunchRange, Track, TrackType, TransportState } from '../types';
import { SCALES } from '../constants';
import { Activity, Layers3, MousePointer2, Music, Pencil, Scissors, Sparkles, Waves, ZoomIn, ZoomOut, Eraser } from 'lucide-react';
import Knob from './Knob';
import WaveformVisualizer from './WaveformVisualizer';

interface EditorMutationOptions {
    noHistory?: boolean;
    reason?: string;
}

export type EditorTransportView = Pick<TransportState, 'snapToGrid' | 'gridSize' | 'scaleRoot' | 'scaleType'>;

interface EditorProps {
    track: Track | null;
    selectedClipId?: string | null;
    audioViewState?: AudioClipEditorViewState | null;
    selectedTrackPunchRange?: PunchRange | null;
    onClipUpdate?: (trackId: string, clipId: string, updates: Partial<Clip>, options?: EditorMutationOptions) => void;
    onConsolidate?: (track: Track, clips: Clip[]) => void;
    onReverse?: (track: Track, clip: Clip) => void;
    onPromoteToComp?: (track: Track, clip: Clip) => void;
    transport?: EditorTransportView;
}

type SelectedTrackEditorProps = Omit<EditorProps, 'track'> & { track: Track };

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const formatSnapLabel = (gridSize: number): string => {
    const options: Array<{ value: number; label: string }> = [
        { value: 1, label: '1 BAR' },
        { value: 0.5, label: '1/2' },
        { value: 0.25, label: '1/4' },
        { value: 0.125, label: '1/8' },
        { value: 0.0625, label: '1/16' },
        { value: 0.03125, label: '1/32' },
        { value: 1 / 3, label: '1/2T' },
        { value: 1 / 6, label: '1/4T' },
        { value: 1 / 12, label: '1/8T' }
    ];

    const match = options.find((entry) => Math.abs(entry.value - gridSize) < 0.0001);
    if (match) return match.label;

    if (gridSize >= 1) {
        return `${gridSize.toFixed(2)} BAR`;
    }

    const denominator = Math.max(1, Math.round(1 / Math.max(0.0001, gridSize * 4)));
    return `1/${denominator}`;
};

const formatBars = (value: number | null | undefined): string => {
    return Number.isFinite(value) ? Number(value).toFixed(3) : '0.000';
};

const EmptyEditor: React.FC = () => (
    <div className="h-full flex flex-col items-center justify-center bg-[#121214] text-daw-muted select-none border-t border-daw-border relative overflow-hidden">
        <div className="absolute inset-0 opacity-5" style={{ backgroundImage: 'radial-gradient(#ffffff 1px, transparent 1px)', backgroundSize: '30px 30px' }}></div>

        <div className="p-6 bg-[#1a1a1d] rounded-full mb-6 shadow-2xl border border-white/5 animate-pulse">
            <Activity size={48} className="text-daw-ruby" />
        </div>
        <span className="text-sm font-black tracking-[0.3em] opacity-80 uppercase text-white">Ninguna Selección</span>
        <span className="text-[10px] opacity-40 mt-2 font-mono uppercase tracking-widest">Selecciona una Pista para Editar</span>
    </div>
);

const SelectedTrackEditor: React.FC<SelectedTrackEditorProps> = ({
    track,
    selectedClipId = null,
    audioViewState = null,
    selectedTrackPunchRange = null,
    onClipUpdate,
    onConsolidate,
    onReverse,
    onPromoteToComp,
    transport
}) => {
    const [zoom, setZoom] = useState(40); // Pixels per 16th note
    const [verticalZoom, setVerticalZoom] = useState(24); // Pixels per key (Larger for better visibility)
    const [tool, setTool] = useState<'pointer' | 'draw' | 'erase'>('pointer');
    const [hoverNote, setHoverNote] = useState<{ pitch: number, start: number } | null>(null);
    const [selectedNoteIndex, setSelectedNoteIndex] = useState<number | null>(null);
    const [noteDragState, setNoteDragState] = useState<{
        noteIndex: number;
        originClientX: number;
        originClientY: number;
        originalNote: Note;
        originalNotes: Note[];
    } | null>(null);
    const [velocityDragState, setVelocityDragState] = useState<{
        noteIndex: number;
        originalNotes: Note[];
    } | null>(null);
    const [velocityHeight] = useState(80); // Height of velocity lane

    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const gridRef = useRef<HTMLDivElement>(null);
    const velocityLaneRef = useRef<HTMLDivElement>(null);

    // Range: C0 (12) to C8 (108) - Full Piano Range
    const startNote = 12;
    const endNote = 108;
    const totalKeys = endNote - startNote + 1;

    // Auto-Scroll to C3 (MIDI 60) on mount or track change
    useLayoutEffect(() => {
        if (track?.type === TrackType.MIDI && scrollContainerRef.current) {
            // Center view on C3 (60)
            const centerPitch = 60;
            const keysFromTop = endNote - centerPitch;
            const scrollPos = (keysFromTop * verticalZoom) - (scrollContainerRef.current.clientHeight / 2);

            // Instant scroll without animation for snapping effect
            scrollContainerRef.current.scrollTo({ top: scrollPos, behavior: 'instant' });
        }
    }, [track?.id, track?.type]);

    // KEYBOARD SHORTCUTS
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

            if (e.key.toLowerCase() === 'b') setTool('draw');
            if (e.key.toLowerCase() === 'v') setTool('pointer');
            if (e.key.toLowerCase() === 'e') setTool('erase');
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    const selectedClip = useMemo(() => {
        if (selectedClipId) {
            const matched = track.clips.find((clip) => clip.id === selectedClipId);
            if (matched) return matched;
        }
        return track.clips[0] ?? null;
    }, [selectedClipId, track]);
    const canEditAudioSource = track?.type === TrackType.AUDIO && selectedClip && !audioViewState?.isCompClip;
    const audioTake = useMemo(() => {
        if (!track || track.type !== TrackType.AUDIO || !audioViewState?.takeId) {
            return null;
        }
        return (track.recordingTakes || []).find((take) => take.id === audioViewState.takeId) || null;
    }, [audioViewState?.takeId, track]);

    const snapEnabled = transport?.snapToGrid ?? true;
    const snapStep16 = useMemo(() => {
        const gridSize = transport?.gridSize ?? 0.0625;
        return Math.max(0.25, gridSize * 16);
    }, [transport?.gridSize]);

    const snapLabel = useMemo(() => {
        if (!snapEnabled) return 'OFF';
        return formatSnapLabel(transport?.gridSize ?? 0.0625);
    }, [snapEnabled, transport?.gridSize]);

    const quantizeTime16 = useMemo(() => {
        return (rawValue: number) => {
            const safe = Math.max(0, rawValue);
            if (!snapEnabled) return Number(safe.toFixed(4));
            const snapped = Math.round(safe / snapStep16) * snapStep16;
            return Number(Math.max(0, snapped).toFixed(4));
        };
    }, [snapEnabled, snapStep16]);

    useEffect(() => {
        setSelectedNoteIndex(null);
        setNoteDragState(null);
        setVelocityDragState(null);
    }, [selectedClip?.id]);

    useEffect(() => {
        if (!selectedClip) {
            if (selectedNoteIndex !== null) {
                setSelectedNoteIndex(null);
            }
            return;
        }

        if (selectedNoteIndex !== null && selectedNoteIndex >= selectedClip.notes.length) {
            setSelectedNoteIndex(null);
        }
    }, [selectedClip, selectedNoteIndex]);

    // --- HELPERS ---

    const isInScale = (pitch: number) => {
        if (!transport) return true; // Default to chromatic if no transport state
        if (transport.scaleType === 'chromatic') return true;

        const noteIndex = pitch % 12;
        const root = transport.scaleRoot;
        // Normalize note relative to root
        const relativeNote = (noteIndex - root + 12) % 12;

        return SCALES[transport.scaleType].includes(relativeNote);
    };

    const getGridPosition = (e: React.MouseEvent) => {
        if (!gridRef.current) return null;

        const rect = gridRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const rawTime16th = x / zoom;
        const time16th = quantizeTime16(rawTime16th);
        const keyIndex = Math.floor(y / verticalZoom);
        const pitch = endNote - keyIndex;

        return { time16th, pitch, rawY: y };
    };

    const updateSelectedClipNotes = (notes: Note[], options?: EditorMutationOptions) => {
        if (!selectedClip || !onClipUpdate) return;
        onClipUpdate(track.id, selectedClip.id, { notes }, options);
    };

    const updateAudioClip = (updates: Partial<Clip>, reason: string) => {
        if (!selectedClip || !onClipUpdate) return;
        onClipUpdate(track.id, selectedClip.id, updates, { reason });
    };

    // --- EVENT HANDLERS ---

    const handleMouseMove = (e: React.MouseEvent) => {
        if (tool === 'draw') {
            const pos = getGridPosition(e);
            if (pos && (!hoverNote || hoverNote.pitch !== pos.pitch || hoverNote.start !== pos.time16th)) {
                setHoverNote({ pitch: pos.pitch, start: pos.time16th });
            }
        } else {
            setHoverNote(null);
        }
    };

    const handleMouseLeave = () => {
        setHoverNote(null);
    };

    const handleGridClick = (e: React.MouseEvent) => {
        if (!selectedClip || track.type !== TrackType.MIDI || !onClipUpdate) return;

        const pos = getGridPosition(e);
        if (!pos) return;

        const { time16th, pitch } = pos;
        if (pitch < startNote || pitch > endNote) return;

        const existingNoteIndex = selectedClip.notes.findIndex(n =>
            n.pitch === pitch &&
            time16th >= n.start &&
            time16th < (n.start + n.duration)
        );

        if (tool === 'erase') {
            if (existingNoteIndex >= 0) {
                const newNotes = [...selectedClip.notes];
                newNotes.splice(existingNoteIndex, 1);
                updateSelectedClipNotes(newNotes, { reason: 'editor-erase-note' });
                setSelectedNoteIndex(null);
            }
        } else if (tool === 'draw') {
            if (existingNoteIndex === -1) {
                const newNote: Note = {
                    pitch,
                    start: time16th,
                    duration: snapEnabled ? snapStep16 : 1,
                    velocity: 100
                };
                updateSelectedClipNotes([...selectedClip.notes, newNote], { reason: 'editor-draw-note' });
                setSelectedNoteIndex(selectedClip.notes.length);
            }
        } else if (tool === 'pointer') {
            if (existingNoteIndex >= 0) {
                setSelectedNoteIndex(existingNoteIndex);
            } else {
                setSelectedNoteIndex(null);
            }
        }
    };

    const handleNoteMouseDown = (e: React.MouseEvent, note: Note, noteIndex: number) => {
        if (!selectedClip || track.type !== TrackType.MIDI) return;
        e.stopPropagation();

        if (tool === 'erase') {
            const nextNotes = [...selectedClip.notes];
            nextNotes.splice(noteIndex, 1);
            updateSelectedClipNotes(nextNotes, { reason: 'editor-erase-note' });
            setSelectedNoteIndex(null);
            return;
        }

        if (tool !== 'pointer' || !onClipUpdate) return;

        setSelectedNoteIndex(noteIndex);
        setNoteDragState({
            noteIndex,
            originClientX: e.clientX,
            originClientY: e.clientY,
            originalNote: { ...note },
            originalNotes: selectedClip.notes.map((entry) => ({ ...entry }))
        });
    };

    useEffect(() => {
        if (!noteDragState || !selectedClip || track.type !== TrackType.MIDI || !onClipUpdate) return;

        const applyDrag = (event: MouseEvent, noHistory: boolean, reason: string) => {
            const delta16 = (event.clientX - noteDragState.originClientX) / zoom;
            const deltaPitch = Math.round((noteDragState.originClientY - event.clientY) / verticalZoom);

            const nextStart = quantizeTime16(noteDragState.originalNote.start + delta16);
            const nextPitch = Math.max(startNote, Math.min(endNote, noteDragState.originalNote.pitch + deltaPitch));

            const nextNotes = noteDragState.originalNotes.map((note, index) => {
                if (index !== noteDragState.noteIndex) return note;
                return {
                    ...note,
                    start: nextStart,
                    pitch: nextPitch
                };
            });

            updateSelectedClipNotes(nextNotes, {
                noHistory,
                reason
            });
        };

        const handleMouseMove = (event: MouseEvent) => {
            applyDrag(event, true, 'editor-note-drag-preview');
        };

        const handleMouseUp = (event: MouseEvent) => {
            applyDrag(event, false, 'editor-note-drag');
            setNoteDragState(null);
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
        document.body.style.cursor = 'grabbing';

        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
            document.body.style.cursor = 'default';
        };
    }, [endNote, noteDragState, onClipUpdate, quantizeTime16, selectedClip, startNote, tool, track.type, updateSelectedClipNotes, verticalZoom, zoom]);

    const getVelocityFromClientY = (clientY: number): number | null => {
        if (!velocityLaneRef.current) return null;

        const rect = velocityLaneRef.current.getBoundingClientRect();
        const relativeY = clientY - rect.top;
        const clampedY = Math.max(0, Math.min(rect.height, relativeY));
        const normalized = 1 - (clampedY / Math.max(1, rect.height));
        return Math.max(1, Math.min(127, Math.round(normalized * 127)));
    };

    const handleVelocityDragStart = (event: React.MouseEvent, noteIndex: number) => {
        if (!selectedClip || !onClipUpdate || track.type !== TrackType.MIDI) return;

        event.preventDefault();
        event.stopPropagation();

        setSelectedNoteIndex(noteIndex);
        setVelocityDragState({
            noteIndex,
            originalNotes: selectedClip.notes.map((note) => ({ ...note }))
        });
    };

    useEffect(() => {
        if (!velocityDragState || !selectedClip || track.type !== TrackType.MIDI || !onClipUpdate) return;

        const applyVelocity = (event: MouseEvent, noHistory: boolean, reason: string) => {
            const nextVelocity = getVelocityFromClientY(event.clientY);
            if (!nextVelocity) return;

            const nextNotes = velocityDragState.originalNotes.map((note, index) => {
                if (index !== velocityDragState.noteIndex) return note;
                return {
                    ...note,
                    velocity: nextVelocity
                };
            });

            updateSelectedClipNotes(nextNotes, {
                noHistory,
                reason
            });
        };

        const handleMouseMove = (event: MouseEvent) => {
            applyVelocity(event, true, 'editor-velocity-preview');
        };

        const handleMouseUp = (event: MouseEvent) => {
            applyVelocity(event, false, 'editor-velocity-commit');
            setVelocityDragState(null);
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
        document.body.style.cursor = 'ns-resize';

        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
            document.body.style.cursor = 'default';
        };
    }, [onClipUpdate, selectedClip, track.type, updateSelectedClipNotes, velocityDragState]);

    useEffect(() => {
        const handleDeleteSelectedNote = (event: KeyboardEvent) => {
            if (tool !== 'pointer') return;
            if (!selectedClip || selectedNoteIndex === null || track.type !== TrackType.MIDI) return;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
            if (event.key !== 'Delete' && event.key !== 'Backspace') return;

            event.preventDefault();
            const nextNotes = [...selectedClip.notes];
            if (selectedNoteIndex < 0 || selectedNoteIndex >= nextNotes.length) return;
            nextNotes.splice(selectedNoteIndex, 1);
            updateSelectedClipNotes(nextNotes, { reason: 'editor-delete-selected-note' });
            setSelectedNoteIndex(null);
        };

        window.addEventListener('keydown', handleDeleteSelectedNote);
        return () => window.removeEventListener('keydown', handleDeleteSelectedNote);
    }, [selectedClip, selectedNoteIndex, tool, track.type]);

    return (
        <div className="h-full flex flex-col bg-[#121214] select-none text-sans">

            {/* Editor Toolbar */}
            <div className="h-9 border-b border-daw-border bg-[#18181b] flex items-center justify-between px-3 shrink-0 z-30 shadow-md">
                <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2 bg-black/20 pr-3 py-0.5 rounded-sm">
                        <div
                            className="w-2 h-4 rounded-sm"
                            style={{ backgroundColor: track.color }}
                        ></div>
                        <span className="text-xs font-bold text-gray-200 uppercase tracking-wide">{track.name}</span>
                    </div>

                    <div className="w-px h-4 bg-daw-border"></div>

                    {/* TOOL TOGGLES */}
                    <div className="flex gap-0.5 bg-[#0a0a0a] p-0.5 rounded-[3px] border border-daw-border">
                        <button
                            onClick={() => setTool('pointer')}
                            className={`p-1.5 rounded-[2px] transition-all ${tool === 'pointer' ? 'bg-[#333] text-white' : 'text-gray-500 hover:text-gray-300'}`}
                            title="Puntero (V)"
                        >
                            <MousePointer2 size={13} />
                        </button>
                        <button
                            onClick={() => setTool('draw')}
                            className={`p-1.5 rounded-[2px] transition-all ${tool === 'draw' ? 'bg-daw-accent text-black' : 'text-gray-500 hover:text-gray-300'}`}
                            title="Lápiz (B)"
                        >
                            <Pencil size={13} />
                        </button>
                        <button
                            onClick={() => setTool('erase')}
                            className={`p-1.5 rounded-[2px] transition-all ${tool === 'erase' ? 'bg-daw-ruby text-white' : 'text-gray-500 hover:text-gray-300'}`}
                            title="Borrador (E)"
                        >
                            <Eraser size={13} />
                        </button>
                    </div>
                </div>

                <div className="flex gap-4 items-center">
                    {/* Scale Info */}
                    {transport && transport.scaleType !== 'chromatic' && (
                        <div className="px-2 py-0.5 bg-daw-cyan/10 border border-daw-cyan/30 rounded-full flex items-center gap-1">
                            <Activity size={10} className="text-daw-cyan" />
                            <span className="text-[9px] text-daw-cyan font-bold uppercase">
                                {NOTE_NAMES[transport.scaleRoot]} {transport.scaleType}
                            </span>
                        </div>
                    )}

                    <div className="flex items-center gap-2">
                        <span className="text-[9px] text-gray-600 font-bold uppercase">Rejilla</span>
                        <div className="flex gap-1">
                            <ZoomOut size={14} className="text-gray-500 hover:text-white cursor-pointer" onClick={() => setZoom(Math.max(10, zoom - 5))} />
                            <ZoomIn size={14} className="text-gray-500 hover:text-white cursor-pointer" onClick={() => setZoom(Math.min(100, zoom + 5))} />
                        </div>
                    </div>

                    {track.type === TrackType.MIDI && (
                        <div className="flex items-center gap-2 border-l border-daw-border pl-4">
                            <span className="text-[9px] text-gray-600 font-bold uppercase">Teclas</span>
                            <div className="flex gap-1">
                                <ZoomOut size={14} className="text-gray-500 hover:text-white cursor-pointer" onClick={() => setVerticalZoom(Math.max(12, verticalZoom - 4))} />
                                <ZoomIn size={14} className="text-gray-500 hover:text-white cursor-pointer" onClick={() => setVerticalZoom(Math.min(48, verticalZoom + 4))} />
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Editor Content Split */}
            <div className="flex-1 relative flex flex-col overflow-hidden">

                <div
                    className="flex-1 relative overflow-auto bg-[#121214] flex"
                    ref={scrollContainerRef}
                >
                    {track.type === TrackType.MIDI ? (
                        <>
                            {/* Piano Keys (Sticky Left) */}
                            <div className="sticky left-0 z-40 bg-[#121214] border-r border-daw-border select-none shadow-[2px_0_10px_rgba(0,0,0,0.3)]">
                                <div style={{ height: totalKeys * verticalZoom, position: 'relative', width: '50px' }}>
                                    {Array.from({ length: totalKeys }).map((_, i) => {
                                        const pitch = endNote - i;
                                        const noteInOctave = pitch % 12;
                                        const isBlack = [1, 3, 6, 8, 10].includes(noteInOctave);
                                        const noteName = NOTE_NAMES[noteInOctave];
                                        const octave = Math.floor(pitch / 12) - 1;
                                        const isC = noteName === "C";
                                        const inScale = isInScale(pitch);

                                        return (
                                            <div
                                                key={pitch}
                                                className={`
                                                absolute left-0 right-0 flex items-center justify-end pr-1 text-[9px] font-bold border-b border-black/30 transition-colors duration-300
                                                ${isBlack
                                                        ? 'bg-[#18181b] text-gray-600 z-10 h-[60%] border-r-4 border-r-[#000]'
                                                        : 'bg-[#d4d4d8] text-gray-800'
                                                    }
                                                ${!inScale ? 'opacity-30 grayscale' : ''} 
                                                ${inScale && !isBlack ? 'bg-white' : ''}
                                            `}
                                                style={{
                                                    top: i * verticalZoom,
                                                    height: verticalZoom,
                                                    width: isBlack ? '65%' : '100%'
                                                }}
                                            >
                                                {isC && !isBlack && <span className="text-daw-accent font-black tracking-tighter mr-1">C{octave}</span>}
                                                {/* Root Note Indicator */}
                                                {transport && pitch % 12 === transport.scaleRoot && (
                                                    <div className="absolute left-1 w-1.5 h-1.5 rounded-full bg-daw-ruby"></div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>

                            {/* MIDI Note Grid */}
                            <div
                                ref={gridRef}
                                className={`relative min-w-full bg-[#121214] ${tool === 'draw' ? 'cursor-none' : tool === 'erase' ? 'cursor-cell' : 'cursor-default'}`}
                                style={{ height: totalKeys * verticalZoom, width: Math.max(2000, (selectedClip?.length || 4) * 4 * 4 * zoom) }}
                                onClick={handleGridClick}
                                onMouseMove={handleMouseMove}
                                onMouseLeave={handleMouseLeave}
                            >
                                {/* Background Rows */}
                                {Array.from({ length: totalKeys }).map((_, i) => {
                                    const pitch = endNote - i;
                                    const isBlack = [1, 3, 6, 8, 10].includes(pitch % 12);
                                    const inScale = isInScale(pitch);
                                    const isRoot = transport && pitch % 12 === transport.scaleRoot;

                                    return (
                                        <div
                                            key={`row-${i}`}
                                            className={`absolute left-0 right-0 border-b pointer-events-none transition-colors duration-300
                                            ${isBlack ? 'bg-[#161618] border-[#222]' : 'border-[#1e1e20]'}
                                            ${!inScale ? 'bg-[#0a0a0c]/80' : ''} 
                                            ${isRoot ? 'bg-daw-ruby/5' : ''}
                                        `}
                                            style={{ top: i * verticalZoom, height: verticalZoom }}
                                        ></div>
                                    );
                                })}

                                {/* Vertical Bar Lines (Stronger) & Beat Lines (Weaker) */}
                                {Array.from({ length: (selectedClip?.length || 4) * 16 }).map((_, i) => {
                                    const isBar = i % 16 === 0;
                                    const isBeat = i % 4 === 0;
                                    return (
                                        <div
                                            key={`col-${i}`}
                                            className={`absolute top-0 bottom-0 pointer-events-none ${isBar ? 'border-l border-white/20' : isBeat ? 'border-l border-white/10' : 'border-l border-white/5'}`}
                                            style={{ left: i * zoom }}
                                        ></div>
                                    );
                                })}

                                {/* EXISTING NOTES */}
                                {selectedClip && selectedClip.notes.map((note, idx) => {
                                    const top = (endNote - note.pitch) * verticalZoom;
                                    const left = note.start * zoom;
                                    const width = note.duration * zoom;
                                    const inScale = isInScale(note.pitch);
                                    const isSelected = selectedNoteIndex === idx;

                                    return (
                                        <div
                                            key={`${note.pitch}-${note.start}-${idx}`}
                                            onMouseDown={(event) => handleNoteMouseDown(event, note, idx)}
                                            className={`absolute rounded-[2px] border border-black/50 shadow-[0_2px_5px_rgba(0,0,0,0.6)] z-20 group transition-all ${tool === 'pointer' ? 'cursor-move' : tool === 'erase' ? 'cursor-cell' : 'cursor-default'} ${isSelected ? 'ring-2 ring-white/70 brightness-125' : 'hover:brightness-110'} ${!inScale ? 'opacity-60 saturate-50' : ''}`}
                                            style={{
                                                top: top + 1,
                                                left: left,
                                                width: Math.max(4, width - 1),
                                                height: verticalZoom - 2,
                                                backgroundColor: inScale ? track.color : '#444' // Grey out out-of-scale notes
                                            }}
                                        >
                                            {/* Note Velocity Bar (Inside Note) */}
                                            <div
                                                className="absolute bottom-0 left-0 right-0 bg-black/20"
                                                style={{ height: `${100 - (note.velocity / 127 * 100)}%` }}
                                            ></div>
                                            {/* Note Label (visible on zoom) */}
                                            {verticalZoom > 18 && (
                                                <span className="text-[8px] font-bold text-black/70 absolute left-1 top-1/2 -translate-y-1/2 pointer-events-none truncate w-full">
                                                    {NOTE_NAMES[note.pitch % 12]}
                                                </span>
                                            )}
                                            {/* Warning for out of scale */}
                                            {!inScale && (
                                                <div className="absolute top-0 right-0 w-2 h-2 bg-red-500 rounded-bl-sm" title="Nota fuera de escala"></div>
                                            )}
                                        </div>
                                    );
                                })}

                                {/* GHOST NOTE (High Visibility for Drawing) */}
                                {tool === 'draw' && hoverNote && (
                                    <div
                                        className="absolute pointer-events-none z-30"
                                        style={{
                                            top: (endNote - hoverNote.pitch) * verticalZoom,
                                            left: hoverNote.start * zoom,
                                            width: Math.max(1, snapEnabled ? snapStep16 : 1) * zoom,
                                            height: verticalZoom,
                                        }}
                                    >
                                        <div
                                            className={`w-full h-full border-2 bg-white/20 animate-pulse ${isInScale(hoverNote.pitch) ? 'border-white' : 'border-red-500 bg-red-500/10'}`}
                                            style={{ boxShadow: isInScale(hoverNote.pitch) ? `0 0 10px ${track.color}` : 'none' }}
                                        ></div>
                                        <div className="absolute -right-3 -top-3 filter drop-shadow-md">
                                            <Pencil size={14} className="text-white fill-daw-accent" />
                                        </div>
                                        <div className="absolute left-1 top-0 text-[9px] font-bold text-white bg-black/80 px-1 rounded-sm -mt-4">
                                            {NOTE_NAMES[hoverNote.pitch % 12]}{Math.floor(hoverNote.pitch / 12) - 1}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </>
                    ) : (
                        selectedClip ? (
                            <div className="w-full h-full flex flex-col relative bg-[#121214]">
                                <div className="absolute inset-0 opacity-5" style={{ backgroundImage: 'radial-gradient(#ffffff 1px, transparent 1px)', backgroundSize: '10px 10px' }}></div>

                                <div className="p-4 border-b border-daw-border bg-[#18181b] z-10 shadow-sm space-y-4">
                                    <div className="flex flex-wrap items-start gap-4">
                                        <div className="flex flex-col gap-1 pr-4 border-r border-daw-border min-w-[180px]">
                                            <span className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Clip</span>
                                            <div className="flex items-center gap-2">
                                                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: selectedClip.color }}></div>
                                                <span className="text-sm font-bold text-white tracking-wide truncate max-w-[220px]">{selectedClip.name}</span>
                                            </div>
                                            <div className="flex flex-wrap gap-1.5 mt-1">
                                                <span className={`px-2 py-1 rounded-sm text-[9px] font-mono border ${audioViewState?.isCompClip ? 'border-daw-violet/40 text-daw-violet bg-daw-violet/10' : 'border-cyan-400/30 text-cyan-200 bg-cyan-400/10'}`}>
                                                    {audioViewState?.isCompClip ? 'COMP CLIP' : audioViewState?.isTakeClip ? 'TAKE CLIP' : 'AUDIO CLIP'}
                                                </span>
                                                {audioTake && (
                                                    <span className="px-2 py-1 rounded-sm text-[9px] font-mono border border-white/10 text-gray-200 bg-white/5">
                                                        {audioTake.label || audioTake.id}
                                                    </span>
                                                )}
                                                {audioViewState?.takeLaneName && (
                                                    <span className="px-2 py-1 rounded-sm text-[9px] font-mono border border-white/10 text-gray-400 bg-white/5">
                                                        {audioViewState.takeLaneName}
                                                    </span>
                                                )}
                                            </div>
                                        </div>

                                        <div className="flex flex-col gap-1 min-w-[140px]">
                                            <span className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Punch</span>
                                            {selectedTrackPunchRange?.enabled ? (
                                                <div className="rounded border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-[10px] font-mono text-amber-100">
                                                    <div>IN {formatBars(selectedTrackPunchRange.inBar)} / OUT {formatBars(selectedTrackPunchRange.outBar)}</div>
                                                    <div className="text-amber-100/70 mt-0.5">PRE {formatBars(selectedTrackPunchRange.preRollBars)} / COUNT {formatBars(selectedTrackPunchRange.countInBars)}</div>
                                                </div>
                                            ) : (
                                                <div className="rounded border border-white/10 bg-white/5 px-3 py-2 text-[10px] font-mono text-gray-500">
                                                    Punch desactivado para esta pista
                                                </div>
                                            )}
                                        </div>

                                        <div className="flex flex-col gap-1 items-center min-w-[84px]">
                                            <span className="text-[9px] font-bold text-gray-500 uppercase tracking-widest mb-1">Time Mode</span>
                                            <button
                                                disabled={!canEditAudioSource}
                                                onClick={() => updateAudioClip({ isWarped: !selectedClip.isWarped }, 'editor-audio-toggle-warp')}
                                                className={`
                                                    px-3 py-1 rounded-sm text-[10px] font-black uppercase border tracking-wider transition-all disabled:opacity-40 disabled:cursor-not-allowed
                                                    ${selectedClip.isWarped
                                                        ? 'bg-[#eab308] text-black border-[#eab308] shadow-[0_0_10px_rgba(234,179,8,0.3)]'
                                                        : 'bg-[#222] text-gray-400 border-[#333] hover:text-white hover:border-white/20'
                                                    }
                                                `}
                                                title={canEditAudioSource ? 'Alternar warp' : 'Los comp clips editan segmento, no modo fuente'}
                                            >
                                                WARP
                                            </button>
                                        </div>

                                        <div className="flex items-center gap-4 pl-4 border-l border-daw-border">
                                            <div className={`${!canEditAudioSource ? 'opacity-45 pointer-events-none' : ''}`}>
                                                <Knob
                                                    label="GAIN"
                                                    value={selectedClip.gain}
                                                    min={0}
                                                    max={2}
                                                    defaultValue={1}
                                                    size={32}
                                                    color={track.color}
                                                    onChange={(val) => updateAudioClip({ gain: val }, 'editor-audio-gain')}
                                                />
                                            </div>
                                            <div className={`${!canEditAudioSource ? 'opacity-45 pointer-events-none' : ''}`}>
                                                <Knob
                                                    label="PITCH"
                                                    value={selectedClip.transpose ?? 0}
                                                    min={-24}
                                                    max={24}
                                                    defaultValue={0}
                                                    size={32}
                                                    color="#00fff2"
                                                    bipolar={true}
                                                    onChange={(val) => updateAudioClip({ transpose: Math.round(val) }, 'editor-audio-transpose')}
                                                />
                                            </div>
                                            <div className={`${!canEditAudioSource ? 'opacity-45 pointer-events-none' : ''}`}>
                                                <Knob
                                                    label="RATE"
                                                    value={selectedClip.playbackRate ?? 1}
                                                    min={0.25}
                                                    max={4}
                                                    defaultValue={1}
                                                    size={32}
                                                    color="#94F6A6"
                                                    onChange={(val) => updateAudioClip({ playbackRate: Number(val.toFixed(3)) }, 'editor-audio-rate')}
                                                />
                                            </div>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-5 gap-3">
                                        {[
                                            { key: 'start', label: 'START', value: selectedClip.start, min: 0, step: 0.0625 },
                                            { key: 'length', label: 'LENGTH', value: selectedClip.length, min: 0.0625, step: 0.0625 },
                                            { key: 'offset', label: 'OFFSET', value: selectedClip.offset || 0, min: 0, step: 0.0625 },
                                            { key: 'fadeIn', label: 'FADE IN', value: selectedClip.fadeIn || 0, min: 0, step: 0.03125 },
                                            { key: 'fadeOut', label: 'FADE OUT', value: selectedClip.fadeOut || 0, min: 0, step: 0.03125 }
                                        ].map((field) => (
                                            <label key={field.key} className="flex flex-col gap-1">
                                                <span className="text-[9px] font-bold text-gray-500 uppercase tracking-widest">{field.label}</span>
                                                <input
                                                    type="number"
                                                    min={field.min}
                                                    step={field.step}
                                                    value={Number.isFinite(field.value) ? Number(field.value).toFixed(3) : '0.000'}
                                                    onChange={(event) => {
                                                        const numeric = Number(event.target.value);
                                                        if (!Number.isFinite(numeric)) return;
                                                        updateAudioClip({ [field.key]: numeric } as Partial<Clip>, `editor-audio-${field.key}`);
                                                    }}
                                                    className="h-9 rounded border border-white/10 bg-[#10131c] px-2 text-[11px] font-mono text-white outline-none focus:border-daw-violet/60"
                                                />
                                            </label>
                                        ))}
                                    </div>

                                    <div className="flex flex-wrap gap-2">
                                        <button
                                            disabled={!canEditAudioSource || !selectedClip.buffer}
                                            onClick={() => onReverse && onReverse(track, selectedClip)}
                                            className="h-8 px-3 rounded border border-white/10 bg-[#111622] text-[10px] font-bold uppercase tracking-wider text-gray-200 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-2"
                                        >
                                            <Waves size={12} />
                                            Reverse
                                        </button>
                                        <button
                                            disabled={!canEditAudioSource || !selectedClip.buffer}
                                            onClick={() => onConsolidate && onConsolidate(track, [selectedClip])}
                                            className="h-8 px-3 rounded border border-white/10 bg-[#111622] text-[10px] font-bold uppercase tracking-wider text-gray-200 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-2"
                                        >
                                            <Scissors size={12} />
                                            Consolidate
                                        </button>
                                        <button
                                            disabled={!audioViewState?.isTakeClip || Boolean(audioViewState?.isCompClip)}
                                            onClick={() => onPromoteToComp && onPromoteToComp(track, selectedClip)}
                                            className="h-8 px-3 rounded border border-daw-violet/25 bg-daw-violet/10 text-[10px] font-bold uppercase tracking-wider text-daw-violet hover:text-white disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-2"
                                        >
                                            <Sparkles size={12} />
                                            Promote to Comp
                                        </button>
                                        <div className="ml-auto rounded border border-white/10 bg-white/5 px-3 py-1.5 text-[10px] font-mono text-gray-400 inline-flex items-center gap-2">
                                            <Layers3 size={12} />
                                            {audioViewState?.isCompClip
                                                ? `Segment ${audioViewState.compSegmentId || 'n/a'}`
                                                : audioViewState?.takeId
                                                    ? `Take ${audioViewState.takeId}`
                                                    : 'Clip source edit'}
                                        </div>
                                    </div>
                                </div>

                                <div className="flex-1 bg-black/40 rounded border border-white/10 relative overflow-hidden group min-h-0">
                                    <WaveformVisualizer buffer={selectedClip.buffer} color={track.color} />
                                </div>
                            </div>
                        ) : (
                            <div className="w-full h-full flex flex-col items-center justify-center relative bg-[#121214]">
                                <div className="absolute inset-0 opacity-10" style={{ backgroundImage: 'radial-gradient(#ffffff 1px, transparent 1px)', backgroundSize: '40px 40px' }}></div>
                                <div className="p-8 border border-white/5 rounded-xl bg-black/20 backdrop-blur-sm text-center">
                                    <Music size={48} className="text-gray-700 mx-auto mb-4" />
                                    <span className="text-sm font-bold text-gray-500 uppercase tracking-widest">No Clip Selected</span>
                                </div>
                            </div>
                        )
                    )}
                </div>

                {/* VELOCITY LANE (MIDI ONLY) */}
                {track.type === TrackType.MIDI && selectedClip && (
                    <div
                        ref={velocityLaneRef}
                        className="h-[80px] border-t border-daw-border bg-[#151518] shrink-0 relative overflow-hidden"
                        style={{ height: velocityHeight }}
                    >
                        <div className="absolute top-0 left-[50px] right-0 bottom-0 overflow-hidden">
                            <div
                                className="relative h-full"
                                style={{
                                    width: Math.max(2000, selectedClip.length * 4 * 4 * zoom),
                                    transform: `translateX(-${scrollContainerRef.current?.scrollLeft || 0}px)`
                                }}
                            >
                                {/* Background Grid for Velocity */}
                                {Array.from({ length: selectedClip.length * 16 }).map((_, i) => (
                                    <div
                                        key={i}
                                        className={`absolute top-0 bottom-0 border-l ${i % 4 === 0 ? 'border-white/10' : 'border-white/5'}`}
                                        style={{ left: i * zoom }}
                                    ></div>
                                ))}

                                {/* Velocity Stalks */}
                                {selectedClip.notes.map((note, idx) => {
                                    const left = note.start * zoom;
                                    const heightPercent = (note.velocity / 127) * 100;

                                    return (
                                        <div
                                            key={`vel-${idx}`}
                                            className="absolute bottom-0 w-[6px] group cursor-ns-resize"
                                            style={{ left: left + 2 }}
                                            onMouseDown={(event) => handleVelocityDragStart(event, idx)}
                                        >
                                            <div
                                                className="w-full bg-daw-accent opacity-60 group-hover:opacity-100 rounded-t-sm transition-opacity"
                                                style={{
                                                    height: `${heightPercent}%`,
                                                    backgroundColor: track.color
                                                }}
                                            ></div>
                                            <div
                                                className="absolute -top-4 left-1/2 -translate-x-1/2 text-[8px] font-bold text-white opacity-0 group-hover:opacity-100 bg-black px-1 rounded"
                                            >
                                                {note.velocity}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                        {/* Velocity Label */}
                        <div className="absolute top-1 left-2 text-[9px] font-bold text-gray-500 uppercase tracking-widest bg-[#151518] pr-2">
                            Velocidad
                        </div>
                    </div>
                )}
            </div>

            {/* Footer info */}
            <div className="h-6 bg-[#0a0a0c] border-t border-daw-border flex items-center px-4 justify-between text-[10px] text-gray-500 font-mono">
                <div className="flex gap-4">
                    <span className={tool === 'draw' ? 'text-daw-accent font-bold' : ''}>HERRAMIENTA: {tool === 'pointer' ? 'PUNTERO' : tool === 'draw' ? 'LÁPIZ' : 'BORRADOR'}</span>
                    {hoverNote && tool === 'draw' && (
                        <span>NOTA: {NOTE_NAMES[hoverNote.pitch % 12]}{Math.floor(hoverNote.pitch / 12) - 1}</span>
                    )}
                </div>
                <div>
                    SNAP: {snapLabel}
                </div>
            </div>
        </div>
    );
};

const Editor: React.FC<EditorProps> = (props) => {
    if (!props.track) {
        return <EmptyEditor />;
    }

    return <SelectedTrackEditor {...props} track={props.track} />;
};

export default React.memo(Editor);
