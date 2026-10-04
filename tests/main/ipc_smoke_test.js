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
    console.log('Registering IPC handlers...');
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

    await win.loadURL('data:text/html;charset=utf-8,<!DOCTYPE html><html><body><h1>IPC Test</h1></body></html>');

    console.log('Page loaded in Electron. Verifying window.audioApi in renderer...');

    const result = await win.webContents.executeJavaScript(`
      (async () => {
        if (!window.audioApi) {
          throw new Error('window.audioApi is undefined');
        }

        const requiredMethods = [
          'selectFolder',
          'scanFolder',
          'loadFileAnalysis',
          'startBatchAnalysis',
          'controlBatchAnalysis',
          'onBatchProgress',
          'playbackPlay',
          'playbackPause',
          'playbackStop',
          'playbackSeek',
          'playbackSetVolume',
          'onPlaybackTick',
          'revealInFinder'
        ];

        for (const method of requiredMethods) {
          if (typeof window.audioApi[method] !== 'function') {
            throw new Error('Missing method on window.audioApi: ' + method);
          }
        }

        return { success: true };
      })()
    `);

    assert.strictEqual(result.success, true);
    console.log('window.audioApi surface verified successfully!');

    // 1. Test scanFolder through the IPC bridge
    const fixturesDir = path.resolve(__dirname, '../fixtures');
    const scanResult = await win.webContents.executeJavaScript(`
      window.audioApi.scanFolder(${JSON.stringify(fixturesDir)})
    `);

    console.log('scanFolder result count:', scanResult.length);
    assert(Array.isArray(scanResult), 'scanFolder must return an array');
    const wav = scanResult.find(f => f.fileName === 'test.wav');
    assert(wav, 'test.wav must be in scanFolder results');
    assert(wav.filePath.endsWith('test.wav'));
    assert(wav.fileSizeBytes > 0);
    assert.strictEqual(typeof wav.codec, 'string');
    assert.strictEqual(typeof wav.status, 'string');
    console.log('scanFolder IPC test passed! File:', wav.fileName, wav.codec, wav.status);

    // 2. Test loadFileAnalysis through the IPC bridge
    const testWavPath = path.join(fixturesDir, 'test.wav');
    const analysisResult = await win.webContents.executeJavaScript(`
      window.audioApi.loadFileAnalysis(${JSON.stringify(testWavPath)}, false)
    `);
    console.log('loadFileAnalysis result:', analysisResult ? 'Loaded' : 'null');
    assert(analysisResult, 'loadFileAnalysis should return analysis data for cached fixture');
    assert.strictEqual(analysisResult.sampleRate, 44100);
    assert.strictEqual(analysisResult.channels, 2);
    assert.strictEqual(Math.round(analysisResult.bpm), 120);
    assert(Array.isArray(analysisResult.lods), 'lods should be array');
    assert(Array.isArray(analysisResult.beatMarkers), 'beatMarkers should be array');
    console.log('loadFileAnalysis IPC test passed! LODs:', analysisResult.lods.length);

    // 3. Test controlBatchAnalysis through the IPC bridge
    const controlResult = await win.webContents.executeJavaScript(`
      window.audioApi.controlBatchAnalysis('pause')
    `);
    assert.strictEqual(controlResult, true);
    console.log('controlBatchAnalysis IPC test passed!');

    // 4. Test playbackPlay through the IPC bridge
    const playResult = await win.webContents.executeJavaScript(`
      window.audioApi.playbackPlay(${JSON.stringify(testWavPath)}, 0)
    `);
    assert.strictEqual(playResult, true);
    console.log('playbackPlay IPC test passed!');

    // 5. Test playbackStop through the IPC bridge
    const stopResult = await win.webContents.executeJavaScript(`
      window.audioApi.playbackStop()
    `);
    assert.strictEqual(stopResult, true);
    console.log('playbackStop IPC test passed!');

    // 5. Test onPlaybackTick and onBatchProgress listener registration/unregistration
    const listenerTest = await win.webContents.executeJavaScript(`
      (() => {
        let unsubTick = window.audioApi.onPlaybackTick((state) => {});
        let unsubBatch = window.audioApi.onBatchProgress((update) => {});
        if (typeof unsubTick !== 'function' || typeof unsubBatch !== 'function') {
          throw new Error('Event listeners must return unsubscription functions');
        }
        unsubTick();
        unsubBatch();
        return true;
      })()
    `);
    assert.strictEqual(listenerTest, true);
    console.log('Listener subscription/unsubscription test passed!');

    console.log('ALL ELECTRON IPC TESTS PASSED!');
    mainModule.stopPlaybackTicker();
    app.exit(0);
  } catch (err) {
    console.error('IPC Smoke Test Error:', err);
    app.exit(1);
  }
});
