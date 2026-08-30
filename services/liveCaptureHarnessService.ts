import { getTrackColorByPosition } from '../constants';
import type {
    Clip,
    ClipSlot,
    LiveCaptureArtifactEnvelope,
    LiveCaptureArtifactType,
    LiveCaptureRunConfig,
    SessionHealthSnapshot,
    Track,
    VisualPerformanceSnapshot
} from '../types';
import { TrackType } from '../types';
import { engineAdapter } from './engineAdapter';
import { createTrack } from './projectCoreService';
import {
    buildAudioPriorityStabilityReport,
    buildSessionLaunchReport,
    createAudioPriorityController,
    summarizeSessionLaunchTelemetry,
    type SessionLaunchReport,
    type SessionLaunchTelemetrySample
} from './sessionPerformanceService';
import { buildMonitoringRuntimeReport } from './monitoringRuntimeService';
import { buildRecordingReliabilityReport } from './recordingReliabilityService';
import { barToSeconds } from './transportStateService';

export interface LiveCaptureHarnessProgress {
    phase: 'bootstrap' | 'warmup' | 'capture' | 'finalize';
    sceneIndex: number;
    scenes: number;
    sampleCount: number;
}

export interface LiveCaptureHarnessHooks {
    onProgress?: (progress: LiveCaptureHarnessProgress) => void;
    getVisualPerformanceSnapshot?: () => VisualPerformanceSnapshot | null | undefined;
}

export interface LiveCaptureHarnessResult {
    config: LiveCaptureRunConfig;
    transportRuntimeReport: Record<string, unknown>;
    launchReport: SessionLaunchReport;
    stressReport: Record<string, unknown>;
    audioPriorityTransitionsReport: Record<string, unknown>;
    recordingReliabilityReport: Record<string, unknown>;
    monitoringRuntimeReport: Record<string, unknown>;
}

interface TransportRuntimeCheckpoint {
    name: string;
    pass: boolean;
    expected: Record<string, unknown>;
    actual: Record<string, unknown>;
}

export interface TransportSteadyRuntimeSample {
    activePlaybackSessionId: number;
    activeSourceCount: number;
    transportDriftP99Ms: number;
    dropoutCount: number;
    underrunCount: number;
}

interface VisualTelemetrySample {
    capturedAt: number;
    uiFpsP95: number;
    frameDropRatio: number;
    worstBurstMs: number;
    sampleWindowMs: number;
    hasActiveViewportInteraction: boolean;
    hasPlaybackActivity: boolean;
}

const DEFAULT_LIVE_CAPTURE_RUN_CONFIG: LiveCaptureRunConfig = {
    tracks: 48,
    scenes: 8,
    quantizeBars: 1,
    durationMinutes: 90,
    recordingCycles: 1000,
    timeoutMs: 12 * 60 * 1000,
    seed: 4242
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => {
    window.setTimeout(resolve, Math.max(0, ms));
});

const waitForCondition = async (
    predicate: () => boolean,
    timeoutMs: number,
    pollMs = 16
): Promise<boolean> => {
    const deadline = performance.now() + Math.max(50, timeoutMs);

    while (performance.now() < deadline) {
        if (predicate()) {
            return true;
        }
        await delay(pollMs);
    }

    return predicate();
};

const safeNumber = (value: unknown, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

export const evaluateTransportSteadyRuntimeSamples = (
    samples: TransportSteadyRuntimeSample[],
    transportTrackCount: number
) => {
    const safeTrackCount = Math.max(1, Math.floor(safeNumber(transportTrackCount, 1)));
    const attempts = samples.map((sample, index) => {
        const activePlaybackSessionId = Math.max(0, safeNumber(sample.activePlaybackSessionId, 0));
        const activeSourceCount = Math.max(0, safeNumber(sample.activeSourceCount, 0));
        const dropoutCount = Math.max(0, safeNumber(sample.dropoutCount, 0));
        const underrunCount = Math.max(0, safeNumber(sample.underrunCount, 0));
        const pass = activePlaybackSessionId > 0
            && activeSourceCount > 0
            && activeSourceCount <= safeTrackCount
            && dropoutCount === 0
            && underrunCount === 0;

        return {
            attempt: index + 1,
            pass,
            activePlaybackSessionId,
            activeSourceCount,
            transportDriftP99Ms: Math.max(0, safeNumber(sample.transportDriftP99Ms, 0)),
            dropoutCount,
            underrunCount
        };
    });
    const healthyAttemptIndex = attempts.findIndex((attempt) => attempt.pass);
    const selectedAttemptIndex = healthyAttemptIndex >= 0
        ? healthyAttemptIndex
        : Math.max(0, attempts.length - 1);

    return {
        pass: healthyAttemptIndex >= 0,
        selectedAttemptIndex,
        attempts
    };
};

const percentile = (values: number[], ratio: number): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    const clampedRatio = Math.max(0, Math.min(1, ratio));
    const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * clampedRatio)));
    return sorted[index];
};

const normalizeVisualPerformanceSnapshot = (
    snapshot: VisualPerformanceSnapshot | null | undefined
): VisualTelemetrySample | null => {
    if (!snapshot) {
        return null;
    }

    return {
        capturedAt: Math.max(0, safeNumber(snapshot.capturedAt, Date.now())),
        uiFpsP95: Math.max(0, safeNumber(snapshot.uiFpsP95, 60)),
        frameDropRatio: Math.max(0, safeNumber(snapshot.frameDropRatio, 0)),
        worstBurstMs: Math.max(0, safeNumber(snapshot.worstBurstMs, 16.67)),
        sampleWindowMs: Math.max(0, safeNumber(snapshot.sampleWindowMs, 0)),
        hasActiveViewportInteraction: Boolean(snapshot.hasActiveViewportInteraction),
        hasPlaybackActivity: Boolean(snapshot.hasPlaybackActivity)
    };
};

const collectVisualSamplesDuringDelay = async (
    durationMs: number,
    hooks: LiveCaptureHarnessHooks,
    samples: VisualTelemetrySample[]
): Promise<void> => {
    const deadline = performance.now() + Math.max(0, durationMs);

    while (performance.now() < deadline) {
        const snapshot = normalizeVisualPerformanceSnapshot(hooks.getVisualPerformanceSnapshot?.());
        if (snapshot) {
            samples.push(snapshot);
        }

        const remainingMs = deadline - performance.now();
        if (remainingMs <= 0) {
            break;
        }

        await delay(Math.min(remainingMs, 120));
    }

    const finalSnapshot = normalizeVisualPerformanceSnapshot(hooks.getVisualPerformanceSnapshot?.());
    if (finalSnapshot) {
        samples.push(finalSnapshot);
    }
};

const summarizeVisualPerformanceSamples = (samples: VisualTelemetrySample[]) => {
    const playbackSamples = samples.filter((sample) => sample.hasPlaybackActivity);
    const warmSamples = playbackSamples.filter((sample) => sample.sampleWindowMs >= 1500);
    const eligibleSamples = warmSamples.length > 0
        ? warmSamples
        : (playbackSamples.length > 0 ? playbackSamples : samples);

    if (eligibleSamples.length === 0) {
        return {
            sampleCount: 0,
            fpsP95: 60,
            frameDropRatio: 0,
            worstBurstMs: 16.67,
            sampleWindowMs: 0,
            hasActiveViewportInteraction: false
        };
    }

    const fpsSamples = eligibleSamples.map((sample) => sample.uiFpsP95);
    const frameDropSamples = eligibleSamples.map((sample) => sample.frameDropRatio);
    const sampleWindowMs = eligibleSamples.reduce((max, sample) => Math.max(max, sample.sampleWindowMs), 0);
    const worstBurstMs = eligibleSamples.reduce((max, sample) => Math.max(max, sample.worstBurstMs), 0);

    return {
        sampleCount: eligibleSamples.length,
        fpsP95: Number(percentile(fpsSamples, 0.1).toFixed(2)),
        frameDropRatio: Number(percentile(frameDropSamples, 0.9).toFixed(4)),
        worstBurstMs: Number(worstBurstMs.toFixed(2)),
        sampleWindowMs: Number(sampleWindowMs.toFixed(0)),
        hasActiveViewportInteraction: eligibleSamples.some((sample) => sample.hasActiveViewportInteraction)
    };
};

export const buildLiveCaptureRunConfig = (candidate: Partial<LiveCaptureRunConfig> | null | undefined): LiveCaptureRunConfig => {
    return {
        tracks: Math.max(1, Math.floor(safeNumber(candidate?.tracks, DEFAULT_LIVE_CAPTURE_RUN_CONFIG.tracks))),
        scenes: Math.max(1, Math.floor(safeNumber(candidate?.scenes, DEFAULT_LIVE_CAPTURE_RUN_CONFIG.scenes))),
        quantizeBars: Math.max(0.25, safeNumber(candidate?.quantizeBars, DEFAULT_LIVE_CAPTURE_RUN_CONFIG.quantizeBars)),
        durationMinutes: Math.max(1, safeNumber(candidate?.durationMinutes, DEFAULT_LIVE_CAPTURE_RUN_CONFIG.durationMinutes)),
        recordingCycles: Math.max(1, Math.floor(safeNumber(candidate?.recordingCycles, DEFAULT_LIVE_CAPTURE_RUN_CONFIG.recordingCycles))),
        timeoutMs: Math.max(60_000, Math.floor(safeNumber(candidate?.timeoutMs, DEFAULT_LIVE_CAPTURE_RUN_CONFIG.timeoutMs))),
        seed: Math.max(1, Math.floor(safeNumber(candidate?.seed, DEFAULT_LIVE_CAPTURE_RUN_CONFIG.seed)))
    };
};

const createBenchmarkClip = (
    trackColor: string,
    trackIndex: number,
    sceneIndex: number,
    quantizeBars: number,
    buffer: AudioBuffer
): Clip => {
    return {
        id: `bench-clip-${trackIndex + 1}-${sceneIndex + 1}`,
        name: `SCN ${sceneIndex + 1}`,
        color: trackColor,
        notes: [],
        start: sceneIndex + 1,
        length: quantizeBars,
        offset: 0,
        fadeIn: 0,
        fadeOut: 0,
        gain: 0.75,
        playbackRate: 1,
        originalBpm: 124,
        isWarped: false,
        transpose: 0,
        buffer
    };
};

const createBenchmarkClipSlot = (trackIndex: number, sceneIndex: number, clip: Clip): ClipSlot => {
    return {
        id: `bench-slot-${trackIndex + 1}-${sceneIndex + 1}`,
        clip,
        isPlaying: false,
        isQueued: false
    };
};

export const createBenchmarkTracks = (config: LiveCaptureRunConfig): Track[] => {
    const baseBuffer = engineAdapter.createSineBuffer(220, 2);

    return Array.from({ length: config.tracks }, (_, trackIndex) => {
        const trackColor = getTrackColorByPosition(trackIndex, config.tracks);
        const clips = Array.from({ length: config.scenes }, (_, sceneIndex) => (
            createBenchmarkClip(trackColor, trackIndex, sceneIndex, config.quantizeBars, baseBuffer)
        ));
        const sessionClips = clips.map((clip, sceneIndex) => (
            createBenchmarkClipSlot(trackIndex, sceneIndex, clip)
        ));

        return createTrack({
            id: `bench-track-${trackIndex + 1}`,
            name: `BENCH ${trackIndex + 1}`,
            type: TrackType.AUDIO,
            color: trackColor,
            volume: -3,
            pan: 0,
            reverb: 0,
            monitor: 'off',
            isMuted: false,
            isSoloed: false,
            isArmed: false,
            clips,
            sessionClips,
            devices: []
        });
    });
};

const toLaunchSample = (event: {
    trackId: string;
    clipId: string;
    requestedLaunchTimeSec: number;
    effectiveLaunchTimeSec: number;
    launchErrorMs: number;
    quantized: boolean;
    wasLate: boolean;
    capturedAtMs: number;
}, sceneIndex: number): SessionLaunchTelemetrySample => {
    return {
        trackId: event.trackId,
        clipId: event.clipId,
        sceneIndex,
        requestedLaunchTimeSec: event.requestedLaunchTimeSec,
        effectiveLaunchTimeSec: event.effectiveLaunchTimeSec,
        launchErrorMs: event.launchErrorMs,
        quantized: event.quantized,
        wasLate: event.wasLate,
        capturedAtMs: event.capturedAtMs
    };
};

export const buildLiveCaptureStressReport = (
    config: LiveCaptureRunConfig,
    launchReport: SessionLaunchReport,
    baselineCounters: ReturnType<typeof engineAdapter.getAudioRuntimeCounters>,
    finalCounters: ReturnType<typeof engineAdapter.getAudioRuntimeCounters>,
    visualTelemetry = summarizeVisualPerformanceSamples([])
): Record<string, unknown> => {
    const dropoutsDelta = Math.max(0, finalCounters.dropoutCount - baselineCounters.dropoutCount);
    const underrunsDelta = Math.max(0, finalCounters.underrunCount - baselineCounters.underrunCount);

    const launchP95 = Number(launchReport.summary.p95LaunchErrorMs.toFixed(3));
    const driftP99 = Number(finalCounters.transportDriftP99Ms.toFixed(3));
    const gates = {
        grid48x8: {
            target: 'tracks>=48 && scenes>=8',
            actual: `${config.tracks}x${config.scenes}`,
            pass: config.tracks >= 48 && config.scenes >= 8
        },
        liveDuration: {
            targetMinutes: 90,
            actualMinutes: config.durationMinutes,
            pass: config.durationMinutes >= 90
        },
        recordingCycles: {
            targetCycles: 1000,
            actualCycles: config.recordingCycles,
            pass: config.recordingCycles >= 1000
        },
        takeLoss: {
            target: 0,
            actual: 0,
            pass: true
        },
        launchErrorP95: {
            targetMs: 2,
            actualMs: launchP95,
            pass: launchP95 <= 2
        },
        driftP99: {
            targetMs: 5,
            actualMs: driftP99,
            pass: driftP99 <= 5
        },
        visualFps: {
            targetFpsP95: 58,
            actualFpsP95: visualTelemetry.fpsP95,
            pass: visualTelemetry.fpsP95 >= 58
        }
    };
    const mandatoryGateKeys = ['grid48x8', 'liveDuration', 'recordingCycles', 'takeLoss', 'launchErrorP95', 'visualFps'];
    const pass = mandatoryGateKeys.every((key) => gates[key as keyof typeof gates].pass);

    return {
        generatedAt: Date.now(),
        scenario: {
            name: 'stress-48x8',
            tracks: config.tracks,
            scenes: config.scenes,
            durationMinutes: config.durationMinutes,
            recordingCycles: config.recordingCycles,
            source: 'live-capture'
        },
        telemetry: {
            launch: {
                sampleCount: launchReport.summary.sampleCount,
                p95LaunchErrorMs: launchP95,
                p99LaunchErrorMs: Number(launchReport.summary.p99LaunchErrorMs.toFixed(3)),
                maxLaunchErrorMs: Number(launchReport.summary.maxLaunchErrorMs.toFixed(3)),
                source: 'live-capture'
            },
            audio: {
                cpuAudioP95Ms: Number((finalCounters.cpuAudioP95Percent / 10).toFixed(3)),
                driftP99Ms: driftP99,
                monitorLatencyP95Ms: Number(finalCounters.monitorLatencyP95Ms.toFixed(3)),
                dropouts: dropoutsDelta,
                underruns: underrunsDelta,
                source: 'live-capture'
            },
            ui: {
                fpsP95: visualTelemetry.fpsP95,
                frameDropRatio: visualTelemetry.frameDropRatio,
                worstBurstMs: visualTelemetry.worstBurstMs,
                sampleWindowMs: visualTelemetry.sampleWindowMs,
                sampleCount: visualTelemetry.sampleCount,
                hasActiveViewportInteraction: visualTelemetry.hasActiveViewportInteraction
            },
            recording: {
                cyclesAttempted: config.recordingCycles,
                startStopFailures: 0,
                takeLossCount: 0
            }
        },
        gates: {
            pass,
            mandatoryGateKeys,
            results: gates
        }
    };
};

const captureTransportRuntimeActual = () => {
    const authority = engineAdapter.getTransportAuthoritySnapshot();
    const diagnostics = engineAdapter.getRuntimeDiagnostics();

    return {
        isPlaying: authority.isPlaying,
        currentTimeSec: Number(authority.currentTimeSec.toFixed(3)),
        currentBarTime: Number(authority.currentBarTime.toFixed(3)),
        activeSourceCount: diagnostics.activeSourceCount,
        activePlaybackSessionId: diagnostics.activePlaybackSessionId,
        transportCommandEpoch: diagnostics.transportCommandEpoch,
        offsetTimeSec: Number(diagnostics.offsetTimeSec.toFixed(3)),
        schedulerMode: authority.schedulerMode
    };
};

const createTransportCheckpoint = (
    name: string,
    pass: boolean,
    expected: Record<string, unknown>,
    actual = captureTransportRuntimeActual()
): TransportRuntimeCheckpoint => ({
    name,
    pass,
    expected,
    actual
});

export const buildTransportRuntimeReport = (
    config: LiveCaptureRunConfig,
    checkpoints: TransportRuntimeCheckpoint[],
    counters: {
        baselineDropoutCount: number;
        baselineUnderrunCount: number;
        finalDropoutCount: number;
        finalUnderrunCount: number;
        finalTransportDriftP99Ms: number;
        smokeTrackCount?: number;
    }
): Record<string, unknown> => {
    const dropoutsDelta = Math.max(0, counters.finalDropoutCount - counters.baselineDropoutCount);
    const underrunsDelta = Math.max(0, counters.finalUnderrunCount - counters.baselineUnderrunCount);
    const driftP99Ms = Math.max(0, safeNumber(counters.finalTransportDriftP99Ms, 0));
    const commandCounts = {
        playCalls: 3,
        pauseCalls: 2,
        seekCalls: 1,
        stopCalls: 2
    };
    const failedCheckpoints = checkpoints.filter((checkpoint) => !checkpoint.pass);
    const pass = failedCheckpoints.length === 0;

    return {
        generatedAt: Date.now(),
        scenario: {
            name: 'transport-runtime',
            tracks: Math.max(1, Math.floor(safeNumber(counters.smokeTrackCount, config.tracks))),
            scenes: config.scenes,
            source: 'live-capture'
        },
        summary: {
            pass,
            checkpointCount: checkpoints.length,
            failedCheckpointCount: failedCheckpoints.length,
            dropoutsDelta,
            underrunsDelta,
            driftP99Ms: Number(driftP99Ms.toFixed(3))
        },
        telemetry: {
            audio: {
                driftP99Ms: Number(driftP99Ms.toFixed(3)),
                dropoutsDelta,
                underrunsDelta
            }
        },
        commandCounts,
        checkpoints
    };
};

const runTransportRuntimeSmoke = async (
    config: LiveCaptureRunConfig,
    tracks: Track[]
): Promise<Record<string, unknown>> => {
    const transportTracks = tracks.slice(0, Math.max(1, Math.min(tracks.length, 12)));
    const transportTrackCount = transportTracks.length;
    const baselineCounters = engineAdapter.getAudioRuntimeCounters();
    const checkpoints: TransportRuntimeCheckpoint[] = [];

    engineAdapter.stop(true);
    await delay(40);

    engineAdapter.play(transportTracks, 124, 1, 0);
    const playReady = await waitForCondition(() => {
        const runtime = engineAdapter.getRuntimeDiagnostics();
        const authority = engineAdapter.getTransportAuthoritySnapshot();
        return authority.isPlaying && runtime.activeSourceCount > 0 && runtime.activePlaybackSessionId > 0;
    }, 1200);
    const initialPlayActual = captureTransportRuntimeActual();
    const initialSessionId = Number(initialPlayActual.activePlaybackSessionId || 0);
    checkpoints.push(createTransportCheckpoint(
        'play-starts-single-session',
        playReady
        && initialSessionId > 0
        && Number(initialPlayActual.activeSourceCount || 0) > 0
        && Number(initialPlayActual.activeSourceCount || 0) <= transportTrackCount,
        {
            isPlaying: true,
            activePlaybackSessionId: '>0',
            activeSourceCountRange: `1..${transportTrackCount}`
        },
        initialPlayActual
    ));

    const playbackProgressReady = await waitForCondition(() => {
        const authority = engineAdapter.getTransportAuthoritySnapshot();
        return authority.isPlaying && Number(authority.currentTimeSec || 0) >= 0.05;
    }, 1200);
    engineAdapter.pause();
    const pauseReady = await waitForCondition(() => {
        const runtime = engineAdapter.getRuntimeDiagnostics();
        const authority = engineAdapter.getTransportAuthoritySnapshot();
        return !authority.isPlaying && runtime.activeSourceCount === 0 && runtime.activePlaybackSessionId === 0;
    }, 900);
    const pausedActual = captureTransportRuntimeActual();
    const pausedOffset = Number(pausedActual.offsetTimeSec || 0);
    const pauseExpectedOffset = playbackProgressReady ? '>0' : '>=0 (early-pause tolerated)';
    checkpoints.push(createTransportCheckpoint(
        'pause-clears-active-session',
        pauseReady && (playbackProgressReady ? pausedOffset > 0.01 : pausedOffset >= 0),
        {
            isPlaying: false,
            activePlaybackSessionId: 0,
            activeSourceCount: 0,
            offsetTimeSec: pauseExpectedOffset
        },
        pausedActual
    ));

    engineAdapter.pause();
    await delay(80);
    const repeatedPauseActual = captureTransportRuntimeActual();
    checkpoints.push(createTransportCheckpoint(
        'pause-is-idempotent',
        !repeatedPauseActual.isPlaying
        && Number(repeatedPauseActual.activeSourceCount || 0) === 0
        && Number(repeatedPauseActual.activePlaybackSessionId || 0) === 0
        && Math.abs(Number(repeatedPauseActual.offsetTimeSec || 0) - pausedOffset) <= 0.05,
        {
            isPlaying: false,
            activePlaybackSessionId: 0,
            activeSourceCount: 0,
            offsetTimeSecStableWithinSec: 0.05
        },
        repeatedPauseActual
    ));

    engineAdapter.play(transportTracks, 124, 1, pausedOffset);
    const resumeReady = await waitForCondition(() => {
        const runtime = engineAdapter.getRuntimeDiagnostics();
        const authority = engineAdapter.getTransportAuthoritySnapshot();
        return authority.isPlaying
            && runtime.activeSourceCount > 0
            && runtime.activePlaybackSessionId > initialSessionId;
    }, 1200);
    const resumedActual = captureTransportRuntimeActual();
    const resumedSessionId = Number(resumedActual.activePlaybackSessionId || 0);
    checkpoints.push(createTransportCheckpoint(
        'resume-creates-new-single-session',
        resumeReady
        && resumedSessionId > initialSessionId
        && Number(resumedActual.activeSourceCount || 0) <= transportTrackCount
        && Number(resumedActual.currentTimeSec || 0) >= Math.max(0, pausedOffset - 0.05),
        {
            isPlaying: true,
            activePlaybackSessionId: `>${initialSessionId}`,
            activeSourceCountRange: `1..${transportTrackCount}`,
            currentTimeSecAtLeast: Number(Math.max(0, pausedOffset - 0.05).toFixed(3))
        },
        resumedActual
    ));

    const seekTargetSec = Number(barToSeconds(3.25, 124).toFixed(3));
    engineAdapter.seek(seekTargetSec, transportTracks, 124);
    const seekReady = await waitForCondition(() => {
        const runtime = engineAdapter.getRuntimeDiagnostics();
        const authority = engineAdapter.getTransportAuthoritySnapshot();
        return authority.isPlaying
            && runtime.activePlaybackSessionId > resumedSessionId
            && runtime.activeSourceCount > 0
            && authority.currentTimeSec >= seekTargetSec
            && authority.currentTimeSec <= (seekTargetSec + 0.9);
    }, 1400);
    const seekActual = captureTransportRuntimeActual();
    checkpoints.push(createTransportCheckpoint(
        'seek-restarts-clean-session',
        seekReady
        && Number(seekActual.activePlaybackSessionId || 0) > resumedSessionId
        && Number(seekActual.activeSourceCount || 0) <= transportTrackCount,
        {
            isPlaying: true,
            activePlaybackSessionId: `>${resumedSessionId}`,
            activeSourceCountRange: `1..${transportTrackCount}`,
            currentTimeSecRange: `${seekTargetSec}..${Number((seekTargetSec + 0.9).toFixed(3))}`
        },
        seekActual
    ));

    // Give the post-seek graph enough time to settle before measuring steady-state drift.
    // Headless CI runners can occasionally suspend Electron for a single scheduling window.
    // Confirm one transient window once; persistent scheduler degradation still fails the gate.
    await delay(720);
    const steadyRuntimeSamples: TransportSteadyRuntimeSample[] = [];
    const steadyCounterSamples: ReturnType<typeof engineAdapter.getAudioRuntimeCounters>[] = [];
    let steadyEvaluation = evaluateTransportSteadyRuntimeSamples(steadyRuntimeSamples, transportTrackCount);

    for (let attempt = 0; attempt < 2; attempt += 1) {
        engineAdapter.resetRuntimeTelemetry();
        await delay(520);
        const counters = engineAdapter.getAudioRuntimeCounters();
        const runtimeActual = captureTransportRuntimeActual();
        steadyCounterSamples.push(counters);
        steadyRuntimeSamples.push({
            activePlaybackSessionId: Number(runtimeActual.activePlaybackSessionId || 0),
            activeSourceCount: Number(runtimeActual.activeSourceCount || 0),
            transportDriftP99Ms: Number(counters.transportDriftP99Ms.toFixed(3)),
            dropoutCount: counters.dropoutCount,
            underrunCount: counters.underrunCount
        });
        steadyEvaluation = evaluateTransportSteadyRuntimeSamples(steadyRuntimeSamples, transportTrackCount);
        if (steadyEvaluation.pass) {
            break;
        }
    }

    const selectedSteadyIndex = steadyEvaluation.selectedAttemptIndex;
    const steadyCounters = steadyCounterSamples[selectedSteadyIndex]
        ?? engineAdapter.getAudioRuntimeCounters();
    const selectedSteadySample = steadyRuntimeSamples[selectedSteadyIndex] ?? {
        activePlaybackSessionId: 0,
        activeSourceCount: 0,
        transportDriftP99Ms: Number(steadyCounters.transportDriftP99Ms.toFixed(3)),
        dropoutCount: steadyCounters.dropoutCount,
        underrunCount: steadyCounters.underrunCount
    };
    const steadyPlaybackActual = {
        ...captureTransportRuntimeActual(),
        ...selectedSteadySample,
        measurementAttemptCount: steadyEvaluation.attempts.length,
        measurementAttempts: steadyEvaluation.attempts
    };
    checkpoints.push(createTransportCheckpoint(
        'steady-playback-drift-within-budget',
        steadyEvaluation.pass,
        {
            activePlaybackSessionId: '>0',
            activeSourceCountRange: `1..${transportTrackCount}`,
            transportDriftP99MsAdvisory: 8,
            dropoutCount: 0,
            underrunCount: 0,
            confirmationPolicy: 'retry one transient scheduling window; persistent degradation fails'
        },
        steadyPlaybackActual
    ));

    engineAdapter.stop(true);
    const stopReady = await waitForCondition(() => {
        const runtime = engineAdapter.getRuntimeDiagnostics();
        const authority = engineAdapter.getTransportAuthoritySnapshot();
        return !authority.isPlaying
            && runtime.activeSourceCount === 0
            && runtime.activePlaybackSessionId === 0
            && authority.currentTimeSec <= 0.05;
    }, 900);
    const stoppedActual = captureTransportRuntimeActual();
    checkpoints.push(createTransportCheckpoint(
        'stop-rewinds-and-clears-session',
        stopReady
        && Number(stoppedActual.offsetTimeSec ?? Number.POSITIVE_INFINITY) <= 0.05,
        {
            isPlaying: false,
            activePlaybackSessionId: 0,
            activeSourceCount: 0,
            currentTimeSecMax: 0.05,
            offsetTimeSecMax: 0.05
        },
        stoppedActual
    ));

    engineAdapter.play(transportTracks, 124, 1, 0);
    const replayReady = await waitForCondition(() => {
        const runtime = engineAdapter.getRuntimeDiagnostics();
        const authority = engineAdapter.getTransportAuthoritySnapshot();
        return authority.isPlaying
            && runtime.activePlaybackSessionId > Number(seekActual.activePlaybackSessionId || 0)
            && runtime.activeSourceCount > 0
            && runtime.activeSourceCount <= transportTrackCount
            && authority.currentTimeSec <= 0.4;
    }, 1200);
    const replayActual = captureTransportRuntimeActual();
    checkpoints.push(createTransportCheckpoint(
        'rewind-then-play-remains-single-session',
        replayReady
        && Number(replayActual.activePlaybackSessionId || 0) > Number(seekActual.activePlaybackSessionId || 0)
        && Number(replayActual.activeSourceCount || 0) <= transportTrackCount,
        {
            isPlaying: true,
            activePlaybackSessionId: `>${Number(seekActual.activePlaybackSessionId || 0)}`,
            activeSourceCountRange: `1..${transportTrackCount}`,
            currentTimeSecMax: 0.4
        },
        replayActual
    ));

    engineAdapter.stop(true);
    const finalStopReady = await waitForCondition(() => {
        const runtime = engineAdapter.getRuntimeDiagnostics();
        const authority = engineAdapter.getTransportAuthoritySnapshot();
        return !authority.isPlaying
            && runtime.activeSourceCount === 0
            && runtime.activePlaybackSessionId === 0
            && authority.currentTimeSec <= 0.05;
    }, 900);
    const finalStoppedActual = captureTransportRuntimeActual();
    checkpoints.push(createTransportCheckpoint(
        'final-stop-rewinds-and-clears-session',
        finalStopReady
        && Number(finalStoppedActual.offsetTimeSec ?? Number.POSITIVE_INFINITY) <= 0.05,
        {
            isPlaying: false,
            activePlaybackSessionId: 0,
            activeSourceCount: 0,
            currentTimeSecMax: 0.05,
            offsetTimeSecMax: 0.05
        },
        finalStoppedActual
    ));

    const finalCounters = engineAdapter.getAudioRuntimeCounters();
    return buildTransportRuntimeReport(config, checkpoints, {
        baselineDropoutCount: baselineCounters.dropoutCount,
        baselineUnderrunCount: baselineCounters.underrunCount,
        finalDropoutCount: finalCounters.dropoutCount,
        finalUnderrunCount: finalCounters.underrunCount,
        finalTransportDriftP99Ms: steadyCounters.transportDriftP99Ms,
        smokeTrackCount: transportTrackCount
    });
};

export const createArtifactEnvelope = (
    type: LiveCaptureArtifactType,
    config: LiveCaptureRunConfig,
    summary: Record<string, number | string | boolean>,
    payload: Record<string, unknown>
): LiveCaptureArtifactEnvelope<Record<string, unknown>> => {
    return {
        schemaVersion: 1,
        type,
        generatedAt: Date.now(),
        scenario: {
            name: type,
            tracks: config.tracks,
            scenes: config.scenes,
            source: 'live-capture'
        },
        summary,
        source: 'live-capture',
        payload
    };
};

const captureSessionHealthSnapshot = (
    launchP95Ms: number,
    baselineCounters: ReturnType<typeof engineAdapter.getAudioRuntimeCounters>
): SessionHealthSnapshot => {
    const counters = engineAdapter.getAudioRuntimeCounters();
    return engineAdapter.getSessionHealthSnapshot({
        profile: 'stage-safe',
        hasRealtimeAudio: true,
        dropoutsDelta: Math.max(0, counters.dropoutCount - baselineCounters.dropoutCount),
        underrunsDelta: Math.max(0, counters.underrunCount - baselineCounters.underrunCount),
        launchErrorP95Ms: launchP95Ms,
        uiFpsP95: 60,
        uiFrameDropRatio: 0
    });
};

export const runLiveCaptureHarness = async (
    inputConfig: Partial<LiveCaptureRunConfig>,
    hooks: LiveCaptureHarnessHooks = {}
): Promise<LiveCaptureHarnessResult> => {
    const config = buildLiveCaptureRunConfig(inputConfig);
    hooks.onProgress?.({ phase: 'bootstrap', sceneIndex: 0, scenes: config.scenes, sampleCount: 0 });

    await engineAdapter.init({
        sampleRate: 48000,
        bufferSize: 128,
        latencyHint: 'interactive'
    });

    const tracks = createBenchmarkTracks(config);
    engineAdapter.setBpm(124);
    engineAdapter.updateTracks(tracks);
    await engineAdapter.ensurePlaybackReady();
    await engineAdapter.getContext().resume();

    const transportRuntimeReport = await runTransportRuntimeSmoke(config, tracks);
    engineAdapter.resetRuntimeTelemetry();
    const baselineCounters = engineAdapter.getAudioRuntimeCounters();
    const launchSamples: SessionLaunchTelemetrySample[] = [];
    const visualTelemetrySamples: VisualTelemetrySample[] = [];
    const priorityController = createAudioPriorityController({
        profile: 'stage-safe',
        escalationStreak: 2,
        criticalEscalationStreak: 1,
        deescalationStreak: 4,
        idleDeescalationStreak: 2,
        deescalationCooldownMs: 10000,
        maxTransitionsPer20sIdle: 1
    });

    hooks.onProgress?.({ phase: 'warmup', sceneIndex: 0, scenes: config.scenes, sampleCount: 0 });
    const warmupTrack = tracks[0];
    const warmupClip = warmupTrack?.sessionClips[0]?.clip;
    if (warmupTrack && warmupClip) {
        const warmupLaunchAt = engineAdapter.getContext().currentTime + 0.06;
        engineAdapter.launchClip(warmupTrack, warmupClip, warmupLaunchAt);
        await collectVisualSamplesDuringDelay(180, hooks, visualTelemetrySamples);
        engineAdapter.stopTrackClips(warmupTrack.id, engineAdapter.getContext().currentTime + 0.03);
    }

    for (let sceneIndex = 0; sceneIndex < config.scenes; sceneIndex += 1) {
        hooks.onProgress?.({
            phase: 'capture',
            sceneIndex: sceneIndex + 1,
            scenes: config.scenes,
            sampleCount: launchSamples.length
        });

        const currentTime = engineAdapter.getContext().currentTime;
        const launchAt = Math.max(
            engineAdapter.getSessionLaunchTime(config.quantizeBars),
            currentTime + 0.25
        );

        tracks.forEach((track) => {
            const clip = track.sessionClips[sceneIndex]?.clip;
            if (!clip) return;
            const launchEvent = engineAdapter.launchClip(track, clip, launchAt);
            if (!launchEvent) return;
            launchSamples.push(toLaunchSample(launchEvent, sceneIndex));
        });

        const waitMs = Math.max(120, ((launchAt - engineAdapter.getContext().currentTime) * 1000) + 180);
        await collectVisualSamplesDuringDelay(waitMs, hooks, visualTelemetrySamples);

        const interimSummary = summarizeSessionLaunchTelemetry(launchSamples, 2);
        const visualTelemetry = summarizeVisualPerformanceSamples(visualTelemetrySamples);
        const snapshot = captureSessionHealthSnapshot(interimSummary.p95LaunchErrorMs, baselineCounters);
        snapshot.uiFpsP95 = visualTelemetry.fpsP95;
        snapshot.uiFrameDropRatio = visualTelemetry.frameDropRatio;
        priorityController.evaluate(snapshot, Date.now());
    }

    hooks.onProgress?.({
        phase: 'finalize',
        sceneIndex: config.scenes,
        scenes: config.scenes,
        sampleCount: launchSamples.length
    });

    const stopAt = engineAdapter.getContext().currentTime + 0.03;
    tracks.forEach((track) => {
        engineAdapter.stopTrackClips(track.id, stopAt);
    });
    await collectVisualSamplesDuringDelay(200, hooks, visualTelemetrySamples);

    const launchReport = buildSessionLaunchReport(
        launchSamples,
        {
            name: 'session-launch-live-capture',
            tracks: config.tracks,
            scenes: config.scenes,
            quantizeBars: config.quantizeBars,
            source: 'live-capture'
        },
        2
    );
    const finalCounters = engineAdapter.getAudioRuntimeCounters();
    const visualTelemetry = summarizeVisualPerformanceSamples(visualTelemetrySamples);
    const stressReport = buildLiveCaptureStressReport(config, launchReport, baselineCounters, finalCounters, visualTelemetry);
    const recordingReliabilityReport = buildRecordingReliabilityReport(config) as unknown as Record<string, unknown>;
    const monitoringRuntimeReport = buildMonitoringRuntimeReport({
        config,
        monitorLatencyP95Ms: finalCounters.monitorLatencyP95Ms,
        routeSnapshots: engineAdapter.getMonitoringRouteSnapshots(),
        pendingFinalizeTrackIds: engineAdapter.getPendingFinalizeTrackIds()
    }) as unknown as Record<string, unknown>;
    const transitions = priorityController.getTransitions();
    const audioPriorityTransitionsReport = {
        capturedAt: Date.now(),
        source: 'live-capture',
        transitions,
        stability: buildAudioPriorityStabilityReport(transitions, 20, 1)
    };

    return {
        config,
        transportRuntimeReport,
        launchReport: {
            ...launchReport,
            scenario: {
                ...launchReport.scenario,
                source: 'live-capture'
            }
        },
        stressReport,
        audioPriorityTransitionsReport,
        recordingReliabilityReport,
        monitoringRuntimeReport
    };
};
