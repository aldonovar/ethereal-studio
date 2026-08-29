// @vitest-environment node
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import type { ProjectData } from '../../types.ts';
import {
  createPortableProjectBundle,
  PortableProjectBundleError,
  readPortableProjectBundle,
  type PortableProjectAudioAsset,
} from '../../services/storage/portableProjectBundleService.ts';

function projectFixture(sourceIds: string[] = ['source-a']): ProjectData {
  return {
    version: '1.0.0',
    name: 'Portable session',
    tracks: sourceIds.length === 0 ? [] : [{
      id: 'track-1',
      name: 'Audio',
      clips: sourceIds.map((sourceId, index) => ({
        id: `clip-${index + 1}`,
        name: index === 0 ? 'original.mp3' : `take-${index + 1}.wav`,
        sourceId,
      })),
      sessionClips: [],
      devices: [],
    }],
    transport: { bpm: 120 },
    audioSettings: { sampleRate: 48_000 },
    createdAt: 1,
    lastModified: 2,
  } as unknown as ProjectData;
}

function asset(bytes = new Uint8Array([0x49, 0x44, 0x33, 0x00, 0xff])): PortableProjectAudioAsset {
  return {
    blob: new Blob([bytes], { type: 'audio/mpeg' }),
    fileName: 'original.mp3',
  };
}

async function customZip(
  projectData: ProjectData,
  entries: ReadonlyArray<readonly [string, Uint8Array]>,
): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(projectData), { createFolders: false });
  entries.forEach(([path, bytes]) => zip.file(path, bytes, { createFolders: false }));
  return zip.generateAsync({ type: 'uint8array' });
}

describe('portableProjectBundleService', () => {
  it('round-trips ProjectData and exact original audio bytes in the documented ZIP paths', async () => {
    const projectData = projectFixture();
    const originalBytes = new Uint8Array([0x49, 0x44, 0x33, 0x00, 0xff]);
    const bundle = await createPortableProjectBundle(
      projectData,
      new Map([['source-a', asset(originalBytes)]]),
    );

    const zip = await JSZip.loadAsync(new Uint8Array(await bundle.arrayBuffer()));
    expect(Object.keys(zip.files).sort()).toEqual(['audio/source-a.mp3', 'manifest.json']);
    expect(JSON.parse(await zip.file('manifest.json')!.async('text'))).toEqual(projectData);

    const restored = await readPortableProjectBundle(bundle);
    expect(restored.format).toBe('portable-zip');
    expect(restored.projectData).toEqual(projectData);
    expect(restored.audioAssets.get('source-a')?.fileName).toBe('original.mp3');
    expect(restored.audioAssets.get('source-a')?.blob.type).toBe('audio/mpeg');
    expect(new Uint8Array(await restored.audioAssets.get('source-a')!.blob.arrayBuffer()))
      .toEqual(originalBytes);
  });

  it('reads legacy .esp JSON without pretending that it embeds audio', async () => {
    const projectData = projectFixture();
    const restored = await readPortableProjectBundle(`\uFEFF  ${JSON.stringify(projectData)}`);

    expect(restored.format).toBe('legacy-json');
    expect(restored.projectData).toEqual(projectData);
    expect(restored.audioAssets.size).toBe(0);
  });

  it('rejects missing, extra and duplicate sources before generating a bundle', async () => {
    const projectData = projectFixture();

    await expect(createPortableProjectBundle(projectData, new Map()))
      .rejects.toMatchObject({ code: 'MISSING_ASSET' });
    await expect(createPortableProjectBundle(
      projectData,
      new Map([
        ['source-a', asset()],
        ['source-extra', asset()],
      ]),
    )).rejects.toMatchObject({ code: 'UNEXPECTED_ASSET' });
    await expect(createPortableProjectBundle(projectData, [
      ['source-a', asset()],
      ['source-a', asset()],
    ])).rejects.toMatchObject({ code: 'DUPLICATE_SOURCE' });
  });

  it('rejects unsafe source ids and unknown codecs instead of inventing a file format', async () => {
    await expect(createPortableProjectBundle(
      projectFixture(['../source-a']),
      new Map([['../source-a', asset()]]),
    )).rejects.toMatchObject({ code: 'INVALID_SOURCE_ID' });

    await expect(createPortableProjectBundle(
      projectFixture(),
      new Map([['source-a', {
        blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'application/octet-stream' }),
        fileName: 'unknown',
      }]]),
    )).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
  });

  it('rejects traversal and any undeclared path before JSZip can normalize it', async () => {
    const traversal = await customZip(projectFixture([]), [
      ['../escape.wav', new Uint8Array([1])],
    ]);
    const undeclared = await customZip(projectFixture([]), [
      ['cover.png', new Uint8Array([1])],
    ]);

    await expect(readPortableProjectBundle(traversal))
      .rejects.toMatchObject({ code: 'INVALID_PATH' });
    await expect(readPortableProjectBundle(undeclared))
      .rejects.toMatchObject({ code: 'INVALID_PATH' });
  });

  it('rejects two archive entries that claim the same sourceId', async () => {
    const bundle = await customZip(projectFixture(), [
      ['audio/source-a.wav', new Uint8Array([1])],
      ['audio/source-a.mp3', new Uint8Array([2])],
    ]);

    await expect(readPortableProjectBundle(bundle))
      .rejects.toMatchObject({ code: 'DUPLICATE_SOURCE' });
  });

  it('enforces declared per-file and aggregate size limits during write and read', async () => {
    const projectData = projectFixture();
    await expect(createPortableProjectBundle(
      projectData,
      new Map([['source-a', asset(new Uint8Array([1, 2, 3, 4]))]]),
      { maxAudioFileBytes: 3 },
    )).rejects.toMatchObject({ code: 'AUDIO_TOO_LARGE' });

    const bundle = await customZip(projectData, [
      ['audio/source-a.mp3', new Uint8Array([1, 2, 3, 4])],
    ]);
    await expect(readPortableProjectBundle(bundle, { maxAudioFileBytes: 3 }))
      .rejects.toMatchObject({ code: 'AUDIO_TOO_LARGE' });

    const twoSourceProject = projectFixture(['source-a', 'source-b']);
    await expect(createPortableProjectBundle(
      twoSourceProject,
      new Map([
        ['source-a', asset(new Uint8Array([1, 2]))],
        ['source-b', asset(new Uint8Array([3, 4]))],
      ]),
      { maxAudioFileBytes: 2, maxTotalAudioBytes: 3 },
    )).rejects.toMatchObject({ code: 'AUDIO_TOO_LARGE' });

    const aggregateBundle = await customZip(twoSourceProject, [
      ['audio/source-a.mp3', new Uint8Array([1, 2])],
      ['audio/source-b.wav', new Uint8Array([3, 4])],
    ]);
    await expect(readPortableProjectBundle(aggregateBundle, {
      maxAudioFileBytes: 2,
      maxTotalAudioBytes: 3,
    })).rejects.toMatchObject({ code: 'AUDIO_TOO_LARGE' });
  });

  it('rejects a ZIP whose manifest omits or does not reference its embedded source', async () => {
    const missing = await customZip(projectFixture(), []);
    const extra = await customZip(projectFixture([]), [
      ['audio/source-a.wav', new Uint8Array([1])],
    ]);

    await expect(readPortableProjectBundle(missing))
      .rejects.toMatchObject({ code: 'MISSING_ASSET' });
    await expect(readPortableProjectBundle(extra))
      .rejects.toMatchObject({ code: 'UNEXPECTED_ASSET' });
  });

  it('exposes stable typed error codes for callers without leaking raw ZIP errors', async () => {
    try {
      await readPortableProjectBundle(new Uint8Array([1, 2, 3]));
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(PortableProjectBundleError);
      expect((error as PortableProjectBundleError).code).toBe('INVALID_ARCHIVE');
    }
  });
});
