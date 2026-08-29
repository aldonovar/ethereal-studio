// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { NativeFileGrantManager } = require('../../electron/native-file-grants.cjs') as {
  NativeFileGrantManager: new (options: Record<string, unknown>) => any;
};

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dawfi-native-grants-'));
  temporaryDirectories.push(directory);
  return directory;
}

const createManager = (maxAudioBytes = 32) => new NativeFileGrantManager({
  audioExtensions: ['wav', 'mp3'],
  scanExtensions: ['wav', 'mp3', 'vst3', 'dll'],
  maxAudioBytes,
  scanLimit: 20,
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('NativeFileGrantManager', () => {
  it('reads only a supported audio file explicitly selected by the same sender', async () => {
    const directory = await temporaryDirectory();
    const audioPath = join(directory, 'take.wav');
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    await writeFile(audioPath, bytes);
    const grants = createManager();

    await expect(grants.readGrantedAudioFile(1, audioPath))
      .rejects.toMatchObject({ code: 'PATH_NOT_GRANTED' });
    const selected = await grants.grantSelectedAudioFile(1, audioPath);
    expect(selected).toMatchObject({ name: 'take.wav', size: bytes.byteLength });
    const opened = await grants.readGrantedAudioFile(1, selected.path);
    expect(new Uint8Array(opened.data)).toEqual(bytes);
    await expect(grants.readGrantedAudioFile(2, selected.path))
      .rejects.toMatchObject({ code: 'PATH_NOT_GRANTED' });
  });

  it('grants supported descendants of a selected root but rejects siblings and unsupported types', async () => {
    const directory = await temporaryDirectory();
    const root = join(directory, 'library');
    const nested = join(root, 'nested');
    const sibling = join(directory, 'outside.wav');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'inside.mp3'), Uint8Array.from([5, 6]));
    await writeFile(join(nested, 'notes.txt'), 'secret');
    await writeFile(sibling, Uint8Array.from([9]));
    const grants = createManager();
    const grantedRoot = await grants.grantDirectory(3, root);

    const inside = await grants.readGrantedAudioFile(3, join(grantedRoot, 'nested', 'inside.mp3'));
    expect(new Uint8Array(inside.data)).toEqual(Uint8Array.from([5, 6]));
    await expect(grants.readGrantedAudioFile(3, sibling))
      .rejects.toMatchObject({ code: 'PATH_NOT_GRANTED' });
    await expect(grants.readGrantedAudioFile(3, join(nested, 'notes.txt')))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_AUDIO' });
  });

  it('scans only allowed extensions inside a granted root and skips symlinks', async () => {
    const directory = await temporaryDirectory();
    const root = join(directory, 'library');
    await mkdir(root);
    const audioPath = join(root, 'piano.wav');
    const textPath = join(root, 'notes.txt');
    const linkedPath = join(root, 'linked.wav');
    await writeFile(audioPath, Uint8Array.from([1, 2]));
    await writeFile(textPath, 'not audio');
    await symlink(audioPath, linkedPath);
    const grants = createManager();
    await expect(grants.scanGrantedDirectory(4, root, ['wav']))
      .rejects.toMatchObject({ code: 'PATH_NOT_GRANTED' });
    await grants.grantDirectory(4, root);

    const files = await grants.scanGrantedDirectory(4, root, ['wav', 'txt']);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ name: 'piano.wav', size: 2 });
    expect(new Uint8Array((await grants.readGrantedAudioFile(4, files[0].path)).data))
      .toEqual(Uint8Array.from([1, 2]));
  });

  it('cleans sender grants and enforces the configured audio size limit', async () => {
    const directory = await temporaryDirectory();
    const audioPath = join(directory, 'large.wav');
    await writeFile(audioPath, Uint8Array.from([1, 2, 3]));
    const grants = createManager(2);
    await expect(grants.grantSelectedAudioFile(5, audioPath))
      .rejects.toMatchObject({ code: 'AUDIO_TOO_LARGE' });

    const smallManager = createManager();
    const selected = await smallManager.grantSelectedAudioFile(5, audioPath);
    smallManager.clearSender(5);
    await expect(smallManager.readGrantedAudioFile(5, selected.path))
      .rejects.toMatchObject({ code: 'PATH_NOT_GRANTED' });
    expect(new Uint8Array(await readFile(audioPath))).toEqual(Uint8Array.from([1, 2, 3]));
  });

  it('rejects a same-size audio file whose identity changes between lstat and fstat', async () => {
    let handleClosed = false;
    const fsMock = {
      lstat: async () => ({
        isFile: () => true,
        isSymbolicLink: () => false,
        size: 4,
        dev: 2,
        ino: 3,
      }),
      realpath: async (value: string) => value,
      open: async () => ({
        stat: async () => ({
          isFile: () => true,
          size: 4,
          dev: 2,
          ino: 9,
        }),
        close: async () => {
          handleClosed = true;
        },
      }),
    };
    const grants = new NativeFileGrantManager({
      fs: fsMock,
      audioExtensions: ['wav'],
      scanExtensions: ['wav'],
      maxAudioBytes: 32,
    });

    await expect(grants.grantSelectedAudioFile(6, '/tmp/raced.wav'))
      .rejects.toMatchObject({ code: 'FILE_CHANGED' });
    expect(handleClosed).toBe(true);
  });
});
