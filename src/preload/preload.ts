import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import type {
  AudioApi,
  AudioFileInfo,
  BatchProgressUpdate,
  FileAnalysisData,
  PlaybackState,
} from '../shared/audio_types';

export const audioApi: AudioApi = {
  selectFolder: (): Promise<{ folderPath: string; files: AudioFileInfo[] } | null> => {
    return ipcRenderer.invoke('audio:select-folder');
  },

  scanFolder: (folderPath: string): Promise<AudioFileInfo[]> => {
    return ipcRenderer.invoke('audio:scan-folder', folderPath);
  },

  loadFileAnalysis: (filePath: string, flatSidecar?: boolean): Promise<FileAnalysisData | null> => {
    return ipcRenderer.invoke('audio:load-analysis', filePath, flatSidecar);
  },

  invalidateCache: (filePath: string, flatSidecar?: boolean): Promise<boolean> => {
    return ipcRenderer.invoke('audio:invalidate-cache', filePath, flatSidecar);
  },

  reanalyzeFile: (filePath: string, flatSidecar?: boolean): Promise<FileAnalysisData | null> => {
    return ipcRenderer.invoke('audio:reanalyze-file', filePath, flatSidecar);
  },

  getDecoderInfo: (): Promise<{ addonVersion: string; audioCodecsCommit: string; flacMaxBlockSize: number; flacMaxChannels: number }> => {
    return ipcRenderer.invoke('audio:get-decoder-info');
  },

  startBatchAnalysis: (folderPath: string, sidecarMode?: boolean): Promise<void> => {
    return ipcRenderer.invoke('audio:start-batch', folderPath, sidecarMode);
  },

  controlBatchAnalysis: (action: 'pause' | 'resume' | 'cancel'): Promise<boolean | void> => {
    return ipcRenderer.invoke('audio:control-batch', action);
  },

  onBatchProgress: (callback: (update: BatchProgressUpdate) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, update: BatchProgressUpdate) => {
      callback(update);
    };
    ipcRenderer.on('audio:batch-progress', listener);
    return () => {
      ipcRenderer.removeListener('audio:batch-progress', listener);
    };
  },

  playbackPlay: (filePath: string, startMs: number = 0): Promise<boolean> => {
    return ipcRenderer.invoke('audio:playback-play', filePath, startMs);
  },

  playbackPause: (): Promise<boolean> => {
    return ipcRenderer.invoke('audio:playback-pause');
  },

  playbackStop: (): Promise<boolean> => {
    return ipcRenderer.invoke('audio:playback-stop');
  },

  playbackSeek: (timeMs: number): Promise<boolean> => {
    return ipcRenderer.invoke('audio:playback-seek', timeMs);
  },

  playbackSetVolume: (volume: number): Promise<void> => {
    return ipcRenderer.invoke('audio:playback-set-volume', volume);
  },

  onPlaybackTick: (callback: (state: PlaybackState) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, state: PlaybackState) => {
      callback(state);
    };
    ipcRenderer.on('audio:playback-tick', listener);
    return () => {
      ipcRenderer.removeListener('audio:playback-tick', listener);
    };
  },

  revealInFinder: (filePath: string): Promise<void> => {
    return ipcRenderer.invoke('audio:reveal-in-finder', filePath);
  },
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('audioApi', audioApi);
  } catch (error) {
    console.error('Failed to expose audioApi via contextBridge:', error);
  }
} else {
  (window as unknown as { audioApi: AudioApi }).audioApi = audioApi;
}
