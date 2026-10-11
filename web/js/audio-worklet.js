/**
 * audio-worklet.js - the audio thread half of the mixer.
 *
 * Runs inside an AudioWorkletGlobalScope.  It cannot touch WebAssembly memory,
 * so instead it drains a SharedArrayBuffer ring that the game loop fills with
 * the engine's mixed output (see audio.js).  When the ring runs dry we count an
 * underrun and output silence - never a click.
 */

const HEADER_INTS = 4; // write, read, underruns, capacity

class DoomMixer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { shared, capacity } = options.processorOptions;
    this.header = new Int32Array(shared, 0, HEADER_INTS);
    this.samples = new Int16Array(shared, HEADER_INTS * 4, capacity * 2);
    this.capacity = capacity;
    this.muted = !!options.processorOptions.muted;
    this.gain = 1 / 32768;

    this.port.onmessage = (event) => {
      if (event.data?.type === "mute") this.muted = !!event.data.value;
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] || output[0];
    const frames = left.length;

    let read = Atomics.load(this.header, 1);
    let write = Atomics.load(this.header, 0);
    let available = write - read;
    if (available < 0) available = 0;

    const toRead = Math.min(frames, available);
    const start = read % this.capacity;
    const gain = this.muted ? 0 : this.gain;

    for (let i = 0; i < toRead; i++) {
      const index = ((start + i) % this.capacity) * 2;
      left[i] = this.samples[index] * gain;
      right[i] = this.samples[index + 1] * gain;
    }
    for (let i = toRead; i < frames; i++) {
      left[i] = 0;
      right[i] = 0;
    }

    if (toRead < available) {
      // nothing - we simply did not need the rest this quantum
    }
    Atomics.store(this.header, 1, read + toRead);
    if (toRead < frames) {
      Atomics.add(this.header, 2, 1); // underrun counter, surfaced in the UI
    }

    return true;
  }
}

registerProcessor("doom-mixer", DoomMixer);
