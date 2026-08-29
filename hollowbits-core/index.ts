export const CORE_CONTRACT_VERSION = '2026.05-local-first';
export const PROJECT_SCHEMA_VERSION = '3.0-reference';

/**
 * The public product map is deliberately independent from a browser or
 * Electron runtime.  Both clients consume this same contract so a link to a
 * DAW-fi surface does not silently create an isolated product or identity.
 */
export type DawfiSurface = 'site' | 'studio' | 'documentation' | 'desktop';

export const DAWFI_CANONICAL_ORIGINS = {
  site: 'https://www.hollowbits.com',
  studio: 'https://play.hollowbits.com',
} as const;

export const DAWFI_DOCUMENTATION_PATH = '/docs';

export const DAWFI_STUDIO_PATHS = [
  '/login',
  '/signup',
  '/console',
  '/settings',
  '/engine',
  '/score',
  '/keys',
] as const;

export const DAWFI_SURFACES: Readonly<Record<DawfiSurface, {
  label: string;
  canonicalOrigin: string | null;
  path: string;
  requiresBrowser: boolean;
}>> = {
  site: {
    label: 'DAW-fi',
    canonicalOrigin: DAWFI_CANONICAL_ORIGINS.site,
    path: '/',
    requiresBrowser: true,
  },
  studio: {
    label: 'DAW-fi Studio',
    canonicalOrigin: DAWFI_CANONICAL_ORIGINS.studio,
    path: '/console',
    requiresBrowser: true,
  },
  documentation: {
    label: 'DAW-fi Documentation',
    canonicalOrigin: DAWFI_CANONICAL_ORIGINS.site,
    path: DAWFI_DOCUMENTATION_PATH,
    requiresBrowser: true,
  },
  desktop: {
    label: 'DAW-fi Desktop',
    canonicalOrigin: null,
    path: '/',
    requiresBrowser: false,
  },
};

export const isSafeDawfiPath = (value: string | null | undefined): value is string =>
  typeof value === 'string'
  && value.startsWith('/')
  && !value.startsWith('//')
  && !value.includes('\\')
  && !/[\r\n]/.test(value);

export const toDawfiSurfaceUrl = (
  surface: Exclude<DawfiSurface, 'desktop'>,
  path = DAWFI_SURFACES[surface].path,
): string => {
  const definition = DAWFI_SURFACES[surface];
  const safePath = isSafeDawfiPath(path) ? path : definition.path;
  return `${definition.canonicalOrigin}${safePath}`;
};

export type Tier = 'free' | 'pro' | 'studio';
export type WorkspaceRole = 'owner' | 'admin' | 'editor' | 'commenter' | 'viewer';
export type UsageMetric =
  | 'storage_bytes'
  | 'ai_action'
  | 'render_minutes'
  | 'sample_claim'
  | 'collaborator_seat'
  | 'snapshot';

export type StorageBucket =
  | 'project-audio'
  | 'project-stems'
  | 'project-exports'
  | 'asset-library'
  | 'user-avatars';

export const STORAGE_BUCKETS = [
  'project-audio',
  'project-stems',
  'project-exports',
  'asset-library',
  'user-avatars',
] as const satisfies readonly StorageBucket[];

export const STORAGE_BUCKET_SIZE_LIMITS: Record<StorageBucket, number> = {
  'project-audio': 100 * 1024 * 1024,
  'project-stems': 200 * 1024 * 1024,
  'project-exports': 500 * 1024 * 1024,
  'asset-library': 250 * 1024 * 1024,
  'user-avatars': 5 * 1024 * 1024,
};

export interface TierLimits {
  storageBytes: number;
  maxCollaborators: number;
  aiRequestsPerMonth: number;
  renderMinutesPerMonth: number;
  sampleDownloadsPerMonth: number;
  sampleClaimsPerMonth: number;
  maxPublishedTracks: number;
  snapshotRetentionDays: number;
  apiWebhookCallsPerMonth: number;
  maxSampleRate: 96000 | 192000;
  maxExportBitDepth: 24 | 32;
}

export interface FeatureFlags {
  vstBridge: boolean;
  stemExport: boolean;
  batchExport: boolean;
  aiMixAnalysis: boolean;
  aiMastering: boolean;
  aiStemSeparation: boolean;
  aiLyricSuggestion: boolean;
  cloudRender: boolean;
  projectSnapshots: boolean;
  sampleLibraryAccess: boolean;
  sampleMarketplaceUpload: boolean;
  videoScoring: boolean;
  podcastMode: boolean;
  apiWebhooks: boolean;
  verifiedBadge: boolean;
  customEmbedPlayer: boolean;
  prioritySupport: boolean;
  dedicatedSupport: boolean;
  pitchCorrection: boolean;
  multibandComp: boolean;
  deEsser: boolean;
  ampCabinetSim: boolean;
  advancedAutomation: boolean;
  lufsMetering: boolean;
}

export type FeatureGate = keyof FeatureFlags;

export const TIER_ORDER: Record<Tier, number> = {
  free: 0,
  pro: 1,
  studio: 2,
};

export const TIER_LIMITS: Record<Tier, TierLimits> = {
  free: {
    storageBytes: 5 * 1024 ** 3,
    maxCollaborators: 2,
    aiRequestsPerMonth: 50,
    renderMinutesPerMonth: 0,
    sampleDownloadsPerMonth: 0,
    sampleClaimsPerMonth: 0,
    maxPublishedTracks: 10,
    snapshotRetentionDays: 0,
    apiWebhookCallsPerMonth: 0,
    maxSampleRate: 192000,
    maxExportBitDepth: 24,
  },
  pro: {
    storageBytes: 100 * 1024 ** 3,
    maxCollaborators: 5,
    aiRequestsPerMonth: 500,
    renderMinutesPerMonth: 120,
    sampleDownloadsPerMonth: 500,
    sampleClaimsPerMonth: 500,
    maxPublishedTracks: -1,
    snapshotRetentionDays: 30,
    apiWebhookCallsPerMonth: 0,
    maxSampleRate: 192000,
    maxExportBitDepth: 32,
  },
  studio: {
    storageBytes: 1024 * 1024 ** 3,
    maxCollaborators: 25,
    aiRequestsPerMonth: -1,
    renderMinutesPerMonth: -1,
    sampleDownloadsPerMonth: -1,
    sampleClaimsPerMonth: -1,
    maxPublishedTracks: -1,
    snapshotRetentionDays: -1,
    apiWebhookCallsPerMonth: -1,
    maxSampleRate: 192000,
    maxExportBitDepth: 32,
  },
};

export const TIER_FLAGS: Record<Tier, FeatureFlags> = {
  free: {
    vstBridge: false,
    stemExport: false,
    batchExport: false,
    aiMixAnalysis: false,
    aiMastering: false,
    aiStemSeparation: false,
    aiLyricSuggestion: false,
    cloudRender: false,
    projectSnapshots: false,
    sampleLibraryAccess: false,
    sampleMarketplaceUpload: false,
    videoScoring: false,
    podcastMode: false,
    apiWebhooks: false,
    verifiedBadge: false,
    customEmbedPlayer: false,
    prioritySupport: false,
    dedicatedSupport: false,
    pitchCorrection: false,
    multibandComp: false,
    deEsser: false,
    ampCabinetSim: false,
    advancedAutomation: false,
    lufsMetering: false,
  },
  pro: {
    vstBridge: true,
    stemExport: true,
    batchExport: true,
    aiMixAnalysis: true,
    aiMastering: false,
    aiStemSeparation: false,
    aiLyricSuggestion: true,
    cloudRender: true,
    projectSnapshots: true,
    sampleLibraryAccess: true,
    sampleMarketplaceUpload: false,
    videoScoring: false,
    podcastMode: true,
    apiWebhooks: false,
    verifiedBadge: false,
    customEmbedPlayer: true,
    prioritySupport: true,
    dedicatedSupport: false,
    pitchCorrection: true,
    multibandComp: true,
    deEsser: true,
    ampCabinetSim: true,
    advancedAutomation: true,
    lufsMetering: true,
  },
  studio: {
    vstBridge: true,
    stemExport: true,
    batchExport: true,
    aiMixAnalysis: true,
    aiMastering: true,
    aiStemSeparation: true,
    aiLyricSuggestion: true,
    cloudRender: true,
    projectSnapshots: true,
    sampleLibraryAccess: true,
    sampleMarketplaceUpload: true,
    videoScoring: true,
    podcastMode: true,
    apiWebhooks: true,
    verifiedBadge: true,
    customEmbedPlayer: true,
    prioritySupport: true,
    dedicatedSupport: true,
    pitchCorrection: true,
    multibandComp: true,
    deEsser: true,
    ampCabinetSim: true,
    advancedAutomation: true,
    lufsMetering: true,
  },
};

export interface DeviceParam {
  name: string;
  value: number;
  min: number;
  max: number;
  unit?: string;
}

export interface Device {
  id: string;
  name: string;
  type: 'instrument' | 'effect' | 'eq' | 'vst-loader' | string;
  latencyMs?: number;
  sidechainSourceTrackId?: string;
  params: DeviceParam[];
}

export interface Track {
  id: string;
  name: string;
  type: string;
  sends?: Record<string, number>;
  sendModes?: Record<string, 'pre' | 'post'>;
  groupId?: string;
  vcaGroupId?: string;
  soloSafe?: boolean;
  isFrozen?: boolean;
  frozenBufferSourceId?: string;
  devices?: Device[];
  [key: string]: unknown;
}

export interface ProjectData {
  version: string;
  name: string;
  tracks: Track[];
  transport: Record<string, unknown>;
  audioSettings: Record<string, unknown>;
  createdAt: number;
  lastModified: number;
  scoreWorkspaces?: unknown[];
  assetRefs?: AssetRef[];
  workspaceId?: string;
}

export interface AssetRef {
  id: string;
  bucket: StorageBucket;
  path: string;
  ownerId: string;
  workspaceId?: string;
  projectId?: string;
  hash?: string;
  sizeBytes?: number;
  durationSeconds?: number;
  format?: string;
  sampleRate?: number;
  licenseState?: 'unknown' | 'owned' | 'royalty-free' | 'marketplace-licensed' | 'restricted';
  createdAt?: string;
}

export interface AIAction {
  id: string;
  type:
    | 'stem_split'
    | 'midi_generate'
    | 'auto_master'
    | 'mix_assist'
    | 'audio_to_midi'
    | 'vocal_tuning';
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  projectId?: string;
  trackId?: string;
  requestedBy: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RenderJob {
  id: string;
  workspaceId?: string;
  projectId: string;
  requestedBy: string;
  kind: 'master' | 'stems' | 'preview';
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  format: 'wav' | 'aiff' | 'flac' | 'mp3';
  bitDepth: 16 | 24 | 32;
  sampleRate: 44100 | 48000 | 88200 | 96000 | 192000;
  inputAssetIds?: string[];
  outputAssetId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export const TRACK_CONTRACT_FIELDS = [
  'sends',
  'sendModes',
  'groupId',
  'vcaGroupId',
  'soloSafe',
  'sidechainSourceTrackId',
  'isFrozen',
  'frozenBufferSourceId',
] as const;

export const ECOSYSTEM_CONTRACT = {
  version: CORE_CONTRACT_VERSION,
  projectSchemaVersion: PROJECT_SCHEMA_VERSION,
  surfaces: DAWFI_SURFACES,
  buckets: STORAGE_BUCKETS,
  tiers: TIER_LIMITS,
  featureFlags: TIER_FLAGS,
  trackContractFields: TRACK_CONTRACT_FIELDS,
} as const;

export const resolveTier = (raw: string | null | undefined): Tier => {
  if (raw === 'pro' || raw === 'studio') return raw;
  return 'free';
};

export const getTierLimits = (tier: Tier): Readonly<TierLimits> => TIER_LIMITS[tier];
export const getLimits = getTierLimits;

export const getTierFlags = (tier: Tier): Readonly<FeatureFlags> => TIER_FLAGS[tier];
export const getFlags = getTierFlags;

export const hasTierFeature = (tier: Tier, flag: FeatureGate): boolean => TIER_FLAGS[tier][flag];
export const hasFeature = hasTierFeature;

export const meetsMinimumTier = (userTier: Tier, requiredTier: Tier): boolean =>
  TIER_ORDER[userTier] >= TIER_ORDER[requiredTier];

export const getRequiredTierName = (flag: FeatureGate): Tier => {
  if (TIER_FLAGS.free[flag]) return 'free';
  if (TIER_FLAGS.pro[flag]) return 'pro';
  return 'studio';
};

export const getFeatureUpgradeTarget = (flag: FeatureGate): Tier => getRequiredTierName(flag);

export const getUsageLimitForMetric = (tier: Tier, metric: UsageMetric): number => {
  const limits = TIER_LIMITS[tier];
  switch (metric) {
    case 'storage_bytes':
      return limits.storageBytes;
    case 'ai_action':
      return limits.aiRequestsPerMonth;
    case 'render_minutes':
      return limits.renderMinutesPerMonth;
    case 'sample_claim':
      return limits.sampleClaimsPerMonth;
    case 'collaborator_seat':
      return limits.maxCollaborators;
    case 'snapshot':
      return limits.snapshotRetentionDays === 0 ? 0 : -1;
    default:
      return 0;
  }
};

export const isWithinQuota = (
  tier: Tier,
  metric: keyof Pick<TierLimits, 'aiRequestsPerMonth' | 'sampleDownloadsPerMonth' | 'renderMinutesPerMonth'>,
  currentValue: number
): boolean => {
  const limit = TIER_LIMITS[tier][metric];
  if (limit === -1) return true;
  return currentValue < limit;
};

export const isAllowedStorageBucket = (bucket: string): bucket is StorageBucket =>
  STORAGE_BUCKETS.includes(bucket as StorageBucket);

export const formatStorageLimit = (bytes: number): string => {
  if (bytes === -1) return 'Ilimitado';
  if (bytes >= 1024 ** 4) return `${Math.round(bytes / 1024 ** 4)} TB`;
  if (bytes >= 1024 ** 3) return `${Math.round(bytes / 1024 ** 3)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${bytes.toLocaleString()} B`;
};

export const formatCountLimit = (value: number, suffix = ''): string => {
  if (value === -1) return 'Ilimitado';
  return `${value.toLocaleString()}${suffix}`;
};

export const formatLimit = (value: number): string => {
  if (value === -1) return 'Ilimitado';
  if (value >= 1024 ** 2) return formatStorageLimit(value);
  return value.toLocaleString();
};

export const formatUsageMetric = (metric: UsageMetric, quantity: number): string => {
  const safeQuantity = Number.isFinite(quantity) ? Math.max(0, quantity) : 0;
  if (metric === 'storage_bytes') return formatStorageLimit(safeQuantity);
  if (metric === 'render_minutes') return `${Number(safeQuantity.toFixed(1)).toLocaleString()} min`;
  return safeQuantity.toLocaleString();
};
