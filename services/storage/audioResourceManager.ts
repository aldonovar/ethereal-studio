import type { AssetRef } from '@hollowbits/core';
import { projectOsService } from '../projectOsService';
import { cloudStorageService } from './cloudStorageService';
import { localAudioCache } from './localAudioCache';

export interface ProjectAudioAsset {
  blob: Blob;
  fileName?: string;
}

/**
 * Resolves project audio through the local cache first and Supabase Storage
 * second. Explicit cloud saves are transactional from the UI perspective:
 * project metadata is not committed until every referenced source is remote.
 */
class AudioResourceManager {
  public async getAudioBuffer(projectId: string, fileId: string, assetPath?: string): Promise<Blob> {
    const localBlob = await localAudioCache.getAudioLocally(fileId);
    if (localBlob) {
      return localBlob;
    }

    console.info(`[Storage] Cache miss for ${fileId}; downloading project audio.`);
    const cloudBlob = await cloudStorageService.downloadAudioFromCloud(projectId, fileId, assetPath);

    localAudioCache.saveAudioLocally(fileId, cloudBlob).catch((error: unknown) => {
      console.error('[Storage] Failed to cache downloaded audio:', error);
    });

    return cloudBlob;
  }

  public async commitProjectAudio(
    projectId: string,
    workspaceId: string | undefined,
    assets: Map<string, ProjectAudioAsset>,
  ): Promise<AssetRef[]> {
    const entries = Array.from(assets.entries());
    const committed: Array<AssetRef | undefined> = new Array(entries.length);
    const failures: unknown[] = [];
    let nextIndex = 0;

    const commitOne = async (index: number): Promise<void> => {
      const entry = entries[index];
      if (!entry) return;
      const [fileId, asset] = entry;

      try {
        const cloudPath = await cloudStorageService.uploadAudioToCloud(
          projectId,
          fileId,
          asset.blob,
          asset.fileName,
        );
        const assetRecord = await projectOsService.registerAsset({
          bucket: 'project-audio',
          path: cloudPath,
          projectId,
          workspaceId,
          hash: fileId,
          sizeBytes: asset.blob.size,
          format: cloudPath.split('.').pop() || 'bin',
          metadata: {
            source: 'audioResourceManager.commitProjectAudio',
            fileId,
            originalName: asset.fileName,
          },
        });

        committed[index] = {
          id: assetRecord.id,
          bucket: assetRecord.bucket,
          path: assetRecord.path,
          ownerId: assetRecord.owner_id,
          workspaceId: assetRecord.workspace_id || undefined,
          projectId: assetRecord.project_id || undefined,
          hash: assetRecord.hash || fileId,
          sizeBytes: assetRecord.size_bytes,
          durationSeconds: assetRecord.duration_seconds || undefined,
          format: assetRecord.format || undefined,
          sampleRate: assetRecord.sample_rate || undefined,
          licenseState: assetRecord.license_state as AssetRef['licenseState'],
          createdAt: assetRecord.created_at,
        } satisfies AssetRef;
      } catch (error: unknown) {
        console.error(`[Storage] Failed to sync ${fileId} to cloud`, error);
        failures.push(error);
      }
    };

    const workerCount = Math.min(2, entries.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (nextIndex < entries.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        await commitOne(currentIndex);
      }
    }));

    if (failures.length > 0) {
      throw new Error(`No se pudieron sincronizar ${failures.length} de ${entries.length} archivos de audio.`);
    }

    const result = committed.filter((ref): ref is AssetRef => Boolean(ref));
    console.info(`[Storage] Cloud audio sync complete: ${result.length} original assets.`);
    return result;
  }
}

export const audioResourceManager = new AudioResourceManager();
