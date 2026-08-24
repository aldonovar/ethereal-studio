// @vitest-environment node

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');

describe('project hydration memory boundary', () => {
    it('decodes project audio sequentially and reuses buffers by sourceId', () => {
        const start = appSource.indexOf('const hydratedAudioBuffers');
        const end = appSource.indexOf('replaceTracks(rehydratedTracks', start);
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
        const hydrationBlock = appSource.slice(start, end);
        expect(hydrationBlock).toContain('for (const track of projectData.tracks)');
        expect(hydrationBlock).toContain('for (const clip of track.clips)');
        expect(hydrationBlock).toContain('hydratedAudioBuffers.has(clip.sourceId)');
        expect(hydrationBlock).not.toContain('Promise.all');
    });
});
