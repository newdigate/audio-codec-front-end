import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AudioTableRow, formatDuration, formatSampleRateChannels } from '../../src/renderer/components/AudioTableRow';
import { ContextMenu } from '../../src/renderer/components/ContextMenu';
import { FolderBrowserView } from '../../src/renderer/components/FolderBrowserView';
import type { AudioFileInfo, AudioApi, PlaybackState } from '../../src/shared/audio_types';

describe('AudioTableRow', () => {
  const sampleFile: AudioFileInfo = {
    filePath: '/samples/snare.wav',
    fileName: 'snare.wav',
    fileSizeBytes: 10240,
    durationMs: 500,
    sampleRate: 44100,
    channels: 2,
    codec: 'WAV',
    status: 'cached',
    bpm: 124.5,
  };

  it('displays audio metadata, bpm, and action buttons', () => {
    render(
      <AudioTableRow
        file={sampleFile}
        isPlaying={false}
        onPlay={() => {}}
        onOpenTab={() => {}}
      />
    );
    expect(screen.getByText('snare.wav')).toBeDefined();
    expect(screen.getByText('124.5 BPM')).toBeDefined();
    expect(screen.getByText('WAV')).toBeDefined();
    expect(screen.getByText('00:00.500')).toBeDefined();
    expect(screen.getByText('44.1 kHz / Stereo')).toBeDefined();
    expect(screen.getByText('Ready')).toBeDefined();
    expect(screen.getByRole('button', { name: /play snare\.wav/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /open snare\.wav/i })).toBeDefined();
  });

  it('formats duration helper correctly', () => {
    expect(formatDuration(0)).toBe('00:00.000');
    expect(formatDuration(500)).toBe('00:00.500');
    expect(formatDuration(65432)).toBe('01:05.432');
    expect(formatDuration(undefined)).toBe('--:--.---');
  });

  it('formats sample rate and channels helper correctly', () => {
    expect(formatSampleRateChannels(44100, 2)).toBe('44.1 kHz / Stereo');
    expect(formatSampleRateChannels(48000, 1)).toBe('48.0 kHz / Mono');
    expect(formatSampleRateChannels(96000, 6)).toBe('96.0 kHz / 6 ch');
    expect(formatSampleRateChannels(undefined, undefined)).toBe('-');
  });

  it('renders analyzing status with progress percentage', () => {
    const analyzingFile: AudioFileInfo = {
      ...sampleFile,
      status: 'analyzing',
      progressPct: 67,
      bpm: undefined,
    };
    render(
      <AudioTableRow
        file={analyzingFile}
        isPlaying={false}
        onPlay={() => {}}
        onOpenTab={() => {}}
      />
    );
    expect(screen.getByText('67%')).toBeDefined();
    expect(screen.getByText('-')).toBeDefined(); // unanalyzed BPM
  });

  it('renders unanalyzed and error status badges', () => {
    const unanalyzedFile: AudioFileInfo = {
      ...sampleFile,
      status: 'unanalyzed',
      bpm: undefined,
    };
    const { rerender } = render(
      <AudioTableRow
        file={unanalyzedFile}
        isPlaying={false}
        onPlay={() => {}}
        onOpenTab={() => {}}
      />
    );
    expect(screen.getByText('Unanalyzed')).toBeDefined();

    const errorFile: AudioFileInfo = {
      ...sampleFile,
      status: 'error',
      errorMessage: 'Corrupt file header',
    };
    rerender(
      <AudioTableRow
        file={errorFile}
        isPlaying={false}
        onPlay={() => {}}
        onOpenTab={() => {}}
      />
    );
    expect(screen.getByText('Error')).toBeDefined();
  });

  it('handles play/stop audition toggle', () => {
    const onPlay = vi.fn();
    const { rerender } = render(
      <AudioTableRow
        file={sampleFile}
        isPlaying={false}
        onPlay={onPlay}
        onOpenTab={() => {}}
      />
    );

    const playBtn = screen.getByRole('button', { name: /play snare\.wav/i });
    fireEvent.click(playBtn);
    expect(onPlay).toHaveBeenCalledWith(sampleFile);

    rerender(
      <AudioTableRow
        file={sampleFile}
        isPlaying={true}
        onPlay={onPlay}
        onOpenTab={() => {}}
      />
    );
    const stopBtn = screen.getByRole('button', { name: /stop snare\.wav/i });
    fireEvent.click(stopBtn);
    expect(onPlay).toHaveBeenCalledTimes(2);
  });

  it('handles opening tab via button and double click', () => {
    const onOpenTab = vi.fn();
    render(
      <AudioTableRow
        file={sampleFile}
        isPlaying={false}
        onPlay={() => {}}
        onOpenTab={onOpenTab}
      />
    );

    const openBtn = screen.getByRole('button', { name: /open snare\.wav/i });
    fireEvent.click(openBtn);
    expect(onOpenTab).toHaveBeenCalledWith(sampleFile);

    const row = screen.getByRole('row');
    fireEvent.doubleClick(row);
    expect(onOpenTab).toHaveBeenCalledTimes(2);
  });

  it('handles right click context menu event', () => {
    const onContextMenu = vi.fn();
    render(
      <AudioTableRow
        file={sampleFile}
        isPlaying={false}
        onPlay={() => {}}
        onOpenTab={() => {}}
        onContextMenu={onContextMenu}
      />
    );

    const row = screen.getByRole('row');
    fireEvent.contextMenu(row);
    expect(onContextMenu).toHaveBeenCalled();
  });
});

describe('ContextMenu Component', () => {
  const sampleFile: AudioFileInfo = {
    filePath: '/samples/snare.wav',
    fileName: 'snare.wav',
    fileSizeBytes: 10240,
    durationMs: 500,
    sampleRate: 44100,
    channels: 2,
    codec: 'WAV',
    status: 'cached',
    bpm: 124.5,
  };

  it('renders context actions and file title', () => {
    render(
      <ContextMenu
        x={100}
        y={150}
        file={sampleFile}
        onClose={() => {}}
        onOpenTab={() => {}}
      />
    );

    expect(screen.getByText('snare.wav')).toBeDefined();
    expect(screen.getByRole('menuitem', { name: /open in new tab/i })).toBeDefined();
    expect(screen.getByRole('menuitem', { name: /re-analyze file/i })).toBeDefined();
    expect(screen.getByRole('menuitem', { name: /reveal in finder/i })).toBeDefined();
  });

  it('calls onOpenTab and onClose when clicking Open in New Tab', () => {
    const onOpenTab = vi.fn();
    const onClose = vi.fn();
    render(
      <ContextMenu
        x={100}
        y={150}
        file={sampleFile}
        onClose={onClose}
        onOpenTab={onOpenTab}
      />
    );

    fireEvent.click(screen.getByRole('menuitem', { name: /open in new tab/i }));
    expect(onOpenTab).toHaveBeenCalledWith(sampleFile);
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onReanalyze and onClose when clicking Re-analyze File', () => {
    const onReanalyze = vi.fn();
    const onClose = vi.fn();
    render(
      <ContextMenu
        x={100}
        y={150}
        file={sampleFile}
        onClose={onClose}
        onOpenTab={() => {}}
        onReanalyze={onReanalyze}
      />
    );

    fireEvent.click(screen.getByRole('menuitem', { name: /re-analyze file/i }));
    expect(onReanalyze).toHaveBeenCalledWith(sampleFile);
    expect(onClose).toHaveBeenCalled();
  });

  it('calls window.audioApi.revealInFinder when clicking Reveal in Finder', async () => {
    const revealInFinderMock = vi.fn().mockResolvedValue(undefined);
    window.audioApi = {
      ...(window.audioApi || {}),
      revealInFinder: revealInFinderMock,
    } as unknown as AudioApi;

    const onClose = vi.fn();
    render(
      <ContextMenu
        x={100}
        y={150}
        file={sampleFile}
        onClose={onClose}
        onOpenTab={() => {}}
      />
    );

    fireEvent.click(screen.getByRole('menuitem', { name: /reveal in finder/i }));
    expect(revealInFinderMock).toHaveBeenCalledWith('/samples/snare.wav');
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape key', () => {
    const onClose = vi.fn();
    render(
      <ContextMenu
        x={100}
        y={150}
        file={sampleFile}
        onClose={onClose}
        onOpenTab={() => {}}
      />
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on click outside', () => {
    const onClose = vi.fn();
    render(
      <div>
        <div data-testid="outside-element">Outside</div>
        <ContextMenu
          x={100}
          y={150}
          file={sampleFile}
          onClose={onClose}
          onOpenTab={() => {}}
        />
      </div>
    );

    fireEvent.mouseDown(screen.getByTestId('outside-element'));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('FolderBrowserView Component', () => {
  let mockAudioApi: Partial<AudioApi>;
  let playbackTickCallback: ((state: PlaybackState) => void) | null = null;

  const mockFiles: AudioFileInfo[] = [
    {
      filePath: '/samples/kick.wav',
      fileName: 'kick.wav',
      fileSizeBytes: 20000,
      durationMs: 400,
      sampleRate: 44100,
      channels: 1,
      codec: 'WAV',
      status: 'cached',
      bpm: 120.0,
    },
    {
      filePath: '/samples/hat.wav',
      fileName: 'hat.wav',
      fileSizeBytes: 10000,
      durationMs: 200,
      sampleRate: 48000,
      channels: 2,
      codec: 'FLAC',
      status: 'unanalyzed',
    },
    {
      filePath: '/samples/loop.wav',
      fileName: 'loop.wav',
      fileSizeBytes: 80000,
      durationMs: 2000,
      sampleRate: 44100,
      channels: 2,
      codec: 'WAV',
      status: 'cached',
      bpm: 130.0,
    },
  ];

  beforeEach(() => {
    playbackTickCallback = null;
    mockAudioApi = {
      playbackPlay: vi.fn().mockResolvedValue(true),
      playbackStop: vi.fn().mockResolvedValue(true),
      revealInFinder: vi.fn().mockResolvedValue(undefined),
      onPlaybackTick: vi.fn().mockImplementation((cb) => {
        playbackTickCallback = cb;
        return () => {
          playbackTickCallback = null;
        };
      }),
    };
    window.audioApi = mockAudioApi as AudioApi;
  });

  it('renders empty state when folderPath is null', () => {
    const onOpenFolder = vi.fn();
    render(
      <FolderBrowserView
        folderPath={null}
        files={[]}
        onOpenFileTab={() => {}}
        onOpenFolder={onOpenFolder}
      />
    );

    expect(screen.getByText(/no folder opened/i)).toBeDefined();
    const openBtn = screen.getByRole('button', { name: /open folder/i });
    fireEvent.click(openBtn);
    expect(onOpenFolder).toHaveBeenCalled();
  });

  it('renders empty folder state when folderPath is set but files is empty', () => {
    render(
      <FolderBrowserView
        folderPath="/samples/empty"
        files={[]}
        onOpenFileTab={() => {}}
      />
    );

    expect(screen.getByText(/no audio files found/i)).toBeDefined();
  });

  it('renders virtualized file rows and table header', () => {
    render(
      <FolderBrowserView
        folderPath="/samples"
        files={mockFiles}
        onOpenFileTab={() => {}}
      />
    );

    expect(screen.getByText('Name')).toBeDefined();
    expect(screen.getByText('Duration')).toBeDefined();
    expect(screen.getByText('BPM')).toBeDefined();
    expect(screen.getByText('Status')).toBeDefined();

    expect(screen.getByText('kick.wav')).toBeDefined();
    expect(screen.getByText('hat.wav')).toBeDefined();
    expect(screen.getByText('loop.wav')).toBeDefined();
  });

  it('handles audition playback play and stop', async () => {
    render(
      <FolderBrowserView
        folderPath="/samples"
        files={mockFiles}
        onOpenFileTab={() => {}}
      />
    );

    const kickPlayBtn = screen.getByRole('button', { name: /play kick\.wav/i });
    fireEvent.click(kickPlayBtn);

    await waitFor(() => {
      expect(mockAudioApi.playbackPlay).toHaveBeenCalledWith('/samples/kick.wav', 0);
      expect(screen.getByRole('button', { name: /stop kick\.wav/i })).toBeDefined();
    });

    const kickStopBtn = screen.getByRole('button', { name: /stop kick\.wav/i });
    fireEvent.click(kickStopBtn);

    await waitFor(() => {
      expect(mockAudioApi.playbackStop).toHaveBeenCalled();
      expect(screen.getByRole('button', { name: /play kick\.wav/i })).toBeDefined();
    });
  });

  it('stops audition state when playbackTick reports isPlaying false', async () => {
    render(
      <FolderBrowserView
        folderPath="/samples"
        files={mockFiles}
        onOpenFileTab={() => {}}
      />
    );

    const kickPlayBtn = screen.getByRole('button', { name: /play kick\.wav/i });
    fireEvent.click(kickPlayBtn);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /stop kick\.wav/i })).toBeDefined();
    });

    act(() => {
      playbackTickCallback?.({ isPlaying: false, currentMs: 400 });
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /play kick\.wav/i })).toBeDefined();
    });
  });

  it('opens file tab when clicking Open or double-clicking a row', () => {
    const onOpenFileTab = vi.fn();
    render(
      <FolderBrowserView
        folderPath="/samples"
        files={mockFiles}
        onOpenFileTab={onOpenFileTab}
      />
    );

    const openKickBtn = screen.getByRole('button', { name: /open kick\.wav/i });
    fireEvent.click(openKickBtn);
    expect(onOpenFileTab).toHaveBeenCalledWith(mockFiles[0]);

    const hatRow = screen.getByTestId('audio-row-hat.wav');
    fireEvent.doubleClick(hatRow);
    expect(onOpenFileTab).toHaveBeenCalledWith(mockFiles[1]);
  });

  it('opens context menu on right click of a row and executes action', async () => {
    const onOpenFileTab = vi.fn();
    render(
      <FolderBrowserView
        folderPath="/samples"
        files={mockFiles}
        onOpenFileTab={onOpenFileTab}
      />
    );

    const kickRow = screen.getByTestId('audio-row-kick.wav');
    fireEvent.contextMenu(kickRow, { clientX: 200, clientY: 250 });

    expect(screen.getByRole('menu', { name: /options for kick\.wav/i })).toBeDefined();

    const openInNewTab = screen.getByRole('menuitem', { name: /open in new tab/i });
    fireEvent.click(openInNewTab);

    expect(onOpenFileTab).toHaveBeenCalledWith(mockFiles[0]);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('sorts files when clicking column headers', () => {
    render(
      <FolderBrowserView
        folderPath="/samples"
        files={mockFiles}
        onOpenFileTab={() => {}}
      />
    );

    const nameHeader = screen.getByText('Name');
    // Click sort Name asc -> hat, kick, loop
    fireEvent.click(nameHeader);
    const rows1 = screen.getAllByRole('row');
    expect(rows1[1].textContent).toContain('hat.wav');

    // Click sort Name desc -> loop, kick, hat
    fireEvent.click(nameHeader);
    const rows2 = screen.getAllByRole('row');
    expect(rows2[1].textContent).toContain('loop.wav');
  });
});
