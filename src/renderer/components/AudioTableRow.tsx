import React from 'react';
import type { AudioFileInfo } from '../../shared/audio_types';

export interface AudioTableRowProps {
  file: AudioFileInfo;
  isPlaying?: boolean;
  isSelected?: boolean;
  onPlay?: (file: AudioFileInfo) => void;
  onPlayToggle?: (file: AudioFileInfo) => void;
  onOpenTab?: (file: AudioFileInfo) => void;
  onContextMenu?: (e: React.MouseEvent, file: AudioFileInfo) => void;
  style?: React.CSSProperties;
}

export function formatDuration(durationMs?: number): string {
  if (durationMs === undefined || durationMs === null || isNaN(durationMs) || durationMs < 0) {
    return '--:--.---';
  }
  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const ms = Math.floor(durationMs % 1000);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

export function formatSampleRateChannels(sampleRate?: number, channels?: number): string {
  if (!sampleRate && !channels) return '-';
  const srText = sampleRate
    ? sampleRate >= 1000
      ? `${(sampleRate / 1000).toFixed(1)} kHz`
      : `${sampleRate} Hz`
    : '-';
  const chText = channels === 1 ? 'Mono' : channels === 2 ? 'Stereo' : channels ? `${channels} ch` : '-';
  return `${srText} / ${chText}`;
}

export const AudioTableRow: React.FC<AudioTableRowProps> = ({
  file,
  isPlaying = false,
  isSelected = false,
  onPlay,
  onPlayToggle,
  onOpenTab,
  onContextMenu,
  style,
}) => {
  const handlePlayToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onPlay) {
      onPlay(file);
    } else if (onPlayToggle) {
      onPlayToggle(file);
    }
  };

  const handleOpenTab = (e: React.MouseEvent) => {
    e.stopPropagation();
    onOpenTab?.(file);
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onOpenTab?.(file);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    onContextMenu?.(e, file);
  };

  const bpmText =
    file.bpm !== undefined && file.bpm !== null && file.bpm > 0
      ? `${file.bpm.toFixed(1)} BPM`
      : '-';

  let statusText = 'Unanalyzed';
  if (file.status === 'cached') {
    statusText = 'Ready';
  } else if (file.status === 'analyzing') {
    statusText = file.progressPct !== undefined ? `${Math.round(file.progressPct)}%` : 'Analyzing...';
  } else if (file.status === 'error') {
    statusText = 'Error';
  }

  return (
    <div
      className={`audio-table-row ${isPlaying ? 'row-playing' : ''} ${isSelected ? 'row-selected' : ''}`}
      style={style}
      role="row"
      data-testid={`audio-row-${file.fileName}`}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
    >
      <div className="audio-cell cell-play" role="gridcell">
        <button
          type="button"
          className={`audition-btn ${isPlaying ? 'is-playing' : ''}`}
          onClick={handlePlayToggle}
          title={isPlaying ? `Stop ${file.fileName}` : `Play ${file.fileName}`}
          aria-label={isPlaying ? `Stop ${file.fileName}` : `Play ${file.fileName}`}
        >
          {isPlaying ? '⏹' : '▶'}
        </button>
      </div>

      <div className="audio-cell cell-name" role="gridcell" title={file.filePath}>
        <span className="file-icon" aria-hidden="true">🎵</span>
        <span className="file-name-text">{file.fileName}</span>
      </div>

      <div className="audio-cell cell-duration" role="gridcell">
        {formatDuration(file.durationMs)}
      </div>

      <div className="audio-cell cell-codec" role="gridcell">
        <span className="codec-badge">{file.codec ? file.codec.toUpperCase() : '-'}</span>
      </div>

      <div className="audio-cell cell-audio-specs" role="gridcell">
        {formatSampleRateChannels(file.sampleRate, file.channels)}
      </div>

      <div className="audio-cell cell-bpm" role="gridcell">
        <span className="bpm-badge">{bpmText}</span>
      </div>

      <div className="audio-cell cell-status" role="gridcell">
        <span
          className={`status-badge status-${file.status}`}
          data-status={file.status}
          title={file.errorMessage || file.status}
        >
          {statusText}
        </span>
      </div>

      <div className="audio-cell cell-actions" role="gridcell">
        <button
          type="button"
          className="row-action-btn open-tab-btn"
          onClick={handleOpenTab}
          title="Open in Tab"
          aria-label={`Open ${file.fileName}`}
        >
          <span className="action-icon">⤢</span> Open
        </button>
      </div>
    </div>
  );
};
