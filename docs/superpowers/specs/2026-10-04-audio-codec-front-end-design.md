# Audio Codec Front-End Application Design Specification

**Date**: 2026-10-04  
**Status**: Approved for Implementation Plan  
**Target Repository**: `audio-codec-front-end`

---

## 1. System Overview & Objectives

The **Audio Codec Front-End** is a cross-platform desktop application designed for audio engineers, sample library curators, and embedded audio developers. It provides high-performance audio file browsing, real-time audio auditioning, multi-threaded batch waveform and tempo analysis, and an interactive waveform viewer adhering to the hardware-inspired design language of `SynthUI`.

### Core Capabilities
1. **Audio Directory Browsing**: Target and scan local folders containing diverse audio formats (`.wav`, `.aif`, `.aiff`, `.mp3`, `.flac`, `.ogg`, `.aac`, `.m4a`).
2. **Real-time Audio Playback**: Low-latency audio playback powered by `libsoundio` on dedicated audio threads.
3. **Batch Waveform & Tempo Analysis**:
   - Zero-allocation streaming decode via `audio-codecs`.
   - Simultaneous generation of multi-LOD waveform previews (`.apv`) and tempo/beat grids (`.att`).
   - Background multi-threaded worker pool with real-time UI progress reporting.
4. **Analysis Storage & MCU Compatibility**:
   - Stores analysis files in a `.analysis/` subfolder by default, with support for flat sidecar files for direct use on microcontroller SD cards (e.g., Teensy 4.1, i.MX RT1170).
   - Fast $O(1)$ cache validation via binary header checks (`source_file_size`, `crc32`).
5. **Interactive Waveform View**:
   - Top mini-overview strip showing full audio track with a draggable viewport window.
   - Zoomable and pannable main viewport with automatic Level-of-Detail (LOD) selection.
   - Interactive playhead seeking and playback synchronization (~60 FPS).
   - Beat and bar grid overlay lines extracted from `.att` analysis data.
   - Drag-to-select time region support (establishing foundations for future audio slicing).

---

## 2. Architecture & Technology Stack

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Electron Application                            │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │               Renderer Process (React + TypeScript)              │  │
│  │                                                                  │  │
│  │   ┌─────────────────────┐  ┌─────────────────────────────────┐   │  │
│  │   │  Folder Browser Tab │  │      Audio Waveform Tab(s)      │   │  │
│  │   │  - Virtual Table    │  │  - Mini Overview (Canvas LOD2)  │   │  │
│  │   │  - Batch Progress   │  │  - Detail Viewport (Canvas LOD) │   │  │
│  │   │  - 1-Click Audition │  │  - Beat Grid Overlay (.att)     │   │  │
│  │   │  - Context Menu     │  │  - Interactive Seek & Selection │   │  │
│  │   └─────────────────────┘  └─────────────────────────────────┘   │  │
│  │                              ▲                                   │  │
│  └──────────────────────────────┼───────────────────────────────────┘  │
│                                 │ Typed IPC (preload.ts)               │
│  ┌──────────────────────────────▼───────────────────────────────────┐  │
│  │                         Main Process                             │  │
│  │                   (Electron Node.js Runtime)                     │  │
│  │                                                                  │  │
│  │    Loads: audio_native.node (Node-API / C++ Native Addon)        │  │
│  └──────────────────────────────┬───────────────────────────────────┘  │
└─────────────────────────────────┼──────────────────────────────────────┘
                                  │ Direct C++ In-Process Calls
┌─────────────────────────────────▼──────────────────────────────────────┐
│                    C++ Native Engine (CMake Build)                     │
│                                                                        │
│   ┌───────────────────────────┐      ┌──────────────────────────────┐  │
│   │    AudioPlaybackEngine    │      │      AnalysisWorkerPool      │  │
│   │    - libsoundio output    │      │      - Multi-threaded pool   │  │
│   │    - Real-time thread     │      │      - Napi::ThreadSafeFunc  │  │
│   │    - Lock-free RingBuffer │      │      - Batch progress events │  │
│   └─────────────┬─────────────┘      └──────────────┬───────────────┘  │
│                 │                                   │                  │
│                 └─────────────────┬─────────────────┘                  │
│                                   │                                    │
│   ┌───────────────────────────────▼────────────────────────────────┐   │
│   │                         audio-codecs                           │   │
│   │   - Decoders: WAV, AIFF, MP3, FLAC, Vorbis, AAC                │   │
│   │   - PreviewGenerator (APV1 / .apv)                             │   │
│   │   - TempoGenerator   (ATT1 / .att)                             │   │
│   └────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

### Component Stack
- **Desktop Shell**: Electron (Latest LTS), `contextIsolation: true`, sandboxed renderer.
- **Native Addon**: C++17, compiled with CMake via `cmake-js` and `node-addon-api`.
- **Audio Codec Library**: `https://github.com/newdigate/audio-codecs` (local path resolution with CMake `FetchContent` fallback).
- **Audio Output Driver**: `libsoundio` (linking CoreAudio on macOS, WASAPI on Windows, ALSA/Pulse on Linux).
- **Frontend Framework**: React 18+, TypeScript, HTML5 Canvas 2D (`devicePixelRatio` scaling).
- **Styling**: `SynthUI`-inspired dark theme (`#181830`), IBM Plex typography, crisp vector accent colors.

---

## 3. C++ Native Engine Specification

### 3.1 Dependencies & CMake Build Configuration
The root `CMakeLists.txt` is configured to build `audio_native.node`.

```cmake
cmake_minimum_required(VERSION 3.16)
project(audio_front_end_native LANGUAGES CXX C)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# 1. Resolve audio-codecs
set(AUDIO_CODECS_LOCAL_PATH "/Users/moolet/Development/github/newdigate/audio-codecs" CACHE PATH "Path to local audio-codecs")
if(EXISTS "${AUDIO_CODECS_LOCAL_PATH}/CMakeLists.txt")
    message(STATUS "Using local audio-codecs: ${AUDIO_CODECS_LOCAL_PATH}")
    add_subdirectory("${AUDIO_CODECS_LOCAL_PATH}" audio_codecs_build EXCLUDE_FROM_ALL)
else()
    include(FetchContent)
    FetchContent_Declare(
        audio_codecs
        GIT_REPOSITORY https://github.com/newdigate/audio-codecs.git
        GIT_TAG main
        GIT_SHALLOW TRUE
    )
    FetchContent_MakeAvailable(audio_codecs)
endif()

# 2. Resolve libsoundio
find_package(PkgConfig QUIET)
pkg_check_modules(LIBSOUNDIO QUIET libsoundio)
if(NOT LIBSOUNDIO_FOUND)
    find_library(SOUNDIO_LIBRARY NAMES soundio)
    find_path(SOUNDIO_INCLUDE_DIR NAMES soundio/soundio.h)
    if(SOUNDIO_LIBRARY AND SOUNDIO_INCLUDE_DIR)
        set(LIBSOUNDIO_LIBRARIES ${SOUNDIO_LIBRARY})
        set(LIBSOUNDIO_INCLUDE_DIRS ${SOUNDIO_INCLUDE_DIR})
    else()
        message(FATAL_ERROR "libsoundio not found. Please install libsoundio-dev or soundio.")
    endif()
endif()

# 3. Node-API Target
include_directories(${CMAKE_JS_INC} ${LIBSOUNDIO_INCLUDE_DIRS})
file(GLOB_RECURSE SOURCE_FILES "src/native/*.cpp" "src/native/*.h")
add_library(${PROJECT_NAME} SHARED ${SOURCE_FILES} ${CMAKE_JS_SRC})
set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")
target_link_libraries(${PROJECT_NAME} PRIVATE
    ${LIBSOUNDIO_LIBRARIES}
    audio_codecs_wav
    audio_codecs_aiff
    audio_codecs_mp3
    audio_codecs_flac
    audio_codecs_vorbis
    audio_codecs_aac
    audio_codecs_preview
    audio_codecs_tempo
)
```

### 3.2 Audio Playback Engine (`AudioPlaybackEngine`)
- **Lifecycle**: Initializes `SoundIo` client and connects to the default audio output device.
- **Threading**:
  - `SoundIoOutStream` callback runs on a dedicated high-priority audio thread.
  - Feeds from a lock-free single-producer single-consumer (SPSC) circular float buffer.
  - Decoder thread decodes audio in small 8KB chunks ahead of the playhead.
- **Buffer Underrun Handling**: Fills missing frames with silence (zeros) without clicks or pops.
- **Controls**:
  - `play(filePath, startOffsetMs)`: Starts playback.
  - `pause()`: Suspends stream emission.
  - `stop()`: Halts playback and rewinds to beginning.
  - `seek(offsetMs)`: Flushes ring buffer, seeks audio decoder to nearest frame, and resumes stream.
  - `setVolume(float [0.0..1.0])`: Linear gain scaling.
- **Position Tracking**: Reports microsecond-level playback frame position via a thread-safe atomic counter for 60 FPS playhead synchronization.

### 3.3 Batch Analysis Worker Pool (`AnalysisWorkerPool`)
- **Worker Threads**: Spawns $N$ background threads ($\min(hardware\_concurrency - 1, 8)$).
- **Execution Flow**:
  1. Picks unanalyzed audio file from work queue.
  2. Opens audio file using format-specific decoder (`WavDecoder`, `AiffDecoder`, `Mp3Decoder`, `FlacDecoder`, `VorbisDecoder`, `AacDecoder`).
  3. Pipes decoded PCM blocks in a single pass into:
     - `audio_codecs::preview::PreviewGenerator` (generates multi-LOD waveform points).
     - `audio_codecs::tempo::TempoGenerator` (generates beat markers, tempo curve, global BPM).
  4. Writes output files:
     - Target `.apv` (APV1 format with 128-byte header and LOD tables).
     - Target `.att` (ATT1 format with 128-byte header and beat grid tables).
  5. Emits real-time progress callbacks to Node.js via `Napi::ThreadSafeFunction`.

### 3.4 Analysis File Reader (`AnalysisFileReader`)
- Direct binary deserializer exposing C++ parsed structs or zero-copy `Napi::ArrayBuffer` views of `.apv` and `.att` structures to JavaScript.
- Avoids JSON serialization overhead for waveform points.

---

## 4. File Storage & MCU Compatibility Formats

### 4.1 Binary Formats
1. **`.apv` (APV1 Waveform Preview)**:
   - Header (128 bytes): Magic `0x31565041`, sample rate, channels, total frames, duration ms, source file size, source CRC32, LOD descriptors.
   - LOD 0: 1:1 base chunks (128 PCM frames per chunk).
   - LOD 1: 16:1 downsampled chunks.
   - LOD 2: 256:1 downsampled chunks (overview).
   - Chunk Data: `WaveformPointMono` (int8 min, max) or `WaveformPointStereo` (left_min, left_max, right_min, right_max).
2. **`.att` (ATT1 Tempo & Beat Grid)**:
   - Header (128 bytes): Magic `ATT1`, global BPM in Q16, confidence, time signature numerator/denominator, first beat ms, first downbeat ms, total beats, total bars.
   - Beat Grid Table: `AttBeatMarker` array (`time_ms`, `bar_index`, `beat_within_bar`, `flags`, `local_bpm_q16`).
   - Tempo Curve Table: `AttTempoPoint` array (`time_ms`, `bpm_q16`).

### 4.2 Storage Resolution
- **Default Mode**: Stored in a `.analysis/` subdirectory within the audio folder.
  - Audio: `/Music/Samples/kick.wav`
  - Analysis: `/Music/Samples/.analysis/kick.wav.apv`, `/Music/Samples/.analysis/kick.wav.att`
- **MCU Flat Mode**: Stored as sibling sidecars in the same directory for direct SD card copy:
  - Audio: `/SDCARD/SAMPLES/KICK.WAV`
  - Analysis: `/SDCARD/SAMPLES/KICK.WAV.APV`, `/SDCARD/SAMPLES/KICK.WAV.ATT`
- **Lookup Resolution**:
  When inspecting an audio file `sample.wav`:
  1. Check `.analysis/sample.wav.apv` (and `.att`).
  2. If not found, check `sample.wav.apv` (and `sample.apv`).
  3. If found, validate header `source_file_size == actual_file_size`.
  4. If validation succeeds $\rightarrow$ status = `CACHED`. Otherwise $\rightarrow$ status = `UNANALYZED`.

---

## 5. Electron IPC & Preload Interface

### 5.1 Preload API (`window.audioApi`)
```typescript
export interface AudioFileInfo {
  filePath: string;
  fileName: string;
  fileSizeBytes: number;
  durationMs: number;
  sampleRate: number;
  channels: number;
  codec: string;
  status: 'cached' | 'unanalyzed' | 'analyzing' | 'error';
  bpm?: number;
  progressPct?: number;
  errorMessage?: string;
}

export interface LodData {
  downsampleRatio: number;
  chunkCount: number;
  peaks: Int8Array; // [min, max] or [l_min, l_max, r_min, r_max]
}

export interface BeatMarker {
  timeMs: number;
  barIndex: number;
  beatWithinBar: number;
  isDownbeat: boolean;
  localBpm: number;
}

export interface FileAnalysisData {
  filePath: string;
  fileName: string;
  durationMs: number;
  sampleRate: number;
  channels: number;
  bpm: number;
  confidence: number;
  timeSignature: [number, number];
  lods: LodData[];
  beatMarkers: BeatMarker[];
}

export interface AudioApi {
  // Folder & File Management
  selectFolder: () => Promise<{ folderPath: string; files: AudioFileInfo[] } | null>;
  scanFolder: (folderPath: string) => Promise<AudioFileInfo[]>;
  loadFileAnalysis: (filePath: string) => Promise<FileAnalysisData>;

  // Batch Analysis Controls
  startBatchAnalysis: (folderPath: string, sidecarMode: boolean) => Promise<void>;
  controlBatchAnalysis: (action: 'pause' | 'resume' | 'cancel') => Promise<void>;
  onBatchProgress: (callback: (update: { filePath: string; progressPct: number; bpm?: number; status: string }) => void) => () => void;

  // Real-time Playback
  playbackPlay: (filePath: string, startMs: number) => Promise<boolean>;
  playbackPause: () => Promise<boolean>;
  playbackStop: () => Promise<boolean>;
  playbackSeek: (timeMs: number) => Promise<boolean>;
  playbackSetVolume: (volume: number) => Promise<void>;
  onPlaybackTick: (callback: (state: { isPlaying: boolean; currentMs: number }) => void) => () => void;

  // OS Integration
  revealInFinder: (filePath: string) => Promise<void>;
}
```

---

## 6. Frontend UI Specification (`SynthUI` Aesthetic)

### 6.1 Visual Design Tokens
- **Background Ground**: `#181830` (SynthUI dark slate faceplate)
- **Panel Surface**: `#20203c` with `#2d2d52` border outlines
- **Waveform Fill**: `#2272` (Polynesian Blue solid columns)
- **Waveform Highlights**: `#4A7F` (Neon Blue peaks)
- **Playhead Cursor**: `#4A7F` / `#7878c0`
- **Zero-Crossing & Grid Guides**: `#018C` (Berkeley Blue) and `#012C` (Royal Blue Dark)
- **Beat & Downbeat Markers**: `#e69138` (Amber downbeats), `#6078c0` (Bar lines)
- **Font Stack**: `'IBM Plex Mono', 'SF Mono', monospace`

### 6.2 View Layouts & Tabs
1. **Application Header**:
   - `Open Folder...` button
   - Folder Path indicator with file count
   - Batch progress indicator (`Analyzed 38 / 120 files`) + Pause/Resume toggle
   - Flat Sidecar / `.analysis/` mode switch
2. **Tab Controller**:
   - `📁 [Folder Name]` (Pinned tab: file list)
   - Dynamic audio tabs `🎵 [filename.ext] ×` (closable)
3. **Folder Browser View**:
   - Virtualized table rendering 1000s of files smoothly.
   - Column headers: Play, File Name, Format, Channels, Duration, BPM, Status, Actions.
   - Quick Play audition button starts instant `libsoundio` stream.
   - Action button / double-click opens audio file in a new Waveform Tab.
   - Context Menu: `Open in Tab`, `Re-analyze File`, `Reveal in Explorer/Finder`.
4. **Waveform Tab (`WaveView`)**:
   - **Mini Overview Canvas (Top ~48px)**:
     - Always displays full track using LOD 2.
     - Viewport overlay box highlighting the visible range of the detail canvas.
     - Click or drag inside the overview box immediately repositions the detail view.
   - **Detail Viewport Canvas (Main)**:
     - Automatically switches between LOD 0 (high zoom) and LOD 1 (medium zoom).
     - Smooth horizontal scrolling (pan) and zooming (mouse wheel / trackpad pinch).
     - **Time & Beat Ruler**: Displays milliseconds/seconds and musical bar:beat positions.
     - **Interactive Seeking**: Click to reposition playhead; synchronizes with `libsoundio`.
     - **Region Drag Selection**: Click & drag creates a loop/selection range (future-ready for audio slicing).

---

## 7. Error Handling & Edge Cases

| Failure Mode | Detection | Mitigation |
|---|---|---|
| **Corrupt / Malformed Audio File** | `audio-codecs` returns negative decode error code | Worker marks file as `Error: Corrupt audio`, logs warning, and continues batch queue without crashing |
| **Write-Protected Audio Directory** | C++ cannot create `.analysis/` folder | Emits non-blocking notification; stores analysis in memory for current session |
| **Audio Device Disconnected / Unplugged** | `SoundIo::on_devices_change` fires in C++ | Audio playback engine gracefully suspends, re-detects default device, and can resume |
| **Missing libsoundio on Linux/Windows** | CMake build check | Clear build/runtime diagnostics with dynamic loading fallback |
| **Stale Cache (.apv mismatch)** | `source_file_size` or CRC mismatch in `ApvHeader` | Automatically marks file unanalyzed and re-queues for processing |
| **Huge Directories (10,000+ files)** | Large array in React | `@tanstack/react-virtual` ensures only visible rows exist in DOM |

---

## 8. Verification & Testing Plan

### 8.1 Automated C++ Unit Tests (`ctest`)
- `test_apv_io`: Verify writing and reading `ApvHeader` and multi-tier LOD chunks.
- `test_att_io`: Verify writing and reading `AttHeader` and beat grid markers.
- `test_ring_buffer`: Verify lock-free SPSC buffer concurrency under high read/write load.
- `test_batch_queue`: Verify thread pool job scheduling, pause/resume, and cancellation.

### 8.2 Frontend Math & Component Tests (`vitest`)
- Coordinate conversions: Sample $\leftrightarrow$ Pixel $\leftrightarrow$ Milliseconds under various zoom levels.
- LOD selection: Ensure optimal LOD tier is selected for given samples-per-pixel ratio.
- Beat grid math: Validate beat placement against audio duration.

### 8.3 Manual End-to-End Verification
- Scan a mixed directory of WAV, MP3, FLAC, and AIFF files.
- Verify `.analysis/` directory creation and generated `.apv` and `.att` files.
- Verify playback through `libsoundio` with accurate playhead tracking in the waveform view.
- Verify zoom, pan, and seek responsiveness at 60 FPS.
