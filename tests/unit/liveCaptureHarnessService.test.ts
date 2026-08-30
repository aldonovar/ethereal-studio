import { describe, expect, it } from 'vitest';
import type { LiveCaptureRunConfig } from '../../types';
import {
    buildTransportRuntimeReport,
    buildLiveCaptureRunConfig,
    buildLiveCaptureStressReport,
    createArtifactEnvelope,
    evaluateTransportSteadyRuntimeSamples
} from '../../services/liveCaptureHarnessService';

describe('liveCaptureHarnessService.buildLiveCaptureRunConfig', () => {
    it('sanitizes and clamps config values', () => {
        const config = buildLiveCaptureRunConfig({
            tracks: -4,
            scenes: 0,
            quantizeBars: 0,
            durationMinutes: -20,
            recordingCycles: -1,
            timeoutMs: 10,
            seed: 0
        });

        expect(config.tracks).toBe(1);
        expect(config.scenes).toBe(1);
        expect(config.quantizeBars).toBe(0.25);
        expect(config.durationMinutes).toBe(1);
        expect(config.recordingCycles).toBe(1);
        expect(config.timeoutMs).toBeGreaterThanOrEqual(60000);
        expect(config.seed).toBe(1);
    });
});

describe('liveCaptureHarnessService.buildLiveCaptureStressReport', () => {
    it('builds mandatory gate structure for strict stress gate', () => {
        const config: LiveCaptureRunConfig = {
            tracks: 48,
            scenes: 8,
            quantizeBars: 1,
            durationMinutes: 90,
            recordingCycles: 1000,
            timeoutMs: 600000,
            seed: 4242
        };

        const launchReport = {
            generatedAt: Date.now(),
            scenario: {
                name: 'session-launch-live-capture',
                tracks: 48,
                scenes: 8,
                quantizeBars: 1,
                source: 'live-capture' as const
            },
            summary: {
                sampleCount: 384,
                lateSampleCount: 0,
                avgLaunchErrorMs: 0.4,
                p95LaunchErrorMs: 1.2,
                p99LaunchErrorMs: 1.8,
                maxLaunchErrorMs: 2,
                gateTargetMs: 2,
                gatePass: true
            },
            samples: []
        };

        const baselineCounters = {
            capturedAt: Date.now(),
            cpuAudioP95Percent: 20,
            dropoutCount: 0,
            underrunCount: 0,
            overrunCount: 0,
            overrunRatio: 0,
            transportDriftP99Ms: 1,
            monitorLatencyP95Ms: 9,
            contextState: 'running' as const
        };
        const finalCounters = {
            ...baselineCounters,
            cpuAudioP95Percent: 32,
            transportDriftP99Ms: 2
        };

        const report = buildLiveCaptureStressReport(config, launchReport, baselineCounters, finalCounters) as {
            scenario: { source: string };
            telemetry: { ui: { fpsP95: number; frameDropRatio: number } };
            gates: { pass: boolean; mandatoryGateKeys: string[]; results: Record<string, { pass: boolean }> };
        };

        expect(report.scenario.source).toBe('live-capture');
        expect(report.gates.mandatoryGateKeys).toContain('launchErrorP95');
        expect(report.gates.mandatoryGateKeys).toContain('visualFps');
        expect(report.gates.results.launchErrorP95.pass).toBe(true);
        expect(report.gates.results.visualFps.pass).toBe(true);
        expect(report.telemetry.ui.fpsP95).toBe(60);
        expect(report.telemetry.ui.frameDropRatio).toBe(0);
        expect(report.gates.pass).toBe(true);
    });
});

describe('liveCaptureHarnessService.createArtifactEnvelope', () => {
    it('produces schema v1 live-capture envelope', () => {
        const config = buildLiveCaptureRunConfig({ tracks: 48, scenes: 8 });
        const envelope = createArtifactEnvelope(
            'session-launch',
            config,
            { sampleCount: 384, gatePass: true },
            { generatedAt: Date.now() }
        );

        expect(envelope.schemaVersion).toBe(1);
        expect(envelope.source).toBe('live-capture');
        expect(envelope.scenario.tracks).toBe(48);
        expect(envelope.type).toBe('session-launch');
    });
});

describe('liveCaptureHarnessService.buildTransportRuntimeReport', () => {
    it('marks the runtime smoke report as passing only when all checkpoints pass', () => {
        const config = buildLiveCaptureRunConfig({ tracks: 48, scenes: 8 });
        const report = buildTransportRuntimeReport(
            config,
            [
                {
                    name: 'play-starts-single-session',
                    pass: true,
                    expected: { isPlaying: true },
                    actual: { isPlaying: true }
                },
                {
                    name: 'pause-clears-active-session',
                    pass: true,
                    expected: { activePlaybackSessionId: 0 },
                    actual: { activePlaybackSessionId: 0 }
                }
            ],
            {
                baselineDropoutCount: 2,
                baselineUnderrunCount: 4,
                finalDropoutCount: 2,
                finalUnderrunCount: 4,
                finalTransportDriftP99Ms: 1.75
            }
        ) as {
            summary: {
                pass: boolean;
                checkpointCount: number;
                failedCheckpointCount: number;
                dropoutsDelta: number;
                underrunsDelta: number;
                driftP99Ms: number;
            };
            telemetry: {
                audio: {
                    driftP99Ms: number;
                };
            };
            commandCounts: {
                playCalls: number;
                pauseCalls: number;
                seekCalls: number;
                stopCalls: number;
            };
        };

        expect(report.summary.pass).toBe(true);
        expect(report.summary.checkpointCount).toBe(2);
        expect(report.summary.failedCheckpointCount).toBe(0);
        expect(report.summary.dropoutsDelta).toBe(0);
        expect(report.summary.underrunsDelta).toBe(0);
        expect(report.summary.driftP99Ms).toBe(1.75);
        expect(report.telemetry.audio.driftP99Ms).toBe(1.75);
        expect(report.commandCounts.playCalls).toBe(3);
        expect(report.commandCounts.pauseCalls).toBe(2);
        expect(report.commandCounts.stopCalls).toBe(2);
    });
});

describe('liveCaptureHarnessService.evaluateTransportSteadyRuntimeSamples', () => {
    it('confirms an isolated runner stall with one healthy steady-state window', () => {
        const evaluation = evaluateTransportSteadyRuntimeSamples([
            {
                activePlaybackSessionId: 3,
                activeSourceCount: 12,
                transportDriftP99Ms: 210.2,
                dropoutCount: 1,
                underrunCount: 1
            },
            {
                activePlaybackSessionId: 3,
                activeSourceCount: 12,
                transportDriftP99Ms: 7.6,
                dropoutCount: 0,
                underrunCount: 0
            }
        ], 12);

        expect(evaluation.pass).toBe(true);
        expect(evaluation.selectedAttemptIndex).toBe(1);
        expect(evaluation.attempts.map((attempt) => attempt.pass)).toEqual([false, true]);
    });

    it('keeps persistent scheduler degradation as a hard failure', () => {
        const evaluation = evaluateTransportSteadyRuntimeSamples([
            {
                activePlaybackSessionId: 3,
                activeSourceCount: 12,
                transportDriftP99Ms: 180,
                dropoutCount: 1,
                underrunCount: 1
            },
            {
                activePlaybackSessionId: 3,
                activeSourceCount: 12,
                transportDriftP99Ms: 140,
                dropoutCount: 1,
                underrunCount: 1
            }
        ], 12);

        expect(evaluation.pass).toBe(false);
        expect(evaluation.selectedAttemptIndex).toBe(1);
        expect(evaluation.attempts.every((attempt) => !attempt.pass)).toBe(true);
    });
});
