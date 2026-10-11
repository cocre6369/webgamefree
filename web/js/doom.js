/**
 * doom.js - JavaScript side of the DOOM engine.
 *
 * The engine is the original DOOM source (via the doomgeneric port) compiled
 * for wasm32-wasi by build.sh.  This class owns the instance, hands the engine
 * its own clock, drives one game tic per tick() and exposes the 32 bit
 * framebuffer that the renderer uploads to the GPU.
 */

import { VirtualFS, createWasiImports } from "./wasi.js";
import { MusicPlayer } from "./music.js";

export const DOOM_KEY = {
  RIGHTARROW: 0xae,
  LEFTARROW: 0xac,
  UPARROW: 0xad,
  DOWNARROW: 0xaf,
  STRAFE_L: 0xa0,
  STRAFE_R: 0xa1,
  USE: 0xa2,
  FIRE: 0xa3,
  ESCAPE: 27,
  ENTER: 13,
  TAB: 9,
  BACKSPACE: 0x7f,
  PAUSE: 0xff,
  EQUALS: 0x3d,
  MINUS: 0x2d,
  RSHIFT: 0x80 + 0x36,
  RCTRL: 0x80 + 0x1d,
  RALT: 0x80 + 0x38,
  F1: 0x80 + 0x3b,
  F2: 0x80 + 0x3c,
  F3: 0x80 + 0x3d,
  F4: 0x80 + 0x3e,
  F5: 0x80 + 0x3f,
  F6: 0x80 + 0x40,
  F7: 0x80 + 0x41,
  F8: 0x80 + 0x42,
  F9: 0x80 + 0x43,
  F10: 0x80 + 0x44,
  F11: 0x80 + 0x57,
  F12: 0x80 + 0x58,
};

export const GAMESTATE = {
  0: "GS_LEVEL",
  1: "GS_INTERMISSION",
  2: "GS_FINALE",
  3: "GS_DEMOSCREEN",
};

const TICRATE = 35;
/** One DOOM tic: the engine's native simulation step (35 Hz). */
export const TIC_MS = 1000 / TICRATE;

export class Doom {
  /**
   * @param {object} [options]
   * @param {(text: string) => void} [options.onStdout]
   * @param {(text: string) => void} [options.onStderr]
   * @param {AudioContext} [options.audioContext] Web Audio context used for
   *        music.  Without one the game runs silently (music is handed to a
   *        null player), which is what the headless test does.
   */
  constructor({ onStdout, onStderr, audioContext = null } = {}) {
    this.instance = null;
    this.memory = null;
    this.exports = {};
    this.fs = new VirtualFS();
    this.argv = ["doom", "-iwad", "freedoom1.wad"];
    this.startTime = 0;
    this.virtualSleep = 0;
    this.stdout = onStdout || (() => {});
    this.stderr = onStderr || (() => {});
    this.exited = false;
    this.exitCode = null;
    this.tickCount = 0;
    this._view = null;
    this._frameBytes = 0;
    this.music = audioContext ? new MusicPlayer(audioContext) : null;
    this._mixFrames = 0;
    this._mixPointer = 0;
  }

  /** Reserve space in wasm memory for the audio mixer's output buffer. */
  prepareAudio({ sampleRate = 44100, maxFrames = 4096 } = {}) {
    this.exports.dg_audio_init(sampleRate);
    this._mixFrames = maxFrames;
    this._mixPointer = this.exports.malloc(maxFrames * 4); // stereo int16
    return this._mixPointer;
  }

  /**
   * Mix `frames` stereo frames into wasm memory and return a view of it.
   * Called from the audio worklet / ScriptProcessor callback.
   */
  mixAudio(frames = this._mixFrames) {
    if (!this._mixPointer) return null;
    this.exports.dg_mix_audio(this._mixPointer, frames);
    return new Int16Array(this.memory.buffer, this._mixPointer, frames * 2);
  }

  /** Add a file to the engine's virtual filesystem (e.g. the IWAD). */
  addFile(path, bytes) {
    this.fs.addFile(path, bytes);
  }

  async init({ wasmBytes, wasmUrl } = {}) {
    const imports = createWasiImports({
      getMemory: () => this.memory,
      fs: this.fs,
      args: this.argv,
      onStdout: (text) => this.stdout(text),
      onStderr: (text) => this.stderr(text),
      onExit: (code) => {
        this.exited = true;
        this.exitCode = code;
      },
    });

    const env = {
      // The engine's only notion of the outside world: a millisecond clock
      // and the audio device.  Sleeping is instantaneous - see
      // src/doomgeneric_web.c.  Sound effects are pulled with dg_mix_audio()
      // by whoever owns the audio device.
      web_now_ms: () => Math.round(performance.now() - this.startTime + this.virtualSleep),

      // Music: i_web_sound.c hands over MUS lumps and playback commands.
      web_music_register: (ptr, len) =>
        this.music ? this.music.register(new Uint8Array(this.memory.buffer, ptr, len).slice()) : 1,
      web_music_unregister: (handle) => this.music?.unregister(handle),
      web_music_play: (handle, looping) => this.music?.play(handle, looping !== 0),
      web_music_stop: () => this.music?.stop(),
      web_music_volume: (volume) => this.music?.setVolume(volume),
      web_music_pause: (paused) => this.music?.pause(paused !== 0),
      web_music_is_playing: () => (this.music && this.music.isPlaying() ? 1 : 0),
    };

    const resolveImports = (module) => {
      if (module === "env") return env;
      if (module === "wasi_snapshot_preview1") return imports.wasi_snapshot_preview1;
      throw new Error(`unexpected import module: ${module}`);
    };

    const result =
      wasmBytes !== undefined
        ? await WebAssembly.instantiate(wasmBytes, { env, wasi_snapshot_preview1: imports.wasi_snapshot_preview1 })
        : await WebAssembly.instantiateStreaming(fetch(wasmUrl), {
            env,
            wasi_snapshot_preview1: imports.wasi_snapshot_preview1,
          }).catch(async (error) => {
            // Fall back for servers that do not send application/wasm.
            const response = await fetch(wasmUrl);
            if (!response.ok) throw error;
            return WebAssembly.instantiate(await response.arrayBuffer(), {
              env,
              wasi_snapshot_preview1: imports.wasi_snapshot_preview1,
            });
          });

    this.instance = result.instance;
    this.exports = this.instance.exports;
    this.memory = this.exports.memory;
    this._resolveImports = resolveImports;

    // Run static initialisers (wasm-ld calls them from _start in a normal
    // WASI command; we are a reactor so we do it ourselves).
    if (this.exports.__wasm_call_ctors) this.exports.__wasm_call_ctors();

    this.startTime = performance.now();
    this.width = this.exports.dg_width();
    this.height = this.exports.dg_height();
    this._frameBytes = this.width * this.height * 4;
    return this;
  }

  /** Load the IWAD and boot the engine.  Returns when the title screen is up. */
  boot() {
    try {
      this.exports.dg_create();
    } catch (error) {
      if (this.exited) throw new Error(`DOOM exited during startup (code ${this.exitCode})`);
      throw error;
    }
    return this;
  }

  /** Run exactly one game tic and render exactly one frame. */
  tick() {
    if (this.exited) return false;
    this.tickCount++;
    try {
      this.exports.dg_tick();
    } catch (error) {
      if (this.exited) return false;
      throw error;
    }
    return true;
  }

  /** Byte view of the engine's framebuffer (RGBA byte order, alpha = 0). */
  frameBytes() {
    const ptr = this.exports.dg_framebuffer();
    if (!this._view || this._view.buffer !== this.memory.buffer || this._view.byteOffset !== ptr) {
      this._view = new Uint8Array(this.memory.buffer, ptr, this._frameBytes);
    }
    return this._view;
  }

  frameCount() {
    return this.exports.dg_frame_count();
  }

  gametic() {
    return this.exports.dg_gametic();
  }

  gamestate() {
    return GAMESTATE[this.exports.dg_gamestate()] || "?";
  }

  pushKey(pressed, doomKey) {
    if (this.exited) return;
    this.exports.dg_push_key(pressed ? 1 : 0, doomKey);
  }

  /** DOOM's own volume settings (0-15 in the menu) -> music gain. */
  setMusicVolume(volume) {
    this.music?.setVolume(volume);
  }

  /** Pause/resume the music (the engine does this while its menu is open). */
  pauseMusic(paused) {
    this.music?.pause(paused);
  }
}
