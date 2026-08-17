
export enum TrackType {
  MIDI = 'MIDI',
  AUDIO = 'AUDIO',
  GROUP = 'GROUP',
  RETURN = 'RETURN',
  MASTER = 'MASTER'
}

export interface Note {
  pitch: number;
  start: number;
  duration: number;
  velocity: number;
}

export type ScoreHand = 'left' | 'right';
export type ScoreWorkspaceMode = 'score' | 'transcribe' | 'correct' | 'compare';

export interface ScoreSourceRef {
  kind: 'midi' | 'audio-derived';
  trackId: string;
  clipId: string;
  derivedMidiTrackId?: string;
  derivedMidiClipId?: string;
}

export interface ScoreNotationOverride {
  id: string;
  noteKey: string;
  hand?: ScoreHand;
  spelling?: string;
  voice?: number;
  tieStart?: boolean;
  tieEnd?: boolean;
  pedal?: boolean;
}

export interface ScoreLayoutPreferences {
  splitRatio: number;
  followTransport: boolean;
  zoom: number;
}

export interface ScoreConfidenceRegion {
  id: string;
  start16th: number;
  end16th: number;
  confidence: number;
  label?: string;
}

export interface ScoreEvent {
  id: string;
  type: 'note' | 'rest' | 'pedal';
  start16th: number;
  duration16th: number;
  voice: number;
  hand: ScoreHand;
  pitch?: number;
  velocity?: number;
  spelling?: string;
  tieStart?: boolean;
  tieEnd?: boolean;
  pedalDown?: boolean;
  confidence?: number;
  sourceNoteKey?: string;
  sourceNoteIndex?: number;
}

export interface ScoreVoice {
  id: string;
  hand: ScoreHand;
  voice: number;
  events: ScoreEvent[];
}

export interface ScoreMeasure {
  index: number;
  start16th: number;
  duration16th: number;
  voices: ScoreVoice[];
  confidence?: number;
}

export interface ScoreDocument {
  id: string;
  title: string;
  bpm: number;
  timeSignature: [number, number];
  total16ths: number;
  sourceNoteCount: number;
  generatedAt: number;
  measures: ScoreMeasure[];
}

export interface ScoreWorkspaceState {
  id: string;
  title: string;
  mode: ScoreWorkspaceMode;
  source: ScoreSourceRef;
  layout: ScoreLayoutPreferences;
  notationOverrides: ScoreNotationOverride[];
  confidenceRegions: ScoreConfidenceRegion[];
  lastAverageConfidence?: number;
  updatedAt: number;
}

export interface Clip {
  id: string;
  name: string;
  color: string;
  notes: Note[];
  start: number; // Start position in bars
  length: number; // in bars
  offset: number; // Start point within the source audio (in bars)
  fadeIn: number; // fade in length in bars
  fadeOut: number; // fade out length in bars
  gain: number; // clip volume (linear 0-1, default 1)
  playbackRate: number; // Playback speed (1 = normal, 0.5 = half speed)
  originalBpm?: number;
  isWarped?: boolean; // [NEW] If true, use Granular Engine for independent Pitch/Time. If false, use Native Buffer.
  transpose?: number; // [NEW] Semitones (+/- 24). Controls Pitch.

  // RUNTIME DATA (Not Saved)
  buffer?: AudioBuffer;
  isOffline?: boolean; // If true, the source file is missing from DB

  // PERSISTENCE (Saved)
  sourceId?: string; // The Hash key to look up in IndexedDB
}

export interface ClipSlot {
  id: string;
  clip: Clip | null;
  isPlaying: boolean;
  isQueued: boolean;
}

export interface Device {
  id: string;
  name: string;
  type: 'instrument' | 'effect' | 'eq' | 'vst-loader';
  latencyMs?: number;
  /** Track ID whose post-fader signal feeds this device's sidechain input (key input). */
  sidechainSourceTrackId?: string;
  params: {
    name: string;
    value: number;
    min: number;
    max: number;
    unit?: string;
  }[];
}

// ============================================================================
// AUTOMATION TYPES
// ============================================================================

export type AutomationCurveType = 'linear' | 'easeIn' | 'easeOut' | 'sCurve' | 'hold';

export interface AutomationPoint {
  id: string;
  time: number; // In bars (e.g., 1.5 = beat 3 of bar 1)
  value: number; // Normalized 0-1
  curveType: AutomationCurveType;
  // Bezier control point offsets for custom curves (optional)
  tangentIn?: { x: number; y: number };
  tangentOut?: { x: number; y: number };
}

export type AutomationParam = 'volume' | 'pan' | 'mute' | 'filterCutoff' | 'filterResonance' | 'reverb' | 'custom';
export type AutomationMode = 'off' | 'read' | 'touch' | 'latch' | 'write';

export interface AutomationLane {
  id: string;
  param: AutomationParam;
  paramName: string; // Display name (e.g., "Volume", "Filter Cutoff")
  color: string; // Hex color for the lane
  isExpanded: boolean;
  points: AutomationPoint[];
  minValue?: number; // Parameter minimum (default 0)
  maxValue?: number; // Parameter maximum (default 1)
}

export interface RecordingTake {
  id: string;
  clipId: string;
  trackId: string;
  laneId: string;
  sourceId?: string;
  startBar: number;
  lengthBars: number;
  offsetBars: number;
  createdAt: number;
  label?: string;
  gain?: number;
  muted?: boolean;
}

export interface CompSegment {
  id: string;
  takeId: string;
  sourceStartBar: number;
  sourceEndBar: number;
  targetStartBar: number;
  fadeInBars?: number;
  fadeOutBars?: number;
}

export interface TakeLane {
  id: string;
  name: string;
  trackId: string;
  isCompLane?: boolean;
  isMuted?: boolean;
  takeIds: string[];
  compSegments?: CompSegment[];
}

export interface PunchRange {
  enabled: boolean;
  inBar: number;
  outBar: number;
  preRollBars?: number;
  countInBars?: number;
}

export interface AudioClipEditorViewState {
  clipId: string;
  isCompClip: boolean;
  isTakeClip: boolean;
  takeId?: string;
  takeLabel?: string;
  takeLaneId?: string;
  takeLaneName?: string;
  compLaneId?: string;
  compSegmentId?: string;
  punchRange?: PunchRange | null;
}

export type RecordingJournalPhase =
  | 'armed'
  | 'start-requested'
  | 'started'
  | 'stop-requested'
  | 'stopped'
  | 'finalized'
  | 'committed'
  | 'failed'
  | 'recovered';

export type RecordingJournalStatus = 'active' | 'committed' | 'failed' | 'recovered';

export interface RecordingJournalEvent {
  phase: RecordingJournalPhase;
  at: number;
  barTime?: number;
  contextTimeSec?: number;
  message?: string;
  details?: Record<string, string | number | boolean | null>;
}

export type MonitoringRouteMode = 'mono' | 'stereo' | 'left' | 'right';

export interface RecordingJournalEntry {
  id: string;
  trackId: string;
  trackName: string;
  createdAt: number;
  updatedAt: number;
  inputDeviceId?: string;
  monitorMode: MonitoringRouteMode;
  status: RecordingJournalStatus;
  clipId?: string;
  takeId?: string;
  sourceId?: string;
  failureReason?: string;
  phases: RecordingJournalEvent[];
}

export interface RecordingCommitResult {
  journalId: string;
  trackId: string;
  clipId: string;
  takeId: string;
  sourceId: string;
  committedAt: number;
  latencyCompensationBars: number;
  monitorMode: MonitoringRouteMode;
}

export interface MonitoringRouteSnapshot {
  trackId: string;
  trackName: string;
  active: boolean;
  mode: MonitoringRouteMode;
  latencyCompensationMs: number;
  monitoringEnabled: boolean;
  sharedInputStream: boolean;
}

export interface Track {
  id: string;
  name: string;
  type: TrackType;
  color: string;
  volume: number;
  pan: number;
  reverb: number;
  transpose: number;
  monitor: 'in' | 'auto' | 'off';
  isMuted: boolean;
  isSoloed: boolean;
  isArmed: boolean;
  inputDeviceId?: string;
  micSettings?: MicSettings;
  sends?: Record<string, number>; // Map of Return Track ID -> Send Amount (linear 0-1, legacy dB accepted)
  sendModes?: Record<string, 'pre' | 'post'>;
  groupId?: string;
  vcaGroupId?: string;
  soloSafe?: boolean;
  automationMode?: AutomationMode;
  /** When true, this track plays back a pre-rendered frozen buffer instead of processing live effects. */
  isFrozen?: boolean;
  /** The IndexedDB/source cache id of the frozen AudioBuffer. */
  frozenBufferSourceId?: string;
  clips: Clip[];
  sessionClips: ClipSlot[];
  devices: Device[];
  automationLanes?: AutomationLane[];
  recordingTakes?: RecordingTake[];
  takeLanes?: TakeLane[];
  activeCompLaneId?: string;
  activeTakeId?: string;
  soloTakeId?: string;
  punchRange?: PunchRange;
}

export type MicInputProfile = 'studio-voice' | 'podcast' | 'raw';
export type MicInputChannelMode = MonitoringRouteMode;

export interface MicSettings {
  profile: MicInputProfile;
  inputGain: number;
  monitoringEnabled: boolean;
  monitoringReverb: boolean;
  monitoringEcho: boolean;
  monitorInputMode?: MicInputChannelMode;
  monitorLatencyCompensationMs?: number;
}

export type LoopMode = 'off' | 'once' | 'infinite';

export interface TransportState {
  isPlaying: boolean;
  isRecording: boolean;
  loopMode: LoopMode;
  isLooping?: boolean; // Legacy project compatibility
  bpm: number;
  timeSignature: [number, number];
  currentBar: number;
  currentBeat: number;
  currentSixteenth: number;
  masterTranspose: number;
  gridSize: number;
  snapToGrid: boolean;
  scaleRoot: number;
  scaleType: 'major' | 'minor' | 'dorian' | 'phrygian' | 'chromatic' | 'pentatonic-major' | 'pentatonic-minor';
}

export interface TransportAuthoritySnapshot {
  capturedAt: number;
  contextState: AudioContextState | 'closed';
  schedulerMode: 'interval' | 'worklet-clock';
  bpm: number;
  currentTimeSec: number;
  currentBarTime: number;
  currentBar: number;
  currentBeat: number;
  currentSixteenth: number;
  isPlaying: boolean;
}

export interface AudioSettings {
  sampleRate: 44100 | 48000 | 88200 | 96000 | 192000;
  bufferSize: 'auto' | 128 | 256 | 512 | 1024 | 2048;
  latencyHint: 'interactive' | 'balanced' | 'playback' | string;
  inputDeviceId?: string;
  outputDeviceId?: string;
  lastFailedOutputDeviceId?: string;
}

export type EngineBackendRoute = 'webaudio' | 'worker-dsp' | 'native-sidecar';

export interface EngineRouteKpiSnapshot {
  route: EngineBackendRoute;
  timestamp: number;
  contextState: AudioContextState | 'closed';
  monitorLatencyMs: number;
  schedulerP95TickDriftMs: number;
  schedulerP99TickDriftMs: number;
  schedulerP99LoopMs: number;
  schedulerCpuLoadP95Percent: number;
  schedulerOverrunRatio: number;
  schedulerUnderrunCount: number;
  schedulerDropoutCount: number;
}

export interface Block1RouteEvaluation {
  route: EngineBackendRoute;
  implementationStatus: 'native' | 'simulated';
  cpuAudioP95Ms: number;
  cpuAudioP95ImprovementRatio: number;
  dropouts: number;
  dropoutReductionRatio: number;
  driftP99Ms: number;
  monitorLatencyP95Ms: number;
  passesGate: boolean;
  notes: string[];
}

export type StudioPerformanceProfile = 'studio' | 'stage-safe';

export interface SessionHealthSnapshot {
  capturedAt: number;
  profile: StudioPerformanceProfile;
  hasRealtimeAudio: boolean;
  cpuAudioP95Percent: number;
  dropoutsDelta: number;
  underrunsDelta: number;
  launchErrorP95Ms: number;
  uiFpsP95: number;
  uiFrameDropRatio: number;
  transportDriftP99Ms: number;
  monitorLatencyP95Ms: number;
}

export interface AudioIncidentWindow {
  active: boolean;
  windowStartedAt: number;
  baselineDropoutCount: number;
  baselineUnderrunCount: number;
  lastCounterChangeAt: number | null;
  dropoutsDeltaWindow: number;
  underrunsDeltaWindow: number;
}

export type TransportPlaybackSessionId = number;

export type VisualPerformanceMode = 'normal' | 'guarded' | 'degraded';
export type DiagnosticsVisibilityMode = 'hidden' | 'debug';

export type VisualPerformanceReasonCode =
  | 'steady'
  | 'idle'
  | 'ui-fps-guarded'
  | 'ui-fps-degraded'
  | 'ui-frame-drop-guarded'
  | 'ui-frame-drop-degraded';

export interface VisualPerformanceSnapshot {
  capturedAt: number;
  uiFpsP95: number;
  frameDropRatio: number;
  hasPlaybackActivity: boolean;
  worstBurstMs: number;
  sampleWindowMs: number;
  hasActiveViewportInteraction: boolean;
}

export interface AutomationRuntimeValue {
  trackId: string;
  volume?: number;
  pan?: number;
  reverb?: number;
}

export interface AutomationRuntimeFrame {
  capturedAt: number;
  barTime: number;
  values: AutomationRuntimeValue[];
}

export interface AutomationPlaybackSnapshot {
  capturedAt: number;
  barTime: number;
  appliedTrackCount: number;
}

export interface LiveCaptureRunConfig {
  tracks: number;
  scenes: number;
  quantizeBars: number;
  durationMinutes: number;
  recordingCycles: number;
  timeoutMs: number;
  seed: number;
}

export type LiveCaptureArtifactType =
  | 'session-launch'
  | 'stress-48x8'
  | 'audio-priority-transitions'
  | 'recording-reliability'
  | 'monitoring-runtime'
  | 'transport-runtime';

export interface LiveCaptureArtifactEnvelope<TPayload = unknown> {
  schemaVersion: 1;
  type: LiveCaptureArtifactType;
  generatedAt: number;
  scenario: {
    name: string;
    tracks: number;
    scenes: number;
    source: 'live-capture';
  };
  summary: Record<string, number | string | boolean>;
  source: 'live-capture';
  payload: TPayload;
}

// LIGHTWEIGHT PROJECT MANIFEST
// Just logic, no binaries.
export interface ProjectData {
  version: string;
  name: string;
  tracks: Track[];
  transport: TransportState;
  audioSettings: AudioSettings;
  scoreWorkspaces?: ScoreWorkspaceState[];
  assetRefs?: unknown[];
  workspaceId?: string;
  createdAt: number;
  lastModified: number;
}

export interface FileData {
  name: string;
  data: ArrayBuffer;
  path?: string;
}

export type ExportAudioFormat = 'wav' | 'aiff' | 'flac' | 'mp3';

export interface AudioTranscodeRequest {
  inputData: ArrayBuffer;
  outputFormat: ExportAudioFormat;
  sampleRate: number;
  bitDepth: 16 | 24 | 32;
}

export interface AudioTranscodeResult {
  success: boolean;
  data?: ArrayBuffer;
  mimeType?: string;
  extension?: ExportAudioFormat;
  error?: string;
}

export interface DirectoryScanRequest {
  directory: string;
  extensions: string[];
}

export interface ScannedFileEntry {
  name: string;
  path: string;
  size: number;
}

export interface DesktopWindowState {
  isMaximized: boolean;
  isMinimized: boolean;
  isFullScreen: boolean;
}

export interface DesktopOpenEditorRequest {
  projectId?: string;
  shareToken?: string;
  localPath?: string;
}

export interface DesktopAuthRequest {
  mode?: 'login' | 'signup';
  prompt?: 'select_account' | 'none';
}

export type DesktopAuthErrorCode =
  | 'AUTH_GOOGLE_PROVIDER_DISABLED'
  | 'AUTH_REDIRECT_NOT_ALLOWED'
  | 'AUTH_CALLBACK_INVALID'
  | 'AUTH_STATE_MISMATCH'
  | 'AUTH_DESKTOP_HANDOFF_EXPIRED'
  | 'AUTH_DESKTOP_HANDOFF_REPLAYED'
  | 'AUTH_NETWORK_UNAVAILABLE'
  | 'AUTH_CONFIGURATION_MISSING'
  | 'AUTH_USER_CANCELLED';

export interface DesktopAuthSessionPayload {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  expires_at?: number;
  token_type?: string;
}

export interface DesktopAuthLaunchResult {
  success: boolean;
  requestId?: string;
  persistence?: 'encrypted' | 'memory';
  errorCode?: DesktopAuthErrorCode;
  error?: string;
}

export interface DesktopAuthCallbackResult extends DesktopAuthLaunchResult {
  session?: DesktopAuthSessionPayload;
}

export interface DesktopHostAPI {
  minimize: () => void;
  maximize: () => void;
  close: () => void;
  getWindowState?: () => Promise<DesktopWindowState>;
  onWindowStateChange?: (callback: (state: DesktopWindowState) => void) => (() => void);
  openEditor?: (request?: DesktopOpenEditorRequest) => Promise<{ success: boolean; error?: string }>;
  showHub?: () => Promise<{ success: boolean; error?: string }>;
  openDesktopAuth?: (request?: DesktopAuthRequest) => Promise<DesktopAuthLaunchResult>;
  cancelDesktopAuth?: () => Promise<{ success: boolean; error?: string }>;
  openExternalUrl?: (url: string) => Promise<{ success: boolean; error?: string }>;
  getPendingAuthCallback?: () => Promise<DesktopAuthCallbackResult | null>;
  onAuthCallback?: (callback: (result: DesktopAuthCallbackResult) => void) => (() => void);
  getPersistedAuthSession?: () => Promise<DesktopAuthSessionPayload | null>;
  persistAuthSession?: (session: DesktopAuthSessionPayload) => Promise<DesktopAuthLaunchResult>;
  clearPersistedAuthSession?: () => Promise<{ success: boolean; error?: string }>;
  onHubRefresh?: (callback: () => void) => (() => void);
  selectFiles: () => Promise<FileData[]>;
  readFileFromPath?: (filePath: string) => Promise<FileData | null>;
  selectDirectory?: () => Promise<string | null>;
  scanDirectoryFiles?: (request: DirectoryScanRequest) => Promise<ScannedFileEntry[]>;
  saveProject: (data: string, filename: string) => Promise<{ success: boolean; filePath?: string }>;
  openProject: () => Promise<{ text: string; filename: string } | null>;
  transcodeAudio?: (request: AudioTranscodeRequest) => Promise<AudioTranscodeResult>;
  onBenchmarkStart?: (callback: (config: LiveCaptureRunConfig) => void) => (() => void);
  publishBenchmarkArtifact?: (
    name: LiveCaptureArtifactType,
    payload: LiveCaptureArtifactEnvelope
  ) => Promise<{ success: boolean; filePath?: string; error?: string }>;
  publishBenchmarkStatus?: (
    status: 'running' | 'success' | 'fail',
    details?: Record<string, unknown>
  ) => Promise<{ success: boolean; error?: string }>;
  platform: string;
}

export interface ElectronAPI extends DesktopHostAPI { }

declare global {
  interface Window {
    electron?: ElectronAPI;
    nativeWindows?: DesktopHostAPI;
  }
}
