// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const bridge = require('../../electron/benchmarkBridge.cjs') as {
    BENCHMARK_FLAG: string;
    parseLiveCaptureConfig: (argv?: string[], env?: Record<string, string>) => Record<string, unknown> | null;
    resolveBenchmarkArtifactPath: (name: string, cwd?: string) => { absolutePath: string } | null;
    sanitizeBenchmarkStatus: (input: unknown) => { status: string; details: Record<string, unknown> } | null;
};

describe('benchmarkBridge.parseLiveCaptureConfig', () => {
    it('returns null when benchmark mode is disabled', () => {
        const config = bridge.parseLiveCaptureConfig(['node', 'electron/main.cjs'], {});
        expect(config).toBeNull();
    });

    it('parses benchmark config from CLI flags', () => {
        const config = bridge.parseLiveCaptureConfig(
            [
                'node',
                'electron/main.cjs',
                bridge.BENCHMARK_FLAG,
                '--benchmark-tracks', '64',
                '--benchmark-scenes', '12',
                '--benchmark-quantize-bars', '2'
            ],
            {}
        );

        expect(config).not.toBeNull();
        expect(config?.tracks).toBe(64);
        expect(config?.scenes).toBe(12);
        expect(config?.quantizeBars).toBe(2);
    });
});

describe('benchmarkBridge.resolveBenchmarkArtifactPath', () => {
    it('resolves whitelisted artifact paths under benchmarks root', () => {
        const resolved = bridge.resolveBenchmarkArtifactPath('session-launch', process.cwd());
        expect(resolved).not.toBeNull();
        expect(resolved?.absolutePath).toContain(path.join('benchmarks', 'session-launch'));
    });

    it('rejects unknown artifact names', () => {
        const resolved = bridge.resolveBenchmarkArtifactPath('unknown-artifact', process.cwd());
        expect(resolved).toBeNull();
    });
});

describe('benchmarkBridge.sanitizeBenchmarkStatus', () => {
    it('accepts running/success/fail statuses', () => {
        expect(bridge.sanitizeBenchmarkStatus({ status: 'running' })?.status).toBe('running');
        expect(bridge.sanitizeBenchmarkStatus({ status: 'success' })?.status).toBe('success');
        expect(bridge.sanitizeBenchmarkStatus({ status: 'fail' })?.status).toBe('fail');
    });

    it('rejects invalid statuses', () => {
        expect(bridge.sanitizeBenchmarkStatus({ status: 'done' })).toBeNull();
    });
});
