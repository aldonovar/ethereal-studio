export const AUDIO_ASSET_EXTENSIONS = [
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
  'bin',
] as const;

export type AudioAssetExtension = (typeof AUDIO_ASSET_EXTENSIONS)[number];

export interface AudioAssetFormat {
  extension: AudioAssetExtension;
  contentType: string;
}

export const MAX_CLOUD_AUDIO_OBJECT_BYTES = 100 * 1024 * 1024;

const CLOUD_AUDIO_CONTENT_TYPES = new Set([
  'audio/ogg',
  'audio/mpeg',
  'audio/flac',
  'audio/wav',
  'audio/aiff',
  'audio/mp4',
  'audio/webm',
]);

const MIME_FORMATS: Record<string, AudioAssetFormat> = {
  'audio/wav': { extension: 'wav', contentType: 'audio/wav' },
  'audio/x-wav': { extension: 'wav', contentType: 'audio/wav' },
  'audio/mpeg': { extension: 'mp3', contentType: 'audio/mpeg' },
  'audio/mp3': { extension: 'mp3', contentType: 'audio/mpeg' },
  'audio/ogg': { extension: 'ogg', contentType: 'audio/ogg' },
  'application/ogg': { extension: 'ogg', contentType: 'audio/ogg' },
  // An .opus file is an Ogg Opus stream. The DAW-fi bucket accepts audio/ogg
  // and browsers decode the original bytes without a fake transcode.
  'audio/opus': { extension: 'opus', contentType: 'audio/ogg' },
  'audio/flac': { extension: 'flac', contentType: 'audio/flac' },
  'audio/x-flac': { extension: 'flac', contentType: 'audio/flac' },
  'audio/aiff': { extension: 'aiff', contentType: 'audio/aiff' },
  'audio/x-aiff': { extension: 'aiff', contentType: 'audio/aiff' },
  'audio/webm': { extension: 'webm', contentType: 'audio/webm' },
  'audio/mp4': { extension: 'm4a', contentType: 'audio/mp4' },
  'audio/x-m4a': { extension: 'm4a', contentType: 'audio/mp4' },
  'audio/aac': { extension: 'aac', contentType: 'audio/aac' },
};

const EXTENSION_CONTENT_TYPES: Record<AudioAssetExtension, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  webm: 'audio/webm',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  bin: 'application/octet-stream',
};

function extensionFromFileName(fileName?: string): AudioAssetExtension | null {
  const rawExtension = fileName?.trim().toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (!rawExtension) return null;
  return AUDIO_ASSET_EXTENSIONS.includes(rawExtension as AudioAssetExtension)
    ? rawExtension as AudioAssetExtension
    : null;
}

export function resolveAudioAssetFormat(blob: Blob, fileName?: string): AudioAssetFormat {
  const normalizedMime = blob.type.trim().toLowerCase().split(';', 1)[0];
  const mimeFormat = MIME_FORMATS[normalizedMime];
  if (mimeFormat) return mimeFormat;

  const extension = extensionFromFileName(fileName) ?? 'bin';
  return {
    extension,
    contentType: EXTENSION_CONTENT_TYPES[extension],
  };
}

export function resolveCloudAudioUploadFormat(blob: Blob, fileName?: string): AudioAssetFormat {
  const format = resolveAudioAssetFormat(blob, fileName);
  if (format.extension === 'bin') {
    throw new Error('Unsupported audio format: the original file type could not be identified.');
  }
  if (blob.size > MAX_CLOUD_AUDIO_OBJECT_BYTES) {
    throw new Error('El archivo supera el límite cloud de 100 MiB. Sigue disponible localmente, pero no se publicaron metadatos incompletos.');
  }
  if (!CLOUD_AUDIO_CONTENT_TYPES.has(format.contentType)) {
    throw new Error(`El formato ${format.extension.toUpperCase()} funciona localmente, pero el bucket cloud todavía no admite su tipo MIME.`);
  }
  return format;
}
