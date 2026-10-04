import React, { useEffect, useRef } from 'react';
import type { AudioFileInfo } from '../../shared/audio_types';

export interface ContextMenuProps {
  x: number;
  y: number;
  file: AudioFileInfo;
  onClose: () => void;
  onOpenTab?: (file: AudioFileInfo) => void;
  onReanalyze?: (file: AudioFileInfo) => void;
  onRevealInFinder?: (filePath: string) => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({
  x,
  y,
  file,
  onClose,
  onOpenTab,
  onReanalyze,
  onRevealInFinder,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handlePointerDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [onClose]);

  const handleOpen = () => {
    onOpenTab?.(file);
    onClose();
  };

  const handleReanalyze = () => {
    if (onReanalyze) {
      onReanalyze(file);
    } else if (window.audioApi?.loadFileAnalysis) {
      window.audioApi.loadFileAnalysis(file.filePath);
    }
    onClose();
  };

  const handleReveal = () => {
    if (onRevealInFinder) {
      onRevealInFinder(file.filePath);
    } else if (window.audioApi?.revealInFinder) {
      window.audioApi.revealInFinder(file.filePath);
    }
    onClose();
  };

  // Clamp positioning within viewport if window is available
  const menuWidth = 190;
  const menuHeight = 135;
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1000;
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 800;

  const clampedX = Math.max(8, Math.min(x, viewportWidth - menuWidth - 8));
  const clampedY = Math.max(8, Math.min(y, viewportHeight - menuHeight - 8));

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: `${clampedX}px`, top: `${clampedY}px` }}
      role="menu"
      aria-label={`Options for ${file.fileName}`}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="context-menu-title" title={file.fileName}>
        <span className="context-menu-icon" aria-hidden="true">🎵</span>{' '}
        <span className="title-text">{file.fileName}</span>
      </div>
      <div className="context-menu-divider" />
      <button
        type="button"
        className="context-menu-item"
        role="menuitem"
        onClick={handleOpen}
      >
        <span className="context-menu-icon" aria-hidden="true">📂</span>
        <span>Open in New Tab</span>
      </button>
      <button
        type="button"
        className="context-menu-item"
        role="menuitem"
        onClick={handleReanalyze}
      >
        <span className="context-menu-icon" aria-hidden="true">🔄</span>
        <span>Re-analyze File</span>
      </button>
      <button
        type="button"
        className="context-menu-item"
        role="menuitem"
        onClick={handleReveal}
      >
        <span className="context-menu-icon" aria-hidden="true">🔍</span>
        <span>Reveal in Finder</span>
      </button>
    </div>
  );
};
