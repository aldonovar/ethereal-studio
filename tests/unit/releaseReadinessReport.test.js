// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { RELEASE_CONTRACT, evaluateReleaseReadiness } from '../../scripts/release-readiness-report.mjs';

describe('releaseReadinessReport', () => {
  it('marks the release ready only when gates pass and blocking blocks are done', () => {
    const report = evaluateReleaseReadiness({
      transportGate: {
        pass: true,
        testedFiles: [
          'tests/unit/audioEngineTransportAuthority.test.ts',
          'tests/unit/transportStateService.test.ts',
        ],
      },
      transportRuntimeReport: {
        summary: {
          driftP99Ms: 1.5,
        },
      },
      launchGate: {
        status: 'pass',
        summary: {
          p95LaunchErrorMs: 0.5,
          scenarioTracks: 48,
          scenarioScenes: 8,
        },
      },
      stressReport: {
        scenario: {
          tracks: 48,
          scenes: 8,
          durationMinutes: 90,
        },
        telemetry: {
          audio: {
            driftP99Ms: 1.5,
            monitorLatencyP95Ms: 10,
          },
          ui: {
            fpsP95: 60,
          },
        },
        gates: {
          pass: true,
        },
      },
      recordingGate: {
        status: 'pass',
        summary: {
          attemptedCycles: 1000,
          takeLossCount: 0,
        },
      },
      monitoringGate: {
        status: 'pass',
      },
      monitoringReport: {
        summary: {
          pass: true,
          monitorLatencyP95Ms: 10,
          activeRouteCount: 0,
          pendingFinalizeCount: 0,
        },
      },
      block5Gate: {
        pass: true,
        testedFiles: ['tests/unit/block5EditingRegression.test.ts'],
        summary: {
          attemptedCycles: 1000,
          takeLossCount: 0,
        },
      },
      block6Gate: {
        pass: true,
        testedFiles: ['tests/unit/block6SessionRegression.test.ts'],
        summary: {
          launchGatePass: true,
          stressGatePass: true,
          scenarioTracks: 48,
          scenarioScenes: 8,
          durationMinutes: 90,
          visualFpsP95: 60,
        },
      },
      block7Gate: {
        pass: true,
        testedFiles: ['tests/unit/block7MixerRoutingRegression.test.ts'],
        summary: {
          monitoringGatePass: true,
          testedFiles: 4,
          activeRouteCount: 0,
          pendingFinalizeCount: 0,
          monitorLatencyP95Ms: 10,
        },
      },
      audioPriorityGate: {
        pass: true,
        maxTransitionsInWindow: 0,
      },
      programStatus: {
        blocks: [
          { id: 'block-0', status: 'done', releaseBlocking: true },
          { id: 'block-1', status: 'done', releaseBlocking: true },
        ],
      },
    });

    expect(report.release.targetDate).toBe(RELEASE_CONTRACT.targetDate);
    expect(report.summary.readyForPublicRelease).toBe(true);
    expect(report.summary.overallStatus).toBe('ready');
  });

  it('keeps the release blocked when technical gates fail or blocking blocks remain', () => {
    const report = evaluateReleaseReadiness({
      transportGate: {
        pass: false,
        testedFiles: [
          'tests/unit/audioEngineTransportAuthority.test.ts',
        ],
      },
      launchGate: {
        status: 'pass',
        summary: {
          p95LaunchErrorMs: 3.2,
          scenarioTracks: 48,
          scenarioScenes: 8,
        },
      },
      stressReport: {
        scenario: {
          tracks: 48,
          scenes: 8,
          durationMinutes: 90,
        },
        telemetry: {
          audio: {
            driftP99Ms: 8,
            monitorLatencyP95Ms: 14,
          },
          ui: {
            fpsP95: 52,
          },
        },
        gates: {
          pass: true,
        },
      },
      recordingGate: {
        status: 'pass',
        summary: {
          attemptedCycles: 1000,
          takeLossCount: 0,
        },
      },
      monitoringGate: {
        status: 'fail',
      },
      monitoringReport: {
        summary: {
          pass: false,
          monitorLatencyP95Ms: 14,
          activeRouteCount: 1,
          pendingFinalizeCount: 1,
        },
      },
      block5Gate: {
        pass: false,
        testedFiles: ['tests/unit/block5EditingRegression.test.ts'],
        summary: {
          attemptedCycles: 1000,
          takeLossCount: 0,
        },
      },
      block6Gate: {
        pass: false,
        testedFiles: ['tests/unit/block6SessionRegression.test.ts'],
        summary: {
          launchGatePass: false,
          stressGatePass: false,
          scenarioTracks: 48,
          scenarioScenes: 8,
          durationMinutes: 90,
          visualFpsP95: 52,
        },
      },
      block7Gate: {
        pass: false,
        testedFiles: ['tests/unit/block7MixerRoutingRegression.test.ts'],
        summary: {
          monitoringGatePass: false,
          testedFiles: 4,
          activeRouteCount: 1,
          pendingFinalizeCount: 1,
          monitorLatencyP95Ms: 14,
        },
      },
      audioPriorityGate: {
        pass: true,
        maxTransitionsInWindow: 0,
      },
      programStatus: {
        blocks: [
          { id: 'block-0', status: 'done', releaseBlocking: true },
          { id: 'block-1', status: 'in-progress', releaseBlocking: true },
        ],
      },
    });

    expect(report.summary.readyForPublicRelease).toBe(false);
    expect(report.summary.overallStatus).toBe('blocked');
    expect(report.gates.filter((gate) => gate.status === 'fail').map((gate) => gate.id)).toEqual(
      expect.arrayContaining(['transport-command-contract', 'launch-strict', 'monitoring-runtime-contract', 'block5-editing-regression', 'block6-session-flagship', 'block7-mixer-routing-automation', 'transport-drift', 'monitor-latency', 'visual-fps'])
    );
  });
});
