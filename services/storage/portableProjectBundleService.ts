import JSZip from 'jszip';
import type { ProjectData } from '../../types.ts';
import { resolveAudioAssetFormat } from './audioAssetFormat.ts';
import { collectProjectAudioSourceRefs } from './projectAudioAssetService.ts';

const MANIFEST_PATH = 'manifest.json';
const AUDIO_DIRECTORY_PATH = 'audio/';
const SAFE_SOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_FILE_SIGNATURE = 0x02014b50;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;
const ZIP_EOCD_MIN_BYTES = 22;
const ZIP_MAX_COMMENT_BYTES = 0xffff;
const PORTABLE_DATE = new Date('1980-01-01T00:00:00.000Z');

const PORTABLE_AUDIO_EXTENSIONS = [
  'wav',
  'mp3',
  'ogg',
  'oga',
  'opus',
  'flac',
  'aif',
  'aiff',
  'webm',
  'm4a',
  'mp4',
  'aac',
] as const;

type PortableAudioExtension = (typeof PORTABLE_AUDIO_EXTENSIONS)[number];

export interface PortableProjectBundleLimits {
  maxArchiveBytes: number;
  maxManifestBytes: number;
  maxAudioFileBytes: number;
  maxTotalAudioBytes: number;
  maxEntries: number;
}

export const DEFAULT_PORTABLE_PROJECT_BUNDLE_LIMITS: Readonly<PortableProjectBundleLimits> = Object.freeze({
  maxArchiveBytes: 1024 * 1024 * 1024,
  maxManifestBytes: 16 * 1024 * 1024,
  maxAudioFileBytes: 512 * 1024 * 1024,
  maxTotalAudioBytes: 1000 * 1024 * 1024,
  maxEntries: 2048,
});

export type PortableProjectBundleErrorCode =
  | 'ARCHIVE_TOO_LARGE'
  | 'AUDIO_TOO_LARGE'
  | 'DUPLICATE_ENTRY'
  | 'DUPLICATE_SOURCE'
  | 'INVALID_ARCHIVE'
  | 'INVALID_ASSET'
  | 'INVALID_MANIFEST'
  | 'INVALID_PATH'
  | 'INVALID_SOURCE_ID'
  | 'MISSING_ASSET'
  | 'UNEXPECTED_ASSET'
  | 'UNSUPPORTED_FORMAT';

export class PortableProjectBundleError extends Error {
  readonly code: PortableProjectBundleErrorCode;

  constructor(code: PortableProjectBundleErrorCode, message: string) {
    super(message);
    this.name = 'PortableProjectBundleError';
    this.code = code;
  }
}

export interface PortableProjectAudioAsset {
  blob: Blob;
  fileName?: string;
}

export type PortableProjectAudioAssetEntries = Iterable<
  readonly [sourceId: string, asset: PortableProjectAudioAsset]
>;

export interface PortableProjectBundleReadResult {
  format: 'portable-zip' | 'legacy-json';
  projectData: ProjectData;
  audioAssets: Map<string, PortableProjectAudioAsset>;
}

export type PortableProjectBundleInput = Blob | ArrayBuffer | Uint8Array | string;

interface ZipEntryMetadata {
  path: string;
  kind: 'manifest' | 'audio' | 'directory';
  sourceId?: string;
  extension?: PortableAudioExtension;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  flags: number;
  compressionMethod: number;
  crc32: number;
}

function fail(code: PortableProjectBundleErrorCode, message: string): never {
  throw new PortableProjectBundleError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBlob(value: unknown): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function assertProjectDataEnvelope(value: unknown): asserts value is ProjectData {
  if (!isRecord(value)
    || typeof value.version !== 'string'
    || value.version.length === 0
    || typeof value.name !== 'string'
    || !Array.isArray(value.tracks)
    || !isRecord(value.transport)
    || !isRecord(value.audioSettings)
    || !isFiniteTimestamp(value.createdAt)
    || !isFiniteTimestamp(value.lastModified)
    || (value.scoreWorkspaces !== undefined && !Array.isArray(value.scoreWorkspaces))
    || (value.assetRefs !== undefined && !Array.isArray(value.assetRefs))
    || (value.workspaceId !== undefined && typeof value.workspaceId !== 'string')) {
    fail('INVALID_MANIFEST', 'El manifiesto no contiene un ProjectData válido.');
  }

  value.tracks.forEach((candidate, index) => {
    if (!isRecord(candidate)
      || typeof candidate.name !== 'string'
      || !Array.isArray(candidate.clips)
      || !Array.isArray(candidate.sessionClips)
      || (candidate.recordingTakes !== undefined && !Array.isArray(candidate.recordingTakes))
      || (candidate.frozenBufferSourceId !== undefined && typeof candidate.frozenBufferSourceId !== 'string')) {
      fail('INVALID_MANIFEST', `La pista ${index + 1} del manifiesto no es válida.`);
    }

    candidate.clips.forEach((clip) => {
      if (!isRecord(clip) || (clip.sourceId !== undefined && typeof clip.sourceId !== 'string')) {
        fail('INVALID_MANIFEST', `La pista ${index + 1} contiene un clip inválido.`);
      }
    });
    candidate.sessionClips.forEach((slot) => {
      if (!isRecord(slot)
        || (slot.clip !== undefined && slot.clip !== null && !isRecord(slot.clip))
        || (isRecord(slot.clip) && slot.clip.sourceId !== undefined && typeof slot.clip.sourceId !== 'string')) {
        fail('INVALID_MANIFEST', `La pista ${index + 1} contiene un slot inválido.`);
      }
    });
    (candidate.recordingTakes || []).forEach((take) => {
      if (!isRecord(take) || (take.sourceId !== undefined && typeof take.sourceId !== 'string')) {
        fail('INVALID_MANIFEST', `La pista ${index + 1} contiene una toma inválida.`);
      }
    });
  });
}

function assertSourceId(sourceId: unknown): asserts sourceId is string {
  if (typeof sourceId !== 'string' || !SAFE_SOURCE_ID.test(sourceId)) {
    fail('INVALID_SOURCE_ID', 'El sourceId debe usar únicamente letras, números, guion o guion bajo (máximo 128 caracteres).');
  }
}

function resolveLimits(overrides?: Partial<PortableProjectBundleLimits>): PortableProjectBundleLimits {
  const limits = { ...DEFAULT_PORTABLE_PROJECT_BUNDLE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      fail('INVALID_ARCHIVE', `El límite ${name} debe ser un entero positivo.`);
    }
  }
  return limits;
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function blobFromBytes(bytes: Uint8Array, type: string): Blob {
  return new Blob([ownedArrayBuffer(bytes)], { type });
}

function utf8Decode(bytes: Uint8Array, context: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail('INVALID_ARCHIVE', `${context} no usa UTF-8 válido.`);
  }
}

function expectedAudioSources(projectData: ProjectData): ReturnType<typeof collectProjectAudioSourceRefs> {
  let refs: ReturnType<typeof collectProjectAudioSourceRefs>;
  try {
    refs = collectProjectAudioSourceRefs(projectData.tracks);
  } catch {
    return fail('INVALID_MANIFEST', 'No se pudieron recorrer las fuentes de audio del manifiesto.');
  }
  refs.forEach(({ sourceId }) => assertSourceId(sourceId));
  return refs;
}

function portableExtension(blob: Blob, fileName?: string): PortableAudioExtension {
  const { extension } = resolveAudioAssetFormat(blob, fileName);
  if (extension === 'bin' || !PORTABLE_AUDIO_EXTENSIONS.includes(extension as PortableAudioExtension)) {
    return fail('UNSUPPORTED_FORMAT', 'No se pudo identificar el formato original del audio; no se inventó ningún codec.');
  }
  return extension as PortableAudioExtension;
}

function assertAudioSize(
  size: number,
  sourceId: string,
  limits: PortableProjectBundleLimits,
): void {
  if (!Number.isSafeInteger(size) || size <= 0) {
    fail('INVALID_ASSET', `La fuente ${sourceId} está vacía o reporta un tamaño inválido.`);
  }
  if (size > limits.maxAudioFileBytes) {
    fail('AUDIO_TOO_LARGE', `La fuente ${sourceId} supera el límite por archivo del proyecto portable.`);
  }
}

function parseManifest(bytes: Uint8Array): ProjectData {
  let parsed: unknown;
  try {
    const text = utf8Decode(bytes, 'El manifiesto').replace(/^\uFEFF/, '');
    parsed = JSON.parse(text);
  } catch (error) {
    if (error instanceof PortableProjectBundleError) throw error;
    return fail('INVALID_MANIFEST', 'El manifest.json no contiene JSON válido.');
  }
  assertProjectDataEnvelope(parsed);
  expectedAudioSources(parsed);
  return parsed;
}

function classifyEntryPath(path: string): Pick<ZipEntryMetadata, 'kind' | 'sourceId' | 'extension'> {
  if (path === MANIFEST_PATH) return { kind: 'manifest' };
  if (path === AUDIO_DIRECTORY_PATH) return { kind: 'directory' };

  const match = /^audio\/([A-Za-z0-9_-]{1,128})\.([a-z0-9]+)$/.exec(path);
  if (!match) {
    return fail('INVALID_PATH', `Ruta no permitida dentro del proyecto portable: ${path || '(vacía)'}.`);
  }
  const sourceId = match[1];
  const extension = match[2] as PortableAudioExtension;
  assertSourceId(sourceId);
  if (!PORTABLE_AUDIO_EXTENSIONS.includes(extension)) {
    return fail('UNSUPPORTED_FORMAT', `Extensión de audio no admitida en el contenedor: ${extension}.`);
  }
  return { kind: 'audio', sourceId, extension };
}

function findEocd(view: DataView): number {
  const minimum = Math.max(0, view.byteLength - ZIP_EOCD_MIN_BYTES - ZIP_MAX_COMMENT_BYTES);
  for (let offset = view.byteLength - ZIP_EOCD_MIN_BYTES; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) !== ZIP_EOCD_SIGNATURE) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + ZIP_EOCD_MIN_BYTES + commentLength === view.byteLength) return offset;
  }
  return fail('INVALID_ARCHIVE', 'No se encontró un directorio ZIP final válido.');
}

function parseZipDirectory(bytes: Uint8Array, limits: PortableProjectBundleLimits): ZipEntryMetadata[] {
  if (bytes.byteLength < ZIP_EOCD_MIN_BYTES) {
    return fail('INVALID_ARCHIVE', 'El archivo es demasiado corto para ser un ZIP válido.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEocd(view);
  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const centralDisk = view.getUint16(eocdOffset + 6, true);
  const entriesOnDisk = view.getUint16(eocdOffset + 8, true);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  const commentLength = view.getUint16(eocdOffset + 20, true);

  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount || commentLength !== 0) {
    return fail('INVALID_ARCHIVE', 'No se admiten ZIP multidisco ni comentarios adjuntos.');
  }
  if (entryCount === ZIP64_SENTINEL_16
    || centralSize === ZIP64_SENTINEL_32
    || centralOffset === ZIP64_SENTINEL_32) {
    return fail('INVALID_ARCHIVE', 'El formato ZIP64 no está admitido para proyectos .esp.');
  }
  if (entryCount > limits.maxEntries) {
    return fail('INVALID_ARCHIVE', 'El proyecto portable contiene demasiadas entradas.');
  }
  if (centralOffset + centralSize !== eocdOffset || centralOffset > eocdOffset) {
    return fail('INVALID_ARCHIVE', 'El directorio central ZIP está fuera de límites.');
  }

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const paths = new Set<string>();
  const sourceIds = new Set<string>();
  const localOffsets = new Set<number>();
  const entries: ZipEntryMetadata[] = [];
  let cursor = centralOffset;
  let totalAudioBytes = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocdOffset || view.getUint32(cursor, true) !== ZIP_CENTRAL_FILE_SIGNATURE) {
      return fail('INVALID_ARCHIVE', 'El directorio central ZIP está truncado o corrupto.');
    }
    const flags = view.getUint16(cursor + 8, true);
    const compressionMethod = view.getUint16(cursor + 10, true);
    const crc32 = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const fileNameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const entryCommentLength = view.getUint16(cursor + 32, true);
    const diskStart = view.getUint16(cursor + 34, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const end = cursor + 46 + fileNameLength + extraLength + entryCommentLength;

    if (end > eocdOffset || fileNameLength === 0 || diskStart !== 0) {
      return fail('INVALID_ARCHIVE', 'Una entrada ZIP tiene metadatos fuera de límites.');
    }
    if ((flags & 0x0001) !== 0) {
      return fail('INVALID_ARCHIVE', 'Los proyectos .esp cifrados no están admitidos.');
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      return fail('INVALID_ARCHIVE', 'El ZIP usa un método de compresión no admitido.');
    }
    if (compressedSize === ZIP64_SENTINEL_32
      || uncompressedSize === ZIP64_SENTINEL_32
      || localHeaderOffset === ZIP64_SENTINEL_32) {
      return fail('INVALID_ARCHIVE', 'El formato ZIP64 no está admitido para proyectos .esp.');
    }

    let path: string;
    try {
      path = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + fileNameLength));
    } catch {
      return fail('INVALID_PATH', 'Una ruta del ZIP no usa UTF-8 válido.');
    }
    if (paths.has(path)) {
      return fail('DUPLICATE_ENTRY', `El ZIP contiene la ruta duplicada ${path}.`);
    }
    paths.add(path);

    const classification = classifyEntryPath(path);
    if (classification.kind === 'manifest' && uncompressedSize > limits.maxManifestBytes) {
      return fail('INVALID_MANIFEST', 'El manifest.json supera el límite permitido.');
    }
    if (classification.kind === 'directory' && (compressedSize !== 0 || uncompressedSize !== 0)) {
      return fail('INVALID_ARCHIVE', 'La entrada de directorio audio/ debe estar vacía.');
    }
    if (classification.kind === 'audio') {
      assertAudioSize(uncompressedSize, classification.sourceId!, limits);
      if (sourceIds.has(classification.sourceId!)) {
        return fail('DUPLICATE_SOURCE', `El ZIP contiene más de un archivo para ${classification.sourceId}.`);
      }
      sourceIds.add(classification.sourceId!);
      totalAudioBytes += uncompressedSize;
      if (!Number.isSafeInteger(totalAudioBytes) || totalAudioBytes > limits.maxTotalAudioBytes) {
        return fail('AUDIO_TOO_LARGE', 'El audio total del proyecto portable supera el límite permitido.');
      }
    }
    if (localOffsets.has(localHeaderOffset)) {
      return fail('DUPLICATE_ENTRY', 'Dos entradas ZIP apuntan al mismo encabezado local.');
    }
    localOffsets.add(localHeaderOffset);

    entries.push({
      path,
      ...classification,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      flags,
      compressionMethod,
      crc32,
    });
    cursor = end;
  }

  if (cursor !== centralOffset + centralSize) {
    return fail('INVALID_ARCHIVE', 'El tamaño del directorio central ZIP no coincide.');
  }
  if (entries.filter((entry) => entry.kind === 'manifest').length !== 1) {
    return fail('INVALID_MANIFEST', 'El ZIP debe contener exactamente un manifest.json.');
  }

  const localRanges = entries.map((entry) => {
    const offset = entry.localHeaderOffset;
    if (offset + 30 > centralOffset || view.getUint32(offset, true) !== ZIP_LOCAL_FILE_SIGNATURE) {
      return fail('INVALID_ARCHIVE', `El encabezado local de ${entry.path} es inválido.`);
    }
    const localFlags = view.getUint16(offset + 6, true);
    const localMethod = view.getUint16(offset + 8, true);
    const localCrc32 = view.getUint32(offset + 14, true);
    const localCompressedSize = view.getUint32(offset + 18, true);
    const localUncompressedSize = view.getUint32(offset + 22, true);
    const localNameLength = view.getUint16(offset + 26, true);
    const localExtraLength = view.getUint16(offset + 28, true);
    const dataOffset = offset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataOffset + entry.compressedSize;
    if (dataEnd > centralOffset) {
      return fail('INVALID_ARCHIVE', `Los datos comprimidos de ${entry.path} están fuera de límites.`);
    }

    let localPath: string;
    try {
      localPath = decoder.decode(bytes.subarray(offset + 30, offset + 30 + localNameLength));
    } catch {
      return fail('INVALID_PATH', 'Una ruta local del ZIP no usa UTF-8 válido.');
    }
    if (localPath !== entry.path) {
      return fail('INVALID_PATH', `La ruta local de ${entry.path} no coincide con el directorio central.`);
    }
    if (localFlags !== entry.flags || localMethod !== entry.compressionMethod) {
      return fail('INVALID_ARCHIVE', `El encabezado local de ${entry.path} no coincide con el directorio central.`);
    }
    if ((localFlags & 0x0008) === 0
      && (localCrc32 !== entry.crc32
        || localCompressedSize !== entry.compressedSize
        || localUncompressedSize !== entry.uncompressedSize)) {
      return fail('INVALID_ARCHIVE', `Los tamaños o CRC locales de ${entry.path} no coinciden con el directorio central.`);
    }
    return { start: offset, end: dataEnd };
  }).sort((left, right) => left.start - right.start);

  if (localRanges.length > 0 && localRanges[0].start !== 0) {
    return fail('INVALID_ARCHIVE', 'El ZIP contiene datos antepuestos no permitidos.');
  }
  for (let index = 1; index < localRanges.length; index += 1) {
    if (localRanges[index].start < localRanges[index - 1].end) {
      return fail('INVALID_ARCHIVE', 'Las entradas ZIP locales se superponen.');
    }
  }
  return entries;
}

async function inputBytes(
  input: PortableProjectBundleInput,
  limits: PortableProjectBundleLimits,
): Promise<Uint8Array> {
  if (typeof input === 'string') {
    if (input.length > limits.maxArchiveBytes) {
      return fail('ARCHIVE_TOO_LARGE', 'El proyecto supera el límite de lectura permitido.');
    }
    const encoded = new TextEncoder().encode(input);
    if (encoded.byteLength > limits.maxArchiveBytes) {
      return fail('ARCHIVE_TOO_LARGE', 'El proyecto supera el límite de lectura permitido.');
    }
    return encoded;
  }

  const byteLength = isBlob(input) ? input.size : input.byteLength;
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
    return fail('INVALID_ARCHIVE', 'El proyecto está vacío o reporta un tamaño inválido.');
  }
  if (byteLength > limits.maxArchiveBytes) {
    return fail('ARCHIVE_TOO_LARGE', 'El proyecto supera el límite de lectura permitido.');
  }
  if (isBlob(input)) return new Uint8Array(await input.arrayBuffer());
  if (input instanceof Uint8Array) return input;
  return new Uint8Array(input);
}

function looksLikeLegacyJson(bytes: Uint8Array): boolean {
  let offset = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (offset < bytes.byteLength
    && (bytes[offset] === 0x20 || bytes[offset] === 0x09 || bytes[offset] === 0x0a || bytes[offset] === 0x0d)) {
    offset += 1;
  }
  return bytes[offset] === 0x7b;
}

function contentTypeForExtension(extension: PortableAudioExtension): string {
  return resolveAudioAssetFormat(
    new Blob([], { type: 'application/octet-stream' }),
    `audio.${extension}`,
  ).contentType;
}

export async function createPortableProjectBundle(
  projectData: ProjectData,
  audioAssetEntries: PortableProjectAudioAssetEntries,
  limitOverrides?: Partial<PortableProjectBundleLimits>,
): Promise<Blob> {
  const limits = resolveLimits(limitOverrides);
  assertProjectDataEnvelope(projectData);
  const expectedRefs = expectedAudioSources(projectData);

  let manifestJson: string;
  try {
    manifestJson = JSON.stringify(projectData);
  } catch {
    return fail('INVALID_MANIFEST', 'El ProjectData no puede serializarse como JSON.');
  }
  const manifestBytes = new TextEncoder().encode(manifestJson);
  if (manifestBytes.byteLength > limits.maxManifestBytes) {
    return fail('INVALID_MANIFEST', 'El manifest.json supera el límite permitido.');
  }

  const provided = new Map<string, PortableProjectAudioAsset>();
  for (const [sourceId, asset] of audioAssetEntries) {
    assertSourceId(sourceId);
    if (provided.has(sourceId)) {
      return fail('DUPLICATE_SOURCE', `Se proporcionó más de una vez la fuente ${sourceId}.`);
    }
    if (!isRecord(asset) || !isBlob(asset.blob)
      || (asset.fileName !== undefined && typeof asset.fileName !== 'string')) {
      return fail('INVALID_ASSET', `La fuente ${sourceId} no contiene un Blob válido.`);
    }
    provided.set(sourceId, asset);
  }

  const expectedIds = new Set(expectedRefs.map((ref) => ref.sourceId));
  for (const sourceId of provided.keys()) {
    if (!expectedIds.has(sourceId)) {
      return fail('UNEXPECTED_ASSET', `La fuente ${sourceId} no está referenciada por el proyecto.`);
    }
  }
  if (expectedRefs.length + 1 > limits.maxEntries) {
    return fail('INVALID_ARCHIVE', 'El proyecto portable contiene demasiadas entradas.');
  }

  const zip = new JSZip();
  zip.file(MANIFEST_PATH, manifestBytes, {
    binary: true,
    compression: 'DEFLATE',
    date: PORTABLE_DATE,
    createFolders: false,
  });

  let totalAudioBytes = 0;
  for (const ref of expectedRefs) {
    const asset = provided.get(ref.sourceId);
    if (!asset) {
      return fail('MISSING_ASSET', `Falta la fuente ${ref.sourceId} requerida por el proyecto.`);
    }
    assertAudioSize(asset.blob.size, ref.sourceId, limits);
    totalAudioBytes += asset.blob.size;
    if (!Number.isSafeInteger(totalAudioBytes) || totalAudioBytes > limits.maxTotalAudioBytes) {
      return fail('AUDIO_TOO_LARGE', 'El audio total del proyecto portable supera el límite permitido.');
    }
    const extension = portableExtension(asset.blob, asset.fileName || ref.fileName);
    const audioBytes = new Uint8Array(await asset.blob.arrayBuffer());
    if (audioBytes.byteLength !== asset.blob.size) {
      return fail('INVALID_ASSET', `No se pudieron leer todos los bytes de ${ref.sourceId}.`);
    }
    zip.file(`audio/${ref.sourceId}.${extension}`, audioBytes, {
      binary: true,
      compression: 'STORE',
      date: PORTABLE_DATE,
      createFolders: false,
    });
  }

  const archiveBytes = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    platform: 'DOS',
  });
  if (archiveBytes.byteLength > limits.maxArchiveBytes) {
    return fail('ARCHIVE_TOO_LARGE', 'El proyecto portable generado supera el límite permitido.');
  }
  return blobFromBytes(archiveBytes, 'application/zip');
}

export async function readPortableProjectBundle(
  input: PortableProjectBundleInput,
  limitOverrides?: Partial<PortableProjectBundleLimits>,
): Promise<PortableProjectBundleReadResult> {
  const limits = resolveLimits(limitOverrides);
  const bytes = await inputBytes(input, limits);

  if (looksLikeLegacyJson(bytes)) {
    if (bytes.byteLength > limits.maxManifestBytes) {
      return fail('INVALID_MANIFEST', 'El proyecto JSON legacy supera el límite permitido.');
    }
    return {
      format: 'legacy-json',
      projectData: parseManifest(bytes),
      audioAssets: new Map(),
    };
  }

  const metadata = parseZipDirectory(bytes, limits);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: false });
  } catch {
    return fail('INVALID_ARCHIVE', 'El ZIP está corrupto o no pudo verificarse.');
  }

  const manifestMetadata = metadata.find((entry) => entry.kind === 'manifest')!;
  const manifestEntry = zip.file(MANIFEST_PATH);
  if (!manifestEntry) {
    return fail('INVALID_MANIFEST', 'No se encontró manifest.json.');
  }
  const manifestBytes = await manifestEntry.async('uint8array');
  if (manifestBytes.byteLength !== manifestMetadata.uncompressedSize) {
    return fail('INVALID_MANIFEST', 'El tamaño real de manifest.json no coincide con el declarado.');
  }
  const projectData = parseManifest(manifestBytes);
  const expectedRefs = expectedAudioSources(projectData);
  const expectedBySource = new Map(expectedRefs.map((ref) => [ref.sourceId, ref]));
  const audioMetadata = metadata.filter((entry) => entry.kind === 'audio');

  for (const ref of expectedRefs) {
    if (!audioMetadata.some((entry) => entry.sourceId === ref.sourceId)) {
      return fail('MISSING_ASSET', `Falta la fuente ${ref.sourceId} requerida por manifest.json.`);
    }
  }
  for (const entry of audioMetadata) {
    if (!expectedBySource.has(entry.sourceId!)) {
      return fail('UNEXPECTED_ASSET', `La fuente ${entry.sourceId} no está referenciada por manifest.json.`);
    }
  }

  const audioAssets = new Map<string, PortableProjectAudioAsset>();
  for (const entry of audioMetadata) {
    const zipEntry = zip.file(entry.path);
    if (!zipEntry) {
      return fail('INVALID_ARCHIVE', `No se pudo abrir ${entry.path}.`);
    }
    const audioBytes = await zipEntry.async('uint8array');
    if (audioBytes.byteLength !== entry.uncompressedSize) {
      return fail('INVALID_ASSET', `El tamaño real de ${entry.path} no coincide con el declarado.`);
    }
    audioAssets.set(entry.sourceId!, {
      blob: blobFromBytes(audioBytes, contentTypeForExtension(entry.extension!)),
      fileName: expectedBySource.get(entry.sourceId!)?.fileName || entry.path.slice(AUDIO_DIRECTORY_PATH.length),
    });
  }

  return { format: 'portable-zip', projectData, audioAssets };
}
