const path = require('path');
const fs = require('fs');
const assert = require('assert');
const native = require(path.join(__dirname, '../../build/Release/audio_native.node'));

console.log('Testing batch worker pool...');

const fixturesDir = path.join(__dirname, '../fixtures');
const testWavPath = path.join(fixturesDir, 'test.wav');

// Ensure fixture exists
assert(fs.existsSync(testWavPath), 'test.wav fixture must exist');

// Clean up any existing analysis cache in fixtures to test from clean state
const analysisDir = path.join(fixturesDir, '.analysis');
if (fs.existsSync(analysisDir)) {
    fs.rmSync(analysisDir, { recursive: true, force: true });
}
const flatApv = path.join(fixturesDir, 'test.wav.apv');
const flatAtt = path.join(fixturesDir, 'test.wav.att');
if (fs.existsSync(flatApv)) fs.unlinkSync(flatApv);
if (fs.existsSync(flatAtt)) fs.unlinkSync(flatAtt);

// 1. Test scanFolder before analysis (should be pending)
const filesBefore = native.scanFolder(fixturesDir);
console.log('Scanned files before analysis:', filesBefore.length);
assert(filesBefore.length >= 1, 'Should find at least 1 audio file');
const wavFile = filesBefore.find(f => f.fileName === 'test.wav');
assert(wavFile, 'test.wav should be found by scanFolder');
assert.strictEqual(wavFile.status, 'pending', 'Initial status should be pending');
assert(wavFile.sizeBytes > 0, 'sizeBytes should be > 0');
assert(typeof wavFile.durationMs === 'number');
assert(typeof wavFile.bpm === 'number');

// 2. Test controlBatchAnalysis
assert.strictEqual(native.controlBatchAnalysis('pause'), true, 'pause should return true');
assert.strictEqual(native.controlBatchAnalysis('resume'), true, 'resume should return true');
assert.strictEqual(native.controlBatchAnalysis('invalid'), false, 'invalid action should return false');

// 3. Test startBatchAnalysis
let progressCount = 0;
let cachedReported = false;

native.startBatchAnalysis(fixturesDir, false, (progress) => {
    console.log('Batch progress update:', progress);
    progressCount++;

    assert(progress.filePath, 'progress must have filePath');
    assert(typeof progress.progressPct === 'number', 'progressPct must be number');
    assert(typeof progress.bpm === 'number', 'bpm must be number');
    assert(typeof progress.status === 'string', 'status must be string');

    if (progress.status === 'cached' && progress.progressPct === 100 && progress.filePath.endsWith('test.wav')) {
        cachedReported = true;
        assert.strictEqual(Math.round(progress.bpm), 120, 'BPM should be ~120');
        assert(progress.durationMs > 0, 'durationMs should be > 0');

        // 4. Test loadFileAnalysis
        const analysis = native.loadFileAnalysis(progress.filePath, false);
        console.log('Loaded analysis for:', progress.filePath);
        assert(analysis !== null, 'analysis must not be null');
        assert.strictEqual(analysis.sampleRate, 44100, 'sampleRate should be 44100');
        assert.strictEqual(analysis.channels, 2, 'channels should be 2');
        assert(analysis.durationMs > 0, 'durationMs should be positive');
        assert.strictEqual(Math.round(analysis.bpm), 120, 'bpm should be 120');
        assert(Array.isArray(analysis.timeSignature), 'timeSignature should be array');
        assert.strictEqual(analysis.timeSignature[0], 4);
        assert.strictEqual(analysis.timeSignature[1], 4);

        // LOD tests
        assert(Array.isArray(analysis.lods), 'lods should be an array');
        assert(analysis.lods.length > 0, 'lods array should not be empty');
        console.log('LOD tiers count:', analysis.lods.length);
        try {
            for (let i = 0; i < analysis.lods.length; ++i) {
                const lod = analysis.lods[i];
                console.log(`LOD ${i}: ratio=${lod.downsampleRatio}, chunkCount=${lod.chunkCount}, peaks.length=${lod.peaks.length}`);
                assert(lod.downsampleRatio >= 1, 'downsampleRatio should be >= 1');
                assert(lod.chunkCount > 0, 'chunkCount should be > 0');
                assert(lod.peaks instanceof Int8Array, 'peaks must be Int8Array');
                assert(lod.buffer instanceof ArrayBuffer, 'buffer must be ArrayBuffer');
                assert.strictEqual(lod.peaks.length, lod.chunkCount * 4, 'peaks length should match chunkCount * 4');
            }

            // 5. Test scanFolder after analysis (should now report 'cached')
            const filesAfter = native.scanFolder(fixturesDir);
            const wavAfter = filesAfter.find(f => f.fileName === 'test.wav');
            assert(wavAfter, 'test.wav should be found after analysis');
            assert.strictEqual(wavAfter.status, 'cached', 'Status should be cached after analysis');
            assert(wavAfter.durationMs > 0, 'durationMs should be positive');
            assert.strictEqual(Math.round(wavAfter.bpm), 120, 'bpm should be ~120');

            console.log('All assertions passed for batch worker pool!');
        } catch (err) {
            console.error('Assertion error in callback:', err);
            process.exit(1);
        }
    }
});

// Give event loop time to receive callbacks
setTimeout(() => {
    assert(progressCount > 0, 'Should have received at least one progress callback');
    assert(cachedReported, 'Should have received a cached status report');
    console.log('test_batch_worker.js COMPLETED SUCCESSFULLY');
    process.exit(0);
}, 2000);
