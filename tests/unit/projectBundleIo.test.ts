// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { ProjectBundleIoManager } = require('../../electron/project-bundle-io.cjs') as {
  ProjectBundleIoManager: new (options?: { chunkBytes?: number; fs?: unknown }) => any;
};

const temporaryDirectories: string[] = [];
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dawfi-project-io-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('ProjectBundleIoManager', () => {
  it('writes with ordered backpressure, verifies SHA-256 and preserves a recoverable backup', async () => {
    const directory = await temporaryDirectory();
    const targetPath = join(directory, 'session.esp');
    const previous = Uint8Array.from([9, 9]);
    const bytes = Uint8Array.from([1, 2, 3, 4, 5, 6, 7]);
    await writeFile(targetPath, previous);
    const manager = new ProjectBundleIoManager({ chunkBytes: 4 });
    const started = await manager.beginWrite({
      senderId: 7,
      targetPath,
      totalBytes: bytes.byteLength,
      sha256: digest(bytes),
    });

    let offset = 0;
    for (const chunk of [bytes.slice(0, 4), bytes.slice(4)]) {
      const result = await manager.appendWriteChunk({
        senderId: 7,
        sessionId: started.sessionId,
        offset,
        data: chunk,
        sha256: digest(chunk),
      });
      offset = result.nextOffset;
    }
    const completed = await manager.completeWrite({ senderId: 7, sessionId: started.sessionId });

    expect(new Uint8Array(await readFile(targetPath))).toEqual(bytes);
    expect(completed.backupFileName).toMatch(/^session\.backup-.*\.esp$/);
    expect(new Uint8Array(await readFile(join(directory, completed.backupFileName)))).toEqual(previous);
  });

  it('rejects a mismatched chunk digest and cancellation removes the temporary write', async () => {
    const directory = await temporaryDirectory();
    const targetPath = join(directory, 'session.esp');
    const bytes = Uint8Array.from([1, 2, 3]);
    const manager = new ProjectBundleIoManager({ chunkBytes: 4 });
    const started = await manager.beginWrite({
      senderId: 8,
      targetPath,
      totalBytes: bytes.byteLength,
      sha256: digest(bytes),
    });

    await expect(manager.appendWriteChunk({
      senderId: 8,
      sessionId: started.sessionId,
      offset: 0,
      data: bytes,
      sha256: '0'.repeat(64),
    })).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' });
    await manager.cancelWrite({ senderId: 8, sessionId: started.sessionId });
    await expect(readFile(targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not publish or replace the prior project when the complete stream digest fails', async () => {
    const directory = await temporaryDirectory();
    const targetPath = join(directory, 'session.esp');
    const previous = Uint8Array.from([4, 4, 4]);
    const bytes = Uint8Array.from([1, 2, 3]);
    await writeFile(targetPath, previous);
    const manager = new ProjectBundleIoManager({ chunkBytes: 4 });
    const started = await manager.beginWrite({
      senderId: 10,
      targetPath,
      totalBytes: bytes.byteLength,
      sha256: '0'.repeat(64),
    });
    await manager.appendWriteChunk({
      senderId: 10,
      sessionId: started.sessionId,
      offset: 0,
      data: bytes,
      sha256: digest(bytes),
    });

    await expect(manager.completeWrite({ senderId: 10, sessionId: started.sessionId }))
      .rejects.toMatchObject({ code: 'DIGEST_MISMATCH' });
    expect(new Uint8Array(await readFile(targetPath))).toEqual(previous);
  });

  it('reads exact sequential chunks and rejects out-of-order offsets', async () => {
    const directory = await temporaryDirectory();
    const targetPath = join(directory, 'session.esp');
    const bytes = Uint8Array.from([1, 2, 3, 4, 5]);
    await writeFile(targetPath, bytes);
    const manager = new ProjectBundleIoManager({ chunkBytes: 3 });
    const started = await manager.beginRead({ senderId: 9, filePath: targetPath });
    const first = await manager.readChunk({
      senderId: 9,
      sessionId: started.sessionId,
      offset: 0,
      length: 3,
    });
    expect(new Uint8Array(first.data)).toEqual(bytes.slice(0, 3));
    await expect(manager.readChunk({
      senderId: 9,
      sessionId: started.sessionId,
      offset: 0,
      length: 2,
    })).rejects.toMatchObject({ code: 'INVALID_OFFSET' });
    const second = await manager.readChunk({
      senderId: 9,
      sessionId: started.sessionId,
      offset: first.nextOffset,
      length: 3,
    });
    expect(new Uint8Array(second.data)).toEqual(bytes.slice(3));
    await manager.closeRead({ senderId: 9, sessionId: started.sessionId });
  });

  it('rejects a final-path symlink before opening the selected project', async () => {
    const directory = await temporaryDirectory();
    const realPath = join(directory, 'real-session.esp');
    const symlinkPath = join(directory, 'linked-session.esp');
    await writeFile(realPath, Uint8Array.from([1, 2, 3]));
    await symlink(realPath, symlinkPath);
    const manager = new ProjectBundleIoManager({ chunkBytes: 4 });

    await expect(manager.beginRead({ senderId: 11, filePath: symlinkPath }))
      .rejects.toMatchObject({ code: 'INVALID_PATH' });
  });

  it('closes and rejects a same-size file whose identity changes between lstat and fstat', async () => {
    const directory = await temporaryDirectory();
    const targetPath = join(directory, 'session.esp');
    let handleClosed = false;
    const fsMock = {
      lstat: async () => ({
        isFile: () => true,
        isSymbolicLink: () => false,
        size: 8,
        dev: 13,
        ino: 21,
      }),
      open: async () => ({
        stat: async () => ({
          isFile: () => true,
          size: 8,
          dev: 13,
          ino: 34,
        }),
        close: async () => {
          handleClosed = true;
        },
      }),
    };
    const manager = new ProjectBundleIoManager({ fs: fsMock, chunkBytes: 4 });

    await expect(manager.beginRead({ senderId: 12, filePath: targetPath }))
      .rejects.toMatchObject({ code: 'FILE_CHANGED' });
    expect(handleClosed).toBe(true);
  });
});
