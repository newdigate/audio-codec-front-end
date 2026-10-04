import { describe, it, expect } from 'vitest';
import { normalizeAudioFileInfo } from '../../src/main/main';

describe('Electron IPC Contract & Normalization', () => {
  it('normalizes raw scan results with default and inferred fields', () => {
    const raw = {
      filePath: '/path/to/my_beat.wav',
      fileName: 'my_beat.wav',
      sizeBytes: 1048576,
      status: 'pending',
      durationMs: 5000,
      bpm: 124.5,
    };

    const normalized = normalizeAudioFileInfo(raw);

    expect(normalized.filePath).toBe('/path/to/my_beat.wav');
    expect(normalized.fileName).toBe('my_beat.wav');
    expect(normalized.fileSizeBytes).toBe(1048576);
    expect(normalized.sizeBytes).toBe(1048576);
    expect(normalized.codec).toBe('WAV');
    expect(normalized.status).toBe('unanalyzed');
    expect(normalized.durationMs).toBe(5000);
    expect(normalized.bpm).toBe(124.5);
    expect(normalized.sampleRate).toBe(0);
    expect(normalized.channels).toBe(0);
  });

  it('preserves cached and error statuses', () => {
    const cached = normalizeAudioFileInfo({
      filePath: '/path/to/synth.flac',
      status: 'cached',
      sampleRate: 48000,
      channels: 2,
    });
    expect(cached.status).toBe('cached');
    expect(cached.codec).toBe('FLAC');
    expect(cached.sampleRate).toBe(48000);
    expect(cached.channels).toBe(2);

    const error = normalizeAudioFileInfo({
      filePath: '/path/to/corrupt.mp3',
      status: 'error',
      errorMessage: 'Invalid header',
    });
    expect(error.status).toBe('error');
    expect(error.errorMessage).toBe('Invalid header');
    expect(error.codec).toBe('MP3');
  });
});
