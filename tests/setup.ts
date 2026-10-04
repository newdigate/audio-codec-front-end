import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// Mock Canvas 2D context for jsdom environment
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = vi.fn().mockImplementation((contextId: string) => {
    if (contextId === '2d') {
      return {
        canvas: {},
        fillStyle: '#000000',
        strokeStyle: '#000000',
        lineWidth: 1,
        font: '10px sans-serif',
        textBaseline: 'top',
        textAlign: 'left',
        fillRect: vi.fn(),
        strokeRect: vi.fn(),
        clearRect: vi.fn(),
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        stroke: vi.fn(),
        fill: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
        scale: vi.fn(),
        fillText: vi.fn(),
        strokeText: vi.fn(),
        closePath: vi.fn(),
        measureText: vi.fn().mockReturnValue({ width: 50 }),
      };
    }
    return null;
  }) as any;
}

afterEach(() => {
  cleanup();
});
