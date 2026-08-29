// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  cachePortableProjectAudioAssets,
  PortableProjectAssetCacheError,
} from '../../services/storage/portableProjectAssetCacheService.ts';

const sha1 = (bytes: Uint8Array): string => createHash('sha1').update(bytes).digest('hex');

class TrackedBlob extends Blob {
  constructor(
    private readonly tracker: { active: number; maximum: number },
    bytes: Uint8Array,
  ) {
    super([bytes]);
  }

  override async arrayBuffer(): Promise<ArrayBuffer> {
    this.tracker.active += 1;
    this.tracker.maximum = Math.max(this.tracker.maximum, this.tracker.active);
    await Promise.resolve();
    try {
      return await super.arrayBuffer();
    } finally {
      this.tracker.active -= 1;
    }
  }
}

describe('portableProjectAssetCacheService', () => {
  it('validates all sources first, then persists and verifies one source at a time', async () => {
    const tracker = { active: 0, maximum: 0 };
    const first = Uint8Array.from([1, 2, 3]);
    const second = Uint8Array.from([4, 5, 6, 7]);
    const firstId = sha1(first);
    const secondId = sha1(second);
    const cache = new Map<string, Blob>();
    const saves: string[] = [];

    await cachePortableProjectAudioAssets(new Map([
      [firstId, { blob: new TrackedBlob(tracker, first) }],
      [secondId, { blob: new TrackedBlob(tracker, second) }],
    ]), {
      saveFile: async (blob, buffer) => {
        const id = sha1(new Uint8Array(buffer!));
        saves.push(id);
        cache.set(id, blob);
        return id;
      },
      getFile: async (sourceId) => cache.get(sourceId) || null,
    });

    expect(saves).toEqual([firstId, secondId]);
    expect(tracker.maximum).toBe(1);
  });

  it('does not persist anything when the validation pass finds a corrupt late source', async () => {
    const valid = Uint8Array.from([1]);
    const invalid = Uint8Array.from([2]);
    const saveFile = vi.fn();

    await expect(cachePortableProjectAudioAssets(new Map([
      [sha1(valid), { blob: new Blob([valid]) }],
      [sha1(Uint8Array.from([9])), { blob: new Blob([invalid]) }],
    ]), {
      saveFile,
      getFile: async () => null,
    })).rejects.toBeInstanceOf(PortableProjectAssetCacheError);
    expect(saveFile).not.toHaveBeenCalled();
  });
});
