// @vitest-environment node
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ api: {} as Record<string, any> }));

vi.mock('../../services/desktopRuntimeService.ts', () => ({
  desktopRuntimeService: {
    runtime: 'electron',
    api: runtime.api,
    platform: 'linux',
    isDesktop: true,
    isElectron: true,
    isNativeWindows: false,
  },
}));

import { platformService } from '../../services/platformService.ts';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe('platformService portable project bridge', () => {
  beforeEach(() => {
    Object.keys(runtime.api).forEach((key) => delete runtime.api[key]);
  });

  it('writes one acknowledged chunk at a time and declares the complete stream digest', async () => {
    const bytes = Uint8Array.from({ length: 11 }, (_, index) => index + 1);
    const writes: Array<{ offset: number; bytes: Uint8Array; sha256: string }> = [];
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    runtime.api.beginProjectSave = vi.fn(async () => ({
      canceled: false,
      sessionId: '12345678-1234-4123-8123-123456789abc',
      chunkBytes: 4,
    }));
    runtime.api.writeProjectSaveChunk = vi.fn(async (request) => {
      activeWrites += 1;
      maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
      await Promise.resolve();
      const chunk = new Uint8Array(request.data);
      writes.push({ offset: request.offset, bytes: chunk, sha256: request.sha256 });
      activeWrites -= 1;
      return { nextOffset: request.offset + chunk.byteLength };
    });
    runtime.api.completeProjectSave = vi.fn(async () => ({ success: true, filePath: 'session' }));
    runtime.api.cancelProjectSave = vi.fn(async () => ({ success: true }));

    await expect(platformService.savePortableProject(new Blob([bytes]), 'session'))
      .resolves.toMatchObject({ success: true, filePath: 'session' });

    expect(runtime.api.beginProjectSave).toHaveBeenCalledWith(expect.objectContaining({
      totalBytes: bytes.byteLength,
      sha256: sha256(bytes),
    }));
    expect(writes.map((entry) => entry.offset)).toEqual([0, 4, 8]);
    expect(writes.map((entry) => entry.bytes.byteLength)).toEqual([4, 4, 3]);
    expect(writes.every((entry) => entry.sha256 === sha256(entry.bytes))).toBe(true);
    expect(maximumActiveWrites).toBe(1);
  });

  it('reads sequential chunks and always closes the native session', async () => {
    const bytes = Uint8Array.from([7, 8, 9, 10, 11]);
    runtime.api.beginProjectRead = vi.fn(async () => ({
      sessionId: '12345678-1234-4123-8123-123456789abc',
      filename: 'session.esp',
      totalBytes: bytes.byteLength,
      chunkBytes: 2,
    }));
    runtime.api.readProjectChunk = vi.fn(async (request) => {
      const data = bytes.slice(request.offset, request.offset + request.length);
      return {
        offset: request.offset,
        nextOffset: request.offset + data.byteLength,
        data: data.buffer,
      };
    });
    runtime.api.closeProjectRead = vi.fn(async () => ({ success: true }));

    const result = await platformService.openPortableProjectFile();
    expect(result?.filename).toBe('session.esp');
    expect(new Uint8Array(await result!.blob.arrayBuffer())).toEqual(bytes);
    expect(runtime.api.readProjectChunk).toHaveBeenCalledTimes(3);
    expect(runtime.api.closeProjectRead).toHaveBeenCalledTimes(1);
    expect(runtime.api.beginProjectRead).toHaveBeenCalledWith();
  });
});
