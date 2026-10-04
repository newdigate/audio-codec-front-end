import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { HeaderBar } from './components/HeaderBar';
import { TabBar, TabItem } from './components/TabBar';
import { FolderBrowserView } from './components/FolderBrowserView';
import { WaveView } from './components/WaveView';
import type { AudioFileInfo, BatchProgressUpdate, PlaybackState } from '../shared/audio_types';
import './styles/theme.css';

export const App: React.FC = () => {
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [files, setFiles] = useState<AudioFileInfo[]>([]);
  const [flatSidecar, setFlatSidecar] = useState<boolean>(false);
  const [batchRunning, setBatchRunning] = useState<boolean>(false);
  const [batchPaused, setBatchPaused] = useState<boolean>(false);
  const [, setPlaybackState] = useState<PlaybackState>({
    isPlaying: false,
    currentMs: 0,
  });

  const folderName = useMemo(() => {
    if (!folderPath) return 'Samples';
    const parts = folderPath.split(/[/\\]/).filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : folderPath;
  }, [folderPath]);

  const [tabs, setTabs] = useState<TabItem[]>([
    { id: 'folder', title: '📁 Samples', isPinned: true },
  ]);
  const [activeTabId, setActiveTabId] = useState<string>('folder');

  // Update pinned tab title when folder changes
  useEffect(() => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.isPinned
          ? { ...tab, title: `📁 ${folderName}` }
          : tab
      )
    );
  }, [folderName]);

  // Reset batchRunning when all files are cached or finished
  useEffect(() => {
    if (files.length > 0 && files.every((f) => f.status === 'cached' || f.status === 'error')) {
      setBatchRunning(false);
      setBatchPaused(false);
    }
  }, [files]);

  // Subscribe to batch progress and playback tick
  useEffect(() => {
    if (!window.audioApi) return;

    const unsubProgress = window.audioApi.onBatchProgress((update: BatchProgressUpdate) => {
      setFiles((prev) => {
        const next = prev.map((f) => {
          if (f.filePath === update.filePath) {
            return {
              ...f,
              status: (update.status as AudioFileInfo['status']) || f.status,
              progressPct: update.progressPct,
              bpm: update.bpm !== undefined ? update.bpm : f.bpm,
              durationMs: update.durationMs !== undefined ? update.durationMs : f.durationMs,
              errorMessage: update.errorMessage,
            };
          }
          return f;
        });

        const allFinished =
          next.length > 0 &&
          next.every((f) => f.status === 'cached' || f.status === 'error');
        if (allFinished) {
          setBatchRunning(false);
          setBatchPaused(false);
        }

        return next;
      });
    });

    const unsubPlayback = window.audioApi.onPlaybackTick((state: PlaybackState) => {
      setPlaybackState(state);
    });

    return () => {
      unsubProgress?.();
      unsubPlayback?.();
    };
  }, []);

  const analyzedCount = useMemo(() => {
    return files.filter((f) => f.status === 'cached').length;
  }, [files]);

  const handleOpenFolder = useCallback(async () => {
    if (!window.audioApi?.selectFolder) return;
    try {
      const result = await window.audioApi.selectFolder();
      if (!result) return;

      setFolderPath(result.folderPath);
      setFiles(result.files);
      setBatchPaused(false);

      const unanalyzed = result.files.filter(
        (f) => f.status !== 'cached' && f.status !== 'error'
      );
      if (unanalyzed.length > 0 && window.audioApi.startBatchAnalysis) {
        setBatchRunning(true);
        window.audioApi.startBatchAnalysis(result.folderPath, flatSidecar);
      } else {
        setBatchRunning(false);
        setBatchPaused(false);
      }
    } catch (err) {
      console.error('Failed to select folder:', err);
    }
  }, [flatSidecar]);

  const handleToggleBatch = useCallback(async () => {
    if (!window.audioApi?.controlBatchAnalysis) return;
    const nextPaused = !batchPaused;
    try {
      await window.audioApi.controlBatchAnalysis(nextPaused ? 'pause' : 'resume');
      setBatchPaused(nextPaused);
    } catch (err) {
      console.error('Failed to control batch analysis:', err);
    }
  }, [batchPaused]);

  const handleToggleSidecar = useCallback((enabled: boolean) => {
    setFlatSidecar(enabled);
  }, []);

  const handleSelectTab = useCallback((id: string) => {
    setActiveTabId(id);
  }, []);

  const handleCloseTab = useCallback((id: string) => {
    setTabs((prev) => {
      const nextTabs = prev.filter((t) => t.id !== id);
      if (activeTabId === id) {
        const closedIdx = prev.findIndex((t) => t.id === id);
        const fallback = nextTabs[Math.max(0, closedIdx - 1)] || nextTabs[0];
        setActiveTabId(fallback ? fallback.id : 'folder');
      }
      return nextTabs;
    });
  }, [activeTabId]);

  const handleOpenFileTab = useCallback((file: AudioFileInfo) => {
    setTabs((prev) => {
      const exists = prev.find((t) => t.id === file.filePath);
      if (exists) {
        return prev;
      }
      return [
        ...prev,
        {
          id: file.filePath,
          title: `🎵 ${file.fileName}`,
          isPinned: false,
          filePath: file.filePath,
        },
      ];
    });
    setActiveTabId(file.filePath);
  }, []);

  const activeTab = useMemo(() => {
    return tabs.find((t) => t.id === activeTabId) || tabs[0];
  }, [tabs, activeTabId]);

  return (
    <div className="app-container">
      <HeaderBar
        folderPath={folderPath}
        fileCount={files.length}
        analyzedCount={analyzedCount}
        batchRunning={batchRunning}
        batchPaused={batchPaused}
        flatSidecar={flatSidecar}
        onOpenFolder={handleOpenFolder}
        onToggleBatch={handleToggleBatch}
        onToggleSidecar={handleToggleSidecar}
      />

      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={handleSelectTab}
        onCloseTab={handleCloseTab}
      />

      <main className="main-content" role="region" aria-label="Main content">
        {activeTab?.isPinned ? (
          <FolderBrowserView
            folderPath={folderPath}
            files={files}
            onOpenFileTab={handleOpenFileTab}
            onOpenFolder={handleOpenFolder}
          />
        ) : (
          <WaveView
            filePath={activeTab.filePath || activeTab.id}
            fileName={activeTab.title}
            flatSidecar={flatSidecar}
          />
        )}
      </main>
    </div>
  );
};

export default App;
