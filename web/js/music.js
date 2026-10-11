/**
 * music.js - DOOM music playback on the Web Audio API.
 *
 * Music lumps come in two flavours: MUS (the compact DMX event list shipped in
 * the original IWADs) and standard MIDI (what Freedoom uses).  A browser has
 * neither a DMX player nor an OPL2 FM chip, so this is a small software synth:
 * the lump is parsed into a flat list of timed events and then scheduled as
 * oscillator voices with envelopes, keeping the character of the original
 * instruments (bass, lead, brass, organ pads, noise drums).
 *
 * The engine never hears any of this - i_web_sound.c just hands over the lump
 * and says "play it, loop it, here is the volume".
 */

const MUS_HEADER = 0x1a534d55; // "MUS\x1a" little endian
const MUS_TICK_HZ = 140; // MUS delays are in 1/140 s

/** General MIDI programme -> synth recipe. */
function instrument(program) {
  if (program >= 0 && program <= 7) return { wave: "triangle", attack: 0.004, release: 0.35, gain: 0.55, filter: 4200 }; // piano
  if (program >= 8 && program <= 15) return { wave: "sine", attack: 0.006, release: 0.5, gain: 0.5, filter: 3000 }; // chromatic perc
  if (program >= 16 && program <= 23) return { wave: "triangle", attack: 0.01, release: 0.5, gain: 0.5, filter: 2600 }; // organ
  if (program >= 24 && program <= 31) return { wave: "sawtooth", attack: 0.02, release: 0.6, gain: 0.28, filter: 1700 }; // guitar
  if (program >= 32 && program <= 39) return { wave: "sawtooth", attack: 0.01, release: 0.3, gain: 0.3, filter: 2200 }; // bass
  if (program >= 40 && program <= 47) return { wave: "square", attack: 0.02, release: 0.45, gain: 0.3, filter: 2400 }; // strings
  if (program >= 48 && program <= 55) return { wave: "square", attack: 0.03, release: 0.4, gain: 0.26, filter: 2000 }; // ensemble
  if (program >= 56 && program <= 63) return { wave: "square", attack: 0.02, release: 0.25, gain: 0.32, filter: 2600 }; // brass
  if (program >= 64 && program <= 71) return { wave: "sawtooth", attack: 0.02, release: 0.25, gain: 0.28, filter: 3200 }; // reed
  if (program >= 72 && program <= 79) return { wave: "sine", attack: 0.02, release: 0.2, gain: 0.35, filter: 4000 }; // pipe
  if (program >= 80 && program <= 87) return { wave: "sawtooth", attack: 0.02, release: 0.2, gain: 0.3, filter: 3600 }; // synth lead
  if (program >= 88 && program <= 95) return { wave: "triangle", attack: 0.05, release: 0.6, gain: 0.3, filter: 1400 }; // synth pad
  if (program >= 96 && program <= 103) return { wave: "triangle", attack: 0.05, release: 0.7, gain: 0.3, filter: 1200 }; // fx
  return { wave: "sawtooth", attack: 0.005, release: 0.15, gain: 0.3, filter: 2800 };
}

/** Percussion note -> recipe (MUS channel 9). */
function percussion(note) {
  if (note <= 35) return { kind: "kick", freq: 110, decay: 0.16, gain: 0.5 };
  if (note <= 40) return { kind: "snare", freq: 320, decay: 0.14, gain: 0.32 };
  if (note <= 44) return { kind: "tom", freq: 300, decay: 0.16, gain: 0.3 };
  if (note <= 52) return { kind: "hat", decay: 0.06, gain: 0.16 };
  if (note <= 60) return { kind: "tom", freq: 420, decay: 0.12, gain: 0.26 };
  return { kind: "crash", decay: 0.4, gain: 0.2 };
}


/** Read a MIDI variable length quantity. */
function readVarLen(view, cursor) {
  let value = 0;
  let byte;
  do {
    byte = view.getUint8(cursor.i++);
    value = (value << 7) | (byte & 0x7f);
  } while (byte & 0x80);
  return value;
}

/**
 * Parse a standard MIDI file (formats 0 and 1) into the same flat event list
 * that the MUS parser produces.  Tempo changes are honoured, multiple tracks
 * are merged on a shared timeline.
 */
export function parseMidi(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset) =>
    String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));

  if (bytes.byteLength < 14 || tag(0) !== "MThd") return null;

  const headerLength = view.getUint32(4);
  const format = view.getUint16(8);
  const trackCount = view.getUint16(10);
  const division = view.getUint16(12);
  if (division & 0x8000) return null; // SMPTE timing is not used by DOOM music
  const ticksPerQuarter = division || 96;

  const tracks = [];
  let offset = 8 + headerLength;
  for (let t = 0; t < trackCount; t++) {
    while (offset + 8 <= bytes.byteLength && tag(offset) !== "MTrk") offset++;
    if (offset + 8 > bytes.byteLength) break;
    const length = view.getUint32(offset + 4);
    tracks.push({ start: offset + 8, end: Math.min(bytes.byteLength, offset + 8 + length) });
    offset += 8 + length;
  }
  if (tracks.length === 0) return tracks.length === 0 && format === 2 ? null : null;

  const merged = [];
  for (const track of tracks) {
    const cursor = { i: track.start };
    let tick = 0;
    let runningStatus = 0;
    while (cursor.i < track.end) {
      tick += readVarLen(view, cursor);
      let status = view.getUint8(cursor.i);
      if (status & 0x80) {
        cursor.i++;
        runningStatus = status;
      } else {
        status = runningStatus;
      }
      if (!status) break;

      const type = status & 0xf0;
      const channel = status & 0x0f;

      if (status === 0xff) {
        const metaType = view.getUint8(cursor.i++);
        const length = readVarLen(view, cursor);
        if (metaType === 0x51 && length === 3) {
          const microseconds = (view.getUint8(cursor.i) << 16) | (view.getUint8(cursor.i + 1) << 8) | view.getUint8(cursor.i + 2);
          merged.push({ tick, tempo: microseconds });
        }
        cursor.i += length;
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        const length = readVarLen(view, cursor);
        cursor.i += length;
        continue;
      }

      switch (type) {
        case 0x80: {
          const note = view.getUint8(cursor.i++);
          cursor.i++; // velocity
          merged.push({ tick, type: "off", channel, note });
          break;
        }
        case 0x90: {
          const note = view.getUint8(cursor.i++);
          const velocity = view.getUint8(cursor.i++);
          if (velocity === 0) merged.push({ tick, type: "off", channel, note });
          else if (channel === 9) merged.push({ tick, type: "drum", channel: 9, note, volume: velocity });
          else merged.push({ tick, type: "on", channel, note, volume: Math.round((velocity / 127) * 100) });
          break;
        }
        case 0xa0: {
          cursor.i += 2;
          break;
        }
        case 0xb0: {
          const controller = view.getUint8(cursor.i++);
          const value = view.getUint8(cursor.i++);
          merged.push({ tick, type: "control", channel, controller, value });
          break;
        }
        case 0xc0: {
          const program = view.getUint8(cursor.i++);
          merged.push({ tick, type: "program", channel, program });
          break;
        }
        case 0xd0: {
          cursor.i += 1;
          break;
        }
        case 0xe0: {
          const low = view.getUint8(cursor.i++);
          const high = view.getUint8(cursor.i++);
          merged.push({ tick, type: "bend", channel, bend: ((high << 7) | low) >> 6 });
          break;
        }
        default:
          cursor.i = track.end;
          break;
      }
    }
  }

  merged.sort((a, b) => a.tick - b.tick);

  // Walk the merged timeline, turning ticks into seconds with the tempo map.
  const events = [];
  let tempo = 500000; // microseconds per quarter note (120 bpm)
  let lastTick = 0;
  let seconds = 0;
  for (const event of merged) {
    seconds += ((event.tick - lastTick) / ticksPerQuarter) * (tempo / 1e6);
    lastTick = event.tick;
    if (event.tempo) {
      tempo = event.tempo;
      continue;
    }
    events.push({ time: seconds, ...event });
  }

  const duration = events.length ? events[events.length - 1].time : 0;
  return { events, duration, source: "midi" };
}

/** Parse whichever music format a WAD lump uses. */
export function parseMusic(bytes) {
  if (bytes.byteLength >= 14 && bytes[0] === 0x4d && bytes[1] === 0x54 && bytes[2] === 0x68 && bytes[3] === 0x64) {
    return parseMidi(bytes);
  }
  return parseMus(bytes);
}

/** Parse a MUS lump into a flat event list with absolute times in seconds. */
export function parseMus(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 16 || view.getUint32(0, true) !== MUS_HEADER) {
    return null;
  }
  const scoreLength = view.getUint16(4, true);
  const scoreStart = view.getUint16(6, true);
  const end = Math.min(bytes.byteLength, scoreStart + scoreLength);

  const events = [];
  let i = scoreStart;
  let ticks = 0;

  const readByte = () => bytes[i++];
  const readDelay = () => {
    for (;;) {
      const value = readByte();
      ticks += value & 0x7f;
      if ((value & 0x80) === 0) break;
    }
  };

  while (i < end) {
    readDelay();
    if (i >= end) break;
    const time = ticks / MUS_TICK_HZ;
    const event = readByte();
    const type = event & 0xf0;
    const channel = event & 0x0f;

    switch (type) {
      case 0x00: {
        // release note (channel, note)
        const ch = readByte();
        const note = readByte();
        events.push({ time, type: "off", channel: ch, note });
        break;
      }
      case 0x10: {
        // note on: note (MSB = has volume), optional volume
        const noteByte = readByte();
        let volume = null;
        if (noteByte & 0x80) volume = readByte();
        events.push({ time, type: "on", channel, note: noteByte & 0x7f, volume });
        break;
      }
      case 0x20: {
        const bend = readByte();
        events.push({ time, type: "bend", channel, bend });
        break;
      }
      case 0x30: {
        const controller = readByte();
        events.push({ time, type: "system", channel, controller });
        break;
      }
      case 0x40: {
        const controller = readByte();
        const value = readByte();
        events.push({ time, type: "control", channel, controller, value });
        break;
      }
      case 0x50: {
        const program = readByte();
        events.push({ time, type: "program", channel, program });
        break;
      }
      case 0x60: {
        events.push({ time, type: "end" });
        i = end;
        break;
      }
      case 0x70: {
        const note = readByte();
        events.push({ time, type: "off", channel, note });
        break;
      }
      case 0x80: {
        const note = readByte();
        const volume = readByte();
        events.push({ time, type: "drum", channel: 9, note, volume });
        break;
      }
      case 0x90: {
        const note = readByte();
        events.push({ time, type: "off", channel: 9, note });
        break;
      }
      default:
        // Unknown event: the rest of the stream cannot be trusted.
        i = end;
        break;
    }
  }

  const duration = events.length ? events[events.length - 1].time : 0;
  return { events, duration, source: "mus" };
}

/**
 * MUS -> Web Audio player.
 *
 * Voices are scheduled ahead of time (500 ms lookahead, refreshed every
 * 100 ms) which keeps timing independent of frame rate and lets looping songs
 * run forever without accumulating drift.
 */
export class MusicPlayer {
  constructor(context, destination = null) {
    this.context = context;
    this.master = context.createGain();
    this.master.gain.value = 0.5;
    this.compressor = context.createDynamicsCompressor();
    this.compressor.threshold.value = -14;
    this.compressor.knee.value = 24;
    this.compressor.ratio.value = 5;
    this.master.connect(this.compressor);
    this.compressor.connect(destination || context.destination);

    this.songs = new Map();
    this.nextHandle = 1;
    this.current = null; // { song, looping, startedAt, iteration, scheduleUntil }
    this.volume = 127;
    this.paused = false;
    this.master.gain.value = 0.55;
    this.timer = null;
    this.activeVoices = [];
  }

  /** Register a MUS lump, returns a handle the engine keeps. */
  register(bytes) {
    const song = parseMusic(bytes);
    if (!song || song.events.length === 0) return 0;
    const handle = this.nextHandle++;
    this.songs.set(handle, song);
    return handle;
  }

  unregister(handle) {
    this.songs.delete(handle);
    if (this.current && this.current.handle === handle) this.stop();
  }

  play(handle, looping) {
    const song = this.songs.get(handle);
    if (!song) return;
    this.stop();
    this.current = {
      handle,
      song,
      looping: !!looping,
      startedAt: this.context.currentTime + 0.06,
      iteration: 0,
      scheduleUntil: 0,
      channels: new Map(), // channel -> program
      voices: new Map(), // channel -> active voice
    };
    this.current.scheduleUntil = this.current.startedAt;
    this._schedule();
    this.timer = setInterval(() => this._schedule(), 100);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.current = null;
    for (const voice of this.activeVoices) {
      try {
        voice.gain.gain.cancelScheduledValues(this.context.currentTime);
        voice.gain.gain.setTargetAtTime(0, this.context.currentTime, 0.02);
        voice.stop(this.context.currentTime + 0.1);
      } catch {
        /* voice already finished */
      }
    }
    this.activeVoices = [];
  }

  setVolume(volume) {
    this.volume = Math.max(0, Math.min(127, volume));
    const scaled = (this.volume / 127) ** 2 * 0.55;
    this.master.gain.setTargetAtTime(this.paused ? 0 : scaled, this.context.currentTime, 0.02);
  }

  pause(paused) {
    this.paused = !!paused;
    const scaled = (this.volume / 127) ** 2 * 0.55;
    this.master.gain.setTargetAtTime(this.paused ? 0 : scaled, this.context.currentTime, 0.03);
    if (this.timer) {
      // Freeze scheduling while paused instead of letting notes pile up.
      clearInterval(this.timer);
      this.timer = setInterval(() => this._schedule(), 100);
    }
  }

  isPlaying() {
    return this.current !== null;
  }

  /** Do not schedule more than this far ahead (seconds). */
  get lookahead() {
    return 0.5;
  }

  _schedule() {
    const state = this.current;
    if (!state) return;
    const now = this.context.currentTime;

    while (state.scheduleUntil < now + this.lookahead) {
      const base = state.startedAt + state.iteration * (state.song.duration + 0.35);
      for (const event of state.song.events) {
        const time = base + event.time;
        if (time < state.scheduleUntil) continue;
        if (time > now + this.lookahead) break;
        this._apply(event, time, state);
      }
      state.scheduleUntil = base + state.song.duration + 0.35;
      state.iteration++;
      if (!state.looping && state.iteration > 1) {
        // Let the final notes ring out, then stop.
        setTimeout(
          () => {
            if (this.current === state) this.stop();
          },
          Math.max(0, (state.scheduleUntil - now) * 1000) + 500,
        );
        break;
      }
      if (state.iteration > 100000) break; // safety net
    }

    // Retire finished voices so the list does not grow without bound.
    if (this.activeVoices.length > 256) {
      const cutoff = now - 2;
      this.activeVoices = this.activeVoices.filter((v) => !v.ended || v.ended > cutoff);
    }
  }

  _apply(event, time, state) {
    switch (event.type) {
      case "program":
        state.channels.set(event.channel, event.program);
        break;
      case "control":
        if (event.controller === 0) state.channels.set(event.channel, event.value);
        break;
      case "on":
        this._noteOn(event, time, state);
        break;
      case "drum":
        this._drum(event.note, time, event.volume ?? 100);
        break;
      case "off":
        this._noteOff(event.channel, event.note, time);
        break;
      default:
        break;
    }
  }

  _noteOn(event, time, state) {
    const program = state.channels.get(event.channel) ?? 0;
    const recipe = instrument(program);
    const frequency = 440 * 2 ** ((event.note - 69) / 12);
    const rawVolume = (event.volume ?? 100) / 127;
    const gain = recipe.gain * rawVolume;

    const osc = this.context.createOscillator();
    osc.type = recipe.wave;
    osc.frequency.setValueAtTime(frequency, time);

    const filter = this.context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(recipe.filter, time);
    filter.Q.value = 0.8;

    const envelope = this.context.createGain();
    envelope.gain.setValueAtTime(0, time);
    envelope.gain.linearRampToValueAtTime(gain, time + recipe.attack);
    envelope.gain.setTargetAtTime(gain * 0.6, time + recipe.attack, 0.25);

    osc.connect(filter);
    filter.connect(envelope);
    envelope.connect(this.master);
    osc.start(time);

    const voice = { osc, gain: envelope, key: `${event.channel}:${event.note}`, ended: null };
    this.activeVoices.push(voice);

    const previous = state.voices.get(voice.key);
    if (previous) this._releaseVoice(previous, time, 0.02);
    state.voices.set(voice.key, voice);
  }

  _noteOff(channel, note, time) {
    const state = this.current;
    if (!state) return;
    const key = `${channel}:${note}`;
    const voice = state.voices.get(key);
    if (voice) {
      state.voices.delete(key);
      this._releaseVoice(voice, time, 0.12);
    }
  }

  _releaseVoice(voice, time, release) {
    try {
      voice.gain.gain.cancelScheduledValues(Math.max(time, this.context.currentTime));
      voice.gain.gain.setTargetAtTime(0, Math.max(time, this.context.currentTime), release);
      voice.osc.stop(Math.max(time, this.context.currentTime) + release * 6);
      voice.ended = this.context.currentTime;
    } catch {
      /* already stopped */
    }
  }

  _drum(note, time, volume) {
    const recipe = percussion(note);
    const amplitude = recipe.gain * (volume / 127);

    if (recipe.kind === "kick") {
      const osc = this.context.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(recipe.freq, time);
      osc.frequency.exponentialRampToValueAtTime(45, time + recipe.decay);
      const envelope = this.context.createGain();
      envelope.gain.setValueAtTime(amplitude, time);
      envelope.gain.exponentialRampToValueAtTime(0.001, time + recipe.decay * 2);
      osc.connect(envelope);
      envelope.connect(this.master);
      osc.start(time);
      osc.stop(time + recipe.decay * 2 + 0.02);
      this.activeVoices.push({ osc, gain: envelope, ended: this.context.currentTime });
      return;
    }

    // Noise-based drums: snare / hats / toms / crash.
    const length = Math.max(1, Math.floor(this.context.sampleRate * recipe.decay));
    const buffer = this.context.createBuffer(1, length, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      const decay = 1 - i / length;
      data[i] = (Math.random() * 2 - 1) * decay ** (recipe.kind === "hat" ? 6 : 2);
    }
    const source = this.context.createBufferSource();
    source.buffer = buffer;

    const filter = this.context.createBiquadFilter();
    if (recipe.kind === "snare") {
      filter.type = "bandpass";
      filter.frequency.value = 1800;
      filter.Q.value = 0.7;
    } else if (recipe.kind === "hat") {
      filter.type = "highpass";
      filter.frequency.value = 6000;
    } else {
      filter.type = "lowpass";
      filter.frequency.value = recipe.freq * 3;
    }

    const envelope = this.context.createGain();
    envelope.gain.setValueAtTime(amplitude, time);
    envelope.gain.exponentialRampToValueAtTime(0.001, time + recipe.decay);

    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(this.master);
    source.start(time);
    source.stop(time + recipe.decay + 0.02);
    this.activeVoices.push({ osc: source, gain: envelope, ended: this.context.currentTime });
  }
}
