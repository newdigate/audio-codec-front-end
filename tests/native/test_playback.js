const path = require('path');
const fs = require('fs');
const assert = require('assert');
const native = require(path.join(__dirname, '../../build/Release/audio_native.node'));

console.log('Testing Audio Playback Engine with libsoundio...');

const fixturesDir = path.join(__dirname, '../fixtures');
const testWavPath = path.join(fixturesDir, 'test.wav');

assert(fs.existsSync(testWavPath), 'test.wav fixture must exist');

// 1. Initial State Check
const initialPos = native.playbackGetPosition();
console.log('Initial position:', initialPos);
assert.strictEqual(typeof initialPos, 'object');
assert.strictEqual(initialPos.isPlaying, false, 'Initial state should not be playing');
assert.strictEqual(initialPos.currentMs, 0, 'Initial position should be 0ms');

// 2. Set Volume
native.playbackSetVolume(0.8);
console.log('Set volume to 0.8 succeeded');

// 3. Start Playback
const playResult = native.playbackPlay(testWavPath, 0);
assert.strictEqual(playResult, true, 'playbackPlay should return true');
console.log('Playback started successfully');

// 4. Verify playing after a short delay
setTimeout(() => {
    const playPos = native.playbackGetPosition();
    console.log('Position after 200ms playback:', playPos);
    assert.strictEqual(playPos.isPlaying, true, 'playbackGetPosition should report isPlaying = true');
    assert(playPos.currentMs > 0, `currentMs should be > 0, got ${playPos.currentMs}`);
    assert(playPos.currentMs < 2000, `currentMs should be < 2000, got ${playPos.currentMs}`);

    // 5. Test Pause
    const pauseResult = native.playbackPause();
    assert.strictEqual(pauseResult, true, 'playbackPause should return true');
    const pausedPos = native.playbackGetPosition();
    console.log('Position immediately after pause:', pausedPos);
    assert.strictEqual(pausedPos.isPlaying, false, 'isPlaying should be false after pause');
    const pausedMs = pausedPos.currentMs;

    setTimeout(() => {
        const checkPausedPos = native.playbackGetPosition();
        console.log('Position after 100ms paused:', checkPausedPos);
        assert.strictEqual(checkPausedPos.isPlaying, false, 'isPlaying should remain false while paused');
        assert.strictEqual(checkPausedPos.currentMs, pausedMs, 'Position must not advance while paused');

        // 6. Test Resume
        let resumeResult;
        if (typeof native.playbackResume === 'function') {
            resumeResult = native.playbackResume();
        } else {
            resumeResult = native.playbackPause();
        }
        assert.strictEqual(resumeResult, true, 'resume should return true');
        console.log('Playback resumed');

        setTimeout(() => {
            const resumedPos = native.playbackGetPosition();
            console.log('Position after resume + 200ms:', resumedPos);
            assert.strictEqual(resumedPos.isPlaying, true, 'isPlaying should be true after resume');
            assert(resumedPos.currentMs > pausedMs, `Position should advance after resume (paused: ${pausedMs}, current: ${resumedPos.currentMs})`);

            // 7. Test Seek
            const seekTargetMs = 500;
            const seekResult = native.playbackSeek(seekTargetMs);
            assert.strictEqual(seekResult, true, 'playbackSeek should return true');
            console.log(`Seek to ${seekTargetMs}ms requested`);

            setTimeout(() => {
                const seekPos = native.playbackGetPosition();
                console.log('Position after seek:', seekPos);
                assert.strictEqual(seekPos.isPlaying, true, 'Should still be playing after seek');
                assert(seekPos.currentMs >= 450 && seekPos.currentMs <= 850,
                    `Position after seek to ${seekTargetMs}ms should be around 500ms-850ms, got ${seekPos.currentMs}`);

                // 8. Test Stop
                const stopResult = native.playbackStop();
                assert.strictEqual(stopResult, true, 'playbackStop should return true');
                const stoppedPos = native.playbackGetPosition();
                console.log('Position after stop:', stoppedPos);
                assert.strictEqual(stoppedPos.isPlaying, false, 'isPlaying should be false after stop');
                assert.strictEqual(stoppedPos.currentMs, 0, 'currentMs should reset to 0 after stop');

                // 9. Concurrency Edge Cases: Immediate Play + Seek in same tick
                console.log('Testing concurrency edge case: immediate Play + Seek in same tick...');
                native.playbackPlay(testWavPath, 0);
                native.playbackSeek(600); // Immediate seek in same tick!

                setTimeout(() => {
                    const immSeekPos = native.playbackGetPosition();
                    console.log('Position after immediate Play + Seek:', immSeekPos);
                    assert.strictEqual(immSeekPos.isPlaying, true, 'Should be playing after immediate Play + Seek');
                    assert(immSeekPos.currentMs >= 550, `Position should be at or past 600ms, got ${immSeekPos.currentMs}`);

                    // 10. Concurrency Edge Cases: Immediate Play + Pause in same tick
                    console.log('Testing concurrency edge case: immediate Play + Pause in same tick...');
                    native.playbackPlay(testWavPath, 0);
                    native.playbackPause(); // Immediate pause in same tick!

                    setTimeout(() => {
                        const immPausePos = native.playbackGetPosition();
                        console.log('Position after immediate Play + Pause:', immPausePos);
                        assert.strictEqual(immPausePos.isPlaying, false, 'Should be paused after immediate Play + Pause');
                        assert.strictEqual(immPausePos.currentMs, 0, 'Position should remain at 0ms');

                        // 11. Concurrency Edge Cases: Immediate Play + Stop in same tick
                        console.log('Testing concurrency edge case: immediate Play + Stop in same tick...');
                        native.playbackPlay(testWavPath, 0);
                        native.playbackStop(); // Immediate stop in same tick!

                        setTimeout(() => {
                            const immStopPos = native.playbackGetPosition();
                            console.log('Position after immediate Play + Stop:', immStopPos);
                            assert.strictEqual(immStopPos.isPlaying, false, 'Should be stopped after immediate Play + Stop');
                            assert.strictEqual(immStopPos.currentMs, 0, 'Position should remain at 0ms');

                            console.log('All playback & concurrency assertions PASSED successfully!');
                            process.exit(0);
                        }, 150);
                    }, 150);
                }, 150);
            }, 100);
        }, 200);
    }, 100);
}, 200);
