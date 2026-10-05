const path = require('path');
const native = require(path.join(__dirname, '../../build/Release/audio_native.node'));
console.log('audio_native addon loaded. Version:', native.getVersion());
if (native.getVersion() !== '0.1.0') {
    throw new Error('Version mismatch');
}
const info = native.getDecoderInfo();
console.log('Decoder info:', info);
if (!info || typeof info.audioCodecsCommit !== 'string' || !info.audioCodecsCommit || info.flacMaxBlockSize !== 8192) {
    throw new Error(`Unexpected decoder info: ${JSON.stringify(info)}`);
}
console.log('smoke_test.js PASSED');
