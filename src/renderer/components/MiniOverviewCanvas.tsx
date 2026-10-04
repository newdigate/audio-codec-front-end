import React, { useRef, useEffect, useCallback, useState } from 'react';
import type { LodData } from '../../shared/audio_types';
import { clamp } from '../utils/wave_math';

export interface MiniOverviewCanvasProps {
  durationMs: number;
  viewStartMs: number;
  viewEndMs: number;
  currentMs?: number;
  isPlaying?: boolean;
  lodData?: LodData;
  channels?: number;
  onViewRangeChange: (startMs: number, endMs: number) => void;
}

export const MiniOverviewCanvas: React.FC<MiniOverviewCanvasProps> = ({
  durationMs,
  viewStartMs,
  viewEndMs,
  currentMs,
  lodData,
  channels = 2,
  onViewRangeChange,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 800, height: 48 });
  const isDraggingRef = useRef(false);

  // Measure size with ResizeObserver
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

  // Render canvas
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

    // 1. Background
    ctx.fillStyle = '#151528';
    ctx.fillRect(0, 0, width, height);

    // 2. Zero-crossing guide line
    ctx.strokeStyle = '#018C';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    // 3. Peaks overview
    if (lodData && lodData.peaks && lodData.chunkCount > 0) {
      const { peaks, chunkCount } = lodData;
      const bpc = Math.max(2, Math.floor(peaks.length / chunkCount));
      const midY = height / 2;

      for (let x = 0; x < width; x++) {
        const c1 = Math.floor((x / width) * chunkCount);
        const c2 = Math.min(chunkCount, Math.max(c1 + 1, Math.floor(((x + 1) / width) * chunkCount)));

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

        const yTop = midY - maxVal * midY;
        const yBottom = midY - minVal * midY;
        const barH = Math.max(1, yBottom - yTop);

        // Waveform column fill
        ctx.fillStyle = '#2272';
        ctx.fillRect(x, yTop, 1, barH);

        // Neon peak cap accents
        ctx.fillStyle = '#4A7F';
        ctx.fillRect(x, yTop, 1, 1);
        ctx.fillRect(x, Math.max(yTop, yBottom - 1), 1, 1);
      }
    }

    // 4. Viewport bounds box
    const totalMs = durationMs > 0 ? durationMs : 1;
    const startPx = Math.max(0, (viewStartMs / totalMs) * width);
    const endPx = Math.min(width, (viewEndMs / totalMs) * width);
    const boxW = Math.max(4, endPx - startPx);

    // Box fill
    ctx.fillStyle = 'rgba(74, 127, 255, 0.22)';
    ctx.fillRect(startPx, 0, boxW, height);

    // Box border
    ctx.strokeStyle = '#4A7F';
    ctx.lineWidth = 1;
    ctx.strokeRect(startPx + 0.5, 0.5, boxW - 1, height - 1);

    // 5. Mini Playhead
    if (currentMs !== undefined && currentMs >= 0 && currentMs <= totalMs) {
      const phX = (currentMs / totalMs) * width;
      ctx.strokeStyle = '#4A7F';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(phX, 0);
      ctx.lineTo(phX, height);
      ctx.stroke();
    }

    ctx.restore();
  }, [size, durationMs, viewStartMs, viewEndMs, currentMs, lodData, channels]);

  // Click & drag interaction
  const handlePointerAt = useCallback(
    (clientX: number) => {
      const el = containerRef.current;
      if (!el || durationMs <= 0) return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;

      const clickRatio = clamp((clientX - rect.left) / rect.width, 0, 1);
      const clickTimeMs = clickRatio * durationMs;
      const currentWindow = Math.max(10, viewEndMs - viewStartMs);

      let newStart = clickTimeMs - currentWindow / 2;
      let newEnd = clickTimeMs + currentWindow / 2;

      if (newStart < 0) {
        newStart = 0;
        newEnd = Math.min(durationMs, currentWindow);
      } else if (newEnd > durationMs) {
        newEnd = durationMs;
        newStart = Math.max(0, durationMs - currentWindow);
      }

      onViewRangeChange(newStart, newEnd);
    },
    [durationMs, viewStartMs, viewEndMs, onViewRangeChange]
  );

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    isDraggingRef.current = true;
    handlePointerAt(e.clientX);

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!isDraggingRef.current) return;
      handlePointerAt(moveEvent.clientX);
    };

    const onMouseUp = () => {
      isDraggingRef.current = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  return (
    <div
      ref={containerRef}
      className="mini-overview-wrapper"
      data-testid="mini-overview-canvas"
      onMouseDown={handleMouseDown}
      role="slider"
      aria-label="Overview waveform navigator"
      aria-valuemin={0}
      aria-valuemax={durationMs}
      aria-valuenow={viewStartMs}
      tabIndex={0}
    >
      <canvas ref={canvasRef} />
    </div>
  );
};
