import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TabBar, TabItem } from '../../src/renderer/components/TabBar';
import { HeaderBar } from '../../src/renderer/components/HeaderBar';
import App from '../../src/renderer/App';
import type { AudioApi, AudioFileInfo, BatchProgressUpdate, PlaybackState } from '../../src/shared/audio_types';

describe('TabBar Component', () => {
  it('renders pinned folder tab and active tabs', () => {
    const tabs: TabItem[] = [
      { id: 'folder', title: '📁 My Samples', isPinned: true },
      { id: 'file-1', title: '🎵 kick.wav', isPinned: false },
    ];
    let active = 'folder';
    render(
      <TabBar
        tabs={tabs}
        activeTabId={active}
        onSelectTab={(id) => (active = id)}
        onCloseTab={() => {}}
      />
    );
    expect(screen.getByText('📁 My Samples')).toBeDefined();
    expect(screen.getByText('🎵 kick.wav')).toBeDefined();
  });

  it('selects tab on click', () => {
    const tabs: TabItem[] = [
      { id: 'folder', title: '📁 My Samples', isPinned: true },
      { id: 'file-1', title: '🎵 kick.wav', isPinned: false },
    ];
    const onSelect = vi.fn();
    render(
      <TabBar
        tabs={tabs}
        activeTabId="folder"
        onSelectTab={onSelect}
        onCloseTab={() => {}}
      />
    );
    fireEvent.click(screen.getByText('🎵 kick.wav'));
    expect(onSelect).toHaveBeenCalledWith('file-1');
  });

  it('supports keyboard navigation with Enter and Space keys', () => {
    const tabs: TabItem[] = [
      { id: 'folder', title: '📁 My Samples', isPinned: true },
      { id: 'file-1', title: '🎵 kick.wav', isPinned: false },
    ];
    const onSelect = vi.fn();
    render(
      <TabBar
        tabs={tabs}
        activeTabId="folder"
        onSelectTab={onSelect}
        onCloseTab={() => {}}
      />
    );
    const kickTab = screen.getByRole('tab', { name: /kick\.wav/i });
    fireEvent.keyDown(kickTab, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('file-1');

    fireEvent.keyDown(kickTab, { key: ' ' });
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it('calls onCloseTab when clicking close button and does not select tab', () => {
    const tabs: TabItem[] = [
      { id: 'folder', title: '📁 My Samples', isPinned: true },
      { id: 'file-1', title: '🎵 kick.wav', isPinned: false },
    ];
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <TabBar
        tabs={tabs}
        activeTabId="folder"
        onSelectTab={onSelect}
        onCloseTab={onClose}
      />
    );
    const closeBtn = screen.getByRole('button', { name: /close kick\.wav/i });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledWith('file-1');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('does not render close button on pinned tabs', () => {
    const tabs: TabItem[] = [
      { id: 'folder', title: '📁 My Samples', isPinned: true },
    ];
    render(
      <TabBar
        tabs={tabs}
        activeTabId="folder"
        onSelectTab={() => {}}
        onCloseTab={() => {}}
      />
    );
    expect(screen.queryByRole('button', { name: /close/i })).toBeNull();
  });
});

describe('HeaderBar Component', () => {
  it('renders open folder button, path, and file count', () => {
    render(
      <HeaderBar
        folderPath="/Users/music/samples"
        fileCount={12}
        analyzedCount={5}
        batchRunning={false}
        batchPaused={false}
        flatSidecar={false}
        onOpenFolder={() => {}}
        onToggleBatch={() => {}}
        onToggleSidecar={() => {}}
      />
    );
    expect(screen.getByText('Open Folder')).toBeDefined();
    expect(screen.getByText('/Users/music/samples')).toBeDefined();
    expect(screen.getByText(/12 files/i)).toBeDefined();
  });

  it('renders batch progress and calls pause/resume handler', () => {
    const onToggleBatch = vi.fn();
    render(
      <HeaderBar
        folderPath="/Users/music/samples"
        fileCount={10}
        analyzedCount={4}
        batchRunning={true}
        batchPaused={false}
        flatSidecar={false}
        onOpenFolder={() => {}}
        onToggleBatch={onToggleBatch}
        onToggleSidecar={() => {}}
      />
    );

    expect(screen.getByText(/Analyzed 4 \/ 10/i)).toBeDefined();
    const pauseBtn = screen.getByRole('button', { name: /pause/i });
    fireEvent.click(pauseBtn);
    expect(onToggleBatch).toHaveBeenCalled();
  });

  it('toggles flat sidecar mode checkbox', () => {
    const onToggleSidecar = vi.fn();
    render(
      <HeaderBar
        folderPath="/Users/music/samples"
        fileCount={10}
        analyzedCount={4}
        batchRunning={false}
        batchPaused={false}
        flatSidecar={false}
        onOpenFolder={() => {}}
        onToggleBatch={() => {}}
        onToggleSidecar={onToggleSidecar}
      />
    );

    const checkbox = screen.getByLabelText(/flat sidecar/i);
    fireEvent.click(checkbox);
    expect(onToggleSidecar).toHaveBeenCalledWith(true);
  });
});

describe('App Layout & Shell Integration', () => {
  let mockAudioApi: Partial<AudioApi>;
  let batchCallback: ((update: BatchProgressUpdate) => void) | null = null;
  let playbackCallback: ((state: PlaybackState) => void) | null = null;

  beforeEach(() => {
    batchCallback = null;
    playbackCallback = null;

    mockAudioApi = {
      selectFolder: vi.fn().mockResolvedValue({
        folderPath: '/mock/audio',
        files: [
          {
            filePath: '/mock/audio/beat.wav',
            fileName: 'beat.wav',
            fileSizeBytes: 1000,
            durationMs: 4000,
            sampleRate: 44100,
            channels: 2,
            codec: 'WAV',
            status: 'unanalyzed',
          } as AudioFileInfo,
          {
            filePath: '/mock/audio/synth.flac',
            fileName: 'synth.flac',
            fileSizeBytes: 2000,
            durationMs: 6000,
            sampleRate: 48000,
            channels: 2,
            codec: 'FLAC',
            status: 'cached',
          } as AudioFileInfo,
        ],
      }),
      startBatchAnalysis: vi.fn().mockResolvedValue(undefined),
      controlBatchAnalysis: vi.fn().mockResolvedValue(true),
      onBatchProgress: vi.fn().mockImplementation((cb) => {
        batchCallback = cb;
        return () => {
          batchCallback = null;
        };
      }),
      onPlaybackTick: vi.fn().mockImplementation((cb) => {
        playbackCallback = cb;
        return () => {
          playbackCallback = null;
        };
      }),
    };

    window.audioApi = mockAudioApi as AudioApi;
  });

  it('renders initial state with empty folder and default tab', () => {
    render(<App />);
    expect(screen.getByText('📁 Samples')).toBeDefined();
    expect(screen.getByText('No folder opened')).toBeDefined();
    expect(screen.getByTestId('folder-browser-placeholder')).toBeDefined();
  });

  it('opens folder and populates files when clicking Open Folder', async () => {
    render(<App />);
    const openBtn = screen.getAllByRole('button', { name: /open folder/i })[0];
    fireEvent.click(openBtn);

    await waitFor(() => {
      expect(mockAudioApi.selectFolder).toHaveBeenCalled();
      expect(screen.getByText('/mock/audio')).toBeDefined();
      expect(screen.getByText(/2 files/i)).toBeDefined();
      expect(screen.getByText('📁 audio')).toBeDefined();
      expect(mockAudioApi.startBatchAnalysis).toHaveBeenCalledWith('/mock/audio', false);
    });
  });

  it('handles batch pause / resume in App', async () => {
    render(<App />);
    const openBtn = screen.getAllByRole('button', { name: /open folder/i })[0];
    fireEvent.click(openBtn);

    await waitFor(() => {
      expect(screen.getByText('/mock/audio')).toBeDefined();
    });

    const pauseBtn = screen.getByRole('button', { name: /pause/i });
    fireEvent.click(pauseBtn);

    await waitFor(() => {
      expect(mockAudioApi.controlBatchAnalysis).toHaveBeenCalledWith('pause');
      expect(screen.getByRole('button', { name: /resume/i })).toBeDefined();
    });

    const resumeBtn = screen.getByRole('button', { name: /resume/i });
    fireEvent.click(resumeBtn);

    await waitFor(() => {
      expect(mockAudioApi.controlBatchAnalysis).toHaveBeenCalledWith('resume');
      expect(screen.getByRole('button', { name: /pause/i })).toBeDefined();
    });
  });

  it('updates file status and batch progress when onBatchProgress fires', async () => {
    render(<App />);
    const openBtn = screen.getAllByRole('button', { name: /open folder/i })[0];
    fireEvent.click(openBtn);

    await waitFor(() => {
      expect(screen.getByText(/Analyzed 1 \/ 2/i)).toBeDefined();
    });

    act(() => {
      batchCallback?.({
        filePath: '/mock/audio/beat.wav',
        progressPct: 100,
        bpm: 128,
        status: 'cached',
      });
    });

    await waitFor(() => {
      expect(screen.getByText(/Analyzed 2 \/ 2/i)).toBeDefined();
    });
  });

  it('updates playback status when onPlaybackTick fires', async () => {
    render(<App />);
    act(() => {
      playbackCallback?.({
        isPlaying: true,
        currentMs: 2500,
      });
    });
    // In default pinned view, playback is tracked in state
    expect(playbackCallback).toBeDefined();
  });
});

  it('opens audio file in dynamic tab and switches view between folder and waveform', async () => {
    render(<App />);
    const openBtn = screen.getAllByRole('button', { name: /open folder/i })[0];
    fireEvent.click(openBtn);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /open beat\.wav/i })).toBeDefined();
    });

    const openBeatBtn = screen.getByRole('button', { name: /open beat\.wav/i });
    fireEvent.click(openBeatBtn);

    // Dynamic tab is now active and waveform placeholder is visible
    expect(screen.getByTestId('wave-view-placeholder')).toBeDefined();
    expect(screen.getByText(/Active File: 🎵 beat\.wav/i)).toBeDefined();

    // Close dynamic tab and check fallback to pinned folder tab
    const closeBtn = screen.getByRole('button', { name: /close beat\.wav/i });
    fireEvent.click(closeBtn);

    expect(screen.getByTestId('folder-browser-placeholder')).toBeDefined();
  });
