const fs = require('fs');
const path = require('path');

const fixturesDir = path.join(__dirname, 'fixtures');
if (!fs.existsSync(fixturesDir)) {
  fs.mkdirSync(fixturesDir, { recursive: true });
}

const sampleRate = 44100;
const numChannels = 2;
const bitsPerSample = 16;
const bpm = 120;
const beatSec = 60 / bpm; // 0.5 sec
const beatsTotal = 8;     // 2 bars of 4/4
const durationSec = beatsTotal * beatSec; // 4.0 sec
const numFrames = Math.floor(sampleRate * durationSec);
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
buffer.writeUInt32LE(16, 16);
buffer.writeUInt16LE(1, 20); // PCM
buffer.writeUInt16LE(numChannels, 22);
buffer.writeUInt32LE(sampleRate, 24);
buffer.writeUInt32LE(sampleRate * blockAlign, 28);
buffer.writeUInt16LE(blockAlign, 32);
buffer.writeUInt16LE(bitsPerSample, 34);

// data subchunk
buffer.write('data', 36);
buffer.writeUInt32LE(dataSize, 40);

// Synthesis buffers (floats)
const leftSamples = new Float32Array(numFrames);
const rightSamples = new Float32Array(numFrames);

// Helper pseudo-random for snare & hats
let randSeed = 123456789;
function pseudoRandom() {
  randSeed = (randSeed * 1664525 + 1013904223) >>> 0;
  return (randSeed / 4294967296) * 2.0 - 1.0;
}

// Synthesize Kick
function addKick(startFrame, velocity = 1.0) {
  const kickDuration = Math.floor(sampleRate * 0.35);
  let phase = 0;
  for (let i = 0; i < kickDuration && (startFrame + i) < numFrames; i++) {
    const t = i / sampleRate;
    // Pitch drops from 160Hz to 48Hz
    const freq = 48 + (160 - 48) * Math.exp(-t / 0.035);
    phase += (2 * Math.PI * freq) / sampleRate;
    // Amplitude envelope
    const env = Math.exp(-t / 0.09) * velocity;
    // Transient click at the start
    const click = (i < sampleRate * 0.005) ? (1.0 - i / (sampleRate * 0.005)) * 0.4 : 0;
    const sample = (Math.sin(phase) + click) * env * 0.9;
    leftSamples[startFrame + i] += sample;
    rightSamples[startFrame + i] += sample;
  }
}

// Synthesize Snare
function addSnare(startFrame, velocity = 1.0) {
  const snareDuration = Math.floor(sampleRate * 0.3);
  let tonePhase = 0;
  for (let i = 0; i < snareDuration && (startFrame + i) < numFrames; i++) {
    const t = i / sampleRate;
    // Tonal body drops 240Hz -> 170Hz
    const freq = 170 + 70 * Math.exp(-t / 0.025);
    tonePhase += (2 * Math.PI * freq) / sampleRate;
    const toneEnv = Math.exp(-t / 0.07);
    const tone = Math.sin(tonePhase) * toneEnv * 0.5;

    // Noise body
    const noiseEnv = Math.exp(-t / 0.09);
    const noise = pseudoRandom() * noiseEnv * 0.6;

    // Snap transient at start
    const snap = (i < sampleRate * 0.004) ? (1.0 - i / (sampleRate * 0.004)) * 0.5 : 0;

    const sample = (tone + noise + snap) * velocity * 0.8;
    leftSamples[startFrame + i] += sample * 0.95;
    rightSamples[startFrame + i] += sample * 1.05;
  }
}

// Synthesize Hi-Hat
function addHiHat(startFrame, velocity = 0.5) {
  const hatDuration = Math.floor(sampleRate * 0.05);
  for (let i = 0; i < hatDuration && (startFrame + i) < numFrames; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-t / 0.015);
    // High frequency noise with metallic edge
    const sample = pseudoRandom() * env * velocity * 0.35;
    leftSamples[startFrame + i] += sample * 0.8;
    rightSamples[startFrame + i] += sample * 1.1;
  }
}

// Render pattern over 8 beats (2 bars)
for (let b = 0; b < beatsTotal; b++) {
  const beatStartFrame = Math.floor(b * beatSec * sampleRate);

  // Kicks on beat 0, 2, 4, 6 and an 8th-note kick at beat 2.5
  if (b % 2 === 0) {
    addKick(beatStartFrame, 1.0);
  }
  if (b === 2 || b === 6) {
    const syncKickFrame = Math.floor((b + 0.75) * beatSec * sampleRate);
    addKick(syncKickFrame, 0.7);
  }

  // Snares on beat 1, 3, 5, 7
  if (b % 2 === 1) {
    addSnare(beatStartFrame, 0.95);
  }

  // 8th-note Hi-Hats
  addHiHat(beatStartFrame, 0.5);
  const eighthFrame = Math.floor((b + 0.5) * beatSec * sampleRate);
  addHiHat(eighthFrame, 0.35);
}

// Write PCM to buffer with soft clipping / limiting
let offset = 44;
for (let f = 0; f < numFrames; f++) {
  let l = leftSamples[f];
  let r = rightSamples[f];

  // Soft clip
  l = Math.max(-0.99, Math.min(0.99, l));
  r = Math.max(-0.99, Math.min(0.99, r));

  const intL = Math.round(l * 32767);
  const intR = Math.round(r * 32767);

  buffer.writeInt16LE(intL, offset);
  offset += 2;
  buffer.writeInt16LE(intR, offset);
  offset += 2;
}

const outputPath = path.join(fixturesDir, 'sample_drum_loop.wav');
fs.writeFileSync(outputPath, buffer);
console.log(`Generated ${outputPath}:`);
console.log(`  Size: ${buffer.length} bytes`);
console.log(`  Duration: ${durationSec}s (${numFrames} frames)`);
console.log(`  Channels: ${numChannels}, Sample Rate: ${sampleRate}Hz, Tempo: ${bpm} BPM`);
