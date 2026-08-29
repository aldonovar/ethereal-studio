import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, RotateCcw, SkipBack, SkipForward, Volume2 } from 'lucide-react';
import { DetectedMidiNote } from '../services/noteScannerService';
import { audioEngine } from '../services/audioEngine';
import { proPianoEngine } from '../services/proPianoEngine';
import {
    buildSynthesiaPitchViewport,
    midiNoteLabel,
    normalizePianoPitch
} from '../services/synthesiaLayoutService';

interface SynthesiaVisualizerProps {
    notes: DetectedMidiNote[];
    bpm: number;
    accentColor?: string;
    height?: number;
}

interface TimedNote {
    id: number;
    pitch: number;
    velocity: number;
    confidence: number;
    frequency: number;
    startSec: number;
    endSec: number;
}

interface WhiteKey {
    pitch: number;
    index: number;
}

interface BlackKey {
    pitch: number;
    anchor: number;
}

const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const PLUM = { r: 168, g: 124, b: 232 };
const ROSE = { r: 236, g: 112, b: 152 };
const PIANO_MIN_MIDI = 21;
const PIANO_MAX_MIDI = 108;
const LOCAL_BPM_MIN = 40;
const LOCAL_BPM_MAX = 240;

const clamp = (value: number, min: number, max: number): number => {
    return Math.min(max, Math.max(min, value));
};

const pitchToFrequency = (pitch: number): number => {
    return 440 * Math.pow(2, (pitch - 69) / 12);
};

const mixChannel = (start: number, end: number, amount: number): number => {
    return Math.round(start + ((end - start) * amount));
};

const pitchColor = (pitch: number, minPitch: number, maxPitch: number, confidence: number): string => {
    const range = Math.max(1, maxPitch - minPitch);
    const pitchT = (pitch - minPitch) / range;
    const confidenceT = clamp(confidence, 0, 1);
    const colorT = clamp((pitchT * 0.65) + (confidenceT * 0.35), 0, 1);

    const r = mixChannel(PLUM.r, ROSE.r, colorT);
    const g = mixChannel(PLUM.g, ROSE.g, colorT);
    const b = mixChannel(PLUM.b, ROSE.b, colorT);
    return `rgb(${r} ${g} ${b})`;
};

const createRoomImpulse = (ctx: AudioContext, seconds: number, decay: number): AudioBuffer => {
    const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const impulse = ctx.createBuffer(2, length, ctx.sampleRate);

    for (let channel = 0; channel < 2; channel++) {
        const data = impulse.getChannelData(channel);
        for (let i = 0; i < length; i++) {
            const t = i / length;
            const env = Math.pow(1 - t, decay);
            const noise = (Math.random() * 2) - 1;
            data[i] = noise * env * (0.9 - (channel * 0.08));
        }
    }

    return impulse;
};

const SynthesiaVisualizer: React.FC<SynthesiaVisualizerProps> = ({
    notes,
    bpm,
    accentColor = '#a855f7',
    height = 560
}) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const timelineTrackRef = useRef<HTMLDivElement>(null);
    const frameRef = useRef<number | null>(null);
    const schedulerRef = useRef<number | null>(null);
    const lastTimeRef = useRef<number | null>(null);
    const playheadRef = useRef(0);
    const scheduledNotesRef = useRef<Set<number>>(new Set());
    const isScrubbingRef = useRef(false);
    const previewBusRef = useRef<GainNode | null>(null);
    const previewNodesRef = useRef<AudioNode[]>([]);
    const pianoReadyRef = useRef(false);
    const pianoLoadPromiseRef = useRef<Promise<void> | null>(null);

    const [isPlaying, setIsPlaying] = useState(false);
    const [isScrubbing, setIsScrubbing] = useState(false);
    const [playheadSeconds, setPlayheadSeconds] = useState(0);
    const [pianoError, setPianoError] = useState<string | null>(null);
    const [pianoEngineLabel, setPianoEngineLabel] = useState<'CONCERT GRAND HQ' | 'CARGANDO'>('CARGANDO');
    const [localBpm, setLocalBpm] = useState(() => clamp(Math.round(bpm), LOCAL_BPM_MIN, LOCAL_BPM_MAX));
    const [tempoEdited, setTempoEdited] = useState(false);
    const [jumpBarInput, setJumpBarInput] = useState('1');

    const tempoSeekRatioRef = useRef<number | null>(null);

    const secondsPer16th = useMemo(() => (60 / localBpm) / 4, [localBpm]);
    const keyboardHeight = 68;
    const blackKeyHeight = Math.round(keyboardHeight * 0.66);
    const noteCanvasHeight = Math.max(300, Math.min(480, height - 180));

    useEffect(() => {
        if (tempoEdited) return;
        setLocalBpm(clamp(Math.round(bpm), LOCAL_BPM_MIN, LOCAL_BPM_MAX));
    }, [bpm, tempoEdited]);

    const totalTimeline16th = useMemo(() => {
        if (notes.length === 0) return 16;
        return Math.max(16, ...notes.map((note) => note.start + note.duration));
    }, [notes]);

    const totalDurationSeconds = useMemo(() => {
        return Math.max(1, totalTimeline16th * secondsPer16th);
    }, [secondsPer16th, totalTimeline16th]);

    const totalBars = useMemo(() => Math.max(1, Math.ceil(totalTimeline16th / 16)), [totalTimeline16th]);

    const currentTimeline16th = useMemo(() => {
        return clamp(playheadSeconds / Math.max(0.0001, secondsPer16th), 0, totalTimeline16th);
    }, [playheadSeconds, secondsPer16th, totalTimeline16th]);

    const currentBar = Math.floor(currentTimeline16th / 16) + 1;
    const currentBeat = Math.floor((currentTimeline16th % 16) / 4) + 1;
    const currentSixteenth = Math.floor(currentTimeline16th % 4) + 1;

    const timelineNotes = useMemo<TimedNote[]>(() => {
        return notes
            .map((note, id) => {
                const pitch = normalizePianoPitch(note.pitch);
                if (pitch === null) return null;
                const startSec = note.start * secondsPer16th;
                const endSec = (note.start + note.duration) * secondsPer16th;
                return {
                    id,
                    pitch,
                    velocity: note.velocity,
                    confidence: note.confidence,
                    frequency: note.frequency || pitchToFrequency(note.pitch),
                    startSec,
                    endSec
                };
            })
            .filter((note): note is TimedNote => note !== null)
            .sort((a, b) => a.startSec - b.startSec || b.pitch - a.pitch);
    }, [notes, secondsPer16th]);

    const noteTimelineSignature = useMemo(
        () => notes.map((note) => `${note.pitch}:${note.start.toFixed(4)}:${note.duration.toFixed(4)}`).join('|'),
        [notes]
    );

    const pitchViewport = useMemo(() => buildSynthesiaPitchViewport(notes), [notes]);
    const minPitch = pitchViewport.minPitch;
    const maxPitch = pitchViewport.maxPitch;

    const keyboardLayout = useMemo(() => {
        const whiteKeys: WhiteKey[] = [];
        const blackKeys: BlackKey[] = [];
        const centerByPitch = new Map<number, number>();
        let whiteCount = 0;

        for (let pitch = minPitch; pitch <= maxPitch; pitch++) {
            if (BLACK_KEYS.has(pitch % 12)) {
                blackKeys.push({ pitch, anchor: whiteCount });
                continue;
            }

            whiteKeys.push({ pitch, index: whiteCount });
            whiteCount += 1;
        }

        const safeWhiteCount = Math.max(2, whiteCount);
        whiteKeys.forEach((key) => {
            centerByPitch.set(key.pitch, (key.index + 0.5) / safeWhiteCount);
        });
        blackKeys.forEach((key) => {
            centerByPitch.set(key.pitch, clamp(key.anchor / safeWhiteCount, 0.02, 0.98));
        });

        return {
            whiteKeys,
            blackKeys,
            whiteCount: safeWhiteCount,
            centerByPitch
        };
    }, [minPitch, maxPitch]);

    const activePitches = useMemo(() => {
        const set = new Set<number>();
        timelineNotes.forEach((note) => {
            if (playheadSeconds >= note.startSec && playheadSeconds <= note.endSec) {
                set.add(note.pitch);
            }
        });
        return set;
    }, [playheadSeconds, timelineNotes]);

    const stopAllVoices = useCallback(() => {
        const ctx = audioEngine.ctx;
        if (!ctx) return;
        proPianoEngine.allNotesOff(ctx.currentTime);
        proPianoEngine.setSustain(false, ctx.currentTime);
    }, []);

    const resetPianoEngineState = useCallback(() => {
        stopAllVoices();
        pianoReadyRef.current = false;
        setPianoEngineLabel('CARGANDO');
    }, [stopAllVoices]);

    const ensurePreviewBus = useCallback((): GainNode => {
        const ctx = audioEngine.getContext();
        if (previewBusRef.current && previewBusRef.current.context === ctx) {
            return previewBusRef.current;
        }

        previewNodesRef.current.forEach((node) => {
            try {
                node.disconnect();
            } catch {
                // ignore graph cleanup races
            }
        });
        previewNodesRef.current = [];

        const busGain = ctx.createGain();
        const highpass = ctx.createBiquadFilter();
        const body = ctx.createBiquadFilter();
        const presence = ctx.createBiquadFilter();
        const air = ctx.createBiquadFilter();
        const dryGain = ctx.createGain();
        const reverbSend = ctx.createGain();
        const convolver = ctx.createConvolver();
        const reverbDamp = ctx.createBiquadFilter();
        const reverbLowCut = ctx.createBiquadFilter();
        const reverbGain = ctx.createGain();
        const compressor = ctx.createDynamicsCompressor();
        const output = ctx.createGain();

        busGain.gain.value = 0.58;

        highpass.type = 'highpass';
        highpass.frequency.value = 27;
        highpass.Q.value = 0.72;

        body.type = 'lowshelf';
        body.frequency.value = 170;
        body.gain.value = 0.8;

        presence.type = 'peaking';
        presence.frequency.value = 2650;
        presence.Q.value = 0.92;
        presence.gain.value = -0.2;

        air.type = 'highshelf';
        air.frequency.value = 7300;
        air.gain.value = -1.2;

        dryGain.gain.value = 0.96;
        reverbSend.gain.value = 0.065;

        convolver.buffer = createRoomImpulse(ctx, 2.8, 2.15);

        reverbDamp.type = 'lowpass';
        reverbDamp.frequency.value = 5600;
        reverbDamp.Q.value = 0.45;

        reverbLowCut.type = 'highpass';
        reverbLowCut.frequency.value = 150;
        reverbLowCut.Q.value = 0.55;

        reverbGain.gain.value = 0.48;

        compressor.threshold.value = -16;
        compressor.knee.value = 6;
        compressor.ratio.value = 1.22;
        compressor.attack.value = 0.015;
        compressor.release.value = 0.18;

        output.gain.value = 0.52;

        busGain.connect(highpass);
        highpass.connect(body);
        body.connect(presence);
        presence.connect(air);

        air.connect(dryGain);
        dryGain.connect(compressor);

        air.connect(reverbSend);
        reverbSend.connect(convolver);
        convolver.connect(reverbDamp);
        reverbDamp.connect(reverbLowCut);
        reverbLowCut.connect(reverbGain);
        reverbGain.connect(compressor);

        compressor.connect(output);
        output.connect(ctx.destination);

        previewNodesRef.current = [
            busGain,
            highpass,
            body,
            presence,
            air,
            dryGain,
            reverbSend,
            convolver,
            reverbDamp,
            reverbLowCut,
            reverbGain,
            compressor,
            output
        ];

        previewBusRef.current = busGain;
        return busGain;
    }, []);

    const ensurePianoEngine = useCallback(async (): Promise<void> => {
        if (pianoReadyRef.current) return;
        if (pianoLoadPromiseRef.current) {
            await pianoLoadPromiseRef.current;
            return;
        }

        pianoLoadPromiseRef.current = (async () => {
            const ctx = audioEngine.getContext();
            const bus = ensurePreviewBus();
            setPianoEngineLabel('CARGANDO');

            await proPianoEngine.ensureReady({
                context: ctx,
                destination: bus
            });
            proPianoEngine.setConcertGrandNatural(ctx.currentTime);

            pianoReadyRef.current = true;
            setPianoError(null);
            setPianoEngineLabel('CONCERT GRAND HQ');
        })();

        try {
            await pianoLoadPromiseRef.current;
        } catch (error) {
            const message = error instanceof Error
                ? error.message
                : 'No se pudo inicializar el motor fisico de piano.';
            setPianoError(message);
            pianoReadyRef.current = false;
            throw error;
        } finally {
            pianoLoadPromiseRef.current = null;
        }
    }, [ensurePreviewBus]);

    const scheduleVoice = useCallback((note: TimedNote, delaySeconds: number) => {
        const ctx = audioEngine.getContext();
        const startAt = ctx.currentTime + Math.max(0, delaySeconds);
        const baseDuration = Math.max(0.11, note.endSec - note.startSec);
        const velocityNorm = clamp(note.velocity / 127, 0, 1);
        const confidenceT = clamp(note.confidence, 0, 1);
        const pitch = clamp(Math.round(note.pitch), PIANO_MIN_MIDI, PIANO_MAX_MIDI);

        const velocity = clamp(
            (velocityNorm * 0.72)
            + (confidenceT * 0.06)
            + 0.07
            + ((Math.random() - 0.5) * 0.008),
            0.04,
            1
        );

        const duration = baseDuration + clamp(
            0.14 + (velocityNorm * 0.32) + (confidenceT * 0.08),
            0.14,
            1
        );

        proPianoEngine.scheduleNote({
            note: pitch,
            velocity,
            confidence: confidenceT,
            when: startAt,
            duration
        });
    }, []);

    const resetPreview = useCallback(() => {
        setPlayheadSeconds(0);
        setIsPlaying(false);
        playheadRef.current = 0;
        scheduledNotesRef.current = new Set();
        stopAllVoices();
    }, [stopAllVoices]);

    const primeScheduledNotesAt = useCallback((seconds: number) => {
        const alreadyPassed = new Set<number>();
        timelineNotes.forEach((note) => {
            if (note.startSec < seconds - 0.001) {
                alreadyPassed.add(note.id);
            }
        });
        scheduledNotesRef.current = alreadyPassed;
    }, [timelineNotes]);

    const seekToSeconds = useCallback((seconds: number) => {
        const clampedSeconds = clamp(seconds, 0, totalDurationSeconds);
        setPlayheadSeconds(clampedSeconds);
        playheadRef.current = clampedSeconds;
        primeScheduledNotesAt(clampedSeconds);
        stopAllVoices();
    }, [primeScheduledNotesAt, stopAllVoices, totalDurationSeconds]);

    const seekToBar = useCallback((bar: number) => {
        const safeBar = Math.round(clamp(bar, 1, totalBars));
        const target16th = (safeBar - 1) * 16;
        seekToSeconds(target16th * secondsPer16th);
    }, [secondsPer16th, seekToSeconds, totalBars]);

    const handleLocalBpmChange = useCallback((nextBpm: number) => {
        const safeBpm = Math.round(clamp(nextBpm, LOCAL_BPM_MIN, LOCAL_BPM_MAX));
        if (safeBpm === localBpm) return;

        tempoSeekRatioRef.current = clamp(playheadRef.current / Math.max(0.0001, totalDurationSeconds), 0, 1);
        setLocalBpm(safeBpm);
        setTempoEdited(true);
    }, [localBpm, totalDurationSeconds]);

    const handleJumpBar = useCallback(() => {
        const parsed = Number.parseInt(jumpBarInput, 10);
        if (!Number.isFinite(parsed)) return;
        const safeBar = Math.round(clamp(parsed, 1, totalBars));
        seekToBar(safeBar);
        setJumpBarInput(String(safeBar));
    }, [jumpBarInput, seekToBar, totalBars]);

    const jumpToStart = useCallback(() => {
        seekToSeconds(0);
    }, [seekToSeconds]);

    const jumpToEnd = useCallback(() => {
        seekToSeconds(totalDurationSeconds);
        setIsPlaying(false);
    }, [seekToSeconds, totalDurationSeconds]);

    const replayFromStart = useCallback(() => {
        seekToSeconds(0);
        setIsPlaying(true);
    }, [seekToSeconds]);

    const timelineOverviewNotes = useMemo(() => {
        if (timelineNotes.length === 0 || totalDurationSeconds <= 0) return [];

        return timelineNotes.map((note) => {
            const leftPct = clamp((note.startSec / totalDurationSeconds) * 100, 0, 100);
            const widthPct = Math.max(0.2, ((note.endSec - note.startSec) / totalDurationSeconds) * 100);
            const pitchT = clamp((note.pitch - minPitch) / Math.max(1, maxPitch - minPitch), 0, 1);

            return {
                id: note.id,
                leftPct,
                widthPct,
                topPct: 100 - (pitchT * 100),
                color: pitchColor(note.pitch, minPitch, maxPitch, note.confidence),
                alpha: clamp(0.35 + (note.confidence * 0.55), 0.25, 0.95)
            };
        });
    }, [maxPitch, minPitch, timelineNotes, totalDurationSeconds]);

    const seekFromClientX = useCallback((clientX: number) => {
        const node = timelineTrackRef.current;
        if (!node || totalDurationSeconds <= 0) return;
        const rect = node.getBoundingClientRect();
        const ratio = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
        seekToSeconds(ratio * totalDurationSeconds);
    }, [seekToSeconds, totalDurationSeconds]);

    const handleTimelinePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (timelineNotes.length === 0) return;
        isScrubbingRef.current = true;
        setIsScrubbing(true);
        event.currentTarget.setPointerCapture(event.pointerId);
        seekFromClientX(event.clientX);
    }, [seekFromClientX, timelineNotes.length]);

    const handleTimelinePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (!isScrubbingRef.current) return;
        seekFromClientX(event.clientX);
    }, [seekFromClientX]);

    const handleTimelinePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (!isScrubbingRef.current) return;
        isScrubbingRef.current = false;
        setIsScrubbing(false);
        event.currentTarget.releasePointerCapture(event.pointerId);
    }, []);

    useEffect(() => {
        if (tempoSeekRatioRef.current === null) return;
        const ratio = tempoSeekRatioRef.current;
        tempoSeekRatioRef.current = null;
        seekToSeconds(totalDurationSeconds * ratio);
    }, [localBpm, seekToSeconds, totalDurationSeconds]);

    useEffect(() => {
        setJumpBarInput((previous) => {
            const parsed = Number.parseInt(previous, 10);
            if (!Number.isFinite(parsed)) return '1';
            return String(Math.round(clamp(parsed, 1, totalBars)));
        });
    }, [totalBars]);

    useEffect(() => {
        playheadRef.current = playheadSeconds;
    }, [playheadSeconds]);

    useEffect(() => {
        resetPianoEngineState();
        setIsPlaying(false);
    }, [noteTimelineSignature, resetPianoEngineState]);

    useEffect(() => {
        if (!isPlaying) return;

        const animate = (now: number) => {
            const last = lastTimeRef.current ?? now;
            const delta = (now - last) / 1000;
            lastTimeRef.current = now;

            setPlayheadSeconds((prev) => {
                const next = prev + delta;
                if (next >= totalDurationSeconds) {
                    setIsPlaying(false);
                    return totalDurationSeconds;
                }
                return next;
            });

            frameRef.current = requestAnimationFrame(animate);
        };

        frameRef.current = requestAnimationFrame(animate);

        return () => {
            if (frameRef.current) {
                cancelAnimationFrame(frameRef.current);
                frameRef.current = null;
            }
            lastTimeRef.current = null;
        };
    }, [isPlaying, totalDurationSeconds]);

    useEffect(() => {
        if (!isPlaying) {
            if (schedulerRef.current) {
                window.clearInterval(schedulerRef.current);
                schedulerRef.current = null;
            }
            stopAllVoices();
            return;
        }

        let cancelled = false;

        const bootstrapScheduler = async () => {
            try {
                const ctx = audioEngine.getContext();
                await ctx.resume();
                await ensurePianoEngine();
                if (cancelled) return;

                primeScheduledNotesAt(playheadRef.current);

                const scheduleAhead = 0.18;

                const schedulerTick = () => {
                    const nowPreview = playheadRef.current;
                    const horizon = nowPreview + scheduleAhead;

                    timelineNotes.forEach((note) => {
                        if (scheduledNotesRef.current.has(note.id)) return;
                        if (note.startSec > horizon) return;
                        if (note.endSec < nowPreview) {
                            scheduledNotesRef.current.add(note.id);
                            return;
                        }

                        const delay = note.startSec - nowPreview;
                        scheduleVoice(note, delay);
                        scheduledNotesRef.current.add(note.id);
                    });
                };

                const density = timelineNotes.length / Math.max(1, totalDurationSeconds);
                const useSustain = density < 3.6;
                proPianoEngine.setSustain(useSustain, ctx.currentTime);
                schedulerTick();
                schedulerRef.current = window.setInterval(schedulerTick, 30);
            } catch (error) {
                const message = error instanceof Error ? error.message : 'No se pudo iniciar la preescucha de piano.';
                setPianoError(message);
                setIsPlaying(false);
            }
        };

        void bootstrapScheduler();

        return () => {
            cancelled = true;
            if (schedulerRef.current) {
                window.clearInterval(schedulerRef.current);
                schedulerRef.current = null;
            }
        };
    }, [ensurePianoEngine, isPlaying, primeScheduledNotesAt, scheduleVoice, stopAllVoices, timelineNotes, totalDurationSeconds]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        const width = Math.max(1, Math.floor(rect.width));
        const visualHeight = noteCanvasHeight;

        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(visualHeight * dpr);

        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const chartTop = 10;
        const chartHeight = visualHeight - chartTop - 6;
        const lookAheadSeconds = Math.max(3, Math.min(12, totalDurationSeconds));
        const whiteKeyWidth = width / keyboardLayout.whiteCount;

        const bgGradient = ctx.createLinearGradient(0, 0, 0, visualHeight);
        bgGradient.addColorStop(0, '#15162a');
        bgGradient.addColorStop(0.5, '#111427');
        bgGradient.addColorStop(1, '#0c1220');
        ctx.fillStyle = bgGradient;
        ctx.fillRect(0, 0, width, visualHeight);

        const ambient = ctx.createRadialGradient(width * 0.7, chartTop + 20, 10, width * 0.7, chartTop + 20, width * 0.8);
        ambient.addColorStop(0, 'rgba(168,124,232,0.15)');
        ambient.addColorStop(1, 'rgba(168,124,232,0)');
        ctx.fillStyle = ambient;
        ctx.fillRect(0, chartTop, width, chartHeight);

        const warmAmbient = ctx.createRadialGradient(width * 0.22, visualHeight, 10, width * 0.22, visualHeight, width * 0.55);
        warmAmbient.addColorStop(0, 'rgba(236,112,152,0.11)');
        warmAmbient.addColorStop(1, 'rgba(236,112,152,0)');
        ctx.fillStyle = warmAmbient;
        ctx.fillRect(0, chartTop, width, chartHeight);

        for (let row = 0; row <= 9; row++) {
            const y = chartTop + (chartHeight * (row / 9));
            const strong = row === 9;
            ctx.strokeStyle = strong ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)';
            ctx.beginPath();
            ctx.moveTo(0, y + 0.5);
            ctx.lineTo(width, y + 0.5);
            ctx.stroke();
        }

        keyboardLayout.whiteKeys.forEach((key) => {
            const x = key.index * whiteKeyWidth;
            if (key.pitch % 12 === 0) {
                ctx.fillStyle = 'rgba(255,255,255,0.075)';
                ctx.fillRect(x, chartTop, 1, chartHeight);
                return;
            }

            if (key.pitch % 12 === 5) {
                ctx.fillStyle = 'rgba(255,255,255,0.03)';
                ctx.fillRect(x, chartTop, 1, chartHeight);
            }
        });

        const playLineY = chartTop + chartHeight;
        const playLineGradient = ctx.createLinearGradient(0, 0, width, 0);
        playLineGradient.addColorStop(0, 'rgba(168,124,232,0.92)');
        playLineGradient.addColorStop(1, 'rgba(236,112,152,0.9)');
        ctx.strokeStyle = playLineGradient;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(0, playLineY);
        ctx.lineTo(width, playLineY);
        ctx.stroke();
        ctx.lineWidth = 1;

        activePitches.forEach((pitch) => {
            const centerRatio = keyboardLayout.centerByPitch.get(pitch);
            if (centerRatio === undefined) return;
            const centerX = centerRatio * width;
            const beam = ctx.createLinearGradient(0, chartTop, 0, playLineY);
            beam.addColorStop(0, 'rgba(168,124,232,0)');
            beam.addColorStop(0.72, 'rgba(168,124,232,0.035)');
            beam.addColorStop(1, 'rgba(236,112,152,0.2)');
            ctx.fillStyle = beam;
            ctx.fillRect(centerX - (whiteKeyWidth * 0.46), chartTop, whiteKeyWidth * 0.92, chartHeight);
        });

        timelineNotes.forEach((note) => {
            const noteStartSec = note.startSec;
            const noteEndSec = note.endSec;
            if (noteEndSec < playheadSeconds - 0.05) return;
            if (noteStartSec > playheadSeconds + lookAheadSeconds) return;

            const futureStart = noteStartSec - playheadSeconds;
            const futureEnd = noteEndSec - playheadSeconds;

            const yBottom = playLineY - ((futureStart / lookAheadSeconds) * chartHeight);
            const yTop = playLineY - ((futureEnd / lookAheadSeconds) * chartHeight);

            const centerRatio = keyboardLayout.centerByPitch.get(note.pitch) ?? ((note.pitch - minPitch + 0.5) / Math.max(1, (maxPitch - minPitch + 1)));
            const isBlack = BLACK_KEYS.has(note.pitch % 12);
            const keyWidth = isBlack ? whiteKeyWidth * 0.58 : whiteKeyWidth * 0.88;
            const x = (centerRatio * width) - (keyWidth / 2);
            const h = Math.max(3, yBottom - yTop);
            const w = Math.max(2, keyWidth - 1);

            if (yBottom < chartTop || yTop > playLineY) return;

            const fill = pitchColor(note.pitch, minPitch, maxPitch, note.confidence);
            const gradient = ctx.createLinearGradient(x, yTop, x, yTop + h);
            gradient.addColorStop(0, 'rgba(255,255,255,0.96)');
            gradient.addColorStop(0.12, fill);
            gradient.addColorStop(1, 'rgba(9,10,15,0.5)');

            ctx.shadowColor = fill;
            ctx.shadowBlur = noteStartSec <= playheadSeconds ? 18 : 10;
            ctx.beginPath();
            ctx.roundRect(x + 0.5, yTop, w, h, Math.min(5, w * 0.22, h * 0.16));
            ctx.fillStyle = gradient;
            ctx.fill();
            ctx.strokeStyle = `rgba(255,255,255,${0.18 + (note.confidence * 0.28)})`;
            ctx.stroke();

            ctx.beginPath();
            ctx.roundRect(x + 1.5, yTop + 1, Math.max(1, w - 2), Math.max(1, Math.min(4, h * 0.09)), 2);
            ctx.fillStyle = 'rgba(255,255,255,0.42)';
            ctx.fill();
            ctx.shadowBlur = 0;

            if (w >= 18 && h >= 28) {
                ctx.fillStyle = 'rgba(255,255,255,0.78)';
                ctx.font = '600 9px ui-monospace, monospace';
                ctx.textAlign = 'center';
                ctx.fillText(midiNoteLabel(note.pitch), x + (w / 2), Math.min(yTop + 15, yTop + h - 4));
            }
        });

        activePitches.forEach((pitch) => {
            const centerRatio = keyboardLayout.centerByPitch.get(pitch);
            if (centerRatio === undefined) return;
            const x = centerRatio * width;
            const impact = ctx.createRadialGradient(x, playLineY, 0, x, playLineY, whiteKeyWidth * 1.55);
            const color = pitchColor(pitch, minPitch, maxPitch, 1);
            impact.addColorStop(0, 'rgba(255,255,255,0.94)');
            impact.addColorStop(0.14, color.replace('rgb(', 'rgba(').replace(')', ' / 0.72)'));
            impact.addColorStop(1, 'rgba(168,124,232,0)');
            ctx.fillStyle = impact;
            ctx.fillRect(x - (whiteKeyWidth * 1.6), playLineY - 24, whiteKeyWidth * 3.2, 28);
        });

        ctx.strokeStyle = accentColor;
        ctx.globalAlpha = 0.15;
        ctx.strokeRect(0.5, 0.5, Math.max(0, width - 1), Math.max(0, visualHeight - 1));
        ctx.globalAlpha = 1;
    }, [
        accentColor,
        activePitches,
        keyboardLayout.centerByPitch,
        keyboardLayout.whiteCount,
        keyboardLayout.whiteKeys,
        maxPitch,
        minPitch,
        noteCanvasHeight,
        playheadSeconds,
        timelineNotes,
        totalDurationSeconds
    ]);

    useEffect(() => {
        return () => {
            if (frameRef.current) cancelAnimationFrame(frameRef.current);
            if (schedulerRef.current) window.clearInterval(schedulerRef.current);
            stopAllVoices();

            proPianoEngine.dispose();

            if (previewBusRef.current) {
                try { previewBusRef.current.disconnect(); } catch { }
                previewBusRef.current = null;
            }

            previewNodesRef.current.forEach((node) => {
                try {
                    node.disconnect();
                } catch {
                    // ignore graph cleanup races
                }
            });
            previewNodesRef.current = [];
        };
    }, [stopAllVoices]);

    const togglePreview = () => {
        if (timelineNotes.length === 0) return;

        if (!isPlaying) {
            const ctx = audioEngine.getContext();
            void ctx.resume();
            void ensurePianoEngine();
        }

        setPianoError(null);

        if (playheadSeconds >= totalDurationSeconds - 0.02) {
            seekToSeconds(0);
        }
        setIsPlaying((prev) => !prev);
    };

    const playheadPercent = clamp((playheadSeconds / Math.max(0.0001, totalDurationSeconds)) * 100, 0, 100);
    const currentPositionLabel = `${currentBar}.${currentBeat}.${currentSixteenth}`;

    const timelineBarMarkers = useMemo(() => {
        const markerStep = totalBars > 256
            ? 16
            : totalBars > 128
                ? 8
                : totalBars > 64
                    ? 4
                    : totalBars > 32
                        ? 2
                        : 1;

        const markers: Array<{ bar: number; left: number; major: boolean }> = [];
        for (let bar = 1; bar <= totalBars; bar += markerStep) {
            const left = totalBars <= 1
                ? 0
                : ((bar - 1) / (totalBars - 1)) * 100;
            const major = (bar - 1) % 4 === 0 || bar === 1;
            markers.push({ bar, left: clamp(left, 0, 100), major });
        }
        return markers;
    }, [totalBars]);

    const timelineTickLabels = useMemo(() => {
        return [0, 0.25, 0.5, 0.75, 1].map((point) => {
            const bar = Math.round(((totalBars - 1) * point) + 1);
            return `Compas ${clamp(bar, 1, totalBars)}`;
        });
    }, [totalBars]);

    return (
        <div className="flex flex-col gap-2 h-full">
            <div className="rounded-sm border border-white/10 bg-[#0f131f] shadow-[0_18px_40px_-28px_rgba(0,0,0,0.8)] overflow-hidden">
                <div className="px-3 py-2 border-b border-white/10 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                        <div className="text-[10px] text-gray-400 uppercase tracking-wider font-bold mr-2">
                            Vista Piano Roll Polifonica
                        </div>
                        <div className="flex items-center gap-1 px-2 h-7 rounded-sm border border-daw-violet/25 bg-[#201a2b] text-[9px] uppercase tracking-wider text-daw-violet">
                            <Volume2 size={10} className="text-daw-violet" />
                            Piano {pianoEngineLabel}
                        </div>
                        <div className="flex items-center gap-1 px-2 h-7 rounded-sm border border-white/10 bg-[#171d2a] text-[9px] uppercase tracking-wider text-gray-300">
                            Motor Grand Piano Integrado
                        </div>
                        <div className="flex items-center gap-1 px-2 h-7 rounded-sm border border-white/10 bg-[#171d2a] text-[9px] uppercase tracking-wider text-gray-300">
                            Rango inteligente {pitchViewport.label}
                        </div>
                        <div className="flex items-center gap-1 px-2 h-7 rounded-sm border border-emerald-400/20 bg-emerald-400/10 text-[9px] uppercase tracking-wider text-emerald-300">
                            {pitchViewport.noteCount} notas · modo Synthesia
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                        <span className="px-2 h-7 inline-flex items-center text-[9px] uppercase tracking-wider font-bold text-gray-300 border border-white/10 rounded-sm bg-[#0f141e]">
                            Cinta de reproduccion
                        </span>
                        <button
                            onClick={jumpToStart}
                            className="w-8 h-8 rounded-sm border border-white/15 bg-[#191f2d] text-gray-300 hover:text-white hover:border-daw-violet/50 flex items-center justify-center"
                            title="Ir al inicio"
                        >
                            <SkipBack size={12} />
                        </button>

                        <button
                            onClick={togglePreview}
                            className={`h-8 px-3 rounded-sm border border-white/15 ${isPlaying ? 'bg-daw-violet/30 text-daw-violet border-daw-violet/60' : 'bg-[#191f2d] text-gray-200'} hover:text-white hover:border-daw-violet/55 flex items-center justify-center gap-1`}
                            title={isPlaying ? 'Pausar visualizacion' : 'Reproducir visualizacion'}
                        >
                            {isPlaying ? <Pause size={12} /> : <Play size={12} />}
                            <span className="text-[9px] font-bold uppercase tracking-wider">{isPlaying ? 'Pausar' : 'Play'}</span>
                        </button>

                        <button
                            onClick={jumpToEnd}
                            className="w-8 h-8 rounded-sm border border-white/15 bg-[#191f2d] text-gray-300 hover:text-white hover:border-daw-violet/50 flex items-center justify-center"
                            title="Ir al final"
                        >
                            <SkipForward size={12} />
                        </button>

                        <button
                            onClick={resetPreview}
                            className="w-8 h-8 rounded-sm border border-white/15 bg-[#191f2d] text-gray-300 hover:text-white hover:border-daw-ruby/50 flex items-center justify-center"
                            title="Detener y reiniciar"
                        >
                            <RotateCcw size={12} />
                        </button>

                        <button
                            onClick={replayFromStart}
                            className="h-8 px-2 rounded-sm border border-daw-ruby/35 bg-daw-ruby/15 text-daw-ruby hover:bg-daw-ruby/25 text-[9px] font-bold uppercase tracking-wider"
                            title="Replay desde el inicio"
                        >
                            Replay
                        </button>

                        <div className="h-8 inline-flex items-center gap-1 px-1.5 border border-white/10 rounded-sm bg-[#0f141e]">
                            <span className="text-[9px] uppercase tracking-wider text-gray-400 font-bold">Tempo</span>
                            <button
                                onClick={() => handleLocalBpmChange(localBpm - 1)}
                                className="w-6 h-6 rounded-sm border border-white/15 bg-[#191f2d] text-gray-300 hover:text-white"
                                title="Reducir BPM"
                            >
                                -
                            </button>
                            <input
                                type="number"
                                min={LOCAL_BPM_MIN}
                                max={LOCAL_BPM_MAX}
                                value={localBpm}
                                onChange={(event) => handleLocalBpmChange(Number(event.target.value || localBpm))}
                                className="w-14 h-6 bg-[#0b1118] border border-white/10 rounded-sm text-center text-[10px] font-mono text-white"
                                title="BPM local del workspace"
                            />
                            <button
                                onClick={() => handleLocalBpmChange(localBpm + 1)}
                                className="w-6 h-6 rounded-sm border border-white/15 bg-[#191f2d] text-gray-300 hover:text-white"
                                title="Aumentar BPM"
                            >
                                +
                            </button>
                        </div>

                        <div className="h-8 inline-flex items-center gap-1 px-1.5 border border-white/10 rounded-sm bg-[#0f141e]">
                            <span className="text-[9px] uppercase tracking-wider text-gray-400 font-bold">Compas</span>
                            <input
                                type="number"
                                min={1}
                                max={totalBars}
                                value={jumpBarInput}
                                onChange={(event) => setJumpBarInput(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter') {
                                        handleJumpBar();
                                    }
                                }}
                                className="w-14 h-6 bg-[#0b1118] border border-white/10 rounded-sm text-center text-[10px] font-mono text-white"
                                title="Saltar a compas"
                            />
                            <span className="text-[9px] font-mono text-gray-500">/ {totalBars}</span>
                            <button
                                onClick={handleJumpBar}
                                className="h-6 px-1.5 rounded-sm border border-daw-violet/30 bg-daw-violet/15 text-daw-violet text-[9px] font-bold uppercase tracking-wider hover:bg-daw-violet/25"
                                title="Ir al compas"
                            >
                                Ir
                            </button>
                        </div>

                        <span className="text-[10px] font-mono text-gray-300 px-2 py-1 border border-white/10 rounded-sm bg-[#0f141e]">
                            Pos {currentPositionLabel}
                        </span>

                        <span className="text-[10px] font-mono text-gray-300 min-w-[138px] text-right px-2 py-1 border border-white/10 rounded-sm bg-[#0f141e]">
                            {playheadSeconds.toFixed(2)}s / {totalDurationSeconds.toFixed(2)}s
                        </span>
                    </div>
                </div>
            </div>

            {pianoError && (
                <div className="px-3 py-2 rounded-sm border border-red-400/30 bg-red-400/10 text-[10px] text-red-300">
                    {pianoError}
                </div>
            )}

            <div className="relative flex-1 min-h-[420px] rounded-sm border border-white/10 overflow-hidden bg-[#0f131a] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)]">
                <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-daw-violet/10 to-transparent" />
                <div className="pointer-events-none absolute -bottom-16 right-0 h-40 w-40 rounded-full bg-daw-ruby/15 blur-[60px]" />

                <canvas ref={canvasRef} className="w-full" style={{ height: noteCanvasHeight }} />

                <div className="relative border-t border-white/10 bg-gradient-to-b from-[#151d2a] to-[#121824]" style={{ height: `${keyboardHeight}px` }}>
                    <div className="absolute inset-x-0 top-0 h-px bg-white/20 pointer-events-none" />
                    {keyboardLayout.whiteKeys.map((key) => {
                        const width = 100 / keyboardLayout.whiteCount;
                        const left = key.index * width;
                        const active = activePitches.has(key.pitch);
                        const label = (key.pitch === PIANO_MIN_MIDI || key.pitch % 12 === 0)
                            ? `${NOTE_NAMES[key.pitch % 12]}${Math.floor(key.pitch / 12) - 1}`
                            : '';

                        return (
                            <div
                                key={`white-${key.pitch}`}
                                className="absolute top-0 bottom-0 border-r border-black/35 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]"
                                style={{ left: `${left}%`, width: `${width}%` }}
                            >
                                <div className={`h-full ${active
                                    ? 'bg-gradient-to-b from-[#f4ddff] to-daw-violet/55 shadow-[inset_0_0_10px_rgba(168,85,247,0.4)]'
                                    : 'bg-gradient-to-b from-[#f4f7fc] to-[#dfe6ef]'
                                    }`} />
                                {label && (
                                    <span className="absolute bottom-1 left-1 text-[9px] font-mono text-black/65 pointer-events-none">
                                        {label}
                                    </span>
                                )}
                            </div>
                        );
                    })}

                    {keyboardLayout.blackKeys.map((key) => {
                        const widthPct = (100 / keyboardLayout.whiteCount) * 0.58;
                        const centerPct = (key.anchor / keyboardLayout.whiteCount) * 100;
                        const leftPct = clamp(centerPct - (widthPct / 2), 0, 100 - widthPct);
                        const active = activePitches.has(key.pitch);

                        return (
                            <div
                                key={`black-${key.pitch}`}
                                className={`absolute top-0 h-[54px] rounded-b-sm border border-black/65 ${active
                                    ? 'bg-gradient-to-b from-[#f3bdff] via-daw-violet to-daw-ruby shadow-[0_0_12px_rgba(168,85,247,0.45)]'
                                    : 'bg-gradient-to-b from-[#121723] to-[#0a0e16]'
                                    }`}
                                style={{ left: `${leftPct}%`, width: `${widthPct}%`, height: `${blackKeyHeight}px` }}
                            />
                        );
                    })}
                </div>

                <div className="border-t border-white/10 bg-[#0d141f] px-3 py-3">
                    <div className="flex items-center justify-between text-[9px] uppercase tracking-wider text-gray-500">
                        <span className="font-bold">Linea de tiempo detectada</span>
                        <span className="font-mono">{isScrubbing ? 'NAVEGANDO...' : 'Click o arrastrar para navegar'}</span>
                    </div>

                    <div
                        ref={timelineTrackRef}
                        className={`relative mt-2 h-16 rounded-sm border border-white/10 bg-gradient-to-b from-[#0d121b] to-[#0a0f17] cursor-pointer overflow-hidden ${isScrubbing ? 'ring-1 ring-daw-violet/45' : ''}`}
                        onPointerDown={handleTimelinePointerDown}
                        onPointerMove={handleTimelinePointerMove}
                        onPointerUp={handleTimelinePointerUp}
                        onPointerCancel={handleTimelinePointerUp}
                    >
                        {timelineBarMarkers.map((marker) => (
                            <div
                                key={`tick-${marker.bar}`}
                                className={`absolute top-0 bottom-0 w-px ${marker.major ? 'bg-white/15' : 'bg-white/8'}`}
                                style={{ left: `${marker.left}%` }}
                            />
                        ))}

                        {timelineBarMarkers
                            .filter((marker) => marker.major)
                            .slice(0, 40)
                            .map((marker) => (
                                <button
                                    key={`label-${marker.bar}`}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        seekToBar(marker.bar);
                                    }}
                                    className="absolute top-0 -translate-x-1/2 text-[8px] font-mono text-gray-500 hover:text-white"
                                    style={{ left: `${marker.left}%` }}
                                    title={`Ir al compas ${marker.bar}`}
                                >
                                    {marker.bar}
                                </button>
                            ))}

                        {timelineOverviewNotes.map((note) => (
                            <div
                                key={`overview-${note.id}`}
                                className="absolute rounded-sm"
                                style={{
                                    left: `${note.leftPct}%`,
                                    width: `${note.widthPct}%`,
                                    top: `${note.topPct}%`,
                                    height: '2px',
                                    backgroundColor: note.color,
                                    opacity: note.alpha
                                }}
                            />
                        ))}

                        <div
                            className="absolute top-0 bottom-0 w-[2px] bg-white/90 shadow-[0_0_10px_rgba(255,255,255,0.7)]"
                            style={{ left: `${playheadPercent}%`, transform: 'translateX(-1px)' }}
                        />
                    </div>

                    <div className="mt-2 grid grid-cols-5 text-[9px] font-mono text-gray-500">
                        {timelineTickLabels.map((label) => (
                            <span key={label} className="text-center">{label}</span>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default SynthesiaVisualizer;
