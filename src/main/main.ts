import path from 'path';
import fs from 'fs';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type {
  AudioFileInfo,
  FileAnalysisData,
  PlaybackState,
} from '../shared/audio_types';

let mainWindow: BrowserWindow | null = null;
let nativeAddon: any = null;
let tickerInterval: NodeJS.Timeout | null = null;
let lastPlaybackState: PlaybackState = { isPlaying: false, currentMs: 0 };
let wasPlaying = false;

export function getNativeAddon() {
  if (nativeAddon) return nativeAddon;
  try {
    nativeAddon = require('bindings')('audio_native');
    return nativeAddon;
  } catch {
    const candidates = [
      process.resourcesPath ? path.join(process.resourcesPath, 'build/Release/audio_native.node') : '',
      process.resourcesPath ? path.join(process.resourcesPath, 'app.asar.unpacked/build/Release/audio_native.node') : '',
      process.resourcesPath ? path.join(process.resourcesPath, 'audio_native.node') : '',
      path.join(__dirname, '../../build/Release/audio_native.node'),
      path.join(__dirname, '../build/Release/audio_native.node'),
      path.join(__dirname, 'audio_native.node'),
      path.join(app.getAppPath ? app.getAppPath() : process.cwd(), 'build/Release/audio_native.node'),
      path.join(process.cwd(), 'build/Release/audio_native.node'),
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        nativeAddon = require(candidate);
        return nativeAddon;
      }
    }
    throw new Error('Unable to load audio_native.node addon from candidate paths');
  }
}

export function normalizeAudioFileInfo(f: any): AudioFileInfo {
  const ext = path.extname(f.fileName || f.filePath || '').replace(/^\./, '').toUpperCase();
  const rawStatus = f.status || 'unanalyzed';
  let status: AudioFileInfo['status'] = 'unanalyzed';
  if (rawStatus === 'cached') {
    status = 'cached';
  } else if (rawStatus === 'analyzing') {
    status = 'analyzing';
  } else if (rawStatus === 'error') {
    status = 'error';
  } else {
    status = 'unanalyzed';
  }

  const fileSizeBytes = Number(f.fileSizeBytes ?? f.sizeBytes ?? 0);
  return {
    filePath: f.filePath,
    fileName: f.fileName || path.basename(f.filePath),
    fileSizeBytes,
    sizeBytes: fileSizeBytes,
    durationMs: Number(f.durationMs ?? 0),
    sampleRate: Number(f.sampleRate ?? 0),
    channels: Number(f.channels ?? 0),
    codec: f.codec ?? ext,
    status,
    bpm: typeof f.bpm === 'number' ? f.bpm : undefined,
    progressPct: typeof f.progressPct === 'number' ? f.progressPct : undefined,
    errorMessage: f.errorMessage,
  };
}

export function registerIpcHandlers() {
  ipcMain.removeHandler('audio:select-folder');
  ipcMain.removeHandler('audio:scan-folder');
  ipcMain.removeHandler('audio:start-batch');
  ipcMain.removeHandler('audio:control-batch');
  ipcMain.removeHandler('audio:load-analysis');
  ipcMain.removeHandler('audio:get-decoder-info');
  ipcMain.removeHandler('audio:invalidate-cache');
  ipcMain.removeHandler('audio:reanalyze-file');
  ipcMain.removeHandler('audio:playback-play');
  ipcMain.removeHandler('audio:playback-pause');
  ipcMain.removeHandler('audio:playback-stop');
  ipcMain.removeHandler('audio:playback-seek');
  ipcMain.removeHandler('audio:playback-set-volume');
  ipcMain.removeHandler('audio:reveal-in-finder');

  ipcMain.handle('audio:select-folder', async () => {
    const window = mainWindow ?? undefined;
    const result = window
      ? await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const folderPath = result.filePaths[0];
    const native = getNativeAddon();
    const rawFiles = native.scanFolder(folderPath) || [];
    const files = rawFiles.map(normalizeAudioFileInfo);
    return { folderPath, files };
  });

  ipcMain.handle('audio:scan-folder', async (_event, folderPath: string) => {
    const native = getNativeAddon();
    const rawFiles = native.scanFolder(folderPath) || [];
    return rawFiles.map(normalizeAudioFileInfo);
  });

  ipcMain.handle('audio:start-batch', async (event, folderPath: string, sidecarMode?: boolean) => {
    const native = getNativeAddon();
    const sender = event.sender;
    native.startBatchAnalysis(folderPath, !!sidecarMode, (update: any) => {
      if (!sender.isDestroyed()) {
        sender.send('audio:batch-progress', update);
      }
    });
  });

  ipcMain.handle('audio:control-batch', async (_event, action: 'pause' | 'resume' | 'cancel') => {
    const native = getNativeAddon();
    return native.controlBatchAnalysis(action);
  });

  ipcMain.handle('audio:load-analysis', async (_event, filePath: string, flatSidecar?: boolean) => {
    const native = getNativeAddon();
    const raw = native.loadFileAnalysis(filePath, !!flatSidecar);
    if (!raw) return null;
    const result: FileAnalysisData = {
      filePath,
      fileName: path.basename(filePath),
      durationMs: raw.durationMs,
      sampleRate: raw.sampleRate,
      channels: raw.channels,
      bpm: raw.bpm,
      confidence: raw.confidence,
      timeSignature: raw.timeSignature,
      lods: raw.lods,
      beatMarkers: raw.beats || raw.beatMarkers || [],
      beats: raw.beats || raw.beatMarkers || [],
    };
    return result;
  });

  ipcMain.handle('audio:get-decoder-info', async () => {
    const native = getNativeAddon();
    return native.getDecoderInfo ? native.getDecoderInfo() : { addonVersion: '0.1.0', audioCodecsCommit: 'unknown', flacMaxBlockSize: 8192, flacMaxChannels: 2 };
  });

  ipcMain.handle('audio:invalidate-cache', async (_event, filePath: string, flatSidecar?: boolean) => {
    const native = getNativeAddon();
    return native.invalidateCache ? native.invalidateCache(filePath, !!flatSidecar) : true;
  });

  ipcMain.handle('audio:reanalyze-file', async (_event, filePath: string, flatSidecar?: boolean) => {
    const native = getNativeAddon();
    if (native.invalidateCache) {
      native.invalidateCache(filePath, !!flatSidecar);
    }
    await new Promise<void>((resolve) => {
      native.startBatchAnalysis([filePath], !!flatSidecar, (update: any) => {
        if (update.status === 'cached' || update.status === 'error') {
          resolve();
        }
      });
    });
    const raw = native.loadFileAnalysis(filePath, !!flatSidecar);
    if (!raw) return null;
    return {
      filePath,
      fileName: path.basename(filePath),
      durationMs: raw.durationMs,
      sampleRate: raw.sampleRate,
      channels: raw.channels,
      bpm: raw.bpm,
      confidence: raw.confidence,
      timeSignature: raw.timeSignature,
      lods: raw.lods,
      beatMarkers: raw.beats || raw.beatMarkers || [],
      beats: raw.beats || raw.beatMarkers || [],
    };
  });

  ipcMain.handle('audio:playback-play', async (_event, filePath: string, startMs: number = 0) => {
    const native = getNativeAddon();
    return native.playbackPlay(filePath, startMs);
  });

  ipcMain.handle('audio:playback-pause', async () => {
    const native = getNativeAddon();
    return native.playbackPause();
  });

  ipcMain.handle('audio:playback-stop', async () => {
    const native = getNativeAddon();
    return native.playbackStop();
  });

  ipcMain.handle('audio:playback-seek', async (_event, timeMs: number) => {
    const native = getNativeAddon();
    return native.playbackSeek(timeMs);
  });

  ipcMain.handle('audio:playback-set-volume', async (_event, volume: number) => {
    const native = getNativeAddon();
    native.playbackSetVolume(volume);
  });

  ipcMain.handle('audio:reveal-in-finder', async (_event, filePath: string) => {
    shell.showItemInFolder(filePath);
  });
}

export function startPlaybackTicker() {
  if (tickerInterval) return;
  tickerInterval = setInterval(() => {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length === 0) return;
    try {
      const native = getNativeAddon();
      const state: PlaybackState = native.playbackGetPosition();
      if (state.isPlaying || wasPlaying || state.currentMs !== lastPlaybackState.currentMs) {
        for (const win of windows) {
          if (!win.isDestroyed()) {
            win.webContents.send('audio:playback-tick', state);
          }
        }
        wasPlaying = state.isPlaying;
        lastPlaybackState = state;
      }
    } catch {
      // Ignore during app teardown
    }
  }, 16);
}

export function stopPlaybackTicker() {
  if (tickerInterval) {
    clearInterval(tickerInterval);
    tickerInterval = null;
  }
}

export function createWindow(): BrowserWindow {
  const preloadCandidates = [
    path.join(__dirname, 'preload.js'),
    path.join(__dirname, '../preload/preload.js'),
    path.join(__dirname, '../dist-electron/preload.js'),
    path.join(app.getAppPath ? app.getAppPath() : process.cwd(), 'dist-electron/preload.js'),
  ];
  const preloadPath = preloadCandidates.find(p => fs.existsSync(p)) || path.join(__dirname, 'preload.js');

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#181830',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    const distHtmlCandidates = [
      path.join(__dirname, '../dist/index.html'),
      path.join(__dirname, 'index.html'),
      path.join(app.getAppPath ? app.getAppPath() : process.cwd(), 'dist/index.html'),
      path.join(app.getAppPath ? app.getAppPath() : process.cwd(), 'index.html'),
      path.join(process.cwd(), 'dist/index.html'),
    ];
    const distHtml = distHtmlCandidates.find(p => fs.existsSync(p));
    if (distHtml) {
      mainWindow.loadFile(distHtml);
    } else {
      console.error('Could not find application HTML bundle in candidate paths:', distHtmlCandidates);
      mainWindow.loadURL('data:text/html;charset=utf-8,<!DOCTYPE html><html><head><title>Audio Codec Front-End - Bundle Not Found</title></head><body style="background:%23181830;color:%23ff4d4d;font-family:monospace;padding:40px;"><h1>Bundle Error: dist/index.html not found</h1><p style="color:%23e0dfd5;">Please ensure the production build has been generated with <code>npm run build</code>.</p></body></html>');
    }
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

export function getMainWindow() {
  return mainWindow;
}

export function setMainWindow(win: BrowserWindow | null) {
  mainWindow = win;
}

if (process.type === 'browser') {
  // Suppress harmless Chromium/ANGLE GPU diagnostic probing noise (e.g. eglQueryDeviceAttribEXT: Bad attribute)
  app.commandLine.appendSwitch('log-level', '3');

  app.whenReady().then(() => {
    registerIpcHandlers();
    startPlaybackTicker();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('will-quit', () => {
    stopPlaybackTicker();
    try {
      const native = getNativeAddon();
      native.playbackStop();
    } catch {}
  });
}
