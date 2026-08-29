// @vitest-environment node

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { AUDIO_IMPORT_EXTENSIONS, isSupportedAudioImportName } from '../../services/audioImportContract';

interface FfmpegRuntime {
    SUPPORTED_AUDIO_IMPORT_EXTENSIONS: readonly string[];
    resolveFfmpegBinary: (options?: Record<string, unknown>) => string | null;
    runFfmpeg: (binary: string | null, args: string[]) => Promise<void>;
}

interface AudioImportPolicy {
    MAX_AUDIO_IMPORT_FILE_BYTES: number;
    MAX_AUDIO_IMPORT_SELECTION_FILES: number;
    assertAudioImportFileSize: (name: string, size: number) => void;
    assertAudioImportSelectionCount: (count: number) => void;
}

const require = createRequire(import.meta.url);
const runtime = require('../../electron/ffmpeg-runtime.cjs') as FfmpegRuntime;
const importPolicy = require('../../electron/audio-import-policy.cjs') as AudioImportPolicy;

describe('audio import runtime', () => {
    it('keeps the renderer and Electron picker format contracts aligned', () => {
        expect(runtime.SUPPORTED_AUDIO_IMPORT_EXTENSIONS).toEqual([...AUDIO_IMPORT_EXTENSIONS]);
        for (const extension of AUDIO_IMPORT_EXTENSIONS) {
            expect(isSupportedAudioImportName(`track.${extension}`)).toBe(true);
        }
        expect(isSupportedAudioImportName('project.esp')).toBe(false);
    });

    it('rejects a phantom ffmpeg-static path and uses a working PATH fallback', () => {
        const resolved = runtime.resolveFfmpegBinary({
            staticPath: '/missing/ffmpeg',
            fsAccessSync: () => { throw new Error('missing'); },
            spawnSyncImpl: () => ({ error: null, status: 0 })
        });
        expect(resolved).toBe('ffmpeg');
    });

    it('accepts real long stems without allowing unbounded renderer payloads', () => {
        expect(importPolicy.MAX_AUDIO_IMPORT_FILE_BYTES).toBe(512 * 1024 * 1024);
        expect(importPolicy.MAX_AUDIO_IMPORT_SELECTION_FILES).toBe(256);

        expect(() => importPolicy.assertAudioImportFileSize('guia.wav', 279_317_246)).not.toThrow();
        expect(() => importPolicy.assertAudioImportFileSize('sinthe.wav', 277_899_386)).not.toThrow();
        expect(() => importPolicy.assertAudioImportFileSize('oversized.wav', 512 * 1024 * 1024 + 1))
            .toThrow(/512 MB/);
        expect(() => importPolicy.assertAudioImportSelectionCount(15)).not.toThrow();
        expect(() => importPolicy.assertAudioImportSelectionCount(257)).toThrow(/256 pistas/);
    });

    it('transcodes the supported compressed/container matrix to decodable WAV', async () => {
        const staticPath = require('ffmpeg-static') as string | null;
        const binary = runtime.resolveFfmpegBinary({ staticPath });
        expect(binary, 'DAW-fi requires a usable packaged or system FFmpeg runtime').toBeTruthy();

        const directory = await mkdtemp(path.join(tmpdir(), 'dawfi-import-'));
        const sourceWav = path.join(directory, 'source.wav');
        const variants = [
            { extension: 'mp3', codecArgs: ['-c:a', 'libmp3lame'] },
            { extension: 'flac', codecArgs: ['-c:a', 'flac'] },
            { extension: 'ogg', codecArgs: ['-c:a', 'libvorbis'] },
            { extension: 'oga', codecArgs: ['-c:a', 'libvorbis'] },
            { extension: 'opus', codecArgs: ['-c:a', 'libopus'] },
            { extension: 'aif', codecArgs: ['-c:a', 'pcm_s16be'] },
            { extension: 'aiff', codecArgs: ['-c:a', 'pcm_s16be'] },
            { extension: 'm4a', codecArgs: ['-c:a', 'aac'] },
            { extension: 'mp4', codecArgs: ['-c:a', 'aac'] },
            { extension: 'aac', codecArgs: ['-c:a', 'aac', '-f', 'adts'] },
            { extension: 'webm', codecArgs: ['-c:a', 'libopus'] }
        ] as const;

        try {
            await runtime.runFfmpeg(binary, [
                '-y', '-hide_banner', '-loglevel', 'error',
                '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.2',
                '-c:a', 'pcm_s16le', sourceWav
            ]);

            for (const variant of variants) {
                const encoded = path.join(directory, `source.${variant.extension}`);
                const decoded = path.join(directory, `${variant.extension}.wav`);
                await runtime.runFfmpeg(binary, [
                    '-y', '-hide_banner', '-loglevel', 'error', '-i', sourceWav,
                    ...variant.codecArgs, encoded
                ]);
                await runtime.runFfmpeg(binary, [
                    '-y', '-hide_banner', '-loglevel', 'error', '-i', encoded,
                    '-c:a', 'pcm_s16le', decoded
                ]);
                expect((await readFile(decoded)).byteLength, variant.extension).toBeGreaterThan(1024);
            }
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }, 20_000);
});
