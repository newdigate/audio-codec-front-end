import React from 'react';

export interface HeaderBarProps {
  folderPath?: string | null;
  fileCount?: number;
  analyzedCount?: number;
  batchRunning?: boolean;
  batchPaused?: boolean;
  flatSidecar?: boolean;
  onOpenFolder?: () => void;
  onToggleBatch?: () => void;
  onToggleSidecar?: (flat: boolean) => void;
}

export const HeaderBar: React.FC<HeaderBarProps> = ({
  folderPath,
  fileCount = 0,
  analyzedCount = 0,
  batchRunning = false,
  batchPaused = false,
  flatSidecar = false,
  onOpenFolder,
  onToggleBatch,
  onToggleSidecar,
}) => {
  const handleOpenFolder = async () => {
    if (onOpenFolder) {
      onOpenFolder();
    } else if (window.audioApi?.selectFolder) {
      await window.audioApi.selectFolder();
    }
  };

  const progressPct =
    fileCount > 0 ? Math.min(100, Math.round((analyzedCount / fileCount) * 100)) : 0;

  return (
    <header className="header-bar">
      <button
        type="button"
        className="header-btn"
        onClick={handleOpenFolder}
        aria-label="Open Folder"
      >
        <span>📁</span>
        <span>Open Folder</span>
      </button>

      <div className="header-path-container">
        <span className="header-path" title={folderPath || 'No folder opened'}>
          {folderPath || 'No folder opened'}
        </span>
        {folderPath && (
          <span className="header-file-count">
            ({fileCount} {fileCount === 1 ? 'file' : 'files'})
          </span>
        )}
      </div>

      <div className="batch-progress-section" aria-label="Batch analysis progress">
        <span className="batch-label">
          Analyzed {analyzedCount} / {fileCount}
        </span>
        <div
          className="batch-progress-bar-bg"
          role="progressbar"
          aria-valuenow={progressPct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="batch-progress-bar-fill"
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <button
          type="button"
          className="batch-ctrl-btn"
          onClick={onToggleBatch}
          aria-label={batchPaused ? 'Resume' : 'Pause'}
          disabled={!batchRunning && !batchPaused && analyzedCount >= fileCount}
        >
          {batchPaused ? '▶ Resume' : '⏸ Pause'}
        </button>
      </div>

      <label className="sidecar-toggle">
        <input
          type="checkbox"
          checked={flatSidecar}
          onChange={(e) => onToggleSidecar?.(e.target.checked)}
        />
        <span>Flat Sidecar</span>
      </label>
    </header>
  );
};
