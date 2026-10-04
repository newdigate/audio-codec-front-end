import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WaveView } from '../../src/renderer/components/WaveView';
import { MiniOverviewCanvas } from '../../src/renderer/components/MiniOverviewCanvas';
import { DetailViewportCanvas } from '../../src/renderer/components/DetailViewportCanvas';
import type {
  AudioApi,
  FileAnalysisData,
  PlaybackState,
  LodData,
  BeatMarker,
} from '../../src/shared/audio_types';

describe('MiniOverviewCanvas Component', () => {
  const mockLod2: LodData = {
    downsampleRatio: 4096,
    chunkCount: 10,
    peaks: new Int8Array(40).fill(60),
  };

  it('renders overview canvas with bounds and responds to pointer click', () => {
    const onViewRangeChange = vi.fn();
    render(
      <div style={{ width: 800, height: 48 }}>
        <MiniOverviewCanvas
          durationMs={10000}
          viewStartMs={2000}
          viewEndMs={6000}
          currentMs={3000}
          isPlaying={true}
          lodData={mockLod2}
          channels={2}
          onViewRangeChange={onViewRangeChange}
        />
      </div>
    );

    const canvasWrapper = screen.getByTestId('mini-overview-canvas');
    expect(canvasWrapper).toBeDefined();

    // Mock getBoundingClientRect
    vi.spyOn(canvasWrapper, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 1000,
      height: 48,
      right: 1000,
      bottom: 48,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    // Click at 50% width -> 5000ms center. With 4000ms window -> [3000ms, 7000ms]
    fireEvent.mouseDown(canvasWrapper, { clientX: 500 });
    expect(onViewRangeChange).toHaveBeenCalledWith(3000, 7000);
  });
});

describe('DetailViewportCanvas Component', () => {
  const mockLods: LodData[] = [
    {
      downsampleRatio: 64,
      chunkCount: 100,
      peaks: new Int8Array(400).fill(50),
    },
    {
      downsampleRatio: 512,
      chunkCount: 50,
      peaks: new Int8Array(200).fill(40),
    },
  ];

  const mockBeatMarkers: BeatMarker[] = [
    { timeMs: 0, barIndex: 0, beatWithinBar: 0, isDownbeat: true, localBpm: 120 },
    { timeMs: 500, barIndex: 0, beatWithinBar: 1, isDownbeat: false, localBpm: 120 },
    { timeMs: 1000, barIndex: 0, beatWithinBar: 2, isDownbeat: false, localBpm: 120 },
    { timeMs: 1500, barIndex: 0, beatWithinBar: 3, isDownbeat: false, localBpm: 120 },
    { timeMs: 2000, barIndex: 1, beatWithinBar: 0, isDownbeat: true, localBpm: 120 },
  ];

  it('renders detail canvas and handles click-to-seek', () => {
    const onViewRangeChange = vi.fn();
    const onSelectionChange = vi.fn();
    const onSeek = vi.fn();

    render(
      <div style={{ width: 800, height: 300 }}>
        <DetailViewportCanvas
          durationMs={5000}
          sampleRate={44100}
          channels={2}
          viewStartMs={0}
          viewEndMs={5000}
          currentMs={1000}
          isPlaying={false}
          lods={mockLods}
          beatMarkers={mockBeatMarkers}
          selectionStartMs={null}
          selectionEndMs={null}
          onViewRangeChange={onViewRangeChange}
          onSelectionChange={onSelectionChange}
          onSeek={onSeek}
        />
      </div>
    );

    const canvasWrapper = screen.getByTestId('detail-viewport-canvas');
    expect(canvasWrapper).toBeDefined();

    vi.spyOn(canvasWrapper, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 1000,
      height: 300,
      right: 1000,
      bottom: 300,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    // Simple click without drag seeks to clicked time (250px -> 1250ms) AND clears selection
    fireEvent.mouseDown(canvasWrapper, { clientX: 250, button: 0 });
    fireEvent.mouseUp(window, { clientX: 250, button: 0 });

    expect(onSeek).toHaveBeenCalledWith(1250);
    expect(onSelectionChange).toHaveBeenCalledWith(null, null);
  });

  it('handles standard drag to pan viewport', () => {
    const onViewRangeChange = vi.fn();
    render(
      <DetailViewportCanvas
        durationMs={10000}
        sampleRate={44100}
        channels={2}
        viewStartMs={2000}
        viewEndMs={6000}
        lods={mockLods}
        beatMarkers={mockBeatMarkers}
        selectionStartMs={null}
        selectionEndMs={null}
        onViewRangeChange={onViewRangeChange}
        onSelectionChange={() => {}}
        onSeek={() => {}}
      />
    );

    const canvasWrapper = screen.getByTestId('detail-viewport-canvas');
    vi.spyOn(canvasWrapper, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 1000,
      height: 300,
      right: 1000,
      bottom: 300,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    // Standard drag without Shift: start at 500, move to 400 (drag left 100px)
    fireEvent.mouseDown(canvasWrapper, { clientX: 500, button: 0 });
    fireEvent.mouseMove(window, { clientX: 400 });

    expect(onViewRangeChange).toHaveBeenCalled();
  });

  it('handles Escape key to clear selection', () => {
    const onSelectionChange = vi.fn();
    render(
      <DetailViewportCanvas
        durationMs={10000}
        sampleRate={44100}
        channels={2}
        viewStartMs={0}
        viewEndMs={10000}
        lods={mockLods}
        beatMarkers={mockBeatMarkers}
        selectionStartMs={1000}
        selectionEndMs={3000}
        onViewRangeChange={() => {}}
        onSelectionChange={onSelectionChange}
        onSeek={() => {}}
      />
    );

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onSelectionChange).toHaveBeenCalledWith(null, null);
  });

  it('handles mouse wheel zoom centered at cursor', () => {
    const onViewRangeChange = vi.fn();
    render(
      <DetailViewportCanvas
        durationMs={10000}
        sampleRate={44100}
        channels={2}
        viewStartMs={2000}
        viewEndMs={8000}
        lods={mockLods}
        beatMarkers={mockBeatMarkers}
        selectionStartMs={null}
        selectionEndMs={null}
        onViewRangeChange={onViewRangeChange}
        onSelectionChange={() => {}}
        onSeek={() => {}}
      />
    );

    const canvasWrapper = screen.getByTestId('detail-viewport-canvas');
    vi.spyOn(canvasWrapper, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 1000,
      height: 300,
      right: 1000,
      bottom: 300,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    // Zoom in with deltaY < 0
    fireEvent.wheel(canvasWrapper, {
      clientX: 500, // center
      deltaY: -100,
      deltaX: 0,
    });

    expect(onViewRangeChange).toHaveBeenCalled();
    const [newStart, newEnd] = onViewRangeChange.mock.calls[0];
    expect(newEnd - newStart).toBeLessThan(6000); // zoomed in
  });

  it('handles drag for selection range with shift key', () => {
    const onSelectionChange = vi.fn();
    render(
      <DetailViewportCanvas
        durationMs={10000}
        sampleRate={44100}
        channels={2}
        viewStartMs={0}
        viewEndMs={10000}
        lods={mockLods}
        beatMarkers={mockBeatMarkers}
        selectionStartMs={null}
        selectionEndMs={null}
        onViewRangeChange={() => {}}
        onSelectionChange={onSelectionChange}
        onSeek={() => {}}
      />
    );

    const canvasWrapper = screen.getByTestId('detail-viewport-canvas');
    vi.spyOn(canvasWrapper, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 1000,
      height: 300,
      right: 1000,
      bottom: 300,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    // Start drag at x = 200 (2000ms) with shift
    fireEvent.mouseDown(canvasWrapper, { clientX: 200, shiftKey: true, button: 0 });
    // Move to x = 500 (5000ms)
    fireEvent.mouseMove(window, { clientX: 500, shiftKey: true });

    expect(onSelectionChange).toHaveBeenCalledWith(2000, 5000);
  });
});

describe('WaveView Component', () => {
  let mockAudioApi: Partial<AudioApi>;
  let playbackTickCallback: ((state: PlaybackState) => void) | null = null;

  const mockAnalysis: FileAnalysisData = {
    filePath: '/audio/lead.wav',
    fileName: 'lead.wav',
    durationMs: 4000,
    sampleRate: 44100,
    channels: 2,
    bpm: 128.5,
    confidence: 97,
    timeSignature: [4, 4],
    lods: [
      { downsampleRatio: 64, chunkCount: 100, peaks: new Int8Array(400) },
      { downsampleRatio: 512, chunkCount: 50, peaks: new Int8Array(200) },
      { downsampleRatio: 4096, chunkCount: 10, peaks: new Int8Array(40) },
    ],
    beatMarkers: [
      { timeMs: 0, barIndex: 0, beatWithinBar: 0, isDownbeat: true, localBpm: 128.5 },
      { timeMs: 466, barIndex: 0, beatWithinBar: 1, isDownbeat: false, localBpm: 128.5 },
    ],
  };

  beforeEach(() => {
    playbackTickCallback = null;
    mockAudioApi = {
      loadFileAnalysis: vi.fn().mockResolvedValue(mockAnalysis),
      playbackPlay: vi.fn().mockResolvedValue(true),
      playbackPause: vi.fn().mockResolvedValue(true),
      playbackStop: vi.fn().mockResolvedValue(true),
      playbackSeek: vi.fn().mockResolvedValue(true),
      playbackSetVolume: vi.fn().mockResolvedValue(undefined),
      onPlaybackTick: vi.fn().mockImplementation((cb) => {
        playbackTickCallback = cb;
        return () => {
          playbackTickCallback = null;
        };
      }),
    };
    window.audioApi = mockAudioApi as AudioApi;
  });

  it('fetches analysis on mount and displays metadata, timecode, and BPM', async () => {
    render(<WaveView filePath="/audio/lead.wav" fileName="lead.wav" />);

    expect(screen.getByTestId('wave-view')).toBeDefined();

    await waitFor(() => {
      expect(mockAudioApi.loadFileAnalysis).toHaveBeenCalledWith('/audio/lead.wav', false);
      expect(screen.getByText(/128\.5 BPM/i)).toBeDefined();
      expect(screen.getByText(/00:00\.000/i)).toBeDefined();
      expect(screen.getByText(/00:04\.000/i)).toBeDefined();
      expect(screen.getByText(/lead\.wav • Stereo • 44\.1 kHz/i)).toBeDefined();
    });
  });

  it('handles playback transport: play, pause, stop', async () => {
    render(<WaveView filePath="/audio/lead.wav" fileName="lead.wav" />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /play/i })).toBeDefined();
    });

    // 1. Play
    const playBtn = screen.getByRole('button', { name: /play/i });
    fireEvent.click(playBtn);

    await waitFor(() => {
      expect(mockAudioApi.playbackPlay).toHaveBeenCalledWith('/audio/lead.wav', 0);
      expect(screen.getByRole('button', { name: /pause/i })).toBeDefined();
    });

    // 2. Pause
    const pauseBtn = screen.getByRole('button', { name: /pause/i });
    fireEvent.click(pauseBtn);

    await waitFor(() => {
      expect(mockAudioApi.playbackPause).toHaveBeenCalled();
      expect(screen.getByRole('button', { name: /play/i })).toBeDefined();
    });

    // 3. Stop
    const stopBtn = screen.getByRole('button', { name: /stop/i });
    fireEvent.click(stopBtn);

    await waitFor(() => {
      expect(mockAudioApi.playbackStop).toHaveBeenCalled();
    });
  });

  it('toggles playback with Spacebar key press', async () => {
    render(<WaveView filePath="/audio/lead.wav" fileName="lead.wav" />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /play/i })).toBeDefined();
    });

    // Press Space to Play
    fireEvent.keyDown(window, { code: 'Space' });
    await waitFor(() => {
      expect(mockAudioApi.playbackPlay).toHaveBeenCalledWith('/audio/lead.wav', 0);
    });

    // Simulate playback tick active
    act(() => {
      playbackTickCallback?.({ isPlaying: true, currentMs: 1200 });
    });

    // Press Space to Pause
    fireEvent.keyDown(window, { code: 'Space' });
    await waitFor(() => {
      expect(mockAudioApi.playbackPause).toHaveBeenCalled();
    });
  });

  it('adjusts playback volume via slider', async () => {
    render(<WaveView filePath="/audio/lead.wav" fileName="lead.wav" />);

    const volumeSlider = screen.getByLabelText(/volume slider/i);
    fireEvent.change(volumeSlider, { target: { value: '0.65' } });

    await waitFor(() => {
      expect(mockAudioApi.playbackSetVolume).toHaveBeenCalledWith(0.65);
      expect(screen.getByText('65%')).toBeDefined();
    });
  });

  it('handles zoom controls (+, -, Fit)', async () => {
    render(<WaveView filePath="/audio/lead.wav" fileName="lead.wav" />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /zoom in/i })).toBeDefined();
    });

    const zoomInBtn = screen.getByRole('button', { name: /zoom in/i });
    fireEvent.click(zoomInBtn);

    const zoomOutBtn = screen.getByRole('button', { name: /zoom out/i });
    fireEvent.click(zoomOutBtn);

    const zoomFitBtn = screen.getByRole('button', { name: /fit to window/i });
    fireEvent.click(zoomFitBtn);
  });

  it('allows clearing selection via Escape key and clear button', async () => {
    render(<WaveView filePath="/audio/lead.wav" fileName="lead.wav" />);

    await waitFor(() => {
      expect(screen.getByTestId('detail-viewport-canvas')).toBeDefined();
    });

    const canvasWrapper = screen.getByTestId('detail-viewport-canvas');
    vi.spyOn(canvasWrapper, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 1000,
      height: 300,
      right: 1000,
      bottom: 300,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    // Create selection with Shift-drag
    fireEvent.mouseDown(canvasWrapper, { clientX: 250, shiftKey: true, button: 0 });
    fireEvent.mouseMove(window, { clientX: 500, shiftKey: true });

    // Loop info and clear button should appear
    expect(screen.getByText(/Loop: 00:01\.000 - 00:02\.000/i)).toBeDefined();
    const clearBtn = screen.getByRole('button', { name: /clear selection/i });
    expect(clearBtn).toBeDefined();

    // Click clear button
    fireEvent.click(clearBtn);
    expect(screen.queryByText(/Loop: 00:01\.000/i)).toBeNull();

    // Re-create selection and clear with Escape key
    fireEvent.mouseDown(canvasWrapper, { clientX: 250, shiftKey: true, button: 0 });
    fireEvent.mouseMove(window, { clientX: 500, shiftKey: true });
    expect(screen.getByText(/Loop: 00:01\.000 - 00:02\.000/i)).toBeDefined();

    fireEvent.keyDown(window, { code: 'Escape' });
    expect(screen.queryByText(/Loop: 00:01\.000/i)).toBeNull();
  });
});
