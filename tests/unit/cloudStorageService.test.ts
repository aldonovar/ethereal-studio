import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/supabase', () => ({
    supabase: {
        auth: { getUser: vi.fn() },
        storage: { from: vi.fn() },
    },
}));

import {
    MAX_CLOUD_AUDIO_OBJECT_BYTES,
    cloudStorageService,
} from '../../services/storage/cloudStorageService';

describe('cloudStorageService preflight', () => {
    it('rejects an object over the real bucket limit before authentication or upload', async () => {
        const oversizedBlob = {
            size: MAX_CLOUD_AUDIO_OBJECT_BYTES + 1,
            type: 'audio/wav',
        } as Blob;

        await expect(cloudStorageService.uploadAudioToCloud(
            'project-1',
            'source-1',
            oversizedBlob,
            'track.wav'
        )).rejects.toThrow('100 MiB');
    });

    it('rejects raw AAC while the project bucket does not allow its MIME', async () => {
        const aacBlob = { size: 8, type: 'audio/aac' } as Blob;

        await expect(cloudStorageService.uploadAudioToCloud(
            'project-1',
            'source-1',
            aacBlob,
            'track.aac'
        )).rejects.toThrow('todavía no admite');
    });
});
