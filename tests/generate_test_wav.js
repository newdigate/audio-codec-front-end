const fs = require('fs');
const path = require('path');

const fixturesDir = path.join(__dirname, 'fixtures');
if (!fs.existsSync(fixturesDir)) {
    fs.mkdirSync(fixturesDir, { recursive: true });
}

const sampleRate = 44100;
const numChannels = 2;
const bitsPerSample = 16;
const durationSec = 2.0;
const numFrames = Math.floor(sampleRate * durationSec);
const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
const blockAlign = numChannels * (bitsPerSample / 8);
const dataSize = numFrames * blockAlign;
const headerSize = 44;
const totalSize = headerSize + dataSize;

const buffer = Buffer.alloc(totalSize);

// RIFF header
buffer.write('RIFF', 0);
buffer.writeUInt32LE(totalSize - 8, 4);
buffer.write('WAVE', 8);

// fmt subchunk
buffer.write('fmt ', 12);
buffer.writeUInt32LE(16, 16); // subchunk1size (16 for PCM)
buffer.writeUInt16LE(1, 20);  // audioFormat (1 for PCM)
buffer.writeUInt16LE(numChannels, 22);
buffer.writeUInt32LE(sampleRate, 24);
buffer.writeUInt32LE(byteRate, 28);
buffer.writeUInt16LE(blockAlign, 32);
buffer.writeUInt16LE(bitsPerSample, 34);

// data subchunk
buffer.write('data', 36);
buffer.writeUInt32LE(dataSize, 40);

// Generate PCM audio: 120 BPM beats (every 0.5 sec) with 440Hz tone
const beatIntervalFrames = Math.floor(sampleRate * 0.5); // 120 BPM -> 0.5 sec = 22050 frames

let offset = 44;
for (let f = 0; f < numFrames; ++f) {
    const t = f / sampleRate;
    let sampleVal = Math.sin(2 * Math.PI * 440 * t) * 0.3; // base 440Hz tone

    // Add sharp kick/click on beats (every 0.5s)
    const frameInBeat = f % beatIntervalFrames;
    if (frameInBeat < sampleRate * 0.05) { // 50ms beat pulse
        const beatEnv = 1.0 - (frameInBeat / (sampleRate * 0.05));
        const kick = Math.sin(2 * Math.PI * 60 * (frameInBeat / sampleRate)) * beatEnv;
        sampleVal += kick * 0.6;
    }

    const clamped = Math.max(-1.0, Math.min(1.0, sampleVal));
    const int16Val = Math.round(clamped * 32767);

    // Left channel
    buffer.writeInt16LE(int16Val, offset);
    offset += 2;
    // Right channel
    buffer.writeInt16LE(-int16Val, offset);
    offset += 2;
}

const targetPath = path.join(fixturesDir, 'test.wav');
fs.writeFileSync(targetPath, buffer);
console.log(`Generated ${targetPath} (${buffer.length} bytes, ${durationSec}s, ${sampleRate}Hz stereo)`);
