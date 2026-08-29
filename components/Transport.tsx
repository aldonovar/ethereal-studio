
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Play, Square, Circle, Download, RotateCcw, Pause, SkipBack, SkipForward, Repeat, Activity, Minus, X, Maximize2, Minimize2 } from 'lucide-react';
import { PunchRange, TransportState } from '../types';
import { MidiDevice } from '../services/MidiService';
import { audioEngine } from '../services/audioEngine';
import { platformService } from '../services/platformService';
import {
    getTransportClockSnapshot,
    subscribeTransportClock
} from '../services/transportClockStore';
import Knob from './Knob';
import AppLogo from './AppLogo';

type AppRegionStyle = React.CSSProperties & {
    WebkitAppRegion: 'drag' | 'no-drag';
};

// --- SUB-COMPONENT: DRAGGABLE NUMBER (BPM) ---
interface DraggableNumberProps {
    value: number;
    onChange: (val: number) => void;
    min?: number;
    max?: number;
    label?: string;
    color?: string;
    integerOnly?: boolean;
}

const DraggableNumber: React.FC<DraggableNumberProps> = ({
    value,
    onChange,
    min = 20,
    max = 999,
    label,
    color = 'white',
    integerOnly = false,
}) => {
    const [isEditing, setIsEditing] = useState(false);
    const [inputValue, setInputValue] = useState(value.toString());
    const prevValue = useRef(value);
    const startX = useRef(0);

    // If not editing, ensure input value matches prop
    useEffect(() => {
        if (!isEditing) setInputValue(value.toString());
    }, [value, isEditing]);

    const handlePointerDown = (e: React.PointerEvent) => {
        if (isEditing) return;
        e.preventDefault();

        const target = e.currentTarget as HTMLElement;
        target.setPointerCapture(e.pointerId);

        prevValue.current = value;
        startX.current = e.clientX;

        // Visual feedback
        document.body.style.cursor = 'ew-resize';
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        e.preventDefault();

        const deltaX = e.clientX - startX.current; // Right is positive
        if (deltaX === 0) return;

        // Sensitivity
        let step = 1;
        if (!integerOnly && e.shiftKey) step = 0.1; // Fine adjustment

        // Scale delta for comfortable feel
        const change = deltaX * (step * 0.5);

        let newVal = prevValue.current + change;
        newVal = Math.min(max, Math.max(min, newVal));

        if (integerOnly || !e.shiftKey) newVal = Math.round(newVal);
        else newVal = Number(newVal.toFixed(2));

        onChange(newVal);
    };

    const handlePointerUp = (e: React.PointerEvent) => {
        const target = e.currentTarget as HTMLElement;
        target.releasePointerCapture(e.pointerId);
        document.body.style.cursor = 'default';

        // Detect click (no drag) to enter edit mode
        if (Math.abs(e.clientX - startX.current) < 3) {
            setIsEditing(true);
        }
    };

    const commitEdit = () => {
        let val = parseFloat(inputValue);
        if (isNaN(val)) val = value;
        val = Math.min(max, Math.max(min, val));
        if (integerOnly) {
            val = Math.round(val);
        }
        onChange(val);
        setIsEditing(false);
    };

    return (
        <div className="flex flex-col relative group">
            {label && (
                <span className="absolute -top-2 left-1 text-[8px] font-bold text-gray-500 bg-daw-bg px-1 z-10">{label}</span>
            )}
            <div
                className={`h-8 min-w-[60px] bg-[#1a1a1a] border rounded-[2px] overflow-hidden flex items-center relative transition-colors 
                    ${isEditing ? 'border-daw-cyan' : 'border-daw-border hover:border-gray-500'}
                `}
            >
                {isEditing ? (
                    <input
                        autoFocus
                        type="text"
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        onBlur={commitEdit}
                        onKeyDown={(e) => e.key === 'Enter' && commitEdit()}
                        className="bg-[#050505] text-white font-mono font-bold text-sm w-full h-full text-center outline-none"
                    />
                ) : (
                    <div
                        onPointerDown={handlePointerDown}
                        onPointerMove={handlePointerMove}
                        onPointerUp={handlePointerUp}
                        className="w-full h-full flex items-center justify-center cursor-ew-resize select-none relative z-0"
                        title="Drag left/right to change, Shift for fine, Click to edit"
                    >
                        <span
                            className="font-mono font-bold text-sm"
                            style={{ color: color }}
                        >
                            {value}
                        </span>
                    </div>
                )}
            </div>
        </div>
    );
};

interface PunchFieldProps {
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
    decimals?: number;
    disabled?: boolean;
    onChange: (value: number) => void;
}

const PunchField: React.FC<PunchFieldProps> = ({
    label,
    value,
    min,
    max,
    step,
    decimals = 2,
    disabled = false,
    onChange
}) => {
    const normalizedValue = Number.isFinite(value) ? value : min;
    const clampedValue = Math.max(min, Math.min(max, normalizedValue));
    const displayValue = clampedValue.toFixed(decimals);

    return (
        <label className="flex items-center gap-1 text-[9px] font-bold tracking-wide text-gray-400 uppercase">
            <span className="w-9 text-right">{label}</span>
            <input
                type="number"
                value={displayValue}
                step={step}
                min={min}
                max={max}
                disabled={disabled}
                onChange={(event) => {
                    const parsed = Number.parseFloat(event.target.value);
                    if (!Number.isFinite(parsed)) return;
                    onChange(Math.max(min, Math.min(max, parsed)));
                }}
                className={`w-[72px] h-6 bg-[#101012] border rounded-[2px] px-1.5 text-[10px] font-mono text-gray-100 focus:outline-none focus:border-daw-cyan ${disabled ? 'opacity-40 cursor-not-allowed border-daw-border' : 'border-[#2f2f36]'}`}
            />
        </label>
    );
};

const TransportPositionReadout: React.FC<{ fallbackPosition: Pick<TransportState, 'currentBar' | 'currentBeat' | 'currentSixteenth'> }> = React.memo(({
    fallbackPosition
}) => {
    const transportClock = useSyncExternalStore(
        subscribeTransportClock,
        getTransportClockSnapshot,
        getTransportClockSnapshot
    );

    const currentBar = transportClock.currentBar || fallbackPosition.currentBar;
    const currentBeat = transportClock.currentBeat || fallbackPosition.currentBeat;
    const currentSixteenth = transportClock.currentSixteenth || fallbackPosition.currentSixteenth;

    return (
        <span className="font-mono font-bold text-sm text-daw-violet">
            {currentBar}
            <span className="text-gray-600">.</span>
            {currentBeat}
            <span className="text-gray-600">.</span>
            {currentSixteenth}
        </span>
    );
});

// --- MAIN TRANSPORT COMPONENT ---

interface TransportProps {
    transport: TransportState;
    midiDevices: MidiDevice[];
    onPlay: () => void;
    onPause: () => void;
    onStop: () => void;
    onRecordToggle: () => void;
    onLoopToggle: () => void;
    onSkipStart: () => void;
    onSkipEnd: () => void;
    setBpm: (bpm: number) => void;
    setMasterTranspose: (semitones: number) => void;
    onExport: () => void;
    setScaleRoot?: (root: number) => void;
    setScaleType?: (type: string) => void;
    projectName?: string;
    selectedTrackName?: string | null;
    selectedTrackPunchRange?: PunchRange | null;
    onSelectedTrackPunchUpdate?: (updates: Partial<PunchRange>) => void;
}

const Transport: React.FC<TransportProps> = React.memo(({
    transport,
    // midiDevices, // Unused
    onPlay,
    onPause,
    onStop,
    onRecordToggle,
    onLoopToggle,
    onSkipStart,
    onSkipEnd,
    setBpm,
    setMasterTranspose,
    onExport,
    selectedTrackName,
    selectedTrackPunchRange,
    onSelectedTrackPunchUpdate
}) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const frequencyDataRef = useRef<Uint8Array | null>(null);
    const visualizerCanvasMetricsRef = useRef<{ width: number; height: number; dpr: number }>({
        width: 0,
        height: 0,
        dpr: 1
    });
    const windowActionLockRef = useRef(false);
    const breathResetTimerRef = useRef<number | null>(null);
    const [cpuLoad, setCpuLoad] = useState(0);
    const [isMaximized, setIsMaximized] = useState(false);
    const [windowControlPulse, setWindowControlPulse] = useState<'min' | 'max' | 'close' | null>(null);
    const [logoBreathing, setLogoBreathing] = useState(false);
    const [showPunchPanel, setShowPunchPanel] = useState(false);
    const punchPanelRef = useRef<HTMLDivElement>(null);
    const triggerLogoBreath = useCallback((durationMs: number) => {
        setLogoBreathing(true);
        if (breathResetTimerRef.current) {
            window.clearTimeout(breathResetTimerRef.current);
        }
        breathResetTimerRef.current = window.setTimeout(() => {
            setLogoBreathing(false);
            breathResetTimerRef.current = null;
        }, durationMs);
    }, []);

    const transportVisualActive = transport.isPlaying || transport.isRecording;

    useEffect(() => {
        let lastTime = performance.now();
        const smoothingFactor = 0.92;
        const interval = transportVisualActive ? 750 : 1400;

        const timer = window.setInterval(() => {
            const now = performance.now();
            const delta = now - lastTime;
            lastTime = now;
            const expected = interval;
            const excess = Math.max(0, delta - expected);
            const instantLoad = Math.min(100, (excess / Math.max(1, expected)) * 100);
            const baseAudioLoad = transportVisualActive ? 9.5 : 0.4;
            setCpuLoad((prev) => {
                const next = (prev * smoothingFactor) + ((instantLoad + baseAudioLoad) * (1 - smoothingFactor));
                return Math.abs(next - prev) < 0.35 ? prev : next;
            });
        }, interval);

        return () => window.clearInterval(timer);
    }, [transportVisualActive]);

    useEffect(() => {
        let animationFrame: number;
        let lastFrameTime = 0;

        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) return;

        const ensureCanvasResolution = () => {
            const cssWidth = Math.max(1, Math.round(canvas.clientWidth || 1));
            const cssHeight = Math.max(1, Math.round(canvas.clientHeight || 1));
            const dpr = typeof window !== 'undefined' ? Math.max(1, Math.min(2, window.devicePixelRatio || 1)) : 1;
            const nextWidth = Math.max(1, Math.round(cssWidth * dpr));
            const nextHeight = Math.max(1, Math.round(cssHeight * dpr));
            const metrics = visualizerCanvasMetricsRef.current;

            if (metrics.width !== nextWidth || metrics.height !== nextHeight || metrics.dpr !== dpr) {
                canvas.width = nextWidth;
                canvas.height = nextHeight;
                visualizerCanvasMetricsRef.current = { width: nextWidth, height: nextHeight, dpr };
            }

            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            return { width: cssWidth, height: cssHeight };
        };

        const drawFrame = (active: boolean) => {
            const { width, height } = ensureCanvasResolution();
            const data = audioEngine.getFrequencyDataInto(frequencyDataRef.current || undefined);
            if (frequencyDataRef.current !== data) {
                frequencyDataRef.current = data;
            }

            ctx.fillStyle = '#0a0a0a';
            ctx.fillRect(0, 0, width, height);

            ctx.fillStyle = 'rgba(168, 85, 247, 0.03)';
            for (let i = 0; i < width; i += 4) ctx.fillRect(i, 0, 1, height);

            const gradient = ctx.createLinearGradient(0, 0, 0, height);
            gradient.addColorStop(0, '#ffffff');
            gradient.addColorStop(0.2, '#f43f5e');
            gradient.addColorStop(0.7, '#a855f7');
            gradient.addColorStop(1, 'rgba(168, 85, 247, 0.05)');
            ctx.fillStyle = gradient;

            ctx.beginPath();
            const visibleBins = Math.max(1, Math.floor(active ? data.length * 0.72 : data.length * 0.36));
            const sliceWidth = width * 1.0 / Math.max(1, visibleBins);
            let x = 0;
            ctx.moveTo(0, height);
            for (let i = 0; i < visibleBins; i++) {
                const raw = data[i] ?? 0;
                const intensity = active ? raw : raw * 0.24;
                const y = height - ((intensity / 255.0) * height);
                ctx.lineTo(x, y);
                x += sliceWidth;
            }
            ctx.lineTo(width, height); ctx.lineTo(0, height); ctx.fill();

            ctx.strokeStyle = active ? 'rgba(244, 63, 94, 0.88)' : 'rgba(168, 85, 247, 0.68)';
            ctx.lineWidth = active ? 1.15 : 0.9;
            ctx.beginPath();
            x = 0;
            for (let i = 0; i < visibleBins; i++) {
                const raw = data[i] ?? 0;
                const intensity = active ? raw : raw * 0.24;
                const y = height - ((intensity / 255.0) * height);
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
                x += sliceWidth;
            }
            ctx.stroke();
        };

        const render = (time: number) => {
            const targetFps = transportVisualActive ? 45 : 12;
            const minFrameDelta = 1000 / targetFps;
            if (time - lastFrameTime < minFrameDelta) {
                animationFrame = requestAnimationFrame(render);
                return;
            }
            lastFrameTime = time;
            drawFrame(transportVisualActive);
            animationFrame = requestAnimationFrame(render);
        };

        drawFrame(transportVisualActive);
        animationFrame = requestAnimationFrame(render);
        return () => cancelAnimationFrame(animationFrame);
    }, [transportVisualActive]);

    const handleGlobalReset = () => { setBpm(124); setMasterTranspose(0); };
    const buttonClass = "daw-transport-action w-9 h-7 flex items-center justify-center rounded-[2px] border border-transparent transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-daw-cyan/70 motion-reduce:transition-none";
    const inactiveClass = "bg-[#2d2d2d] text-gray-400 hover:bg-[#3d3d3d] hover:text-gray-200";
    const engineIsPlaying = audioEngine.getIsPlaying();
    const hasResumeOffset = audioEngine.getCurrentTime() > 0.0001;
    const fallbackPosition = {
        currentBar: transport.currentBar,
        currentBeat: transport.currentBeat,
        currentSixteenth: transport.currentSixteenth
    };
    const isPlaybackActive = transport.isPlaying;
    const isPaused = !transport.isPlaying && !transport.isRecording && !engineIsPlaying && hasResumeOffset;
    const isStopped = !transport.isPlaying && !transport.isRecording && !engineIsPlaying && !hasResumeOffset;
    const isLoopEnabled = transport.loopMode !== 'off';
    const loopBadge = transport.loopMode === 'once' ? '1' : transport.loopMode === 'infinite' ? '∞' : '';
    const loopTitle = transport.loopMode === 'off'
        ? 'Bucle: Desactivado'
        : transport.loopMode === 'once'
            ? 'Bucle: Repetir una vez'
            : 'Bucle: Repetición infinita';
    const semitoneStep = Math.max(-12, Math.min(12, Math.round(transport.masterTranspose)));
    const pitchTempoMultiplier = Math.pow(2, semitoneStep / 12);
    const effectiveBpmExact = transport.bpm * pitchTempoMultiplier;
    const displayedBpm = Math.round(effectiveBpmExact);
    const bpmMin = Math.round(20 * pitchTempoMultiplier);
    const bpmMax = Math.round(999 * pitchTempoMultiplier);
    const punchRange = selectedTrackPunchRange || {
        enabled: false,
        inBar: 1,
        outBar: 2,
        preRollBars: 1,
        countInBars: 0
    };
    const canEditPunch = Boolean(onSelectedTrackPunchUpdate && selectedTrackName);
    const punchInBar = Math.max(1, punchRange.inBar);
    const punchOutBar = Math.max(punchInBar + 0.25, punchRange.outBar);
    const preRollBars = Math.max(0, punchRange.preRollBars || 0);
    const countInBars = Math.max(0, punchRange.countInBars || 0);

    const handleDisplayedBpmChange = (newDisplayedBpm: number) => {
        const quantizedBpm = Math.round(newDisplayedBpm);
        const clampedBpm = Math.max(bpmMin, Math.min(bpmMax, quantizedBpm));
        const normalizedBpm = clampedBpm / pitchTempoMultiplier;
        setBpm(normalizedBpm);
    };

    const applyPunchUpdate = useCallback((updates: Partial<PunchRange>) => {
        if (!onSelectedTrackPunchUpdate || !selectedTrackName) return;
        onSelectedTrackPunchUpdate(updates);
    }, [onSelectedTrackPunchUpdate, selectedTrackName]);

    const isDesktop = platformService.isDesktop;

    useEffect(() => {
        if (!isDesktop) return;

        let mounted = true;

        platformService.getWindowState().then((state) => {
            if (!mounted || !state) return;
            setIsMaximized(state.isMaximized || state.isFullScreen);
        });

        const unsubscribe = platformService.onWindowStateChange((state) => {
            setIsMaximized(state.isMaximized || state.isFullScreen);
        });

        return () => {
            mounted = false;
            unsubscribe();
        };
    }, [isDesktop]);

    useEffect(() => {
        if (!windowControlPulse) return;
        const timer = window.setTimeout(() => setWindowControlPulse(null), 180);
        return () => window.clearTimeout(timer);
    }, [windowControlPulse]);

    useEffect(() => {
        if (!showPunchPanel) return;

        const handleWindowPointerDown = (event: MouseEvent) => {
            const target = event.target as Node;
            if (punchPanelRef.current && !punchPanelRef.current.contains(target)) {
                setShowPunchPanel(false);
            }
        };

        window.addEventListener('mousedown', handleWindowPointerDown);
        return () => window.removeEventListener('mousedown', handleWindowPointerDown);
    }, [showPunchPanel]);

    useEffect(() => {
        let isDisposed = false;
        let triggerTimer: number | undefined;

        const scheduleBreath = () => {
            const minDelay = transport.isPlaying ? 5200 : 9800;
            const maxDelay = transport.isPlaying ? 9400 : 17600;
            const breathDuration = transport.isPlaying ? 1080 : 1500;
            const delay = Math.round(minDelay + (Math.random() * (maxDelay - minDelay)));

            triggerTimer = window.setTimeout(() => {
                if (isDisposed) return;

                triggerLogoBreath(breathDuration);
                scheduleBreath();
            }, delay);
        };

        scheduleBreath();

        return () => {
            isDisposed = true;
            if (triggerTimer) window.clearTimeout(triggerTimer);
        };
    }, [transport.isPlaying, triggerLogoBreath]);

    useEffect(() => {
        if (!transport.isPlaying && !transport.isRecording) {
            setLogoBreathing(false);
            return;
        }

        triggerLogoBreath(transport.isPlaying ? 1080 : 1320);
    }, [transport.isPlaying, transport.isRecording, triggerLogoBreath]);

    useEffect(() => {
        if (!transport.isPlaying) return;
        triggerLogoBreath(760);
    }, [transport.isPlaying, triggerLogoBreath]);

    useEffect(() => () => {
        if (breathResetTimerRef.current) {
            window.clearTimeout(breathResetTimerRef.current);
            breathResetTimerRef.current = null;
        }
    }, []);

    const handleMinimizeWindow = () => {
        if (windowActionLockRef.current) return;
        windowActionLockRef.current = true;
        setWindowControlPulse('min');
        platformService.minimize();
        window.setTimeout(() => {
            windowActionLockRef.current = false;
        }, 150);
    };

    const handleToggleMaximizeWindow = () => {
        if (windowActionLockRef.current) return;
        windowActionLockRef.current = true;
        setWindowControlPulse('max');
        platformService.maximize();
        window.setTimeout(() => {
            windowActionLockRef.current = false;
        }, 220);
    };

    const handleCloseWindow = () => {
        if (windowActionLockRef.current) return;
        windowActionLockRef.current = true;
        setWindowControlPulse('close');
        platformService.close();
    };

    const handleTransportDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
        if (!isDesktop) return;
        const target = event.target as HTMLElement;
        if (target.closest('[data-no-window-toggle="true"]')) return;
        handleToggleMaximizeWindow();
    };

    const useFastBreath = transport.isPlaying || transport.isRecording;

    return (
        <div
            className="relative h-[50px] bg-[#11131a]/92 backdrop-blur-md border-b border-white/10 flex items-center px-4 justify-between select-none z-50 text-daw-text font-sans transition-[background-color,border-color] duration-500"
            style={{ WebkitAppRegion: isDesktop ? 'drag' : 'no-drag' } as AppRegionStyle}
            onDoubleClick={handleTransportDoubleClick}
        >
            <div className="flex items-center gap-6" style={{ WebkitAppRegion: 'no-drag' } as AppRegionStyle} data-no-window-toggle="true">
                {/* BRANDING */}
                <div className="flex items-center gap-2 select-none group cursor-pointer mr-4">
                    <div className="relative w-8 h-8 flex items-center justify-center logo-breath-shell">
                        <span className={`pointer-events-none absolute -inset-[6px] rounded-full logo-breathing-aura ${logoBreathing ? `logo-breathing-aura-active ${useFastBreath ? 'logo-breathing-aura-fast' : ''}` : ''}`} />
                        <div className={`relative z-10 w-8 h-8 flex items-center justify-center logo-breathing-core ${logoBreathing ? `logo-breathing-active ${useFastBreath ? 'logo-breathing-fast' : ''}` : ''}`}>
                            <AppLogo size={28} withGlow={logoBreathing} />
                        </div>
                    </div>
                    <div className="flex flex-col justify-center items-center leading-none min-w-[108px]">
                        <span className="font-black tracking-[0.3em] text-[12px] text-white text-center">HOLLOW</span>
                        <span
                            className="inline-block text-[19px] -mt-[1px] text-transparent bg-clip-text bg-gradient-to-r from-daw-violet to-daw-ruby text-center"
                            style={{
                                fontFamily: "'Brittany', 'Brittany Signature', cursive",
                                letterSpacing: '0.01em',
                                transform: 'scaleX(1.26)',
                                transformOrigin: 'center center',
                                lineHeight: 0.9
                            }}
                        >
                            bits
                        </span>
                    </div>
                </div>

                {/* CONTROLS GROUP 1: Pitch & BPM */}
                <div className="flex items-center gap-4 border-r border-daw-border pr-4 h-8">

                    {/* PITCH KNOB */}
                    <div className="flex items-center gap-2" title="Master Pitch (Varispeed: también afecta tempo)">
                        <div className="bg-[#1a1a1a] border border-daw-border rounded-[2px] p-0.5 px-1 flex items-center justify-center shadow-inner">
                            <Knob
                                value={semitoneStep}
                                min={-12}
                                max={12}
                                size={28}
                                defaultValue={0}
                                color="#f43f5e"
                                bipolar={true}
                                onChange={(val) => setMasterTranspose(Math.round(val))}
                            />
                        </div>
                        <div className="flex flex-col justify-center">
                            <span className="text-[9px] font-bold text-daw-ruby tracking-wider">PITCH</span>
                            <span className="text-[8px] font-mono text-gray-500">
                                {semitoneStep > 0 ? '+' : ''}{semitoneStep} st
                            </span>
                        </div>
                    </div>

                    {/* BPM BOX */}
                    <div className="flex items-center gap-2">
                        <DraggableNumber
                            value={displayedBpm}
                            onChange={handleDisplayedBpmChange}
                            min={bpmMin}
                            max={bpmMax}
                            label="BPM"
                            integerOnly
                        />
                    </div>

                    {/* TIME DISPLAY */}
                    <div className="flex flex-col relative group">
                        <span className="absolute -top-2 left-1 text-[8px] font-bold text-gray-500 bg-daw-bg px-1 z-10">POSICIÓN</span>
                        <div className="h-8 px-3 bg-[#1a1a1a] border border-daw-border rounded-[2px] flex items-center justify-center min-w-[80px]">
                            <TransportPositionReadout fallbackPosition={fallbackPosition} />
                        </div>
                    </div>
                </div>

                {/* CONTROLS GROUP 2: Transport Buttons */}
                <div className="daw-transport-controls flex items-center gap-1 bg-[#1a1a1a] p-1 rounded-sm border border-[#2d2d2d]" role="group" aria-label="Controles de transporte">
                    <button
                        type="button"
                        onClick={onLoopToggle}
                        className={`${buttonClass} ${isLoopEnabled ? 'bg-daw-violet text-white shadow-[0_0_10px_rgba(168,85,247,0.5)] relative' : `${inactiveClass} relative`}`}
                        title={loopTitle}
                        aria-label={loopTitle}
                        aria-pressed={isLoopEnabled}
                        data-transport-action="loop"
                    >
                        <Repeat size={12} />
                        {loopBadge && (
                            <span className="absolute -top-1 -right-1 min-w-[12px] h-3 px-[2px] rounded-full bg-black/80 border border-daw-cyan text-[8px] leading-[10px] font-black text-daw-cyan flex items-center justify-center">
                                {loopBadge}
                            </span>
                        )}
                    </button>
                    <div className="w-px h-4 bg-[#333] mx-1"></div>

                    <button
                        type="button"
                        onClick={onSkipStart}
                        className={`${buttonClass} ${inactiveClass}`}
                        title="Volver al inicio"
                        aria-label="Volver al inicio"
                        data-transport-action="rewind"
                    >
                        <SkipBack size={12} fill="currentColor" />
                    </button>
                    <button
                        type="button"
                        onClick={onStop}
                        className={`${buttonClass} ${isStopped ? 'bg-gray-200 text-[#171717] shadow-[0_0_8px_rgba(229,231,235,0.28)]' : inactiveClass}`}
                        title="Detener y volver al inicio"
                        aria-label="Detener y volver al inicio"
                        aria-pressed={isStopped}
                        data-transport-action="stop"
                    >
                        <Square size={10} fill="currentColor" />
                    </button>

                    <button
                        type="button"
                        onClick={onPlay}
                        className={`${buttonClass} ${isPlaybackActive ? 'bg-green-600 text-white shadow-[0_0_10px_rgba(22,163,74,0.5)]' : 'bg-[#2d2d2d] text-green-500 hover:text-green-400'}`}
                        title="Reproducir"
                        aria-label="Reproducir"
                        aria-pressed={isPlaybackActive}
                        data-transport-action="play"
                    >
                        <Play size={12} fill="currentColor" />
                    </button>

                    <button
                        type="button"
                        onClick={onPause}
                        className={`${buttonClass} ${isPaused ? 'bg-yellow-600 text-white shadow-[0_0_10px_rgba(202,138,4,0.5)]' : inactiveClass}`}
                        title="Pausar"
                        aria-label="Pausar"
                        aria-pressed={isPaused}
                        data-transport-action="pause"
                    >
                        <Pause size={12} fill="currentColor" />
                    </button>

                    <button type="button" onClick={onSkipEnd} className={`${buttonClass} ${inactiveClass}`} title="Ir al final" aria-label="Ir al final" data-transport-action="skip-end"><SkipForward size={12} fill="currentColor" /></button>

                    <div className="w-px h-4 bg-[#333] mx-1"></div>
                    <button
                        type="button"
                        onClick={onRecordToggle}
                        className={`${buttonClass} ${transport.isRecording ? 'bg-daw-ruby text-white animate-pulse shadow-[0_0_10px_rgba(244,63,94,0.5)]' : 'bg-[#2d2d2d] text-daw-ruby hover:text-red-400'}`}
                        title="Grabar"
                        aria-label="Grabar"
                        aria-pressed={transport.isRecording}
                        data-transport-action="record"
                    >
                        <Circle size={10} fill="currentColor" />
                    </button>

                    <div className="relative ml-1" ref={punchPanelRef}>
                        <button
                            type="button"
                            onClick={() => setShowPunchPanel((prev) => !prev)}
                            className={`${buttonClass} ${punchRange.enabled ? 'bg-daw-violet text-white shadow-[0_0_10px_rgba(168,85,247,0.5)]' : inactiveClass}`}
                            title="Panel Punch In/Out"
                            aria-label="Abrir panel Punch In/Out"
                            aria-expanded={showPunchPanel}
                            data-transport-action="punch"
                        >
                            P
                        </button>

                        {showPunchPanel && (
                            <div className="absolute top-[calc(100%+8px)] left-0 w-[288px] rounded-sm border border-daw-border bg-[#0b0d13]/98 backdrop-blur-md shadow-[0_16px_34px_rgba(0,0,0,0.55)] z-[220] p-2.5">
                                <div className="flex items-center justify-between gap-2">
                                    <div className="min-w-0">
                                        <div className="text-[10px] font-black uppercase tracking-wider text-daw-violet">Punch Pro</div>
                                        <div className="text-[10px] text-gray-400 truncate">
                                            {selectedTrackName ? `Track: ${selectedTrackName}` : 'Selecciona una pista de audio'}
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => applyPunchUpdate({ enabled: !punchRange.enabled })}
                                        disabled={!canEditPunch}
                                        className={`h-6 px-2 rounded-[2px] text-[9px] font-bold uppercase border transition-colors ${punchRange.enabled ? 'bg-daw-violet/25 text-daw-violet border-daw-violet/60' : 'bg-[#1f2027] text-gray-400 border-[#2f3340]'} ${!canEditPunch ? 'opacity-40 cursor-not-allowed' : ''}`}
                                    >
                                        {punchRange.enabled ? 'ON' : 'OFF'}
                                    </button>
                                </div>

                                <div className="mt-2 grid grid-cols-1 gap-1.5">
                                    <PunchField
                                        label="IN"
                                        value={punchInBar}
                                        min={1}
                                        max={999}
                                        step={0.25}
                                        decimals={2}
                                        disabled={!canEditPunch}
                                        onChange={(value) => applyPunchUpdate({
                                            enabled: true,
                                            inBar: value,
                                            outBar: Math.max(punchOutBar, value + 0.25)
                                        })}
                                    />
                                    <PunchField
                                        label="OUT"
                                        value={punchOutBar}
                                        min={1.25}
                                        max={1000}
                                        step={0.25}
                                        decimals={2}
                                        disabled={!canEditPunch}
                                        onChange={(value) => applyPunchUpdate({
                                            enabled: true,
                                            inBar: Math.min(punchInBar, value - 0.25),
                                            outBar: value
                                        })}
                                    />
                                    <PunchField
                                        label="PRE"
                                        value={preRollBars}
                                        min={0}
                                        max={16}
                                        step={0.25}
                                        decimals={2}
                                        disabled={!canEditPunch}
                                        onChange={(value) => applyPunchUpdate({
                                            preRollBars: value
                                        })}
                                    />
                                    <PunchField
                                        label="COUNT"
                                        value={countInBars}
                                        min={0}
                                        max={8}
                                        step={1}
                                        decimals={0}
                                        disabled={!canEditPunch}
                                        onChange={(value) => applyPunchUpdate({
                                            countInBars: Math.max(0, Math.round(value))
                                        })}
                                    />
                                </div>

                                <div className="mt-2 text-[9px] text-gray-500 leading-snug">
                                    Atajos: <span className="text-gray-300 font-mono">Alt+P</span> toggle, <span className="text-gray-300 font-mono">Alt+I</span> Punch In, <span className="text-gray-300 font-mono">Alt+O</span> Punch Out.
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* CENTER: VISUALIZER */}
            <div className="flex-1 max-w-[400px] h-[32px] mx-4 bg-[#050505] border border-gray-800 relative rounded-[2px] overflow-hidden opacity-80">
                <canvas ref={canvasRef} className="w-full h-full" />
            </div>

            {/* RIGHT: SYSTEM & EXPORT */}
            <div className="flex items-center gap-4 border-l border-daw-border pl-4 h-8" style={{ WebkitAppRegion: 'no-drag' } as AppRegionStyle} data-no-window-toggle="true">
                <div className="flex flex-col items-end justify-center">
                    <div className="w-12 h-1.5 bg-[#111] border border-gray-700 rounded-[1px] overflow-hidden">
                        <div className="h-full bg-gray-400" style={{ width: `${Math.min(100, cpuLoad)}%`, backgroundColor: cpuLoad > 50 ? '#f43f5e' : '#a855f7' }}></div>
                    </div>
                    <div className="flex items-center gap-1 mt-0.5">
                        <Activity size={8} className="text-gray-600" />
                        <span className="text-[8px] font-mono text-gray-500">{Math.round(cpuLoad)}% CPU</span>
                    </div>
                </div>

                <div className="h-6 w-px bg-[#333]"></div>

                <div className="flex items-center gap-2">
                    <button onClick={handleGlobalReset} className="w-6 h-6 flex items-center justify-center text-gray-500 hover:text-white" title="Resetear Transporte"><RotateCcw size={14} /></button>
                    <button onClick={onExport} className="flex items-center gap-2 text-gray-300 hover:text-white transition-all px-3 py-1.5 bg-gradient-to-r from-[#2d2d2d] to-[#222] hover:from-daw-violet/20 hover:to-daw-ruby/20 rounded-[2px] border border-daw-border hover:border-daw-violet shadow-sm">
                        <Download size={12} />
                        <span className="text-[10px] font-bold uppercase tracking-wider">Exportar</span>
                    </button>
                </div>

                {isDesktop && (
                    <>
                        <div className="h-6 w-px bg-[#333]"></div>
                        <div className="flex h-7 border border-white/10 rounded-[2px] overflow-hidden bg-[#101218] shadow-[0_0_0_1px_rgba(255,255,255,0.03)]" data-window-controls>
                            <button
                                onClick={handleMinimizeWindow}
                                className={`window-control-btn w-8 h-full flex items-center justify-center text-gray-500 hover:text-white hover:bg-white/10 transition-[transform,background-color,color,opacity] duration-150 active:scale-95 ${windowControlPulse === 'min' ? 'scale-95 bg-white/10 text-white' : ''}`}
                                title="Minimizar"
                            >
                                <Minus size={12} />
                            </button>
                            <button
                                onClick={handleToggleMaximizeWindow}
                                className={`window-control-btn w-8 h-full flex items-center justify-center text-gray-500 hover:text-white hover:bg-white/10 transition-[transform,background-color,color,opacity] duration-150 active:scale-95 ${windowControlPulse === 'max' ? 'scale-95 bg-white/10 text-white' : ''}`}
                                title={isMaximized ? 'Restaurar' : 'Maximizar'}
                            >
                                {isMaximized ? <Minimize2 size={10} /> : <Maximize2 size={10} />}
                            </button>
                            <button
                                onClick={handleCloseWindow}
                                className={`window-control-btn w-8 h-full flex items-center justify-center text-gray-500 hover:text-white hover:bg-daw-ruby transition-[transform,background-color,color,opacity] duration-150 active:scale-95 ${windowControlPulse === 'close' ? 'scale-95 bg-daw-ruby text-white' : ''}`}
                                title="Cerrar"
                            >
                                <X size={12} />
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
});

export default Transport;
