import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AudioTableRow } from './AudioTableRow';
import { ContextMenu } from './ContextMenu';
import type { AudioFileInfo, PlaybackState } from '../../shared/audio_types';

export interface FolderBrowserViewProps {
  files: AudioFileInfo[];
  folderPath: string | null;
  onOpenFileTab: (file: AudioFileInfo) => void;
  onOpenFolder?: () => void;
  onReanalyzeFile?: (file: AudioFileInfo) => void;
}

type SortField = 'name' | 'duration' | 'codec' | 'bpm' | 'status' | null;
type SortDirection = 'asc' | 'desc';

export const FolderBrowserView: React.FC<FolderBrowserViewProps> = ({
  files,
  folderPath,
  onOpenFileTab,
  onOpenFolder,
  onReanalyzeFile,
}) => {
  const [playingFilePath, setPlayingFilePath] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    file: AudioFileInfo;
  } | null>(null);

  const parentRef = useRef<HTMLDivElement>(null);

  // Sync with real-time playback ticks from audioApi
  useEffect(() => {
    if (!window.audioApi?.onPlaybackTick) return;

    const unsub = window.audioApi.onPlaybackTick((state: PlaybackState) => {
      if (!state.isPlaying) {
        setPlayingFilePath(null);
      }
    });

    return () => {
      unsub?.();
    };
  }, []);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      if (sortDirection === 'asc') {
        setSortDirection('desc');
      } else {
        setSortField(null);
        setSortDirection('asc');
      }
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const sortedFiles = useMemo(() => {
    if (!sortField) return files;
    return [...files].sort((a, b) => {
      let valA: string | number = '';
      let valB: string | number = '';

      switch (sortField) {
        case 'name':
          valA = a.fileName.toLowerCase();
          valB = b.fileName.toLowerCase();
          break;
        case 'duration':
          valA = a.durationMs || 0;
          valB = b.durationMs || 0;
          break;
        case 'codec':
          valA = (a.codec || '').toLowerCase();
          valB = (b.codec || '').toLowerCase();
          break;
        case 'bpm':
          valA = a.bpm || 0;
          valB = b.bpm || 0;
          break;
        case 'status':
          valA = a.status || '';
          valB = b.status || '';
          break;
      }

      if (valA < valB) return sortDirection === 'asc' ? -1 : 1;
      if (valA > valB) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });
  }, [files, sortField, sortDirection]);

  // Virtualized row layout
  const rowVirtualizer = useVirtualizer({
    count: sortedFiles.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 40,
    overscan: 12,
    initialRect: { width: 1000, height: 800 },
    observeElementRect: (instance, cb) => {
      const el = instance.scrollElement;
      if (!el) return;
      const getRect = () => {
        const rect = el.getBoundingClientRect();
        return {
          width: Math.round(rect.width) || 1000,
          height: Math.round(rect.height) || 800,
        };
      };
      cb(getRect());

      const ResizeObserver = el.ownerDocument?.defaultView?.ResizeObserver;
      if (!ResizeObserver) return;

      const observer = new ResizeObserver(() => {
        cb(getRect());
      });
      observer.observe(el);
      return () => observer.disconnect();
    },
  });

  const handlePlayToggle = useCallback(
    async (file: AudioFileInfo) => {
      if (playingFilePath === file.filePath) {
        if (window.audioApi?.playbackStop) {
          await window.audioApi.playbackStop();
        }
        setPlayingFilePath(null);
      } else {
        if (window.audioApi?.playbackPlay) {
          const success = await window.audioApi.playbackPlay(file.filePath, 0);
          if (success !== false) {
            setPlayingFilePath(file.filePath);
          }
        } else {
          setPlayingFilePath(file.filePath);
        }
      }
    },
    [playingFilePath]
  );

  const handleContextMenu = useCallback((e: React.MouseEvent, file: AudioFileInfo) => {
    e.preventDefault();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      file,
    });
  }, []);

  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const handleReanalyze = useCallback(
    async (file: AudioFileInfo) => {
      if (onReanalyzeFile) {
        onReanalyzeFile(file);
      } else if (window.audioApi?.reanalyzeFile) {
        await window.audioApi.reanalyzeFile(file.filePath);
      } else if (window.audioApi?.loadFileAnalysis) {
        await window.audioApi.loadFileAnalysis(file.filePath);
      }
    },
    [onReanalyzeFile]
  );

  const getSortIcon = (field: SortField) => {
    if (sortField !== field) return null;
    return sortDirection === 'asc' ? ' ▴' : ' ▾';
  };

  // Empty state: no folder opened
  if (!folderPath) {
    return (
      <div className="view-placeholder folder-empty-placeholder" data-testid="folder-browser-placeholder">
        <span className="view-placeholder-title">📁 Folder Browser View</span>
        <span className="view-placeholder-sub">
          No folder opened. Click "Open Folder" to browse audio samples.
        </span>
        {onOpenFolder && (
          <button type="button" className="header-btn" onClick={onOpenFolder}>
            Open Folder
          </button>
        )}
      </div>
    );
  }

  // Empty state: folder opened but contains 0 audio files
  if (files.length === 0) {
    return (
      <div className="view-placeholder folder-empty-placeholder" data-testid="folder-browser-placeholder">
        <span className="view-placeholder-title">📁 Audio Browser</span>
        <span className="view-placeholder-sub">
          No audio files found in {folderPath}.
        </span>
        {onOpenFolder && (
          <button type="button" className="header-btn" onClick={onOpenFolder}>
            Open Different Folder
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className="folder-browser-view"
      data-testid="folder-browser-placeholder"
      data-testid-view="folder-browser-view"
    >
      {/* Table Header */}
      <div className="audio-table-header" role="row">
        <div className="header-cell cell-play" role="columnheader" aria-label="Play audition" />
        <div
          className="header-cell cell-name sortable"
          role="columnheader"
          onClick={() => handleSort('name')}
          title="Sort by file name"
        >
          <span>Name</span>
          <span className="sort-indicator">{getSortIcon('name')}</span>
        </div>
        <div
          className="header-cell cell-duration sortable"
          role="columnheader"
          onClick={() => handleSort('duration')}
          title="Sort by duration"
        >
          <span>Duration</span>
          <span className="sort-indicator">{getSortIcon('duration')}</span>
        </div>
        <div
          className="header-cell cell-codec sortable"
          role="columnheader"
          onClick={() => handleSort('codec')}
          title="Sort by format"
        >
          <span>Format</span>
          <span className="sort-indicator">{getSortIcon('codec')}</span>
        </div>
        <div className="header-cell cell-audio-specs" role="columnheader">
          <span>Sample Rate / Ch</span>
        </div>
        <div
          className="header-cell cell-bpm sortable"
          role="columnheader"
          onClick={() => handleSort('bpm')}
          title="Sort by BPM"
        >
          <span>BPM</span>
          <span className="sort-indicator">{getSortIcon('bpm')}</span>
        </div>
        <div
          className="header-cell cell-status sortable"
          role="columnheader"
          onClick={() => handleSort('status')}
          title="Sort by status"
        >
          <span>Status</span>
          <span className="sort-indicator">{getSortIcon('status')}</span>
        </div>
        <div className="header-cell cell-actions" role="columnheader">
          <span>Actions</span>
        </div>
      </div>

      {/* Virtualized Table Body */}
      <div ref={parentRef} className="audio-table-scroll-container">
        <div
          className="audio-table-virtual-inner"
          style={{
            height: `${rowVirtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const file = sortedFiles[virtualRow.index];
            if (!file) return null;

            return (
              <AudioTableRow
                key={file.filePath}
                file={file}
                isPlaying={playingFilePath === file.filePath}
                onPlay={handlePlayToggle}
                onPlayToggle={handlePlayToggle}
                onOpenTab={onOpenFileTab}
                onContextMenu={handleContextMenu}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              />
            );
          })}
        </div>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          file={contextMenu.file}
          onClose={handleCloseContextMenu}
          onOpenTab={onOpenFileTab}
          onReanalyze={handleReanalyze}
        />
      )}
    </div>
  );
};
