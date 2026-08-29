// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { IncrementalSha256, sha256Blob } from '../../services/storage/blobDigestService.ts';

const nodeSha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe('blobDigestService', () => {
  it('matches standard SHA-256 vectors across arbitrary update boundaries', () => {
    const bytes = new TextEncoder().encode('abc');
    const hasher = new IncrementalSha256();
    hasher.update(bytes.subarray(0, 1));
    hasher.update(bytes.subarray(1));
    expect(hasher.digestHex()).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes a Blob sequentially without materializing the complete file', async () => {
    const bytes = Uint8Array.from({ length: 10_003 }, (_, index) => index % 251);
    await expect(sha256Blob(new Blob([bytes]), 97)).resolves.toBe(nodeSha256(bytes));
  });
});
