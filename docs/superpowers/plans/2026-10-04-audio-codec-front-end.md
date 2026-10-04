# Audio Codec Front-End Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a cross-platform desktop application using C++ (`audio-codecs`, `libsoundio`) and Electron with React/Canvas to browse audio folders, stream audio playback, execute multi-threaded batch waveform (`.apv`) and tempo (`.att`) analysis with MCU-compatible caching, and provide an interactive `SynthUI`-styled waveform/tempo viewer in tabbed views.

**Architecture:** Electron application with `contextIsolation: true` loading a C++ Node-API native addon (`audio_native.node`) in the Main process. The C++ addon runs real-time audio output via `libsoundio` and manages a background worker thread pool for batch analysis with zero-allocation streaming decode via `audio-codecs`. Analysis files are cached in `.analysis/` (or MCU flat sidecar mode). The React renderer communicates through a typed IPC bridge (`preload.ts`) and renders virtualized folder manifests and a high-performance 2D Canvas waveform with overview, zoomable detail view, and beat grid overlays.

**Tech Stack:** C++17, CMake, `node-addon-api`, `cmake-js`, `libsoundio`, `audio-codecs`, Node.js 20+, Electron, React 18, TypeScript, HTML5 Canvas 2D, `@tanstack/react-virtual`, Vitest.

**Spec:** [`docs/superpowers/specs/2026-10-04-audio-codec-front-end-design.md`](file:///Users/moolet/Development/audio-codec-front-end/docs/superpowers/specs/2026-10-04-audio-codec-front-end-design.md)

## Global Constraints
- Target Repository: `/Users/moolet/Development/audio-codec-front-end`
- Audio Codecs Reference: `https://github.com/newdigate/audio-codecs` (local path `/Users/moolet/Development/github/newdigate/audio-codecs` via CMake with FetchContent fallback)
- Audio Output: `libsoundio` via C++ real-time callback thread
- Waveform Preview Binary Format: `.apv` (APV1 format with 128-byte header and multi-LOD tiers)
- Tempo Analysis Binary Format: `.att` (ATT1 format with 128-byte header, BPM in Q16, and beat grid markers)
- Design Language: `SynthUI` faceplate dark theme (`#181830`), IBM Plex typography, solid vertical wave bars (`#2272`) and neon highlights (`#4A7F`)
- Audio Slicing: Out of scope for this plan; selection range provides UI grounding

---

### Task 1: Project Scaffolding & CMake Build Configuration

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `vite.config.ts`
- Create: `CMakeLists.txt`
- Create: `src/native/addon.cpp`
- Test: `tests/native/smoke_test.js`

**Interfaces:**
- Consumes: None (root configuration)
- Produces: `audio_native.node` loadable module, `npm run build:native`, and `npm test` scripts

- [ ] **Step 1: Create `package.json` with build scripts and dependencies**

```json
{
  "name": "audio-codec-front-end",
  "version": "0.1.0",
  "description": "Cross-platform audio browser, batch analyzer and waveform viewer",
  "main": "dist-electron/main.js",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build && electron-builder --dir",
    "build:native": "cmake-js compile",
    "build:native:debug": "cmake-js compile --debug",
    "test:native": "node tests/native/smoke_test.js",
    "test": "vitest run"
  },
  "dependencies": {
    "bindings": "^1.5.0",
    "node-addon-api": "^8.2.0"
  },
  "devDependencies": {
    "@tanstack/react-virtual": "^3.10.8",
    "@types/node": "^20.17.0",
    "@types/react": "^18.3.11",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.2",
    "cmake-js": "^7.3.0",
    "electron": "^32.1.2",
    "electron-builder": "^25.1.8",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "typescript": "^5.6.3",
    "vite": "^5.4.8",
    "vite-plugin-electron": "^0.28.8",
    "vite-plugin-electron-renderer": "^0.14.5",
    "vitest": "^2.1.2"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json` and `tsconfig.node.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src/renderer", "src/shared"]
}
```

- [ ] **Step 3: Create root `CMakeLists.txt` for `cmake-js` native build**

```cmake
cmake_minimum_required(VERSION 3.16)
project(audio_native LANGUAGES CXX C)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# 1. audio-codecs dependency
set(AUDIO_CODECS_LOCAL_PATH "/Users/moolet/Development/github/newdigate/audio-codecs" CACHE PATH "Path to local audio-codecs")
if(EXISTS "${AUDIO_CODECS_LOCAL_PATH}/CMakeLists.txt")
    message(STATUS "Using local audio-codecs from: ${AUDIO_CODECS_LOCAL_PATH}")
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

# 2. libsoundio dependency
find_library(SOUNDIO_LIBRARY NAMES soundio PATHS /usr/local/lib /opt/homebrew/lib)
find_path(SOUNDIO_INCLUDE_DIR NAMES soundio/soundio.h PATHS /usr/local/include /opt/homebrew/include)
if(NOT SOUNDIO_LIBRARY OR NOT SOUNDIO_INCLUDE_DIR)
    message(FATAL_ERROR "libsoundio not found. Please install libsoundio (e.g. brew install libsoundio)")
endif()
message(STATUS "Found libsoundio: ${SOUNDIO_LIBRARY} (headers: ${SOUNDIO_INCLUDE_DIR})")

# 3. Node-API Target
include_directories(
    ${CMAKE_JS_INC}
    ${SOUNDIO_INCLUDE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/src/native
    ${CMAKE_CURRENT_SOURCE_DIR}/node_modules/node-addon-api
)

file(GLOB_RECURSE SOURCE_FILES "src/native/*.cpp")

add_library(${PROJECT_NAME} SHARED ${SOURCE_FILES} ${CMAKE_JS_SRC})
set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")

target_link_libraries(${PROJECT_NAME} PRIVATE
    ${SOUNDIO_LIBRARY}
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

- [ ] **Step 4: Create minimal `src/native/addon.cpp` and smoke test**

```cpp
#include <napi.h>

Napi::String GetVersion(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    return Napi::String::New(env, "0.1.0");
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("getVersion", Napi::Function::New(env, GetVersion));
    return exports;
}

NODE_API_MODULE(audio_native, Init)
```

Create `tests/native/smoke_test.js`:
```javascript
const path = require('path');
const native = require(path.join(__dirname, '../../build/Release/audio_native.node'));
console.log('audio_native addon loaded. Version:', native.getVersion());
if (native.getVersion() !== '0.1.0') {
    throw new Error('Version mismatch');
}
```

- [ ] **Step 5: Run npm install, build native addon, and verify test passes**

Run:
```bash
npm install
npm run build:native
npm run test:native
```
Expected: `audio_native addon loaded. Version: 0.1.0`

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json tsconfig.node.json CMakeLists.txt src/native tests/native
git commit -m "feat: scaffold project with cmake-js and node-addon-api"
```

---

### Task 2: Analysis File Format & Cache Validation Engine (C++)

**Files:**
- Create: `src/native/analysis_cache.h`
- Create: `src/native/analysis_cache.cpp`
- Create: `tests/native/test_analysis_cache.cpp`

**Interfaces:**
- Consumes: `audio_codecs::preview::ApvHeader`, `audio_codecs::tempo::AttHeader`
- Produces: `AnalysisCache` class for checking, reading, writing `.apv` and `.att` files with path resolution (`.analysis/` vs sidecar)

- [ ] **Step 1: Write unit test `tests/native/test_analysis_cache.cpp`**

```cpp
#include <cassert>
#include <iostream>
#include <filesystem>
#include "analysis_cache.h"

namespace fs = std::filesystem;

int main() {
    fs::path tempDir = fs::temp_directory_path() / "test_audio_cache";
    fs::create_directories(tempDir);
    fs::path sampleAudio = tempDir / "test.wav";
    {
        std::ofstream f(sampleAudio, std::ios::binary);
        f.write("RIFFtestdata", 12);
    }

    audio_front_end::AnalysisCache cache;
    
    // 1. Initial check - should be unanalyzed
    assert(!cache.HasValidCache(sampleAudio.string(), false));

    // 2. Generate dummy apv and att
    audio_codecs::preview::ApvHeader apv{};
    apv.source_file_size = 12;
    apv.duration_ms = 1000;
    apv.sample_rate = 44100;
    apv.channels = 2;

    audio_codecs::tempo::AttHeader att{};
    att.duration_ms = 1000;
    att.global_bpm_q16 = 120 << 16;

    assert(cache.WriteCache(sampleAudio.string(), apv, {}, att, {}, false));

    // 3. Cache should now be valid
    assert(cache.HasValidCache(sampleAudio.string(), false));

    // 4. Test reading cache
    audio_front_end::CachedAnalysisData data;
    assert(cache.ReadCache(sampleAudio.string(), data, false));
    assert(data.durationMs == 1000);
    assert(data.sampleRate == 44100);
    assert(data.bpm == 120.0);

    fs::remove_all(tempDir);
    std::cout << "test_analysis_cache PASSED" << std::endl;
    return 0;
}
```

- [ ] **Step 2: Implement `src/native/analysis_cache.h` and `src/native/analysis_cache.cpp`**

`src/native/analysis_cache.h`:
```cpp
#pragma once
#include <string>
#include <vector>
#include <filesystem>
#include <audio_codecs/preview/preview_types.h>
#include <audio_codecs/tempo/tempo_types.h>

namespace audio_front_end {

struct CachedLod {
    uint32_t downsampleRatio;
    uint32_t chunkCount;
    std::vector<int8_t> peaks;
};

struct CachedBeat {
    uint32_t timeMs;
    uint32_t barIndex;
    uint16_t beatWithinBar;
    bool isDownbeat;
    double localBpm;
};

struct CachedAnalysisData {
    uint32_t durationMs{0};
    uint32_t sampleRate{0};
    uint8_t channels{0};
    double bpm{0.0};
    uint8_t confidence{0};
    std::pair<uint8_t, uint8_t> timeSignature{4, 4};
    std::vector<CachedLod> lods;
    std::vector<CachedBeat> beats;
};

class AnalysisCache {
public:
    static std::filesystem::path GetApvPath(const std::string& audioPath, bool flatSidecar);
    static std::filesystem::path GetAttPath(const std::string& audioPath, bool flatSidecar);
    
    bool HasValidCache(const std::string& audioPath, bool flatSidecar);
    bool ReadCache(const std::string& audioPath, CachedAnalysisData& outData, bool flatSidecar);
    bool WriteCache(const std::string& audioPath, 
                    const audio_codecs::preview::ApvHeader& apvHeader,
                    const std::vector<std::vector<int8_t>>& lodData,
                    const audio_codecs::tempo::AttHeader& attHeader,
                    const std::vector<audio_codecs::tempo::AttBeatMarker>& beatMarkers,
                    bool flatSidecar);
};

} // namespace audio_front_end
```

- [ ] **Step 3: Compile and run test**

Compile standalone test with CMake/clang++ and run:
Run: `./build/tests/test_analysis_cache`
Expected: `test_analysis_cache PASSED`

- [ ] **Step 4: Commit**

```bash
git add src/native/analysis_cache.h src/native/analysis_cache.cpp tests/native/test_analysis_cache.cpp
git commit -m "feat: add analysis cache binary reader, writer and header validator"
```

---

### Task 3: Multi-threaded Batch Analysis Worker Pool (C++)

**Files:**
- Create: `src/native/batch_worker_pool.h`
- Create: `src/native/batch_worker_pool.cpp`
- Modify: `src/native/addon.cpp`
- Test: `tests/native/test_batch_worker.js`

**Interfaces:**
- Consumes: `audio_codecs` decoders, `PreviewGenerator`, `TempoGenerator`, `AnalysisCache`
- Produces: Addon bindings `scanFolder`, `startBatchAnalysis`, `controlBatchAnalysis`

- [ ] **Step 1: Write Node.js test `tests/native/test_batch_worker.js`**

```javascript
const path = require('path');
const native = require(path.join(__dirname, '../../build/Release/audio_native.node'));

console.log('Testing batch worker pool...');
assert = require('assert');

// Test scanFolder
const files = native.scanFolder(path.join(__dirname, '../fixtures'));
console.log('Scanned files:', files.length);

native.startBatchAnalysis(path.join(__dirname, '../fixtures'), false, (progress) => {
    console.log('Batch progress update:', progress);
});
```

- [ ] **Step 2: Implement `src/native/batch_worker_pool.h` and `cpp`**

```cpp
#pragma once
#include <vector>
#include <string>
#include <thread>
#include <queue>
#include <mutex>
#include <condition_variable>
#include <atomic>
#include <napi.h>
#include "analysis_cache.h"

namespace audio_front_end {

struct BatchJob {
    std::string filePath;
    bool flatSidecar;
};

class BatchWorkerPool {
public:
    BatchWorkerPool();
    ~BatchWorkerPool();

    void StartBatch(const std::vector<std::string>& files, bool flatSidecar, Napi::ThreadSafeFunction tsfn);
    void Pause();
    void Resume();
    void Cancel();

private:
    void WorkerLoop();
    void ProcessFile(const std::string& filePath, bool flatSidecar);

    std::vector<std::thread> workers_;
    std::queue<BatchJob> queue_;
    std::mutex queueMutex_;
    std::condition_variable cv_;
    std::atomic<bool> stop_{false};
    std::atomic<bool> paused_{false};
    Napi::ThreadSafeFunction progressCallback_;
    AnalysisCache cache_;
};

} // namespace audio_front_end
```

Pipes decoded PCM into `PreviewGenerator` and `TempoGenerator`, writes `.apv` and `.att` using `AnalysisCache::WriteCache`, and calls `progressCallback_.BlockingCall(...)`.

- [ ] **Step 3: Expose methods in `src/native/addon.cpp`**

Expose:
- `scanFolder(folderPath)` $\rightarrow$ Array of `{ filePath, fileName, sizeBytes, status, durationMs, bpm }`.
- `startBatchAnalysis(folderPath, flatSidecar, callback)`.
- `controlBatchAnalysis(action: "pause"|"resume"|"cancel")`.
- `loadFileAnalysis(filePath, flatSidecar)` $\rightarrow$ returns parsed analysis object with ArrayBuffers.

- [ ] **Step 4: Build and test**

Run:
```bash
npm run build:native
node tests/native/test_batch_worker.js
```
Expected: `Batch progress update: { filePath: '...', progressPct: 100, bpm: 120, status: 'cached' }`

- [ ] **Step 5: Commit**

```bash
git add src/native/batch_worker_pool.* src/native/addon.cpp tests/native/test_batch_worker.js
git commit -m "feat: add multi-threaded batch analysis worker pool"
```

---

### Task 4: Real-time Audio Playback Engine with `libsoundio` (C++)

**Files:**
- Create: `src/native/ring_buffer.h`
- Create: `src/native/playback_engine.h`
- Create: `src/native/playback_engine.cpp`
- Modify: `src/native/addon.cpp`
- Test: `tests/native/test_playback.js`

**Interfaces:**
- Consumes: `libsoundio`, `audio-codecs` decoders
- Produces: Addon bindings `playbackPlay`, `playbackPause`, `playbackStop`, `playbackSeek`, `playbackGetPosition`, `playbackSetVolume`

- [ ] **Step 1: Implement lock-free single-producer single-consumer `ring_buffer.h`**

```cpp
#pragma once
#include <vector>
#include <atomic>
#include <cstddef>

namespace audio_front_end {

template <typename T>
class SpscRingBuffer {
public:
    explicit SpscRingBuffer(size_t capacity)
        : capacity_(capacity), buffer_(capacity), head_(0), tail_(0) {}

    size_t write(const T* data, size_t count) {
        size_t written = 0;
        size_t head = head_.load(std::memory_order_relaxed);
        size_t tail = tail_.load(std::memory_order_acquire);
        size_t available = (tail > head) ? (tail - head - 1) : (capacity_ - head + tail - 1);
        size_t toWrite = std::min(count, available);

        for (size_t i = 0; i < toWrite; ++i) {
            buffer_[head] = data[i];
            head = (head + 1) % capacity_;
        }
        head_.store(head, std::memory_order_release);
        return toWrite;
    }

    size_t read(T* outData, size_t count) {
        size_t head = head_.load(std::memory_order_acquire);
        size_t tail = tail_.load(std::memory_order_relaxed);
        size_t available = (head >= tail) ? (head - tail) : (capacity_ - tail + head);
        size_t toRead = std::min(count, available);

        for (size_t i = 0; i < toRead; ++i) {
            outData[i] = buffer_[tail];
            tail = (tail + 1) % capacity_;
        }
        tail_.store(tail, std::memory_order_release);
        return toRead;
    }

    void clear() {
        head_.store(0, std::memory_order_relaxed);
        tail_.store(0, std::memory_order_relaxed);
    }

private:
    size_t capacity_;
    std::vector<T> buffer_;
    std::atomic<size_t> head_;
    std::atomic<size_t> tail_;
};

} // namespace audio_front_end
```

- [ ] **Step 2: Implement `src/native/playback_engine.h` and `playback_engine.cpp`**

Sets up `SoundIo*`, `SoundIoDevice*`, and `SoundIoOutStream*`. Stream write callback pulls from `SpscRingBuffer<float>`. Background decoding thread opens audio file using `audio_codecs` and feeds ring buffer ahead of playhead. Atomic `currentFrame_` keeps track of accurate position in samples.

- [ ] **Step 3: Expose playback functions in `src/native/addon.cpp`**

- `playbackPlay(filePath, startOffsetMs)`
- `playbackPause()`
- `playbackStop()`
- `playbackSeek(offsetMs)`
- `playbackGetPosition()` $\rightarrow$ `{ isPlaying: boolean, currentMs: number }`
- `playbackSetVolume(volume: 0.0 - 1.0)`

- [ ] **Step 4: Build and test playback**

Run:
```bash
npm run build:native
node tests/native/test_playback.js
```
Expected: Sound streams via libsoundio without underrun or crash; returns expected positions.

- [ ] **Step 5: Commit**

```bash
git add src/native/ring_buffer.h src/native/playback_engine.* src/native/addon.cpp tests/native/test_playback.js
git commit -m "feat: add real-time audio playback engine with libsoundio and lock-free ring buffer"
```

---

### Task 5: Electron Main Process, Preload Script & IPC Bridge

**Files:**
- Create: `src/shared/audio_types.ts`
- Create: `src/main/main.ts`
- Create: `src/preload/preload.ts`
- Modify: `vite.config.ts`

**Interfaces:**
- Consumes: `audio_native.node`
- Produces: `window.audioApi` bridge typed via `src/shared/audio_types.ts`

- [ ] **Step 1: Define `src/shared/audio_types.ts`**

Export interfaces for `AudioFileInfo`, `FileAnalysisData`, `LodData`, `BeatMarker`, `BatchProgressUpdate`, and `PlaybackState`.

- [ ] **Step 2: Implement `src/preload/preload.ts`**

Use `contextBridge.exposeInMainWorld('audioApi', ...)` with `ipcRenderer.invoke` and `ipcRenderer.on`.

- [ ] **Step 3: Implement `src/main/main.ts`**

Setup `BrowserWindow`, register IPC handlers (`audio:select-folder`, `audio:scan-folder`, `audio:start-batch`, `audio:control-batch`, `audio:load-analysis`, `audio:playback-*`, `audio:reveal-in-finder`). Setup 60Hz ticker for `onPlaybackTick`.

- [ ] **Step 4: Configure `vite.config.ts` with `vite-plugin-electron`**

Ensure `vite.config.ts` builds `main.ts`, `preload.ts`, and React renderer.

- [ ] **Step 5: Verify Electron boots with bridge attached**

Run: `npm run dev` (or headless Electron launch test).
Expected: Electron window initializes without security warnings; `window.audioApi` is accessible.

- [ ] **Step 6: Commit**

```bash
git add src/shared/audio_types.ts src/main/main.ts src/preload/preload.ts vite.config.ts
git commit -m "feat: setup electron main process, preload script, and typed ipc bridge"
```

---

### Task 6: SynthUI Theme, Design Tokens & Core React Layout

**Files:**
- Create: `src/renderer/index.html`
- Create: `src/renderer/styles/theme.css`
- Create: `src/renderer/components/HeaderBar.tsx`
- Create: `src/renderer/components/TabBar.tsx`
- Create: `src/renderer/App.tsx`
- Create: `src/renderer/main.tsx`
- Test: `tests/renderer/theme_test.test.tsx`

**Interfaces:**
- Consumes: `window.audioApi`
- Produces: Application shell with folder picker, batch progress bar, and tab switching

- [ ] **Step 1: Write Vitest test for Tab switching `tests/renderer/theme_test.test.tsx`**

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { TabBar } from '../../src/renderer/components/TabBar';
import { describe, it, expect } from 'vitest';

describe('TabBar Component', () => {
  it('renders pinned folder tab and active tabs', () => {
    const tabs = [
      { id: 'folder', title: '📁 My Samples', isPinned: true },
      { id: 'file-1', title: '🎵 kick.wav', isPinned: false },
    ];
    let active = 'folder';
    render(<TabBar tabs={tabs} activeTabId={active} onSelectTab={(id) => active = id} onCloseTab={() => {}} />);
    expect(screen.getByText('📁 My Samples')).toBeDefined();
    expect(screen.getByText('🎵 kick.wav')).toBeDefined();
  });
});
```

- [ ] **Step 2: Create `src/renderer/styles/theme.css`**

Define CSS variables for SynthUI faceplate palette:
```css
:root {
  --bg-ground: #181830;
  --bg-surface: #20203c;
  --border-surface: #2d2d52;
  --text-main: #e0dfd5;
  --text-dim: #7878c0;
  --accent-wave: #2272;
  --accent-neon: #4A7F;
  --accent-amber: #e69138;
  --grid-line: #012C;
  --font-mono: 'IBM Plex Mono', monospace, sans-serif;
}
body {
  margin: 0;
  background-color: var(--bg-ground);
  color: var(--text-main);
  font-family: var(--font-mono);
  user-select: none;
  overflow: hidden;
}
```

- [ ] **Step 3: Implement `HeaderBar.tsx`, `TabBar.tsx`, and `App.tsx`**

- `HeaderBar`: "Open Folder" button, current path, progress bar showing batch status with Pause/Resume, sidecar mode toggle.
- `TabBar`: Pinned folder tab + closable audio file tabs.
- `App.tsx`: Manages active tab state, active folder path, loaded files list.

- [ ] **Step 4: Run Vitest**

Run: `npm test`
Expected: `theme_test.test.tsx PASS`

- [ ] **Step 5: Commit**

```bash
git add src/renderer/ tests/renderer/
git commit -m "feat: implement SynthUI dark theme, header bar, and tab navigation"
```

---

### Task 7: Folder Browser View with Virtualized File List & Auditioning

**Files:**
- Create: `src/renderer/components/FolderBrowserView.tsx`
- Create: `src/renderer/components/AudioTableRow.tsx`
- Create: `src/renderer/components/ContextMenu.tsx`
- Test: `tests/renderer/folder_browser.test.tsx`

**Interfaces:**
- Consumes: `AudioFileInfo`, `window.audioApi`
- Produces: Virtualized table view with audition playback, status badges, and tab opening

- [ ] **Step 1: Write test `tests/renderer/folder_browser.test.tsx`**

```tsx
import { render, screen } from '@testing-library/react';
import { AudioTableRow } from '../../src/renderer/components/AudioTableRow';
import { describe, it, expect, vi } from 'vitest';

describe('AudioTableRow', () => {
  it('displays audio metadata, bpm, and action buttons', () => {
    const file = {
      filePath: '/samples/snare.wav',
      fileName: 'snare.wav',
      fileSizeBytes: 10240,
      durationMs: 500,
      sampleRate: 44100,
      channels: 2,
      codec: 'WAV',
      status: 'cached' as const,
      bpm: 124.5
    };
    render(<AudioTableRow file={file} isPlaying={false} onPlay={() => {}} onOpenTab={() => {}} />);
    expect(screen.getByText('snare.wav')).toBeDefined();
    expect(screen.getByText('124.5 BPM')).toBeDefined();
  });
});
```

- [ ] **Step 2: Implement `FolderBrowserView.tsx` using `@tanstack/react-virtual`**

Features:
- Handles lists with 10,000+ files via virtual windowing.
- 1-click Play/Stop audition icon calling `window.audioApi.playbackPlay` / `playbackStop`.
- "Open in Tab" button + double-click trigger.
- Right click context menu (`Open in New Tab`, `Re-analyze File`, `Reveal in Finder`).
- Live updates when `onBatchProgress` events arrive.

- [ ] **Step 3: Run Vitest**

Run: `npm test`
Expected: `folder_browser.test.tsx PASS`

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/FolderBrowserView.tsx src/renderer/components/AudioTableRow.tsx src/renderer/components/ContextMenu.tsx tests/renderer/folder_browser.test.tsx
git commit -m "feat: implement virtualized folder browser with auditioning and context actions"
```

---

### Task 8: SynthUI Waveform & Tempo View (`WaveView`)

**Files:**
- Create: `src/renderer/components/WaveView.tsx`
- Create: `src/renderer/utils/wave_math.ts`
- Create: `src/renderer/components/MiniOverviewCanvas.tsx`
- Create: `src/renderer/components/DetailViewportCanvas.tsx`
- Test: `tests/renderer/wave_math.test.ts`

**Interfaces:**
- Consumes: `FileAnalysisData`, `PlaybackState`, `window.audioApi`
- Produces: Dual-canvas interactive waveform component

- [ ] **Step 1: Write test for coordinate math `tests/renderer/wave_math.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { timeToPixel, pixelToTime, selectBestLod } from '../../src/renderer/utils/wave_math';

describe('Waveform Coordinate Math', () => {
  it('converts time to pixel and back accurately', () => {
    const totalDurationMs = 10000;
    const canvasWidth = 1000;
    const viewStartMs = 2000;
    const viewEndMs = 6000;

    const px = timeToPixel(4000, viewStartMs, viewEndMs, canvasWidth);
    expect(px).toBe(500);

    const time = pixelToTime(500, viewStartMs, viewEndMs, canvasWidth);
    expect(time).toBe(4000);
  });

  it('selects LOD 0 for high zoom, LOD 1 for medium zoom, LOD 2 for overview', () => {
    expect(selectBestLod(100)).toBe(0); // 100 samples per pixel -> LOD 0
    expect(selectBestLod(2000)).toBe(1); // 2000 samples per pixel -> LOD 1
    expect(selectBestLod(30000)).toBe(2); // 30000 samples per pixel -> LOD 2
  });
});
```

- [ ] **Step 2: Implement `src/renderer/utils/wave_math.ts`**

Functions:
- `timeToPixel(timeMs, viewStartMs, viewEndMs, width)`
- `pixelToTime(px, viewStartMs, viewEndMs, width)`
- `selectBestLod(samplesPerPixel)`
- `formatTimecode(timeMs)`

- [ ] **Step 3: Implement `MiniOverviewCanvas.tsx` and `DetailViewportCanvas.tsx`**

- **`MiniOverviewCanvas`**:
  - Draws full track from LOD 2.
  - Draws interactive rectangle of visible zoom bounds.
  - Clicking/dragging viewport bounds updates main viewport range.
- **`DetailViewportCanvas`**:
  - Selects LOD 0 / LOD 1 based on samples/px.
  - Draws zero-crossing guide line `#018C` and quartile guides `#012C`.
  - Draws vertical peak bars (`#2272` solid, `#4A7F` peak points).
  - Draws musical beat grid lines and downbeat markers (`#e69138`).
  - Draws neon playhead cursor (`#4A7F`) synced to `libsoundio` position.
  - Mouse wheel zoom (centered on mouse pointer) and drag-pan.
  - Click-to-seek directly calling `window.audioApi.playbackSeek`.
  - Shift-drag to create selection range.

- [ ] **Step 4: Run Vitest**

Run: `npm test`
Expected: `wave_math.test.ts PASS`

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/WaveView.tsx src/renderer/components/MiniOverviewCanvas.tsx src/renderer/components/DetailViewportCanvas.tsx src/renderer/utils/wave_math.ts tests/renderer/wave_math.test.ts
git commit -m "feat: implement dual-canvas SynthUI waveform and tempo view with zoom, pan and seek"
```

---

### Task 9: End-to-End Integration, Audio Verification & Packaging

**Files:**
- Create: `tests/fixtures/sample_drum_loop.wav`
- Modify: `src/renderer/App.tsx`
- Modify: `package.json`

**Interfaces:**
- Consumes: All native and renderer components
- Produces: Complete working desktop application and release build

- [ ] **Step 1: End-to-end workflow verification test**

Create an end-to-end integration test or manual script:
1. Launch Electron with `npm run dev`.
2. Open test audio directory.
3. Verify files appear in the virtualized folder table.
4. Verify batch analysis runs in the background and writes `.analysis/` files.
5. Click audition button on a track; verify audio plays through speakers via `libsoundio`.
6. Open audio file in tab; verify overview canvas, detail canvas, zoom, pan, and seek.
7. Click on the waveform; verify playhead seeks and `libsoundio` audio seeks synchronously.

- [ ] **Step 2: Test building production package**

Run:
```bash
npm run build:native
npm run build
```
Verify the production bundle compiles and generates the desktop application executable.

- [ ] **Step 3: Commit**

```bash
git add .
git commit -m "feat: complete end-to-end integration and release build packaging"
```
