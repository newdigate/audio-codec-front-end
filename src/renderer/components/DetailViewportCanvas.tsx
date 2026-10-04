import React, { useRef, useEffect, useState, useCallback } from 'react';
import type { LodData, BeatMarker } from '../../shared/audio_types';
import {
  timeToPixel,
  pixelToTime,
  selectBestLod,
  clamp,
} from '../utils/wave_math';

export interface DetailViewportCanvasProps {
  durationMs: number;
  sampleRate: number;
  channels: number;
  viewStartMs: number;
  viewEndMs: number;
  currentMs?: number;
  isPlaying?: boolean;
  lods: LodData[];
  beatMarkers: BeatMarker[];
  selectionStartMs: number | null;
  selectionEndMs: number | null;
  onViewRangeChange: (startMs: number, endMs: number) => void;
  onSelectionChange: (startMs: number | null, endMs: number | null) => void;
  onSeek: (timeMs: number) => void;
}

const RULER_HEIGHT = 22;

export const DetailViewportCanvas: React.FC<DetailViewportCanvasProps> = ({
  durationMs,
  sampleRate,
  channels,
  viewStartMs,
  viewEndMs,
  currentMs,
  lods,
  beatMarkers,
  selectionStartMs,
  selectionEndMs,
  onViewRangeChange,
  onSelectionChange,
  onSeek,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 800, height: 260 });

  // Drag tracking refs
  const dragRef = useRef<{
    isDown: boolean;
    hasDragged: boolean;
    button: number;
    startX: number;
    startTimeMs: number;
    initialViewStart: number;
    initialViewEnd: number;
    isShift: boolean;
  }>({
    isDown: false,
    hasDragged: false,
    button: 0,
    startX: 0,
    startTimeMs: 0,
    initialViewStart: 0,
    initialViewEnd: 0,
    isShift: false,
  });

  // Track size with ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      const w = Math.max(10, Math.floor(rect.width));
      const h = Math.max(10, Math.floor(rect.height));
      setSize((prev) => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
    };

    updateSize();

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => updateSize());
      ro.observe(el);
      return () => ro.disconnect();
    }
  }, []);

  // Main Canvas Rendering
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const { width, height } = size;

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    ctx.save();
    ctx.scale(dpr, dpr);

    const safeDuration = durationMs > 0 ? durationMs : 1;
    const currentSpan = Math.max(1, viewEndMs - viewStartMs);
    const waveHeight = height - RULER_HEIGHT;
    const midY = RULER_HEIGHT + waveHeight / 2;
    const halfH = waveHeight / 2;

    // 1. Background
    ctx.fillStyle = '#181830';
    ctx.fillRect(0, 0, width, height);

    // 2. Guide Lines
    // Zero-crossing guide line #018C
    ctx.strokeStyle = '#018C';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(width, midY);
    ctx.stroke();

    // Quartile guide lines #012C
    ctx.strokeStyle = '#012C';
    ctx.lineWidth = 1;
    ctx.beginPath();
    // +0.5 quartile
    ctx.moveTo(0, midY - halfH * 0.5);
    ctx.lineTo(width, midY - halfH * 0.5);
    // -0.5 quartile
    ctx.moveTo(0, midY + halfH * 0.5);
    ctx.lineTo(width, midY + halfH * 0.5);
    ctx.stroke();

    // 3. Selection Range Highlight (under waveform)
    if (selectionStartMs !== null && selectionEndMs !== null && selectionStartMs !== selectionEndMs) {
      const sStart = Math.min(selectionStartMs, selectionEndMs);
      const sEnd = Math.max(selectionStartMs, selectionEndMs);
      const selX1 = timeToPixel(sStart, viewStartMs, viewEndMs, width);
      const selX2 = timeToPixel(sEnd, viewStartMs, viewEndMs, width);
      const selW = Math.max(2, selX2 - selX1);

      ctx.fillStyle = 'rgba(74, 127, 255, 0.16)';
      ctx.fillRect(selX1, RULER_HEIGHT, selW, waveHeight);

      ctx.strokeStyle = '#4A7F';
      ctx.lineWidth = 1;
      ctx.strokeRect(selX1, RULER_HEIGHT, selW, waveHeight);
    }

    // 4. Waveform rendering
    if (lods && lods.length > 0) {
      const sr = sampleRate > 0 ? sampleRate : 44100;
      const samplesPerPixel = (currentSpan / 1000 * sr) / width;
      const targetLodIdx = selectBestLod(samplesPerPixel);
      // Pick target LOD or fallback to closest available
      const activeLod = lods[Math.min(targetLodIdx, lods.length - 1)] || lods[0];

      if (activeLod && activeLod.peaks && activeLod.chunkCount > 0) {
        const { peaks, chunkCount, downsampleRatio } = activeLod;
        const bpc = Math.max(2, Math.floor(peaks.length / chunkCount));
        const chunkDurationMs = ((downsampleRatio || 1) / sr) * 1000;

        for (let x = 0; x < width; x++) {
          const t1 = pixelToTime(x, viewStartMs, viewEndMs, width);
          const t2 = pixelToTime(x + 1, viewStartMs, viewEndMs, width);

          let c1 = Math.floor(t1 / chunkDurationMs);
          let c2 = Math.max(c1 + 1, Math.ceil(t2 / chunkDurationMs));

          c1 = clamp(c1, 0, chunkCount - 1);
          c2 = clamp(c2, c1 + 1, chunkCount);

          let minVal = 1.0;
          let maxVal = -1.0;

          for (let c = c1; c < c2; c++) {
            const idx = c * bpc;
            if (bpc >= 4) {
              const minL = peaks[idx] / 128.0;
              const maxL = peaks[idx + 1] / 128.0;
              const minR = peaks[idx + 2] / 128.0;
              const maxR = peaks[idx + 3] / 128.0;
              minVal = Math.min(minVal, minL, minR);
              maxVal = Math.max(maxVal, maxL, maxR);
            } else {
              const minM = peaks[idx] / 128.0;
              const maxM = peaks[idx + 1] / 128.0;
              minVal = Math.min(minVal, minM);
              maxVal = Math.max(maxVal, maxM);
            }
          }

          if (minVal > maxVal) {
            minVal = 0;
            maxVal = 0;
          }

          const yTop = midY - maxVal * halfH;
          const yBottom = midY - minVal * halfH;
          const colHeight = Math.max(1, yBottom - yTop);

          // Waveform vertical column: #2272
          ctx.fillStyle = '#2272';
          ctx.fillRect(x, yTop, 1, colHeight);

          // Neon blue peak caps: #4A7F
          ctx.fillStyle = '#4A7F';
          ctx.fillRect(x, yTop, 1, 1);
          ctx.fillRect(x, Math.max(yTop, yBottom - 1), 1, 1);
        }
      }
    }

    // 5. Beat Grid lines & Top Ruler
    // Ruler background
    ctx.fillStyle = '#1c1c38';
    ctx.fillRect(0, 0, width, RULER_HEIGHT);
    ctx.strokeStyle = '#2d2d52';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, RULER_HEIGHT);
    ctx.lineTo(width, RULER_HEIGHT);
    ctx.stroke();

    // Beat markers
    if (beatMarkers && beatMarkers.length > 0) {
      ctx.font = '10px "IBM Plex Mono", "SF Mono", monospace';
      ctx.textBaseline = 'middle';

      for (let i = 0; i < beatMarkers.length; i++) {
        const marker = beatMarkers[i];
        if (marker.timeMs < viewStartMs - 100 || marker.timeMs > viewEndMs + 100) {
          continue;
        }

        const beatX = timeToPixel(marker.timeMs, viewStartMs, viewEndMs, width);
        if (beatX < 0 || beatX > width) continue;

        if (marker.isDownbeat) {
          // Amber downbeat line
          ctx.strokeStyle = 'rgba(230, 145, 56, 0.7)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(beatX, RULER_HEIGHT);
          ctx.lineTo(beatX, height);
          ctx.stroke();

          // Downbeat ruler label
          ctx.fillStyle = '#e69138';
          ctx.textAlign = 'left';
          ctx.fillText(`Bar ${marker.barIndex + 1}`, beatX + 3, RULER_HEIGHT / 2);
        } else {
          // Regular beat line
          ctx.strokeStyle = 'rgba(96, 120, 192, 0.35)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(beatX, RULER_HEIGHT);
          ctx.lineTo(beatX, height);
          ctx.stroke();

          // Only show beat number if there is enough pixel room
          if (currentSpan < 15000) {
            ctx.fillStyle = '#6078c0';
            ctx.textAlign = 'left';
            ctx.fillText(`${marker.barIndex + 1}.${marker.beatWithinBar + 1}`, beatX + 2, RULER_HEIGHT / 2);
          }
        }
      }
    }

    // 6. Playhead Cursor
    if (currentMs !== undefined && currentMs >= 0 && currentMs <= safeDuration) {
      const phX = timeToPixel(currentMs, viewStartMs, viewEndMs, width);
      if (phX >= 0 && phX <= width) {
        // Glow effect
        ctx.strokeStyle = 'rgba(74, 127, 255, 0.4)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(phX, 0);
        ctx.lineTo(phX, height);
        ctx.stroke();

        // Core neon line
        ctx.strokeStyle = '#4A7F';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(phX, 0);
        ctx.lineTo(phX, height);
        ctx.stroke();

        // Ruler marker head
        ctx.fillStyle = '#4A7F';
        ctx.beginPath();
        ctx.moveTo(phX - 4, 0);
        ctx.lineTo(phX + 4, 0);
        ctx.lineTo(phX, 7);
        ctx.closePath();
        ctx.fill();
      }
    }

    ctx.restore();
  }, [
    size,
    durationMs,
    sampleRate,
    channels,
    viewStartMs,
    viewEndMs,
    currentMs,
    lods,
    beatMarkers,
    selectionStartMs,
    selectionEndMs,
  ]);

  // Mouse Wheel (Zoom & Trackpad Pan)
  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      e.preventDefault();
      const el = containerRef.current;
      if (!el || durationMs <= 0) return;

      const rect = el.getBoundingClientRect();
      const mouseX = clamp(e.clientX - rect.left, 0, rect.width);
      const mouseTimeMs = pixelToTime(mouseX, viewStartMs, viewEndMs, rect.width);
      const currentSpan = Math.max(20, viewEndMs - viewStartMs);

      // Pinch zoom or vertical wheel with alt/ctrl, or normal vertical scroll
      if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
        const zoomDelta = e.deltaY < 0 ? 0.8 : 1.25;
        const newSpan = clamp(currentSpan * zoomDelta, 20, durationMs);
        const cursorRatio = mouseX / rect.width;

        let newStart = mouseTimeMs - cursorRatio * newSpan;
        let newEnd = newStart + newSpan;

        if (newStart < 0) {
          newStart = 0;
          newEnd = Math.min(durationMs, newSpan);
        } else if (newEnd > durationMs) {
          newEnd = durationMs;
          newStart = Math.max(0, durationMs - newSpan);
        }

        onViewRangeChange(newStart, newEnd);
      } else if (Math.abs(e.deltaX) > 0) {
        // Horizontal scroll trackpad pan
        const panDeltaMs = (e.deltaX / rect.width) * currentSpan;
        let newStart = viewStartMs + panDeltaMs;
        let newEnd = viewEndMs + panDeltaMs;

        if (newStart < 0) {
          newStart = 0;
          newEnd = currentSpan;
        } else if (newEnd > durationMs) {
          newEnd = durationMs;
          newStart = Math.max(0, durationMs - currentSpan);
        }

        onViewRangeChange(newStart, newEnd);
      }
    },
    [durationMs, viewStartMs, viewEndMs, onViewRangeChange]
  );

  // Mouse Down / Drag / Seek / Select
  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = containerRef.current;
    if (!el || durationMs <= 0) return;

    const rect = el.getBoundingClientRect();
    const mouseX = clamp(e.clientX - rect.left, 0, rect.width);
    const clickTime = pixelToTime(mouseX, viewStartMs, viewEndMs, rect.width);

    dragRef.current = {
      isDown: true,
      hasDragged: false,
      button: e.button,
      startX: e.clientX,
      startTimeMs: clickTime,
      initialViewStart: viewStartMs,
      initialViewEnd: viewEndMs,
      isShift: e.shiftKey,
    };

    const onMouseMove = (moveEvt: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag.isDown) return;

      const deltaX = moveEvt.clientX - drag.startX;
      if (Math.abs(deltaX) > 4) {
        drag.hasDragged = true;
      }

      const currentRect = containerRef.current?.getBoundingClientRect();
      if (!currentRect || currentRect.width <= 0) return;

      const curMouseX = clamp(moveEvt.clientX - currentRect.left, 0, currentRect.width);
      const curTimeMs = pixelToTime(curMouseX, viewStartMs, viewEndMs, currentRect.width);

      if (drag.isShift || (!drag.button && !moveEvt.altKey && drag.hasDragged)) {
        // Selection drag
        onSelectionChange(
          Math.min(drag.startTimeMs, curTimeMs),
          Math.max(drag.startTimeMs, curTimeMs)
        );
      } else if (drag.button === 1 || moveEvt.altKey) {
        // Pan drag
        const span = drag.initialViewEnd - drag.initialViewStart;
        const shiftMs = (deltaX / currentRect.width) * span;
        let newStart = drag.initialViewStart - shiftMs;
        let newEnd = drag.initialViewEnd - shiftMs;

        if (newStart < 0) {
          newStart = 0;
          newEnd = span;
        } else if (newEnd > durationMs) {
          newEnd = durationMs;
          newStart = Math.max(0, durationMs - span);
        }

        onViewRangeChange(newStart, newEnd);
      }
    };

    const onMouseUp = (upEvt: MouseEvent) => {
      const drag = dragRef.current;
      drag.isDown = false;

      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);

      // If clicked without dragging -> Seek!
      if (!drag.hasDragged && drag.button === 0) {
        const currentRect = containerRef.current?.getBoundingClientRect();
        if (currentRect && currentRect.width > 0) {
          const upX = clamp(upEvt.clientX - currentRect.left, 0, currentRect.width);
          const seekTime = pixelToTime(upX, viewStartMs, viewEndMs, currentRect.width);
          onSeek(clamp(seekTime, 0, durationMs));
        }
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  return (
    <div
      ref={containerRef}
      className="detail-viewport-wrapper"
      data-testid="detail-viewport-canvas"
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      role="application"
      aria-label="Detailed waveform editor"
      tabIndex={0}
    >
      <canvas ref={canvasRef} />
    </div>
  );
};
