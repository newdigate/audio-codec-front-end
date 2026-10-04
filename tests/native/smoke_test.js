const path = require('path');
const native = require(path.join(__dirname, '../../build/Release/audio_native.node'));
console.log('audio_native addon loaded. Version:', native.getVersion());
if (native.getVersion() !== '0.1.0') {
    throw new Error('Version mismatch');
}
