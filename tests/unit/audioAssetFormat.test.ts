import { describe, expect, it } from 'vitest';
import { resolveAudioAssetFormat } from '../../services/storage/audioAssetFormat';

describe('audioAssetFormat', () => {
    it('preserves browser-decodable audio formats without inventing FLAC bytes', () => {
        expect(resolveAudioAssetFormat(
            new Blob(['mp3'], { type: 'audio/mpeg' }),
            'track.mp3'
        )).toEqual({ extension: 'mp3', contentType: 'audio/mpeg' });

        expect(resolveAudioAssetFormat(
            new Blob(['recording'], { type: 'audio/webm' }),
            'take'
        )).toEqual({ extension: 'webm', contentType: 'audio/webm' });

        expect(resolveAudioAssetFormat(
            new Blob(['opus'], { type: 'audio/opus' }),
            'take.opus'
        )).toEqual({ extension: 'opus', contentType: 'audio/ogg' });
    });

    it('uses a trusted filename extension when the desktop bridge supplies an opaque MIME', () => {
        expect(resolveAudioAssetFormat(
            new Blob(['aiff'], { type: 'application/octet-stream' }),
            'keys.AIFF'
        )).toEqual({ extension: 'aiff', contentType: 'audio/aiff' });
    });

    it('keeps unsupported bytes opaque instead of relabelling them', () => {
        expect(resolveAudioAssetFormat(
            new Blob(['unknown'], { type: 'application/octet-stream' }),
            'take'
        )).toEqual({ extension: 'bin', contentType: 'application/octet-stream' });
    });
});
