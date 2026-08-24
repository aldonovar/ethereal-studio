import type { Clip, Track } from '../../types';
import type { AssetRef } from '@hollowbits/core';
import type { ProjectAudioAsset } from './audioResourceManager';
import { AUDIO_ASSET_EXTENSIONS } from './audioAssetFormat';

export interface ProjectAudioSourceRef {
  sourceId: string;
  fileName: string;
}

type UnknownRecord = Record<string, unknown>;

const SAFE_STORAGE_SEGMENT = /^[a-zA-Z0-9_-]+$/;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeStorageSegment(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && SAFE_STORAGE_SEGMENT.test(value);
}

function isSafeProjectAudioPath(path: unknown, projectId: string, sourceId: string): path is string {
  if (typeof path !== 'string' || path.length === 0 || path.startsWith('/') || path.includes('\\')) {
    return false;
  }

  const segments = path.split('/');
  if (segments.length < 2 || segments.some((segment) => segment.length === 0)) {
    return false;
  }

  const directorySegments = segments.slice(0, -1);
  const fileName = segments.at(-1)!;
  return directorySegments.every((segment) => isSafeStorageSegment(segment))
    && directorySegments.includes(projectId)
    && AUDIO_ASSET_EXTENSIONS.some((extension) => extension !== 'bin' && fileName === `${sourceId}.${extension}`);
}

export function isProjectAudioAssetRef(
  value: unknown,
  sourceId: string,
  projectId: string,
  workspaceId?: string,
): value is AssetRef {
  if (!isSafeStorageSegment(sourceId) || !isSafeStorageSegment(projectId) || !isRecord(value)) {
    return false;
  }

  if (
    typeof value.id !== 'string'
    || value.id.length === 0
    || typeof value.ownerId !== 'string'
    || value.ownerId.length === 0
    || value.bucket !== 'project-audio'
    || value.hash !== sourceId
    || value.projectId !== projectId
    || !isSafeProjectAudioPath(value.path, projectId, sourceId)
  ) {
    return false;
  }

  if (value.workspaceId !== undefined && !isSafeStorageSegment(value.workspaceId)) {
    return false;
  }

  return workspaceId === undefined
    || (isSafeStorageSegment(workspaceId) && value.workspaceId === workspaceId);
}

export function getProjectAudioAssetRef(
  assetRefs: unknown[] | null | undefined,
  sourceId: string,
  projectId: string,
  workspaceId?: string,
): AssetRef | undefined {
  if (!Array.isArray(assetRefs)) return undefined;

  for (let index = assetRefs.length - 1; index >= 0; index -= 1) {
    const candidate = assetRefs[index];
    if (isProjectAudioAssetRef(candidate, sourceId, projectId, workspaceId)) {
      return candidate;
    }
  }

  return undefined;
}

export function hasDeclaredProjectAudioAssetRefs(assetRefs: unknown[] | null | undefined): boolean {
  return Array.isArray(assetRefs)
    && assetRefs.some((candidate) => isRecord(candidate) && candidate.bucket === 'project-audio');
}

export interface ResolveProjectAudioBlobInput {
  assetRefs: unknown[] | null | undefined;
  sourceId: string;
  projectId?: string;
  workspaceId?: string;
  getLocalBlob: (sourceId: string) => Promise<Blob | null>;
  downloadCloudBlob: (projectId: string, sourceId: string, assetPath?: string) => Promise<Blob>;
  cacheCloudBlob: (blob: Blob) => Promise<string>;
}

export async function resolveProjectAudioBlob(input: ResolveProjectAudioBlobInput): Promise<Blob | null> {
  const localBlob = await input.getLocalBlob(input.sourceId);
  if (localBlob || !input.projectId) return localBlob;

  const assetRef = getProjectAudioAssetRef(
    input.assetRefs,
    input.sourceId,
    input.projectId,
    input.workspaceId,
  );
  if (hasDeclaredProjectAudioAssetRefs(input.assetRefs) && !assetRef) {
    throw new Error('El manifiesto contiene referencias cloud incompatibles con este clip o proyecto.');
  }

  const cloudBlob = await input.downloadCloudBlob(input.projectId, input.sourceId, assetRef?.path);
  const cachedSourceId = await input.cacheCloudBlob(cloudBlob);
  if (cachedSourceId !== input.sourceId) {
    throw new Error('La fuente cloud no coincide con la huella guardada en el proyecto.');
  }
  return cloudBlob;
}

function isSelfConsistentProjectAudioAssetRef(value: unknown): value is AssetRef {
  if (!isRecord(value) || typeof value.hash !== 'string' || typeof value.projectId !== 'string') {
    return false;
  }
  return isProjectAudioAssetRef(value, value.hash, value.projectId);
}

function isGenericAssetRef(value: unknown): value is AssetRef {
  return isRecord(value)
    && typeof value.id === 'string'
    && value.id.length > 0
    && typeof value.bucket === 'string'
    && value.bucket.length > 0
    && typeof value.path === 'string'
    && value.path.length > 0
    && typeof value.ownerId === 'string'
    && value.ownerId.length > 0;
}

export function mergeProjectAudioAssetRefs(
  existingRefs: unknown[] | null | undefined,
  uploadedRefs: unknown[] | null | undefined,
): AssetRef[] {
  const preservedNonAudio: AssetRef[] = [];
  const merged = new Map<string, AssetRef>();

  if (Array.isArray(existingRefs)) {
    existingRefs.forEach((candidate) => {
      if (!isGenericAssetRef(candidate)) return;
      if (candidate.bucket !== 'project-audio') {
        preservedNonAudio.push(candidate);
        return;
      }
      if (!isSelfConsistentProjectAudioAssetRef(candidate)) return;
      merged.set(`${candidate.projectId}:${candidate.hash}`, candidate);
    });
  }

  if (Array.isArray(uploadedRefs)) {
    uploadedRefs.forEach((candidate) => {
      if (!isSelfConsistentProjectAudioAssetRef(candidate)) {
        throw new Error('Invalid project audio asset reference returned by cloud storage.');
      }
      merged.set(`${candidate.projectId}:${candidate.hash}`, candidate);
    });
  }

  return [...preservedNonAudio, ...merged.values()];
}

function rememberClipSource(refs: Map<string, ProjectAudioSourceRef>, clip: Clip | null | undefined): void {
  if (!clip?.sourceId || refs.has(clip.sourceId)) return;
  refs.set(clip.sourceId, {
    sourceId: clip.sourceId,
    fileName: clip.name || `${clip.sourceId}.bin`,
  });
}

export function collectProjectAudioSourceRefs(tracks: Track[]): ProjectAudioSourceRef[] {
  const refs = new Map<string, ProjectAudioSourceRef>();

  tracks.forEach((track) => {
    track.clips.forEach((clip) => rememberClipSource(refs, clip));
    track.sessionClips.forEach((slot) => rememberClipSource(refs, slot.clip));

    (track.recordingTakes || []).forEach((take) => {
      if (!take.sourceId || refs.has(take.sourceId)) return;
      const matchingClip = track.clips.find((clip) => clip.id === take.clipId);
      refs.set(take.sourceId, {
        sourceId: take.sourceId,
        fileName: matchingClip?.name || take.label || `${track.name}-take.webm`,
      });
    });

    if (track.frozenBufferSourceId && !refs.has(track.frozenBufferSourceId)) {
      refs.set(track.frozenBufferSourceId, {
        sourceId: track.frozenBufferSourceId,
        fileName: `${track.name || 'track'}-frozen.wav`,
      });
    }
  });

  return Array.from(refs.values());
}

export async function loadProjectAudioAssets(
  tracks: Track[],
  getLocalBlob: (sourceId: string) => Promise<Blob | null>,
): Promise<Map<string, ProjectAudioAsset>> {
  const refs = collectProjectAudioSourceRefs(tracks);
  const resolved = await Promise.all(refs.map(async (ref) => ({
    ref,
    blob: await getLocalBlob(ref.sourceId),
  })));

  const missing = resolved.filter((entry) => !entry.blob);
  if (missing.length > 0) {
    throw new Error(`Faltan ${missing.length} fuentes de audio locales; no se publicaron metadatos incompletos.`);
  }

  return new Map(resolved.map(({ ref, blob }) => [
    ref.sourceId,
    { blob: blob!, fileName: ref.fileName },
  ]));
}
