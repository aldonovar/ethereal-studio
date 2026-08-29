import type { PortableProjectAudioAsset } from './portableProjectBundleService';

const SHA1_SOURCE_ID = /^[0-9a-f]{40}$/;

export interface PortableProjectAssetCacheDependencies {
  saveFile: (blob: Blob, knownBuffer?: ArrayBuffer) => Promise<string>;
  getFile: (sourceId: string) => Promise<Blob | null>;
}

export class PortableProjectAssetCacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortableProjectAssetCacheError';
  }
}

async function sha1Buffer(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', buffer);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

async function verifySourceBlob(sourceId: string, blob: Blob): Promise<void> {
  const buffer = await blob.arrayBuffer();
  const actualSourceId = await sha1Buffer(buffer);
  if (actualSourceId !== sourceId) {
    throw new PortableProjectAssetCacheError(
      `La fuente ${sourceId} no coincide con la huella declarada en el proyecto.`,
    );
  }
}

async function persistSourceBlob(
  sourceId: string,
  blob: Blob,
  saveFile: PortableProjectAssetCacheDependencies['saveFile'],
): Promise<void> {
  const buffer = await blob.arrayBuffer();
  const persistedSourceId = await saveFile(blob, buffer);
  if (persistedSourceId !== sourceId) {
    throw new PortableProjectAssetCacheError(
      `IndexedDB rechazó la identidad de la fuente ${sourceId}.`,
    );
  }
}

export async function cachePortableProjectAudioAssets(
  audioAssets: ReadonlyMap<string, PortableProjectAudioAsset>,
  dependencies: PortableProjectAssetCacheDependencies,
): Promise<void> {
  const entries = Array.from(audioAssets.entries());

  // Pass 1 is intentionally sequential and does not persist or retain ArrayBuffers.
  // A corrupt late entry therefore cannot leave a partially imported project cache.
  for (const [sourceId, asset] of entries) {
    if (!SHA1_SOURCE_ID.test(sourceId) || !(asset?.blob instanceof Blob) || asset.blob.size <= 0) {
      throw new PortableProjectAssetCacheError(`La fuente ${sourceId || '(vacía)'} no es válida.`);
    }
    await verifySourceBlob(sourceId, asset.blob);
  }

  // Pass 2 rereads and commits one source at a time. No Promise.all retains all audio buffers.
  for (const [sourceId, asset] of entries) {
    await persistSourceBlob(sourceId, asset.blob, dependencies.saveFile);
    const cachedBlob = await dependencies.getFile(sourceId);
    if (!cachedBlob || cachedBlob.size !== asset.blob.size) {
      throw new PortableProjectAssetCacheError(`No se pudo verificar la fuente ${sourceId} en IndexedDB.`);
    }
    await verifySourceBlob(sourceId, cachedBlob);
  }
}
