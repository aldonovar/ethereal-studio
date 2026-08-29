import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
    Activity,
    AlertCircle,
    AudioLines,
    CheckCircle2,
    ChevronDown,
    Clock3,
    Copy,
    Cpu,
    FolderOpen,
    Gauge,
    HardDrive,
    Headphones,
    Piano,
    RefreshCcw,
    Search,
    SlidersHorizontal,
    X
} from 'lucide-react';
import { AudioSettings, EngineBackendRoute, ScannedFileEntry } from '../types';
import { engineAdapter, type EngineDiagnostics } from '../services/engineAdapter';
import { midiService, MidiDevice } from '../services/MidiService';
import { platformService } from '../services/platformService';
import {
    AudioPerformanceBenchmarkHistoryRecord,
    DefaultListenMode,
    loadStudioSettings,
    saveStudioSettings
} from '../services/studioSettingsService';
import {
    AudioReliabilityMatrixReport,
    runAudioReliabilityMatrix
} from '../services/audioReliabilityMatrixService';
import {
    createAudioPerformanceBenchmarkHistoryEntry,
    evaluateAudioPerformanceGate,
    type AudioPerformanceGateResult,
    AudioPerformanceBenchmarkReport,
    runAudioPerformanceBenchmark
} from '../services/audioPerformanceBenchmarkService';

interface HardwareSettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    audioSettings: AudioSettings;
    onAudioSettingsChange: (settings: AudioSettings) => void;
    engineStats: EngineDiagnostics;
}

type TabId = 'audio' | 'midi' | 'content';

const SAMPLE_RATE_OPTIONS: Array<{ value: AudioSettings['sampleRate']; label: string }> = [
    { value: 44100, label: '44 kHz (44.1k real)' },
    { value: 48000, label: '48 kHz' },
    { value: 88200, label: '88 kHz (88.2k real)' },
    { value: 96000, label: '92 kHz (96k real)' },
    { value: 192000, label: '196 kHz (192k real)' }
];
const BUFFER_OPTIONS: Array<AudioSettings['bufferSize']> = ['auto', 128, 256, 512, 1024, 2048];
const LATENCY_HINT_OPTIONS: Array<AudioSettings['latencyHint']> = ['interactive', 'balanced', 'playback'];

const AUDIO_LIBRARY_EXTENSIONS = ['wav', 'aif', 'aiff', 'flac', 'mp3', 'ogg'];
const PLUGIN_EXTENSIONS = ['vst3', 'dll'];

const entryClass = 'h-10 rounded-sm border border-white/10 bg-[#12141b] px-3 text-xs text-gray-200 outline-none focus:border-daw-violet/60';

const normalizePath = (value: string): string => value.trim().toLowerCase();

const dedupeByPath = (files: ScannedFileEntry[]): ScannedFileEntry[] => {
    const seen = new Set<string>();

    return files.filter((file) => {
        const key = normalizePath(file.path);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};

const prettyBytes = (bytes: number): string => {
    if (bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / (1024 ** exponent);
    return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
};

const formatLatencyMs = (seconds: number): string => `${(seconds * 1000).toFixed(1)} ms`;

const DEFAULT_LISTENING_OPTIONS: Array<{
    id: DefaultListenMode;
    label: string;
    description: string;
}> = [
    {
        id: 'manual',
        label: 'Manual',
        description: 'Las pistas nuevas nacen en Auto sin monitor activo.'
    },
    {
        id: 'armed',
        label: 'Al armar',
        description: 'Monitor activo solo cuando la pista esta armada.'
    },
    {
        id: 'always',
        label: 'Siempre',
        description: 'Monitor activo permanente en pistas nuevas.'
    }
];

const HardwareSettingsModal: React.FC<HardwareSettingsModalProps> = ({
    isOpen,
    onClose,
    audioSettings,
    onAudioSettingsChange,
    engineStats
}) => {
    const [activeTab, setActiveTab] = useState<TabId>('audio');

    const [isRendered, setIsRendered] = useState(false);
    const [isVisible, setIsVisible] = useState(false);

    const [draftAudio, setDraftAudio] = useState<AudioSettings>(audioSettings);
    const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
    const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
    const [isRefreshingAudioDevices, setIsRefreshingAudioDevices] = useState(false);
    const [isRestartingAudio, setIsRestartingAudio] = useState(false);
    const [schedulerModeDraft, setSchedulerModeDraft] = useState<'interval' | 'worklet-clock'>(() => engineAdapter.getSchedulerMode());
    const [backendRouteDraft, setBackendRouteDraft] = useState<EngineBackendRoute>(() => engineAdapter.getBackendRoute());

    const [midiDevices, setMidiDevices] = useState<MidiDevice[]>([]);
    const [midiActivity, setMidiActivity] = useState<Record<string, number>>({});

    const [pluginFolders, setPluginFolders] = useState<string[]>([]);
    const [libraryFolders, setLibraryFolders] = useState<string[]>([]);
    const [pluginIndex, setPluginIndex] = useState<ScannedFileEntry[]>([]);
    const [libraryIndex, setLibraryIndex] = useState<ScannedFileEntry[]>([]);
    const [isScanningPlugins, setIsScanningPlugins] = useState(false);
    const [isScanningLibrary, setIsScanningLibrary] = useState(false);
    const [defaultListenMode, setDefaultListenMode] = useState<DefaultListenMode>('manual');
    const [isRunningReliabilityMatrix, setIsRunningReliabilityMatrix] = useState(false);
    const [matrixProgressTotal, setMatrixProgressTotal] = useState(0);
    const [matrixProgressCompleted, setMatrixProgressCompleted] = useState(0);
    const [matrixCurrentCaseLabel, setMatrixCurrentCaseLabel] = useState<string | null>(null);
    const [matrixReport, setMatrixReport] = useState<AudioReliabilityMatrixReport | null>(null);
    const matrixAbortRef = useRef<AbortController | null>(null);
    const [isRunningPerformanceBenchmark, setIsRunningPerformanceBenchmark] = useState(false);
    const [benchmarkProgressTotal, setBenchmarkProgressTotal] = useState(0);
    const [benchmarkProgressCompleted, setBenchmarkProgressCompleted] = useState(0);
    const [benchmarkCurrentCaseLabel, setBenchmarkCurrentCaseLabel] = useState<string | null>(null);
    const [benchmarkReport, setBenchmarkReport] = useState<AudioPerformanceBenchmarkReport | null>(null);
    const [benchmarkGate, setBenchmarkGate] = useState<AudioPerformanceGateResult | null>(null);
    const [benchmarkHistory, setBenchmarkHistory] = useState<AudioPerformanceBenchmarkHistoryRecord[]>([]);
    const benchmarkAbortRef = useRef<AbortController | null>(null);

    const [statusTone, setStatusTone] = useState<'ok' | 'warn' | 'error' | null>(null);
    const [statusMessage, setStatusMessage] = useState<string | null>(null);

    const isDesktop = platformService.isDesktop;
    const backendRouteOptions = useMemo(() => engineAdapter.getAvailableRoutes(), []);

    const pluginSize = useMemo(
        () => pluginIndex.reduce((acc, entry) => acc + (entry.size || 0), 0),
        [pluginIndex]
    );

    const librarySize = useMemo(
        () => libraryIndex.reduce((acc, entry) => acc + (entry.size || 0), 0),
        [libraryIndex]
    );

    const hasUnsavedAudioChanges = useMemo(() => {
        return draftAudio.sampleRate !== audioSettings.sampleRate ||
            draftAudio.bufferSize !== audioSettings.bufferSize ||
            draftAudio.latencyHint !== audioSettings.latencyHint ||
            (draftAudio.inputDeviceId || '') !== (audioSettings.inputDeviceId || '') ||
            (draftAudio.outputDeviceId || '') !== (audioSettings.outputDeviceId || '');
    }, [audioSettings, draftAudio]);

    useEffect(() => {
        if (!isOpen) {
            setIsVisible(false);
            const hideTimer = window.setTimeout(() => setIsRendered(false), 280);
            return () => clearTimeout(hideTimer);
        }

        setIsRendered(true);
        setDraftAudio(audioSettings);
        setSchedulerModeDraft(engineAdapter.getSchedulerMode());
        setBackendRouteDraft(engineAdapter.getBackendRoute());
        setActiveTab('audio');
        setBenchmarkGate(null);
        setStatusTone(null);
        setStatusMessage(null);

        const studioSettings = loadStudioSettings();
        setPluginFolders(studioSettings.pluginFolders);
        setLibraryFolders(studioSettings.libraryFolders);
        setPluginIndex(studioSettings.pluginIndex);
        setLibraryIndex(studioSettings.libraryIndex);
        setBenchmarkHistory(studioSettings.benchmarkHistory);
        setDefaultListenMode(studioSettings.defaultListenMode);

        const showTimer = window.setTimeout(() => setIsVisible(true), 24);
        return () => clearTimeout(showTimer);
    }, [audioSettings, isOpen]);

    useEffect(() => {
        if (!isRendered) return;
        saveStudioSettings({
            pluginFolders,
            libraryFolders,
            pluginIndex,
            libraryIndex,
            benchmarkHistory,
            defaultListenMode,
            updatedAt: Date.now()
        });
    }, [benchmarkHistory, defaultListenMode, isRendered, libraryFolders, libraryIndex, pluginFolders, pluginIndex]);

    useEffect(() => {
        return () => {
            matrixAbortRef.current?.abort();
            benchmarkAbortRef.current?.abort();
        };
    }, []);

    const matrixProgressPercent = useMemo(() => {
        if (matrixProgressTotal <= 0) return 0;
        return Math.round((matrixProgressCompleted / matrixProgressTotal) * 100);
    }, [matrixProgressCompleted, matrixProgressTotal]);

    const benchmarkProgressPercent = useMemo(() => {
        if (benchmarkProgressTotal <= 0) return 0;
        return Math.round((benchmarkProgressCompleted / benchmarkProgressTotal) * 100);
    }, [benchmarkProgressCompleted, benchmarkProgressTotal]);

    const refreshAudioDevices = async () => {
        setIsRefreshingAudioDevices(true);
        try {
            const devices = await engineAdapter.getAvailableDevices();
            setInputDevices(devices.inputs);
            setOutputDevices(devices.outputs);
            setStatusTone('ok');
            setStatusMessage('Dispositivos de audio actualizados.');
        } catch (error) {
            console.error('No se pudieron listar dispositivos de audio.', error);
            setStatusTone('error');
            setStatusMessage('No se pudo refrescar la lista de dispositivos de audio.');
        } finally {
            setIsRefreshingAudioDevices(false);
        }
    };

    useEffect(() => {
        if (!isOpen || activeTab !== 'audio') return;
        void refreshAudioDevices();
    }, [activeTab, isOpen]);

    useEffect(() => {
        if (!isOpen) return;

        void midiService.init();
        const unsubscribeDevices = midiService.subscribeDevices((devices) => {
            setMidiDevices(devices.filter((device) => device.type === 'input'));
        });

        const unsubscribeMidiMessages = midiService.onMessage((message) => {
            setMidiActivity((prev) => ({
                ...prev,
                [message.deviceId]: Date.now()
            }));
        });

        return () => {
            unsubscribeDevices();
            unsubscribeMidiMessages();
        };
    }, [isOpen]);

    const updateAudioField = <K extends keyof AudioSettings>(key: K, value: AudioSettings[K]) => {
        setDraftAudio((prev) => ({ ...prev, [key]: value }));
    };

    const applyAudioProfile = (profile: 'recording' | 'balanced' | 'mastering') => {
        if (profile === 'recording') {
            setDraftAudio((prev) => ({ ...prev, latencyHint: 'interactive', bufferSize: 128 }));
            return;
        }

        if (profile === 'balanced') {
            setDraftAudio((prev) => ({ ...prev, latencyHint: 'balanced', bufferSize: 256 }));
            return;
        }

        setDraftAudio((prev) => ({ ...prev, latencyHint: 'playback', bufferSize: 1024 }));
    };

    const syncAudioSettingsFromEngine = () => {
        const effectiveSettings = engineAdapter.getSettings();
        setDraftAudio(effectiveSettings);
        onAudioSettingsChange(effectiveSettings);
        return effectiveSettings;
    };

    const applyAudioChanges = () => {
        onAudioSettingsChange(draftAudio);
        engineAdapter.setAudioConfiguration(draftAudio);
        const effectiveSettings = syncAudioSettingsFromEngine();
        if (effectiveSettings.lastFailedOutputDeviceId && effectiveSettings.lastFailedOutputDeviceId === effectiveSettings.outputDeviceId) {
            setStatusTone('warn');
            setStatusMessage('Configuracion aplicada con fallback al output de sistema.');
            return;
        }
        setStatusTone('ok');
        setStatusMessage('Configuracion de audio aplicada.');
    };

    const applySuggestedHighLoadProfile = () => {
        const suggestion = engineStats.profileSuggestion;
        if (!suggestion) return;
        setDraftAudio((prev) => ({
            ...prev,
            latencyHint: suggestion.latencyHint,
            bufferSize: suggestion.bufferSize
        }));
        setStatusTone('warn');
        setStatusMessage('Sugerencia aplicada en borrador: perfil playback + buffer alto para alta carga.');
    };

    const restartAudioEngine = async () => {
        setIsRestartingAudio(true);
        try {
            onAudioSettingsChange(draftAudio);
            await engineAdapter.restartEngine(draftAudio);
            const effectiveSettings = syncAudioSettingsFromEngine();
            if (effectiveSettings.lastFailedOutputDeviceId && effectiveSettings.lastFailedOutputDeviceId === effectiveSettings.outputDeviceId) {
                setStatusTone('warn');
                setStatusMessage('Motor reiniciado con fallback al output de sistema.');
            } else {
                setStatusTone('ok');
                setStatusMessage('Motor de audio reiniciado con la configuracion actual.');
            }
        } catch (error) {
            console.error('No se pudo reiniciar el motor de audio.', error);
            setStatusTone('error');
            setStatusMessage('No se pudo reiniciar el motor de audio.');
        } finally {
            setIsRestartingAudio(false);
        }
    };

    const runReliabilityMatrix = async () => {
        if (isRunningReliabilityMatrix) return;

        setIsRunningReliabilityMatrix(true);
        setMatrixReport(null);
        setMatrixProgressTotal(0);
        setMatrixProgressCompleted(0);
        setMatrixCurrentCaseLabel(null);
        setStatusTone('warn');
        setStatusMessage('Ejecutando matriz SR x Buffer. El motor se reiniciara de forma controlada.');

        const abortController = new AbortController();
        matrixAbortRef.current = abortController;

        try {
            const report = await runAudioReliabilityMatrix({
                signal: abortController.signal,
                onProgress: ({ totalCases, completedCases, runningCaseLabel }) => {
                    setMatrixProgressTotal(totalCases);
                    setMatrixProgressCompleted(completedCases);
                    setMatrixCurrentCaseLabel(runningCaseLabel);
                }
            });

            setMatrixReport(report);

            const elapsedSeconds = (report.elapsedMs / 1000).toFixed(1);
            if (report.restoreFailed) {
                setStatusTone('error');
                setStatusMessage(`Matriz completada con error de restauracion (${elapsedSeconds}s). ${report.restoreError || ''}`.trim());
            } else if (report.aborted) {
                setStatusTone('warn');
                setStatusMessage(`Matriz cancelada por usuario tras ${report.results.length}/${report.totalCases} casos (${elapsedSeconds}s).`);
            } else if (report.failedCases > 0) {
                setStatusTone('error');
                setStatusMessage(`Matriz completada con fallos: ${report.failedCases} fail, ${report.warnedCases} warn, ${report.passedCases} pass (${elapsedSeconds}s).`);
            } else if (report.warnedCases > 0) {
                setStatusTone('warn');
                setStatusMessage(`Matriz completada sin fallos criticos: ${report.warnedCases} casos con warning, ${report.passedCases} pass (${elapsedSeconds}s).`);
            } else {
                setStatusTone('ok');
                setStatusMessage(`Matriz completada en excelencia tecnica: ${report.passedCases}/${report.totalCases} casos PASS (${elapsedSeconds}s).`);
            }
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                setStatusTone('warn');
                setStatusMessage('Matriz cancelada por usuario.');
            } else {
                console.error('No se pudo ejecutar la matriz de confiabilidad.', error);
                setStatusTone('error');
                setStatusMessage('No se pudo ejecutar la matriz SR x Buffer.');
            }
        } finally {
            if (matrixAbortRef.current === abortController) {
                matrixAbortRef.current = null;
            }
            setMatrixCurrentCaseLabel(null);
            setIsRunningReliabilityMatrix(false);
        }
    };

    const cancelReliabilityMatrix = () => {
        matrixAbortRef.current?.abort();
    };

    const runPerformanceBenchmark = async () => {
        if (isRunningPerformanceBenchmark) return;

        setIsRunningPerformanceBenchmark(true);
        setBenchmarkReport(null);
        setBenchmarkGate(null);
        setBenchmarkProgressTotal(0);
        setBenchmarkProgressCompleted(0);
        setBenchmarkCurrentCaseLabel(null);
        setStatusTone('warn');
        setStatusMessage(`Ejecutando benchmark extremo de Bloque 1 en ruta ${backendRouteDraft}.`);

        const abortController = new AbortController();
        benchmarkAbortRef.current = abortController;

        try {
            const report = await runAudioPerformanceBenchmark({
                signal: abortController.signal,
                onProgress: ({ totalCases, completedCases, runningCaseLabel }) => {
                    setBenchmarkProgressTotal(totalCases);
                    setBenchmarkProgressCompleted(completedCases);
                    setBenchmarkCurrentCaseLabel(runningCaseLabel);
                }
            });

            setBenchmarkReport(report);
            const gate = evaluateAudioPerformanceGate(report);
            setBenchmarkGate(gate);
            const historyEntry = createAudioPerformanceBenchmarkHistoryEntry(report, gate);
            setBenchmarkHistory((prev) => [historyEntry, ...prev].slice(0, 30));

            const elapsedSeconds = (report.elapsedMs / 1000).toFixed(1);
            if (report.restoreFailed) {
                setStatusTone('error');
                setStatusMessage(`Benchmark completado con error de restauracion (${elapsedSeconds}s). ${report.restoreError || ''}`.trim());
            } else if (report.aborted) {
                setStatusTone('warn');
                setStatusMessage(`Benchmark cancelado tras ${report.results.length}/${report.totalCases} escenarios (${elapsedSeconds}s).`);
            } else if (gate.status === 'fail') {
                setStatusTone('error');
                setStatusMessage(`Benchmark completado con gate FAIL: ${gate.failures[0] || 'presupuesto excedido'} (${elapsedSeconds}s).`);
            } else if (gate.status === 'warn') {
                setStatusTone('warn');
                setStatusMessage(`Benchmark completado con warnings de gate: ${gate.warnings[0] || 'revision recomendada'} (${elapsedSeconds}s).`);
            } else {
                setStatusTone('ok');
                setStatusMessage(`Benchmark extremo completado en PASS: ${report.passedCases}/${report.totalCases} casos (${elapsedSeconds}s). Ruta recomendada: ${report.recommendedRoute || 'webaudio'}.`);
            }
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                setStatusTone('warn');
                setStatusMessage('Benchmark cancelado por usuario.');
            } else {
                console.error('No se pudo ejecutar benchmark de performance.', error);
                setStatusTone('error');
                setStatusMessage('No se pudo ejecutar benchmark extremo de performance.');
            }
        } finally {
            if (benchmarkAbortRef.current === abortController) {
                benchmarkAbortRef.current = null;
            }
            setBenchmarkCurrentCaseLabel(null);
            setIsRunningPerformanceBenchmark(false);
        }
    };

    const cancelPerformanceBenchmark = () => {
        benchmarkAbortRef.current?.abort();
    };

    const applySchedulerMode = () => {
        engineAdapter.setSchedulerMode(schedulerModeDraft);
        setStatusTone('ok');
        setStatusMessage(`Scheduler mode aplicado: ${schedulerModeDraft}.`);
    };

    const applyBackendRoute = () => {
        engineAdapter.setBackendRoute(backendRouteDraft);
        const implementationStatus = engineAdapter.getBackendImplementationStatus(backendRouteDraft);
        setStatusTone(implementationStatus === 'native' ? 'ok' : 'warn');
        setStatusMessage(
            implementationStatus === 'native'
                ? `Backend route aplicada: ${backendRouteDraft}.`
                : `Backend route aplicada en modo simulado: ${backendRouteDraft}.`
        );
    };

    const copyJsonReport = async (label: string, payload: unknown) => {
        try {
            const text = JSON.stringify(payload, null, 2);
            await navigator.clipboard.writeText(text);
            setStatusTone('ok');
            setStatusMessage(`${label} copiado al portapapeles.`);
        } catch (error) {
            console.error(`No se pudo copiar ${label}.`, error);
            setStatusTone('error');
            setStatusMessage(`No se pudo copiar ${label}.`);
        }
    };

    const exportJsonReport = (baseName: string, payload: unknown) => {
        try {
            const text = JSON.stringify(payload, null, 2);
            const blob = new Blob([text], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = `${baseName}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
            anchor.click();
            URL.revokeObjectURL(url);
            setStatusTone('ok');
            setStatusMessage(`${baseName} exportado como JSON.`);
        } catch (error) {
            console.error(`No se pudo exportar ${baseName}.`, error);
            setStatusTone('error');
            setStatusMessage(`No se pudo exportar ${baseName}.`);
        }
    };

    const addFolder = async (target: 'plugins' | 'library') => {
        const folder = await platformService.selectDirectory();
        if (!folder) return;

        if (target === 'plugins') {
            setPluginFolders((prev) => {
                if (prev.some((entry) => normalizePath(entry) === normalizePath(folder))) return prev;
                return [...prev, folder];
            });
            return;
        }

        setLibraryFolders((prev) => {
            if (prev.some((entry) => normalizePath(entry) === normalizePath(folder))) return prev;
            return [...prev, folder];
        });
    };

    const removeFolder = (target: 'plugins' | 'library', folder: string) => {
        if (target === 'plugins') {
            setPluginFolders((prev) => prev.filter((entry) => normalizePath(entry) !== normalizePath(folder)));
            return;
        }

        setLibraryFolders((prev) => prev.filter((entry) => normalizePath(entry) !== normalizePath(folder)));
    };

    const scanFolders = async (target: 'plugins' | 'library') => {
        const folders = target === 'plugins' ? pluginFolders : libraryFolders;
        if (!isDesktop) {
            setStatusTone('warn');
            setStatusMessage('El escaneo de carpetas solo esta disponible en la version desktop.');
            return;
        }

        if (folders.length === 0) {
            setStatusTone('warn');
            setStatusMessage(`Agrega al menos una carpeta de ${target === 'plugins' ? 'plugins' : 'libreria'} antes de escanear.`);
            return;
        }

        const extensions = target === 'plugins' ? PLUGIN_EXTENSIONS : AUDIO_LIBRARY_EXTENSIONS;

        if (target === 'plugins') {
            setIsScanningPlugins(true);
        } else {
            setIsScanningLibrary(true);
        }

        try {
            const scannedPerFolder = await Promise.all(
                folders.map((folder) => platformService.scanDirectoryFiles(folder, extensions))
            );
            const merged = dedupeByPath(scannedPerFolder.flat()).sort((a, b) => a.name.localeCompare(b.name));

            if (target === 'plugins') {
                setPluginIndex(merged);
                setStatusTone('ok');
                setStatusMessage(`Escaneo de plugins finalizado: ${merged.length} archivos detectados.`);
            } else {
                setLibraryIndex(merged);
                setStatusTone('ok');
                setStatusMessage(`Escaneo de libreria finalizado: ${merged.length} archivos detectados.`);
            }
        } catch (error) {
            console.error('Fallo el escaneo de carpetas.', error);
            setStatusTone('error');
            setStatusMessage('No se pudo completar el escaneo de carpetas.');
        } finally {
            if (target === 'plugins') {
                setIsScanningPlugins(false);
            } else {
                setIsScanningLibrary(false);
            }
        }
    };

    const toggleMidiDevice = (deviceId: string) => {
        const enabled = midiService.isEnabled(deviceId);
        midiService.setEnabled(deviceId, !enabled);
        setMidiDevices((prev) => [...prev]);
    };

    const toggleAllMidi = (enabled: boolean) => {
        midiService.setAllEnabled(midiDevices.map((device) => device.id), enabled);
        setMidiDevices((prev) => [...prev]);
    };

    const isMidiDeviceHot = (deviceId: string): boolean => {
        const lastEvent = midiActivity[deviceId] || 0;
        return Date.now() - lastEvent < 1400;
    };

    const closeModal = () => {
        if (isScanningLibrary || isScanningPlugins || isRestartingAudio || isRunningReliabilityMatrix || isRunningPerformanceBenchmark) return;
        onClose();
    };

    if (!isRendered) return null;

    return (
        <div
            className={`fixed inset-0 z-[9999] flex items-center justify-center transition-all duration-300 ${isVisible ? 'bg-black/70 backdrop-blur-sm' : 'bg-black/0 backdrop-blur-none'}`}
            onClick={closeModal}
        >
            <div
                className={`w-[980px] max-h-[92vh] rounded-sm border border-white/10 bg-[#0b0c11] overflow-hidden flex transition-all duration-300 ${isVisible ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-4 scale-[0.98]'}`}
                onClick={(event) => event.stopPropagation()}
            >
                <aside className="w-[250px] border-r border-white/10 bg-[#0f1017] flex flex-col">
                    <div className="h-14 px-5 border-b border-white/10 flex items-center justify-between">
                        <div>
                            <div className="text-[10px] uppercase tracking-[0.18em] text-gray-500">Studio Core</div>
                            <div className="text-sm font-bold text-white">Configuracion</div>
                        </div>
                    </div>

                    <div className="p-3 space-y-1.5">
                        <TabButton id="audio" label="Audio" subLabel="I/O · Latencia · Escucha" icon={Cpu} active={activeTab === 'audio'} onClick={setActiveTab} />
                        <TabButton id="midi" label="MIDI" subLabel="Controladores y actividad" icon={Piano} active={activeTab === 'midi'} onClick={setActiveTab} />
                        <TabButton id="content" label="Contenido" subLabel="Plugins + Libreria" icon={HardDrive} active={activeTab === 'content'} onClick={setActiveTab} />
                    </div>

                    <div className="mt-auto p-4 border-t border-white/10 bg-white/[0.01]">
                        <div className="text-[10px] text-gray-500 uppercase tracking-wider">Estado motor</div>
                        <div className="mt-2 flex items-center justify-between text-xs text-gray-300">
                            <span>{engineStats.state.toUpperCase()}</span>
                            <span className="font-mono">{Math.round(engineStats.sampleRate)} Hz</span>
                        </div>
                    </div>
                </aside>

                <section className="flex-1 flex flex-col min-h-0">
                    <header className="h-14 px-5 border-b border-white/10 flex items-center justify-between bg-[#10121b]">
                        <div>
                            <h2 className="text-sm font-semibold text-white">
                                {activeTab === 'audio' && 'Audio Setup'}
                                {activeTab === 'midi' && 'MIDI Controller Hub'}
                                {activeTab === 'content' && 'Gestor de Contenido'}
                            </h2>
                            <p className="text-[10px] text-gray-500 uppercase tracking-wider">Flujo directo, sin pasos ocultos</p>
                        </div>
                        <button
                            onClick={closeModal}
                            className="w-8 h-8 rounded-sm border border-white/10 bg-white/5 text-gray-400 hover:text-white hover:border-white/30 flex items-center justify-center"
                            title="Cerrar"
                        >
                            <X size={14} />
                        </button>
                    </header>

                    <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-5 space-y-5">
                        {activeTab === 'audio' && (
                            <div className="space-y-5">
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                    <ProfileButton
                                        title="Recording"
                                        description="Minima latencia para grabacion"
                                        active={draftAudio.latencyHint === 'interactive'}
                                        onClick={() => applyAudioProfile('recording')}
                                    />
                                    <ProfileButton
                                        title="Balanced"
                                        description="Uso general estable"
                                        active={draftAudio.latencyHint === 'balanced'}
                                        onClick={() => applyAudioProfile('balanced')}
                                    />
                                    <ProfileButton
                                        title="Mastering"
                                        description="Maxima estabilidad de reproduccion"
                                        active={draftAudio.latencyHint === 'playback'}
                                        onClick={() => applyAudioProfile('mastering')}
                                    />
                                </div>

                                <div className="rounded-sm border border-white/10 bg-[#131620] p-4 space-y-3">
                                    <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-gray-500">
                                        <Headphones size={12} /> Escucha por defecto
                                    </div>
                                    <p className="text-xs text-gray-300">Define como nacen las pistas de audio nuevas para mantener un flujo coherente en todo el proyecto.</p>
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                                        {DEFAULT_LISTENING_OPTIONS.map((option) => (
                                            <button
                                                key={option.id}
                                                onClick={() => setDefaultListenMode(option.id)}
                                                className={`rounded-sm border px-3 py-2 text-left transition-colors ${defaultListenMode === option.id
                                                    ? 'border-daw-cyan/50 bg-daw-cyan/10 text-white'
                                                    : 'border-white/10 bg-[#0f1320] text-gray-300 hover:border-white/25 hover:text-white'}`}
                                            >
                                                <div className="text-[11px] font-bold uppercase tracking-wider">{option.label}</div>
                                                <div className="mt-1 text-[10px] text-gray-500">{option.description}</div>
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                <div className="rounded-sm border border-white/10 bg-[#131620] p-4 space-y-3">
                                    <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                                        <div>
                                            <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-gray-500">
                                                <Gauge size={12} /> Matriz de confiabilidad SR x Buffer
                                            </div>
                                            <p className="text-xs text-gray-300 mt-1">Ejecuta validacion automatica en 40 combinaciones de sample rate + buffer y comprueba estabilidad de render.</p>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            {isRunningReliabilityMatrix && (
                                                <button
                                                    onClick={cancelReliabilityMatrix}
                                                    className="h-8 px-3 rounded-sm border border-red-500/35 bg-red-500/10 text-[10px] font-bold uppercase tracking-wider text-red-300 hover:text-red-200"
                                                >
                                                    Cancelar
                                                </button>
                                            )}
                                            <button
                                                onClick={() => void runReliabilityMatrix()}
                                                disabled={isRunningReliabilityMatrix}
                                                className="h-8 px-3 rounded-sm border border-daw-cyan/45 bg-daw-cyan/10 text-[10px] font-bold uppercase tracking-wider text-daw-cyan hover:text-white disabled:opacity-40"
                                            >
                                                    {isRunningReliabilityMatrix ? 'Validando...' : 'Run Matrix'}
                                                </button>
                                            {matrixReport && (
                                                <>
                                                    <button
                                                        onClick={() => void copyJsonReport('Reporte de matriz', matrixReport)}
                                                        className="h-8 px-3 rounded-sm border border-white/20 bg-[#171b28] text-[10px] font-bold uppercase tracking-wider text-gray-200 hover:text-white flex items-center gap-1"
                                                    >
                                                        <Copy size={11} /> Copiar JSON
                                                    </button>
                                                    <button
                                                        onClick={() => exportJsonReport('audio-reliability-matrix', matrixReport)}
                                                        className="h-8 px-3 rounded-sm border border-white/20 bg-[#171b28] text-[10px] font-bold uppercase tracking-wider text-gray-200 hover:text-white"
                                                    >
                                                        Export JSON
                                                    </button>
                                                </>
                                            )}
                                        </div>
                                    </div>

                                    {(isRunningReliabilityMatrix || matrixReport) && (
                                        <div className="rounded-sm border border-white/10 bg-[#0f1320] p-3 space-y-3">
                                            <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-gray-500">
                                                <span>Progreso</span>
                                                <span className="font-mono text-gray-300">{matrixProgressCompleted}/{matrixProgressTotal || matrixReport?.totalCases || 0} ({matrixProgressPercent}%)</span>
                                            </div>

                                            <div className="h-2 rounded-full bg-black/40 overflow-hidden">
                                                <div
                                                    className="h-full bg-gradient-to-r from-daw-cyan/80 to-daw-violet/80 transition-all duration-300"
                                                    style={{ width: `${matrixProgressPercent}%` }}
                                                />
                                            </div>

                                            {matrixCurrentCaseLabel && (
                                                <div className="text-[10px] text-gray-400">Caso actual: <span className="font-mono text-gray-200">{matrixCurrentCaseLabel}</span></div>
                                            )}

                                            {matrixReport && (
                                                <div className="space-y-2">
                                                    <div className="grid grid-cols-3 gap-2">
                                                        <div className="rounded-sm border border-green-500/25 bg-green-500/10 px-2 py-1">
                                                            <div className="text-[9px] uppercase tracking-wider text-green-300">Pass</div>
                                                            <div className="text-sm font-bold text-green-200">{matrixReport.passedCases}</div>
                                                        </div>
                                                        <div className="rounded-sm border border-amber-500/25 bg-amber-500/10 px-2 py-1">
                                                            <div className="text-[9px] uppercase tracking-wider text-amber-300">Warn</div>
                                                            <div className="text-sm font-bold text-amber-200">{matrixReport.warnedCases}</div>
                                                        </div>
                                                        <div className="rounded-sm border border-red-500/25 bg-red-500/10 px-2 py-1">
                                                            <div className="text-[9px] uppercase tracking-wider text-red-300">Fail</div>
                                                            <div className="text-sm font-bold text-red-200">{matrixReport.failedCases}</div>
                                                        </div>
                                                    </div>

                                                    <div className="max-h-44 overflow-y-auto custom-scrollbar space-y-1 pr-1">
                                                        {matrixReport.results.map((result) => (
                                                            <div
                                                                key={result.caseConfig.id}
                                                                className={`rounded-sm border px-2 py-1.5 text-[10px] ${result.status === 'pass'
                                                                    ? 'border-green-500/25 bg-green-500/10 text-green-100'
                                                                    : result.status === 'warn'
                                                                        ? 'border-amber-500/25 bg-amber-500/10 text-amber-100'
                                                                        : 'border-red-500/25 bg-red-500/10 text-red-100'}`}
                                                            >
                                                                <div className="flex items-center justify-between gap-2">
                                                                    <span className="font-mono">{Math.round(result.caseConfig.sampleRate / 100) / 10}kHz / {String(result.caseConfig.bufferSize)}</span>
                                                                    <span className="uppercase tracking-wider">{result.status}</span>
                                                                </div>
                                                                <div className="mt-0.5 text-[9px] opacity-80">
                                                                    activo {result.diagnostics.activeSampleRate}Hz · buffer {result.diagnostics.effectiveBufferSize} · peak {result.render.peakDb.toFixed(1)} dBFS
                                                                </div>
                                                                {result.issues[0] && (
                                                                    <div className="mt-0.5 text-[9px] opacity-90">{result.issues[0]}</div>
                                                                )}
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>

                                <div className="rounded-sm border border-white/10 bg-[#131620] p-4 space-y-3">
                                    <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                                        <div>
                                            <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-gray-500">
                                                <Cpu size={12} /> Benchmark extremo Bloque 1 (rutas + scheduler)
                                            </div>
                                            <p className="text-xs text-gray-300 mt-1">Ejecuta matriz comparativa en rutas WebAudio, Worker DSP y Native Sidecar; incluye A/B interval vs worklet-clock, jitter, lag, CPU y decision tecnica.</p>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            {isRunningPerformanceBenchmark && (
                                                <button
                                                    onClick={cancelPerformanceBenchmark}
                                                    className="h-8 px-3 rounded-sm border border-red-500/35 bg-red-500/10 text-[10px] font-bold uppercase tracking-wider text-red-300 hover:text-red-200"
                                                >
                                                    Cancelar
                                                </button>
                                            )}
                                            <button
                                                onClick={() => void runPerformanceBenchmark()}
                                                disabled={isRunningPerformanceBenchmark}
                                                className="h-8 px-3 rounded-sm border border-daw-violet/45 bg-daw-violet/10 text-[10px] font-bold uppercase tracking-wider text-violet-200 hover:text-white disabled:opacity-40"
                                            >
                                                {isRunningPerformanceBenchmark ? 'Bench Running...' : 'Run Benchmark'}
                                            </button>
                                            {benchmarkReport && (
                                                <>
                                                    <button
                                                        onClick={() => void copyJsonReport('Reporte benchmark', benchmarkReport)}
                                                        className="h-8 px-3 rounded-sm border border-white/20 bg-[#171b28] text-[10px] font-bold uppercase tracking-wider text-gray-200 hover:text-white flex items-center gap-1"
                                                    >
                                                        <Copy size={11} /> Copiar JSON
                                                    </button>
                                                    <button
                                                        onClick={() => exportJsonReport('audio-performance-benchmark', benchmarkReport)}
                                                        className="h-8 px-3 rounded-sm border border-white/20 bg-[#171b28] text-[10px] font-bold uppercase tracking-wider text-gray-200 hover:text-white"
                                                    >
                                                        Export JSON
                                                    </button>
                                                </>
                                            )}
                                            {benchmarkHistory.length > 0 && (
                                                <button
                                                    onClick={() => {
                                                        setBenchmarkHistory([]);
                                                        setStatusTone('ok');
                                                        setStatusMessage('Historial de benchmark limpiado.');
                                                    }}
                                                    className="h-8 px-3 rounded-sm border border-white/20 bg-[#171b28] text-[10px] font-bold uppercase tracking-wider text-gray-200 hover:text-white"
                                                >
                                                    Limpiar Historial
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    {(isRunningPerformanceBenchmark || benchmarkReport || benchmarkHistory.length > 0) && (
                                        <div className="rounded-sm border border-white/10 bg-[#0f1320] p-3 space-y-3">
                                            {(isRunningPerformanceBenchmark || benchmarkReport) && (
                                                <>
                                                    <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-gray-500">
                                                        <span>Progreso</span>
                                                        <span className="font-mono text-gray-300">{benchmarkProgressCompleted}/{benchmarkProgressTotal || benchmarkReport?.totalCases || 0} ({benchmarkProgressPercent}%)</span>
                                                    </div>

                                                    <div className="h-2 rounded-full bg-black/40 overflow-hidden">
                                                        <div
                                                            className="h-full bg-gradient-to-r from-violet-500/80 to-cyan-500/80 transition-all duration-300"
                                                            style={{ width: `${benchmarkProgressPercent}%` }}
                                                        />
                                                    </div>

                                                    {benchmarkCurrentCaseLabel && (
                                                        <div className="text-[10px] text-gray-400">Escenario actual: <span className="font-mono text-gray-200">{benchmarkCurrentCaseLabel}</span></div>
                                                    )}
                                                </>
                                            )}

                                            {benchmarkReport && (
                                                <div className="space-y-2">
                                                    <div className="grid grid-cols-3 gap-2">
                                                        <div className="rounded-sm border border-green-500/25 bg-green-500/10 px-2 py-1">
                                                            <div className="text-[9px] uppercase tracking-wider text-green-300">Pass</div>
                                                            <div className="text-sm font-bold text-green-200">{benchmarkReport.passedCases}</div>
                                                        </div>
                                                        <div className="rounded-sm border border-amber-500/25 bg-amber-500/10 px-2 py-1">
                                                            <div className="text-[9px] uppercase tracking-wider text-amber-300">Warn</div>
                                                            <div className="text-sm font-bold text-amber-200">{benchmarkReport.warnedCases}</div>
                                                        </div>
                                                        <div className="rounded-sm border border-red-500/25 bg-red-500/10 px-2 py-1">
                                                            <div className="text-[9px] uppercase tracking-wider text-red-300">Fail</div>
                                                            <div className="text-sm font-bold text-red-200">{benchmarkReport.failedCases}</div>
                                                        </div>
                                                    </div>

                                                    {benchmarkGate && (
                                                        <div className={`rounded-sm border px-2 py-2 ${benchmarkGate.status === 'pass'
                                                            ? 'border-green-500/30 bg-green-500/10 text-green-100'
                                                            : benchmarkGate.status === 'warn'
                                                                ? 'border-amber-500/30 bg-amber-500/10 text-amber-100'
                                                                : 'border-red-500/30 bg-red-500/10 text-red-100'}`}>
                                                            <div className="text-[9px] uppercase tracking-wider">
                                                                Performance Gate · {benchmarkGate.status.toUpperCase()}
                                                            </div>
                                                            <div className="mt-0.5 text-[9px] opacity-90">
                                                                drift p95 {benchmarkGate.summary.maxWorkletP95TickDriftMs.toFixed(1)}ms · drift p99 {benchmarkGate.summary.maxWorkletP99TickDriftMs.toFixed(1)}ms · lag p95 {benchmarkGate.summary.maxWorkletP95LagMs.toFixed(1)}ms · win-rate {(benchmarkGate.summary.workletWinRate * 100).toFixed(1)}%
                                                            </div>
                                                            {benchmarkGate.issues[0] && (
                                                                <div className="mt-0.5 text-[9px] opacity-95">{benchmarkGate.issues[0]}</div>
                                                            )}
                                                        </div>
                                                    )}

                                                    {(benchmarkReport.routeEvaluations || []).length > 0 && (
                                                        <div className="rounded-sm border border-white/10 bg-black/25 p-2 space-y-1">
                                                            <div className="text-[9px] uppercase tracking-wider text-gray-400">
                                                                Route Decision Matrix · recomendado <span className="text-daw-cyan font-mono">{benchmarkReport.recommendedRoute || 'webaudio'}</span>
                                                            </div>
                                                            {(benchmarkReport.routeEvaluations || []).map((entry) => (
                                                                <div key={entry.route} className="text-[9px] text-gray-200 flex items-center justify-between gap-2">
                                                                    <span className="font-mono uppercase">{entry.route}</span>
                                                                    <span>
                                                                        {entry.implementationStatus} · CPU +{(entry.cpuAudioP95ImprovementRatio * 100).toFixed(1)}% · dropouts -{(entry.dropoutReductionRatio * 100).toFixed(1)}% · drift p99 {entry.driftP99Ms.toFixed(1)}ms
                                                                    </span>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    )}

                                                    {benchmarkReport.comparisons.length > 0 && (
                                                        <div className="rounded-sm border border-white/10 bg-black/25 p-2 space-y-1">
                                                            <div className="text-[9px] uppercase tracking-wider text-gray-400">A/B Interval vs Worklet</div>
                                                            {benchmarkReport.comparisons.map((comparison) => (
                                                                <div key={comparison.scenarioKey} className="text-[9px] text-gray-200 flex items-center justify-between gap-2">
                                                                    <span className="font-mono uppercase">{comparison.scenarioKey}</span>
                                                                    <span>
                                                                        winner <b>{comparison.winner}</b> · drift p95 delta {comparison.driftP95ImprovementMs.toFixed(1)}ms · lag p95 delta {comparison.lagP95ImprovementMs.toFixed(1)}ms
                                                                    </span>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    )}

                                                    <div className="max-h-44 overflow-y-auto custom-scrollbar space-y-1 pr-1">
                                                        {benchmarkReport.results.map((result) => (
                                                            <div
                                                                key={result.caseConfig.id}
                                                                className={`rounded-sm border px-2 py-1.5 text-[10px] ${result.status === 'pass'
                                                                    ? 'border-green-500/25 bg-green-500/10 text-green-100'
                                                                    : result.status === 'warn'
                                                                        ? 'border-amber-500/25 bg-amber-500/10 text-amber-100'
                                                                        : 'border-red-500/25 bg-red-500/10 text-red-100'}`}
                                                            >
                                                                <div className="flex items-center justify-between gap-2">
                                                                    <span className="font-mono">{result.caseConfig.label}</span>
                                                                    <span className="uppercase tracking-wider">{result.status}</span>
                                                                </div>
                                                                <div className="mt-0.5 text-[9px] opacity-80">
                                                                    {result.metrics.scheduler.mode} · drift p95 {result.metrics.scheduler.p95TickDriftMs.toFixed(1)}ms · loop p99 {result.metrics.scheduler.p99LoopMs.toFixed(1)}ms · lag p95 {result.metrics.eventLoop.p95LagMs.toFixed(1)}ms
                                                                </div>
                                                                <div className="mt-0.5 text-[9px] opacity-80">
                                                                    graph writes mix {result.metrics.graphUpdate.mixParamWrites} · sends {result.metrics.graphUpdate.sendLevelWrites}
                                                                </div>
                                                                {result.issues[0] && (
                                                                    <div className="mt-0.5 text-[9px] opacity-90">{result.issues[0]}</div>
                                                                )}
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}

                                            {benchmarkHistory.length > 0 && (
                                                <div className="rounded-sm border border-white/10 bg-[#0d111d] p-2 space-y-1">
                                                    <div className="text-[9px] uppercase tracking-wider text-gray-400">Historial reciente benchmark</div>
                                                    <div className="max-h-24 overflow-y-auto custom-scrollbar pr-1 space-y-1">
                                                        {benchmarkHistory.slice(0, 8).map((entry) => (
                                                            <div key={entry.id} className="text-[9px] text-gray-200 flex items-center justify-between gap-2 border border-white/10 rounded-sm px-2 py-1 bg-black/20">
                                                                <span className="font-mono">{new Date(entry.createdAt).toLocaleString()}</span>
                                                                <span className="uppercase">{entry.gateStatus}</span>
                                                                <span>route {entry.recommendedRoute || 'webaudio'}</span>
                                                                <span>win {(entry.workletWinRate * 100).toFixed(0)}%</span>
                                                                <span>d95 {entry.maxWorkletP95TickDriftMs.toFixed(1)}ms</span>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <SelectField
                                        label="Input Device"
                                        value={draftAudio.inputDeviceId || ''}
                                        onChange={(value) => updateAudioField('inputDeviceId', value || undefined)}
                                        options={[
                                            { value: '', label: 'Sistema (default input)' },
                                            ...inputDevices.map((device) => ({ value: device.deviceId, label: device.label || `Input ${device.deviceId.slice(0, 8)}` }))
                                        ]}
                                    />
                                    <SelectField
                                        label="Output Device"
                                        value={draftAudio.outputDeviceId || ''}
                                        onChange={(value) => updateAudioField('outputDeviceId', value || undefined)}
                                        options={[
                                            { value: '', label: 'Sistema (default output)' },
                                            ...outputDevices.map((device) => ({ value: device.deviceId, label: device.label || `Output ${device.deviceId.slice(0, 8)}` }))
                                        ]}
                                    />
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                    <SelectField
                                        label="Sample Rate"
                                        value={String(draftAudio.sampleRate)}
                                        onChange={(value) => updateAudioField('sampleRate', Number(value) as AudioSettings['sampleRate'])}
                                        options={SAMPLE_RATE_OPTIONS.map((option) => ({
                                            value: String(option.value),
                                            label: option.label
                                        }))}
                                    />

                                    <SelectField
                                        label="Buffer Size"
                                        value={String(draftAudio.bufferSize)}
                                        onChange={(value) => updateAudioField('bufferSize', value === 'auto' ? 'auto' : Number(value) as AudioSettings['bufferSize'])}
                                        options={BUFFER_OPTIONS.map((bufferSize) => ({
                                            value: String(bufferSize),
                                            label: bufferSize === 'auto' ? 'Auto' : `${bufferSize} samples`
                                        }))}
                                    />

                                    <SelectField
                                        label="Latency Hint"
                                        value={draftAudio.latencyHint}
                                        onChange={(value) => updateAudioField('latencyHint', value)}
                                        options={LATENCY_HINT_OPTIONS.map((latencyHint) => ({
                                            value: latencyHint,
                                            label: latencyHint.toUpperCase()
                                        }))}
                                    />
                                </div>

                                <div className="rounded-sm border border-white/10 bg-[#131620] p-4 space-y-3">
                                    <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                                        <div>
                                            <div className="text-[10px] uppercase tracking-wider text-gray-500">Scheduler Clock Mode</div>
                                            <p className="text-xs text-gray-300 mt-1">Selecciona el driver de scheduler para el engine en tiempo real: interval tradicional o reloj por AudioWorklet.</p>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <select
                                                value={schedulerModeDraft}
                                                onChange={(event) => setSchedulerModeDraft(event.target.value as 'interval' | 'worklet-clock')}
                                                className="h-9 rounded-sm border border-white/10 bg-[#12141b] px-3 text-xs text-gray-200 outline-none focus:border-daw-violet/60"
                                            >
                                                <option value="worklet-clock">Worklet Clock (recommended)</option>
                                                <option value="interval">Interval Fallback</option>
                                            </select>
                                            <button
                                                onClick={applySchedulerMode}
                                                className="h-9 px-3 rounded-sm border border-daw-cyan/45 bg-daw-cyan/10 text-[10px] font-bold uppercase tracking-wider text-daw-cyan hover:text-white"
                                            >
                                                Aplicar Scheduler
                                            </button>
                                        </div>
                                    </div>
                                </div>

                                <div className="rounded-sm border border-white/10 bg-[#131620] p-4 space-y-3">
                                    <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                                        <div>
                                            <div className="text-[10px] uppercase tracking-wider text-gray-500">Engine Backend Route (Bloque 1)</div>
                                            <p className="text-xs text-gray-300 mt-1">Permite comparar WebAudio vs Worker DSP vs Native Sidecar sin romper la UI actual.</p>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <select
                                                value={backendRouteDraft}
                                                onChange={(event) => setBackendRouteDraft(event.target.value as EngineBackendRoute)}
                                                className="h-9 rounded-sm border border-white/10 bg-[#12141b] px-3 text-xs text-gray-200 outline-none focus:border-daw-violet/60"
                                            >
                                                {backendRouteOptions.map((route) => (
                                                    <option key={route.route} value={route.route}>
                                                        {route.label} · {route.status}
                                                    </option>
                                                ))}
                                            </select>
                                            <button
                                                onClick={applyBackendRoute}
                                                className="h-9 px-3 rounded-sm border border-daw-violet/45 bg-daw-violet/10 text-[10px] font-bold uppercase tracking-wider text-daw-violet hover:text-white"
                                            >
                                                Aplicar Route
                                            </button>
                                        </div>
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
                                    <MetricCard label="Engine Rate" value={`${Math.round(engineStats.sampleRate)} Hz`} icon={AudioLines} />
                                    <MetricCard label="Current Latency" value={formatLatencyMs(engineStats.latency)} icon={Clock3} />
                                    <MetricCard label="Engine State" value={engineStats.state.toUpperCase()} icon={Gauge} />
                                    <MetricCard
                                        label="Buffer (Req→Eff)"
                                        value={`${String(engineStats.configuredBufferSize ?? 'auto')} → ${Math.round(engineStats.effectiveBufferSize || 0)} smp`}
                                        icon={Cpu}
                                    />
                                    <MetricCard
                                        label="Buffer Strategy"
                                        value={(engineStats.bufferStrategy || 'n/a').toUpperCase()}
                                        icon={Activity}
                                    />
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                                    <MetricCard label="Scheduler Mode" value={(engineStats.schedulerMode || 'n/a').toUpperCase()} icon={Cpu} />
                                    <MetricCard label="Tick Drift P95" value={`${(engineStats.schedulerP95TickDriftMs || 0).toFixed(1)} ms`} icon={Clock3} />
                                    <MetricCard label="Tick Drift P99" value={`${(engineStats.schedulerP99TickDriftMs || 0).toFixed(1)} ms`} icon={Clock3} />
                                    <MetricCard label="Loop P99" value={`${(engineStats.schedulerP99LoopMs || 0).toFixed(1)} ms`} icon={Activity} />
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                    <MetricCard label="Queue Entries" value={`${Math.round(engineStats.schedulerQueueEntries || 0)}`} icon={Gauge} />
                                    <MetricCard label="Queue Active" value={`${Math.round(engineStats.schedulerQueueActive || 0)}`} icon={Cpu} />
                                    <MetricCard label="Queue Cand P95" value={`${(engineStats.schedulerQueueP95Candidates || 0).toFixed(1)}`} icon={Activity} />
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                                    <MetricCard label="CPU Load P95" value={`${(engineStats.schedulerCpuLoadP95Percent || 0).toFixed(1)} %`} icon={Cpu} />
                                    <MetricCard label="Overrun Ratio" value={`${((engineStats.schedulerOverrunRatio || 0) * 100).toFixed(1)} %`} icon={Gauge} />
                                    <MetricCard label="Underruns" value={`${Math.round(engineStats.schedulerUnderrunCount || 0)}`} icon={AlertCircle} />
                                    <MetricCard label="Dropouts" value={`${Math.round(engineStats.schedulerDropoutCount || 0)}`} icon={AlertCircle} />
                                </div>

                                {engineStats.sampleRateMismatch && (
                                    <div className="rounded-sm border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                                        <div className="font-semibold uppercase tracking-wider text-[10px] text-amber-200">Advertencia de compatibilidad</div>
                                        <div className="mt-1">Sample rate solicitado {engineStats.requestedSampleRate}, activo {engineStats.activeSampleRate}. El sistema no soporta el valor elegido y se usa el activo para reproduccion.</div>
                                    </div>
                                )}

                                {engineStats.profileSuggestion && (
                                    <div className="rounded-sm border border-daw-violet/40 bg-daw-violet/10 px-3 py-2 text-xs text-violet-100 flex items-start justify-between gap-3">
                                        <div>
                                            <div className="font-semibold uppercase tracking-wider text-[10px] text-violet-200">Sugerencia de alta carga</div>
                                            <div className="mt-1">{engineStats.profileSuggestion.reason}</div>
                                        </div>
                                        <button
                                            onClick={applySuggestedHighLoadProfile}
                                            className="h-8 px-3 rounded-sm border border-daw-violet/55 bg-daw-violet/20 text-[10px] font-bold uppercase tracking-wider text-violet-100 hover:bg-daw-violet/30"
                                        >
                                            Aplicar sugerencia
                                        </button>
                                    </div>
                                )}

                                <div className="flex flex-wrap items-center gap-2">
                                    <button
                                        onClick={refreshAudioDevices}
                                        disabled={isRefreshingAudioDevices}
                                        className="h-9 px-4 rounded-sm border border-white/15 bg-[#151824] text-[10px] font-bold uppercase tracking-wider text-gray-200 hover:text-white hover:border-daw-violet/60 disabled:opacity-40 flex items-center gap-2"
                                    >
                                        <RefreshCcw size={12} className={isRefreshingAudioDevices ? 'animate-spin' : ''} />
                                        Refrescar I/O
                                    </button>
                                    <button
                                        onClick={restartAudioEngine}
                                        disabled={isRestartingAudio}
                                        className="h-9 px-4 rounded-sm border border-daw-ruby/45 bg-daw-ruby/10 text-[10px] font-bold uppercase tracking-wider text-daw-ruby hover:bg-daw-ruby/20 disabled:opacity-40 flex items-center gap-2"
                                    >
                                        <SlidersHorizontal size={12} className={isRestartingAudio ? 'animate-spin' : ''} />
                                        Reiniciar Motor
                                    </button>
                                </div>
                            </div>
                        )}

                        {activeTab === 'midi' && (
                            <div className="space-y-4">
                                <div className="flex flex-wrap gap-2">
                                    <button
                                        onClick={() => toggleAllMidi(true)}
                                        className="h-8 px-3 rounded-sm border border-white/15 bg-[#151824] text-[10px] font-bold uppercase tracking-wider text-gray-200 hover:text-white hover:border-daw-violet/60"
                                    >
                                        Enable All
                                    </button>
                                    <button
                                        onClick={() => toggleAllMidi(false)}
                                        className="h-8 px-3 rounded-sm border border-white/15 bg-[#151824] text-[10px] font-bold uppercase tracking-wider text-gray-200 hover:text-white hover:border-daw-violet/60"
                                    >
                                        Disable All
                                    </button>
                                    <button
                                        onClick={() => void midiService.init()}
                                        className="h-8 px-3 rounded-sm border border-white/15 bg-[#151824] text-[10px] font-bold uppercase tracking-wider text-gray-200 hover:text-white hover:border-daw-violet/60 flex items-center gap-2"
                                    >
                                        <RefreshCcw size={11} />
                                        Re-scan
                                    </button>
                                </div>

                                {midiDevices.length === 0 ? (
                                    <div className="h-44 rounded-sm border border-dashed border-white/15 bg-[#12141b] flex flex-col items-center justify-center gap-3 text-gray-500">
                                        <Piano size={24} />
                                        <p className="text-xs uppercase tracking-wider">No se detectaron controladores MIDI</p>
                                    </div>
                                ) : (
                                    <div className="space-y-2">
                                        {midiDevices.map((device) => {
                                            const enabled = midiService.isEnabled(device.id);
                                            const active = isMidiDeviceHot(device.id);

                                            return (
                                                <div key={device.id} className="rounded-sm border border-white/10 bg-[#12141b] px-4 py-3 flex items-center justify-between gap-4">
                                                    <div className="min-w-0">
                                                        <div className="text-sm font-semibold text-white truncate">{device.name}</div>
                                                        <div className="text-[10px] uppercase tracking-wider text-gray-500 mt-1">
                                                            {device.manufacturer || 'Generic MIDI'} · {device.state}
                                                        </div>
                                                    </div>
                                                    <div className="flex items-center gap-3 shrink-0">
                                                        <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-sm border text-[9px] font-bold uppercase tracking-wider ${active ? 'border-green-500/35 bg-green-500/10 text-green-400' : 'border-white/15 bg-[#1a1e2a] text-gray-500'}`}>
                                                            <Activity size={10} /> {active ? 'Signal' : 'Idle'}
                                                        </span>
                                                        <button
                                                            onClick={() => toggleMidiDevice(device.id)}
                                                            className={`h-7 px-3 rounded-sm border text-[10px] font-bold uppercase tracking-wider ${enabled ? 'border-daw-violet/45 bg-daw-violet/15 text-daw-violet' : 'border-white/15 bg-[#1a1e2a] text-gray-400 hover:text-white hover:border-white/30'}`}
                                                        >
                                                            {enabled ? 'Enabled' : 'Disabled'}
                                                        </button>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        )}

                        {activeTab === 'content' && (
                            <div className="space-y-5">
                                <ScanManagerSection
                                    title="Plugin Folders"
                                    hint="Escanea VST3 y DLL para construir un indice navegable."
                                    folders={pluginFolders}
                                    entries={pluginIndex}
                                    isDesktop={isDesktop}
                                    isScanning={isScanningPlugins}
                                    totalSize={pluginSize}
                                    onAddFolder={() => void addFolder('plugins')}
                                    onRemoveFolder={(folder) => removeFolder('plugins', folder)}
                                    onScan={() => void scanFolders('plugins')}
                                />

                                <ScanManagerSection
                                    title="Library Folders"
                                    hint="Indexa audio (WAV, AIFF, FLAC, MP3, OGG) para flujo rapido de importacion."
                                    folders={libraryFolders}
                                    entries={libraryIndex}
                                    isDesktop={isDesktop}
                                    isScanning={isScanningLibrary}
                                    totalSize={librarySize}
                                    onAddFolder={() => void addFolder('library')}
                                    onRemoveFolder={(folder) => removeFolder('library', folder)}
                                    onScan={() => void scanFolders('library')}
                                />
                            </div>
                        )}

                        {statusMessage && (
                            <div className={`rounded-sm border px-3 py-2 text-[11px] flex items-start gap-2 ${statusTone === 'ok'
                                ? 'border-green-500/35 bg-green-500/10 text-green-200'
                                : statusTone === 'error'
                                    ? 'border-red-500/35 bg-red-500/10 text-red-200'
                                    : 'border-amber-500/35 bg-amber-500/10 text-amber-200'}`}>
                                {statusTone === 'ok' ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}
                                <span>{statusMessage}</span>
                            </div>
                        )}
                    </div>

                    <footer className="h-14 px-5 border-t border-white/10 bg-[#10121b] flex items-center justify-between">
                        <div className="text-[10px] uppercase tracking-wider text-gray-500">
                            {hasUnsavedAudioChanges
                                ? 'Hay cambios de audio pendientes de aplicar.'
                                : 'Configuracion sincronizada.'}
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={() => setDraftAudio(audioSettings)}
                                disabled={!hasUnsavedAudioChanges}
                                className="h-9 px-4 rounded-sm border border-white/10 bg-[#151824] text-[10px] font-bold uppercase tracking-wider text-gray-300 hover:text-white disabled:opacity-40"
                            >
                                Revertir
                            </button>
                            <button
                                onClick={applyAudioChanges}
                                disabled={!hasUnsavedAudioChanges}
                                className="h-9 px-5 rounded-sm border border-daw-ruby/45 bg-gradient-to-r from-daw-violet to-daw-ruby text-white text-[10px] font-black uppercase tracking-[0.13em] disabled:opacity-40"
                            >
                                Aplicar Audio
                            </button>
                        </div>
                    </footer>
                </section>
            </div>
        </div>
    );
};

interface TabButtonProps {
    id: TabId;
    icon: React.ElementType;
    label: string;
    subLabel: string;
    active: boolean;
    onClick: (id: TabId) => void;
}

const TabButton: React.FC<TabButtonProps> = ({ id, icon: Icon, label, subLabel, active, onClick }) => (
    <button
        onClick={() => onClick(id)}
        className={`w-full rounded-sm border px-3 py-2.5 text-left transition-all ${active
            ? 'border-daw-violet/40 bg-daw-violet/10'
            : 'border-white/5 bg-white/[0.01] hover:border-white/20 hover:bg-white/[0.03]'}`}
    >
        <div className="flex items-center gap-2">
            <Icon size={14} className={active ? 'text-daw-violet' : 'text-gray-500'} />
            <div className={`text-[11px] font-bold uppercase tracking-wider ${active ? 'text-white' : 'text-gray-300'}`}>{label}</div>
        </div>
        <div className={`text-[9px] mt-1 uppercase tracking-wide ${active ? 'text-daw-violet/60' : 'text-gray-500'}`}>{subLabel}</div>
    </button>
);

interface SelectFieldProps {
    label: string;
    value: string;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: string }>;
}

const SelectField: React.FC<SelectFieldProps> = ({ label, value, onChange, options }) => (
    <div className="space-y-1.5">
        <label className="text-[10px] uppercase tracking-wider text-gray-500">{label}</label>
        <div className="relative">
            <select
                value={value}
                onChange={(event) => onChange(event.target.value)}
                className={`${entryClass} w-full pr-8`}
            >
                {options.map((option) => (
                    <option key={option.value} value={option.value} className="bg-[#11131a] text-white">
                        {option.label}
                    </option>
                ))}
            </select>
            <ChevronDown size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
        </div>
    </div>
);

interface ProfileButtonProps {
    title: string;
    description: string;
    active: boolean;
    onClick: () => void;
}

const ProfileButton: React.FC<ProfileButtonProps> = ({ title, description, active, onClick }) => (
    <button
        onClick={onClick}
        className={`rounded-sm border px-4 py-3 text-left transition-all ${active
            ? 'border-daw-violet/45 bg-daw-violet/12 text-white'
            : 'border-white/10 bg-[#131620] text-gray-300 hover:text-white hover:border-white/25'}`}
    >
        <div className="text-[11px] font-black uppercase tracking-wider">{title}</div>
        <div className="text-[10px] mt-1 text-gray-500">{description}</div>
    </button>
);

interface MetricCardProps {
    label: string;
    value: string;
    icon: React.ElementType;
}

const MetricCard: React.FC<MetricCardProps> = ({ label, value, icon: Icon }) => (
    <div className="rounded-sm border border-white/10 bg-[#131620] px-3 py-2.5">
        <div className="flex items-center gap-2 text-gray-500 text-[10px] uppercase tracking-wider">
            <Icon size={12} /> {label}
        </div>
        <div className="mt-1 text-sm font-mono text-white">{value}</div>
    </div>
);

interface ScanManagerSectionProps {
    title: string;
    hint: string;
    folders: string[];
    entries: ScannedFileEntry[];
    totalSize: number;
    isDesktop: boolean;
    isScanning: boolean;
    onAddFolder: () => void;
    onRemoveFolder: (folder: string) => void;
    onScan: () => void;
}

const ScanManagerSection: React.FC<ScanManagerSectionProps> = ({
    title,
    hint,
    folders,
    entries,
    totalSize,
    isDesktop,
    isScanning,
    onAddFolder,
    onRemoveFolder,
    onScan
}) => (
    <div className="space-y-4">
        <div className="rounded-sm border border-white/10 bg-[#131620] p-4">
            <div className="flex items-center justify-between gap-3">
                <div>
                    <h3 className="text-sm font-semibold text-white">{title}</h3>
                    <p className="text-[10px] uppercase tracking-wider text-gray-500 mt-1">{hint}</p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={onAddFolder}
                        disabled={!isDesktop}
                        className="h-8 px-3 rounded-sm border border-white/15 bg-[#171a26] text-[10px] font-bold uppercase tracking-wider text-gray-200 hover:text-white disabled:opacity-40 flex items-center gap-1.5"
                    >
                        <FolderOpen size={11} /> Agregar carpeta
                    </button>
                    <button
                        onClick={onScan}
                        disabled={!isDesktop || isScanning}
                        className="h-8 px-3 rounded-sm border border-daw-violet/35 bg-daw-violet/12 text-[10px] font-bold uppercase tracking-wider text-daw-violet hover:bg-daw-violet/20 disabled:opacity-40 flex items-center gap-1.5"
                    >
                        {isScanning ? <RefreshCcw size={11} className="animate-spin" /> : <Search size={11} />}
                        Escanear
                    </button>
                </div>
            </div>

            {!isDesktop && (
                <div className="mt-3 rounded-sm border border-amber-400/30 bg-amber-400/10 text-amber-200 text-[10px] px-3 py-2">
                    Esta funcion requiere la app desktop para acceder al sistema de archivos.
                </div>
            )}

            <div className="mt-3 space-y-2">
                {folders.length === 0 ? (
                    <div className="h-12 rounded-sm border border-dashed border-white/15 bg-[#11131a] px-3 flex items-center text-[11px] text-gray-500">
                        No hay carpetas agregadas.
                    </div>
                ) : (
                    folders.map((folder) => (
                        <div key={folder} className="h-10 rounded-sm border border-white/10 bg-[#11131a] px-3 flex items-center justify-between gap-3">
                            <span className="text-xs text-gray-300 truncate">{folder}</span>
                            <button
                                onClick={() => onRemoveFolder(folder)}
                                className="text-[10px] uppercase tracking-wider text-gray-500 hover:text-daw-ruby"
                            >
                                quitar
                            </button>
                        </div>
                    ))
                )}
            </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
            <MetricCard label="Archivos" value={String(entries.length)} icon={HardDrive} />
            <MetricCard label="Tamano indexado" value={prettyBytes(totalSize)} icon={Activity} />
        </div>

        <div className="rounded-sm border border-white/10 bg-[#131620] overflow-hidden">
            <div className="h-9 px-3 border-b border-white/10 flex items-center text-[10px] uppercase tracking-wider text-gray-500">
                Ultimos archivos indexados
            </div>
            <div className="max-h-[240px] overflow-y-auto custom-scrollbar">
                {entries.length === 0 ? (
                    <div className="h-16 px-3 flex items-center text-xs text-gray-500">Todavia no hay resultados de escaneo.</div>
                ) : (
                    entries.slice(0, 300).map((entry) => (
                        <div key={entry.path} className="h-9 px-3 border-b border-white/5 flex items-center justify-between gap-3">
                            <span className="text-xs text-gray-300 truncate">{entry.name}</span>
                            <span className="text-[10px] font-mono text-gray-500 shrink-0">{prettyBytes(entry.size)}</span>
                        </div>
                    ))
                )}
            </div>
        </div>
    </div>
);

const MemoizedHardwareSettingsModal = React.memo(HardwareSettingsModal);

export { MemoizedHardwareSettingsModal as HardwareSettingsModal };
