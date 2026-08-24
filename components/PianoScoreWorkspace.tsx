import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Loader2, Music2, Pause, Play, RefreshCcw, RotateCcw, Square, Wand2, X } from 'lucide-react';
import {
    Clip,
    Note,
    ScoreNotationOverride,
    ScoreWorkspaceState,
    Track,
    TrackType,
    TransportState
} from '../types';
import {
    buildScoreDocument,
    cloneScoreWorkspaceState,
    createDefaultScoreWorkspace,
    normalizeClipNotes
} from '../services/pianoScoreConversionService';
import { pianoTranscriptionService } from '../services/pianoTranscriptionService';
import {
    buildScoreTransportFrame,
    normalizeScoreNotesToAudibleClipWindow,
    scoreSource16thToGlobalTimeline16th,
    timeline16thToBarTime,
    type ScoreClipTransportContext
} from '../services/scoreTransportSyncService';
import { getTransportClockSnapshot, subscribeTransportClock, type TransportClockSnapshot } from '../services/transportClockStore';
import { midiService } from '../services/MidiService';
import ScoreViewport from './ScoreViewport';
import PianoCinema from './PianoCinema';

export interface PianoScoreMidiCommitPayload {
    notes: Note[];
    clipName: string;
    sourceTrackId: string;
    sourceClipId: string;
}

export type PianoScoreSurfaceMode = 'combined' | 'score' | 'keys';

interface PianoScoreWorkspaceProps {
    isOpen: boolean;
    surfaceMode?: PianoScoreSurfaceMode;
    tracks: Track[];
    transport: TransportState;
    selectedTrackId: string | null;
    selectedClipId: string | null;
    scoreWorkspaces: ScoreWorkspaceState[];
    onClose: () => void;
    onScoreWorkspacesChange: (workspaces: ScoreWorkspaceState[]) => void;
    onCreateMidiTrackFromScore: (
        payload: PianoScoreMidiCommitPayload,
        options?: { trackName?: string }
    ) => { trackId: string; clipId: string } | null;
    onUpdateMidiClip: (trackId: string, clipId: string, payload: PianoScoreMidiCommitPayload) => boolean;
    onSelectSource: (trackId: string, clipId: string) => void;
    onPlay: () => void | Promise<void>;
    onPause: () => void | Promise<void>;
    onStop: () => void | Promise<void>;
    onSeekToBarTime: (barTime: number) => void | Promise<void>;
}

interface SourceCandidate {
    id: string;
    label: string;
    trackId: string;
    clipId: string;
    kind: 'midi' | 'audio-derived';
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const findClipById = (tracks: Track[], trackId?: string, clipId?: string): { track: Track; clip: Clip } | null => {
    if (!trackId || !clipId) return null;
    const track = tracks.find((candidate) => candidate.id === trackId);
    const clip = track?.clips.find((candidate) => candidate.id === clipId);
    return track && clip ? { track, clip } : null;
};

const upsertWorkspace = (workspaces: ScoreWorkspaceState[], nextWorkspace: ScoreWorkspaceState): ScoreWorkspaceState[] => {
    const next = cloneScoreWorkspaceState(nextWorkspace);
    const existingIndex = workspaces.findIndex((workspace) => workspace.id === next.id);
    if (existingIndex === -1) return [...workspaces, next];
    return workspaces.map((workspace, index) => index === existingIndex ? next : workspace);
};

const buttonBase = 'h-11 md:h-8 px-3 rounded-sm border text-[10px] font-bold uppercase tracking-wider transition-all disabled:cursor-not-allowed disabled:opacity-40 flex shrink-0 items-center gap-2';
const subtleButtonClass = `${buttonBase} border-white/15 bg-[#151824] text-gray-300 hover:text-white hover:border-white/30`;
const secondaryAccentButtonClass = `${buttonBase} border-daw-violet/35 bg-daw-violet/10 text-daw-violet hover:bg-daw-violet/18 hover:text-violet-100`;
const successButtonClass = `${buttonBase} border-emerald-400/35 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/18`;
const dangerButtonClass = `${buttonBase} border-rose-400/35 bg-rose-500/10 text-rose-200 hover:bg-rose-500/18`;

const isAbortError = (error: unknown): boolean => (
    (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError')
    || (error instanceof Error && /abort|cancel/i.test(`${error.name} ${error.message}`))
);

const PianoScoreWorkspace: React.FC<PianoScoreWorkspaceProps> = ({
    isOpen,
    surfaceMode = 'combined',
    tracks,
    transport,
    selectedTrackId,
    selectedClipId,
    scoreWorkspaces,
    onClose,
    onScoreWorkspacesChange,
    onCreateMidiTrackFromScore,
    onUpdateMidiClip,
    onSelectSource,
    onPlay,
    onPause,
    onStop,
    onSeekToBarTime
}) => {
    const rootRef = useRef<HTMLDivElement>(null);
    const mobileTabsIdPrefix = useId().replace(/:/g, '');
    const transcriptionAbortRef = useRef<AbortController | null>(null);
    const transcriptionRequestIdRef = useRef(0);
    const [transportClock, setTransportClock] = useState<TransportClockSnapshot>(() => getTransportClockSnapshot());
    const [draftNotes, setDraftNotes] = useState<Note[] | null>(null);
    const [transcriptionGridBpm, setTranscriptionGridBpm] = useState<number | null>(null);
    const [isScanning, setIsScanning] = useState(false);
    const [scanProgressMessage, setScanProgressMessage] = useState('');
    const [scanError, setScanError] = useState<string | null>(null);
    const [selectedNoteKey, setSelectedNoteKey] = useState<string | null>(null);
    const [livePitches, setLivePitches] = useState<number[]>([]);
    const [sustainActive, setSustainActive] = useState(false);
    const [mobilePanel, setMobilePanel] = useState<'score' | 'keys'>(() => surfaceMode === 'score' ? 'score' : 'keys');
    const showScoreSurface = surfaceMode !== 'keys';
    const showKeysSurface = surfaceMode !== 'score';
    const showSurfaceTabs = showScoreSurface && showKeysSurface;
    const productTitle = surfaceMode === 'score' ? 'Score-fi' : surfaceMode === 'keys' ? 'Keys-fi' : 'Score-fi · Keys-fi';

    const sourceCandidates = useMemo<SourceCandidate[]>(() => tracks.flatMap((track) => {
        if (track.type !== TrackType.MIDI && track.type !== TrackType.AUDIO) return [];
        return track.clips.map((clip) => ({
            id: `${track.id}:${clip.id}`,
            label: `${track.name} / ${clip.name}`,
            trackId: track.id,
            clipId: clip.id,
            kind: track.type === TrackType.AUDIO ? 'audio-derived' : 'midi'
        }));
    }), [tracks]);

    const selectedTrack = useMemo(() => tracks.find((track) => track.id === selectedTrackId) || null, [tracks, selectedTrackId]);
    const selectedClip = useMemo(() => selectedTrack?.clips.find((clip) => clip.id === selectedClipId) || null, [selectedClipId, selectedTrack]);

    const matchedWorkspace = useMemo(() => {
        if (!selectedTrackId || !selectedClipId) return null;
        return scoreWorkspaces.find((workspace) => (
            (workspace.source.trackId === selectedTrackId && workspace.source.clipId === selectedClipId)
            || (workspace.source.derivedMidiTrackId === selectedTrackId && workspace.source.derivedMidiClipId === selectedClipId)
        )) || null;
    }, [scoreWorkspaces, selectedClipId, selectedTrackId]);

    const fallbackWorkspace = useMemo(() => {
        if (!selectedTrack || !selectedClip) return null;
        return createDefaultScoreWorkspace(
            selectedTrack.id,
            selectedClip.id,
            `Score-fi / ${selectedTrack.name}`,
            selectedTrack.type === TrackType.AUDIO ? 'audio-derived' : 'midi'
        );
    }, [selectedClip, selectedTrack]);

    const currentWorkspace = matchedWorkspace || fallbackWorkspace;

    useEffect(() => {
        if (!isOpen || matchedWorkspace || !fallbackWorkspace) return;
        onScoreWorkspacesChange(upsertWorkspace(scoreWorkspaces, fallbackWorkspace));
    }, [fallbackWorkspace, isOpen, matchedWorkspace, onScoreWorkspacesChange, scoreWorkspaces]);

    useEffect(() => subscribeTransportClock(() => setTransportClock(getTransportClockSnapshot())), []);

    useEffect(() => {
        transcriptionRequestIdRef.current += 1;
        transcriptionAbortRef.current?.abort();
        transcriptionAbortRef.current = null;
        setIsScanning(false);
        setDraftNotes(null);
        setTranscriptionGridBpm(null);
        setScanError(null);
        setScanProgressMessage('');
        setSelectedNoteKey(null);
    }, [currentWorkspace?.id]);

    useEffect(() => {
        if (isOpen) return;
        transcriptionRequestIdRef.current += 1;
        transcriptionAbortRef.current?.abort();
        transcriptionAbortRef.current = null;
        setIsScanning(false);
    }, [isOpen]);

    useEffect(() => () => {
        transcriptionRequestIdRef.current += 1;
        transcriptionAbortRef.current?.abort();
        transcriptionAbortRef.current = null;
    }, []);

    const sourceClipContext = useMemo(() => {
        if (!currentWorkspace) return null;
        return findClipById(tracks, currentWorkspace.source.trackId, currentWorkspace.source.clipId);
    }, [currentWorkspace, tracks]);

    const scoreClipTransportContext = useMemo<ScoreClipTransportContext | undefined>(() => {
        if (!sourceClipContext) return undefined;
        const { clip, track } = sourceClipContext;
        const sourceOriginalBpm = Math.max(1, clip.originalBpm ?? 120);
        return {
            sourceKind: track.type === TrackType.AUDIO ? 'audio' : 'midi',
            noteTimeDomain: currentWorkspace?.source.kind === 'audio-derived' ? 'clip-local' : 'source-grid',
            clipStartBar: clip.start,
            clipLengthBars: clip.length,
            clipOffsetBars: clip.offset,
            playbackRate: clip.playbackRate,
            sourceOriginalBpm,
            noteGridBpm: transcriptionGridBpm ?? transport.bpm,
            projectBpm: transport.bpm,
            isWarped: clip.isWarped,
            clipTransposeSemitones: clip.transpose,
            trackTransposeSemitones: track.transpose,
            masterTransposeSemitones: transport.masterTranspose
        };
    }, [currentWorkspace?.source.kind, sourceClipContext, transcriptionGridBpm, transport.bpm, transport.masterTranspose]);

    const derivedClipContext = useMemo(() => {
        if (!currentWorkspace || currentWorkspace.source.kind !== 'audio-derived') return null;
        return findClipById(tracks, currentWorkspace.source.derivedMidiTrackId, currentWorkspace.source.derivedMidiClipId);
    }, [currentWorkspace, tracks]);

    const workingNotes = useMemo(() => {
        if (draftNotes) return normalizeClipNotes(draftNotes);
        if (currentWorkspace?.source.kind === 'audio-derived' && derivedClipContext?.clip) {
            return normalizeClipNotes(derivedClipContext.clip.notes);
        }
        if (sourceClipContext?.clip) {
            return normalizeClipNotes(sourceClipContext.clip.notes);
        }
        return [];
    }, [currentWorkspace, derivedClipContext, draftNotes, sourceClipContext]);

    const scoreDocument = useMemo(() => {
        if (!currentWorkspace || workingNotes.length === 0) return null;
        return buildScoreDocument({
            notes: workingNotes,
            bpm: transport.bpm,
            timeSignature: transport.timeSignature,
            title: currentWorkspace.title,
            workspaceId: currentWorkspace.id,
            notationOverrides: currentWorkspace.notationOverrides,
            confidenceRegions: currentWorkspace.confidenceRegions
        });
    }, [currentWorkspace, transport.bpm, transport.timeSignature, workingNotes]);

    const transportFrame = useMemo(() => {
        return buildScoreTransportFrame(
            workingNotes,
            transportClock,
            transport.timeSignature,
            transport.bpm,
            Date.now(),
            scoreClipTransportContext
        );
    }, [scoreClipTransportContext, transport.bpm, transport.timeSignature, transportClock, workingNotes]);

    const setWorkspace = useCallback((updater: (workspace: ScoreWorkspaceState) => ScoreWorkspaceState) => {
        if (!currentWorkspace) return;
        const nextWorkspace = updater(cloneScoreWorkspaceState(currentWorkspace));
        nextWorkspace.updatedAt = Date.now();
        onScoreWorkspacesChange(upsertWorkspace(scoreWorkspaces, nextWorkspace));
    }, [currentWorkspace, onScoreWorkspacesChange, scoreWorkspaces]);

    const selectedScoreEvent = useMemo(() => {
        if (!scoreDocument || !selectedNoteKey) return null;
        return scoreDocument.measures.flatMap((measure) => measure.voices.flatMap((voice) => voice.events))
            .find((event) => event.type === 'note' && event.sourceNoteKey === selectedNoteKey) || null;
    }, [scoreDocument, selectedNoteKey]);

    useEffect(() => {
        if (!isOpen) return;
        const hasArmedMidiTrack = tracks.some((track) => track.type === TrackType.MIDI && track.isArmed);
        if (!hasArmedMidiTrack) {
            setLivePitches([]);
            setSustainActive(false);
            return;
        }

        const held = new Set<number>();
        const sustained = new Set<number>();
        let sustain = false;
        return midiService.onMessage((message) => {
            if (message.type === 'noteon') {
                held.add(message.data1);
                sustained.delete(message.data1);
            } else if (message.type === 'noteoff') {
                if (sustain) {
                    sustained.add(message.data1);
                } else {
                    held.delete(message.data1);
                    sustained.delete(message.data1);
                }
            } else if (message.type === 'cc' && message.data1 === 64) {
                sustain = message.data2 >= 64;
                if (!sustain) sustained.clear();
                setSustainActive(sustain);
            } else {
                return;
            }

            setLivePitches(Array.from(new Set([...held, ...sustained])).sort((left, right) => left - right));
        });
    }, [isOpen, tracks]);

    const handleSourceChange = useCallback((sourceId: string) => {
        const candidate = sourceCandidates.find((item) => item.id === sourceId);
        if (candidate) onSelectSource(candidate.trackId, candidate.clipId);
    }, [onSelectSource, sourceCandidates]);

    const commitEditableNotes = useCallback((nextNotes: Note[]) => {
        if (!currentWorkspace || !sourceClipContext) return;
        const normalizedNextNotes = normalizeClipNotes(nextNotes);
        const notesForClip = currentWorkspace.source.kind === 'audio-derived' && scoreClipTransportContext
            ? normalizeScoreNotesToAudibleClipWindow(normalizedNextNotes, {
                ...scoreClipTransportContext,
                noteTimeDomain: 'clip-local'
            })
            : normalizedNextNotes;
        const payload: PianoScoreMidiCommitPayload = {
            notes: notesForClip,
            clipName: currentWorkspace.source.kind === 'audio-derived'
                ? `SCORE DRAFT - ${sourceClipContext.track.name}`
                : sourceClipContext.clip.name,
            sourceTrackId: sourceClipContext.track.id,
            sourceClipId: sourceClipContext.clip.id
        };

        if (currentWorkspace.source.kind === 'midi') {
            onUpdateMidiClip(sourceClipContext.track.id, sourceClipContext.clip.id, payload);
            return;
        }

        if (currentWorkspace.source.derivedMidiTrackId && currentWorkspace.source.derivedMidiClipId) {
            onUpdateMidiClip(currentWorkspace.source.derivedMidiTrackId, currentWorkspace.source.derivedMidiClipId, payload);
            return;
        }

        setDraftNotes(payload.notes);
    }, [currentWorkspace, onUpdateMidiClip, scoreClipTransportContext, sourceClipContext]);

    const handleNoteUpdate = useCallback((noteIndex: number, nextNote: Note) => {
        const nextNotes = workingNotes.map((note, index) => index === noteIndex ? nextNote : note);
        commitEditableNotes(nextNotes);
    }, [commitEditableNotes, workingNotes]);

    const handleFollowTransportChange = useCallback((followTransport: boolean) => {
        setWorkspace((workspace) => ({
            ...workspace,
            layout: { ...workspace.layout, followTransport }
        }));
    }, [setWorkspace]);

    const handleResetOverrides = useCallback(() => {
        setWorkspace((workspace) => ({ ...workspace, notationOverrides: [] }));
    }, [setWorkspace]);

    const upsertNoteOverride = useCallback((patch: Partial<ScoreNotationOverride>) => {
        if (!selectedNoteKey) return;
        setWorkspace((workspace) => {
            const existing = workspace.notationOverrides.find((override) => override.noteKey === selectedNoteKey);
            const nextOverride: ScoreNotationOverride = {
                id: existing?.id || `score-override-${Date.now()}`,
                noteKey: selectedNoteKey,
                hand: patch.hand ?? existing?.hand,
                spelling: patch.spelling ?? existing?.spelling,
                voice: patch.voice ?? existing?.voice,
                tieStart: typeof patch.tieStart === 'boolean' ? patch.tieStart : existing?.tieStart,
                tieEnd: typeof patch.tieEnd === 'boolean' ? patch.tieEnd : existing?.tieEnd,
                pedal: typeof patch.pedal === 'boolean' ? patch.pedal : existing?.pedal
            };

            const nextOverrides = workspace.notationOverrides.filter((override) => override.noteKey !== selectedNoteKey);
            const hasMeaningfulValue = Boolean(
                nextOverride.hand
                || nextOverride.spelling
                || nextOverride.voice
                || typeof nextOverride.tieStart === 'boolean'
                || typeof nextOverride.tieEnd === 'boolean'
                || typeof nextOverride.pedal === 'boolean'
            );

            return {
                ...workspace,
                notationOverrides: hasMeaningfulValue ? [...nextOverrides, nextOverride] : nextOverrides
            };
        });
    }, [selectedNoteKey, setWorkspace]);

    const handleSeekToTimeline16th = useCallback((timeline16th: number) => {
        const globalTimeline16th = scoreClipTransportContext
            ? scoreSource16thToGlobalTimeline16th(timeline16th, scoreClipTransportContext)
            : timeline16th;
        const barTime = timeline16thToBarTime(
            globalTimeline16th,
            scoreClipTransportContext ? [4, 4] : transport.timeSignature
        );
        void onSeekToBarTime(barTime);
    }, [onSeekToBarTime, scoreClipTransportContext, transport.timeSignature]);

    const handleCancelTranscription = useCallback(() => {
        if (!transcriptionAbortRef.current) return;
        transcriptionRequestIdRef.current += 1;
        transcriptionAbortRef.current.abort();
        transcriptionAbortRef.current = null;
        setIsScanning(false);
        setScanError(null);
        setScanProgressMessage('Transcripcion cancelada. Puedes volver a analizar cuando quieras.');
    }, []);

    const handleCloseWorkspace = useCallback(() => {
        transcriptionRequestIdRef.current += 1;
        transcriptionAbortRef.current?.abort();
        transcriptionAbortRef.current = null;
        setIsScanning(false);
        onClose();
    }, [onClose]);

    const handleRunTranscription = useCallback(async () => {
        if (!sourceClipContext || sourceClipContext.track.type !== TrackType.AUDIO || !sourceClipContext.clip.buffer) {
            setScanError('Selecciona un clip de audio de piano con buffer cargado.');
            return;
        }

        transcriptionAbortRef.current?.abort();
        const controller = new AbortController();
        const requestId = transcriptionRequestIdRef.current + 1;
        transcriptionRequestIdRef.current = requestId;
        transcriptionAbortRef.current = controller;
        setScanError(null);
        setIsScanning(true);
        setScanProgressMessage('Preparando transcripcion de piano...');
        try {
            const result = await pianoTranscriptionService.transcribeAudioBuffer(
                sourceClipContext.clip.buffer,
                transport.bpm,
                {},
                (progress) => {
                    if (requestId !== transcriptionRequestIdRef.current || controller.signal.aborted) return;
                    setScanProgressMessage(progress.message);
                },
                controller.signal
            );
            if (requestId !== transcriptionRequestIdRef.current || controller.signal.aborted) return;
            const clipLocalNotes = scoreClipTransportContext
                ? normalizeScoreNotesToAudibleClipWindow(result.notes, {
                    ...scoreClipTransportContext,
                    noteTimeDomain: 'source-grid',
                    noteGridBpm: transport.bpm
                })
                : result.notes;
            setTranscriptionGridBpm(transport.bpm);
            setDraftNotes(clipLocalNotes);
            setWorkspace((workspace) => ({
                ...workspace,
                mode: 'transcribe',
                confidenceRegions: result.confidenceRegions,
                lastAverageConfidence: result.averageConfidence
            }));
        } catch (error) {
            if (requestId !== transcriptionRequestIdRef.current) return;
            if (controller.signal.aborted || isAbortError(error)) {
                setScanError(null);
                setScanProgressMessage('Transcripcion cancelada. Puedes volver a analizar cuando quieras.');
                return;
            }
            console.error('Piano transcription failed', error);
            setScanError(error instanceof Error ? error.message : 'No se pudo transcribir el clip.');
        } finally {
            if (requestId === transcriptionRequestIdRef.current) {
                transcriptionAbortRef.current = null;
                setIsScanning(false);
            }
        }
    }, [scoreClipTransportContext, setWorkspace, sourceClipContext, transport.bpm]);

    const handleCommitMidi = useCallback(() => {
        if (!currentWorkspace || !sourceClipContext) return;
        const pendingNotes = draftNotes || workingNotes;
        const notesToCommit = currentWorkspace.source.kind === 'audio-derived' && scoreClipTransportContext
            ? normalizeScoreNotesToAudibleClipWindow(pendingNotes, {
                ...scoreClipTransportContext,
                noteTimeDomain: 'clip-local'
            })
            : pendingNotes;
        if (notesToCommit.length === 0) {
            setScanError('No hay notas listas para convertir a partitura o MIDI.');
            return;
        }

        const payload: PianoScoreMidiCommitPayload = {
            notes: normalizeClipNotes(notesToCommit),
            clipName: currentWorkspace.source.kind === 'audio-derived'
                ? `SCORE DRAFT - ${sourceClipContext.track.name}`
                : sourceClipContext.clip.name,
            sourceTrackId: sourceClipContext.track.id,
            sourceClipId: sourceClipContext.clip.id
        };

        if (currentWorkspace.source.kind === 'midi') {
            onUpdateMidiClip(sourceClipContext.track.id, sourceClipContext.clip.id, payload);
            return;
        }

        if (currentWorkspace.source.derivedMidiTrackId && currentWorkspace.source.derivedMidiClipId) {
            onUpdateMidiClip(currentWorkspace.source.derivedMidiTrackId, currentWorkspace.source.derivedMidiClipId, payload);
            setDraftNotes(null);
            return;
        }

        const created = onCreateMidiTrackFromScore(payload, { trackName: `SCORE DRAFT - ${sourceClipContext.track.name}` });
        if (!created) return;
        setWorkspace((workspace) => ({
            ...workspace,
            mode: 'correct',
            source: {
                ...workspace.source,
                derivedMidiTrackId: created.trackId,
                derivedMidiClipId: created.clipId
            }
        }));
        setDraftNotes(null);
    }, [currentWorkspace, draftNotes, onCreateMidiTrackFromScore, onUpdateMidiClip, scoreClipTransportContext, setWorkspace, sourceClipContext, workingNotes]);

    const handleSplitResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (!rootRef.current || !currentWorkspace) return;
        const startY = event.clientY;
        const totalHeight = rootRef.current.getBoundingClientRect().height;
        const initialRatio = currentWorkspace.layout.splitRatio;

        const handlePointerMove = (moveEvent: PointerEvent) => {
            const nextRatio = clamp(initialRatio + ((moveEvent.clientY - startY) / totalHeight), 0.34, 0.78);
            setWorkspace((workspace) => ({
                ...workspace,
                layout: {
                    ...workspace.layout,
                    splitRatio: nextRatio
                }
            }));
        };

        const handlePointerUp = () => {
            window.removeEventListener('pointermove', handlePointerMove);
            window.removeEventListener('pointerup', handlePointerUp);
        };

        window.addEventListener('pointermove', handlePointerMove);
        window.addEventListener('pointerup', handlePointerUp);
    }, [currentWorkspace, setWorkspace]);

    if (!currentWorkspace || !selectedTrack || !selectedClip) {
        return (
            <div className="flex h-full w-full items-center justify-center bg-[#0b0d12] px-3 text-gray-300 sm:px-6">
                <div className="w-full max-w-2xl rounded-sm border border-white/10 bg-[#11131a] p-4 shadow-2xl sm:p-6">
                    <div className="flex items-start justify-between gap-4 border-b border-daw-border pb-4">
                        <div className="flex items-start gap-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-sm border border-daw-violet/30 bg-daw-violet/10 text-daw-violet">
                                <Music2 size={18} />
                            </div>
                            <div>
                                <div className="text-[10px] uppercase tracking-[0.22em] text-gray-500">{productTitle}</div>
                                <div className="mt-1 text-lg font-semibold text-white">Selecciona una fuente musical</div>
                                <p className="mt-2 max-w-xl text-sm leading-6 text-gray-400">
                                    El editor de partitura trabaja directo sobre clips MIDI y sobre drafts derivados desde audio de piano.
                                </p>
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={handleCloseWorkspace}
                            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm border border-white/10 bg-white/5 text-gray-400 hover:border-white/30 hover:text-white md:h-8 md:w-8"
                            title={`Cerrar ${productTitle}`}
                            aria-label={`Cerrar ${productTitle}`}
                        >
                            <X size={14} />
                        </button>
                    </div>

                    {sourceCandidates.length > 0 ? (
                        <div className="mt-5 flex flex-wrap items-center gap-3">
                            <select
                                value=""
                                onChange={(event) => handleSourceChange(event.target.value)}
                                className="h-11 min-w-0 w-full flex-1 rounded-sm border border-white/10 bg-[#0b1018] px-3 text-sm text-gray-200 outline-none focus:border-daw-violet/50 md:h-10 md:w-auto md:min-w-[320px]"
                            >
                                <option value="" disabled>Elegir clip MIDI o audio de piano...</option>
                                {sourceCandidates.map((candidate) => (
                                    <option key={candidate.id} value={candidate.id}>{candidate.label}</option>
                                ))}
                            </select>
                            <div className="rounded-sm border border-white/10 bg-[#131620] px-3 py-2 text-[11px] text-gray-400">
                                Abre una fuente y el workspace se configura solo para partitura, transcripcion y correccion.
                            </div>
                        </div>
                    ) : (
                        <div className="mt-5 rounded-sm border border-dashed border-white/15 bg-[#0f1219] px-4 py-4 text-sm text-gray-500">
                            No hay clips MIDI ni clips de audio listos para {productTitle} todavía.
                        </div>
                    )}
                </div>
            </div>
        );
    }

    const activeSourceId = `${selectedTrack.id}:${selectedClip.id}`;
    const total16ths = scoreDocument?.total16ths || Math.max(16, workingNotes.reduce((maxEnd, note) => Math.max(maxEnd, note.start + note.duration), 16));
    const isAudioSource = currentWorkspace.source.kind === 'audio-derived';
    const hasSourceBuffer = Boolean(sourceClipContext?.clip.buffer);
    const hasDraftNotes = Boolean(draftNotes && draftNotes.length > 0);
    const hasDerivedMidiTarget = Boolean(currentWorkspace.source.derivedMidiTrackId && currentWorkspace.source.derivedMidiClipId);
    const hasWorkingNotes = workingNotes.length > 0;
    const splitRatio = hasWorkingNotes
        ? Math.min(currentWorkspace.layout.splitRatio, isAudioSource ? 0.44 : 0.5)
        : currentWorkspace.layout.splitRatio;
    const sourceModeLabel = isAudioSource ? 'Audio Piano' : 'MIDI Piano';
    const canTranscribe = Boolean(isAudioSource && hasSourceBuffer);

    const confidenceLabel = currentWorkspace.lastAverageConfidence === undefined
        ? 'Sin lectura'
        : `${Math.round(currentWorkspace.lastAverageConfidence * 100)}%`;

    const confidenceClass = currentWorkspace.lastAverageConfidence === undefined
        ? 'border-white/10 bg-[#151824] text-gray-400'
        : currentWorkspace.lastAverageConfidence >= 0.75
            ? 'border-cyan-400/35 bg-cyan-500/10 text-cyan-200'
            : 'border-amber-400/35 bg-amber-500/10 text-amber-200';

    const targetMidiLabel = !isAudioSource
        ? 'Clip fuente'
        : hasDerivedMidiTarget
            ? 'Draft vinculado'
            : hasDraftNotes
                ? 'Pendiente de commit'
                : 'Sin destino';

    let workflowTitle = 'Partitura conectada';
    let workflowHint = 'Las ediciones de Keys-fi actualizan directamente el clip MIDI seleccionado.';
    let emptyTitle = 'Clip MIDI vacio';
    let emptyMessage = 'Graba o dibuja notas en el clip para ver la partitura y el visualizador en tiempo real.';

    if (isAudioSource) {
        emptyTitle = 'Aun no hay draft de piano';
        emptyMessage = hasSourceBuffer
            ? 'Haz click en Analizar piano para generar un borrador MIDI sin tocar el audio original.'
            : 'Este clip no tiene buffer cargado. Importa o recarga el audio para transcribirlo.';

        if (isScanning) {
            workflowTitle = 'Analizando piano...';
            workflowHint = scanProgressMessage || 'Extrayendo notas, agrupando acordes y preparando el draft para piano.';
        } else if (scanError) {
            workflowTitle = 'Revision requerida';
            workflowHint = scanError;
        } else if (hasDraftNotes && hasDerivedMidiTarget) {
            workflowTitle = 'Draft actualizado, listo para sincronizar';
            workflowHint = 'Revisa el resultado y aplica Commit MIDI para sobreescribir el clip derivado sin tocar el audio.';
        } else if (hasDraftNotes) {
            workflowTitle = 'Draft listo para commit';
            workflowHint = 'Ya existe un borrador de partitura. Commit MIDI crea el clip SCORE DRAFT derivado y lo deja listo para editar.';
        } else if (hasDerivedMidiTarget) {
            workflowTitle = 'Audio protegido, draft sincronizado';
            workflowHint = 'El audio original queda intacto. Toda correccion futura se escribe sobre el clip MIDI derivado.';
        } else {
            workflowTitle = hasSourceBuffer ? 'Listo para transcribir piano' : 'Clip sin audio utilizable';
            workflowHint = hasSourceBuffer
                ? 'Un solo click analiza el piano, genera un draft MIDI y abre el flujo de correccion.'
                : 'Necesitas un clip de audio de piano con buffer cargado para arrancar.';
        }
    } else if (hasWorkingNotes) {
        workflowTitle = 'Edicion directa sobre clip MIDI';
        workflowHint = 'No necesitas commit adicional. Mueve notas abajo o corrige notacion arriba y todo queda sincronizado.';
    }

    const selectedNoteSummary = selectedScoreEvent
        ? `${selectedScoreEvent.spelling || `Pitch ${selectedScoreEvent.pitch}`} | Voz ${selectedScoreEvent.voice} | ${selectedScoreEvent.hand === 'left' ? 'Mano izquierda' : 'Mano derecha'}`
        : null;

    const showPrimaryAnalyze = isAudioSource && (!hasDraftNotes || hasDerivedMidiTarget);
    const showPrimaryCommit = isAudioSource && hasWorkingNotes;

    return (
        <div ref={rootRef} className="flex h-full w-full flex-col bg-[#0b0d12] text-white">
            <div className="h-12 shrink-0 border-b border-daw-border bg-[#18181b] px-3 md:h-10">
                <div className="flex h-full items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                        <div className="flex min-w-0 items-center gap-2 rounded-sm bg-black/20 py-0.5 pr-3">
                            <div
                                className="h-4 w-2 shrink-0 rounded-sm"
                                style={{ backgroundColor: selectedTrack.color }}
                            />
                            <span className="truncate text-xs font-bold uppercase tracking-wide text-gray-200">
                                {selectedTrack.name}
                            </span>
                        </div>
                        <div className="hidden h-4 w-px shrink-0 bg-daw-border sm:block" />
                        <div className="hidden min-w-0 sm:block">
                            <div className="text-[10px] uppercase tracking-[0.22em] text-gray-500">{productTitle}</div>
                            <div className="truncate text-[11px] text-gray-300">{selectedClip.name}</div>
                        </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                        <span className={`rounded-sm border px-2 py-1 text-[9px] font-bold uppercase tracking-wider ${isAudioSource ? 'border-amber-400/35 bg-amber-500/10 text-amber-200' : 'border-cyan-400/35 bg-cyan-500/10 text-cyan-200'}`}>
                            {sourceModeLabel}
                        </span>
                        {livePitches.length > 0 && (
                            <span className="rounded-sm border border-emerald-400/35 bg-emerald-500/10 px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-emerald-200">
                                MIDI In
                            </span>
                        )}
                        <button
                            type="button"
                            onClick={handleCloseWorkspace}
                            className="flex h-11 w-11 items-center justify-center rounded-sm border border-white/10 bg-white/5 text-gray-400 hover:border-white/30 hover:text-white md:h-8 md:w-8"
                            title={`Cerrar ${productTitle}`}
                            aria-label={`Cerrar ${productTitle}`}
                        >
                            <X size={14} />
                        </button>
                    </div>
                </div>
            </div>

            <div className="shrink-0 border-b border-daw-border bg-[#11131a] px-2 py-2 md:px-4 md:py-2.5">
                {showSurfaceTabs && <div className="mb-2 grid grid-cols-2 gap-1 md:hidden" role="tablist" aria-label="Vistas de Score-fi y Keys-fi">
                    <button
                        type="button"
                        id={`${mobileTabsIdPrefix}-score-tab`}
                        role="tab"
                        aria-selected={mobilePanel === 'score'}
                        aria-controls={`${mobileTabsIdPrefix}-score-panel`}
                        onClick={() => setMobilePanel('score')}
                        className={`${buttonBase} justify-center ${mobilePanel === 'score' ? 'border-white/30 bg-white/10 text-white' : 'border-white/10 bg-[#151824] text-gray-400'}`}
                    >
                        Partitura
                    </button>
                    <button
                        type="button"
                        id={`${mobileTabsIdPrefix}-keys-tab`}
                        role="tab"
                        aria-selected={mobilePanel === 'keys'}
                        aria-controls={`${mobileTabsIdPrefix}-keys-panel`}
                        onClick={() => setMobilePanel('keys')}
                        className={`${buttonBase} justify-center ${mobilePanel === 'keys' ? 'border-white/30 bg-white/10 text-white' : 'border-white/10 bg-[#151824] text-gray-400'}`}
                    >
                        Keys-fi
                    </button>
                </div>}

                <div className="-mx-1 touch-pan-x overflow-x-auto overscroll-x-contain pb-1 [scrollbar-width:thin]">
                    <div className="flex min-w-max items-center gap-2 px-1">
                    <select
                        value={activeSourceId}
                        onChange={(event) => handleSourceChange(event.target.value)}
                        disabled={isScanning}
                        aria-label="Fuente musical de Score-fi y Keys-fi"
                        className="h-11 w-[min(78vw,320px)] min-w-[240px] rounded-sm border border-white/10 bg-[#0b1018] px-3 text-xs text-gray-200 outline-none focus:border-daw-violet/50 disabled:cursor-not-allowed disabled:opacity-45 md:h-9 md:w-auto md:min-w-[320px]"
                    >
                        {sourceCandidates.map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>{candidate.label}</option>
                        ))}
                    </select>

                    <label className="flex h-11 shrink-0 items-center gap-2 rounded-sm border border-white/10 bg-[#151824] px-3 text-[10px] font-bold uppercase tracking-wider text-gray-300 md:h-8">
                        <input
                            type="checkbox"
                            checked={currentWorkspace.layout.followTransport}
                            onChange={(event) => handleFollowTransportChange(event.target.checked)}
                            className="accent-daw-cyan"
                        />
                        Seguir transporte
                    </label>

                    <div className={`rounded-sm border px-2 py-1 text-[9px] font-bold uppercase tracking-wider ${confidenceClass}`}>
                        Confianza detector {confidenceLabel}
                    </div>

                    <div className="rounded-sm border border-white/10 bg-[#151824] px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-gray-400">
                        Destino MIDI {targetMidiLabel}
                    </div>

                    <button onClick={() => void onPlay()} className={subtleButtonClass}>
                        <Play size={14} />
                        Play
                    </button>
                    <button onClick={() => void onPause()} className={subtleButtonClass}>
                        <Pause size={14} />
                        Pause
                    </button>
                    <button onClick={() => void onStop()} className={subtleButtonClass}>
                        <Square size={14} />
                        Stop
                    </button>

                    {showPrimaryAnalyze && (
                        <button
                            onClick={handleRunTranscription}
                            disabled={isScanning || !canTranscribe}
                            className={secondaryAccentButtonClass}
                        >
                            {isScanning ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
                            {isScanning ? 'Analizando...' : hasDerivedMidiTarget ? 'Reanalizar Piano' : 'Analizar Piano'}
                        </button>
                    )}

                    {isScanning && (
                        <button
                            onClick={handleCancelTranscription}
                            className={dangerButtonClass}
                            aria-label="Cancelar transcripcion de piano"
                        >
                            <X size={14} />
                            Cancelar analisis
                        </button>
                    )}

                    {showPrimaryCommit && (
                        <button
                            onClick={handleCommitMidi}
                            disabled={!hasWorkingNotes}
                            className={successButtonClass}
                        >
                            Commit MIDI
                        </button>
                    )}

                    <button onClick={() => setDraftNotes(null)} className={subtleButtonClass}>
                        <RefreshCcw size={14} />
                        Rebuild Score
                    </button>
                    <button onClick={handleResetOverrides} className={dangerButtonClass}>
                        <RotateCcw size={14} />
                        Reset Overrides
                    </button>
                    </div>
                </div>

                <div className="mt-1 flex touch-pan-x items-center gap-2 overflow-x-auto overscroll-x-contain pb-1 text-[11px] [scrollbar-width:thin] md:mt-2 md:flex-wrap">
                    <div className="rounded-sm border border-white/10 bg-[#151824] px-3 py-1.5 text-gray-300">
                        {workflowTitle}
                    </div>
                    <div className={`rounded-sm border px-3 py-1.5 ${scanError ? 'border-rose-400/25 bg-rose-500/10 text-rose-200' : isScanning ? 'border-cyan-400/25 bg-cyan-500/10 text-cyan-200' : 'border-white/10 bg-[#131620] text-gray-400'}`}>
                        {scanError || scanProgressMessage || workflowHint}
                    </div>

                    {selectedScoreEvent && (
                        <>
                            <div className="rounded-sm border border-white/10 bg-[#131620] px-3 py-1.5 text-gray-300">
                                {selectedNoteSummary}
                            </div>
                            <button
                                onClick={() => upsertNoteOverride({ hand: 'left' })}
                                className={`${buttonBase} ${selectedScoreEvent.hand === 'left' ? 'border-cyan-400/35 bg-cyan-500/10 text-cyan-200' : 'border-white/15 bg-[#151824] text-gray-300 hover:text-white hover:border-white/30'}`}
                            >
                                Mano Izq
                            </button>
                            <button
                                onClick={() => upsertNoteOverride({ hand: 'right' })}
                                className={`${buttonBase} ${selectedScoreEvent.hand === 'right' ? 'border-cyan-400/35 bg-cyan-500/10 text-cyan-200' : 'border-white/15 bg-[#151824] text-gray-300 hover:text-white hover:border-white/30'}`}
                            >
                                Mano Der
                            </button>
                            <button
                                onClick={() => upsertNoteOverride({ pedal: !(selectedScoreEvent.pedalDown ?? false) })}
                                className={`${buttonBase} ${selectedScoreEvent.pedalDown ? 'border-amber-400/35 bg-amber-500/10 text-amber-200' : 'border-white/15 bg-[#151824] text-gray-300 hover:text-white hover:border-white/30'}`}
                            >
                                Pedal
                            </button>
                        </>
                    )}
                </div>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden p-2 md:p-3">
                <div
                    className={`h-full gap-2 ${showSurfaceTabs ? 'md:grid' : 'block'}`}
                    style={showSurfaceTabs ? { gridTemplateRows: `${Math.round(splitRatio * 100)}% 12px minmax(220px, 1fr)` } : undefined}
                >
                    {showScoreSurface && <div
                        id={`${mobileTabsIdPrefix}-score-panel`}
                        role={showSurfaceTabs ? 'tabpanel' : 'region'}
                        aria-labelledby={showSurfaceTabs ? `${mobileTabsIdPrefix}-score-tab` : undefined}
                        aria-label={showSurfaceTabs ? undefined : 'Score-fi'}
                        className={`${!showSurfaceTabs || mobilePanel === 'score' ? 'block' : 'hidden'} h-full min-h-0 ${showSurfaceTabs ? 'md:block' : ''}`}
                    >
                        <ScoreViewport
                            document={scoreDocument}
                            playhead16th={transportFrame.playhead16th}
                            bpm={transport.bpm}
                            isPlaying={transportClock.isPlaying}
                            selectedNoteKey={selectedNoteKey}
                            followTransport={currentWorkspace.layout.followTransport}
                            zoom={currentWorkspace.layout.zoom}
                            emptyTitle={emptyTitle}
                            emptyMessage={emptyMessage}
                            onSelectNoteKey={setSelectedNoteKey}
                            onSeekToTimeline16th={handleSeekToTimeline16th}
                        />
                    </div>}

                    {showSurfaceTabs && <div
                        onPointerDown={handleSplitResizeStart}
                        className="hidden w-full cursor-row-resize items-center justify-center rounded-sm border border-white/10 bg-[#11131a] md:flex"
                    >
                        <div className="h-px w-16 bg-white/20" />
                    </div>}

                    {showKeysSurface && <div
                        id={`${mobileTabsIdPrefix}-keys-panel`}
                        role={showSurfaceTabs ? 'tabpanel' : 'region'}
                        aria-labelledby={showSurfaceTabs ? `${mobileTabsIdPrefix}-keys-tab` : undefined}
                        aria-label={showSurfaceTabs ? undefined : 'Keys-fi'}
                        className={`${!showSurfaceTabs || mobilePanel === 'keys' ? 'block' : 'hidden'} h-full min-h-0 ${showSurfaceTabs ? 'md:block' : ''}`}
                    >
                        <PianoCinema
                            notes={workingNotes}
                            playhead16th={transportFrame.playhead16th}
                            bpm={transport.bpm}
                            isPlaying={transportClock.isPlaying}
                            total16ths={total16ths}
                            selectedNoteKey={selectedNoteKey}
                            activeNoteIndexes={transportFrame.activeNoteIndexes}
                            livePitches={livePitches}
                            sustainActive={sustainActive}
                            zoom={currentWorkspace.layout.zoom}
                            emptyTitle={emptyTitle}
                            emptyMessage={emptyMessage}
                            onSelectNoteKey={setSelectedNoteKey}
                            onSeekToTimeline16th={handleSeekToTimeline16th}
                            onUpdateNote={handleNoteUpdate}
                        />
                    </div>}
                </div>
            </div>
        </div>
    );
};

export default React.memo(PianoScoreWorkspace);
