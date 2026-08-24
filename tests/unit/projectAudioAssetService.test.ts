import { describe, expect, it } from 'vitest';
import type { AssetRef } from '@hollowbits/core';
import type { Track } from '../../types';
import {
    collectProjectAudioSourceRefs,
    getProjectAudioAssetRef,
    hasDeclaredProjectAudioAssetRefs,
    loadProjectAudioAssets,
    mergeProjectAudioAssetRefs,
    resolveProjectAudioBlob,
} from '../../services/storage/projectAudioAssetService';

const projectId = 'project-1';
const workspaceId = 'workspace-1';

const assetRef = (hash: string, id = `asset-${hash}`): AssetRef => ({
    id,
    bucket: 'project-audio',
    path: `owner-1/${projectId}/${hash}.wav`,
    ownerId: 'owner-1',
    workspaceId,
    projectId,
    hash,
    sizeBytes: 4,
    licenseState: 'unknown',
    createdAt: '2026-08-24T00:00:00.000Z',
});

const trackFixture = (): Track => ({
    id: 'track-1',
    name: 'Audio',
    type: 'audio',
    color: '#ffffff',
    clips: [
        { id: 'clip-a', name: 'piano.wav', sourceId: 'source-a' },
        { id: 'clip-a-copy', name: 'piano copy.wav', sourceId: 'source-a' },
    ],
    sessionClips: [
        { id: 'slot-a', clip: { id: 'clip-b', name: 'voice.webm', sourceId: 'source-b' } },
    ],
    recordingTakes: [
        { id: 'take-a', clipId: 'clip-a', sourceId: 'source-c', label: 'Take 1' },
    ],
    frozenBufferSourceId: 'source-d',
} as unknown as Track);

describe('projectAudioAssetService', () => {
    it('deduplicates every persisted source surface in a project', () => {
        expect(collectProjectAudioSourceRefs([trackFixture()])).toEqual([
            { sourceId: 'source-a', fileName: 'piano.wav' },
            { sourceId: 'source-b', fileName: 'voice.webm' },
            { sourceId: 'source-c', fileName: 'piano.wav' },
            { sourceId: 'source-d', fileName: 'Audio-frozen.wav' },
        ]);
    });

    it('refuses to publish metadata when a local source is missing', async () => {
        await expect(loadProjectAudioAssets(
            [trackFixture()],
            async (sourceId) => sourceId === 'source-a' ? new Blob(['wav'], { type: 'audio/wav' }) : null
        )).rejects.toThrow('Faltan 3 fuentes');
    });

    it('accepts only a reference scoped to the exact project, workspace and hash', () => {
        const valid = assetRef('source-a');
        expect(getProjectAudioAssetRef([valid], 'source-a', projectId, workspaceId)).toEqual(valid);
        expect(getProjectAudioAssetRef([valid], 'source-b', projectId, workspaceId)).toBeUndefined();
        expect(getProjectAudioAssetRef([valid], 'source-a', 'project-2', workspaceId)).toBeUndefined();
        expect(getProjectAudioAssetRef([valid], 'source-a', projectId, 'workspace-2')).toBeUndefined();
        expect(hasDeclaredProjectAudioAssetRefs([valid])).toBe(true);
        expect(hasDeclaredProjectAudioAssetRefs([{ ...valid, bucket: 'project-exports' }])).toBe(false);
    });

    it('replaces duplicate audio refs while preserving unrelated assets', () => {
        const oldRef = assetRef('source-a', 'old');
        const freshRef = assetRef('source-a', 'fresh');
        const cover: AssetRef = {
            ...assetRef('cover-hash', 'cover'),
            bucket: 'project-exports',
            path: 'owner-1/cover.png',
        };

        expect(mergeProjectAudioAssetRefs([cover, oldRef], [freshRef])).toEqual([cover, freshRef]);
    });

    it('does not touch the network when a modern manifest declares an invalid ref', async () => {
        let downloadCount = 0;
        await expect(resolveProjectAudioBlob({
            assetRefs: [{ ...assetRef('source-a'), projectId: 'project-other' }],
            sourceId: 'source-a',
            projectId,
            workspaceId,
            getLocalBlob: async () => null,
            downloadCloudBlob: async () => {
                downloadCount += 1;
                return new Blob(['wrong']);
            },
            cacheCloudBlob: async () => 'source-a',
        })).rejects.toThrow('referencias cloud incompatibles');
        expect(downloadCount).toBe(0);
    });

    it('downloads an exact valid ref and verifies its cached content hash', async () => {
        const remoteBlob = new Blob(['wav'], { type: 'audio/wav' });
        let requestedPath = '';
        const resolved = await resolveProjectAudioBlob({
            assetRefs: [assetRef('source-a')],
            sourceId: 'source-a',
            projectId,
            workspaceId,
            getLocalBlob: async () => null,
            downloadCloudBlob: async (_project, _source, assetPath) => {
                requestedPath = assetPath || '';
                return remoteBlob;
            },
            cacheCloudBlob: async () => 'source-a',
        });

        expect(resolved).toBe(remoteBlob);
        expect(requestedPath).toBe(`owner-1/${projectId}/source-a.wav`);
    });

    it('rejects downloaded bytes whose computed source id does not match the manifest', async () => {
        await expect(resolveProjectAudioBlob({
            assetRefs: [assetRef('source-a')],
            sourceId: 'source-a',
            projectId,
            workspaceId,
            getLocalBlob: async () => null,
            downloadCloudBlob: async () => new Blob(['tampered']),
            cacheCloudBlob: async () => 'different-hash',
        })).rejects.toThrow('huella guardada');
    });
});
