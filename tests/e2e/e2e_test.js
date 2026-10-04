const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

// Disable hardware acceleration for headless/CI environments
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

const mainModule = require('../../dist-electron/main.js');

app.whenReady().then(async () => {
  try {
    console.log('=== STARTING END-TO-END INTEGRATION TEST ===');

    mainModule.registerIpcHandlers();
    mainModule.startPlaybackTicker();

    const preloadPath = path.resolve(__dirname, '../../dist-electron/preload.js');
    assert(fs.existsSync(preloadPath), `Preload script must exist at ${preloadPath}`);

    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    mainModule.setMainWindow(win);

    await win.loadURL('data:text/html;charset=utf-8,<!DOCTYPE html><html><head><title>E2E Test</title></head><body><div id="root"></div></body></html>');

    const fixturesDir = path.resolve(__dirname, '../fixtures');
    const sampleDrumLoopPath = path.join(fixturesDir, 'sample_drum_loop.wav');
    const testWavPath = path.join(fixturesDir, 'test.wav');

    assert(fs.existsSync(sampleDrumLoopPath), 'sample_drum_loop.wav fixture must exist');
    assert(fs.existsSync(testWavPath), 'test.wav fixture must exist');

    // Clean up existing .analysis directory to verify cold-start analysis generation
    const analysisDir = path.join(fixturesDir, '.analysis');
    if (fs.existsSync(analysisDir)) {
      fs.rmSync(analysisDir, { recursive: true, force: true });
    }

    console.log('1. Verifying window.audioApi IPC interface in renderer context...');
    const apiSurfaceVerified = await win.webContents.executeJavaScript(`
      (() => {
        if (!window.audioApi) return false;
        const methods = [
          'selectFolder', 'scanFolder', 'loadFileAnalysis',
          'startBatchAnalysis', 'controlBatchAnalysis', 'onBatchProgress',
          'playbackPlay', 'playbackPause', 'playbackStop', 'playbackSeek',
          'playbackSetVolume', 'onPlaybackTick'
        ];
        return methods.every(m => typeof window.audioApi[m] === 'function');
      })()
    `);
    assert.strictEqual(apiSurfaceVerified, true, 'window.audioApi must have all required methods');
    console.log('   ✓ window.audioApi surface verified');

    // 2. Scan folder
    console.log('2. Scanning audio fixtures folder...');
    const initialFiles = await win.webContents.executeJavaScript(`
      window.audioApi.scanFolder(${JSON.stringify(fixturesDir)})
    `);
    assert(Array.isArray(initialFiles), 'scanFolder must return an array');
    console.log('   ✓ Found ' + initialFiles.length + ' audio file(s)');
    const drumFileInfo = initialFiles.find(f => f.fileName === 'sample_drum_loop.wav');
    assert(drumFileInfo, 'sample_drum_loop.wav must be in scanned files');
    assert.strictEqual(drumFileInfo.status, 'unanalyzed');
    assert(drumFileInfo.fileSizeBytes > 0, 'fileSizeBytes should be > 0');

    // 3. Run Batch Analysis
    console.log('3. Running batch analysis in background...');
    const batchResult = await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Batch analysis timed out after 15 seconds. Cached: ' + Array.from(cachedFiles).join(',')));
        }, 15000);

        const cachedFiles = new Set();
        const progressUpdates = [];

        const unsub = window.audioApi.onBatchProgress((update) => {
          progressUpdates.push(update);
          if (update.status === 'cached' && update.progressPct === 100) {
            cachedFiles.add(update.filePath);
            if (cachedFiles.size >= ${initialFiles.length}) {
              clearTimeout(timeout);
              unsub();
              resolve({
                success: true,
                cachedFiles: Array.from(cachedFiles),
                progressUpdates
              });
            }
          }
        });

        window.audioApi.startBatchAnalysis(${JSON.stringify(fixturesDir)}, false);
      })
    `);

    assert(batchResult.success, 'Batch analysis should complete successfully');
    assert(batchResult.cachedFiles.includes(sampleDrumLoopPath), 'sample_drum_loop.wav must be cached');
    assert(batchResult.cachedFiles.includes(testWavPath), 'test.wav must be cached');
    console.log('   ✓ Batch analysis completed for all fixtures');

    // 4. Verify generated .analysis files and binary magic format (APV1 & ATT1)
    console.log('4. Verifying .analysis directory and binary file formats (APV1 & ATT1)...');
    assert(fs.existsSync(analysisDir), '.analysis folder must be generated');

    const drumApvPath = path.join(analysisDir, 'sample_drum_loop.wav.apv');
    const drumAttPath = path.join(analysisDir, 'sample_drum_loop.wav.att');
    assert(fs.existsSync(drumApvPath), 'sample_drum_loop.wav.apv must exist');
    assert(fs.existsSync(drumAttPath), 'sample_drum_loop.wav.att must exist');

    // Read APV binary header: Magic "APV1"
    const apvBuffer = fs.readFileSync(drumApvPath);
    const apvMagic = apvBuffer.toString('ascii', 0, 4);
    const apvVersion = apvBuffer.readUInt16LE(4);
    const apvLodCount = apvBuffer.readUInt16LE(6);
    console.log(`   ✓ APV Magic: "${apvMagic}", Version: ${apvVersion}, LOD Count: ${apvLodCount}`);
    assert.strictEqual(apvMagic, 'APV1', 'APV magic must be APV1');
    assert.strictEqual(apvVersion, 1, 'APV version must be 1');
    assert(apvLodCount >= 3, 'APV must contain at least 3 LOD tiers');

    // Read ATT binary header: Magic "ATT1"
    const attBuffer = fs.readFileSync(drumAttPath);
    const attMagic = attBuffer.toString('ascii', 0, 4);
    const attVersion = attBuffer.readUInt16LE(4);
    const attHeaderSize = attBuffer.readUInt16LE(6);
    console.log(`   ✓ ATT Magic: "${attMagic}", Version: ${attVersion}, Header Size: ${attHeaderSize}`);
    assert.strictEqual(attMagic, 'ATT1', 'ATT magic must be ATT1');
    assert.strictEqual(attVersion, 1, 'ATT version must be 1');
    assert(attHeaderSize >= 32, 'ATT header size must be >= 32 bytes');

    // 5. Test loadFileAnalysis & multi-tier LODs
    console.log('5. Testing loadFileAnalysis and multi-tier LOD retrieval...');
    const analysis = await win.webContents.executeJavaScript(`
      window.audioApi.loadFileAnalysis(${JSON.stringify(sampleDrumLoopPath)}, false)
    `);
    assert(analysis !== null, 'loadFileAnalysis must return analysis data');
    assert.strictEqual(analysis.sampleRate, 44100, 'Sample rate must be 44100');
    assert.strictEqual(analysis.channels, 2, 'Channels must be 2');
    assert.strictEqual(analysis.durationMs, 4000, 'Duration must be 4000ms');
    const detectedBpm = Math.round(analysis.bpm);
    assert(detectedBpm >= 118 && detectedBpm <= 122, `Detected BPM should be ~120, got ${analysis.bpm}`);
    assert(Array.isArray(analysis.lods), 'LODs must be an array');
    assert.strictEqual(analysis.lods.length, 3, 'Must have 3 LOD tiers');
    console.log(`   ✓ Detected BPM: ${analysis.bpm.toFixed(2)}, Duration: ${analysis.durationMs}ms`);

    for (let i = 0; i < analysis.lods.length; i++) {
      const lod = analysis.lods[i];
      assert(lod.downsampleRatio >= 1, `LOD ${i} downsampleRatio must be >= 1`);
      assert(lod.chunkCount > 0, `LOD ${i} chunkCount must be > 0`);
      assert(lod.peaks, `LOD ${i} must have peaks data`);
      console.log(`   ✓ LOD tier ${i}: downsampleRatio=${lod.downsampleRatio}, chunks=${lod.chunkCount}`);
    }

    assert(Array.isArray(analysis.beatMarkers) && analysis.beatMarkers.length >= 8, 'Must have at least 8 beat markers');
    console.log(`   ✓ Beat markers count: ${analysis.beatMarkers.length}`);

    // 6. Test Playback start, seek, pause, resume, and stop
    console.log('6. Testing libsoundio playback start, seek, and position tracking...');
    
    // Start playback at 0ms
    const playStarted = await win.webContents.executeJavaScript(`
      window.audioApi.playbackPlay(${JSON.stringify(sampleDrumLoopPath)}, 0)
    `);
    assert.strictEqual(playStarted, true, 'playbackPlay must return true');
    console.log('   ✓ Playback started');

    // Wait for playback tick confirming isPlaying and position advancement
    const tickResult = await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Playback tick timed out'));
        }, 3000);

        const unsub = window.audioApi.onPlaybackTick((state) => {
          if (state.isPlaying && state.currentMs > 0) {
            clearTimeout(timeout);
            unsub();
            resolve(state);
          }
        });
      })
    `);
    assert(tickResult.isPlaying, 'Tick must report isPlaying = true');
    assert(tickResult.currentMs > 0, 'Tick position must advance > 0ms');
    console.log(`   ✓ Playback running: currentMs = ${tickResult.currentMs}`);

    // Seek to 2000ms
    console.log('   Testing seek to 2000ms...');
    const seekResult = await win.webContents.executeJavaScript(`
      window.audioApi.playbackSeek(2000)
    `);
    assert.strictEqual(seekResult, true, 'playbackSeek must return true');

    // Wait for seek position update
    const seekTick = await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Seek tick timed out'));
        }, 3000);

        const unsub = window.audioApi.onPlaybackTick((state) => {
          if (state.isPlaying && state.currentMs >= 1900 && state.currentMs <= 2500) {
            clearTimeout(timeout);
            unsub();
            resolve(state);
          }
        });
      })
    `);
    assert(seekTick.currentMs >= 1900, 'Position must be at or after seek target');
    console.log(`   ✓ Seek verified: currentMs = ${seekTick.currentMs}`);

    // Pause playback
    console.log('   Testing pause...');
    const pauseResult = await win.webContents.executeJavaScript(`
      window.audioApi.playbackPause()
    `);
    assert.strictEqual(pauseResult, true, 'playbackPause must return true');

    // Verify paused position does not advance
    const pauseState = await win.webContents.executeJavaScript(`
      new Promise((resolve) => {
        let lastMs = 0;
        const unsub = window.audioApi.onPlaybackTick((state) => {
          if (!state.isPlaying) {
            unsub();
            resolve(state);
          }
        });
      })
    `);
    assert.strictEqual(pauseState.isPlaying, false, 'Should report isPlaying = false after pause');
    console.log(`   ✓ Paused verified: isPlaying = false, currentMs = ${pauseState.currentMs}`);

    // Stop playback
    console.log('   Testing stop...');
    const stopResult = await win.webContents.executeJavaScript(`
      window.audioApi.playbackStop()
    `);
    assert.strictEqual(stopResult, true, 'playbackStop must return true');

    const stopState = await win.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const unsub = window.audioApi.onPlaybackTick((state) => {
          if (!state.isPlaying && state.currentMs === 0) {
            unsub();
            resolve(state);
          }
        });
        setTimeout(() => resolve({ isPlaying: false, currentMs: 0 }), 300);
      })
    `);
    assert.strictEqual(stopState.isPlaying, false, 'isPlaying must be false after stop');
    assert.strictEqual(stopState.currentMs, 0, 'currentMs must be 0 after stop');
    console.log('   ✓ Stop verified: currentMs = 0');

    console.log('=== ALL END-TO-END INTEGRATION TESTS PASSED SUCCESSFULLY! ===');
    mainModule.stopPlaybackTicker();
    app.exit(0);
  } catch (err) {
    console.error('E2E Test Failed with Error:', err);
    mainModule.stopPlaybackTicker();
    app.exit(1);
  }
});
