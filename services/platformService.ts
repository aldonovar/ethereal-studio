
import {
  DesktopAuthLaunchResult,
  DesktopAuthRequest,
  DesktopOpenEditorRequest,
  DesktopProjectFileResult,
  DesktopWindowState,
  DirectoryScanRequest,
  FileData,
  ScannedFileEntry,
  SelectedAudioFile,
} from '../types';
import { desktopRuntimeService } from './desktopRuntimeService';
import { sha256Blob, sha256Buffer } from './storage/blobDigestService';

const MAX_PROJECT_BUNDLE_BYTES = 1024 * 1024 * 1024;
const MAX_PROJECT_BUNDLE_CHUNK_BYTES = 4 * 1024 * 1024;

export interface PortableProjectOpenResult {
  blob: Blob;
  filename: string;
}

class PlatformService {
  public isDesktop: boolean;
  public isElectron: boolean;
  public isNativeWindows: boolean;
  public platform: string;

  private toArrayBuffer(data: unknown): ArrayBuffer | null {
    if (!data) return null;

    if (data instanceof ArrayBuffer) {
        return data;
    }

    if (ArrayBuffer.isView(data)) {
      const view = data as Uint8Array;
      return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as any;
    }

    if (typeof data === 'object') {
      const candidate = data as { type?: unknown; data?: unknown };
      if (candidate.type === 'Buffer' && Array.isArray(candidate.data)) {
        return new Uint8Array(candidate.data).buffer;
      }

      const anyData = data as any;
      
      // Handle cross-context Uint8Array where prototypes are lost
      if (typeof anyData.byteLength === 'number') {
          if (anyData.buffer && typeof anyData.buffer.slice === 'function') {
              return anyData.buffer.slice(anyData.byteOffset || 0, (anyData.byteOffset || 0) + anyData.byteLength) as any;
          }
          
          // Electron sometimes sends a Uint8Array proxy that acts like an array
          const len = anyData.byteLength;
          const u8 = new Uint8Array(len);
          for (let i = 0; i < len; i++) {
              u8[i] = anyData[i];
          }
          return u8.buffer;
      }
    }

    console.warn("Failed to convert IPC data to ArrayBuffer. Type is:", typeof data);
    return null;
  }

  constructor() {
    this.isDesktop = desktopRuntimeService.isDesktop;
    this.isElectron = desktopRuntimeService.isElectron;
    this.isNativeWindows = desktopRuntimeService.isNativeWindows;
    this.platform = desktopRuntimeService.platform;
  }

  // --- Window Management ---

  public minimize() {
    const host = desktopRuntimeService.api;
    if (host) {
      host.minimize();
    }
  }

  public maximize() {
    const host = desktopRuntimeService.api;
    if (host) {
      host.maximize();
    }
  }

  public close() {
    const host = desktopRuntimeService.api;
    if (host) {
      host.close();
    }
  }

  public async openEditor(request?: DesktopOpenEditorRequest): Promise<boolean> {
    const host = desktopRuntimeService.api;
    if (!host?.openEditor) {
      return false;
    }

    try {
      const result = await host.openEditor(request);
      return result.success;
    } catch (error) {
      console.error('Unable to open editor', error);
      return false;
    }
  }

  public async showHub(): Promise<boolean> {
    const host = desktopRuntimeService.api;
    if (!host?.showHub) {
      return false;
    }

    try {
      const result = await host.showHub();
      return result.success;
    } catch (error) {
      console.error('Unable to show hub', error);
      return false;
    }
  }

  public async openDesktopAuth(request?: DesktopAuthRequest): Promise<DesktopAuthLaunchResult> {
    const host = desktopRuntimeService.api;
    if (!host?.openDesktopAuth) {
      return {
        success: false,
        error: 'Desktop auth bridge is only available inside Electron.',
      };
    }

    try {
      return await host.openDesktopAuth(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Unable to open desktop auth bridge', error);
      return { success: false, error: message };
    }
  }

  public async cancelDesktopAuth(): Promise<boolean> {
    const host = desktopRuntimeService.api;
    if (!host?.cancelDesktopAuth) return false;

    try {
      const result = await host.cancelDesktopAuth();
      return result.success;
    } catch (error) {
      console.error('Unable to cancel desktop auth', error);
      return false;
    }
  }

  public async openExternalUrl(url: string): Promise<boolean> {
    const host = desktopRuntimeService.api;
    if (!host?.openExternalUrl) {
      window.open(url, '_blank', 'noopener,noreferrer');
      return true;
    }

    try {
      const result = await host.openExternalUrl(url);
      return result.success;
    } catch (error) {
      console.error('Unable to open external URL', error);
      return false;
    }
  }

  public onHubRefresh(callback: () => void): (() => void) {
    const host = desktopRuntimeService.api;
    if (!host?.onHubRefresh) {
      return () => undefined;
    }

    try {
      return host.onHubRefresh(callback);
    } catch (error) {
      console.error('Unable to subscribe hub refresh', error);
      return () => undefined;
    }
  }

  public async getWindowState(): Promise<DesktopWindowState | null> {
    const host = desktopRuntimeService.api;
    if (!host?.getWindowState) {
      return null;
    }

    try {
      return await host.getWindowState();
    } catch (error) {
      console.error('Unable to read window state', error);
      return null;
    }
  }

  public onWindowStateChange(callback: (state: DesktopWindowState) => void): (() => void) {
    const host = desktopRuntimeService.api;
    if (!host?.onWindowStateChange) {
      return () => undefined;
    }

    try {
      return host.onWindowStateChange(callback);
    } catch (error) {
      console.error('Unable to subscribe window state', error);
      return () => undefined;
    }
  }

  // --- File System ---

  public async selectAudioFiles(): Promise<SelectedAudioFile[] | null> {
    const host = desktopRuntimeService.api;
    if (host) {
      try {
        const files = await host.selectFiles();
        const normalized: SelectedAudioFile[] = [];

        files.forEach((file) => {
          const path = typeof file.path === 'string' ? file.path.trim() : '';
          if (!path) {
            console.warn(`Skipping file without a readable path: ${file.name}`);
            return;
          }

          const rawData: unknown = file.data;
          const data = rawData ? this.toArrayBuffer(rawData) : undefined;

          if (rawData && !data) {
            console.warn(`Skipping file with unsupported binary payload: ${file.name}`);
            return;
          }

          normalized.push({
            name: file.name,
            path,
            size: file.size,
            ...(data ? { data } : {})
          });
        });

        return normalized;
      } catch (error) {
        console.error("Desktop file selection failed", error);
        throw error;
      }
    }
    return null;
  }

  public async readFileFromPath(filePath: string): Promise<FileData | null> {
    const targetPath = filePath.trim();
    if (!targetPath) return null;

    const host = desktopRuntimeService.api;
    if (!host?.readFileFromPath) {
      return null;
    }

    try {
      const file = await host.readFileFromPath(targetPath);
      if (!file) return null;

      const data = this.toArrayBuffer((file as FileData & { data: unknown }).data);
      if (!data) {
        console.warn(`Skipping direct file read with unsupported payload: ${targetPath}`);
        return null;
      }

      return {
        name: file.name,
        path: file.path,
        data
      };
    } catch (error) {
      console.error('Direct file read failed', error);
      return null;
    }
  }

  public async selectDirectory(): Promise<string | null> {
    const host = desktopRuntimeService.api;
    if (host?.selectDirectory) {
      try {
        return await host.selectDirectory();
      } catch (error) {
        console.error('Desktop folder selection failed', error);
        return null;
      }
    }

    return null;
  }

  public async scanDirectoryFiles(directory: string, extensions: string[]): Promise<ScannedFileEntry[]> {
    const host = desktopRuntimeService.api;
    if (host?.scanDirectoryFiles) {
      try {
        const payload: DirectoryScanRequest = { directory, extensions };
        const files = await host.scanDirectoryFiles(payload);
        if (!Array.isArray(files)) return [];

        return files
          .filter((file): file is ScannedFileEntry => {
            return Boolean(file && typeof file.name === 'string' && typeof file.path === 'string');
          })
          .map((file) => ({
            name: file.name,
            path: file.path,
            size: Number.isFinite(file.size) ? Number(file.size) : 0
          }));
      } catch (error) {
        console.error('Directory scan failed', error);
        return [];
      }
    }

    return [];
  }

  public async saveProject(data: string, name: string): Promise<{ success: boolean; filePath?: string }> {
    const safeName = name.replace(/[^a-z0-9\s-_]/gi, '').trim() || "untitled";
    const fileName = `${safeName}.esp`;

    const host = desktopRuntimeService.api;
    if (host) {
      return await host.saveProject(data, fileName);
    } else {
      // Web Fallback
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      return { success: true, filePath: fileName.replace('.esp', '') }; // Web always assumes success
    }
  }

  // Updated to return Text for manual parsing
  public async openProjectFile(): Promise<{ text: string, filename: string } | null> {
    const host = desktopRuntimeService.api;
    if (host) {
      try {
        return await host.openProject();
      } catch (error) {
        console.error("Desktop open project failed", error);
        return null;
      }
    }

    // Web Fallback
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.esp';
      let resolved = false;

      input.onchange = async (event: Event) => {
        resolved = true;
        const target = event.target as HTMLInputElement;
        const file = target.files?.[0];
        if (!file) {
          resolve(null);
          return;
        }

        try {
          const text = await file.text();
          resolve({ text, filename: file.name });
        } catch (err) {
          console.error("Error reading project file", err);
          alert("Error de lectura de disco.");
          resolve(null);
        }
      };

      // Detect cancel: when the file dialog closes without selection,
      // the window regains focus. We use a delayed focus check to resolve null.
      const onFocusBack = () => {
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            resolve(null);
          }
        }, 300);
        window.removeEventListener('focus', onFocusBack);
      };
      window.addEventListener('focus', onFocusBack);

      input.click();
    });
  }

  public async savePortableProject(bundle: Blob, name: string): Promise<DesktopProjectFileResult> {
    if (!(bundle instanceof Blob) || bundle.size <= 0 || bundle.size > MAX_PROJECT_BUNDLE_BYTES) {
      throw new Error('El proyecto portable está vacío o supera 1 GiB.');
    }

    const safeName = name.replace(/[^a-z0-9\s-_]/gi, '').trim() || 'Sin-titulo';
    const fileName = `${safeName}.esp`;
    const host = desktopRuntimeService.api;
    if (!host) {
      const url = URL.createObjectURL(bundle);
      try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = fileName;
        anchor.click();
        return { success: true, filePath: safeName };
      } finally {
        URL.revokeObjectURL(url);
      }
    }

    if (!host.beginProjectSave
      || !host.writeProjectSaveChunk
      || !host.completeProjectSave
      || !host.cancelProjectSave) {
      throw new Error('Esta instalación de DAW-fi no dispone del canal binario seguro para .esp.');
    }

    const streamSha256 = await sha256Blob(bundle, MAX_PROJECT_BUNDLE_CHUNK_BYTES);
    const started = await host.beginProjectSave({
      defaultName: fileName,
      totalBytes: bundle.size,
      sha256: streamSha256,
    });
    if (started.canceled) return { success: false, canceled: true };
    if (!started.sessionId
      || !Number.isSafeInteger(started.chunkBytes)
      || started.chunkBytes! <= 0
      || started.chunkBytes! > MAX_PROJECT_BUNDLE_CHUNK_BYTES) {
      throw new Error('El proceso principal devolvió una sesión de escritura inválida.');
    }

    const sessionId = started.sessionId;
    const chunkBytes = started.chunkBytes!;
    try {
      let offset = 0;
      while (offset < bundle.size) {
        const end = Math.min(bundle.size, offset + chunkBytes);
        const data = await bundle.slice(offset, end).arrayBuffer();
        const result = await host.writeProjectSaveChunk({
          sessionId,
          offset,
          data,
          sha256: await sha256Buffer(data),
        });
        if (result.nextOffset !== end) {
          throw new Error('El proceso principal no confirmó el bloque .esp completo.');
        }
        offset = result.nextOffset;
      }
      return await host.completeProjectSave({ sessionId });
    } catch (error) {
      await host.cancelProjectSave({ sessionId }).catch(() => undefined);
      throw error;
    }
  }

  public async openPortableProjectFile(): Promise<PortableProjectOpenResult | null> {
    const host = desktopRuntimeService.api;
    if (host) {
      if (!host.beginProjectRead || !host.readProjectChunk || !host.closeProjectRead) {
        throw new Error('Esta instalación de DAW-fi no dispone del canal binario seguro para .esp.');
      }

      const started = await host.beginProjectRead();
      if (!started) return null;
      if (!Number.isSafeInteger(started.totalBytes)
        || started.totalBytes <= 0
        || started.totalBytes > MAX_PROJECT_BUNDLE_BYTES
        || !Number.isSafeInteger(started.chunkBytes)
        || started.chunkBytes <= 0
        || started.chunkBytes > MAX_PROJECT_BUNDLE_CHUNK_BYTES) {
        await host.closeProjectRead({ sessionId: started.sessionId }).catch(() => undefined);
        throw new Error('El proceso principal devolvió metadatos de lectura inválidos.');
      }

      const parts: BlobPart[] = [];
      let offset = 0;
      try {
        while (offset < started.totalBytes) {
          const length = Math.min(started.chunkBytes, started.totalBytes - offset);
          const result = await host.readProjectChunk({
            sessionId: started.sessionId,
            offset,
            length,
          });
          const data = this.toArrayBuffer(result.data);
          if (!data
            || result.offset !== offset
            || result.nextOffset !== offset + data.byteLength
            || data.byteLength !== length) {
            throw new Error('El bloque .esp leído no coincide con la secuencia solicitada.');
          }
          parts.push(data);
          offset = result.nextOffset;
        }
        return {
          blob: new Blob(parts, { type: 'application/vnd.dawfi.project+zip' }),
          filename: started.filename,
        };
      } finally {
        await host.closeProjectRead({ sessionId: started.sessionId }).catch(() => undefined);
      }
    }

    return await new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.esp,application/zip,application/json';
      let resolved = false;
      const finish = (value: PortableProjectOpenResult | null) => {
        if (resolved) return;
        resolved = true;
        window.removeEventListener('focus', onFocusBack);
        resolve(value);
      };
      const onFocusBack = () => {
        setTimeout(() => {
          if (!resolved) finish(null);
        }, 300);
      };
      input.onchange = () => {
        const file = input.files?.[0];
        finish(file ? { blob: file, filename: file.name } : null);
      };
      window.addEventListener('focus', onFocusBack);
      input.click();
    });
  }
}

export const platformService = new PlatformService();
