/**
 * audio.js - get the engine's mixed samples out of the speakers.
 *
 * The C side mixes on demand: dg_mix_audio(pointer, frames) fills a buffer in
 * wasm memory with interleaved stereo int16.  Somebody has to call it at a
 * steady rate, which is exactly what an audio device does - so we hang the
 * mixer off the audio callback, with two implementations:
 *
 *   1. AudioWorklet + SharedArrayBuffer (preferred).  The worklet runs on the
 *      audio thread and drains a ring buffer that the game loop keeps topped
 *      up.  Needs cross-origin isolation (serve.mjs sends COOP/COEP headers).
 *   2. ScriptProcessorNode fallback: the mixer runs on the main thread inside
 *      the audio callback.  Deprecated, works everywhere.
 *
 * Either way JavaScript owns the device, and the engine just says "here is
 * what I want to sound like".
 */

const RING_HEADER_INTS = 4; // write, read, underruns, capacity
const TARGET_LATENCY_S = 0.12; // keep this much audio queued ahead

export class AudioEngine {
  /**
   * @param {import("./doom.js").Doom} doom
   * @param {AudioContext} context
   */
  constructor(doom, context) {
    this.doom = doom;
    this.context = context;
    this.mode = "none";
    this.muted = false;
    this.sfxEnabled = true;
    this.running = false;
    this.underruns = 0;
    this.chunkFrames = 0;
    this._node = null;
    this._ring = null;
    this._bufferPointer = 0;
  }

  get sampleRate() {
    return this.context.sampleRate || 44100;
  }

  async start() {
    if (this.running) return this;
    const frames = 1024;
    this.chunkFrames = frames;
    this._bufferPointer = this.doom.prepareAudio({ sampleRate: Math.round(this.sampleRate), maxFrames: frames });

    const canUseWorklet = typeof AudioWorkletNode !== "undefined" && typeof SharedArrayBuffer !== "undefined" && self.crossOriginIsolated;

    if (canUseWorklet) {
      try {
        await this._startWorklet(frames);
      } catch (error) {
        console.warn("AudioWorklet unavailable, falling back to ScriptProcessor:", error);
        this._startScriptProcessor(frames);
      }
    } else {
      this._startScriptProcessor(frames);
    }

    this.running = true;
    return this;
  }

  // ------------------------------------------------------------- worklet path
  async _startWorklet(frames) {
    await this.context.audioWorklet.addModule(new URL("./audio-worklet.js", import.meta.url));

    const capacity = frames * 8;
    const shared = new SharedArrayBuffer(RING_HEADER_INTS * 4 + capacity * 2 * 2);
    const header = new Int32Array(shared, 0, RING_HEADER_INTS);
    header[0] = 0; // write index (frames)
    header[1] = 0; // read index (frames)
    header[2] = 0; // underruns
    header[3] = capacity;

    const node = new AudioWorkletNode(this.context, "doom-mixer", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { shared, capacity, muted: this.muted },
    });
    node.connect(this.context.destination);

    this._node = node;
    this._ring = {
      shared,
      header,
      samples: new Int16Array(shared, RING_HEADER_INTS * 4, capacity * 2),
      capacity,
    };
    this.mode = "worklet";
    this._refill();
  }

  _refill() {
    const ring = this._ring;
    if (!ring) return;
    const { header, samples, capacity } = ring;
    const write = Atomics.load(header, 0);
    const read = Atomics.load(header, 1);
    let queued = write - read;
    if (queued < 0) queued += capacity * 1000; // the worklet wrapped to 0
    const target = Math.round(this.sampleRate * TARGET_LATENCY_S);

    let guard = 0;
    while (queued < target && guard++ < 16) {
      const framesToMix = Math.min(this.chunkFrames, capacity - (write % capacity || 0));
      const chunk = this.doom.mixAudio(framesToMix);
      if (!chunk) break;
      let index = write % capacity;
      for (let i = 0; i < framesToMix; i++) {
        samples[(index + i) * 2 + 0] = this.sfxEnabled ? chunk[i * 2 + 0] : 0;
        samples[(index + i) * 2 + 1] = this.sfxEnabled ? chunk[i * 2 + 1] : 0;
      }
      write += framesToMix;
      queued += framesToMix;
      Atomics.store(header, 0, write);
    }

    this.underruns = Atomics.load(header, 2);
  }

  // ------------------------------------------------------ fallback path
  _startScriptProcessor(frames) {
    const node = this.context.createScriptProcessor(frames, 0, 2);
    node.onaudioprocess = (event) => {
      const left = event.outputBuffer.getChannelData(0);
      const right = event.outputBuffer.getChannelData(1);
      const chunk = this.doom.mixAudio(frames);
      for (let i = 0; i < frames; i++) {
        const l = chunk ? chunk[i * 2 + 0] / 32768 : 0;
        const r = chunk ? chunk[i * 2 + 1] / 32768 : 0;
        left[i] = this.sfxEnabled ? l : 0;
        right[i] = this.sfxEnabled ? r : 0;
      }
    };
    node.connect(this.context.destination);
    this._node = node;
    this.mode = "scriptprocessor";
  }

  /** Called from the game loop: keep the worklet's ring buffer stocked. */
  pump() {
    if (this.mode === "worklet") this._refill();
  }

  setSfxEnabled(enabled) {
    this.sfxEnabled = !!enabled;
  }

  async resume() {
    if (this.context.state === "suspended") await this.context.resume();
  }

  stop() {
    try {
      this._node?.disconnect();
    } catch {
      /* already gone */
    }
    this._node = null;
    this.running = false;
  }
}

/**
 * Browsers refuse to start audio without a gesture.  The start button calls
 * this, and from then on the engine's clock and the audio clock agree.
 */
export async function unlockAudio() {
  const context = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
  if (context.state === "suspended") await context.resume();
  return context;
}
