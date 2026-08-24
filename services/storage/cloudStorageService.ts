import { supabase } from '../supabase';
import {
  AUDIO_ASSET_EXTENSIONS,
  resolveCloudAudioUploadFormat,
  type AudioAssetExtension,
} from './audioAssetFormat';

export { MAX_CLOUD_AUDIO_OBJECT_BYTES } from './audioAssetFormat';

class CloudStorageService {
  private readonly BUCKET_NAME = 'project-audio';

  private assertStorageSegment(value: string, label: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
      throw new Error(`Invalid ${label} for project audio storage.`);
    }
    return value;
  }

  private buildAudioPath(projectId: string, fileId: string, extension: AudioAssetExtension): string {
    this.assertStorageSegment(projectId, 'project id');
    this.assertStorageSegment(fileId, 'file id');
    return `${projectId}/${fileId}.${extension}`;
  }

  private async buildScopedAudioPath(
    projectId: string,
    fileId: string,
    extension: AudioAssetExtension,
  ): Promise<string> {
    const { data, error } = await supabase.auth.getUser();
    const userId = data.user?.id;
    if (error || !userId) {
      throw new Error('An authenticated user is required to upload project audio.');
    }
    return `${this.assertStorageSegment(userId, 'user id')}/${this.buildAudioPath(projectId, fileId, extension)}`;
  }

  private async buildDownloadCandidates(projectId: string, fileId: string): Promise<string[]> {
    const { data } = await supabase.auth.getUser();
    const userId = data.user?.id;
    const scoped = userId
      ? AUDIO_ASSET_EXTENSIONS.map((extension) => (
        `${this.assertStorageSegment(userId, 'user id')}/${this.buildAudioPath(projectId, fileId, extension)}`
      ))
      : [];
    const legacy = AUDIO_ASSET_EXTENSIONS.map((extension) => this.buildAudioPath(projectId, fileId, extension));
    return [...scoped, ...legacy];
  }

  public async uploadAudioToCloud(projectId: string, fileId: string, data: Blob, fileName?: string): Promise<string> {
    const { extension, contentType } = resolveCloudAudioUploadFormat(data, fileName);
    const filePath = await this.buildScopedAudioPath(projectId, fileId, extension);

    const { data: uploadData, error } = await supabase.storage
      .from(this.BUCKET_NAME)
      .upload(filePath, data, {
        cacheControl: '31536000',
        upsert: true,
        contentType,
      });

    if (error) {
      console.error('Cloud upload error:', error);
      throw new Error(`Failed to upload to cloud: ${error.message}`);
    }

    return uploadData.path;
  }

  private assertAssetPath(path: string, projectId: string, fileId: string): string {
    const segments = path.split('/');
    const fileName = segments.at(-1) || '';
    const hasExactAudioFileName = AUDIO_ASSET_EXTENSIONS.some(
      (extension) => extension !== 'bin' && fileName === `${fileId}.${extension}`,
    );
    if (
      path.startsWith('/')
      || path.includes('..')
      || path.includes('//')
      || !segments.includes(projectId)
      || segments.some((segment) => !/^[a-zA-Z0-9_.-]+$/.test(segment))
      || !hasExactAudioFileName
    ) {
      throw new Error('Invalid project audio asset path.');
    }
    return path;
  }

  public async downloadAudioFromCloud(projectId: string, fileId: string, assetPath?: string): Promise<Blob> {
    const candidates = assetPath
      ? [this.assertAssetPath(assetPath, projectId, fileId)]
      : await this.buildDownloadCandidates(projectId, fileId);
    let lastError: { message?: string } | null = null;

    for (const filePath of candidates) {
      const { data, error } = await supabase.storage
        .from(this.BUCKET_NAME)
        .download(filePath);

      if (!error && data) {
        return data;
      }

      lastError = error;
    }

    console.error('Cloud download error:', lastError);
    throw new Error(`Failed to download from cloud: ${lastError?.message || 'missing object'}`);
  }
}

export const cloudStorageService = new CloudStorageService();
