// path: src/App.tsx
import './index.css';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Transport from './components/Transport';
import DeviceRack from './components/DeviceRack';
import Timeline from './components/Timeline';
import Mixer from './components/Mixer';
import Editor, { type EditorTransportView } from './components/Editor';
import Browser from './components/Browser';
import TakeLanesPanel from './components/TakeLanesPanel';
import type { PianoScoreMidiCommitPayload } from './components/PianoScoreWorkspace';
import AppLogo from './components/AppLogo';
import SessionView from './components/SessionView';
import Modal from './components/Modal';
import { FluidPanel } from './components/FluidPanel';
import AsciiPerformerDock from './components/AsciiPerformerDock';
import CollabPanel, { CollabActivityEntry } from './components/CollabPanel';
import { MiniAuthPanel } from './components/MiniAuthPanel';
import { INITIAL_TRACKS, getTrackColorByPosition } from './constants';
import { LoopMode, Note, SessionHealthSnapshot, StudioPerformanceProfile, Track, TransportState, TrackType, AudioSettings, Clip, ProjectData, AutomationMode, ScannedFileEntry, PunchRange, TransportAuthoritySnapshot, MonitoringRouteMode, RecordingCommitResult, RecordingJournalEntry, AutomationRuntimeFrame, AudioIncidentWindow, DiagnosticsVisibilityMode, VisualPerformanceSnapshot, AudioClipEditorViewState, ScoreWorkspaceState } from './types';
import { engineAdapter, type EngineDiagnostics } from './services/engineAdapter';
import { midiService, MidiDevice } from './services/MidiService';
import { platformService } from './services/platformService';
import { assetDb } from './services/db';
import {
    AUDIO_IMPORT_ACCEPT,
    describeAudioImportFormats,
    isSupportedAudioImportName
} from './services/audioImportContract';
import {
    createTrack,
    removeTrackRoutingReferences,
    withTrackRuntimeDefaults
} from './services/projectCoreService';
import type { BrowserDragPayload } from './services/browserDragService';
import {
    AUTOMATION_TARGETS,
    denormalizeTrackParam,
    getLaneByParam,
    normalizeTrackParam,
    sampleAutomationLaneAtBar,
    writeAutomationPoint
} from './services/automationService';
import { sanitizeAudioSettingsCandidate } from './services/audioSettingsNormalizer';
import {
    CollabCommandRecord,
    loadCollabSessionSnapshot,
    saveCollabSessionSnapshot
} from './services/collabSessionService';
import {
    ProjectAutosaveSnapshot,
    clearAutosaveSnapshot,
    getLatestAutosaveSnapshot,
    saveAutosaveSnapshot,
    startRecoverySession,
    stopRecoverySession
} from './services/projectRecoveryService';
import {
    type ProjectIntegrityReport,
    repairProjectData,
    summarizeProjectIntegrityReport
} from './services/projectIntegrityService';
import {
    appendRecordingJournalPhase,
    createRecordingJournalEntry,
    getRecordingJournalAttentionEntries,
    loadRecordingJournalEntries,
    loadRecordingJournalRecoveryAcknowledgedAt,
    markRecordingJournalCommitted,
    markRecordingJournalFailed,
    pruneRecordingJournalEntries,
    recoverRecordingJournalEntries,
    saveRecordingJournalRecoveryAcknowledgedAt,
    saveRecordingJournalEntries,
    summarizeRecordingJournalAttentionEntries,
    summarizeRecordingJournalEntries
} from './services/recordingJournalService';
import {
    barTimeToPosition,
    barToSeconds,
    getLoopEndAction,
    getSecondsPerBar,
    positionToBarTime,
    shouldRestartAtSongBoundary
} from './services/transportStateService';
import {
    buildRecordingTakeCommit,
    commitRecordingTakeBatch
} from './services/recordingTakeService';
import {
    assessSessionOverload,
    assessVisualPerformance,
    buildAudioPriorityStabilityReport,
    createAudioPriorityController,
    type SessionOverloadDecision,
    type GlobalAudioPriorityDecision,
    type VisualPerformanceDecision
} from './services/sessionPerformanceService';
import {
    loadDiagnosticsVisibilityMode,
    saveDiagnosticsVisibilityMode,
    toggleDiagnosticsVisibilityMode
} from './services/diagnosticsVisibilityService';
import {
    createArtifactEnvelope,
    runLiveCaptureHarness
} from './services/liveCaptureHarnessService';
import {
    applyTrackClipEdits,
    normalizePunchRange,
    promoteTakeToComp,
    resolveTrackClipEditingContext,
    resolvePunchRecordingPlan,
    shouldFinalizePunchRecording,
    splitTakeForClip,
    syncTakeMetadataForClip,
    updateTrackPunchRange
} from './services/takeCompingService';
import {
    setTrackActiveCompLane,
    setTrackActiveTake,
    toggleTrackTakeMute,
    toggleTrackTakeSolo
} from './services/takeLaneControlService';
import { useUndoRedo } from './hooks/useUndoRedo';
import {
    FolderInput, Settings, Cpu, LayoutGrid, Search, Users, Layers, Sliders, Sparkles, AlertTriangle, Undo2, Redo2, PlayCircle, Folder, HardDrive, Save, Trash2, Piano, LogOut, UserCircle2, Share2, Cloud, CloudOff, X
} from 'lucide-react';
import { HardwareSettingsModal } from './components/HardwareSettingsModal';
import { ShareProjectModal } from './components/ShareProjectModal';
import { ProjectOsPanel } from './components/ProjectOsPanel';
import { audioEngine } from './services/audioEngine';
import { supabase } from './services/supabase';
import {
    getTransportClockSnapshot,
    setTransportClockSnapshot
} from './services/transportClockStore';
import { useAuthStore } from './stores/authStore';
import { resolveTier } from '@hollowbits/core';

const AISidebar = React.lazy(() => import('./components/AISidebar'));
const PianoScoreWorkspace = React.lazy(() => import('./components/PianoScoreWorkspace'));
const ExportModal = React.lazy(() => import('./components/ExportModal'));

const TRACK_COLOR_GRADIENT_TARGET = 48;
const PERFORMANCE_PROFILE: StudioPerformanceProfile = 'stage-safe';
const SESSION_LAUNCH_LATEST_REPORT_STORAGE_KEY = 'hollowbits.session-launch.latest-report.v1';
const AUDIO_PRIORITY_TRANSITIONS_STORAGE_KEY = 'hollowbits.audio-priority.transitions.v1';
const AUDIO_INCIDENT_RESET_COOLDOWN_MS = 3000;
const VISUAL_PERFORMANCE_WARMUP_MS = 1000;
const VISUAL_PERFORMANCE_WINDOW_MS = 5000;
const createAudioIncidentWindow = (
    dropoutCount = 0,
    underrunCount = 0,
    active = false,
    now = Date.now()
): AudioIncidentWindow => ({
    active,
    windowStartedAt: now,
    baselineDropoutCount: Math.max(0, Math.floor(dropoutCount)),
    baselineUnderrunCount: Math.max(0, Math.floor(underrunCount)),
    lastCounterChangeAt: null,
    dropoutsDeltaWindow: 0,
    underrunsDeltaWindow: 0
});

// --- ATOMIC COMPONENTS (Extracted for Performance) ---

interface SidebarItemProps {
    icon: React.ElementType;
    label: string;
    active?: boolean;
    onClick: () => void;
    color?: string;
}

const SidebarItem: React.FC<SidebarItemProps> = React.memo(({ icon: Icon, label, active = false, onClick, color }) => (
    <button
        onClick={onClick}
        className={`w-10 h-10 flex items-center justify-center relative group rounded-sm transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]
          ${active
                ? 'bg-gradient-to-br from-purple-500/20 to-rose-500/20 text-white shadow-[0_0_20px_rgba(168,85,247,0.15)] ring-1 ring-white/10 scale-100'
                : 'text-gray-500 hover:text-white hover:bg-white/5 hover:scale-105 active:scale-95'
            }
      `}
        title={label}
    >
        {/* Active Indicator Strip */}
        {active && (
            <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 bg-gradient-to-b from-purple-500 to-rose-500 rounded-r-full shadow-[0_0_8px_rgba(244,63,94,0.6)] animate-in fade-in duration-300"></span>
        )}

        {/* Hover Gradient Overlay */}
        {!active && (
            <div className="absolute inset-0 bg-gradient-to-tr from-purple-500/10 to-rose-500/10 opacity-0 group-hover:opacity-100 rounded-sm transition-opacity duration-300 pointer-events-none" />
        )}

        <Icon
            size={18}
            strokeWidth={active ? 2 : 1.5}
            className={`transition-all duration-300 relative z-10 ${active ? 'text-white drop-shadow-[0_0_5px_rgba(255,255,255,0.5)]' : color || 'text-current group-hover:text-purple-200'}`}
        />
    </button>
));

const getNextLoopMode = (mode: LoopMode): LoopMode => {
    if (mode === 'off') return 'once';
    if (mode === 'once') return 'infinite';
    return 'off';
};

const normalizeLoopMode = (transport: Partial<TransportState>): LoopMode => {
    if (transport.loopMode === 'off' || transport.loopMode === 'once' || transport.loopMode === 'infinite') {
        return transport.loopMode;
    }
    if (transport.isLooping) return 'infinite';
    return 'off';
};

interface ImportAudioSource {
    name: string;
    load: () => Promise<{
        arrayBuffer: ArrayBuffer;
        persistBlob?: Blob;
    }>;
}

interface ClipDropDestination {
    trackId?: string;
    bar?: number;
    sceneIndex?: number;
    placeInSession?: boolean;
}

type MixSnapshotSlot = 'A' | 'B';

interface TrackMixSnapshot {
    volume: number;
    pan: number;
    reverb: number;
    isMuted: boolean;
    isSoloed: boolean;
    monitor: Track['monitor'];
    sends?: Record<string, number>;
    sendModes?: Record<string, 'pre' | 'post'>;
    groupId?: string;
    vcaGroupId?: string;
    soloSafe?: boolean;
}

interface MixSnapshot {
    capturedAt: number;
    masterVolumeDb: number;
    tracks: Record<string, TrackMixSnapshot>;
}

interface RecordingSessionMeta {
    journalId: string;
    monitorMode: MonitoringRouteMode;
    recordingStartBar: number;
    latencyCompensationBars: number;
    sourceTrimOffsetBars?: number;
    punchOutBar?: number;
}

type ToolPanel = 'browser' | 'ai' | 'scanner' | null;

const AUDIO_SETTINGS_STORAGE_KEY = 'hollowbits.audio-settings.v1';
const AUDIO_SETTINGS_STORAGE_KEY_LEGACY = 'ethereal.audio-settings.v1';
const AUDIO_EFFECTIVE_SETTINGS_STORAGE_KEY = 'hollowbits.audio-effective-settings.v1';
const AUDIO_EFFECTIVE_SETTINGS_STORAGE_KEY_LEGACY = 'ethereal.audio-effective-settings.v1';
const BLOCK1_KPI_STORAGE_KEY = 'hollowbits.block1-kpi.v1';
const MIN_CLIP_LENGTH_BARS = 0.0625;
const AUTOSAVE_DEBOUNCE_MS = 1200;
// Long multitrack stems can each occupy hundreds of MB once decoded. Reading
// them one at a time avoids duplicating an entire selection in renderer memory.
const IMPORT_AUDIO_CONCURRENCY = 1;

const buildRuntimeId = (prefix: string): string => {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
};

const getDefaultAudioSettings = (): AudioSettings => ({
    sampleRate: 48000,
    bufferSize: 'auto',
    latencyHint: 'interactive'
});

const sanitizeAudioSettings = (candidate: Partial<AudioSettings> | null | undefined): AudioSettings => {
    const defaults = getDefaultAudioSettings();
    return sanitizeAudioSettingsCandidate(candidate, defaults);
};

const loadAudioSettingsFromStorage = (): AudioSettings => {
    try {
        const raw = localStorage.getItem(AUDIO_SETTINGS_STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as Partial<AudioSettings>;
            return sanitizeAudioSettings(parsed);
        }

        const legacyRaw = localStorage.getItem(AUDIO_SETTINGS_STORAGE_KEY_LEGACY);
        if (!legacyRaw) return getDefaultAudioSettings();

        const parsedLegacy = sanitizeAudioSettings(JSON.parse(legacyRaw) as Partial<AudioSettings>);
        localStorage.setItem(AUDIO_SETTINGS_STORAGE_KEY, JSON.stringify(parsedLegacy));
        localStorage.removeItem(AUDIO_SETTINGS_STORAGE_KEY_LEGACY);
        return parsedLegacy;
    } catch (error) {
        console.warn('No se pudieron leer preferencias de audio guardadas.', error);
        return getDefaultAudioSettings();
    }
};

const migrateLegacyEffectiveAudioSettings = (): void => {
    try {
        if (localStorage.getItem(AUDIO_EFFECTIVE_SETTINGS_STORAGE_KEY)) {
            localStorage.removeItem(AUDIO_EFFECTIVE_SETTINGS_STORAGE_KEY_LEGACY);
            return;
        }

        const legacyRaw = localStorage.getItem(AUDIO_EFFECTIVE_SETTINGS_STORAGE_KEY_LEGACY);
        if (!legacyRaw) return;

        localStorage.setItem(AUDIO_EFFECTIVE_SETTINGS_STORAGE_KEY, legacyRaw);
        localStorage.removeItem(AUDIO_EFFECTIVE_SETTINGS_STORAGE_KEY_LEGACY);
    } catch {
        // Non-blocking migration path.
    }
};

const toPersistentClip = (clip: Clip): Clip => {
    const { buffer, isOffline, ...persistentClip } = clip;
    return persistentClip;
};

const App: React.FC = () => {
    const initialCollabSnapshot = useMemo(() => loadCollabSessionSnapshot(), []);

    // Auth session (used for session indicator widget in sidebar)
    const { user, profile, session, signOut: authSignOut, initialize: authInitialize } = useAuthStore();

    useEffect(() => {
        // Initialize auth store inside DAW — handles hash token SSO from cross-domain redirect
        const unsubscribe = authInitialize();
        return () => unsubscribe();
    }, [authInitialize]);

    // --- STATE ---
    const [projectName, setProjectName] = useState("Sin Título");
    const [loadingProject, setLoadingProject] = useState(false);
    const [loadingMessage, setLoadingMessage] = useState("");
    const [importProgress, setImportProgress] = useState<{ total: number; completed: number; currentFile: string | null } | null>(null);

    // Undo/Redo Hook
    const { state: tracks, setState: setTracks, setStateNoHistory: setTracksNoHistory, undo, redo, canUndo, canRedo } = useUndoRedo<Track[]>(INITIAL_TRACKS);

    const [selectedTrackId, setSelectedTrackId] = useState<string | null>(INITIAL_TRACKS[0]?.id || null);
    const [selectedClipId, setSelectedClipId] = useState<string | null>(INITIAL_TRACKS[0]?.clips[0]?.id || null);
    const [scoreWorkspaces, setScoreWorkspaces] = useState<ScoreWorkspaceState[]>([]);
    const [midiDevices, setMidiDevices] = useState<MidiDevice[]>([]);

    // Views
    const [mainView, setMainView] = useState<'arrange' | 'session' | 'mixer'>('arrange');
    const [bottomView, setBottomView] = useState<'devices' | 'editor'>('devices');
    const [mixSnapshots, setMixSnapshots] = useState<Partial<Record<MixSnapshotSlot, MixSnapshot>>>({});
    const [activeMixSnapshot, setActiveMixSnapshot] = useState<MixSnapshotSlot | null>(null);
    const [projectCommandCount, setProjectCommandCount] = useState(() => initialCollabSnapshot.commandCount);
    const [collabSessionId, setCollabSessionId] = useState<string | null>(() => initialCollabSnapshot.sessionId);
    const [isReadOnly, setIsReadOnly] = useState(false);
    const [collabUserName, setCollabUserName] = useState(() => initialCollabSnapshot.userName);
    const [collabActivity, setCollabActivity] = useState<CollabActivityEntry[]>(() => initialCollabSnapshot.activity);
    const [collabCommandJournal, setCollabCommandJournal] = useState<CollabCommandRecord[]>(() => initialCollabSnapshot.commandJournal);

    // Side Panels
    const [activeToolPanel, setActiveToolPanel] = useState<ToolPanel>(null);
    const [hasLoadedAISidebar, setHasLoadedAISidebar] = useState(false);
    const [hasLoadedNoteScanner, setHasLoadedNoteScanner] = useState(false);
    const [hasLoadedExportModal, setHasLoadedExportModal] = useState(false);

    // Menus & Modals
    const [showFileMenu, setShowFileMenu] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [activeModal, setActiveModal] = useState<'settings' | 'help' | 'collab' | 'auth' | 'new-project-confirm' | 'recovery' | 'recording-recovery' | 'monitoring-routes' | 'share' | 'project-os' | null>(null);
    const [isRenamingProject, setIsRenamingProject] = useState(false);
    const [renameValue, setRenameValue] = useState("");
    const [showProjectBrowser, setShowProjectBrowser] = useState(false);
    const [cloudProjects, setCloudProjects] = useState<Array<{ id: string; name: string; updated_at: string; data: any }>>([]);
    const [loadingCloudProjects, setLoadingCloudProjects] = useState(false);
    const [showExportModal, setShowExportModal] = useState(false);
    const [recoverySnapshot, setRecoverySnapshot] = useState<ProjectAutosaveSnapshot | null>(null);
    const [lastAutosaveAt, setLastAutosaveAt] = useState<number | null>(null);
    const [lastAutosaveReason, setLastAutosaveReason] = useState<string>('initial-snapshot');
    const [showSessionPopover, setShowSessionPopover] = useState(false);
    const [sessionPopoverView, setSessionPopoverView] = useState<'main' | 'login'>('main');
    const [projectIntegrityReport, setProjectIntegrityReport] = useState<ProjectIntegrityReport | null>(null);
    const [recordingJournalEntries, setRecordingJournalEntries] = useState<RecordingJournalEntry[]>(() => loadRecordingJournalEntries());
    const [recordingRecoveryAcknowledgedAt, setRecordingRecoveryAcknowledgedAt] = useState<number>(() => loadRecordingJournalRecoveryAcknowledgedAt());

    const showBrowser = activeToolPanel === 'browser';
    const showAI = activeToolPanel === 'ai';
    const showNoteScanner = activeToolPanel === 'scanner';
    const recordingJournalSummary = useMemo(
        () => summarizeRecordingJournalEntries(recordingJournalEntries),
        [recordingJournalEntries]
    );
    const recordingRecoveryAttentionEntries = useMemo(
        () => getRecordingJournalAttentionEntries(recordingJournalEntries, recordingRecoveryAcknowledgedAt),
        [recordingJournalEntries, recordingRecoveryAcknowledgedAt]
    );
    const recordingRecoveryAttentionSummary = useMemo(
        () => summarizeRecordingJournalAttentionEntries(recordingJournalEntries, recordingRecoveryAcknowledgedAt),
        [recordingJournalEntries, recordingRecoveryAcknowledgedAt]
    );

    const rememberProjectIntegrityReport = useCallback((report: ProjectIntegrityReport | null) => {
        setProjectIntegrityReport((previous) => {
            if (!previous && !report) return previous;
            if (!previous || !report) return report;
            const sameSummary =
                previous.source === report.source
                && previous.issueCount === report.issueCount
                && previous.errorCount === report.errorCount
                && previous.warningCount === report.warningCount
                && previous.repaired === report.repaired;

            return sameSummary ? previous : report;
        });
    }, []);

    useEffect(() => {
        recordingJournalEntriesRef.current = recordingJournalEntries;
        saveRecordingJournalEntries(recordingJournalEntries);
    }, [recordingJournalEntries]);
    useEffect(() => {
        saveRecordingJournalRecoveryAcknowledgedAt(recordingRecoveryAcknowledgedAt);
    }, [recordingRecoveryAcknowledgedAt]);

    const updateRecordingJournal = useCallback((
        updater: (entries: RecordingJournalEntry[]) => RecordingJournalEntry[]
    ) => {
        setRecordingJournalEntries((previous) => {
            const next = pruneRecordingJournalEntries(updater(previous));
            recordingJournalEntriesRef.current = next;
            return next;
        });
    }, []);
    const acknowledgeRecordingRecoveryNotice = useCallback(() => {
        const nextAcknowledgedAt = recordingRecoveryAttentionSummary.latestUpdatedAt ?? Date.now();
        setRecordingRecoveryAcknowledgedAt(nextAcknowledgedAt);
        setActiveModal((current) => current === 'recording-recovery' ? null : current);
    }, [recordingRecoveryAttentionSummary.latestUpdatedAt]);

    useEffect(() => {
        if (showAI) {
            setHasLoadedAISidebar(true);
        }
    }, [showAI]);

    useEffect(() => {
        if (showNoteScanner) {
            setHasLoadedNoteScanner(true);
        }
    }, [showNoteScanner]);

    useEffect(() => {
        if (showExportModal) {
            setHasLoadedExportModal(true);
        }
    }, [showExportModal]);

    // Zoom & UI
    const [zoom] = useState(40);
    const [trackHeight] = useState(124);

    // Engine State
    const [audioSettings, setAudioSettings] = useState<AudioSettings>(() => loadAudioSettingsFromStorage());
    const [engineStats, setEngineStats] = useState<EngineDiagnostics>({
        sampleRate: 0,
        latency: 0,
        state: 'closed',
        requestedSampleRate: audioSettings.sampleRate,
        activeSampleRate: 0,
        sampleRateMismatch: false,
        sampleRateMismatchMessage: null,
        highLoadDetected: false,
        profileSuggestion: null,
        configuredBufferSize: audioSettings.bufferSize,
        effectiveBufferSize: 0,
        bufferStrategy: 'auto',
        lookaheadMs: 25,
        scheduleAheadTimeMs: 100,
        schedulerMode: engineAdapter.getSchedulerMode(),
        schedulerP95TickDriftMs: 0,
        schedulerP99TickDriftMs: 0,
        schedulerP99LoopMs: 0
    });
    const [uiFrameTelemetry, setUiFrameTelemetry] = useState<{
        fpsP95: number;
        frameDropRatio: number;
        worstBurstMs: number;
        sampleWindowMs: number;
        hasActiveViewportInteraction: boolean;
    }>({
        fpsP95: 60,
        frameDropRatio: 0,
        worstBurstMs: 16.67,
        sampleWindowMs: 0,
        hasActiveViewportInteraction: false
    });
    const uiFrameTelemetryRef = useRef(uiFrameTelemetry);
    const [sessionLaunchP95Ms, setSessionLaunchP95Ms] = useState(0);
    const [sessionHealthSnapshot, setSessionHealthSnapshot] = useState<SessionHealthSnapshot>(() => (
        engineAdapter.getSessionHealthSnapshot({
            profile: PERFORMANCE_PROFILE,
            hasRealtimeAudio: false,
            uiFpsP95: 60,
            uiFrameDropRatio: 0
        })
    ));
    const [globalAudioPriority, setGlobalAudioPriority] = useState<GlobalAudioPriorityDecision>({
        mode: 'normal',
        uiUpdateDebounceMs: 12,
        reduceAnimations: false,
        disableHeavyVisuals: false,
        simplifyMeters: false,
        showBanner: false,
        reasons: ['initial'],
        reasonCode: 'steady'
    });
    const [audioIncidentWindow, setAudioIncidentWindow] = useState<AudioIncidentWindow>(() => createAudioIncidentWindow());
    const [diagnosticsVisibilityMode, setDiagnosticsVisibilityMode] = useState<DiagnosticsVisibilityMode>(() => (
        loadDiagnosticsVisibilityMode()
    ));
    const visualInteractionRef = useRef({ lastAt: 0 });
    const visualTelemetryWarmupUntilRef = useRef(performance.now() + VISUAL_PERFORMANCE_WARMUP_MS);

    useEffect(() => {
        saveDiagnosticsVisibilityMode(diagnosticsVisibilityMode);
    }, [diagnosticsVisibilityMode]);

    useEffect(() => {
        uiFrameTelemetryRef.current = uiFrameTelemetry;
    }, [uiFrameTelemetry]);

    useEffect(() => {
        const handleDiagnosticsShortcut = (event: KeyboardEvent) => {
            if (!event.ctrlKey || !event.altKey || event.code !== 'KeyD') {
                return;
            }

            event.preventDefault();
            setDiagnosticsVisibilityMode((previous) => toggleDiagnosticsVisibilityMode(previous));
        };

        window.addEventListener('keydown', handleDiagnosticsShortcut);
        return () => window.removeEventListener('keydown', handleDiagnosticsShortcut);
    }, []);

    // Refs
    const fileMenuRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    // Project Input Ref removed
    const timelineContainerRef = useRef<HTMLDivElement>(null);
    const recordingSessionMetaRef = useRef<Map<string, RecordingSessionMeta>>(new Map());
    const finalizeRecordingsPromiseRef = useRef<Promise<void> | null>(null);
    const loopOnceRemainingRef = useRef(0);
    const automationTouchUntilRef = useRef<Map<string, number>>(new Map());
    const automationLatchActiveRef = useRef<Set<string>>(new Set());
    const automationLastWriteRef = useRef<Map<string, number>>(new Map());
    const wasPlayingRef = useRef(false);
    const monoCheckStateRef = useRef<{ active: boolean; pans: Record<string, number> }>({ active: false, pans: {} });
    const lastCollabCommandRef = useRef(initialCollabSnapshot.commandCount);
    const collabHydratedRef = useRef(false);
    const pendingCollabReasonsRef = useRef<string[]>([]);
    const playbackSilenceGuardRef = useRef<{ lastAudibleAt: number; recovering: boolean }>({
        lastAudibleAt: Date.now(),
        recovering: false
    });
    const recordingJournalEntriesRef = useRef<RecordingJournalEntry[]>(recordingJournalEntries);
    const latestTracksRef = useRef<Track[]>(tracks);
    const trackSyncQueuedRef = useRef(false);
    const trackSyncFrameRef = useRef<number | null>(null);
    const boundaryTransitionInFlightRef = useRef(false);
    const finalizeActiveRecordingsRef = useRef<(() => Promise<void>) | null>(null);
    const hasActiveRecordingSessionsRef = useRef<(() => boolean) | null>(null);
    const benchmarkRunInFlightRef = useRef(false);
    const audioPriorityControllerRef = useRef(createAudioPriorityController({
        profile: PERFORMANCE_PROFILE,
        escalationStreak: 2,
        criticalEscalationStreak: 1,
        deescalationStreak: 4,
        idleDeescalationStreak: 2,
        deescalationCooldownMs: AUDIO_INCIDENT_RESET_COOLDOWN_MS,
        maxTransitionsPer20sIdle: 1
    }));

    // Audio Lock Ref (Prevents double-fire on rapid clicks)
    const isPlayingRef = useRef(false);
    const transportCommandTokenRef = useRef(0);
    const pauseResumeArmedRef = useRef(false);

    const resetAudioIncidentWindow = useCallback((active: boolean, at = Date.now()) => {
        setAudioIncidentWindow(createAudioIncidentWindow(
            Math.max(0, Number(engineStats.schedulerDropoutCount || 0)),
            Math.max(0, Number(engineStats.schedulerUnderrunCount || 0)),
            active,
            at
        ));
    }, [engineStats.schedulerDropoutCount, engineStats.schedulerUnderrunCount]);

    const [transport, setTransport] = useState<TransportState>({
        isPlaying: false,
        isRecording: false,
        loopMode: 'off',
        bpm: 124,
        timeSignature: [4, 4],
        currentBar: 1,
        currentBeat: 1,
        currentSixteenth: 1,
        masterTranspose: 0,
        gridSize: 0.25,
        snapToGrid: true,
        scaleRoot: 0,
        scaleType: 'minor'
    });

    const applyTrackGradientColors = useCallback((sourceTracks: Track[]): Track[] => {
        if (sourceTracks.length === 0) return sourceTracks;

        const used = new Set<string>();
        const total = sourceTracks.length;
        let changed = false;

        const recoloredTracks = sourceTracks.map((track, index) => {
            let color = getTrackColorByPosition(index, total);
            let guard = 0;

            while (used.has(color.toLowerCase()) && guard < 40) {
                guard += 1;
                color = getTrackColorByPosition(index, total, guard);
            }
            used.add(color.toLowerCase());

            const clipsNeedUpdate = track.clips.some((clip) => clip.color !== color);
            if (track.color === color && !clipsNeedUpdate) {
                return track;
            }

            changed = true;

            return {
                ...track,
                color,
                clips: clipsNeedUpdate
                    ? track.clips.map((clip) => ({ ...clip, color }))
                    : track.clips
            };
        });

        return changed ? recoloredTracks : sourceTracks;
    }, []);

    const getProgressiveTrackColor = useCallback((position: number, projectedTotal = position + 1): string => {
        const gradientTotal = Math.max(TRACK_COLOR_GRADIENT_TARGET, projectedTotal);
        return getTrackColorByPosition(position, gradientTotal);
    }, []);

    const toggleToolPanel = useCallback((panel: Exclude<ToolPanel, null>) => {
        setActiveToolPanel((prev) => (prev === panel ? null : panel));
    }, []);

    const closeAllToolPanels = useCallback(() => {
        setActiveToolPanel(null);
    }, []);

    interface TrackMutationOptions {
        noHistory?: boolean;
        recolor?: boolean;
        reason?: string;
        historyGroupId?: string;
    }

    const applyTrackMutation = useCallback((
        recipe: (currentTracks: Track[]) => Track[],
        options?: TrackMutationOptions
    ) => {
        if (isReadOnly) {
            console.warn("Project is read-only. Track mutation blocked.");
            return;
        }

        const commitMutation = (prevTracks: Track[]) => {
            const nextTracks = recipe(prevTracks);
            if (nextTracks === prevTracks) return prevTracks;
            if (!options?.noHistory) {
                pendingCollabReasonsRef.current.push(options?.reason || 'track-mutation');
                setProjectCommandCount((count) => count + 1);
            }
            return options?.recolor ? applyTrackGradientColors(nextTracks) : nextTracks;
        };

        if (options?.noHistory) {
            setTracksNoHistory(commitMutation);
            return;
        }

        setTracks(commitMutation, {
            groupKey: options?.historyGroupId || undefined
        });
    }, [applyTrackGradientColors, setTracks, setTracksNoHistory, isReadOnly]);

    const updateTrackById = useCallback((trackId: string, updates: Partial<Track>, options?: TrackMutationOptions) => {
        applyTrackMutation((prevTracks) => prevTracks.map((track) => (
            track.id === trackId
                ? (
                    updates.punchRange
                        ? updateTrackPunchRange({ ...track, ...updates }, updates.punchRange)
                        : { ...track, ...updates }
                )
                : track
        )), options);
    }, [applyTrackMutation]);

    const updateClipById = useCallback((trackId: string, clipId: string, updates: Partial<Clip>, options?: TrackMutationOptions) => {
        applyTrackMutation((prevTracks) => prevTracks.map((track) => {
            if (track.id !== trackId) return track;
            return applyTrackClipEdits(track, clipId, updates);
        }), options);
    }, [applyTrackMutation]);

    const appendTrack = useCallback((track: Track, options?: TrackMutationOptions) => {
        applyTrackMutation((prevTracks) => [...prevTracks, track], { ...options, recolor: options?.recolor ?? false });
    }, [applyTrackMutation]);

    const appendTracks = useCallback((nextTracks: Track[], options?: TrackMutationOptions) => {
        applyTrackMutation((prevTracks) => [...prevTracks, ...nextTracks], { ...options, recolor: options?.recolor ?? false });
    }, [applyTrackMutation]);

    const replaceTracks = useCallback((nextTracks: Track[], options?: TrackMutationOptions) => {
        applyTrackMutation(() => nextTracks, options);
    }, [applyTrackMutation]);

    // --- INIT & LOOPS ---
    useEffect(() => {
        engineAdapter.init(audioSettings);
        midiService.init();
        assetDb.init().catch(console.error);
        migrateLegacyEffectiveAudioSettings();

        const unsubscribe = midiService.subscribeDevices((devices: MidiDevice[]) => {
            setMidiDevices(devices.filter(d => d.type === 'input'));
        });

        const interval = setInterval(() => {
            const diagnostics = engineAdapter.getDiagnostics();
            setEngineStats(diagnostics);

            try {
                localStorage.setItem(BLOCK1_KPI_STORAGE_KEY, JSON.stringify({
                    timestamp: Date.now(),
                    route: engineAdapter.getBackendRoute(),
                    schedulerMode: diagnostics.schedulerMode || 'interval',
                    driftP95Ms: diagnostics.schedulerP95TickDriftMs || 0,
                    driftP99Ms: diagnostics.schedulerP99TickDriftMs || 0,
                    loopP99Ms: diagnostics.schedulerP99LoopMs || 0,
                    cpuLoadP95Percent: diagnostics.schedulerCpuLoadP95Percent || 0,
                    overrunRatio: diagnostics.schedulerOverrunRatio || 0,
                    underrunCount: diagnostics.schedulerUnderrunCount || 0,
                    dropoutCount: diagnostics.schedulerDropoutCount || 0,
                    monitorLatencyMs: (diagnostics.latency || 0) * 1000
                }));
            } catch {
                // Non-blocking KPI persistence path.
            }
        }, 1000);

        const handleClickOutside = (event: MouseEvent) => {
            if (fileMenuRef.current && !fileMenuRef.current.contains(event.target as Node)) {
                setShowFileMenu(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);

        return () => {
            unsubscribe();
            clearInterval(interval);
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        try {
            localStorage.setItem(AUDIO_EFFECTIVE_SETTINGS_STORAGE_KEY, JSON.stringify({
                sampleRate: engineStats.activeSampleRate,
                latencyHint: audioSettings.latencyHint,
                bufferSize: audioSettings.bufferSize,
                updatedAt: Date.now()
            }));
            localStorage.removeItem(AUDIO_EFFECTIVE_SETTINGS_STORAGE_KEY_LEGACY);
        } catch {
            // Non-blocking diagnostics persistence.
        }
    }, [audioSettings.bufferSize, audioSettings.latencyHint, engineStats.activeSampleRate]);

    useEffect(() => {
        const markVisualInteraction = () => {
            visualInteractionRef.current.lastAt = performance.now();
        };

        const timelineElement = timelineContainerRef.current;
        window.addEventListener('wheel', markVisualInteraction, { passive: true });
        window.addEventListener('pointerdown', markVisualInteraction, { passive: true });
        window.addEventListener('keydown', markVisualInteraction);
        timelineElement?.addEventListener('scroll', markVisualInteraction, { passive: true });

        return () => {
            window.removeEventListener('wheel', markVisualInteraction);
            window.removeEventListener('pointerdown', markVisualInteraction);
            window.removeEventListener('keydown', markVisualInteraction);
            timelineElement?.removeEventListener('scroll', markVisualInteraction);
        };
    }, []);

    useEffect(() => {
        visualTelemetryWarmupUntilRef.current = performance.now() + VISUAL_PERFORMANCE_WARMUP_MS;
    }, [transport.isPlaying, transport.isRecording]);

    useEffect(() => {
        let rafId = 0;
        let lastFrame = performance.now();
        let lastCommit = lastFrame;
        let active = true;
        const frameSamples: Array<{ at: number; delta: number }> = [];

        const commitTelemetry = (
            fpsP95: number,
            frameDropRatio: number,
            worstBurstMs: number,
            sampleWindowMs: number,
            hasActiveViewportInteraction: boolean
        ) => {
            setUiFrameTelemetry((prev) => {
                if (
                    Math.abs(prev.fpsP95 - fpsP95) < 0.5
                    && Math.abs(prev.frameDropRatio - frameDropRatio) < 0.005
                    && Math.abs(prev.worstBurstMs - worstBurstMs) < 1
                    && Math.abs(prev.sampleWindowMs - sampleWindowMs) < 100
                    && prev.hasActiveViewportInteraction === hasActiveViewportInteraction
                ) {
                    return prev;
                }
                return {
                    fpsP95,
                    frameDropRatio,
                    worstBurstMs,
                    sampleWindowMs,
                    hasActiveViewportInteraction
                };
            });
        };

        const pruneSamples = (now: number) => {
            while (frameSamples.length > 0 && (now - frameSamples[0].at) > VISUAL_PERFORMANCE_WINDOW_MS) {
                frameSamples.shift();
            }
        };

        const tick = (timestamp: number) => {
            if (!active) return;

            const delta = Math.max(0, timestamp - lastFrame);
            lastFrame = timestamp;

            const hasPlaybackActivity = transport.isPlaying || transport.isRecording;
            const hasActiveViewportInteraction = (timestamp - visualInteractionRef.current.lastAt) <= 900;
            const shouldSample = hasPlaybackActivity || hasActiveViewportInteraction;

            if (shouldSample && timestamp >= visualTelemetryWarmupUntilRef.current && delta > 0) {
                frameSamples.push({ at: timestamp, delta });
                pruneSamples(timestamp);
            } else if (!shouldSample) {
                frameSamples.length = 0;
            }

            if ((timestamp - lastCommit) >= 500) {
                pruneSamples(timestamp);
                lastCommit = timestamp;

                if (frameSamples.length === 0) {
                    commitTelemetry(60, 0, 16.67, 0, hasActiveViewportInteraction);
                } else {
                    const deltas = frameSamples.map((sample) => sample.delta).sort((left, right) => left - right);
                    const p95Index = Math.min(deltas.length - 1, Math.max(0, Math.round((deltas.length - 1) * 0.95)));
                    const p95Delta = deltas[p95Index] || 16.6667;
                    const fpsP95 = Math.max(1, 1000 / Math.max(1, p95Delta));
                    const dropThreshold = 22;
                    const frameDropRatio = frameSamples.filter((sample) => sample.delta > dropThreshold).length / Math.max(1, frameSamples.length);
                    const worstBurstMs = frameSamples.reduce((max, sample) => Math.max(max, sample.delta), 0);
                    const sampleWindowMs = Math.max(0, timestamp - frameSamples[0].at);
                    commitTelemetry(fpsP95, frameDropRatio, worstBurstMs, sampleWindowMs, hasActiveViewportInteraction);
                }
            }

            rafId = requestAnimationFrame(tick);
        };

        rafId = requestAnimationFrame(tick);
        return () => {
            active = false;
            if (rafId) cancelAnimationFrame(rafId);
        };
    }, [transport.isPlaying, transport.isRecording]);

    useEffect(() => {
        const readLaunchP95FromStorage = () => {
            try {
                const raw = localStorage.getItem(SESSION_LAUNCH_LATEST_REPORT_STORAGE_KEY);
                if (!raw) {
                    setSessionLaunchP95Ms(0);
                    return;
                }

                const parsed = JSON.parse(raw) as { summary?: { p95LaunchErrorMs?: number } };
                const nextP95 = Number.isFinite(parsed?.summary?.p95LaunchErrorMs)
                    ? Math.max(0, Number(parsed.summary?.p95LaunchErrorMs))
                    : 0;
                setSessionLaunchP95Ms((prev) => (
                    Math.abs(prev - nextP95) < 0.05 ? prev : nextP95
                ));
            } catch {
                setSessionLaunchP95Ms(0);
            }
        };

        readLaunchP95FromStorage();
        const interval = window.setInterval(readLaunchP95FromStorage, 1500);
        return () => window.clearInterval(interval);
    }, []);

    useEffect(() => {
        engineAdapter.setAudioConfiguration(audioSettings);
        try {
            localStorage.setItem(AUDIO_SETTINGS_STORAGE_KEY, JSON.stringify(audioSettings));
            localStorage.removeItem(AUDIO_SETTINGS_STORAGE_KEY_LEGACY);
        } catch (error) {
            console.warn('No se pudieron guardar preferencias de audio.', error);
        }
    }, [audioSettings]);

    useEffect(() => {
        setTransportClockSnapshot({
            currentBar: transport.currentBar,
            currentBeat: transport.currentBeat,
            currentSixteenth: transport.currentSixteenth,
            isPlaying: transport.isPlaying || isPlayingRef.current || engineAdapter.getIsPlaying(),
            updatedAt: Date.now()
        });
    }, [transport.currentBar, transport.currentBeat, transport.currentSixteenth, transport.isPlaying]);

    useEffect(() => {
        const benchmarkApi = window.electron;
        if (
            !benchmarkApi?.onBenchmarkStart
            || !benchmarkApi.publishBenchmarkArtifact
            || !benchmarkApi.publishBenchmarkStatus
        ) {
            return;
        }

        const unsubscribe = benchmarkApi.onBenchmarkStart((incomingConfig) => {
            if (benchmarkRunInFlightRef.current) {
                return;
            }

            benchmarkRunInFlightRef.current = true;

            void (async () => {
                try {
                    await benchmarkApi.publishBenchmarkStatus?.('running', {
                        phase: 'bootstrap',
                        config: incomingConfig
                    });

                    const result = await runLiveCaptureHarness(incomingConfig, {
                        onProgress: (progress) => {
                            void benchmarkApi.publishBenchmarkStatus?.(
                                'running',
                                progress as unknown as Record<string, unknown>
                            );
                        },
                        getVisualPerformanceSnapshot: (): VisualPerformanceSnapshot => {
                            const telemetry = uiFrameTelemetryRef.current;
                            return {
                                capturedAt: Date.now(),
                                uiFpsP95: telemetry.fpsP95,
                                frameDropRatio: telemetry.frameDropRatio,
                                worstBurstMs: telemetry.worstBurstMs,
                                sampleWindowMs: telemetry.sampleWindowMs,
                                hasActiveViewportInteraction: telemetry.hasActiveViewportInteraction,
                                hasPlaybackActivity:
                                    engineAdapter.getIsPlaying()
                                    || engineAdapter.getActiveRecordingTrackIds().length > 0
                            };
                        }
                    });

                    const launchSummary = {
                        sampleCount: result.launchReport.summary.sampleCount,
                        p95LaunchErrorMs: Number(result.launchReport.summary.p95LaunchErrorMs.toFixed(3)),
                        gatePass: result.launchReport.summary.gatePass
                    };
                    const stressGate = (result.stressReport.gates as { pass?: boolean }) || {};
                    const transitionsPayload = result.audioPriorityTransitionsReport as {
                        stability?: { pass?: boolean; passes?: boolean; maxTransitionsInWindow?: number };
                    };
                    const transitionsStability = transitionsPayload.stability || {};
                    const audioPriorityGatePass = Boolean(
                        transitionsStability.passes ?? transitionsStability.pass
                    );
                    const recordingReliabilitySummary = (result.recordingReliabilityReport.summary as {
                        gatePass?: boolean;
                        attemptedCycles?: number;
                        committedCycles?: number;
                        takeLossCount?: number;
                    }) || {};
                    const monitoringRuntimeSummary = (result.monitoringRuntimeReport.summary as {
                        pass?: boolean;
                        activeRouteCount?: number;
                        enabledRouteCount?: number;
                        monitorLatencyP95Ms?: number;
                        maxEffectiveMonitorLatencyMs?: number;
                    }) || {};
                    const transportRuntimeSummary = (result.transportRuntimeReport.summary as {
                        pass?: boolean;
                        checkpointCount?: number;
                        failedCheckpointCount?: number;
                        dropoutsDelta?: number;
                        underrunsDelta?: number;
                    }) || {};

                    await benchmarkApi.publishBenchmarkArtifact?.(
                        'transport-runtime',
                        createArtifactEnvelope(
                            'transport-runtime',
                            result.config,
                            {
                                gatePass: Boolean(transportRuntimeSummary.pass),
                                checkpointCount: Number(transportRuntimeSummary.checkpointCount || 0),
                                failedCheckpointCount: Number(transportRuntimeSummary.failedCheckpointCount || 0),
                                dropoutsDelta: Number(transportRuntimeSummary.dropoutsDelta || 0),
                                underrunsDelta: Number(transportRuntimeSummary.underrunsDelta || 0)
                            },
                            result.transportRuntimeReport as Record<string, unknown>
                        )
                    );
                    await benchmarkApi.publishBenchmarkArtifact?.(
                        'session-launch',
                        createArtifactEnvelope(
                            'session-launch',
                            result.config,
                            launchSummary,
                            result.launchReport as unknown as Record<string, unknown>
                        )
                    );
                    await benchmarkApi.publishBenchmarkArtifact?.(
                        'stress-48x8',
                        createArtifactEnvelope(
                            'stress-48x8',
                            result.config,
                            {
                                gatePass: Boolean(stressGate.pass),
                                durationMinutes: result.config.durationMinutes,
                                recordingCycles: result.config.recordingCycles,
                                visualFpsP95: Number(
                                    ((result.stressReport.telemetry as { ui?: { fpsP95?: number } })?.ui?.fpsP95 || 0)
                                )
                            },
                            result.stressReport
                        )
                    );
                    await benchmarkApi.publishBenchmarkArtifact?.(
                        'audio-priority-transitions',
                        createArtifactEnvelope(
                            'audio-priority-transitions',
                            result.config,
                            {
                                gatePass: audioPriorityGatePass,
                                maxTransitionsInWindow: Number(transitionsStability.maxTransitionsInWindow || 0)
                            },
                            result.audioPriorityTransitionsReport as Record<string, unknown>
                        )
                    );
                    await benchmarkApi.publishBenchmarkArtifact?.(
                        'recording-reliability',
                        createArtifactEnvelope(
                            'recording-reliability',
                            result.config,
                            {
                                gatePass: Boolean(recordingReliabilitySummary.gatePass),
                                attemptedCycles: Number(recordingReliabilitySummary.attemptedCycles || 0),
                                committedCycles: Number(recordingReliabilitySummary.committedCycles || 0),
                                takeLossCount: Number(recordingReliabilitySummary.takeLossCount || 0)
                            },
                            result.recordingReliabilityReport as Record<string, unknown>
                        )
                    );
                    await benchmarkApi.publishBenchmarkArtifact?.(
                        'monitoring-runtime',
                        createArtifactEnvelope(
                            'monitoring-runtime',
                            result.config,
                            {
                                gatePass: Boolean(monitoringRuntimeSummary.pass),
                                activeRouteCount: Number(monitoringRuntimeSummary.activeRouteCount || 0),
                                enabledRouteCount: Number(monitoringRuntimeSummary.enabledRouteCount || 0),
                                monitorLatencyP95Ms: Number(monitoringRuntimeSummary.monitorLatencyP95Ms || 0),
                                maxEffectiveMonitorLatencyMs: Number(monitoringRuntimeSummary.maxEffectiveMonitorLatencyMs || 0)
                            },
                            result.monitoringRuntimeReport as Record<string, unknown>
                        )
                    );

                    await benchmarkApi.publishBenchmarkStatus?.('success', {
                        transportRuntimePass: Boolean(transportRuntimeSummary.pass),
                        launchP95Ms: launchSummary.p95LaunchErrorMs,
                        launchSamples: launchSummary.sampleCount,
                        stressPass: Boolean(stressGate.pass),
                        visualFpsP95: Number(
                            ((result.stressReport.telemetry as { ui?: { fpsP95?: number } })?.ui?.fpsP95 || 0)
                        ),
                        audioPriorityPass: audioPriorityGatePass,
                        recordingReliabilityPass: Boolean(recordingReliabilitySummary.gatePass),
                        monitoringRuntimePass: Boolean(monitoringRuntimeSummary.pass)
                    });
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    await benchmarkApi.publishBenchmarkStatus?.('fail', {
                        error: message
                    });
                } finally {
                    benchmarkRunInFlightRef.current = false;
                }
            })();
        });

        return () => {
            if (typeof unsubscribe === 'function') {
                unsubscribe();
            }
        };
    }, []);

    // Sync Ref with State when stopped externally (e.g. end of song)
    useEffect(() => {
        isPlayingRef.current = transport.isPlaying;
    }, [transport.isPlaying]);

    useEffect(() => {
        loopOnceRemainingRef.current = transport.loopMode === 'once' ? 1 : 0;
    }, [transport.loopMode]);

    useEffect(() => {
        if (tracks.length === 0) {
            if (selectedTrackId !== null) setSelectedTrackId(null);
            if (selectedClipId !== null) setSelectedClipId(null);
            return;
        }

        const activeTrack = selectedTrackId ? tracks.find((track) => track.id === selectedTrackId) : null;
        if (!activeTrack) {
            const fallbackTrack = tracks[0];
            setSelectedTrackId(fallbackTrack?.id ?? null);
            setSelectedClipId(fallbackTrack?.clips[0]?.id ?? null);
            return;
        }

        if (selectedClipId && activeTrack.clips.some((clip) => clip.id === selectedClipId)) {
            return;
        }

        const nextClipId = activeTrack.clips[0]?.id ?? null;
        if (selectedClipId !== nextClipId) {
            setSelectedClipId(nextClipId);
        }
    }, [selectedClipId, selectedTrackId, tracks]);

    useEffect(() => {
        collabHydratedRef.current = true;
    }, []);

    useEffect(() => {
        if (!collabHydratedRef.current) return;

        const reason = pendingCollabReasonsRef.current.shift();
        if (!reason) return;

        const now = Date.now();
        setCollabCommandJournal((prev) => ([
            {
                id: `cmd-${projectCommandCount}-${now}`,
                timestamp: now,
                commandIndex: projectCommandCount,
                reason
            },
            ...prev
        ].slice(0, 240)));
    }, [projectCommandCount]);

    useEffect(() => {
        if (!collabHydratedRef.current) return;

        saveCollabSessionSnapshot({
            sessionId: collabSessionId,
            userName: collabUserName,
            commandCount: projectCommandCount,
            activity: collabActivity,
            commandJournal: collabCommandJournal,
            updatedAt: Date.now()
        });
    }, [collabActivity, collabCommandJournal, collabSessionId, collabUserName, projectCommandCount]);

    // Sync Tracks with Audio Engine
    useEffect(() => {
        const urlParams = new URLSearchParams(window.location.search);
        const token = urlParams.get('token');
        const projectId = urlParams.get('project');
        const localPath = urlParams.get('localPath');

        if (token) {
            const loadSharedSession = async () => {
                setLoadingProject(true);
                setLoadingMessage('Resolviendo token de colaboración...');
                try {
                    const { data, error } = await supabase.rpc('get_project_by_share_token', { p_token: token });
                    if (error || !data || data.length === 0) {
                        alert('El enlace de colaboración es inválido o ha expirado.');
                    } else {
                        const sharedSession = data[0];
                        if (sharedSession.access_level === 'viewer') {
                            setIsReadOnly(true);
                        }
                        setProjectName(sharedSession.name);
                        setCollabSessionId(sharedSession.project_id);
                        
                        // Si es viewer, alertar al usuario
                        if (sharedSession.access_level === 'viewer') {
                            alert('Has entrado en modo VISOR. No podrás guardar cambios en este proyecto.');
                        } else {
                            alert('Has entrado en modo EDITOR.');
                        }

                        if (sharedSession.data) {
                            const integrityReport = await hydrateProjectData(sharedSession.data as unknown as ProjectData, sharedSession.name, {
                                source: 'open-project',
                                rememberReport: true
                            });
                            if (integrityReport.issueCount > 0) {
                                console.warn('Project integrity repaired during open.', integrityReport);
                            }
                        } else {
                            console.warn('Shared project token resolved without project data.');
                        }
                    }
                } catch (e) {
                    console.error('Error loading shared session:', e);
                } finally {
                    setLoadingProject(false);
                }
            };
            loadSharedSession();
        } else if (projectId) {
            const loadCloudProject = async () => {
                setLoadingProject(true);
                setLoadingMessage('Cargando proyecto de la nube...');
                try {
                    const { data, error } = await supabase.from('projects').select('*').eq('id', projectId).single();
                    if (error || !data) {
                        alert('No se pudo encontrar el proyecto en la nube.');
                    } else {
                        setProjectName(data.name);
                        setCollabSessionId(data.id);
                        
                        if (data.data && Object.keys(data.data).length > 0) {
                            const integrityReport = await hydrateProjectData(data.data as unknown as ProjectData, data.name, {
                                source: 'open-project',
                                rememberReport: true
                            });
                            if (integrityReport.issueCount > 0) {
                                console.warn('Project integrity repaired during open.', integrityReport);
                            }
                        }
                    }
                } catch (e) {
                    console.error('Error loading cloud project:', e);
                } finally {
                    setLoadingProject(false);
                }
            };
            loadCloudProject();
        } else if (localPath) {
            const loadLocalProject = async () => {
                setLoadingProject(true);
                setLoadingMessage('Cargando proyecto local...');
                try {
                    const file = await platformService.readFileFromPath(localPath);
                    if (!file?.data) {
                        alert('No se pudo leer el proyecto local.');
                        return;
                    }

                    const decoder = new TextDecoder();
                    const parsed = JSON.parse(decoder.decode(file.data)) as ProjectData;
                    const integrityReport = await hydrateProjectData(parsed, parsed.name || file.name.replace(/\.esp$/i, ''), {
                        source: 'open-project',
                        rememberReport: true
                    });
                    if (integrityReport.issueCount > 0) {
                        console.warn('Project integrity repaired during local open.', integrityReport);
                    }
                } catch (e) {
                    console.error('Error loading local project:', e);
                    alert('No se pudo abrir el proyecto local.');
                } finally {
                    setLoadingProject(false);
                }
            };
            loadLocalProject();
        }
    }, []);

    useEffect(() => {
        latestTracksRef.current = tracks;
    }, [tracks]);

    useEffect(() => {
        if (trackSyncQueuedRef.current) {
            return;
        }

        trackSyncQueuedRef.current = true;
        trackSyncFrameRef.current = window.requestAnimationFrame(() => {
            trackSyncQueuedRef.current = false;
            trackSyncFrameRef.current = null;
            engineAdapter.updateTracks(latestTracksRef.current);
        });
    }, [tracks]);

    useEffect(() => {
        return () => {
            if (trackSyncFrameRef.current !== null) {
                window.cancelAnimationFrame(trackSyncFrameRef.current);
            }
            trackSyncFrameRef.current = null;
            trackSyncQueuedRef.current = false;
        };
    }, []);

    useEffect(() => {
        if (!transport.isPlaying) {
            playbackSilenceGuardRef.current.lastAudibleAt = Date.now();
            playbackSilenceGuardRef.current.recovering = false;
            return;
        }

        const interval = window.setInterval(() => {
            const diagnostics = engineAdapter.getRuntimeDiagnostics();
            const meter = engineAdapter.getMasterMeter();
            const audible = meter.peakDb > -58 || meter.rmsDb > -62;

            if (audible || diagnostics.activeSourceCount === 0) {
                playbackSilenceGuardRef.current.lastAudibleAt = Date.now();
                return;
            }

            const silenceMs = Date.now() - playbackSilenceGuardRef.current.lastAudibleAt;
            if (silenceMs < 1400 || playbackSilenceGuardRef.current.recovering) {
                return;
            }

            playbackSilenceGuardRef.current.recovering = true;

            void engineAdapter.recoverPlaybackGraph(latestTracksRef.current)
                .catch((error) => {
                    console.warn('Audio silence guard recovery failed.', error);
                })
                .finally(() => {
                    window.setTimeout(() => {
                        playbackSilenceGuardRef.current.recovering = false;
                    }, 600);
                });
        }, 320);

        return () => window.clearInterval(interval);
    }, [transport.isPlaying]);

    // --- HELPER: GET PROJECT DURATION ---
    const projectEndBar = useMemo(() => {
        let maxBar = 0;
        tracks.forEach((t: Track) => {
            t.clips.forEach((c: Clip) => {
                const end = c.start + c.length;
                if (end > maxBar) maxBar = end;
            });
        });
        // Tight loop: Use exact maxBar if content exists, otherwise default to 8.
        return maxBar > 0 ? maxBar : 8;
    }, [tracks]);

    const getProjectEndBar = useCallback(() => projectEndBar, [projectEndBar]);

    // Dynamic Calculation of Total Bars for Infinite Scroll
    const totalProjectBars = useMemo(() => {
        return Math.max(200, projectEndBar + 40); // Base 200, or End + padding
    }, [projectEndBar]);

    // --- HANDLE LOOPING & END OF SONG (Transport display now synced from Timeline) ---
    useEffect(() => {
        let animationFrame: number;

        const checkLoopAndEnd = () => {
            if (transport.isPlaying) {
                const transportSnapshot = engineAdapter.getTransportAuthoritySnapshot();
                const currentProjectTime = transportSnapshot.currentTimeSec;

                // Check for Loop / End of Song
                const endBar = getProjectEndBar();
                const endSeconds = barToSeconds(endBar, transport.bpm);

                if (currentProjectTime >= endSeconds && endSeconds > 0) {
                    const loopAction = getLoopEndAction(transport.loopMode, loopOnceRemainingRef.current);
                    const applyBoundaryAction = (): boolean => {
                        if (loopAction.action === 'restart') {
                            loopOnceRemainingRef.current = loopAction.nextOnceRemaining;
                            engineAdapter.seek(0, tracks, transport.bpm);
                            const restartSnapshot = engineAdapter.getTransportAuthoritySnapshot();
                            setTransportClockSnapshot({
                                currentBar: 1,
                                currentBeat: 1,
                                currentSixteenth: 1,
                                isPlaying: true,
                                updatedAt: restartSnapshot.capturedAt
                            });
                            setTransport((prev: TransportState) => ({
                                ...prev,
                                currentBar: 1,
                                currentBeat: 1,
                                currentSixteenth: 1,
                                ...(loopAction.nextLoopMode ? { loopMode: loopAction.nextLoopMode } : {})
                            }));
                            return false;
                        }

                        loopOnceRemainingRef.current = loopAction.nextOnceRemaining;
                        engineAdapter.stop(true);
                        const stopSnapshot = engineAdapter.getTransportAuthoritySnapshot();
                        setTransportClockSnapshot({
                            currentBar: 1,
                            currentBeat: 1,
                            currentSixteenth: 1,
                            isPlaying: false,
                            updatedAt: stopSnapshot.capturedAt
                        });
                        isPlayingRef.current = false;
                        pauseResumeArmedRef.current = false;
                        setTransport((prev: TransportState) => ({
                            ...prev,
                            isPlaying: false,
                            isRecording: false,
                            currentBar: 1,
                            currentBeat: 1,
                            currentSixteenth: 1,
                            ...(loopAction.nextLoopMode ? { loopMode: loopAction.nextLoopMode } : {})
                        }));
                        return true;
                    };

                    if (boundaryTransitionInFlightRef.current) {
                        animationFrame = requestAnimationFrame(checkLoopAndEnd);
                        return;
                    }

                    const requiresFinalize = hasActiveRecordingSessionsRef.current?.() || false;
                    if (requiresFinalize) {
                        boundaryTransitionInFlightRef.current = true;
                        void (async () => {
                            try {
                                const finalizeFn = finalizeActiveRecordingsRef.current;
                                if (finalizeFn) {
                                    await finalizeFn();
                                }

                                const shouldStop = applyBoundaryAction();
                                if (!shouldStop) {
                                    animationFrame = requestAnimationFrame(checkLoopAndEnd);
                                }
                            } finally {
                                boundaryTransitionInFlightRef.current = false;
                            }
                        })();
                        return;
                    }

                    const shouldStop = applyBoundaryAction();
                    if (shouldStop) {
                        return;
                    }
                }
            }
            animationFrame = requestAnimationFrame(checkLoopAndEnd);
        };

        if (transport.isPlaying) {
            animationFrame = requestAnimationFrame(checkLoopAndEnd);
        }
        return () => cancelAnimationFrame(animationFrame);
    }, [transport.isPlaying, transport.bpm, transport.loopMode, tracks, getProjectEndBar]);

    useEffect(() => {
        if (!transport.isPlaying) {
            boundaryTransitionInFlightRef.current = false;
        }
    }, [transport.isPlaying]);

    useEffect(() => {
        engineAdapter.setMasterPitch(transport.masterTranspose);
    }, [transport.masterTranspose]);

    const publishTransportClockFromAuthority = useCallback((
        snapshot: TransportAuthoritySnapshot,
        overrides?: Partial<Pick<TransportState, 'currentBar' | 'currentBeat' | 'currentSixteenth' | 'isPlaying'>>
    ) => {
        setTransportClockSnapshot({
            currentBar: overrides?.currentBar ?? snapshot.currentBar,
            currentBeat: overrides?.currentBeat ?? snapshot.currentBeat,
            currentSixteenth: overrides?.currentSixteenth ?? snapshot.currentSixteenth,
            isPlaying: overrides?.isPlaying ?? snapshot.isPlaying,
            updatedAt: snapshot.capturedAt
        });
    }, []);

    const syncTransportStateFromAuthority = useCallback((
        snapshot: TransportAuthoritySnapshot,
        overrides?: Partial<Pick<TransportState, 'currentBar' | 'currentBeat' | 'currentSixteenth' | 'isPlaying' | 'isRecording' | 'loopMode'>> & {
            commitPositionToState?: boolean;
        }
    ) => {
        const nextBar = overrides?.currentBar ?? snapshot.currentBar;
        const nextBeat = overrides?.currentBeat ?? snapshot.currentBeat;
        const nextSixteenth = overrides?.currentSixteenth ?? snapshot.currentSixteenth;
        const nextIsPlaying = overrides?.isPlaying ?? snapshot.isPlaying;
        const shouldCommitPositionToState = overrides?.commitPositionToState ?? (
            !nextIsPlaying
            || typeof overrides?.currentBar === 'number'
            || typeof overrides?.currentBeat === 'number'
            || typeof overrides?.currentSixteenth === 'number'
        );

        publishTransportClockFromAuthority(snapshot, {
            currentBar: nextBar,
            currentBeat: nextBeat,
            currentSixteenth: nextSixteenth,
            isPlaying: nextIsPlaying
        });

        setTransport((prev: TransportState) => ({
            ...prev,
            ...(shouldCommitPositionToState
                ? {
                    currentBar: nextBar,
                    currentBeat: nextBeat,
                    currentSixteenth: nextSixteenth
                }
                : {}),
            isPlaying: nextIsPlaying,
            ...(typeof overrides?.isRecording === 'boolean' ? { isRecording: overrides.isRecording } : {}),
            ...(overrides?.loopMode ? { loopMode: overrides.loopMode } : {})
        }));
    }, [publishTransportClockFromAuthority]);

    const beginTransportCommand = useCallback((): number => {
        transportCommandTokenRef.current += 1;
        return transportCommandTokenRef.current;
    }, []);

    const isTransportCommandCurrent = useCallback((token: number): boolean => {
        return transportCommandTokenRef.current === token;
    }, []);

    useEffect(() => {
        const shouldSyncFromEngine = (
            transport.isPlaying
            || transport.isRecording
            || isPlayingRef.current
            || engineAdapter.getIsPlaying()
            || engineAdapter.getActiveRecordingTrackIds().length > 0
        );

        if (!shouldSyncFromEngine) {
            return;
        }

        let animationFrame = 0;
        let lastFrameTime = 0;

        const syncClock = (timestamp: number) => {
            const shouldRunRealtime = transport.isPlaying || transport.isRecording || engineAdapter.getActiveRecordingTrackIds().length > 0;
            const minFrameDelta = shouldRunRealtime ? (1000 / 60) : (1000 / 12);
            if ((timestamp - lastFrameTime) < minFrameDelta) {
                animationFrame = requestAnimationFrame(syncClock);
                return;
            }
            lastFrameTime = timestamp;
            const authoritySnapshot = engineAdapter.getTransportAuthoritySnapshot();
            publishTransportClockFromAuthority(authoritySnapshot);

            const keepRunning = (
                authoritySnapshot.isPlaying
                || transport.isRecording
                || engineAdapter.getActiveRecordingTrackIds().length > 0
            );

            if (keepRunning) {
                animationFrame = requestAnimationFrame(syncClock);
            }
        };

        animationFrame = requestAnimationFrame(syncClock);
        return () => cancelAnimationFrame(animationFrame);
    }, [publishTransportClockFromAuthority, transport.isPlaying, transport.isRecording]);

    const getTransportCursorBar = useCallback(() => {
        return positionToBarTime(getTransportClockSnapshot());
    }, []);

    const playFromTransportCursor = useCallback(async (commandToken: number): Promise<boolean> => {
        if (isPlayingRef.current || engineAdapter.getIsPlaying()) {
            pauseResumeArmedRef.current = false;
            return true;
        }

        const ready = await engineAdapter.ensurePlaybackReady();
        if (!isTransportCommandCurrent(commandToken)) {
            return false;
        }

        if (!ready) {
            isPlayingRef.current = false;
            setTransport((prev: TransportState) => ({ ...prev, isPlaying: false }));
            return false;
        }

        const cursorBarTime = getTransportCursorBar();
        const cursorTime = barToSeconds(cursorBarTime, transport.bpm);
        const projectEndBar = getProjectEndBar();
        const projectEndTime = barToSeconds(projectEndBar, transport.bpm);
        const shouldRestartFromBeginning = shouldRestartAtSongBoundary(cursorTime, projectEndTime);
        const playbackStartTime = shouldRestartFromBeginning ? 0 : cursorTime;
        const playbackStartBarTime = Math.max(1, 1 + (playbackStartTime / getSecondsPerBar(transport.bpm)));
        const playbackStartPosition = barTimeToPosition(playbackStartBarTime);

        if (playbackStartTime <= 0.0001) {
            loopOnceRemainingRef.current = transport.loopMode === 'once' ? 1 : 0;
        }

        if (!isTransportCommandCurrent(commandToken)) {
            return false;
        }

        isPlayingRef.current = true;
        pauseResumeArmedRef.current = false;
        engineAdapter.play(latestTracksRef.current, transport.bpm, 1, playbackStartTime);

        if (!engineAdapter.getIsPlaying()) {
            isPlayingRef.current = false;
            pauseResumeArmedRef.current = false;
            setTransport((prev: TransportState) => ({ ...prev, isPlaying: false }));
            return false;
        }

        if (!isTransportCommandCurrent(commandToken)) {
            return false;
        }

        const authoritySnapshot = engineAdapter.getTransportAuthoritySnapshot();
        syncTransportStateFromAuthority(authoritySnapshot, {
            isPlaying: true,
            currentBar: playbackStartPosition.currentBar,
            currentBeat: playbackStartPosition.currentBeat,
            currentSixteenth: playbackStartPosition.currentSixteenth
        });

        return true;
    }, [getProjectEndBar, getTransportCursorBar, isTransportCommandCurrent, syncTransportStateFromAuthority, transport.bpm, transport.loopMode]);


    // --- TRANSPORT HANDLERS ---

    const handlePlay = useCallback(async () => {
        const authoritySnapshot = engineAdapter.getTransportAuthoritySnapshot();
        if (isPlayingRef.current || engineAdapter.getIsPlaying() || authoritySnapshot.isPlaying) {
            pauseResumeArmedRef.current = false;
            syncTransportStateFromAuthority(authoritySnapshot, {
                isPlaying: true
            });
            return;
        }
        const commandToken = beginTransportCommand();
        resetAudioIncidentWindow(true);
        visualTelemetryWarmupUntilRef.current = performance.now() + VISUAL_PERFORMANCE_WARMUP_MS;
        await playFromTransportCursor(commandToken);
    }, [beginTransportCommand, playFromTransportCursor, resetAudioIncidentWindow, syncTransportStateFromAuthority]);

    const hasActiveRecordingSessions = useCallback((): boolean => {
        return transport.isRecording || engineAdapter.getActiveRecordingTrackIds().length > 0;
    }, [transport.isRecording]);

    const appendRecordingJournalForTrack = useCallback((
        journalId: string | undefined,
        phase: Parameters<typeof appendRecordingJournalPhase>[2],
        options?: Parameters<typeof appendRecordingJournalPhase>[3]
    ) => {
        if (!journalId) return;
        updateRecordingJournal((entries) => appendRecordingJournalPhase(entries, journalId, phase, options));
    }, [updateRecordingJournal]);

    const failRecordingJournalForTrack = useCallback((
        journalId: string | undefined,
        message: string,
        options?: { at?: number; barTime?: number; contextTimeSec?: number; details?: Record<string, string | number | boolean | null> }
    ) => {
        if (!journalId) return;
        updateRecordingJournal((entries) => markRecordingJournalFailed(entries, journalId, message, options));
    }, [updateRecordingJournal]);

    const commitRecordingJournalForTrack = useCallback((result: RecordingCommitResult) => {
        updateRecordingJournal((entries) => markRecordingJournalCommitted(entries, result));
    }, [updateRecordingJournal]);

    const clearRecordingRuntimeForTracks = useCallback((trackIds: Iterable<string>) => {
        const targetTrackIds = new Set(trackIds);
        if (targetTrackIds.size === 0) return;

        applyTrackMutation((prevTracks) => {
            let changed = false;
            const nextTracks = prevTracks.map((track) => {
                if (!targetTrackIds.has(track.id) || track.type !== TrackType.AUDIO) {
                    return track;
                }

                const nextMicSettings = {
                    profile: track.micSettings?.profile || 'studio-voice',
                    inputGain: typeof track.micSettings?.inputGain === 'number' ? track.micSettings.inputGain : 1,
                    monitoringEnabled: false,
                    monitoringReverb: false,
                    monitoringEcho: false,
                    monitorInputMode: track.micSettings?.monitorInputMode || 'mono',
                    monitorLatencyCompensationMs: typeof track.micSettings?.monitorLatencyCompensationMs === 'number'
                        ? track.micSettings.monitorLatencyCompensationMs
                        : 0
                };

                const needsUpdate =
                    track.isArmed
                    || track.monitor !== 'auto'
                    || (track.micSettings?.monitoringEnabled ?? false)
                    || (track.micSettings?.monitoringReverb ?? false)
                    || (track.micSettings?.monitoringEcho ?? false);

                if (!needsUpdate) {
                    return track;
                }

                changed = true;
                return {
                    ...track,
                    isArmed: false,
                    monitor: 'auto' as const,
                    micSettings: nextMicSettings
                };
            });

            return changed ? nextTracks : prevTracks;
        }, { recolor: false });
    }, [applyTrackMutation]);
    const disableTrackMonitoring = useCallback((trackId: string) => {
        engineAdapter.stopTrackMonitoring(trackId);
        applyTrackMutation((prevTracks) => {
            let changed = false;
            const nextTracks = prevTracks.map((track) => {
                if (track.id !== trackId || track.type !== TrackType.AUDIO) {
                    return track;
                }

                const nextMicSettings = {
                    profile: track.micSettings?.profile || 'studio-voice',
                    inputGain: track.micSettings?.inputGain ?? 1,
                    monitoringEnabled: false,
                    monitoringReverb: false,
                    monitoringEcho: false,
                    monitorInputMode: track.micSettings?.monitorInputMode || 'mono',
                    monitorLatencyCompensationMs: typeof track.micSettings?.monitorLatencyCompensationMs === 'number'
                        ? track.micSettings.monitorLatencyCompensationMs
                        : 0
                };

                if (!track.micSettings?.monitoringEnabled && track.monitor === 'off') {
                    return track;
                }

                changed = true;
                return {
                    ...track,
                    monitor: 'off' as const,
                    micSettings: nextMicSettings
                };
            });

            return changed ? nextTracks : prevTracks;
        }, { recolor: false });
    }, [applyTrackMutation]);
    const disableAllMonitoring = useCallback(() => {
        const activeRoutes = engineAdapter.getMonitoringRouteSnapshots().filter((route) => route.active || route.monitoringEnabled);
        if (activeRoutes.length === 0) return;

        activeRoutes.forEach((route) => {
            engineAdapter.stopTrackMonitoring(route.trackId);
        });

        const activeTrackIds = new Set(activeRoutes.map((route) => route.trackId));
        applyTrackMutation((prevTracks) => {
            let changed = false;
            const nextTracks = prevTracks.map((track) => {
                if (!activeTrackIds.has(track.id) || track.type !== TrackType.AUDIO) {
                    return track;
                }

                const nextMicSettings = {
                    profile: track.micSettings?.profile || 'studio-voice',
                    inputGain: track.micSettings?.inputGain ?? 1,
                    monitoringEnabled: false,
                    monitoringReverb: false,
                    monitoringEcho: false,
                    monitorInputMode: track.micSettings?.monitorInputMode || 'mono',
                    monitorLatencyCompensationMs: typeof track.micSettings?.monitorLatencyCompensationMs === 'number'
                        ? track.micSettings.monitorLatencyCompensationMs
                        : 0
                };

                if (!track.micSettings?.monitoringEnabled && track.monitor === 'off') {
                    return track;
                }

                changed = true;
                return {
                    ...track,
                    monitor: 'off' as const,
                    micSettings: nextMicSettings
                };
            });

            return changed ? nextTracks : prevTracks;
        }, { recolor: false });
    }, [applyTrackMutation]);

    const finalizeActiveRecordings = useCallback(async () => {
        if (finalizeRecordingsPromiseRef.current) {
            await finalizeRecordingsPromiseRef.current;
            return;
        }

        const finalizeTask = (async () => {
            const activeRecordingTrackIds = engineAdapter.getActiveRecordingTrackIds();
            const pendingFinalizeTrackIds = engineAdapter.getPendingFinalizeTrackIds();
            const trackIdsToFinalize = Array.from(new Set([
                ...activeRecordingTrackIds,
                ...pendingFinalizeTrackIds,
                ...recordingSessionMetaRef.current.keys()
            ]));
            if (trackIdsToFinalize.length === 0) {
                recordingSessionMetaRef.current.clear();
                setTransport((prev: TransportState) => ({ ...prev, isRecording: false }));
                return;
            }

            const trackById = new Map(latestTracksRef.current.map((track) => [track.id, track]));
            const recordingCommitPayloads: Array<{
                commit: ReturnType<typeof buildRecordingTakeCommit>;
                journalId: string;
                sourceId: string;
                latencyCompensationBars: number;
                monitorMode: MonitoringRouteMode;
            }> = [];
            const finalizeErrors: string[] = [];
            const secondsPerBar = getSecondsPerBar(transport.bpm);

            for (const trackId of activeRecordingTrackIds) {
                const sessionMeta = recordingSessionMetaRef.current.get(trackId);
                const stopSnapshot = engineAdapter.getTransportAuthoritySnapshot();
                appendRecordingJournalForTrack(sessionMeta?.journalId, 'stop-requested', {
                    at: Date.now(),
                    barTime: stopSnapshot.currentBarTime,
                    contextTimeSec: stopSnapshot.currentTimeSec
                });
                engineAdapter.stopTrackMonitoring(trackId);
                const stopResult = await engineAdapter.stopRecording(trackId);

                if (!stopResult) {
                    failRecordingJournalForTrack(
                        sessionMeta?.journalId,
                        `stop-null:${trackId}`,
                        {
                            at: Date.now(),
                            barTime: stopSnapshot.currentBarTime,
                            contextTimeSec: stopSnapshot.currentTimeSec
                        }
                    );
                    finalizeErrors.push(`No se pudo detener la grabacion en ${trackId}.`);
                    continue;
                }

                appendRecordingJournalForTrack(sessionMeta?.journalId, 'stopped', {
                    at: Date.now(),
                    barTime: Math.max(1, 1 + (stopResult.stoppedAtContextTime / secondsPerBar)),
                    contextTimeSec: stopResult.stoppedAtContextTime,
                    details: {
                        estimatedLatencyMs: Number(stopResult.estimatedLatencyMs.toFixed(3))
                    }
                });
            }

            for (const trackId of trackIdsToFinalize) {
                const track = trackById.get(trackId);
                const sessionMeta = recordingSessionMetaRef.current.get(trackId);
                const result = await engineAdapter.finalizeRecording(trackId);
                recordingSessionMetaRef.current.delete(trackId);

                if (!result) {
                    failRecordingJournalForTrack(
                        sessionMeta?.journalId,
                        `finalize-null:${trackId}`,
                        {
                            at: Date.now()
                        }
                    );
                    finalizeErrors.push(`No se obtuvo audio final para track ${trackId}.`);
                    continue;
                }

                appendRecordingJournalForTrack(sessionMeta?.journalId, 'finalized', {
                    at: Date.now(),
                    barTime: Math.max(1, 1 + (result.stoppedAtContextTime / secondsPerBar)),
                    contextTimeSec: result.stoppedAtContextTime,
                    details: {
                        estimatedLatencyMs: Number(result.estimatedLatencyMs.toFixed(3))
                    }
                });

                if (!track) {
                    failRecordingJournalForTrack(
                        sessionMeta?.journalId,
                        `missing-track:${trackId}`,
                        { at: Date.now() }
                    );
                    finalizeErrors.push(`La pista ${trackId} ya no existe; se descarta la toma finalizada.`);
                    continue;
                }

                try {
                    const hash = await assetDb.saveFile(result.blob);
                    const fallbackStartBar = Math.max(1, 1 + (result.startedAtContextTime / secondsPerBar));
                    const fallbackCompensationBars = Math.max(0, (result.estimatedLatencyMs / 1000) / secondsPerBar);
                    const latencyCompensationBars = sessionMeta?.latencyCompensationBars ?? fallbackCompensationBars;
                    const monitorMode = sessionMeta?.monitorMode ?? (track.micSettings?.monitorInputMode || 'mono');
                    const commit = buildRecordingTakeCommit({
                        track,
                        sourceId: hash,
                        buffer: result.buffer,
                        bpm: transport.bpm,
                        recordingStartBar: sessionMeta?.recordingStartBar ?? fallbackStartBar,
                        latencyCompensationBars,
                        sourceTrimOffsetBars: sessionMeta?.sourceTrimOffsetBars ?? 0,
                        recordedAt: Date.now(),
                        idFactory: buildRuntimeId
                    });

                    recordingCommitPayloads.push({
                        commit,
                        journalId: sessionMeta?.journalId || '',
                        sourceId: hash,
                        latencyCompensationBars,
                        monitorMode
                    });
                } catch (error) {
                    console.error(`No se pudo persistir la toma grabada en ${track.name}.`, error);
                    failRecordingJournalForTrack(
                        sessionMeta?.journalId,
                        `persist-failed:${track.name}`,
                        { at: Date.now() }
                    );
                    finalizeErrors.push(`Fallo al persistir toma en ${track.name}.`);
                }
            }

            const recordingCommits = recordingCommitPayloads.map((payload) => payload.commit);
            if (recordingCommits.length > 0) {
                applyTrackMutation((prevTracks) => commitRecordingTakeBatch(prevTracks, recordingCommits), { recolor: false });
                recordingCommitPayloads.forEach((payload) => {
                    if (!payload.journalId) return;
                    commitRecordingJournalForTrack({
                        journalId: payload.journalId,
                        trackId: payload.commit.trackId,
                        clipId: payload.commit.clip.id,
                        takeId: payload.commit.take.id,
                        sourceId: payload.sourceId,
                        committedAt: Date.now(),
                        latencyCompensationBars: payload.latencyCompensationBars,
                        monitorMode: payload.monitorMode
                    });
                });
            }

            clearRecordingRuntimeForTracks(trackIdsToFinalize);

            if (finalizeErrors.length > 0) {
                console.warn('[Recording] Finalize completed with issues:', finalizeErrors);
            }

            setTransport((prev: TransportState) => ({ ...prev, isRecording: false }));
        })();

        finalizeRecordingsPromiseRef.current = finalizeTask;
        try {
            await finalizeTask;
        } finally {
            if (finalizeRecordingsPromiseRef.current === finalizeTask) {
                finalizeRecordingsPromiseRef.current = null;
            }
        }
    }, [appendRecordingJournalForTrack, applyTrackMutation, clearRecordingRuntimeForTracks, commitRecordingJournalForTrack, failRecordingJournalForTrack, transport.bpm]);

    useEffect(() => {
        finalizeActiveRecordingsRef.current = finalizeActiveRecordings;
    }, [finalizeActiveRecordings]);

    useEffect(() => {
        hasActiveRecordingSessionsRef.current = hasActiveRecordingSessions;
    }, [hasActiveRecordingSessions]);

    const handlePause = useCallback(async () => {
        const commandToken = beginTransportCommand();
        const isTransportRunning = isPlayingRef.current || engineAdapter.getIsPlaying() || transport.isPlaying;

        if (isTransportRunning) {
            if (hasActiveRecordingSessions()) {
                await finalizeActiveRecordings();
            }

            if (!isTransportCommandCurrent(commandToken)) {
                return;
            }

            engineAdapter.pause();
            const pauseSnapshot = engineAdapter.getTransportAuthoritySnapshot();
            syncTransportStateFromAuthority(pauseSnapshot, {
                isPlaying: false,
                isRecording: false
            });
            isPlayingRef.current = false;
            pauseResumeArmedRef.current = true;
            resetAudioIncidentWindow(false);
            return;
        }

        const idleSnapshot = engineAdapter.getTransportAuthoritySnapshot();
        if (!isTransportCommandCurrent(commandToken)) {
            return;
        }

        isPlayingRef.current = false;
        pauseResumeArmedRef.current = idleSnapshot.currentTimeSec > 0.0001;
        resetAudioIncidentWindow(false);
        syncTransportStateFromAuthority(idleSnapshot, {
            isPlaying: false,
            isRecording: false
        });
    }, [beginTransportCommand, transport.isPlaying, finalizeActiveRecordings, hasActiveRecordingSessions, isTransportCommandCurrent, resetAudioIncidentWindow, syncTransportStateFromAuthority]);

    const handleStop = useCallback(async () => {
        const commandToken = beginTransportCommand();

        if (hasActiveRecordingSessions()) {
            await finalizeActiveRecordings();
        }

        if (!isTransportCommandCurrent(commandToken)) {
            return;
        }

        engineAdapter.stop(true); // True resets offset to 0
        const stopSnapshot = engineAdapter.getTransportAuthoritySnapshot();
        loopOnceRemainingRef.current = transport.loopMode === 'once' ? 1 : 0;
        syncTransportStateFromAuthority(stopSnapshot, {
            isPlaying: false,
            isRecording: false,
            currentBar: 1,
            currentBeat: 1,
            currentSixteenth: 1
        });
        isPlayingRef.current = false;
        pauseResumeArmedRef.current = false;
        resetAudioIncidentWindow(false);
    }, [beginTransportCommand, transport.loopMode, finalizeActiveRecordings, hasActiveRecordingSessions, isTransportCommandCurrent, resetAudioIncidentWindow, syncTransportStateFromAuthority]);

    const handleSkipStart = useCallback(async () => {
        const commandToken = beginTransportCommand();
        const isTransportRunning = isPlayingRef.current || engineAdapter.getIsPlaying() || transport.isPlaying;

        if (hasActiveRecordingSessions()) {
            await finalizeActiveRecordings();
        }

        if (!isTransportCommandCurrent(commandToken)) {
            return;
        }

        visualTelemetryWarmupUntilRef.current = performance.now() + VISUAL_PERFORMANCE_WARMUP_MS;
        loopOnceRemainingRef.current = transport.loopMode === 'once' ? 1 : 0;

        if (isTransportRunning) {
            // Rewind while playing must fully clear the active session so a following
            // Play creates exactly one fresh playback instance.
            engineAdapter.stop(true);
            const stopSnapshot = engineAdapter.getTransportAuthoritySnapshot();
            isPlayingRef.current = false;
            pauseResumeArmedRef.current = false;
            syncTransportStateFromAuthority(stopSnapshot, {
                isPlaying: false,
                isRecording: false,
                currentBar: 1,
                currentBeat: 1,
                currentSixteenth: 1
            });
            resetAudioIncidentWindow(false);
            return;
        }

        engineAdapter.seek(0, latestTracksRef.current, transport.bpm);
        const seekSnapshot = engineAdapter.getTransportAuthoritySnapshot();
        isPlayingRef.current = false;
        pauseResumeArmedRef.current = false;
        syncTransportStateFromAuthority(seekSnapshot, {
            isPlaying: false,
            isRecording: false,
            currentBar: 1,
            currentBeat: 1,
            currentSixteenth: 1
        });
        resetAudioIncidentWindow(false);
    }, [beginTransportCommand, transport.bpm, transport.isPlaying, transport.loopMode, finalizeActiveRecordings, hasActiveRecordingSessions, isTransportCommandCurrent, resetAudioIncidentWindow, syncTransportStateFromAuthority]);

    const handleSkipEnd = useCallback(async () => {
        const commandToken = beginTransportCommand();
        const endBar = getProjectEndBar();

        if (hasActiveRecordingSessions()) {
            await finalizeActiveRecordings();
        }

        if (!isTransportCommandCurrent(commandToken)) {
            return;
        }

        const targetBarTime = Math.max(1, endBar);
        const targetTime = barToSeconds(targetBarTime, transport.bpm);

        if (isPlayingRef.current || engineAdapter.getIsPlaying() || transport.isPlaying) {
            engineAdapter.pause();
            isPlayingRef.current = false;
            pauseResumeArmedRef.current = false;
        }

        if (!isTransportCommandCurrent(commandToken)) {
            return;
        }

        visualTelemetryWarmupUntilRef.current = performance.now() + VISUAL_PERFORMANCE_WARMUP_MS;
        engineAdapter.seek(targetTime, latestTracksRef.current, transport.bpm);
        if (transport.loopMode === 'once') {
            loopOnceRemainingRef.current = 0;
        }

        const endSnapshot = engineAdapter.getTransportAuthoritySnapshot();
        syncTransportStateFromAuthority(endSnapshot, {
            isPlaying: false,
            isRecording: false
        });
        resetAudioIncidentWindow(false);
    }, [beginTransportCommand, transport.bpm, getProjectEndBar, transport.loopMode, transport.isPlaying, finalizeActiveRecordings, hasActiveRecordingSessions, isTransportCommandCurrent, resetAudioIncidentWindow, syncTransportStateFromAuthority]);

    const handleSeekToBar = useCallback(async (bar: number) => {
        const commandToken = beginTransportCommand();
        const safeBar = Math.max(1, Number.isFinite(bar) ? bar : 1);

        if (hasActiveRecordingSessions()) {
            await finalizeActiveRecordings();
        }

        if (!isTransportCommandCurrent(commandToken)) {
            return;
        }

        visualTelemetryWarmupUntilRef.current = performance.now() + VISUAL_PERFORMANCE_WARMUP_MS;
        engineAdapter.seek(barToSeconds(safeBar, transport.bpm), latestTracksRef.current, transport.bpm);
        const seekSnapshot = engineAdapter.getTransportAuthoritySnapshot();

        if (safeBar <= 1.0001 && transport.loopMode === 'once') {
            loopOnceRemainingRef.current = 1;
        }

        syncTransportStateFromAuthority(seekSnapshot, {
            isPlaying: seekSnapshot.isPlaying || isPlayingRef.current,
            isRecording: false
        });
        resetAudioIncidentWindow(seekSnapshot.isPlaying || isPlayingRef.current);
    }, [beginTransportCommand, finalizeActiveRecordings, hasActiveRecordingSessions, transport.bpm, transport.loopMode, isTransportCommandCurrent, resetAudioIncidentWindow, syncTransportStateFromAuthority]);

    const handleSeekToBarTime = useCallback(async (barTime: number) => {
        const commandToken = beginTransportCommand();
        const safeBarTime = Math.max(1, Number.isFinite(barTime) ? barTime : 1);

        if (hasActiveRecordingSessions()) {
            await finalizeActiveRecordings();
        }

        if (!isTransportCommandCurrent(commandToken)) {
            return;
        }

        visualTelemetryWarmupUntilRef.current = performance.now() + VISUAL_PERFORMANCE_WARMUP_MS;
        engineAdapter.seek(barToSeconds(safeBarTime, transport.bpm), latestTracksRef.current, transport.bpm);
        const seekSnapshot = engineAdapter.getTransportAuthoritySnapshot();
        syncTransportStateFromAuthority(seekSnapshot, {
            isPlaying: seekSnapshot.isPlaying || isPlayingRef.current,
            isRecording: false
        });
        resetAudioIncidentWindow(seekSnapshot.isPlaying || isPlayingRef.current);
    }, [beginTransportCommand, finalizeActiveRecordings, hasActiveRecordingSessions, isTransportCommandCurrent, resetAudioIncidentWindow, syncTransportStateFromAuthority, transport.bpm]);

    const handleLoopToggle = useCallback(() => {
        setTransport((prev: TransportState) => {
            const nextLoopMode = getNextLoopMode(prev.loopMode);
            return { ...prev, loopMode: nextLoopMode };
        });
    }, []);

    const handleBpmChange = useCallback((newBpm: number) => {
        const clamped = Math.max(20, Math.min(999, newBpm));
        setTransport((prev: TransportState) => ({ ...prev, bpm: clamped }));
        engineAdapter.setBpm(clamped);
    }, []);

    const toggleSelectedTrackPunch = useCallback(() => {
        if (!selectedTrackId) return;

        applyTrackMutation((prevTracks) => prevTracks.map((track) => {
            if (track.id !== selectedTrackId) return track;
            return updateTrackPunchRange(track, {
                enabled: !(track.punchRange?.enabled || false)
            });
        }), { recolor: false, reason: 'punch-toggle-selected-track' });
    }, [applyTrackMutation, selectedTrackId]);

    const setSelectedTrackPunchBoundary = useCallback((boundary: 'in' | 'out') => {
        if (!selectedTrackId) return;
        const cursorBar = getTransportCursorBar();

        applyTrackMutation((prevTracks) => prevTracks.map((track) => {
            if (track.id !== selectedTrackId) return track;

            const baseRange = track.punchRange || {
                enabled: true,
                inBar: 1,
                outBar: 2,
                preRollBars: 1,
                countInBars: 0
            };

            if (boundary === 'in') {
                return updateTrackPunchRange(track, {
                    enabled: true,
                    inBar: cursorBar,
                    outBar: Math.max(baseRange.outBar, cursorBar + 0.25)
                });
            }

            return updateTrackPunchRange(track, {
                enabled: true,
                outBar: Math.max(cursorBar, baseRange.inBar + 0.25)
            });
        }), { recolor: false, reason: `punch-set-${boundary}` });
    }, [applyTrackMutation, getTransportCursorBar, selectedTrackId]);

    const handleSelectedTrackPunchUpdate = useCallback((updates: Partial<PunchRange>) => {
        if (!selectedTrackId) return;

        applyTrackMutation((prevTracks) => prevTracks.map((track) => {
            if (track.id !== selectedTrackId || track.type !== TrackType.AUDIO) return track;
            return updateTrackPunchRange(track, updates);
        }), { recolor: false, reason: 'transport-punch-panel-update' });
    }, [applyTrackMutation, selectedTrackId]);

    const handleSelectTakeFromPanel = useCallback((trackId: string, takeId: string) => {
        applyTrackMutation((prevTracks) => prevTracks.map((track) => {
            if (track.id !== trackId) return track;
            return setTrackActiveTake(track, takeId);
        }), { recolor: false, reason: 'take-panel-select-active' });

        const targetTrack = latestTracksRef.current.find((track) => track.id === trackId);
        const targetTake = (targetTrack?.recordingTakes || []).find((take) => take.id === takeId);
        if (targetTake) {
            setSelectedTrackId(trackId);
            setSelectedClipId(targetTake.clipId);
            setBottomView('editor');
        }
    }, [applyTrackMutation]);

    const handleToggleTakeMuteFromPanel = useCallback((trackId: string, takeId: string) => {
        applyTrackMutation((prevTracks) => prevTracks.map((track) => {
            if (track.id !== trackId) return track;
            return toggleTrackTakeMute(track, takeId);
        }), { recolor: false, reason: 'take-panel-toggle-mute' });
    }, [applyTrackMutation]);

    const handleToggleTakeSoloFromPanel = useCallback((trackId: string, takeId: string) => {
        applyTrackMutation((prevTracks) => prevTracks.map((track) => {
            if (track.id !== trackId) return track;
            return toggleTrackTakeSolo(track, takeId);
        }), { recolor: false, reason: 'take-panel-toggle-solo' });
    }, [applyTrackMutation]);

    const handleSetCompLaneFromPanel = useCallback((trackId: string, laneId: string) => {
        applyTrackMutation((prevTracks) => prevTracks.map((track) => {
            if (track.id !== trackId) return track;
            return setTrackActiveCompLane(track, laneId);
        }), { recolor: false, reason: 'take-panel-activate-comp-lane' });
    }, [applyTrackMutation]);

    const handleAuditionTakeFromPanel = useCallback(async (trackId: string, takeId: string) => {
        const targetTrack = latestTracksRef.current.find((track) => track.id === trackId);
        if (!targetTrack || targetTrack.type !== TrackType.AUDIO) return;

        const targetTake = (targetTrack.recordingTakes || []).find((take) => take.id === takeId);
        if (!targetTake) return;

        const targetClip = targetTrack.clips.find((clip) => clip.id === targetTake.clipId);
        if (!targetClip) return;

        if (targetClip.buffer) {
            audioEngine.previewBuffer(targetClip.buffer);
            return;
        }

        if (!targetClip.sourceId) return;

        try {
            const storedBlob = await assetDb.getFile(targetClip.sourceId);
            if (!storedBlob) return;

            const decodedBuffer = await engineAdapter.decodeAudioData(await storedBlob.arrayBuffer());
            audioEngine.previewBuffer(decodedBuffer);

            applyTrackMutation((prevTracks) => prevTracks.map((track) => {
                if (track.id !== trackId) return track;
                return {
                    ...track,
                    clips: track.clips.map((clip) => (
                        clip.id === targetClip.id
                            ? { ...clip, buffer: decodedBuffer, isOffline: false }
                            : clip
                    ))
                };
            }), { noHistory: true, recolor: false, reason: 'take-panel-audition-cache-buffer' });
        } catch (error) {
            console.error('No se pudo audicionar la toma seleccionada.', error);
        }
    }, [applyTrackMutation]);

    useEffect(() => {
        const handlePunchHotkeys = (event: KeyboardEvent) => {
            if (!event.altKey || event.ctrlKey || event.metaKey) return;

            const target = event.target as HTMLElement | null;
            const tagName = target?.tagName;
            if (tagName === 'INPUT' || tagName === 'TEXTAREA' || target?.isContentEditable) {
                return;
            }

            const key = event.key.toLowerCase();
            if (key === 'p') {
                event.preventDefault();
                toggleSelectedTrackPunch();
                return;
            }

            if (key === 'i') {
                event.preventDefault();
                setSelectedTrackPunchBoundary('in');
                return;
            }

            if (key === 'o') {
                event.preventDefault();
                setSelectedTrackPunchBoundary('out');
            }
        };

        window.addEventListener('keydown', handlePunchHotkeys);
        return () => window.removeEventListener('keydown', handlePunchHotkeys);
    }, [setSelectedTrackPunchBoundary, toggleSelectedTrackPunch]);

    const handleSplitClipAtCursor = useCallback((track: Track, clip: Clip) => {
        const cursorBar = getTransportCursorBar();
        const clipStart = clip.start;
        const clipEnd = clip.start + clip.length;

        if (cursorBar <= clipStart + MIN_CLIP_LENGTH_BARS || cursorBar >= clipEnd - MIN_CLIP_LENGTH_BARS) {
            alert('Coloca el cursor dentro del clip para dividirlo.');
            return;
        }

        const rightClipId = `c-split-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
        let didSplit = false;

        applyTrackMutation((prevTracks) => prevTracks.map((existingTrack) => {
            if (existingTrack.id !== track.id) return existingTrack;

            const clipIndex = existingTrack.clips.findIndex((existingClip) => existingClip.id === clip.id);
            if (clipIndex < 0) return existingTrack;

            const sourceClip = existingTrack.clips[clipIndex];
            const boundedSplitBar = Math.min(
                sourceClip.start + sourceClip.length - MIN_CLIP_LENGTH_BARS,
                Math.max(sourceClip.start + MIN_CLIP_LENGTH_BARS, cursorBar)
            );
            const leftLength = boundedSplitBar - sourceClip.start;
            const rightLength = sourceClip.length - leftLength;

            if (leftLength < MIN_CLIP_LENGTH_BARS || rightLength < MIN_CLIP_LENGTH_BARS) {
                return existingTrack;
            }

            const splitOffset16 = leftLength * 16;
            const leftNotes: Note[] = [];
            const rightNotes: Note[] = [];

            sourceClip.notes.forEach((note) => {
                const start = note.start;
                const end = note.start + note.duration;

                if (end <= splitOffset16) {
                    leftNotes.push({ ...note });
                    return;
                }

                if (start >= splitOffset16) {
                    rightNotes.push({
                        ...note,
                        start: start - splitOffset16
                    });
                    return;
                }

                leftNotes.push({
                    ...note,
                    duration: Math.max(1, splitOffset16 - start)
                });

                rightNotes.push({
                    ...note,
                    start: 0,
                    duration: Math.max(1, end - splitOffset16)
                });
            });

            const nextOffset = existingTrack.type === TrackType.AUDIO
                ? Math.max(0, (sourceClip.offset || 0) + leftLength)
                : sourceClip.offset || 0;

            const leftClip: Clip = {
                ...sourceClip,
                length: leftLength,
                fadeIn: Math.min(sourceClip.fadeIn || 0, leftLength),
                fadeOut: 0,
                notes: leftNotes
            };

            const rightClip: Clip = {
                ...sourceClip,
                id: rightClipId,
                start: boundedSplitBar,
                length: rightLength,
                offset: nextOffset,
                fadeIn: 0,
                fadeOut: Math.min(sourceClip.fadeOut || 0, rightLength),
                notes: rightNotes
            };

            const nextClips = [...existingTrack.clips];
            nextClips[clipIndex] = leftClip;
            nextClips.splice(clipIndex + 1, 0, rightClip);

            let nextTrack: Track = {
                ...existingTrack,
                clips: nextClips,
                sessionClips: existingTrack.sessionClips.map((slot) => {
                    if (slot.clip?.id !== sourceClip.id) return slot;
                    return {
                        ...slot,
                        clip: leftClip
                    };
                })
            };

            nextTrack = splitTakeForClip(nextTrack, sourceClip.id, leftClip, rightClip, buildRuntimeId);
            didSplit = true;

            return nextTrack;
        }), { recolor: false, reason: 'timeline-split-clip-at-cursor' });

        if (!didSplit) {
            alert('No se pudo dividir el clip seleccionado.');
            return;
        }

        setSelectedTrackId(track.id);
        setSelectedClipId(rightClipId);
        setBottomView('editor');
    }, [applyTrackMutation, getTransportCursorBar]);

    const handleDuplicateClip = useCallback((track: Track, clip: Clip) => {
        const duplicateClipId = `c-dup-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
        let duplicated = false;

        applyTrackMutation((prevTracks) => prevTracks.map((existingTrack) => {
            if (existingTrack.id !== track.id) return existingTrack;

            const sourceClip = existingTrack.clips.find((existingClip) => existingClip.id === clip.id);
            if (!sourceClip) return existingTrack;

            const duplicatedClip: Clip = {
                ...sourceClip,
                id: duplicateClipId,
                start: sourceClip.start + sourceClip.length,
                notes: sourceClip.notes.map((note) => ({ ...note }))
            };

            duplicated = true;

            return {
                ...existingTrack,
                clips: [...existingTrack.clips, duplicatedClip].sort((a, b) => a.start - b.start)
            };
        }), { recolor: false, reason: 'timeline-duplicate-clip' });

        if (!duplicated) {
            alert('No se pudo duplicar el clip seleccionado.');
            return;
        }

        setSelectedTrackId(track.id);
        setSelectedClipId(duplicateClipId);
        setBottomView('editor');
    }, [applyTrackMutation]);

    const handlePromoteClipToComp = useCallback((track: Track, clip: Clip) => {
        let promoted = false;
        let missingTake = false;

        applyTrackMutation((prevTracks) => prevTracks.map((existingTrack) => {
            if (existingTrack.id !== track.id) return existingTrack;

            const sourceTake = (existingTrack.recordingTakes || []).find((take) => take.clipId === clip.id);
            if (!sourceTake) {
                missingTake = true;
                return existingTrack;
            }

            promoted = true;
            return promoteTakeToComp(existingTrack, sourceTake.id, {
                replaceExisting: false,
                idFactory: buildRuntimeId
            });
        }), { recolor: false, reason: 'timeline-promote-take-to-comp' });

        if (missingTake) {
            alert('Este clip no pertenece a una toma grabada.');
            return;
        }

        if (!promoted) {
            alert('No se pudo enviar la toma al Comp Lane.');
        }
    }, [applyTrackMutation]);

    const handleConsolidateClips = useCallback(async (track: Track, clipsToConsolidate: Clip[]) => {
        const targetClip = clipsToConsolidate[0];
        if (!targetClip || track.type !== TrackType.AUDIO) return;
        if (!targetClip.buffer) {
            alert('No se puede consolidar un clip sin audio cargado.');
            return;
        }
        if (targetClip.isWarped) {
            alert('Consolidar clips con Warp activo aun no esta habilitado.');
            return;
        }

        try {
            const secondsPerBar = getSecondsPerBar(transport.bpm);
            const renderDuration = Math.max(0.01, targetClip.length * secondsPerBar);
            const sampleRate = targetClip.buffer.sampleRate;
            const numChannels = Math.max(1, targetClip.buffer.numberOfChannels);
            const frameCount = Math.max(1, Math.ceil(renderDuration * sampleRate));

            const offlineCtx = new OfflineAudioContext(numChannels, frameCount, sampleRate);
            const source = offlineCtx.createBufferSource();
            source.buffer = targetClip.buffer;

            const clipGain = offlineCtx.createGain();
            source.connect(clipGain);
            clipGain.connect(offlineCtx.destination);

            const baseGain = Math.max(0, Math.min(2, targetClip.gain ?? 1));
            const fadeInSeconds = Math.max(0, targetClip.fadeIn || 0) * secondsPerBar;
            const fadeOutSeconds = Math.max(0, targetClip.fadeOut || 0) * secondsPerBar;
            const safeFadeIn = Math.min(fadeInSeconds, renderDuration);
            const safeFadeOut = Math.min(fadeOutSeconds, Math.max(0, renderDuration - safeFadeIn));
            const fadeOutStart = Math.max(0, renderDuration - safeFadeOut);

            clipGain.gain.setValueAtTime(safeFadeIn > 0 ? 0 : baseGain, 0);
            if (safeFadeIn > 0) {
                clipGain.gain.linearRampToValueAtTime(baseGain, safeFadeIn);
            }
            if (safeFadeOut > 0) {
                clipGain.gain.setValueAtTime(baseGain, fadeOutStart);
                clipGain.gain.linearRampToValueAtTime(0, renderDuration);
            }

            const bpmRatio = transport.bpm / (targetClip.originalBpm || transport.bpm);
            const transposeSemitones = targetClip.transpose || 0;
            source.playbackRate.value = bpmRatio * Math.pow(2, transposeSemitones / 12);

            const offsetSeconds = Math.max(0, (targetClip.offset || 0) * secondsPerBar);
            source.start(0, offsetSeconds, renderDuration);

            const renderedBuffer = await offlineCtx.startRendering();

            applyTrackMutation((prevTracks) => prevTracks.map((existingTrack) => {
                if (existingTrack.id !== track.id) return existingTrack;

                const nextTrack: Track = {
                    ...existingTrack,
                    clips: existingTrack.clips.map((existingClip) => {
                        if (existingClip.id !== targetClip.id) return existingClip;

                        return {
                            ...existingClip,
                            name: existingClip.name.endsWith(' [CONS]') ? existingClip.name : `${existingClip.name} [CONS]`,
                            buffer: renderedBuffer,
                            sourceId: undefined,
                            offset: 0,
                            fadeIn: 0,
                            fadeOut: 0,
                            gain: 1,
                            transpose: 0,
                            isWarped: false,
                            playbackRate: 1,
                            originalBpm: transport.bpm
                        };
                    })
                };
                return syncTakeMetadataForClip(nextTrack, targetClip.id);
            }), { recolor: false });
        } catch (error) {
            console.error('Consolidate clip failed', error);
            alert('No se pudo consolidar el clip seleccionado.');
        }
    }, [applyTrackMutation, transport.bpm]);

    const handleReverseClip = useCallback((track: Track, clip: Clip) => {
        if (track.type !== TrackType.AUDIO || !clip.buffer) {
            alert('Solo se puede invertir un clip de audio cargado.');
            return;
        }

        const srcBuffer = clip.buffer;
        const reverseCtx = engineAdapter.getContext();
        const reversedBuffer = reverseCtx.createBuffer(
            srcBuffer.numberOfChannels,
            srcBuffer.length,
            srcBuffer.sampleRate
        );

        for (let ch = 0; ch < srcBuffer.numberOfChannels; ch++) {
            const src = srcBuffer.getChannelData(ch);
            const dst = reversedBuffer.getChannelData(ch);
            for (let i = 0; i < src.length; i++) {
                dst[i] = src[src.length - 1 - i];
            }
        }

        applyTrackMutation((prevTracks) => prevTracks.map((existingTrack) => {
            if (existingTrack.id !== track.id) return existingTrack;

            const nextTrack: Track = {
                ...existingTrack,
                clips: existingTrack.clips.map((existingClip) => {
                    if (existingClip.id !== clip.id) return existingClip;

                    return {
                        ...existingClip,
                        name: existingClip.name.endsWith(' [REV]') ? existingClip.name : `${existingClip.name} [REV]`,
                        buffer: reversedBuffer,
                        sourceId: undefined,
                        offset: 0,
                        fadeIn: clip.fadeOut || 0,
                        fadeOut: clip.fadeIn || 0
                    };
                })
            };
            return syncTakeMetadataForClip(nextTrack, clip.id);
        }), { recolor: false });
    }, [applyTrackMutation]);

    const handleQuantizeClip = useCallback((track: Track, clip: Clip) => {
        if (track.type !== TrackType.MIDI || clip.notes.length === 0) {
            alert('Solo se puede cuantizar un clip MIDI con notas.');
            return;
        }

        const step16 = Math.max(1, Math.round(transport.gridSize * 16));

        const quantizedNotes = clip.notes
            .map((note) => ({
                ...note,
                start: Math.max(0, Math.round(note.start / step16) * step16),
                duration: Math.max(step16, Math.round(note.duration / step16) * step16)
            }))
            .sort((a, b) => a.start - b.start || b.pitch - a.pitch);

        applyTrackMutation((prevTracks) => prevTracks.map((existingTrack) => {
            if (existingTrack.id !== track.id) return existingTrack;

            return {
                ...existingTrack,
                clips: existingTrack.clips.map((existingClip) => {
                    if (existingClip.id !== clip.id) return existingClip;
                    return {
                        ...existingClip,
                        notes: quantizedNotes
                    };
                })
            };
        }), { recolor: false });
    }, [applyTrackMutation, transport.gridSize]);

    const buildScannedMidiClip = useCallback((notes: Note[], clipName: string, color: string, startBarOverride?: number): Clip => {
        const maxEnd16th = notes.reduce((maxEnd, note) => {
            return Math.max(maxEnd, note.start + note.duration);
        }, 0);
        const clipLengthBars = Math.max(1, Math.ceil(maxEnd16th / 16));
        const now = Date.now();
        const entropy = Math.floor(Math.random() * 10000);
        const cursorBar = getTransportCursorBar();
        const targetStartBar = Math.max(1, startBarOverride || cursorBar);

        return {
            id: `c-scan-${now}-${entropy}`,
            name: clipName,
            color,
            start: targetStartBar,
            length: clipLengthBars,
            notes,
            offset: 0,
            fadeIn: 0,
            fadeOut: 0,
            gain: 1,
            playbackRate: 1
        };
    }, [getTransportCursorBar]);

    const handleCreateMidiTrackFromScan = useCallback((payload: PianoScoreMidiCommitPayload) => {
        if (payload.notes.length === 0) {
            alert('El escaneo no detecto notas validas para crear un clip MIDI.');
            return null;
        }

        const trackId = `t-scan-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
        const color = getProgressiveTrackColor(tracks.length, tracks.length + 1);
        const sourceClipStart = tracks
            .find((track) => track.id === payload.sourceTrackId)
            ?.clips.find((clip) => clip.id === payload.sourceClipId)
            ?.start;
        const newTrack = createTrack({
            id: trackId,
            name: payload.clipName.startsWith('SCORE DRAFT') ? payload.clipName : `SCAN ${tracks.length + 1}`,
            type: TrackType.MIDI,
            color,
            volume: -6,
            clips: [buildScannedMidiClip(payload.notes, payload.clipName, color, sourceClipStart)]
        });

        appendTrack(newTrack, { reason: 'scanner-create-track', recolor: true });
        setSelectedTrackId(trackId);
        setSelectedClipId(newTrack.clips[0]?.id ?? null);
        setMainView('arrange');
        setBottomView('editor');
        return {
            trackId,
            clipId: newTrack.clips[0]?.id ?? ''
        };
    }, [appendTrack, buildScannedMidiClip, tracks, tracks.length, getProgressiveTrackColor]);

    const handleUpdateMidiClipFromScore = useCallback((trackId: string, clipId: string, payload: PianoScoreMidiCommitPayload): boolean => {
        if (payload.notes.length === 0) {
            return false;
        }

        let updated = false;
        const nextLength = Math.max(1, Math.ceil(payload.notes.reduce((maxEnd, note) => {
            return Math.max(maxEnd, note.start + note.duration);
        }, 0) / 16));

        applyTrackMutation((prevTracks) => prevTracks.map((track) => {
            if (track.id !== trackId || track.type !== TrackType.MIDI) {
                return track;
            }

            const nextClips = track.clips.map((clip) => {
                if (clip.id !== clipId) return clip;
                updated = true;
                return {
                    ...clip,
                    name: payload.clipName || clip.name,
                    notes: payload.notes,
                    length: nextLength
                };
            });

            if (!updated) {
                return track;
            }

            return {
                ...track,
                clips: nextClips,
                sessionClips: track.sessionClips.map((slot) => {
                    if (!slot.clip || slot.clip.id !== clipId) return slot;
                    return {
                        ...slot,
                        clip: {
                            ...slot.clip,
                            name: payload.clipName || slot.clip.name,
                            notes: payload.notes,
                            length: nextLength
                        }
                    };
                })
            };
        }), { recolor: false });

        if (updated) {
            setSelectedTrackId(trackId);
            setSelectedClipId(clipId);
        }

        return updated;
    }, [applyTrackMutation]);

    const handleSelectPianoScoreSource = useCallback((trackId: string, clipId: string) => {
        setSelectedTrackId(trackId);
        setSelectedClipId(clipId);
        setMainView('arrange');
        setBottomView('editor');
    }, []);

    const removeTrackWithRoutingCleanup = useCallback((trackId: string) => {
        applyTrackMutation((prevTracks) => removeTrackRoutingReferences(prevTracks, trackId), { recolor: false, reason: 'delete-track' });

        if (selectedTrackId === trackId) {
            setSelectedTrackId(null);
            setSelectedClipId(null);
        }
    }, [applyTrackMutation, selectedTrackId]);

    const getPlaybackBarTime = useCallback(() => {
        return engineAdapter.getTransportAuthoritySnapshot().currentBarTime;
    }, []);

    const handleMixerTrackUpdate = useCallback((trackId: string, updates: Partial<Track>) => {
        const nowMs = performance.now();
        const barTime = getPlaybackBarTime();

        applyTrackMutation((prevTracks) => prevTracks.map((track) => {
            if (track.id !== trackId) return track;

            let nextTrack: Track = { ...track, ...updates };
            const mode: AutomationMode = nextTrack.automationMode ?? 'read';

            if (Object.prototype.hasOwnProperty.call(updates, 'automationMode')) {
                if (mode !== 'latch') {
                    Array.from(automationLatchActiveRef.current).forEach((key) => {
                        if (key.startsWith(`${trackId}:`)) {
                            automationLatchActiveRef.current.delete(key);
                        }
                    });
                }

                if (mode !== 'touch') {
                    Array.from(automationTouchUntilRef.current.keys()).forEach((key) => {
                        if (key.startsWith(`${trackId}:`)) {
                            automationTouchUntilRef.current.delete(key);
                        }
                    });
                }
            }

            if (!transport.isPlaying || mode === 'off' || mode === 'read') {
                return nextTrack;
            }

            AUTOMATION_TARGETS.forEach((param) => {
                const hasUpdate = Object.prototype.hasOwnProperty.call(updates, param);
                if (!hasUpdate) return;

                const key = `${trackId}:${param}`;

                if (mode === 'touch') {
                    automationTouchUntilRef.current.set(key, nowMs + 240);
                }

                if (mode === 'latch') {
                    automationLatchActiveRef.current.add(key);
                }

                const normalized = normalizeTrackParam(nextTrack, param);
                const withPoint = writeAutomationPoint(nextTrack, param, barTime, normalized);
                if (withPoint !== nextTrack) {
                    nextTrack = withPoint;
                }

                automationLastWriteRef.current.set(key, nowMs);
            });

            return nextTrack;
        }), { recolor: false });
    }, [applyTrackMutation, getPlaybackBarTime, transport.isPlaying]);

    const automationReadTracks = useMemo(() => {
        return tracks.filter((track) => {
            const mode: AutomationMode = track.automationMode ?? 'read';
            if (mode === 'off' || mode === 'write') return false;
            return Boolean(track.automationLanes?.some((lane) => lane.points.length > 0));
        });
    }, [tracks]);

    const automationWriteTrackIds = useMemo(() => {
        return new Set(
            tracks
                .filter((track) => {
                    const mode: AutomationMode = track.automationMode ?? 'read';
                    return mode === 'write' || mode === 'latch';
                })
                .map((track) => track.id)
        );
    }, [tracks]);

    const shouldRunAutomationLoop = automationReadTracks.length > 0 || automationWriteTrackIds.size > 0;

    useEffect(() => {
        if (!transport.isPlaying || !shouldRunAutomationLoop) {
            return;
        }

        let animationFrame = 0;
        let lastFrameTime = 0;
        const targetFps = 30;
        const minFrameDelta = 1000 / targetFps;

        const tick = (timestamp: number) => {
            if ((timestamp - lastFrameTime) >= minFrameDelta) {
                lastFrameTime = timestamp;
                const nowMs = performance.now();
                const barTime = getPlaybackBarTime();

                const runtimeFrameValues: AutomationRuntimeFrame['values'] = [];

                automationReadTracks.forEach((track) => {
                    const mode: AutomationMode = track.automationMode ?? 'read';
                    const runtimeValue: AutomationRuntimeFrame['values'][number] = { trackId: track.id };
                    let hasRuntimeValue = false;

                    AUTOMATION_TARGETS.forEach((param) => {
                        const key = `${track.id}:${param}`;
                        const touchUntil = automationTouchUntilRef.current.get(key) ?? 0;
                        const isTouchActive = mode === 'touch' && nowMs <= touchUntil;
                        const isLatchActive = mode === 'latch' && automationLatchActiveRef.current.has(key);
                        const shouldRead = mode === 'read' || (mode === 'touch' && !isTouchActive) || (mode === 'latch' && !isLatchActive);
                        if (!shouldRead) return;

                        const laneValue = sampleAutomationLaneAtBar(getLaneByParam(track, param), barTime);
                        if (laneValue === null) return;

                        const desired = denormalizeTrackParam(track, param, laneValue);
                        const runtimeParam = param as 'volume' | 'pan' | 'reverb';
                        runtimeValue[runtimeParam] = desired;
                        hasRuntimeValue = true;
                    });

                    if (hasRuntimeValue) {
                        runtimeFrameValues.push(runtimeValue);
                    }
                });

                let changed = false;
                let nextTracks = tracks;

                if (automationWriteTrackIds.size > 0) {
                    nextTracks = tracks.map((track) => {
                        if (!automationWriteTrackIds.has(track.id)) {
                            return track;
                        }

                        const mode: AutomationMode = track.automationMode ?? 'read';
                        let nextTrack = track;

                        AUTOMATION_TARGETS.forEach((param) => {
                            const key = `${track.id}:${param}`;
                            const isLatchActive = mode === 'latch' && automationLatchActiveRef.current.has(key);
                            const shouldWrite = mode === 'write' || isLatchActive;
                            if (!shouldWrite) return;

                            const lastWrite = automationLastWriteRef.current.get(key) ?? 0;
                            if (nowMs - lastWrite < 110) return;

                            const normalized = normalizeTrackParam(nextTrack, param);
                            const withPoint = writeAutomationPoint(nextTrack, param, barTime, normalized);
                            if (withPoint !== nextTrack) {
                                nextTrack = withPoint;
                                changed = true;
                            }
                            automationLastWriteRef.current.set(key, nowMs);
                        });

                        return nextTrack;
                    });
                }

                if (runtimeFrameValues.length > 0) {
                    engineAdapter.applyAutomationRuntimeFrame({
                        capturedAt: Date.now(),
                        barTime,
                        values: runtimeFrameValues
                    });
                }

                if (changed) {
                    setTracksNoHistory(nextTracks);
                }
            }

            animationFrame = requestAnimationFrame(tick);
        };

        animationFrame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(animationFrame);
    }, [automationReadTracks, automationWriteTrackIds, getPlaybackBarTime, setTracksNoHistory, shouldRunAutomationLoop, tracks, transport.isPlaying]);

    useEffect(() => {
        if (transport.isPlaying) {
            return;
        }

        engineAdapter.updateTracks(latestTracksRef.current);
    }, [transport.isPlaying]);

    useEffect(() => {
        if (!transport.isPlaying && wasPlayingRef.current) {
            automationTouchUntilRef.current.clear();
            automationLatchActiveRef.current.clear();
            automationLastWriteRef.current.clear();
        }

        wasPlayingRef.current = transport.isPlaying;
    }, [transport.isPlaying]);

    const storeMixSnapshot = useCallback((slot: MixSnapshotSlot) => {
        const tracksSnapshot: Record<string, TrackMixSnapshot> = {};

        tracks.forEach((track) => {
            tracksSnapshot[track.id] = {
                volume: track.volume,
                pan: track.pan,
                reverb: track.reverb,
                isMuted: track.isMuted,
                isSoloed: track.isSoloed,
                monitor: track.monitor,
                sends: track.sends ? { ...track.sends } : undefined,
                sendModes: track.sendModes ? { ...track.sendModes } : undefined,
                groupId: track.groupId,
                vcaGroupId: track.vcaGroupId,
                soloSafe: track.soloSafe
            };
        });

        const snapshot: MixSnapshot = {
            capturedAt: Date.now(),
            masterVolumeDb: engineAdapter.getMasterVolumeDb(),
            tracks: tracksSnapshot
        };

        setMixSnapshots((prev) => ({ ...prev, [slot]: snapshot }));
        setActiveMixSnapshot(slot);
    }, [tracks]);

    const recallMixSnapshot = useCallback((slot: MixSnapshotSlot) => {
        const snapshot = mixSnapshots[slot];
        if (!snapshot) return;

        applyTrackMutation((prevTracks) => prevTracks.map((track) => {
            const trackSnapshot = snapshot.tracks[track.id];
            if (!trackSnapshot) return track;

            return {
                ...track,
                volume: trackSnapshot.volume,
                pan: trackSnapshot.pan,
                reverb: trackSnapshot.reverb,
                isMuted: trackSnapshot.isMuted,
                isSoloed: trackSnapshot.isSoloed,
                monitor: trackSnapshot.monitor,
                sends: trackSnapshot.sends ? { ...trackSnapshot.sends } : {},
                sendModes: trackSnapshot.sendModes ? { ...trackSnapshot.sendModes } : {},
                groupId: trackSnapshot.groupId,
                vcaGroupId: trackSnapshot.vcaGroupId,
                soloSafe: trackSnapshot.soloSafe ?? false
            };
        }), { recolor: false });

        engineAdapter.setMasterVolumeDb(snapshot.masterVolumeDb);
        setActiveMixSnapshot(slot);
    }, [applyTrackMutation, mixSnapshots]);

    const toggleMixSnapshotCompare = useCallback(() => {
        const hasA = Boolean(mixSnapshots.A);
        const hasB = Boolean(mixSnapshots.B);

        if (hasA && hasB) {
            const nextSlot: MixSnapshotSlot = activeMixSnapshot === 'A' ? 'B' : 'A';
            recallMixSnapshot(nextSlot);
            return;
        }

        if (hasA) {
            recallMixSnapshot('A');
            return;
        }

        if (hasB) {
            recallMixSnapshot('B');
        }
    }, [activeMixSnapshot, mixSnapshots, recallMixSnapshot]);

    const handleStartCollabSession = useCallback(() => {
        const now = Date.now();
        const sessionId = `ETH-${now.toString(36).toUpperCase()}-${Math.floor(Math.random() * 9999).toString().padStart(4, '0')}`;
        setCollabSessionId(sessionId);
        lastCollabCommandRef.current = projectCommandCount;
        setCollabActivity([
            {
                id: `collab-${now}`,
                timestamp: now,
                message: `${collabUserName || 'Host'} inicio sesion ${sessionId}`
            }
        ]);
    }, [collabUserName, projectCommandCount]);

    const handleStopCollabSession = useCallback(() => {
        const now = Date.now();
        setCollabActivity((prev) => ([
            {
                id: `collab-stop-${now}`,
                timestamp: now,
                message: `Sesion ${collabSessionId} cerrada por host`
            },
            ...prev
        ].slice(0, 60)));
        setCollabSessionId(null);
    }, [collabSessionId]);

    const handleCopyCollabInvite = useCallback(async () => {
        if (!collabSessionId) return;

        const invite = `HOLLOWBITS://session/${collabSessionId}`;
        try {
            await navigator.clipboard.writeText(invite);
            const now = Date.now();
            setCollabActivity((prev) => ([
                {
                    id: `collab-copy-${now}`,
                    timestamp: now,
                    message: 'Invite de sesion copiado al portapapeles'
                },
                ...prev
            ].slice(0, 60)));
        } catch (error) {
            console.warn('No se pudo copiar el invite de colaboracion.', error);
            alert(`Invite de colaboracion:\n${invite}`);
        }
    }, [collabSessionId]);

    useEffect(() => {
        if (!collabSessionId) {
            lastCollabCommandRef.current = projectCommandCount;
            return;
        }

        if (projectCommandCount <= lastCollabCommandRef.current) {
            return;
        }

        const delta = projectCommandCount - lastCollabCommandRef.current;
        const now = Date.now();
        setCollabActivity((prev) => ([
            {
                id: `collab-sync-${now}`,
                timestamp: now,
                message: `${delta} cambio(s) agregado(s) al stream colaborativo por ${collabUserName || 'Host'}`
            },
            ...prev
        ].slice(0, 60)));
        lastCollabCommandRef.current = projectCommandCount;
    }, [collabSessionId, collabUserName, projectCommandCount]);

    const handleMixerMacroApply = useCallback((macroId: 'vocal-up' | 'drum-glue' | 'mono-check' | 'headroom-safe') => {
        const isKeywordMatch = (name: string, keywords: string[]) => {
            const lower = name.toLowerCase();
            return keywords.some((keyword) => lower.includes(keyword));
        };

        if (macroId === 'mono-check') {
            if (!monoCheckStateRef.current.active) {
                const panSnapshot: Record<string, number> = {};

                applyTrackMutation((prevTracks) => prevTracks.map((track) => {
                    panSnapshot[track.id] = track.pan;
                    return {
                        ...track,
                        pan: 0
                    };
                }), { recolor: false });

                monoCheckStateRef.current = {
                    active: true,
                    pans: panSnapshot
                };
            } else {
                const panSnapshot = monoCheckStateRef.current.pans;
                applyTrackMutation((prevTracks) => prevTracks.map((track) => ({
                    ...track,
                    pan: panSnapshot[track.id] ?? track.pan
                })), { recolor: false });
                monoCheckStateRef.current = { active: false, pans: {} };
            }

            return;
        }

        applyTrackMutation((prevTracks) => prevTracks.map((track) => {
            if (track.type === TrackType.RETURN) return track;

            if (macroId === 'vocal-up') {
                const isVocalTrack = isKeywordMatch(track.name, ['vocal', 'voz', 'lead', 'vox']);
                const delta = isVocalTrack ? 2 : -0.8;
                return {
                    ...track,
                    volume: Math.max(-60, Math.min(6, track.volume + delta))
                };
            }

            if (macroId === 'drum-glue') {
                const isDrumTrack = isKeywordMatch(track.name, ['drum', 'kick', 'snare', 'hihat', 'hat', 'perc', 'bombo']);
                if (!isDrumTrack) {
                    return {
                        ...track,
                        reverb: Math.max(0, track.reverb > 1 ? track.reverb - 5 : track.reverb - 0.05)
                    };
                }

                const boostedReverb = track.reverb > 1
                    ? Math.min(100, track.reverb + 8)
                    : Math.min(1, track.reverb + 0.08);

                return {
                    ...track,
                    volume: Math.max(-60, Math.min(6, track.volume + 1.2)),
                    reverb: boostedReverb
                };
            }

            if (macroId === 'headroom-safe') {
                return {
                    ...track,
                    volume: Math.min(track.volume, -6),
                    reverb: track.reverb > 1 ? Math.min(track.reverb, 25) : Math.min(track.reverb, 0.25)
                };
            }

            return track;
        }), { recolor: false });

        if (macroId === 'headroom-safe') {
            engineAdapter.setMasterVolumeDb(Math.min(engineAdapter.getMasterVolumeDb(), -3));
        }
    }, [applyTrackMutation]);

    useEffect(() => {
        const handleMixSnapshotHotkeys = (event: KeyboardEvent) => {
            if (!(event.ctrlKey || event.metaKey)) return;

            const target = event.target as HTMLElement | null;
            const tagName = target?.tagName;
            if (tagName === 'INPUT' || tagName === 'TEXTAREA' || target?.isContentEditable) {
                return;
            }

            const key = event.key.toLowerCase();

            if (event.altKey && key === '1') {
                event.preventDefault();
                storeMixSnapshot('A');
                return;
            }

            if (event.altKey && key === '2') {
                event.preventDefault();
                storeMixSnapshot('B');
                return;
            }

            if (event.shiftKey && key === 'x') {
                event.preventDefault();
                toggleMixSnapshotCompare();
                return;
            }

            if (!event.altKey && !event.shiftKey && key === '1') {
                event.preventDefault();
                recallMixSnapshot('A');
                return;
            }

            if (!event.altKey && !event.shiftKey && key === '2') {
                event.preventDefault();
                recallMixSnapshot('B');
            }
        };

        window.addEventListener('keydown', handleMixSnapshotHotkeys);
        return () => window.removeEventListener('keydown', handleMixSnapshotHotkeys);
    }, [recallMixSnapshot, storeMixSnapshot, toggleMixSnapshotCompare]);

    const handleRecordToggle = useCallback(async () => {
        const commandToken = beginTransportCommand();

        if (hasActiveRecordingSessions()) {
            await finalizeActiveRecordings();
            return;
        }

        let armedTracks = tracks.filter((track) => track.isArmed && track.type === TrackType.AUDIO);

        if (armedTracks.length === 0) {
            const newTrack = createTrack({
                id: buildRuntimeId('t-rec'),
                name: `REC VOCAL ${tracks.length + 1}`,
                type: TrackType.AUDIO,
                color: getProgressiveTrackColor(tracks.length, tracks.length + 1),
                isArmed: true,
                monitor: 'in',
                micSettings: {
                    profile: 'studio-voice',
                    inputGain: 1,
                    monitoringEnabled: true,
                    monitoringReverb: false,
                    monitoringEcho: false,
                    monitorInputMode: 'mono',
                    monitorLatencyCompensationMs: 0
                }
            });

            appendTracks([newTrack], { reason: 'record-auto-track', recolor: true });
            armedTracks = [newTrack];
        }

        if (!isTransportCommandCurrent(commandToken)) {
            return;
        }

        resetAudioIncidentWindow(true);
        const secondsPerBar = getSecondsPerBar(transport.bpm);
        const diagnostics = engineAdapter.getDiagnostics();
        const estimatedLatencyCompensationBars = Math.max(0, (diagnostics.latency || 0) / secondsPerBar);

        const punchPlan = resolvePunchRecordingPlan(armedTracks);
        const transportWasRunning = isPlayingRef.current || engineAdapter.getIsPlaying() || transport.isPlaying;
        const recordingStartAuthority = engineAdapter.getTransportAuthoritySnapshot();
        const journalEntriesByTrack = new Map(
            armedTracks.map((track) => {
                const monitorMode = track.micSettings?.monitorInputMode || 'mono';
                return [track.id, createRecordingJournalEntry({
                    id: buildRuntimeId('rec-journal'),
                    trackId: track.id,
                    trackName: track.name,
                    inputDeviceId: track.inputDeviceId,
                    monitorMode,
                    createdAt: Date.now(),
                    barTime: recordingStartAuthority.currentBarTime,
                    contextTimeSec: recordingStartAuthority.currentTimeSec
                })];
            })
        );
        const failStartJournalEntries = (reason: string) => {
            journalEntriesByTrack.forEach((entry) => {
                failRecordingJournalForTrack(entry.id, reason, {
                    at: Date.now(),
                    barTime: recordingStartAuthority.currentBarTime,
                    contextTimeSec: recordingStartAuthority.currentTimeSec
                });
            });
        };

        updateRecordingJournal((entries) => pruneRecordingJournalEntries([
            ...entries,
            ...Array.from(journalEntriesByTrack.values())
        ]));

        if (punchPlan) {
            const playbackStartBar = punchPlan.startPlaybackBar;
            const playbackStartTime = barToSeconds(playbackStartBar, transport.bpm);
            const playbackStartPosition = barTimeToPosition(playbackStartBar);

            engineAdapter.seek(playbackStartTime, latestTracksRef.current, transport.bpm);

            if (!transportWasRunning) {
                const ready = await engineAdapter.ensurePlaybackReady();
                if (!ready || !isTransportCommandCurrent(commandToken)) {
                    failStartJournalEntries('record-start-aborted:punch-preroll');
                    return;
                }

                isPlayingRef.current = true;
                pauseResumeArmedRef.current = false;
                engineAdapter.play(latestTracksRef.current, transport.bpm, 1, playbackStartTime);

                if (!engineAdapter.getIsPlaying() || !isTransportCommandCurrent(commandToken)) {
                    isPlayingRef.current = false;
                    failStartJournalEntries('record-start-aborted:transport-play');
                    return;
                }
            }

            const punchStartSnapshot = engineAdapter.getTransportAuthoritySnapshot();
            syncTransportStateFromAuthority(punchStartSnapshot, {
                isPlaying: true,
                currentBar: playbackStartPosition.currentBar,
                currentBeat: playbackStartPosition.currentBeat,
                currentSixteenth: playbackStartPosition.currentSixteenth
            });
        } else if (!transportWasRunning) {
            const startedPlayback = await playFromTransportCursor(commandToken);
            if (!startedPlayback || !isTransportCommandCurrent(commandToken)) {
                failStartJournalEntries('record-start-aborted:cursor-play');
                return;
            }
        }

        const recordingStartSnapshot = engineAdapter.getTransportAuthoritySnapshot();
        const recordingCaptureStartBar = recordingStartSnapshot.currentBarTime;
        const recordingTargetStartBar = punchPlan ? punchPlan.punchInBar : recordingCaptureStartBar;
        const sourceTrimOffsetBars = punchPlan
            ? Math.max(0, recordingTargetStartBar - recordingCaptureStartBar)
            : 0;

        pauseResumeArmedRef.current = false;
        setTransport((prev: TransportState) => ({ ...prev, isPlaying: true, isRecording: true }));
        await Promise.all(armedTracks.map(async (track) => {
            const journalEntry = journalEntriesByTrack.get(track.id);
            try {
                appendRecordingJournalForTrack(journalEntry?.id, 'start-requested', {
                    at: Date.now(),
                    barTime: recordingTargetStartBar,
                    contextTimeSec: recordingStartSnapshot.currentTimeSec
                });
                await engineAdapter.startRecording(track.id, track.inputDeviceId);
                const monitorLatencyCompBars = Math.max(
                    0,
                    ((track.micSettings?.monitorLatencyCompensationMs || 0) / 1000) / secondsPerBar
                );
                appendRecordingJournalForTrack(journalEntry?.id, 'started', {
                    at: Date.now(),
                    barTime: recordingTargetStartBar,
                    contextTimeSec: recordingStartSnapshot.currentTimeSec,
                    details: {
                        monitorMode: track.micSettings?.monitorInputMode || 'mono',
                        sourceTrimOffsetBars: Number(sourceTrimOffsetBars.toFixed(6))
                    }
                });
                recordingSessionMetaRef.current.set(track.id, {
                    journalId: journalEntry?.id || buildRuntimeId('rec-journal-fallback'),
                    monitorMode: track.micSettings?.monitorInputMode || 'mono',
                    recordingStartBar: recordingTargetStartBar,
                    latencyCompensationBars: estimatedLatencyCompensationBars + monitorLatencyCompBars,
                    sourceTrimOffsetBars,
                    punchOutBar: punchPlan?.punchOutBar
                });
            } catch (error) {
                console.error(`No se pudo iniciar grabacion para ${track.name}.`, error);
                failRecordingJournalForTrack(
                    journalEntry?.id,
                    `start-failed:${track.name}`,
                    {
                        at: Date.now(),
                        barTime: recordingTargetStartBar,
                        contextTimeSec: recordingStartSnapshot.currentTimeSec
                    }
                );
                recordingSessionMetaRef.current.delete(track.id);
            }
        }));

        const activeRecordingTrackIds = new Set(engineAdapter.getActiveRecordingTrackIds());
        armedTracks.forEach((track) => {
            if (!activeRecordingTrackIds.has(track.id)) {
                const journalEntry = journalEntriesByTrack.get(track.id);
                failRecordingJournalForTrack(
                    journalEntry?.id,
                    `inactive-after-start:${track.name}`,
                    { at: Date.now() }
                );
                recordingSessionMetaRef.current.delete(track.id);
            }
        });

        if (activeRecordingTrackIds.size === 0) {
            clearRecordingRuntimeForTracks(armedTracks.map((track) => track.id));
            setTransport((prev: TransportState) => ({ ...prev, isRecording: false }));
        }
    }, [appendRecordingJournalForTrack, beginTransportCommand, transport.isPlaying, tracks, hasActiveRecordingSessions, finalizeActiveRecordings, appendTracks, isTransportCommandCurrent, playFromTransportCursor, transport.bpm, getProgressiveTrackColor, updateRecordingJournal, syncTransportStateFromAuthority, failRecordingJournalForTrack, clearRecordingRuntimeForTracks, resetAudioIncidentWindow]);

    useEffect(() => {
        if (!transport.isRecording) return;

        let animationFrame = 0;
        const checkPunchAutoStop = () => {
            if (!transport.isRecording) return;

            const activeRecordingTrackIds = engineAdapter.getActiveRecordingTrackIds();
            if (activeRecordingTrackIds.length === 0) {
                animationFrame = requestAnimationFrame(checkPunchAutoStop);
                return;
            }

            const transportSnapshot = engineAdapter.getTransportAuthoritySnapshot();
            const punchDecision = shouldFinalizePunchRecording(
                transportSnapshot.currentBarTime,
                activeRecordingTrackIds,
                recordingSessionMetaRef.current
            );
            if (!punchDecision.shouldFinalize) {
                animationFrame = requestAnimationFrame(checkPunchAutoStop);
                return;
            }

            void finalizeActiveRecordings();
        };

        animationFrame = requestAnimationFrame(checkPunchAutoStop);
        return () => cancelAnimationFrame(animationFrame);
    }, [transport.isRecording, transport.bpm, finalizeActiveRecordings]);

    const buildPersistedTracks = useCallback((sourceTracks: Track[]): Track[] => {
        return sourceTracks.map((track) => ({
            ...track,
            clips: track.clips.map(toPersistentClip),
            sessionClips: track.sessionClips.map((slot) => ({
                ...slot,
                clip: slot.clip ? toPersistentClip(slot.clip) : null,
                isPlaying: false,
                isQueued: false
            })),
            recordingTakes: (track.recordingTakes || []).map((take) => ({ ...take })),
            takeLanes: (track.takeLanes || []).map((lane) => ({
                ...lane,
                takeIds: [...lane.takeIds],
                compSegments: lane.compSegments ? lane.compSegments.map((segment) => ({ ...segment })) : undefined
            })),
            punchRange: track.punchRange ? { ...track.punchRange } : undefined
        }));
    }, []);

    const autosaveTransportSnapshot = useMemo<TransportState>(() => ({
        ...transport,
        isPlaying: false,
        isRecording: false,
        currentBar: 1,
        currentBeat: 1,
        currentSixteenth: 1
    }), [
        transport.bpm,
        transport.gridSize,
        transport.loopMode,
        transport.masterTranspose,
        transport.scaleRoot,
        transport.scaleType,
        transport.snapToGrid,
        transport.timeSignature
    ]);

    const createProjectDataSnapshot = useCallback((transportSnapshot: TransportState, nameOverride?: string): ProjectData => {
        const snapshot: ProjectData = {
            version: '3.0-reference',
            name: nameOverride || projectName,
            tracks: buildPersistedTracks(tracks),
            transport: transportSnapshot,
            audioSettings,
            scoreWorkspaces: scoreWorkspaces.map((workspace) => ({
                ...workspace,
                source: { ...workspace.source },
                layout: { ...workspace.layout },
                notationOverrides: workspace.notationOverrides.map((override) => ({ ...override })),
                confidenceRegions: workspace.confidenceRegions.map((region) => ({ ...region }))
            })),
            createdAt: Date.now(),
            lastModified: Date.now()
        };
        return repairProjectData(snapshot, { source: 'snapshot-save' }).project;
    }, [audioSettings, buildPersistedTracks, projectName, scoreWorkspaces, tracks]);

    const hydrateProjectData = useCallback(async (
        projectCandidate: ProjectData,
        preferredName?: string,
        options?: { source?: string; rememberReport?: boolean }
    ): Promise<ProjectIntegrityReport> => {
        const integrityResult = repairProjectData(projectCandidate, { source: options?.source || 'hydrate-project' });
        const projectData = integrityResult.project;

        if (options?.rememberReport !== false) {
            rememberProjectIntegrityReport(integrityResult.report);
        }

        engineAdapter.stop(true);
        isPlayingRef.current = false;
        pauseResumeArmedRef.current = false;
        setLoadingMessage('Relacionando Archivos...');

        const rehydratedTracks = await Promise.all(projectData.tracks.map(async (track: Track) => {
            const rehydratedClips = await Promise.all(track.clips.map(async (clip: Clip) => {
                if (track.type === TrackType.AUDIO && clip.sourceId) {
                    const blob = await assetDb.getFile(clip.sourceId);
                    if (blob) {
                        const arrayBuffer = await blob.arrayBuffer();
                        const buffer = await engineAdapter.decodeAudioData(arrayBuffer);
                        return { ...clip, buffer, isOffline: false };
                    }

                    return { ...clip, isOffline: true, buffer: undefined };
                }

                return clip;
            }));

            const clipById = new Map(rehydratedClips.map((clip) => [clip.id, clip]));
            const sourceSessionClips = Array.isArray(track.sessionClips) ? track.sessionClips : [];
            const normalizedSessionClips = sourceSessionClips.map((slot, index) => ({
                id: slot.id || `slot-${track.id}-${index}`,
                clip: slot.clip ? clipById.get(slot.clip.id) || null : null,
                isPlaying: false,
                isQueued: false
            }));

            return withTrackRuntimeDefaults({
                ...track,
                clips: rehydratedClips,
                sessionClips: normalizedSessionClips
            });
        }));

        replaceTracks(rehydratedTracks, { recolor: true });

        const normalizedTransport: TransportState = {
            ...projectData.transport,
            loopMode: normalizeLoopMode(projectData.transport),
            isLooping: undefined,
            isPlaying: false,
            isRecording: false
        };

        setTransport(normalizedTransport);
        setAudioSettings(sanitizeAudioSettings(projectData.audioSettings || getDefaultAudioSettings()));
        setScoreWorkspaces((projectData.scoreWorkspaces || []).map((workspace) => ({
            ...workspace,
            source: { ...workspace.source },
            layout: { ...workspace.layout },
            notationOverrides: workspace.notationOverrides.map((override) => ({ ...override })),
            confidenceRegions: workspace.confidenceRegions.map((region) => ({ ...region }))
        })));
        setProjectName(preferredName || projectData.name || 'Sin Título');

        engineAdapter.setBpm(normalizedTransport.bpm);
        engineAdapter.setMasterPitch(normalizedTransport.masterTranspose);

        setSelectedTrackId(rehydratedTracks[0]?.id || null);
        setSelectedClipId(rehydratedTracks[0]?.clips[0]?.id || null);
        return integrityResult.report;
    }, [rememberProjectIntegrityReport, replaceTracks]);

    const createProjectOsSnapshot = useCallback((): ProjectData => {
        const clockSnapshot = getTransportClockSnapshot();
        return createProjectDataSnapshot({
            ...transport,
            isPlaying: false,
            isRecording: false,
            currentBar: clockSnapshot.currentBar,
            currentBeat: clockSnapshot.currentBeat,
            currentSixteenth: clockSnapshot.currentSixteenth
        }, projectName);
    }, [createProjectDataSnapshot, projectName, transport]);

    const handleRestoreProjectOsSnapshot = useCallback(async (project: ProjectData, preferredName?: string) => {
        setLoadingProject(true);
        setLoadingMessage('Restaurando Project OS...');
        try {
            await hydrateProjectData(project, preferredName || projectName, {
                source: 'project-os-restore',
                rememberReport: true
            });
        } finally {
            setLoadingProject(false);
            setLoadingMessage('');
        }
    }, [hydrateProjectData, projectName]);

    const handleRestoreRecoverySnapshot = useCallback(async () => {
        if (!recoverySnapshot) {
            setActiveModal(null);
            return;
        }

        setLoadingProject(true);
        setLoadingMessage('Restaurando autosave...');

        try {
            await hydrateProjectData(recoverySnapshot.project, recoverySnapshot.projectName, {
                source: 'recovery-restore',
                rememberReport: true
            });
            clearAutosaveSnapshot(recoverySnapshot.id);
            setRecoverySnapshot(null);
            setActiveModal(null);
        } catch (error) {
            console.error('Recovery restore failed', error);
            alert('No se pudo restaurar el autosave.');
        } finally {
            setLoadingProject(false);
            setLoadingMessage('');
        }
    }, [hydrateProjectData, recoverySnapshot]);

    const handleDiscardRecoverySnapshot = useCallback(() => {
        if (recoverySnapshot) {
            clearAutosaveSnapshot(recoverySnapshot.id);
        }
        setRecoverySnapshot(null);
        setActiveModal(null);
    }, [recoverySnapshot]);

    useEffect(() => {
        const sessionInfo = startRecoverySession();
        if (sessionInfo.hadUncleanExit) {
            updateRecordingJournal((entries) => recoverRecordingJournalEntries(
                entries,
                'unclean-exit',
                Date.now()
            ));

            const latestSnapshot = getLatestAutosaveSnapshot();
            if (latestSnapshot) {
                setRecoverySnapshot(latestSnapshot);
                setLastAutosaveAt(latestSnapshot.timestamp);
                setLastAutosaveReason(latestSnapshot.reason);
                setActiveModal('recovery');
            }
        }

        const handleBeforeUnload = () => {
            stopRecoverySession();
        };

        window.addEventListener('beforeunload', handleBeforeUnload);
        return () => {
            window.removeEventListener('beforeunload', handleBeforeUnload);
            stopRecoverySession();
        };
    }, [updateRecordingJournal]);
    useEffect(() => {
        if (activeModal === 'recovery') return;
        if (recordingRecoveryAttentionSummary.totalCount === 0) return;
        setActiveModal((current) => current ?? 'recording-recovery');
    }, [activeModal, recordingRecoveryAttentionSummary.totalCount]);

    useEffect(() => {
        const timeoutId = window.setTimeout(() => {
            const snapshot: ProjectAutosaveSnapshot = {
                id: `autosave-${Date.now()}`,
                timestamp: Date.now(),
                reason: projectCommandCount > 0 ? `mutation-${projectCommandCount}` : 'initial-snapshot',
                commandCount: projectCommandCount,
                projectName,
                project: createProjectDataSnapshot(autosaveTransportSnapshot, projectName)
            };

            saveAutosaveSnapshot(snapshot);
            setLastAutosaveAt(snapshot.timestamp);
            setLastAutosaveReason(snapshot.reason);
        }, AUTOSAVE_DEBOUNCE_MS);

        return () => window.clearTimeout(timeoutId);
    }, [autosaveTransportSnapshot, createProjectDataSnapshot, projectCommandCount, projectName]);

    // ── CLOUD AUTO-SAVE (every 30s when connected to cloud project) ──
    const lastCloudSaveCommandRef = useRef(0);
    useEffect(() => {
        if (!collabSessionId || !user) return;

        const intervalId = window.setInterval(async () => {
            if (projectCommandCount <= lastCloudSaveCommandRef.current) return;
            try {
                const clockSnapshot = getTransportClockSnapshot();
                const snapshot = createProjectDataSnapshot({
                    ...transport,
                    isPlaying: false,
                    isRecording: false,
                    currentBar: clockSnapshot.currentBar,
                    currentBeat: clockSnapshot.currentBeat,
                    currentSixteenth: clockSnapshot.currentSixteenth
                }, projectName);
                const integrityResult = repairProjectData(snapshot, { source: 'cloud-autosave' });

                await supabase.from('projects').update({
                    data: integrityResult.project as any,
                    name: projectName,
                    updated_at: new Date().toISOString()
                }).eq('id', collabSessionId);

                lastCloudSaveCommandRef.current = projectCommandCount;
            } catch (err) {
                console.warn('[CloudAutoSave] Silent save failed:', err);
            }
        }, 30000);

        return () => window.clearInterval(intervalId);
    }, [collabSessionId, user, projectCommandCount, transport, projectName, createProjectDataSnapshot]);

    // ... (Project management handlers remain same)

    const resetProjectToEmpty = useCallback(() => {
        replaceTracks([], { recolor: false });
        setProjectName("Sin Título");
        setSelectedTrackId(null);
        setSelectedClipId(null);
        setScoreWorkspaces([]);
        closeAllToolPanels();
        setTransport((prev: TransportState) => ({
            ...prev,
            isPlaying: false,
            isRecording: false,
            currentBar: 1,
            currentBeat: 1,
            currentSixteenth: 1,
            bpm: 124,
            masterTranspose: 0,
            loopMode: 'off',
            scaleRoot: 0,
            scaleType: 'minor'
        }));
        setCollabSessionId(null);
        window.history.pushState({}, '', window.location.pathname);
        setActiveModal(null);
        engineAdapter.stop(true);
        isPlayingRef.current = false;
        pauseResumeArmedRef.current = false;
    }, [closeAllToolPanels, replaceTracks, setCollabSessionId]);

    const handleNewProject = useCallback(() => { setActiveModal('new-project-confirm'); }, []);

    // Rename project handler — updates local state and syncs to cloud if connected
    const handleRenameProject = useCallback(async (newName: string) => {
        const trimmed = newName.trim();
        if (!trimmed || trimmed === projectName) {
            setIsRenamingProject(false);
            return;
        }
        setProjectName(trimmed);
        setIsRenamingProject(false);
        // Sync rename to cloud if we have a session
        if (collabSessionId && user) {
            try {
                await supabase.from('projects').update({ name: trimmed }).eq('id', collabSessionId);
            } catch (e) {
                console.error('[Rename] Cloud sync failed:', e);
            }
        }
    }, [collabSessionId, projectName, user]);

    // Open project browser — fetches cloud projects and shows the side panel
    const handleOpenProjectBrowser = useCallback(async () => {
        setShowFileMenu(false);
        setShowProjectBrowser(true);
        if (!user) return;
        setLoadingCloudProjects(true);
        try {
            const { data: memberships } = await supabase
                .from('workspace_members')
                .select('workspace_id')
                .eq('user_id', user.id);
            if (memberships && memberships.length > 0) {
                const wsIds = memberships.map(m => m.workspace_id);
                const { data: projects } = await supabase
                    .from('projects')
                    .select('id, name, updated_at, data')
                    .in('workspace_id', wsIds)
                    .order('updated_at', { ascending: false });
                if (projects) setCloudProjects(projects);
            }
        } catch (e) {
            console.error('[ProjectBrowser] Error:', e);
        } finally {
            setLoadingCloudProjects(false);
        }
    }, [user]);

    // Load a specific cloud project from the browser panel
    const handleLoadCloudProject = useCallback(async (project: { id: string; name: string; data: any }) => {
        setShowProjectBrowser(false);
        setLoadingProject(true);
        setLoadingMessage('Cargando proyecto...');
        try {
            setProjectName(project.name);
            setCollabSessionId(project.id);
            if (project.data && Object.keys(project.data).length > 0) {
                const integrityReport = await hydrateProjectData(project.data as unknown as ProjectData, project.name, {
                    source: 'open-project',
                    rememberReport: true
                });
                if (integrityReport.issueCount > 0) {
                    console.warn('Project integrity repaired during open.', integrityReport);
                }
            }
        } catch (e) {
            console.error('[LoadCloudProject] Error:', e);
            alert('Error al cargar el proyecto.');
        } finally {
            setLoadingProject(false);
            setLoadingMessage('');
        }
    }, [hydrateProjectData]);

    // Import from local disk (.esp file)
    const handleImportFromDisk = async () => {
        setShowFileMenu(false);
        try {
            setLoadingProject(true);
            setLoadingMessage("Leyendo proyecto...");

            const result = await platformService.openProjectFile();
            if (!result) {
                setLoadingProject(false);
                setLoadingMessage("");
                return; // User cancelled
            }

            const { text, filename } = result;
            const projectData: ProjectData = JSON.parse(text);

            const nameFromDisk = filename.replace(/\.esp$/i, '');
            const integrityReport = await hydrateProjectData(projectData, nameFromDisk || projectData.name, {
                source: 'open-project',
                rememberReport: true
            });
            if (integrityReport.issueCount > 0) {
                console.warn('Project integrity repaired during open.', integrityReport);
                alert(summarizeProjectIntegrityReport(integrityReport, 'Proyecto abierto'));
            }

        } catch (err) {
            console.error("Open Project Error", err);
            alert("Error crítico al leer el archivo. El formato puede estar corrupto.");
        } finally {
            setLoadingProject(false);
            setLoadingMessage("");
            closeAllToolPanels();
        }
    };

    const handleDownloadProject = useCallback(async () => {
        setLoadingProject(true);
        setLoadingMessage("Preparando archivo local...");

        setTimeout(async () => {
            try {
                if (transport.isPlaying) {
                    engineAdapter.pause();
                    setTransport((prev: TransportState) => ({ ...prev, isPlaying: false }));
                    isPlayingRef.current = false;
                    pauseResumeArmedRef.current = false;
                }
                const clockSnapshot = getTransportClockSnapshot();
                const projectMetadata = createProjectDataSnapshot({
                    ...transport,
                    isPlaying: false,
                    isRecording: false,
                    currentBar: clockSnapshot.currentBar,
                    currentBeat: clockSnapshot.currentBeat,
                    currentSixteenth: clockSnapshot.currentSixteenth
                }, projectName);
                const integrityResult = repairProjectData(projectMetadata, { source: 'save-project' });
                rememberProjectIntegrityReport(integrityResult.report);
                const jsonString = JSON.stringify(integrityResult.project, null, 2);

                await platformService.saveProject(jsonString, projectName);
            } catch (err) {
                console.error("Error al descargar proyecto:", err);
                alert("Hubo un error al intentar descargar el proyecto.");
            } finally {
                setLoadingProject(false);
            }
        }, 50);
    }, [transport, projectName, createProjectDataSnapshot]);

    const handleSaveProject = useCallback(async () => {
        if (isReadOnly) {
            alert("No tienes permisos para guardar cambios en este proyecto.");
            return;
        }
        
        setLoadingProject(true);
        setLoadingMessage("Guardando metadatos...");

        setTimeout(async () => {
            try {
                if (transport.isPlaying) {
                    engineAdapter.pause();
                    setTransport((prev: TransportState) => ({ ...prev, isPlaying: false }));
                    isPlayingRef.current = false;
                    pauseResumeArmedRef.current = false;
                }
                const clockSnapshot = getTransportClockSnapshot();
                const projectMetadata = createProjectDataSnapshot({
                    ...transport,
                    isPlaying: false,
                    isRecording: false,
                    currentBar: clockSnapshot.currentBar,
                    currentBeat: clockSnapshot.currentBeat,
                    currentSixteenth: clockSnapshot.currentSixteenth
                }, projectName);
                const integrityResult = repairProjectData(projectMetadata, { source: 'save-project' });
                rememberProjectIntegrityReport(integrityResult.report);
                const jsonString = JSON.stringify(integrityResult.project, null, 2);

                if (collabSessionId) {
                    setLoadingMessage("Guardando en la nube...");
                    try {
                        const { error } = await supabase.from('projects').update({
                            data: integrityResult.project as any,
                            name: projectName,
                            updated_at: new Date().toISOString()
                        }).eq('id', collabSessionId);
                        
                        if (error) throw error;
                    } catch (e) {
                        console.error('Error saving to cloud:', e);
                        alert("Error al guardar en la nube.");
                    }
                } else if (user) {
                    setLoadingMessage("Creando proyecto en la nube...");
                    try {
                        const { data: memberships, error: wsError } = await supabase
                            .from('workspace_members')
                            .select('workspace_id')
                            .eq('user_id', user.id)
                            .limit(1);
                        
                        if (wsError || !memberships || memberships.length === 0) throw new Error("Workspace no encontrado");
                        
                        const workspaceId = memberships[0].workspace_id;
                        const { data: newProjectId, error: createError } = await supabase.rpc('create_project_with_limit', {
                            p_name: projectName,
                            p_workspace_id: workspaceId,
                            p_bpm: 120,
                            p_sample_rate: 44100,
                            p_is_public: false,
                            p_data: integrityResult.project as any
                        });
                        
                        if (createError) {
                            if (createError.message.includes('limit reached')) {
                                alert('Has alcanzado el límite de proyectos para la capa gratuita. Por favor actualiza tu plan o elimina un proyecto.');
                            } else {
                                throw createError;
                            }
                            // Don't fallback to local, just stop
                            setLoadingProject(false);
                            setLoadingMessage("");
                            return;
                        }
                        
                        if (!newProjectId) throw new Error("No se devolvió ID del proyecto");
                        
                        setCollabSessionId(newProjectId as string);
                        window.history.pushState({}, '', `${window.location.pathname}?project=${newProjectId}`);
                    } catch (e) {
                        console.error('Error creating cloud project:', e);
                        alert("Error al crear el proyecto en la nube. Se descargará localmente como respaldo.");
                        const result = await platformService.saveProject(jsonString, projectName);
                        if (result.success && result.filePath) {
                            setProjectName(result.filePath);
                        }
                    }
                } else {
                    setLoadingMessage("Escribiendo disco...");
                    // FIX: Update Project Name from Save Result
                    const result = await platformService.saveProject(jsonString, projectName);
                    if (result.success && result.filePath) {
                        setProjectName(result.filePath);
                    }
                }
                
                // Fallback result for integrity report (using success always if cloud or fallback done without throw)
                if (integrityResult.report.issueCount > 0) {
                    console.warn('Project integrity repaired during save.', integrityResult.report);
                    alert(summarizeProjectIntegrityReport(integrityResult.report, 'Proyecto guardado'));
                }

            } catch (e) {
                console.error("Failed to save project", e);
                alert("Error al guardar.");
            } finally {
                setLoadingProject(false);
                setLoadingMessage("");
                setActiveModal(null);
                setShowFileMenu(false);
            }
        }, 20);
    }, [createProjectDataSnapshot, projectName, rememberProjectIntegrityReport, transport, isReadOnly]);

    const assignClipToSessionSlot = useCallback((track: Track, sceneIndex: number, clip: Clip): Track => {
        const safeSceneIndex = Math.max(0, Math.min(7, sceneIndex));
        const nextSlots = [...track.sessionClips];
        while (nextSlots.length <= safeSceneIndex) {
            const slotIndex = nextSlots.length;
            nextSlots.push({
                id: `slot-${track.id}-${slotIndex}`,
                clip: null,
                isPlaying: false,
                isQueued: false
            });
        }

        nextSlots[safeSceneIndex] = {
            ...nextSlots[safeSceneIndex],
            clip,
            isPlaying: false,
            isQueued: false
        };

        const clipExists = track.clips.some((existingClip) => existingClip.id === clip.id);

        return {
            ...track,
            clips: clipExists ? track.clips : [...track.clips, clip],
            sessionClips: nextSlots
        };
    }, []);

    const buildAudioClipFromBuffer = useCallback((
        name: string,
        color: string,
        buffer: AudioBuffer,
        startBar: number,
        sourceId?: string
    ): Clip => {
        return {
            id: buildRuntimeId('c-audio'),
            name,
            color,
            start: Math.max(1, startBar),
            length: buffer.duration / getSecondsPerBar(transport.bpm),
            buffer,
            sourceId,
            notes: [],
            originalBpm: transport.bpm,
            offset: 0,
            fadeIn: 0,
            fadeOut: 0,
            gain: 1,
            playbackRate: 1
        };
    }, [transport.bpm]);

    const importAudioSources = useCallback(async (sources: ImportAudioSource[]) => {
        if (sources.length === 0) return;

        const unsupportedNames = sources
            .filter((source) => !isSupportedAudioImportName(source.name))
            .map((source) => source.name);
        const supportedSources = sources.filter((source) => isSupportedAudioImportName(source.name));
        if (supportedSources.length === 0) {
            throw new Error(`Formato no compatible. Importa ${describeAudioImportFormats()}.`);
        }

        const importStamp = Date.now();

        setImportProgress({
            total: supportedSources.length,
            completed: 0,
            currentFile: supportedSources[0]?.name || null
        });

        const importedTracks: Array<Track | null> = new Array(supportedSources.length).fill(null);
        const importErrors: string[] = [];
        const totalTrackCountAfterImport = tracks.length + supportedSources.length;
        let nextIndex = 0;

        const processSource = async (index: number) => {
            const source = supportedSources[index];
            if (!source) return;

            setImportProgress((prev) => prev ? { ...prev, currentFile: source.name } : prev);

            try {
                const loadedSource = await source.load();
                console.info('[audio-import] Processing source:', source.name);
                const audioBuffer = await engineAdapter.decodeAudioData(loadedSource.arrayBuffer);
                console.log("Decoded successfully!");

                let sourceId: string | undefined;
                try {
                    const blobToPersist = loadedSource.persistBlob
                        || new Blob([loadedSource.arrayBuffer], { type: 'application/octet-stream' });
                    sourceId = await assetDb.saveFile(blobToPersist);
                } catch (persistError) {
                    console.warn(`Asset cache unavailable for ${source.name}`, persistError);
                }

                const newTrack = createTrack({
                    id: `t-imp-${importStamp}-${index}`,
                    name: source.name.replace(/\.[^/.]+$/, '').substring(0, 12),
                    type: TrackType.AUDIO,
                    color: getProgressiveTrackColor(tracks.length + index, totalTrackCountAfterImport),
                    volume: -3
                });

                const newClip = buildAudioClipFromBuffer(source.name, newTrack.color, audioBuffer, 1, sourceId);
                newTrack.clips.push(newClip);
                importedTracks[index] = newTrack;
            } catch (fileError) {
                console.error(`Failed to import ${source.name}`, fileError);
                importErrors.push(`${source.name}: ${fileError instanceof Error ? fileError.message : 'formato no compatible'}`);
                importedTracks[index] = null;
            } finally {
                setImportProgress((prev) => prev
                    ? {
                        ...prev,
                        completed: Math.min(prev.total, prev.completed + 1)
                    }
                    : prev);
            }
        };

        const workerCount = Math.min(IMPORT_AUDIO_CONCURRENCY, supportedSources.length);
        const workers = Array.from({ length: workerCount }, async () => {
            while (nextIndex < supportedSources.length) {
                const currentIndex = nextIndex;
                nextIndex += 1;
                await processSource(currentIndex);

                await new Promise<void>((resolve) => {
                    window.setTimeout(resolve, 0);
                });
            }
        });

        await Promise.all(workers);

        window.setTimeout(() => {
            setImportProgress(null);
        }, 160);

        const validTracks = importedTracks.filter((track): track is Track => track !== null);
        if (validTracks.length === 0) {
            throw new Error(`No se pudo importar ningún archivo. ${importErrors.join(' | ')}`);
        }

        appendTracks(validTracks, { reason: 'import-audio-files', recolor: true });
        const firstTrack = validTracks[0];
        setSelectedTrackId(firstTrack.id);
        setSelectedClipId(firstTrack.clips[0]?.id || null);
        setMainView('arrange');
        setBottomView('editor');

        if (validTracks.length < supportedSources.length || unsupportedNames.length > 0) {
            const failureDetails = [
                ...importErrors,
                ...unsupportedNames.map((name) => `${name}: extensión no admitida`)
            ];
            alert(`Se importaron ${validTracks.length} de ${sources.length} archivos. Fallos: ${failureDetails.join(' | ')}`);
        }
    }, [appendTracks, buildAudioClipFromBuffer, tracks.length, getProgressiveTrackColor]);

    const importLibraryEntryIntoDestination = useCallback(async (
        entry: ScannedFileEntry,
        destination?: ClipDropDestination
    ) => {
        if (!platformService.isDesktop) {
            alert('La importacion por ruta de libreria requiere la version desktop.');
            return;
        }

        const fileData = await platformService.readFileFromPath(entry.path);
        if (!fileData) {
            alert('No se pudo abrir el archivo seleccionado desde la libreria.');
            return;
        }

        const decoded = await engineAdapter.decodeAudioData(fileData.data.slice(0));
        let sourceId: string | undefined;
        try {
            sourceId = await assetDb.saveFile(new Blob([fileData.data], { type: 'application/octet-stream' }));
        } catch (persistError) {
            console.warn('Asset cache unavailable for library import', persistError);
        }

        const destinationTrack = destination?.trackId
            ? tracks.find((track) => track.id === destination.trackId)
            : undefined;

        const startBar = destination?.bar ?? 1;
        const sceneIndex = destination?.sceneIndex ?? 0;
        const placeInSession = Boolean(destination?.placeInSession);

        if (destinationTrack && destinationTrack.type === TrackType.AUDIO) {
            const clip = buildAudioClipFromBuffer(fileData.name, destinationTrack.color, decoded, startBar, sourceId);

            applyTrackMutation((prevTracks) => prevTracks.map((track) => {
                if (track.id !== destinationTrack.id) return track;

                if (placeInSession) {
                    return assignClipToSessionSlot(track, sceneIndex, clip);
                }

                return {
                    ...track,
                    clips: [...track.clips, clip]
                };
            }), { recolor: false, reason: 'browser-drop-library-to-track' });
            setSelectedTrackId(destinationTrack.id);
            setSelectedClipId(clip.id);
            return;
        }

        const newTrack = createTrack({
            id: buildRuntimeId('t-lib'),
            name: fileData.name.replace(/\.[^/.]+$/, "").substring(0, 12) || 'Library Audio',
            type: TrackType.AUDIO,
            color: getProgressiveTrackColor(tracks.length, tracks.length + 1),
            volume: -3
        });

        const clip = buildAudioClipFromBuffer(fileData.name, newTrack.color, decoded, startBar, sourceId);
        newTrack.clips.push(clip);
        if (placeInSession) {
            newTrack.sessionClips = [{ id: `slot-${newTrack.id}-${sceneIndex}`, clip, isPlaying: false, isQueued: false }];
        }

        appendTrack(newTrack, { reason: 'browser-drop-library-create-track', recolor: true });
        setSelectedTrackId(newTrack.id);
        setSelectedClipId(clip.id);
    }, [appendTrack, applyTrackMutation, assignClipToSessionSlot, buildAudioClipFromBuffer, tracks, getProgressiveTrackColor]);

    const handleImportLibraryEntry = useCallback(async (entry: ScannedFileEntry) => {
        try {
            await importLibraryEntryIntoDestination(entry);
        } catch (error) {
            console.error('Library import failed', error);
            alert('Fallo la importacion desde libreria.');
        }
    }, [importLibraryEntryIntoDestination]);

    const insertGeneratorIntoDestination = useCallback((
        type: 'noise' | 'sine',
        destination?: ClipDropDestination
    ): { trackId: string; clipId: string } => {
        const isNoise = type === 'noise';
        const clipName = isNoise ? 'White Noise Burst' : 'Sine 440Hz';
        const clipBuffer = isNoise
            ? engineAdapter.createNoiseBuffer(4)
            : engineAdapter.createSineBuffer(440, 4);
        const destinationTrack = destination?.trackId
            ? tracks.find((track) => track.id === destination.trackId)
            : undefined;
        const startBar = destination?.bar ?? 1;
        const sceneIndex = destination?.sceneIndex ?? 0;
        const placeInSession = Boolean(destination?.placeInSession);

        if (destinationTrack && destinationTrack.type === TrackType.AUDIO) {
            const clip = buildAudioClipFromBuffer(clipName, destinationTrack.color, clipBuffer, startBar);

            applyTrackMutation((prevTracks) => prevTracks.map((track) => {
                if (track.id !== destinationTrack.id) return track;

                if (placeInSession) {
                    return assignClipToSessionSlot(track, sceneIndex, clip);
                }

                return {
                    ...track,
                    clips: [...track.clips, clip]
                };
            }), { recolor: false, reason: 'browser-drop-generator-to-track' });

            return { trackId: destinationTrack.id, clipId: clip.id };
        }

        const trackName = isNoise ? 'Noise Generator' : 'Tone Generator';
        const newTrack = createTrack({
            id: buildRuntimeId(`t-gen-${type}`),
            name: trackName,
            type: TrackType.AUDIO,
            color: isNoise ? '#F472B6' : '#3BF9F6',
            volume: -9
        });
        const clip = buildAudioClipFromBuffer(clipName, newTrack.color, clipBuffer, startBar);
        newTrack.clips.push(clip);
        if (placeInSession) {
            newTrack.sessionClips = [{ id: `slot-${newTrack.id}-${sceneIndex}`, clip, isPlaying: false, isQueued: false }];
        }

        appendTrack(newTrack, { reason: 'browser-drop-generator-create-track', recolor: true });
        return { trackId: newTrack.id, clipId: clip.id };
    }, [appendTrack, applyTrackMutation, assignClipToSessionSlot, buildAudioClipFromBuffer, tracks]);

    const handleCreateBrowserGeneratorTrack = useCallback((type: 'noise' | 'sine') => {
        const selection = insertGeneratorIntoDestination(type);
        setSelectedTrackId(selection.trackId);
        setSelectedClipId(selection.clipId);
        setMainView('arrange');
        setBottomView('editor');
    }, [insertGeneratorIntoDestination]);

    const cloneClipForDrop = useCallback((clip: Clip, color: string, startBar: number): Clip => {
        return {
            ...clip,
            id: buildRuntimeId('c-drop'),
            color,
            start: Math.max(1, startBar),
            notes: clip.notes.map((note) => ({ ...note }))
        };
    }, []);

    const handleTimelineExternalDrop = useCallback(async (trackId: string, bar: number, payload: BrowserDragPayload) => {
        try {
            if (payload.kind === 'library-entry') {
                await importLibraryEntryIntoDestination(payload.entry, { trackId, bar });
                return;
            }

            if (payload.kind === 'generator') {
                const selection = insertGeneratorIntoDestination(payload.generatorType, { trackId, bar });
                setSelectedTrackId(selection.trackId);
                setSelectedClipId(selection.clipId);
                return;
            }

            const sourceTrack = tracks.find((track) => track.id === payload.sourceTrackId);
            const sourceClip = sourceTrack?.clips.find((clip) => clip.id === payload.clipId);
            const targetTrack = tracks.find((track) => track.id === trackId);
            if (!sourceClip || !sourceTrack || !targetTrack) return;

            const isAudioClip = sourceTrack.type === TrackType.AUDIO;
            const expectedTrackType = isAudioClip ? TrackType.AUDIO : TrackType.MIDI;

            if (targetTrack.type === expectedTrackType) {
                const clip = cloneClipForDrop(sourceClip, targetTrack.color, bar);
                updateTrackById(trackId, {
                    clips: [...targetTrack.clips, clip]
                }, { recolor: false, reason: 'browser-drop-project-clip-to-track' });
                setSelectedTrackId(trackId);
                setSelectedClipId(clip.id);
                return;
            }

            const newTrack = createTrack({
                id: `t-drop-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
                name: sourceTrack.name,
                type: expectedTrackType,
                color: sourceTrack.color,
                volume: sourceTrack.volume,
                pan: sourceTrack.pan,
                reverb: sourceTrack.reverb
            });

            const clip = cloneClipForDrop(sourceClip, newTrack.color, bar);
            newTrack.clips.push(clip);

            appendTrack(newTrack, { reason: 'browser-drop-project-clip-create-track', recolor: true });
            setSelectedTrackId(newTrack.id);
            setSelectedClipId(clip.id);
        } catch (error) {
            console.error('Timeline external drop failed', error);
            alert('No se pudo completar el drop en timeline.');
        }
    }, [appendTrack, cloneClipForDrop, importLibraryEntryIntoDestination, insertGeneratorIntoDestination, tracks, updateTrackById]);

    const handleSessionExternalDrop = useCallback(async (trackId: string, sceneIndex: number, payload: BrowserDragPayload) => {
        try {
            const targetTrack = tracks.find((track) => track.id === trackId);
            if (!targetTrack) return;

            if (payload.kind === 'library-entry') {
                await importLibraryEntryIntoDestination(payload.entry, {
                    trackId,
                    sceneIndex,
                    bar: sceneIndex + 1,
                    placeInSession: true
                });
                return;
            }

            if (payload.kind === 'generator') {
                const selection = insertGeneratorIntoDestination(payload.generatorType, {
                    trackId,
                    sceneIndex,
                    bar: sceneIndex + 1,
                    placeInSession: true
                });
                setSelectedTrackId(selection.trackId);
                setSelectedClipId(selection.clipId);
                return;
            }

            const sourceTrack = tracks.find((track) => track.id === payload.sourceTrackId);
            const sourceClip = sourceTrack?.clips.find((clip) => clip.id === payload.clipId);
            if (!sourceTrack || !sourceClip) return;

            const isAudioClip = sourceTrack.type === TrackType.AUDIO;
            const expectedTrackType = isAudioClip ? TrackType.AUDIO : TrackType.MIDI;

            if (targetTrack.type === expectedTrackType) {
                const clip = cloneClipForDrop(sourceClip, targetTrack.color, sceneIndex + 1);
                applyTrackMutation((prevTracks) => prevTracks.map((track) => {
                    if (track.id !== targetTrack.id) return track;
                    return assignClipToSessionSlot(track, sceneIndex, clip);
                }), { recolor: false, reason: 'browser-drop-session-slot' });
                setSelectedTrackId(targetTrack.id);
                setSelectedClipId(clip.id);
                return;
            }

            const newTrack = createTrack({
                id: `t-session-drop-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
                name: sourceTrack.name,
                type: expectedTrackType,
                color: sourceTrack.color,
                volume: sourceTrack.volume,
                pan: sourceTrack.pan,
                reverb: sourceTrack.reverb
            });

            const clip = cloneClipForDrop(sourceClip, newTrack.color, sceneIndex + 1);
            newTrack.clips.push(clip);
            newTrack.sessionClips = [{ id: `slot-${newTrack.id}-${sceneIndex}`, clip, isPlaying: false, isQueued: false }];

            appendTrack(newTrack, { reason: 'browser-drop-session-create-track', recolor: true });
            setSelectedTrackId(newTrack.id);
            setSelectedClipId(clip.id);
        } catch (error) {
            console.error('Session external drop failed', error);
            alert('No se pudo completar el drop en session view.');
        }
    }, [appendTrack, applyTrackMutation, assignClipToSessionSlot, cloneClipForDrop, importLibraryEntryIntoDestination, insertGeneratorIntoDestination, tracks]);

    const handleImportAudio = useCallback(async () => {
        if (platformService.isElectron) {
            try {
                const files = await platformService.selectAudioFiles();
                if (!files || files.length === 0) return;

                const sources: ImportAudioSource[] = files.map((file) => ({
                    name: file.name,
                    load: async () => {
                        const selected = file.data
                            ? { name: file.name, path: file.path, data: file.data }
                            : await platformService.readFileFromPath(file.path);
                        if (!selected?.data) {
                            throw new Error(`No se pudo leer ${file.name}.`);
                        }
                        return {
                            arrayBuffer: selected.data,
                            persistBlob: new Blob([selected.data], { type: 'application/octet-stream' })
                        };
                    }
                }));

                await importAudioSources(sources);
            } catch (err) {
                console.error("Electron import failed", err);
                alert(err instanceof Error ? err.message : "No se pudo importar el archivo de audio.");
            }
            return;
        }

        fileInputRef.current?.click();
    }, [importAudioSources]);

    const handleFileImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;

        try {
            const fileArray = Array.from(files);
            const sources: ImportAudioSource[] = fileArray.map((file: File) => ({
                name: file.name,
                load: async () => ({
                    arrayBuffer: await file.arrayBuffer(),
                    persistBlob: file
                })
            }));

            await importAudioSources(sources);

        } catch (err) {
            console.error("Import failed", err);
            alert("No se pudo importar el archivo de audio.");
        } finally {
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    }, [importAudioSources]);

    const handleTrackSelect = useCallback((trackId: string) => {
        setSelectedTrackId(trackId);
        setBottomView('editor');
    }, []);

    const handleClipSelect = useCallback((trackId: string, clipId: string) => {
        setSelectedTrackId(trackId);
        setSelectedClipId(clipId);
        setBottomView('editor');
        applyTrackMutation((prevTracks) => prevTracks.map((track) => {
            if (track.id !== trackId) return track;
            const matchedTake = (track.recordingTakes || []).find((take) => take.clipId === clipId);
            if (!matchedTake) return track;
            return setTrackActiveTake(track, matchedTake.id);
        }), { noHistory: true, recolor: false, reason: 'clip-select-active-take-sync' });
    }, [applyTrackMutation]);

    const handleTimelineSeek = useCallback((bar: number) => {
        void handleSeekToBar(bar);
    }, [handleSeekToBar]);

    const handleTimelineTrackUpdate = useCallback((id: string, updates: Partial<Track>, options?: { noHistory?: boolean; reason?: string; historyGroupId?: string }) => {
        updateTrackById(id, updates, { recolor: false, ...options });
    }, [updateTrackById]);

    const handleTimelineClipUpdate = useCallback((trackId: string, clipId: string, updates: Partial<Clip>, options?: { noHistory?: boolean; reason?: string; historyGroupId?: string }) => {
        updateClipById(trackId, clipId, updates, { recolor: false, ...options });
    }, [updateClipById]);

    const handleTimelineGridChange = useCallback((size: number, enabled: boolean) => {
        setTransport((prev: TransportState) => ({ ...prev, gridSize: size, snapToGrid: enabled }));
    }, []);

    const handleTimelineTimeUpdate = useCallback((bar: number, beat: number, sixteenth: number) => {
        const engineIsPlaying = engineAdapter.getIsPlaying() || isPlayingRef.current;
        setTransportClockSnapshot({
            currentBar: bar,
            currentBeat: beat,
            currentSixteenth: sixteenth,
            isPlaying: engineIsPlaying,
            updatedAt: Date.now()
        });
    }, []);

    const handleTimelineAddTrack = useCallback((type = TrackType.AUDIO) => {
        const count = tracks.filter((track) => track.type === type).length + 1;
        const baseName =
            type === TrackType.RETURN
                ? `Return ${String.fromCharCode(64 + count)}`
                : type === TrackType.GROUP
                    ? `Group ${count}`
                    : `${type === TrackType.MIDI ? 'Midi' : 'Audio'} ${count}`;

        const newTrack = createTrack({
            id: buildRuntimeId(`t-${type.toLowerCase()}`),
            name: baseName,
            type,
            color: getProgressiveTrackColor(tracks.length, tracks.length + 1)
        });

        appendTrack(newTrack, { reason: 'timeline-add-track', recolor: true });
    }, [appendTrack, tracks, getProgressiveTrackColor]);

    const handleMixerCreateGroup = useCallback(() => {
        const count = tracks.filter((track) => track.type === TrackType.GROUP).length + 1;
        const newTrack = createTrack({
            id: buildRuntimeId('t-group'),
            name: `Group ${count}`,
            type: TrackType.GROUP,
            color: getProgressiveTrackColor(tracks.length, tracks.length + 1)
        });

        appendTrack(newTrack, { reason: 'mixer-create-group', recolor: true });
    }, [appendTrack, tracks, getProgressiveTrackColor]);

    const hasRealtimeAudioActivity = useMemo(() => {
        if (transport.isPlaying || transport.isRecording || isPlayingRef.current || engineAdapter.getIsPlaying()) {
            return true;
        }

        if (engineAdapter.getActiveRecordingTrackIds().length > 0) {
            return true;
        }

        return engineAdapter.getMonitoringRouteSnapshots().some((route) => route.active);
    }, [transport.isPlaying, transport.isRecording]);
    useEffect(() => {
        const now = Date.now();
        setAudioIncidentWindow((prev) => {
            if (hasRealtimeAudioActivity) {
                if (prev.active) {
                    return prev;
                }
                return createAudioIncidentWindow(
                    Math.max(0, Number(engineStats.schedulerDropoutCount || 0)),
                    Math.max(0, Number(engineStats.schedulerUnderrunCount || 0)),
                    true,
                    now
                );
            }

            if (!prev.active && prev.dropoutsDeltaWindow === 0 && prev.underrunsDeltaWindow === 0) {
                return prev;
            }

            return createAudioIncidentWindow(
                Math.max(0, Number(engineStats.schedulerDropoutCount || 0)),
                Math.max(0, Number(engineStats.schedulerUnderrunCount || 0)),
                false,
                now
            );
        });
    }, [engineStats.schedulerDropoutCount, engineStats.schedulerUnderrunCount, hasRealtimeAudioActivity]);

    useEffect(() => {
        if (!audioIncidentWindow.active) {
            return;
        }

        const currentDropoutCount = Math.max(0, Number(engineStats.schedulerDropoutCount || 0));
        const currentUnderrunCount = Math.max(0, Number(engineStats.schedulerUnderrunCount || 0));

        setAudioIncidentWindow((prev) => {
            if (!prev.active) {
                return prev;
            }

            const nextDropoutsDelta = Math.max(0, currentDropoutCount - prev.baselineDropoutCount);
            const nextUnderrunsDelta = Math.max(0, currentUnderrunCount - prev.baselineUnderrunCount);
            const changed = nextDropoutsDelta !== prev.dropoutsDeltaWindow || nextUnderrunsDelta !== prev.underrunsDeltaWindow;

            if (!changed) {
                return prev;
            }

            return {
                ...prev,
                dropoutsDeltaWindow: nextDropoutsDelta,
                underrunsDeltaWindow: nextUnderrunsDelta,
                lastCounterChangeAt: Date.now()
            };
        });
    }, [audioIncidentWindow.active, engineStats.schedulerDropoutCount, engineStats.schedulerUnderrunCount]);

    useEffect(() => {
        if (!audioIncidentWindow.active || (audioIncidentWindow.dropoutsDeltaWindow === 0 && audioIncidentWindow.underrunsDeltaWindow === 0)) {
            return;
        }

        const interval = window.setInterval(() => {
            setAudioIncidentWindow((prev) => {
                if (!prev.active || (prev.dropoutsDeltaWindow === 0 && prev.underrunsDeltaWindow === 0)) {
                    return prev;
                }

                if (!prev.lastCounterChangeAt || (Date.now() - prev.lastCounterChangeAt) < AUDIO_INCIDENT_RESET_COOLDOWN_MS) {
                    return prev;
                }

                return createAudioIncidentWindow(
                    Math.max(0, Number(engineStats.schedulerDropoutCount || 0)),
                    Math.max(0, Number(engineStats.schedulerUnderrunCount || 0)),
                    true,
                    Date.now()
                );
            });
        }, 250);

        return () => window.clearInterval(interval);
    }, [audioIncidentWindow.active, audioIncidentWindow.dropoutsDeltaWindow, audioIncidentWindow.underrunsDeltaWindow, audioIncidentWindow.lastCounterChangeAt, engineStats.schedulerDropoutCount, engineStats.schedulerUnderrunCount]);

    const recentDropoutDelta = audioIncidentWindow.dropoutsDeltaWindow;
    const recentUnderrunDelta = audioIncidentWindow.underrunsDeltaWindow;
    const sessionTrackCount = useMemo(
        () => tracks.filter((track) => track.type === TrackType.AUDIO || track.type === TrackType.MIDI).length,
        [tracks]
    );
    const sessionOverloadDecision = useMemo<SessionOverloadDecision>(() => (
        assessSessionOverload({
            engineStats: engineStats || null,
            sessionTrackCount,
            sceneCount: 8,
            recentDropoutDelta,
            recentUnderrunDelta
        })
    ), [
        engineStats,
        recentDropoutDelta,
        recentUnderrunDelta,
        sessionTrackCount
    ]);
    const computedSessionHealthSnapshot = useMemo(() => {
        const baseSnapshot = engineAdapter.getSessionHealthSnapshot({
            capturedAt: Date.now(),
            profile: PERFORMANCE_PROFILE,
            hasRealtimeAudio: hasRealtimeAudioActivity,
            dropoutsDelta: recentDropoutDelta,
            underrunsDelta: recentUnderrunDelta,
            launchErrorP95Ms: sessionLaunchP95Ms,
            uiFpsP95: uiFrameTelemetry.fpsP95,
            uiFrameDropRatio: uiFrameTelemetry.frameDropRatio
        });

        return {
            ...baseSnapshot,
            cpuAudioP95Percent: Math.max(
                Number(engineStats.schedulerCpuLoadP95Percent || 0),
                baseSnapshot.cpuAudioP95Percent
            ),
            transportDriftP99Ms: Math.max(
                Number(engineStats.schedulerP99TickDriftMs || 0),
                baseSnapshot.transportDriftP99Ms
            ),
            monitorLatencyP95Ms: Math.max(
                Number((engineStats.latency || 0) * 1000),
                baseSnapshot.monitorLatencyP95Ms
            )
        };
    }, [
        engineStats.latency,
        engineStats.schedulerCpuLoadP95Percent,
        engineStats.schedulerP99TickDriftMs,
        hasRealtimeAudioActivity,
        recentDropoutDelta,
        recentUnderrunDelta,
        sessionLaunchP95Ms,
        uiFrameTelemetry.fpsP95,
        uiFrameTelemetry.frameDropRatio
    ]);
    useEffect(() => {
        setSessionHealthSnapshot((prev) => {
            const isSame =
                prev.profile === computedSessionHealthSnapshot.profile
                && prev.hasRealtimeAudio === computedSessionHealthSnapshot.hasRealtimeAudio
                && Math.abs(prev.cpuAudioP95Percent - computedSessionHealthSnapshot.cpuAudioP95Percent) < 0.1
                && prev.dropoutsDelta === computedSessionHealthSnapshot.dropoutsDelta
                && prev.underrunsDelta === computedSessionHealthSnapshot.underrunsDelta
                && Math.abs(prev.launchErrorP95Ms - computedSessionHealthSnapshot.launchErrorP95Ms) < 0.1
                && Math.abs(prev.uiFpsP95 - computedSessionHealthSnapshot.uiFpsP95) < 0.5
                && Math.abs(prev.uiFrameDropRatio - computedSessionHealthSnapshot.uiFrameDropRatio) < 0.005
                && Math.abs(prev.transportDriftP99Ms - computedSessionHealthSnapshot.transportDriftP99Ms) < 0.1
                && Math.abs(prev.monitorLatencyP95Ms - computedSessionHealthSnapshot.monitorLatencyP95Ms) < 0.1;

            if (isSame) {
                return prev;
            }

            return computedSessionHealthSnapshot;
        });
    }, [computedSessionHealthSnapshot]);
    const visualPerformance = useMemo<VisualPerformanceDecision>(() => (
        assessVisualPerformance({
            capturedAt: Date.now(),
            uiFpsP95: uiFrameTelemetry.fpsP95,
            frameDropRatio: uiFrameTelemetry.frameDropRatio,
            hasPlaybackActivity: transport.isPlaying || transport.isRecording,
            worstBurstMs: uiFrameTelemetry.worstBurstMs,
            sampleWindowMs: uiFrameTelemetry.sampleWindowMs,
            hasActiveViewportInteraction: uiFrameTelemetry.hasActiveViewportInteraction
        })
    ), [
        transport.isPlaying,
        transport.isRecording,
        uiFrameTelemetry.fpsP95,
        uiFrameTelemetry.frameDropRatio,
        uiFrameTelemetry.worstBurstMs,
        uiFrameTelemetry.sampleWindowMs,
        uiFrameTelemetry.hasActiveViewportInteraction
    ]);
    useEffect(() => {
        const decision = audioPriorityControllerRef.current.evaluate(sessionHealthSnapshot);
        setGlobalAudioPriority((prev) => {
            const same =
                prev.mode === decision.mode
                && prev.uiUpdateDebounceMs === decision.uiUpdateDebounceMs
                && prev.reduceAnimations === decision.reduceAnimations
                && prev.disableHeavyVisuals === decision.disableHeavyVisuals
                && prev.simplifyMeters === decision.simplifyMeters
                && prev.showBanner === decision.showBanner
                && prev.reasonCode === decision.reasonCode
                && prev.reasons.join('|') === decision.reasons.join('|');

            if (same) {
                return prev;
            }

            return {
                mode: decision.mode,
                uiUpdateDebounceMs: decision.uiUpdateDebounceMs,
                reduceAnimations: decision.reduceAnimations,
                disableHeavyVisuals: decision.disableHeavyVisuals,
                simplifyMeters: decision.simplifyMeters,
                showBanner: decision.showBanner,
                reasons: decision.reasons,
                reasonCode: decision.reasonCode
            };
        });

        if (decision.transition) {
            const transitions = audioPriorityControllerRef.current.getTransitions();
            const stability = buildAudioPriorityStabilityReport(transitions, 20, 1);
            try {
                localStorage.setItem(AUDIO_PRIORITY_TRANSITIONS_STORAGE_KEY, JSON.stringify({
                    capturedAt: Date.now(),
                    transitions,
                    stability
                }));
            } catch {
                // Non-blocking persistence path.
            }
        }
    }, [sessionHealthSnapshot]);
    const isScannerImmersive = showNoteScanner;
    const selectedTrack = tracks.find((track) => track.id === selectedTrackId) || null;
    const selectedAudioTrack = selectedTrack?.type === TrackType.AUDIO ? selectedTrack : null;
    const selectedTrackPunchRange = useMemo(() => (
        selectedAudioTrack ? normalizePunchRange(selectedAudioTrack.punchRange) : null
    ), [selectedAudioTrack]);
    const selectedAudioClipEditorView = useMemo<AudioClipEditorViewState | null>(() => {
        if (!selectedAudioTrack || !selectedClipId) {
            return null;
        }

        const context = resolveTrackClipEditingContext(selectedAudioTrack, selectedClipId);
        if (!context.clip) {
            return null;
        }

        return {
            clipId: context.clip.id,
            isCompClip: context.isCompClip,
            isTakeClip: context.isTakeClip,
            takeId: context.take?.id,
            takeLabel: context.take?.label,
            takeLaneId: context.takeLane?.id,
            takeLaneName: context.takeLane?.name,
            compLaneId: context.compLane?.id,
            compSegmentId: context.compSegment?.id,
            punchRange: selectedTrackPunchRange
        };
    }, [selectedAudioTrack, selectedClipId, selectedTrackPunchRange]);
    const monitoringRouteDetails = useMemo(() => {
        const pendingFinalizeTrackIds = new Set(engineAdapter.getPendingFinalizeTrackIds());
        return engineAdapter.getMonitoringRouteSnapshots().map((route) => ({
            ...route,
            pendingFinalize: pendingFinalizeTrackIds.has(route.trackId)
        }));
    }, [tracks, transport.isPlaying, transport.isRecording, recordingJournalEntries]);
    const monitoringRouteSnapshot = useMemo(() => {
        const routes = monitoringRouteDetails;
        return {
            activeCount: routes.filter((route) => route.active).length,
            stereoCount: routes.filter((route) => route.active && route.mode === 'stereo').length,
            sharedInputStreamCount: routes.filter((route) => route.sharedInputStream).length,
            pendingFinalizeCount: routes.filter((route) => route.pendingFinalize).length
        };
    }, [monitoringRouteDetails]);
    const monitoringLatencySummary = useMemo(() => {
        const baseLatencyMs = Number(Math.max(0, sessionHealthSnapshot.monitorLatencyP95Ms).toFixed(3));
        const maxLatencyCompensationMs = monitoringRouteDetails.reduce((max, route) => {
            return Math.max(max, route.latencyCompensationMs);
        }, 0);
        const maxEffectiveMonitorLatencyMs = monitoringRouteDetails.reduce((max, route) => {
            return Math.max(max, baseLatencyMs + route.latencyCompensationMs);
        }, baseLatencyMs);

        return {
            baseLatencyMs,
            maxLatencyCompensationMs: Number(maxLatencyCompensationMs.toFixed(3)),
            maxEffectiveMonitorLatencyMs: Number(maxEffectiveMonitorLatencyMs.toFixed(3))
        };
    }, [monitoringRouteDetails, sessionHealthSnapshot.monitorLatencyP95Ms]);
    const handleCloseSettings = useCallback(() => {
        setShowSettings(false);
    }, []);
    const handleAudioSettingsChange = useCallback((nextSettings: AudioSettings) => {
        setAudioSettings(sanitizeAudioSettings(nextSettings));
    }, []);
    const handleAiPatternGenerated = useCallback((notes: Note[], name: string) => {
        const color = getProgressiveTrackColor(tracks.length, tracks.length + 1);
        const newTrack = createTrack({
            id: `t-ai-${Date.now()}`,
            name: name || 'AI Generator',
            type: TrackType.MIDI,
            color,
            volume: -6,
            clips: [{
                id: `c-ai-${Date.now()}`,
                name,
                color,
                start: 1,
                length: 4,
                notes,
                offset: 0,
                fadeIn: 0,
                fadeOut: 0,
                gain: 1,
                playbackRate: 1
            }]
        });

        appendTrack(newTrack, { reason: 'ai-generator-track', recolor: true });
        closeAllToolPanels();
    }, [appendTrack, closeAllToolPanels, getProgressiveTrackColor, tracks.length]);
    const handleTakePanelAudition = useCallback((trackId: string, takeId: string) => {
        void handleAuditionTakeFromPanel(trackId, takeId);
    }, [handleAuditionTakeFromPanel]);
    const handleEditorClipUpdate = useCallback((trackId: string, clipId: string, updates: Partial<Clip>, options?: { noHistory?: boolean; reason?: string }) => {
        updateClipById(trackId, clipId, updates, { recolor: false, ...options });
    }, [updateClipById]);
    const editorTransportView = useMemo<EditorTransportView>(() => ({
        snapToGrid: transport.snapToGrid,
        gridSize: transport.gridSize,
        scaleRoot: transport.scaleRoot,
        scaleType: transport.scaleType
    }), [transport.gridSize, transport.scaleRoot, transport.scaleType, transport.snapToGrid]);
    const timelineUiFrameBudgetMs = visualPerformance.uiFrameBudgetMs;
    const timelineMeterFrameBudgetMs = visualPerformance.meterFrameBudgetMs;
    const timelineMaxActiveMeterTracks = visualPerformance.maxActiveMeterTracks;
    const mixerMeterUpdateIntervalMs = visualPerformance.mixerMeterUpdateIntervalMs;
    const mixerMaxMeterTracks = visualPerformance.mixerMaxMeterTracks;
    const performerFrameIntervalMs = visualPerformance.performerFrameIntervalMs;
    const diagnosticsVisible = diagnosticsVisibilityMode === 'debug';

    return (
        <div
            data-audio-priority={globalAudioPriority.mode}
            data-visual-performance={visualPerformance.mode}
            className={`daw-immersive-shell flex flex-col h-screen w-screen bg-[#111218] text-daw-text font-sans overflow-hidden selection:bg-daw-ruby selection:text-white ${visualPerformance.reduceAnimations ? 'audio-priority-reduced' : ''}`}
        >

            {loadingProject && (
                <div className="fixed inset-0 z-[9999] bg-black/80 backdrop-blur-sm flex flex-col items-center justify-center animate-in fade-in duration-300">
                    <div className="bg-[#1a1a1a] p-8 rounded-xl border border-daw-border flex flex-col items-center shadow-2xl">
                        <AppLogo className="animate-bounce mb-4" size={48} withGlow />
                        <h2 className="text-xl font-black text-white tracking-widest uppercase">Procesando</h2>
                        <p className="text-gray-500 text-xs mt-2 font-mono">{loadingMessage}</p>
                    </div>
                </div>
            )}

            {importProgress && (
                <div className="fixed right-4 bottom-12 z-[120] w-[320px] rounded-sm border border-daw-border bg-[#10131c]/96 backdrop-blur-md px-3 py-2 shadow-2xl animate-in fade-in slide-in-from-bottom-2 duration-200">
                    <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-gray-400">
                        <span>Importando audio</span>
                        <span className="font-mono text-gray-200">{importProgress.completed}/{importProgress.total}</span>
                    </div>
                    <div className="mt-2 h-1.5 rounded-full bg-black/40 overflow-hidden">
                        <div
                            className="h-full bg-gradient-to-r from-daw-cyan to-daw-violet transition-all duration-200"
                            style={{ width: `${Math.max(0, Math.min(100, (importProgress.completed / Math.max(1, importProgress.total)) * 100))}%` }}
                        />
                    </div>
                    <div className="mt-1 text-[10px] text-gray-500 truncate">{importProgress.currentFile || 'Preparando importacion...'}</div>
                </div>
            )}

            {diagnosticsVisible && globalAudioPriority.showBanner && (
                <div className="fixed right-4 top-[56px] z-[130] px-3 py-1.5 rounded-sm border border-daw-ruby/35 bg-[#140e16]/92 backdrop-blur-md text-[9px] uppercase tracking-wider font-bold text-gray-200 flex items-center gap-2 shadow-lg">
                    <span className="text-daw-ruby">Audio Priority</span>
                    <span className={globalAudioPriority.mode === 'critical' ? 'text-red-300' : 'text-amber-300'}>
                        {globalAudioPriority.mode.toUpperCase()}
                    </span>
                    <span className="text-gray-500 font-mono">{globalAudioPriority.reasonCode}</span>
                </div>
            )}

            {recordingRecoveryAttentionSummary.totalCount > 0 && activeModal !== 'recording-recovery' && (
                <div className="fixed left-[64px] right-4 top-[56px] z-[129] rounded-sm border border-amber-400/25 bg-[#16120c]/94 backdrop-blur-md px-3 py-2 shadow-lg flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className="w-8 h-8 rounded-sm bg-amber-500/15 text-amber-300 flex items-center justify-center shrink-0">
                            <AlertTriangle size={16} />
                        </div>
                        <div className="min-w-0">
                            <div className="text-[10px] font-black uppercase tracking-[0.18em] text-amber-200">Recording Recovery</div>
                            <div className="text-[11px] text-gray-300 truncate">
                                {recordingRecoveryAttentionSummary.failedCount > 0
                                    ? `${recordingRecoveryAttentionSummary.failedCount} sesiones de grabacion fallaron`
                                    : `${recordingRecoveryAttentionSummary.recoveredCount} sesiones de grabacion fueron recuperadas tras cierre inesperado`}
                            </div>
                        </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        <button
                            onClick={() => setActiveModal('recording-recovery')}
                            className="px-3 h-8 rounded-sm bg-amber-300 text-[#1a140b] text-[10px] font-bold uppercase tracking-[0.16em] hover:brightness-110 transition-all"
                        >
                            Revisar
                        </button>
                        <button
                            onClick={acknowledgeRecordingRecoveryNotice}
                            className="px-3 h-8 rounded-sm border border-white/10 text-[10px] uppercase tracking-[0.16em] text-gray-300 hover:bg-white/[0.06] transition-all"
                        >
                            Ocultar
                        </button>
                    </div>
                </div>
            )}

            {!isScannerImmersive && (
                <Transport
                    transport={transport}
                    midiDevices={midiDevices}
                    onPlay={handlePlay}
                    onPause={handlePause}
                    onStop={handleStop}
                    onRecordToggle={handleRecordToggle}
                    onLoopToggle={handleLoopToggle}
                    onSkipStart={handleSkipStart}
                    onSkipEnd={handleSkipEnd}
                    setBpm={handleBpmChange}
                    setMasterTranspose={(t) => setTransport((p: TransportState) => ({ ...p, masterTranspose: t }))}
                    onExport={() => setShowExportModal(true)}
                    setScaleRoot={(r) => setTransport((p: TransportState) => ({ ...p, scaleRoot: r }))}
                    setScaleType={(t: string) => setTransport((p: TransportState) => ({ ...p, scaleType: t as TransportState['scaleType'] }))}
                    selectedTrackName={selectedAudioTrack?.name || null}
                    selectedTrackPunchRange={selectedTrackPunchRange}
                    onSelectedTrackPunchUpdate={handleSelectedTrackPunchUpdate}
                />
            )}

            <HardwareSettingsModal
                isOpen={showSettings}
                onClose={handleCloseSettings}
                audioSettings={audioSettings}
                onAudioSettingsChange={handleAudioSettingsChange}
                engineStats={engineStats}
            />

            <div className={`flex-1 overflow-hidden flex relative transition-[transform,opacity,filter] duration-500 ease-[cubic-bezier(0.22,0.84,0.26,1)] ${showSettings ? 'blur-[1px] scale-[0.995] pointer-events-none select-none brightness-90' : ''}`}>

                <div className="w-[50px] bg-[#1a1a1a] border-r border-daw-border flex flex-col items-center py-3 gap-3 z-[100] shrink-0 relative shadow-xl">
                    {/* ... Sidebar Icons (unchanged) ... */}
                    <div className="relative group" ref={fileMenuRef}>
                        <button onClick={() => setShowFileMenu(!showFileMenu)} className={`w-10 h-10 flex items-center justify-center rounded-sm transition-all duration-100 relative ${showFileMenu ? 'bg-[#333] text-white' : 'text-gray-400 hover:text-white hover:bg-[#222]'}`} title="Menú de Proyecto">
                            <Folder size={20} strokeWidth={1.5} />
                        </button>
                        {showFileMenu && (
                            <div className="absolute left-[52px] top-0 w-56 bg-[#1a1a1a] border border-[#444] shadow-[0_5px_15px_rgba(0,0,0,0.5)] z-[101] flex flex-col py-1 animate-in slide-in-from-left-2 duration-100">
                                <div className="px-4 py-2 text-[10px] font-bold text-gray-500 uppercase tracking-wider border-b border-white/5 mb-1">Archivo</div>
                                <button onClick={handleNewProject} className="text-xs text-left px-4 py-2 text-gray-300 hover:bg-white/10 hover:text-white transition-colors flex justify-between group"><span>Nuevo Proyecto</span></button>
                                <button onClick={handleOpenProjectBrowser} className="text-xs text-left px-4 py-2 text-gray-300 hover:bg-white/10 hover:text-white transition-colors flex justify-between group"><span>Mis Proyectos</span></button>
                                <button onClick={handleImportFromDisk} className="text-xs text-left px-4 py-2 text-gray-300 hover:bg-white/10 hover:text-white transition-colors flex justify-between group"><span>Importar desde disco...</span></button>
                                <button
                                    onClick={() => {
                                        setShowSettings(true);
                                        setShowFileMenu(false);
                                    }}
                                    className="text-xs text-left px-4 py-2 text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
                                >
                                    Configuracion de Audio...
                                </button>

                                <div className="h-px bg-daw-border w-1/2 my-2"></div>
                                <button onClick={handleSaveProject} className="text-xs text-left px-4 py-2 text-gray-300 hover:bg-white/10 hover:text-white transition-colors flex justify-between group"><span>Guardar Proyecto</span><span className="opacity-50 text-[10px]">Ctrl+S</span></button>
                                <button onClick={() => { handleDownloadProject(); setShowFileMenu(false); }} className="text-xs text-left px-4 py-2 text-gray-300 hover:bg-white/10 hover:text-white transition-colors flex justify-between group"><span>Descargar Proyecto Local</span></button>
                                <button onClick={() => setShowExportModal(true)} className="text-xs text-left px-4 py-2 text-gray-300 hover:bg-white/10 hover:text-white transition-colors flex justify-between group"><span>Exportar Audio</span></button>
                            </div>
                        )}
                    </div>
                    <div className="w-6 h-px bg-white/5 my-1"></div>
                    <div className="flex flex-col gap-2 w-full items-center">
                        <SidebarItem icon={Search} label="Navegador de Archivos" active={showBrowser} onClick={() => toggleToolPanel('browser')} />
                        <SidebarItem icon={Sparkles} label="Generador AI" active={showAI} onClick={() => toggleToolPanel('ai')} color="text-daw-cyan" />
                        <SidebarItem icon={Piano} label="Piano Score" active={showNoteScanner} onClick={() => toggleToolPanel('scanner')} color="text-daw-violet" />
                    </div>
                    <div className="w-6 h-px bg-white/5 my-1"></div>
                    <div className="flex flex-col gap-2 w-full items-center">
                        <SidebarItem icon={LayoutGrid} label="Vista de Arreglo" active={mainView === 'arrange'} onClick={() => setMainView('arrange')} />
                        <SidebarItem icon={PlayCircle} label="Vista de Sesión (Live)" active={mainView === 'session'} onClick={() => setMainView('session')} color="text-daw-ruby" />
                        <SidebarItem icon={Sliders} label="Mezclador" active={mainView === 'mixer'} onClick={() => setMainView('mixer')} />
                    </div>
                    <div className="w-6 h-px bg-white/5 my-1"></div>
                    <div className="flex flex-col gap-2 w-full items-center">
                        <SidebarItem icon={Cpu} label="Rack de Dispositivos" onClick={() => setBottomView('devices')} active={bottomView === 'devices'} />
                        <SidebarItem icon={Layers} label="Editor de Notas/Audio" onClick={() => setBottomView('editor')} active={bottomView === 'editor'} />
                        <button onClick={handleImportAudio} className="w-10 h-10 flex items-center justify-center text-gray-500 hover:text-white hover:bg-white/5 rounded-md transition-all" title="Importar Rápido">
                            <FolderInput size={18} />
                        </button>
                    </div>
                    <div className="flex flex-col gap-1 w-full items-center mt-2">
                        <button onClick={undo} disabled={!canUndo} className={`w-8 h-8 flex items-center justify-center rounded-md transition-all ${!canUndo ? 'text-gray-700 cursor-not-allowed opacity-30' : 'text-gray-400 hover:text-white hover:bg-white/5'}`} title="Deshacer (Ctrl+Z)"><Undo2 size={16} /></button>
                        <button onClick={redo} disabled={!canRedo} className={`w-8 h-8 flex items-center justify-center rounded-md transition-all ${!canRedo ? 'text-gray-700 cursor-not-allowed opacity-30' : 'text-gray-400 hover:text-white hover:bg-white/5'}`} title="Rehacer (Ctrl+Y)"><Redo2 size={16} /></button>
                    </div>
                    <div className="mt-auto flex flex-col gap-2 w-full items-center pb-3">
                        <SidebarItem icon={Users} label="Colaboración" onClick={() => setActiveModal('collab')} active={activeModal === 'collab'} />
                        <SidebarItem icon={HardDrive} label="Project OS" onClick={() => setActiveModal('project-os')} active={activeModal === 'project-os'} color="text-gray-400 group-hover:text-daw-cyan" />
                        <SidebarItem icon={Share2} label="Compartir Enlace" onClick={() => { if (collabSessionId) { setActiveModal('share'); } else { alert('Debes guardar el proyecto en la nube primero (Colaboración) antes de poder compartirlo.'); } }} active={activeModal === 'share'} color="text-gray-400 group-hover:text-blue-400" />
                        <SidebarItem
                            icon={UserCircle2}
                            label="Cuenta"
                            onClick={() => {
                                setSessionPopoverView('main');
                                setShowSessionPopover(!showSessionPopover);
                            }}
                            active={showSessionPopover}
                            color="text-gray-400 group-hover:text-daw-violet"
                        />
                        <SidebarItem icon={Settings} label="Preferencias de Audio/MIDI" onClick={() => setShowSettings(true)} active={showSettings} />
                    </div>

                    {/* ── SESSION WIDGET ─────────────────────────────────────── */}
                    <div className="relative w-full h-0">
                        {showSessionPopover && (
                            <div className="absolute left-14 bottom-2 w-64 bg-[#0a0a0d] border border-white/10 rounded-lg shadow-[0_0_24px_rgba(0,0,0,0.8)] p-4 z-50 animate-in fade-in zoom-in-95"
                                 // Se removió onMouseLeave para evitar que se cierre accidentalmente
                            >
                                {session ? (
                                    <div className="flex flex-col gap-3">
                                        <div className="flex items-center gap-3">
                                            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-purple-500 to-rose-500 flex items-center justify-center text-white font-bold text-lg">
                                                {(profile?.full_name || profile?.username || user?.email || '?').charAt(0)}
                                            </div>
                                            <div className="flex flex-col min-w-0">
                                                <span className="text-sm text-gray-200 font-medium truncate">{profile?.full_name || profile?.username || 'Usuario DAW'}</span>
                                                <span className="text-[10px] text-gray-500 truncate">{user?.email}</span>
                                            </div>
                                        </div>
                                        <div className="h-px bg-white/10 w-full my-1" />
                                        <button onClick={() => { setShowSessionPopover(false); if (platformService.isDesktop) { platformService.showHub(); } else { window.location.href = import.meta.env.PROD ? 'https://hollowbits.com/console' : '/console'; } }} className="w-full py-2 text-xs text-gray-300 hover:bg-white/5 hover:text-white rounded text-left px-2 transition-colors flex items-center gap-2">
                                            <span>Ir al Hub</span>
                                        </button>
                                        <button onClick={() => { setShowSessionPopover(false); authSignOut(); }} className="w-full py-2 text-xs text-rose-400 hover:bg-rose-500/10 rounded text-left px-2 transition-colors flex items-center gap-2">
                                            <LogOut size={12} />
                                            <span>Cerrar Sesión</span>
                                        </button>
                                    </div>
                                ) : (
                                    <div className="flex flex-col gap-3">
                                        {sessionPopoverView === 'login' ? (
                                            <MiniAuthPanel 
                                                onSuccess={() => { setShowSessionPopover(false); setSessionPopoverView('main'); }} 
                                                onBack={() => setSessionPopoverView('main')} 
                                            />
                                        ) : (
                                            <>
                                                <div className="flex flex-col items-center gap-2 text-center">
                                                    <div className="w-12 h-12 rounded-full border border-white/10 bg-white/[0.03] flex items-center justify-center mb-1">
                                                        <UserCircle2 size={24} className="text-gray-500" />
                                                    </div>
                                                    <h3 className="text-sm text-gray-200 font-medium">Modo Invitado</h3>
                                                    <p className="text-xs text-gray-500 leading-relaxed">
                                                        Tus proyectos no se guardarán en la nube. Inicia sesión para sincronizar.
                                                    </p>
                                                </div>
                                                <div className="h-px bg-white/10 w-full my-1" />
                                                <button 
                                                    onClick={() => setSessionPopoverView('login')}
                                                    className="w-full py-2 text-xs font-medium text-black bg-daw-cyan hover:bg-daw-cyan/90 rounded transition-colors text-center font-bold tracking-wider uppercase"
                                                >
                                                    Vincular Cuenta
                                                </button>
                                                <button 
                                                    onClick={() => { setShowSessionPopover(false); if (platformService.isDesktop) { platformService.showHub(); } else { window.location.href = import.meta.env.PROD ? 'https://hollowbits.com/login' : '/login'; } }}
                                                    className="w-full py-2 text-xs font-medium text-gray-400 hover:text-white bg-transparent border border-white/10 hover:bg-white/5 rounded transition-colors text-center"
                                                >
                                                    Ir al Portal de Login
                                                </button>
                                            </>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}
                        
                        {session ? (
                            <button onClick={() => setShowSessionPopover(!showSessionPopover)} className="hidden">
                                {/* Avatar con iniciales */}
                                <div className="relative w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-rose-500 flex items-center justify-center shadow-[0_0_10px_rgba(168,85,247,0.4)] ring-1 ring-white/10 cursor-pointer hover:ring-white/30 transition-all" title={(profile?.full_name || profile?.username || user?.email) ?? 'Sesión activa'}>
                                    <span className="text-white text-[10px] font-bold uppercase select-none">
                                        {(profile?.full_name || profile?.username || user?.email || '?').charAt(0)}
                                    </span>
                                    {/* Online dot */}
                                    <span className="absolute bottom-0 right-0 w-2 h-2 rounded-full bg-green-400 ring-1 ring-[#1a1a1a]" />
                                </div>
                            </button>
                        ) : (
                            <button
                                onClick={() => setShowSessionPopover(!showSessionPopover)}
                                className="hidden"
                                title="Estado de Sesión"
                            >
                                <div className="w-8 h-8 rounded-full border border-white/10 bg-white/[0.03] group-hover:bg-white/10 group-hover:border-purple-500/50 flex items-center justify-center transition-all duration-300">
                                    <UserCircle2 size={16} className="text-gray-600 group-hover:text-purple-400 transition-colors duration-300" />
                                </div>
                                <span className="text-[8px] text-gray-700 group-hover:text-gray-400 uppercase tracking-wider transition-colors duration-300">Guest</span>
                            </button>
                        )}
                    </div>
                    {/* ─────────────────────────────────────────────────────────── */}

                    <input type="file" ref={fileInputRef} className="hidden" multiple accept={AUDIO_IMPORT_ACCEPT} onChange={handleFileImport} />
                    {/* Project Input removed in favor of platformService */}
                </div>


                {!isScannerImmersive && hasLoadedAISidebar && (
                    <React.Suspense fallback={null}>
                        <AISidebar
                            isOpen={showAI}
                            onClose={closeAllToolPanels}
                            bpm={transport.bpm}
                            onPatternGenerated={handleAiPatternGenerated}
                            tracks={tracks}
                        />
                    </React.Suspense>
                )}

                {!isScannerImmersive && (
                    <FluidPanel
                        isOpen={showBrowser}
                        direction="left"
                        className="absolute left-[50px] top-0 bottom-0 w-[300px] z-30 h-full border-r border-[#333] shadow-2xl bg-[#1a1a1a]"
                    >
                        <Browser
                            onImport={handleImportAudio}
                            onImportFromLibrary={handleImportLibraryEntry}
                            onCreateGeneratorTrack={handleCreateBrowserGeneratorTrack}
                            tracks={tracks}
                        />
                    </FluidPanel>
                )}

                <div className="flex-1 overflow-hidden relative flex flex-col bg-transparent">
                    {isScannerImmersive ? (
                        <div className="flex-1 overflow-hidden bg-[#090b12] animate-view-enter">
                            {hasLoadedNoteScanner && (
                                <React.Suspense fallback={<div className="h-full w-full bg-[#0a0a0d]" />}>
                                    <PianoScoreWorkspace
                                        isOpen={showNoteScanner}
                                        tracks={tracks}
                                        transport={transport}
                                        selectedTrackId={selectedTrackId}
                                        selectedClipId={selectedClipId}
                                        scoreWorkspaces={scoreWorkspaces}
                                        onClose={closeAllToolPanels}
                                        onScoreWorkspacesChange={setScoreWorkspaces}
                                        onCreateMidiTrackFromScore={handleCreateMidiTrackFromScan}
                                        onUpdateMidiClip={handleUpdateMidiClipFromScore}
                                        onSelectSource={handleSelectPianoScoreSource}
                                        onPlay={handlePlay}
                                        onPause={handlePause}
                                        onStop={handleStop}
                                        onSeekToBarTime={handleSeekToBarTime}
                                    />
                                </React.Suspense>
                            )}
                        </div>
                    ) : mainView === 'arrange' ? (
                        <div key="arrange" className="flex-1 overflow-hidden bg-transparent relative animate-view-enter">
                            <div
                                ref={timelineContainerRef}
                                className="absolute left-0 top-0 bottom-0 right-[292px] overflow-auto bg-transparent"
                                style={{ scrollBehavior: 'auto' }}
                            >
                                <Timeline
                                    tracks={tracks}
                                    bars={totalProjectBars}
                                    zoom={zoom}
                                    trackHeight={trackHeight}
                                    bpm={transport.bpm}
                                    onSeek={handleTimelineSeek}
                                    onTrackSelect={handleTrackSelect}
                                    onClipSelect={handleClipSelect}
                                    onTrackUpdate={handleTimelineTrackUpdate}
                                    onTrackDelete={removeTrackWithRoutingCleanup}
                                    onClipUpdate={handleTimelineClipUpdate}
                                    onConsolidate={handleConsolidateClips}
                                    onReverse={handleReverseClip}
                                    onQuantize={handleQuantizeClip}
                                    onSplitClip={handleSplitClipAtCursor}
                                    onDuplicateClip={handleDuplicateClip}
                                    onPromoteToComp={handlePromoteClipToComp}
                                    onGridChange={handleTimelineGridChange}
                                    onExternalDrop={handleTimelineExternalDrop}
                                    onAddTrack={handleTimelineAddTrack}
                                    gridSize={transport.gridSize}
                                    snapToGrid={transport.snapToGrid}
                                    selectedTrackId={selectedTrackId}
                                    selectedTrackPunchRange={selectedTrackPunchRange}
                                    selectedTrackColor={selectedAudioTrack?.color || null}
                                    containerRef={timelineContainerRef}
                                    onTimeUpdate={handleTimelineTimeUpdate}
                                    uiFrameBudgetMs={timelineUiFrameBudgetMs}
                                    meterFrameBudgetMs={timelineMeterFrameBudgetMs}
                                    maxActiveMeterTracks={timelineMaxActiveMeterTracks}
                                    simplifyPlaybackVisuals={visualPerformance.simplifyPlaybackVisuals}
                                />
                            </div>
                            <div className="absolute right-0 top-0 bottom-0 w-[292px] z-[85]">
                                <TakeLanesPanel
                                    track={selectedAudioTrack}
                                    selectedClipId={selectedClipId}
                                    selectedTrackPunchRange={selectedTrackPunchRange}
                                    onSelectTake={handleSelectTakeFromPanel}
                                    onToggleTakeMute={handleToggleTakeMuteFromPanel}
                                    onToggleTakeSolo={handleToggleTakeSoloFromPanel}
                                    onAuditionTake={handleTakePanelAudition}
                                    onSetCompLane={handleSetCompLaneFromPanel}
                                />
                            </div>
                        </div>
                    ) : mainView === 'session' ? (
                        <div key="session" className="flex-1 overflow-hidden animate-view-enter">
                            <SessionView
                                tracks={tracks}
                                bpm={transport.bpm}
                                overloadDecision={sessionOverloadDecision}
                                onClipSelect={handleClipSelect}
                                onExternalDrop={(trackId, sceneIndex, payload) => {
                                    void handleSessionExternalDrop(trackId, sceneIndex, payload);
                                }}
                            />
                        </div>
                    ) : (
                        <div key="mixer" className="flex-1 bg-transparent overflow-hidden animate-view-enter">
                            <Mixer
                                tracks={tracks}
                                onUpdate={handleMixerTrackUpdate}
                                onDelete={removeTrackWithRoutingCleanup}
                                onStoreSnapshot={storeMixSnapshot}
                                onRecallSnapshot={recallMixSnapshot}
                                onToggleSnapshotCompare={toggleMixSnapshotCompare}
                                canRecallSnapshotA={Boolean(mixSnapshots.A)}
                                canRecallSnapshotB={Boolean(mixSnapshots.B)}
                                activeSnapshot={activeMixSnapshot}
                                onMacroApply={handleMixerMacroApply}
                                onCreateGroup={handleMixerCreateGroup}
                                meterUpdateIntervalMs={mixerMeterUpdateIntervalMs}
                                maxMeterTracks={mixerMaxMeterTracks}
                            />
                        </div>
                    )}
                    {!isScannerImmersive && (
                        <div className="h-[300px] bg-[#1a1a1a] border-t border-daw-border relative z-50 shadow-[0_-5px_30px_rgba(0,0,0,0.3)] shrink-0 flex flex-col">
                            <div className="h-7 bg-[#121212] border-b border-daw-border flex items-end px-2 gap-1">
                                <button onClick={() => setBottomView('devices')} className={`text-[9px] font-bold px-4 py-1.5 rounded-t-sm transition-all uppercase tracking-wider flex items-center gap-2 ${bottomView === 'devices' ? 'bg-[#1a1a1a] text-white border-t border-l border-r border-daw-border relative top-[1px]' : 'text-gray-500 hover:text-white bg-[#0e0e0e]'}`}><Cpu size={10} /> Dispositivos</button>
                                <button onClick={() => setBottomView('editor')} className={`text-[9px] font-bold px-4 py-1.5 rounded-t-sm transition-all uppercase tracking-wider flex items-center gap-2 ${bottomView === 'editor' ? 'bg-[#1a1a1a] text-white border-t border-l border-r border-daw-border relative top-[1px]' : 'text-gray-500 hover:text-white bg-[#0e0e0e]'}`}><Layers size={10} /> Editor</button>
                            </div>
                            <div className="flex-1 overflow-hidden relative bg-[#1a1a1a] flex">
                                <div className="min-w-0 flex-1 h-full">
                                    {bottomView === 'devices' ? (
                                        <div key="devices" className="h-full animate-view-enter">
                                            <DeviceRack selectedTrack={selectedTrack} onTrackUpdate={(id, updates) => updateTrackById(id, updates, { recolor: false })} />
                                        </div>
                                    ) : (
                                        <div key="editor" className="h-full animate-view-enter">
                                            <Editor
                                                track={selectedTrack}
                                                selectedClipId={selectedClipId}
                                                audioViewState={selectedAudioClipEditorView}
                                                selectedTrackPunchRange={selectedTrackPunchRange}
                                                onClipUpdate={handleEditorClipUpdate}
                                                onConsolidate={handleConsolidateClips}
                                                onReverse={handleReverseClip}
                                                onPromoteToComp={handlePromoteClipToComp}
                                                transport={editorTransportView}
                                            />
                                        </div>
                                    )}
                                </div>
                                {bottomView === 'devices' && (
                                    <div
                                        className="h-full shrink-0 border-l border-white/8 bg-[#0d0d14]"
                                        style={{ width: 'clamp(220px, 24vw, 320px)', flex: '0 0 clamp(220px, 24vw, 320px)' }}
                                    >
                                        <AsciiPerformerDock
                                            isPlaying={transport.isPlaying}
                                            suspendAnimation={transport.isPlaying || transport.isRecording || visualPerformance.freezePerformerDock || globalAudioPriority.disableHeavyVisuals}
                                            frameIntervalMs={performerFrameIntervalMs}
                                        />
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </div>
            {!isScannerImmersive && (
                <div className="h-8 bg-[#11131a]/96 border-t border-white/10 flex items-center justify-between px-4 select-none shrink-0 z-50 backdrop-blur-sm">
                    <div className="flex items-center gap-3">
                        <div
                            className="flex items-center gap-2 px-2.5 h-5 rounded-sm border border-white/10 bg-white/[0.03] text-gray-300 cursor-pointer hover:border-daw-violet/50 hover:bg-white/[0.06] transition-all group/name"
                            onClick={() => {
                                if (!isRenamingProject) {
                                    setRenameValue(projectName);
                                    setIsRenamingProject(true);
                                }
                            }}
                            title="Clic para renombrar proyecto"
                        >
                            {collabSessionId ? (
                                <Cloud size={11} className="text-green-400" />
                            ) : user ? (
                                <CloudOff size={11} className="text-amber-400" />
                            ) : (
                                <HardDrive size={11} className="text-daw-violet" />
                            )}
                            {isRenamingProject ? (
                                <input
                                    autoFocus
                                    type="text"
                                    value={renameValue}
                                    onChange={(e) => setRenameValue(e.target.value)}
                                    onBlur={() => handleRenameProject(renameValue)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') handleRenameProject(renameValue);
                                        if (e.key === 'Escape') setIsRenamingProject(false);
                                        e.stopPropagation();
                                    }}
                                    onClick={(e) => e.stopPropagation()}
                                    className="text-[9px] font-bold uppercase tracking-[0.14em] bg-transparent border-none outline-none text-white w-[120px] selection:bg-daw-violet/40"
                                />
                            ) : (
                                <span className="text-[9px] font-bold uppercase tracking-[0.14em] group-hover/name:text-white transition-colors">{projectName}</span>
                            )}
                            {collabSessionId && (
                                <span className="text-[8px] text-green-400/60 font-mono">NUBE</span>
                            )}
                        </div>
                        {selectedTrack && (
                            <div className="flex items-center gap-2 px-2.5 h-5 rounded-sm border border-white/10 bg-white/[0.03]">
                                <span className="text-[9px] uppercase tracking-[0.14em] text-gray-500">Track</span>
                                <span className="text-[9px] font-mono text-gray-200">{selectedTrack.name}</span>
                            </div>
                        )}
                    </div>

                    <div className="flex items-center gap-3">
                        {engineStats.sampleRateMismatch && (
                            <div className="flex items-center gap-2 px-2.5 h-5 rounded-sm border border-amber-400/40 bg-amber-500/10" title={engineStats.sampleRateMismatchMessage || `Solicitado ${engineStats.requestedSampleRate}, activo ${engineStats.activeSampleRate}`}>
                                <AlertTriangle size={11} className="text-amber-300" />
                                <span className="text-[9px] font-mono text-amber-100">SR solicitado {engineStats.requestedSampleRate}, activo {engineStats.activeSampleRate}</span>
                            </div>
                        )}
                        <div className="flex items-center gap-2 px-2.5 h-5 rounded-sm border border-white/10 bg-white/[0.03]">
                            <span className="text-[9px] uppercase tracking-[0.14em] text-gray-500">View</span>
                            <span className="text-[9px] font-mono text-gray-200">{bottomView === 'devices' ? 'Devices' : 'Editor'}</span>
                        </div>
                        <div className="flex items-center gap-2 px-2.5 h-5 rounded-sm border border-white/10 bg-white/[0.03]">
                            <span className={`w-1.5 h-1.5 rounded-full ${engineStats.state === 'running' ? 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.9)]' : 'bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.8)]'}`}></span>
                            <span className="text-[9px] font-mono text-gray-300">{Math.round(transport.bpm)} BPM</span>
                        </div>
                        {diagnosticsVisible && visualPerformance.showBadge && (
                            <div className="flex items-center gap-2 px-2.5 h-5 rounded-sm border border-white/10 bg-white/[0.03]">
                                <span className="text-[9px] uppercase tracking-[0.14em] text-gray-500">Visual Load</span>
                                <span className={`${visualPerformance.mode === 'degraded' ? 'text-amber-200' : 'text-gray-300'} text-[9px] font-mono`}>
                                    {visualPerformance.uiFpsP95.toFixed(1)} FPS
                                </span>
                            </div>
                        )}
                        <div className="flex items-center gap-2 px-2.5 h-5 rounded-sm border border-white/10 bg-white/[0.03]" title={`Autosave reason: ${lastAutosaveReason}`}>
                            <span className="text-[9px] uppercase tracking-[0.14em] text-gray-500">Autosave</span>
                            <span className="text-[9px] font-mono text-gray-200">
                                {lastAutosaveAt ? new Date(lastAutosaveAt).toLocaleTimeString() : '--:--:--'}
                            </span>
                        </div>
                        <div
                            className={`flex items-center gap-2 px-2.5 h-5 rounded-sm border ${
                                projectIntegrityReport?.issueCount
                                    ? 'border-amber-400/30 bg-amber-500/8'
                                    : 'border-white/10 bg-white/[0.03]'
                            }`}
                            title={projectIntegrityReport
                                ? summarizeProjectIntegrityReport(projectIntegrityReport, 'Integrity')
                                : 'Integrity pending'}
                        >
                            <span className="text-[9px] uppercase tracking-[0.14em] text-gray-500">Integrity</span>
                            <span className={`text-[9px] font-mono ${
                                projectIntegrityReport?.issueCount
                                    ? 'text-amber-200'
                                    : 'text-gray-200'
                            }`}>
                                {projectIntegrityReport
                                    ? (projectIntegrityReport.issueCount > 0 ? `FIX ${projectIntegrityReport.issueCount}` : 'OK')
                                    : '--'}
                            </span>
                        </div>
                        <button
                            type="button"
                            onClick={() => setActiveModal('monitoring-routes')}
                            className={`flex items-center gap-2 px-2.5 h-5 rounded-sm border ${
                                recordingJournalSummary.activeCount > 0 || recordingJournalSummary.failedCount > 0 || recordingJournalSummary.recoveredCount > 0
                                    ? 'border-fuchsia-400/35 bg-fuchsia-500/10'
                                    : 'border-white/10 bg-white/[0.03]'
                            }`}
                            title={`REC Journal active=${recordingJournalSummary.activeCount} committed=${recordingJournalSummary.committedCount} failed=${recordingJournalSummary.failedCount} recovered=${recordingJournalSummary.recoveredCount} monitoring=${monitoringRouteSnapshot.activeCount} pendingFinalize=${monitoringRouteSnapshot.pendingFinalizeCount} sharedInput=${monitoringRouteSnapshot.sharedInputStreamCount}`}
                        >
                            <span className="text-[9px] uppercase tracking-[0.14em] text-gray-500">REC Journal</span>
                            <span className={`text-[9px] font-mono ${
                                recordingJournalSummary.activeCount > 0
                                    ? 'text-fuchsia-200'
                                    : recordingJournalSummary.failedCount > 0 || recordingJournalSummary.recoveredCount > 0
                                        ? 'text-amber-200'
                                        : 'text-gray-200'
                            }`}>
                                A{recordingJournalSummary.activeCount} F{recordingJournalSummary.failedCount + recordingJournalSummary.recoveredCount} M{monitoringRouteSnapshot.activeCount}
                            </span>
                        </button>
                    </div>
                </div>
            )}
            {hasLoadedExportModal && (
                <React.Suspense fallback={null}>
                    <ExportModal isOpen={showExportModal} onClose={() => setShowExportModal(false)} tracks={tracks} totalBars={200} bpm={transport.bpm} />
                </React.Suspense>
            )}

            {/* ====== PROJECT BROWSER SIDE PANEL ====== */}
            {showProjectBrowser && (
                <div className="fixed inset-0 z-[200] flex">
                    {/* Backdrop */}
                    <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={() => setShowProjectBrowser(false)} />
                    {/* Panel */}
                    <div className="relative w-[380px] max-w-[90vw] h-full bg-[#141619] border-r border-white/10 shadow-2xl flex flex-col animate-in slide-in-from-left duration-200">
                        {/* Header */}
                        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
                            <div>
                                <h2 className="text-sm font-bold text-white tracking-wide">Mis Proyectos</h2>
                                <p className="text-[10px] text-gray-500 mt-0.5">Selecciona un proyecto para abrirlo</p>
                            </div>
                            <button
                                onClick={() => setShowProjectBrowser(false)}
                                className="w-7 h-7 flex items-center justify-center rounded-sm text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
                            >
                                <X size={16} />
                            </button>
                        </div>

                        {/* Project List */}
                        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1">
                            {!user && (
                                <div className="flex flex-col items-center justify-center h-full text-center px-6">
                                    <CloudOff size={32} className="text-gray-600 mb-3" />
                                    <p className="text-xs text-gray-400">Inicia sesión para acceder a tus proyectos en la nube.</p>
                                </div>
                            )}
                            {user && loadingCloudProjects && (
                                <div className="flex flex-col items-center justify-center h-40">
                                    <div className="w-5 h-5 border-2 border-daw-violet/30 border-t-daw-violet rounded-full animate-spin" />
                                    <p className="text-[10px] text-gray-500 mt-3 font-mono">Cargando proyectos...</p>
                                </div>
                            )}
                            {user && !loadingCloudProjects && cloudProjects.length === 0 && (
                                <div className="flex flex-col items-center justify-center h-full text-center px-6">
                                    <Folder size={32} className="text-gray-600 mb-3" />
                                    <p className="text-xs text-gray-400">No tienes proyectos guardados aún.</p>
                                    <p className="text-[10px] text-gray-600 mt-1">Guarda tu primer proyecto con Ctrl+S</p>
                                </div>
                            )}
                            {user && !loadingCloudProjects && cloudProjects.map((proj) => (
                                <button
                                    key={proj.id}
                                    onClick={() => handleLoadCloudProject(proj)}
                                    className={`w-full text-left px-4 py-3 rounded-md border transition-all duration-150 group ${
                                        proj.id === collabSessionId
                                            ? 'border-daw-violet/50 bg-daw-violet/10 text-white'
                                            : 'border-transparent hover:border-white/10 hover:bg-white/[0.04] text-gray-300'
                                    }`}
                                >
                                    <div className="flex items-center gap-3">
                                        <div className={`w-8 h-8 rounded-sm flex items-center justify-center shrink-0 ${
                                            proj.id === collabSessionId ? 'bg-daw-violet/20' : 'bg-white/5 group-hover:bg-white/10'
                                        } transition-colors`}>
                                            <Folder size={14} className={proj.id === collabSessionId ? 'text-daw-violet' : 'text-gray-500 group-hover:text-gray-300'} />
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <div className="text-xs font-semibold truncate">{proj.name}</div>
                                            <div className="text-[10px] text-gray-500 mt-0.5 font-mono">
                                                {new Date(proj.updated_at).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                            </div>
                                        </div>
                                        {proj.id === collabSessionId && (
                                            <span className="text-[8px] font-bold text-daw-violet uppercase tracking-wider shrink-0">Actual</span>
                                        )}
                                    </div>
                                </button>
                            ))}
                        </div>

                        {/* Footer */}
                        <div className="px-4 py-3 border-t border-white/10 flex flex-col gap-2">
                            <button
                                onClick={() => { setShowProjectBrowser(false); handleImportFromDisk(); }}
                                className="w-full text-xs text-left px-3 py-2 text-gray-400 hover:text-white hover:bg-white/[0.05] rounded-sm transition-colors flex items-center gap-2"
                            >
                                <HardDrive size={12} />
                                <span>Importar desde disco (.esp)</span>
                            </button>
                        </div>
                    </div>
                </div>
            )}
            <Modal isOpen={activeModal === 'recovery'} onClose={handleDiscardRecoverySnapshot} title="RecuperaciÃ³n automÃ¡tica">
                <div className="flex flex-col gap-4">
                    <p className="text-xs text-gray-300 leading-relaxed">
                        Detectamos un cierre inesperado en la sesiÃ³n anterior. Puedes restaurar el Ãºltimo autosave para continuar donde te quedaste.
                    </p>
                    {recoverySnapshot && (
                        <div className="rounded-sm border border-white/10 bg-white/[0.03] p-3">
                            <div className="text-[10px] uppercase tracking-wider text-gray-500">Ãšltimo autosave</div>
                            <div className="mt-2 text-xs text-gray-200 font-semibold">{recoverySnapshot.projectName}</div>
                            <div className="mt-1 text-[10px] text-gray-500 font-mono">{new Date(recoverySnapshot.timestamp).toLocaleString()}</div>
                            <div className="mt-1 text-[10px] text-daw-cyan">{recoverySnapshot.reason}</div>
                        </div>
                    )}
                    <div className="flex flex-col gap-2">
                        <button
                            onClick={() => {
                                void handleRestoreRecoverySnapshot();
                            }}
                            className="w-full py-2.5 rounded-sm bg-daw-cyan text-[#071017] text-xs font-bold uppercase tracking-wider hover:brightness-110 transition-all"
                        >
                            Restaurar autosave
                        </button>
                        <button
                            onClick={handleDiscardRecoverySnapshot}
                            className="w-full py-2 rounded-sm border border-white/15 text-xs text-gray-300 hover:bg-white/[0.06] transition-all"
                        >
                            Descartar y continuar
                        </button>
                    </div>
                </div>
            </Modal>
            <Modal isOpen={activeModal === 'recording-recovery'} onClose={acknowledgeRecordingRecoveryNotice} title="REC Journal Recovery">
                <div className="flex flex-col gap-4">
                    <div className="rounded-sm border border-amber-400/20 bg-amber-500/5 p-3">
                        <div className="text-[10px] uppercase tracking-[0.18em] text-amber-200">Resumen</div>
                        <div className="mt-2 text-xs text-gray-300 leading-relaxed">
                            Detectamos entradas del journal de grabacion que requieren atencion. Esto no borra tomas ni cambia el proyecto; solo te avisa que hubo sesiones interrumpidas o fallidas que conviene revisar.
                        </div>
                        <div className="mt-3 grid grid-cols-3 gap-2 text-[10px] font-mono">
                            <div className="rounded-sm border border-white/10 bg-white/[0.03] px-2 py-2 text-center">
                                <div className="text-gray-500 uppercase tracking-[0.12em]">Total</div>
                                <div className="mt-1 text-gray-100">{recordingRecoveryAttentionSummary.totalCount}</div>
                            </div>
                            <div className="rounded-sm border border-red-400/20 bg-red-500/5 px-2 py-2 text-center">
                                <div className="text-red-200 uppercase tracking-[0.12em]">Failed</div>
                                <div className="mt-1 text-red-100">{recordingRecoveryAttentionSummary.failedCount}</div>
                            </div>
                            <div className="rounded-sm border border-amber-400/20 bg-amber-500/5 px-2 py-2 text-center">
                                <div className="text-amber-200 uppercase tracking-[0.12em]">Recovered</div>
                                <div className="mt-1 text-amber-100">{recordingRecoveryAttentionSummary.recoveredCount}</div>
                            </div>
                        </div>
                    </div>
                    <div className="flex flex-col gap-2">
                        {recordingRecoveryAttentionEntries.slice(0, 8).map((entry) => {
                            const lastPhase = entry.phases.at(-1);
                            return (
                                <div key={entry.id} className="rounded-sm border border-white/10 bg-white/[0.03] px-3 py-3">
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <div className="text-xs font-semibold text-white truncate">{entry.trackName}</div>
                                            <div className="mt-1 text-[10px] uppercase tracking-[0.16em] text-gray-500">{entry.status}</div>
                                        </div>
                                        <div className="text-[10px] text-gray-500 font-mono shrink-0">{new Date(entry.updatedAt).toLocaleString()}</div>
                                    </div>
                                    <div className="mt-2 text-[11px] text-gray-300">
                                        {entry.failureReason || lastPhase?.message || 'Sin detalle adicional.'}
                                    </div>
                                    <div className="mt-2 text-[10px] text-gray-500 font-mono">
                                        Phase: {lastPhase?.phase || 'unknown'}{typeof lastPhase?.barTime === 'number' ? ` Â· bar ${lastPhase.barTime.toFixed(3)}` : ''}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                    <div className="flex flex-col gap-2">
                        <button
                            onClick={acknowledgeRecordingRecoveryNotice}
                            className="w-full py-2.5 rounded-sm bg-white text-black text-xs font-bold uppercase tracking-wider hover:bg-gray-200 transition-all"
                        >
                            Marcar revisado
                        </button>
                        <div className="text-[10px] text-gray-500 leading-relaxed">
                            El journal permanece guardado para diagnostico. Este acuse solo oculta el aviso hasta que aparezca una incidencia nueva.
                        </div>
                    </div>
                </div>
            </Modal>
            <Modal isOpen={activeModal === 'monitoring-routes'} onClose={() => setActiveModal(null)} title="Monitoring Router v2">
                <div className="flex flex-col gap-4">
                    <div className="rounded-sm border border-white/10 bg-white/[0.03] p-3">
                        <div className="text-[10px] uppercase tracking-[0.18em] text-gray-500">Estado operativo</div>
                        <div className="mt-3 grid grid-cols-3 md:grid-cols-7 gap-2 text-[10px] font-mono">
                            <div className="rounded-sm border border-white/10 bg-black/20 px-2 py-2 text-center">
                                <div className="text-gray-500 uppercase tracking-[0.12em]">Active</div>
                                <div className="mt-1 text-gray-100">{monitoringRouteSnapshot.activeCount}</div>
                            </div>
                            <div className="rounded-sm border border-white/10 bg-black/20 px-2 py-2 text-center">
                                <div className="text-gray-500 uppercase tracking-[0.12em]">Stereo</div>
                                <div className="mt-1 text-gray-100">{monitoringRouteSnapshot.stereoCount}</div>
                            </div>
                            <div className="rounded-sm border border-white/10 bg-black/20 px-2 py-2 text-center">
                                <div className="text-gray-500 uppercase tracking-[0.12em]">Shared</div>
                                <div className="mt-1 text-gray-100">{monitoringRouteSnapshot.sharedInputStreamCount}</div>
                            </div>
                            <div className="rounded-sm border border-white/10 bg-black/20 px-2 py-2 text-center">
                                <div className="text-gray-500 uppercase tracking-[0.12em]">Finalize</div>
                                <div className="mt-1 text-gray-100">{monitoringRouteSnapshot.pendingFinalizeCount}</div>
                            </div>
                            <div className="rounded-sm border border-white/10 bg-black/20 px-2 py-2 text-center">
                                <div className="text-gray-500 uppercase tracking-[0.12em]">Base Lat</div>
                                <div className="mt-1 text-gray-100">{monitoringLatencySummary.baseLatencyMs.toFixed(2)}ms</div>
                            </div>
                            <div className="rounded-sm border border-white/10 bg-black/20 px-2 py-2 text-center">
                                <div className="text-gray-500 uppercase tracking-[0.12em]">Comp Max</div>
                                <div className="mt-1 text-gray-100">{monitoringLatencySummary.maxLatencyCompensationMs.toFixed(2)}ms</div>
                            </div>
                            <div className="rounded-sm border border-white/10 bg-black/20 px-2 py-2 text-center">
                                <div className="text-gray-500 uppercase tracking-[0.12em]">Max Eff</div>
                                <div className="mt-1 text-gray-100">{monitoringLatencySummary.maxEffectiveMonitorLatencyMs.toFixed(2)}ms</div>
                            </div>
                        </div>
                        <div className="mt-3 text-[10px] text-gray-500 leading-relaxed">
                            Esta vista permite auditar modo de entrada, latencia de monitoreo, stream compartido y pistas con finalize pendiente sin mezclarlo con diagnostico invasivo en la UI principal.
                        </div>
                    </div>

                    <div className="flex items-center justify-between gap-3">
                        <div className="text-[10px] uppercase tracking-[0.16em] text-gray-500">Rutas por pista</div>
                        <button
                            onClick={disableAllMonitoring}
                            className="px-3 h-8 rounded-sm border border-red-400/30 text-[10px] font-bold uppercase tracking-[0.16em] text-red-200 hover:bg-red-500/10 transition-all"
                        >
                            Panic Stop Monitoring
                        </button>
                    </div>

                    <div className="flex flex-col gap-2">
                        {monitoringRouteDetails.length === 0 && (
                            <div className="rounded-sm border border-white/10 bg-white/[0.03] px-3 py-4 text-[11px] text-gray-400">
                                No hay rutas de monitoring configuradas.
                            </div>
                        )}
                        {monitoringRouteDetails.map((route) => (
                            <div key={route.trackId} className="rounded-sm border border-white/10 bg-white/[0.03] px-3 py-3">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <div className="text-xs font-semibold text-white truncate">{route.trackName}</div>
                                        <div className="mt-1 flex items-center gap-2 text-[10px] uppercase tracking-[0.14em]">
                                            <span className={route.active ? 'text-emerald-300' : 'text-gray-500'}>
                                                {route.active ? 'Active' : 'Idle'}
                                            </span>
                                            <span className="text-gray-500">Â·</span>
                                            <span className="text-gray-300">{route.mode}</span>
                                            {route.pendingFinalize && (
                                                <>
                                                    <span className="text-gray-500">Â·</span>
                                                    <span className="text-amber-200">Pending Finalize</span>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => disableTrackMonitoring(route.trackId)}
                                        className="px-2.5 h-7 rounded-sm border border-white/10 text-[10px] uppercase tracking-[0.16em] text-gray-300 hover:bg-white/[0.06] transition-all shrink-0"
                                    >
                                        Stop
                                    </button>
                                </div>
                                <div className="mt-3 grid grid-cols-3 gap-2 text-[10px] font-mono">
                                    <div className="rounded-sm border border-white/10 bg-black/20 px-2 py-2">
                                        <div className="text-gray-500 uppercase tracking-[0.12em]">Latency</div>
                                        <div className="mt-1 text-gray-100">{route.latencyCompensationMs.toFixed(2)}ms</div>
                                    </div>
                                    <div className="rounded-sm border border-white/10 bg-black/20 px-2 py-2">
                                        <div className="text-gray-500 uppercase tracking-[0.12em]">Enabled</div>
                                        <div className="mt-1 text-gray-100">{route.monitoringEnabled ? 'yes' : 'no'}</div>
                                    </div>
                                    <div className="rounded-sm border border-white/10 bg-black/20 px-2 py-2">
                                        <div className="text-gray-500 uppercase tracking-[0.12em]">Shared Stream</div>
                                        <div className="mt-1 text-gray-100">{route.sharedInputStream ? 'yes' : 'no'}</div>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </Modal>
            <Modal isOpen={activeModal === 'new-project-confirm'} onClose={() => setActiveModal(null)} title="Nuevo Proyecto"><div className="flex flex-col gap-6"><div className="flex items-start gap-4 text-white"><div className="p-3 bg-daw-ruby/20 rounded-full shrink-0"><AlertTriangle className="text-daw-ruby" size={24} /></div><div><h3 className="font-bold text-lg mb-1">Ã‚Â¿Deseas guardar los cambios?</h3><p className="text-gray-400 text-xs leading-relaxed">Si continúas sin guardar, perderás todo el trabajo actual para abrir un espacio de trabajo limpio.</p></div></div><div className="flex flex-col gap-2"><button onClick={async () => { await handleSaveProject(); resetProjectToEmpty(); }} className="w-full flex items-center justify-between px-4 py-3 bg-white text-black rounded-sm font-bold text-xs hover:bg-gray-200 transition-all group"><div className="flex items-center gap-3"><Save size={16} /><span>GUARDAR Y CREAR NUEVO</span></div></button><button onClick={resetProjectToEmpty} className="w-full flex items-center gap-3 px-4 py-3 bg-[#222] text-daw-ruby border border-daw-ruby/30 rounded-sm font-bold text-xs hover:bg-daw-ruby hover:text-white transition-all"><Trash2 size={16} /><span>CONTINUAR SIN GUARDAR</span></button><button onClick={() => setActiveModal(null)} className="w-full py-2 text-gray-500 hover:text-white text-[10px] font-bold uppercase tracking-widest mt-2">CANCELAR</button></div></div></Modal>

            <Modal isOpen={activeModal === 'project-os'} onClose={() => setActiveModal(null)} title="Project OS">
                <ProjectOsPanel
                    projectId={collabSessionId}
                    projectName={projectName}
                    tier={resolveTier(profile?.tier)}
                    buildSnapshot={createProjectOsSnapshot}
                    onRestoreProject={handleRestoreProjectOsSnapshot}
                    onUpgrade={() => { window.location.href = '/pricing'; }}
                />
            </Modal>

            {activeModal === 'share' && collabSessionId && (
                <ShareProjectModal 
                    projectId={collabSessionId} 
                    projectName={projectName} 
                    onClose={() => setActiveModal(null)} 
                />
            )}

            <Modal isOpen={activeModal === 'collab'} onClose={() => setActiveModal(null)} title="Colaboración">
                <CollabPanel
                    sessionId={collabSessionId}
                    userName={collabUserName}
                    commandCount={projectCommandCount}
                    activity={collabActivity}
                    onUserNameChange={setCollabUserName}
                    onStartSession={handleStartCollabSession}
                    onStopSession={handleStopCollabSession}
                    onCopyInvite={handleCopyCollabInvite}
                />
            </Modal>

        </div>
    );
};

export default App;
