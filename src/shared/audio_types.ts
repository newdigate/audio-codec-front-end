export interface AudioFileInfo {
  filePath: string;
  fileName: string;
  fileSizeBytes: number;
  sizeBytes?: number;
  durationMs: number;
  sampleRate: number;
  channels: number;
  codec: string;
  status: 'cached' | 'unanalyzed' | 'analyzing' | 'error';
  bpm?: number;
  progressPct?: number;
  errorMessage?: string;
}

export interface LodData {
  downsampleRatio: number;
  chunkCount: number;
  peaks: Int8Array;
  buffer?: ArrayBuffer;
}

export interface BeatMarker {
  timeMs: number;
  barIndex: number;
  beatWithinBar: number;
  isDownbeat: boolean;
  localBpm: number;
}

export interface FileAnalysisData {
  filePath: string;
  fileName: string;
  durationMs: number;
  sampleRate: number;
  channels: number;
  bpm: number;
  confidence: number;
  timeSignature: [number, number];
  lods: LodData[];
  beatMarkers: BeatMarker[];
  beats?: BeatMarker[];
}

export interface BatchProgressUpdate {
  filePath: string;
  progressPct: number;
  bpm?: number;
  status: string;
  durationMs?: number;
  errorMessage?: string;
}

export interface PlaybackState {
  isPlaying: boolean;
  currentMs: number;
}

export interface AudioApi {
  // Folder & File Management
  selectFolder: () => Promise<{ folderPath: string; files: AudioFileInfo[] } | null>;
  scanFolder: (folderPath: string) => Promise<AudioFileInfo[]>;
  loadFileAnalysis: (filePath: string, flatSidecar?: boolean) => Promise<FileAnalysisData | null>;

  // Batch Analysis Controls
  startBatchAnalysis: (folderPath: string, sidecarMode?: boolean) => Promise<void>;
  controlBatchAnalysis: (action: 'pause' | 'resume' | 'cancel') => Promise<boolean | void>;
  onBatchProgress: (callback: (update: BatchProgressUpdate) => void) => () => void;

  // Real-time Playback
  playbackPlay: (filePath: string, startMs?: number) => Promise<boolean>;
  playbackPause: () => Promise<boolean>;
  playbackStop: () => Promise<boolean>;
  playbackSeek: (timeMs: number) => Promise<boolean>;
  playbackSetVolume: (volume: number) => Promise<void>;
  onPlaybackTick: (callback: (state: PlaybackState) => void) => () => void;

  // OS Integration
  revealInFinder: (filePath: string) => Promise<void>;
}

declare global {
  interface Window {
    audioApi: AudioApi;
  }
}
