import { describe, it, expect } from 'vitest';
import {
  timeToPixel,
  pixelToTime,
  selectBestLod,
  formatTimecode,
  clamp,
} from '../../src/renderer/utils/wave_math';

describe('Waveform Coordinate Math', () => {
  it('converts time to pixel and back accurately', () => {
    const canvasWidth = 1000;
    const viewStartMs = 2000;
    const viewEndMs = 6000;

    const px = timeToPixel(4000, viewStartMs, viewEndMs, canvasWidth);
    expect(px).toBe(500);

    const time = pixelToTime(500, viewStartMs, viewEndMs, canvasWidth);
    expect(time).toBe(4000);
  });

  it('handles edge cases at boundary values', () => {
    const canvasWidth = 1000;
    const viewStartMs = 1000;
    const viewEndMs = 5000;

    // Left boundary
    expect(timeToPixel(1000, viewStartMs, viewEndMs, canvasWidth)).toBe(0);
    expect(pixelToTime(0, viewStartMs, viewEndMs, canvasWidth)).toBe(1000);

    // Right boundary
    expect(timeToPixel(5000, viewStartMs, viewEndMs, canvasWidth)).toBe(1000);
    expect(pixelToTime(1000, viewStartMs, viewEndMs, canvasWidth)).toBe(5000);

    // Degenerate width or zero duration
    expect(timeToPixel(2000, 2000, 2000, canvasWidth)).toBe(0);
    expect(timeToPixel(2000, 1000, 5000, 0)).toBe(0);
    expect(pixelToTime(500, 1000, 5000, 0)).toBe(1000);
  });

  it('selects LOD 0 for high zoom, LOD 1 for medium zoom, LOD 2 for overview', () => {
    expect(selectBestLod(100)).toBe(0); // 100 samples per pixel -> LOD 0
    expect(selectBestLod(2000)).toBe(1); // 2000 samples per pixel -> LOD 1
    expect(selectBestLod(30000)).toBe(2); // 30000 samples per pixel -> LOD 2
  });

  it('boundary conditions for selectBestLod', () => {
    expect(selectBestLod(499)).toBe(0);
    expect(selectBestLod(500)).toBe(1);
    expect(selectBestLod(8000)).toBe(1);
    expect(selectBestLod(8001)).toBe(2);
  });

  it('formats timecode correctly', () => {
    expect(formatTimecode(0)).toBe('00:00.000');
    expect(formatTimecode(500)).toBe('00:00.500');
    expect(formatTimecode(65432)).toBe('01:05.432');
    expect(formatTimecode(3661050)).toBe('61:01.050');
    expect(formatTimecode(-50)).toBe('00:00.000');
  });

  it('clamps values within range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });
});
