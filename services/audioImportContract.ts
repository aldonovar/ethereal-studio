export const AUDIO_IMPORT_EXTENSIONS = [
    'wav',
    'mp3',
    'flac',
    'ogg',
    'oga',
    'opus',
    'aif',
    'aiff',
    'm4a',
    'mp4',
    'aac',
    'webm'
] as const;

export type AudioImportExtension = (typeof AUDIO_IMPORT_EXTENSIONS)[number];

export const AUDIO_IMPORT_ACCEPT = AUDIO_IMPORT_EXTENSIONS
    .map((extension) => `.${extension}`)
    .join(',');

const AUDIO_IMPORT_EXTENSION_SET = new Set<string>(AUDIO_IMPORT_EXTENSIONS);

export const isSupportedAudioImportName = (fileName: string): boolean => {
    const extension = fileName.trim().toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
    return Boolean(extension && AUDIO_IMPORT_EXTENSION_SET.has(extension));
};

export const describeAudioImportFormats = (): string => {
    return 'WAV, MP3, FLAC, OGG/Opus, AIFF, M4A/AAC, MP4 y WebM';
};
