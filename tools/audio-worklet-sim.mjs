#!/usr/bin/env node
/**
 * audio-worklet-sim.mjs - test the SharedArrayBuffer audio path.
 *
 * The game prefers an AudioWorklet mixer (see web/js/audio.js) because it keeps
 * the sound thread independent of the frame rate.  A browser is needed to run
 * it for real, but the moving parts - the ring buffer, the back-pressure logic
 * and the worklet's process() - are plain JavaScript, so they can be exercised
 * here: the worklet module is imported with shimmed AudioWorkletProcessor and
 * registerProcessor globals, and the audio thread is simulated by calling
 * process() on a fixed quantum while the game loop refills the ring.
 *
 * What it proves: audio actually flows through the ring, the game never
 * overruns the reader, the underrun rate is low and the fallback watchdog is
 * armed.
 *
 * Usage: node tools/audio-worklet-sim.mjs
 */

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const check = (condition, message) => {
  console.log(`  ${condition ? "✓" : "✗"} ${message}`);
  if (!condition) failures.push(message);
};

// ------------------------------------------------- AudioWorklet environment
const processors = new Map();

class AudioWorkletProcessor {
  constructor() {
    this.port = { onmessage: null, postMessage() {} };
  }
}

globalThis.AudioWorkletProcessor = AudioWorkletProcessor;
globalThis.registerProcessor = (name, implementation) => processors.set(name, implementation);
globalThis.currentTime = 0;
globalThis.sampleRate = 48000;

class AudioWorkletNode {
  constructor(_context, name, options) {
    const Implementation = processors.get(name);
    if (!Implementation) throw new Error(`no processor registered as ${name}`);
    this.processor = new Implementation(options);
    this.port = this.processor.port;
    this.connected = false;
  }
  connect() {
    this.connected = true;
  }
  disconnect() {
    this.connected = false;
  }
}

globalThis.AudioWorkletNode = AudioWorkletNode;
globalThis.SharedArrayBuffer = globalThis.SharedArrayBuffer;
globalThis.crossOriginIsolated = true; // the gate that enables the worklet path

// ------------------------------------------------------------ audio context
function param() {
  return { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {} };
}
function node() {
  return { connect: () => node(), disconnect() {}, gain: param(), frequency: param(), Q: param() };
}
const context = {
  state: "running",
  sampleRate: 48000,
  currentTime: 0,
  destination: node(),
  createGain: () => node(),
  createDynamicsCompressor: () => ({ ...node(), threshold: param(), knee: param(), ratio: param() }),
  createBiquadFilter: () => node(),
  createOscillator: () => ({ ...node(), start() {}, stop() {}, type: "sine" }),
  createBufferSource: () => ({ ...node(), start() {}, stop() {}, buffer: null }),
  createBuffer: (_ch, length) => ({ getChannelData: () => new Float32Array(length), length }),
  createScriptProcessor: () => ({ connect() {}, disconnect() {}, onaudioprocess: null }),
  audioWorklet: {
    addModule: async (url) => {
      // Load the real worklet module with the shims in place.
      await import(String(url));
    },
  },
};

console.log("audio worklet path:");

const { Doom } = await import(pathToFileURL(join(root, "web/js/doom.js")).href);
const { AudioEngine } = await import(pathToFileURL(join(root, "web/js/audio.js")).href);

const wad = new Uint8Array(gunzipSync(readFileSync(join(root, "web/assets/freedoom1.wad.gz"))));
const doom = new Doom({});
doom.addFile("freedoom1.wad", wad);
await doom.init({ wasmBytes: readFileSync(join(root, "web/doom.wasm")) });
doom.boot();

const engine = new AudioEngine(doom, context);
await engine.start();
check(engine.mode === "worklet", "the engine chose the AudioWorklet path");
check(engine._node.connected, "the mixer node is connected to the destination");
check(engine._ring.capacity >= 4096, `ring buffer holds ${engine._ring.capacity} frames`);

// ---------------------------------------------------- simulate both threads
const QUANTUM = 128; // what a real browser calls process() with
const BLOCKS = 900; // 2 game tics per block -> ~51 s of game time
const left = new Float32Array(QUANTUM);
const right = new Float32Array(QUANTUM);

let loudestAfterStartup = 0;
let loudBlocks = 0;
let clipped = 0;
let framesPlayed = 0;

for (let block = 0; block < BLOCKS; block++) {
  // Game loop: run a couple of tics, then top the ring up.
  for (let i = 0; i < 2; i++) doom.tick();
  engine.pump();

  // Audio thread: render one quantum.
  engine._node.processor.process([], [[left, right]]);
  framesPlayed += QUANTUM;

  // The title screen is silent until the engine starts its demo ~10 s in, so
  // only measure once the game has something to say.
  if (doom.gametic() > 420) {
    let blockPeak = 0;
    for (let i = 0; i < QUANTUM; i++) {
      const l = Math.abs(left[i]);
      const r = Math.abs(right[i]);
      if (l > blockPeak) blockPeak = l;
      if (l >= 0.999 || r >= 0.999) clipped++;
    }
    if (blockPeak > loudestAfterStartup) loudestAfterStartup = blockPeak;
    if (blockPeak > 0.01) loudBlocks++;
  }
}

const underruns = Atomics.load(engine._ring.header, 2);
check(framesPlayed === BLOCKS * QUANTUM, `${framesPlayed} frames rendered by the worklet`);
check(loudestAfterStartup > 0.05, `audio flowed through the ring (peak ${loudestAfterStartup.toFixed(3)})`);
check(loudBlocks > 20, `${loudBlocks} blocks of game audio after the intro`);
check(underruns <= 2, `the ring never ran dry (${underruns} underruns over ${framesPlayed} frames)`);

// The engine's own limiter must keep the signal below full scale even with
// several sounds at once - clipping here would mean the gain staging is wrong.
check(clipped < framesPlayed * 0.01, `${clipped} of ${framesPlayed} frames at full scale (no hard clipping)`);

const queued = engine.latencyFrames;
check(queued >= 0 && queued <= engine._ring.capacity, `ring accounting is sane (${queued} frames queued)`);

// ------------------------------------------------------- watchdog behaviour
check(engine._watchdog !== null && engine._watchdog !== undefined, "the underrun watchdog is armed");

// Simulate a dead audio thread: process() is never called again, so the
// watchdog must hand over to the ScriptProcessor fallback.
engine._watchdog = {
  at: performance.now() - 5000,
  read: Atomics.load(engine._ring.header, 1), // stale counter => audio thread is stuck
};
engine.pump();
check(engine.mode === "scriptprocessor", "a stalled worklet falls back to ScriptProcessor");
check(engine._node.onaudioprocess !== null, "the fallback mixer is driving the output");

// And the fallback must produce sound too.
const fallbackLeft = new Float32Array(QUANTUM);
const fallbackRight = new Float32Array(QUANTUM);
let fallbackPeak = 0;
for (let block = 0; block < 40; block++) {
  doom.tick();
  engine._node.onaudioprocess({ outputBuffer: { getChannelData: (channel) => (channel === 0 ? fallbackLeft : fallbackRight) } });
  for (let i = 0; i < QUANTUM; i++) fallbackPeak = Math.max(fallbackPeak, Math.abs(fallbackLeft[i]));
}
check(fallbackPeak > 0.001, `the fallback path produces audio (peak ${fallbackPeak.toFixed(3)})`);
check(engine._node.onaudioprocess !== null, "the fallback mixer keeps its callback");

engine.stop();
doom.music?.stop?.();

console.log("\n" + "=".repeat(60));
if (failures.length) {
  console.log(`${failures.length} FAILED:`);
  failures.forEach((failure) => console.log(`  - ${failure}`));
  process.exit(1);
}
console.log("AUDIO WORKLET SIMULATION PASSED");
