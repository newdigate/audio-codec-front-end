/**
 * Waveform coordinate transformations, LOD selection, and timecode formatting.
 */

/**
 * Converts a timestamp in milliseconds to a horizontal pixel coordinate
 * within the given viewport range and canvas width.
 */
export function timeToPixel(
  timeMs: number,
  viewStartMs: number,
  viewEndMs: number,
  width: number
): number {
  if (width <= 0 || viewEndMs <= viewStartMs) {
    return 0;
  }
  return ((timeMs - viewStartMs) / (viewEndMs - viewStartMs)) * width;
}

/**
 * Converts a horizontal pixel coordinate to a timestamp in milliseconds
 * within the given viewport range and canvas width.
 */
export function pixelToTime(
  px: number,
  viewStartMs: number,
  viewEndMs: number,
  width: number
): number {
  if (width <= 0) {
    return viewStartMs;
  }
  return viewStartMs + (px / width) * (viewEndMs - viewStartMs);
}

/**
 * Selects the optimal LOD tier based on samples per pixel:
 * - < 500 samples/px: LOD 0 (detailed sample waveform)
 * - 500 .. 8000 samples/px: LOD 1 (medium zoom block preview)
 * - > 8000 samples/px: LOD 2 (overview peak envelope)
 */
export function selectBestLod(samplesPerPixel: number): number {
  if (samplesPerPixel < 500) {
    return 0;
  }
  if (samplesPerPixel <= 8000) {
    return 1;
  }
  return 2;
}

/**
 * Formats a duration or position in milliseconds to 'mm:ss.xxx' string.
 * Example: 65432 -> '01:05.432'
 */
export function formatTimecode(timeMs: number): string {
  if (isNaN(timeMs) || timeMs < 0) {
    timeMs = 0;
  }
  const totalSeconds = Math.floor(timeMs / 1000);
  const ms = Math.floor(timeMs % 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  const xxx = String(ms).padStart(3, '0');

  return `${mm}:${ss}.${xxx}`;
}

/**
 * Helper to clamp a number between min and max.
 */
export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}
