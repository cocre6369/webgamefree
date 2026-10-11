/**
 * main.js - the application: load, boot, run, persist.
 *
 * Responsibilities, in order:
 *   1. fetch doom.wasm and the gzipped Freedoom IWAD, with a progress bar
 *   2. decompress the IWAD in the browser (DecompressionStream, with a
 *      portable fallback) and hand it to the engine's virtual filesystem
 *   3. boot the engine and run the frame loop: the engine is driven at exactly
 *      35 game tics per second (its native rate) while rendering is tied to
 *      requestAnimationFrame, so the game runs at the correct speed on any
 *      display - 60 Hz, 120 Hz or a throttled background tab
 *   4. wire input, audio, fullscreen and save persistence
 *
 * Nothing here is DOOM specific beyond keys and the tick rate: the engine does
 * everything else.
 */

import { Doom, TIC_MS } from "./doom.js";
import { Renderer } from "./renderer.js";
import { AudioEngine, unlockAudio } from "./audio.js";
import { attachKeyboard, attachMouse, attachTouch } from "./input.js";
import { SaveStore } from "./savedata.js";

const ASSETS = {
  wasm: "doom.wasm",
  wad: "assets/freedoom1.wad.gz",
};

const ui = {
  canvas: document.getElementById("canvas"),
  overlay: document.getElementById("overlay"),
  overlayText: document.getElementById("overlay-text"),
  progress: document.getElementById("progress"),
  progressFill: document.getElementById("progress-fill"),
  progressText: document.getElementById("progress-text"),
  start: document.getElementById("btn-start"),
  toast: document.getElementById("toast"),
  stats: {
    fps: document.getElementById("stat-fps"),
    mem: document.getElementById("stat-mem"),
    state: document.getElementById("stat-state"),
  },
  buttons: {
    sfx: document.getElementById("btn-sfx"),
    music: document.getElementById("btn-music"),
    full: document.getElementById("btn-full"),
    help: document.getElementById("btn-help"),
  },
  help: document.getElementById("help"),
  touch: document.getElementById("touch"),
  helpNotes: document.getElementById("help-notes"),
  factWasm: document.getElementById("fact-wasm"),
  factWad: document.getElementById("fact-wad"),
};

const state = {
  doom: null,
  renderer: null,
  audio: null,
  saves: null,
  sfx: true,
  music: true,
  running: false,
  booting: false,
  accumulator: 0,
  lastFrame: 0,
  fps: 0,
  fpsFrames: 0,
  fpsSince: 0,
  ticks: 0,
};

// ---------------------------------------------------------------- utilities
function setProgress(fraction, text) {
  ui.progressFill.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
  if (text) ui.progressText.textContent = text;
}

let toastTimer = null;
function toast(message, ms = 2600) {
  ui.toast.textContent = message;
  ui.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove("show"), ms);
}

/** Fetch a URL with progress reporting. */
async function fetchWithProgress(url, onProgress) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);

  const total = Number(response.headers.get("content-length") || 0);
  if (!response.body || !total) {
    return new Uint8Array(await response.arrayBuffer());
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received / total, received, total);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Turn whatever the server sent us into an IWAD.
 *
 * The asset on disk is gzipped (9.8 MiB instead of 27.5 MiB), but hosts differ:
 * some add `Content-Encoding: gzip` and hand the browser a decompressed body,
 * some serve the file as-is.  Both are handled by sniffing the magic bytes, so
 * the page works on any static host - GitHub Pages, a CDN, a local server -
 * without configuration.
 */
async function toIwad(bytes) {
  const gzipMagic = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const wadMagic = bytes[0] === 0x49 && bytes[1] === 0x57; // "IW"
  let wad = bytes;

  if (gzipMagic) wad = await decompressGzip(bytes);
  else if (!wadMagic) throw new Error("the game data is neither gzip nor a WAD");

  if (wad.length < 1048576 || !(wad[0] === 0x49 && wad[1] === 0x57 && wad[3] === 0x44)) {
    throw new Error(`that file is not a usable IWAD (${wad.length} bytes)`);
  }
  return wad;
}

/** Gunzip with the platform decoder when possible, otherwise always works. */
async function decompressGzip(bytes) {
  if (typeof DecompressionStream === "function") {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  if (typeof process !== "undefined" && process.versions?.node) {
    const { gunzipSync } = await import("node:zlib");
    return new Uint8Array(gunzipSync(bytes));
  }
  throw new Error("this browser cannot decompress the game data (no DecompressionStream)");
}

function formatBytes(bytes) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MiB` : `${Math.round(bytes / 1024)} KiB`;
}

// ------------------------------------------------------------------- loading
async function loadGame() {
  if (state.booting) return;
  state.booting = true;
  const t0 = performance.now();

  try {
    setProgress(0.02, "fetching the engine…");
    const wasmBytes = await fetchWithProgress(ASSETS.wasm, (fraction, received, total) =>
      setProgress(0.02 + fraction * 0.08, `engine ${formatBytes(received)} / ${formatBytes(total)}`),
    );
    ui.factWasm.textContent = `doom.wasm (${formatBytes(wasmBytes.length)})`;

    setProgress(0.1, "fetching the game data…");
    const wadGz = await fetchWithProgress(ASSETS.wad, (fraction, received, total) =>
      setProgress(0.1 + fraction * 0.5, `game data ${formatBytes(received)} / ${formatBytes(total)}`),
    );

    setProgress(0.62, "unpacking the game data…");
    await new Promise((resolve) => setTimeout(resolve, 30)); // let the bar paint
    const wad = await toIwad(wadGz);
    ui.factWad.textContent = `freedoom1.wad (${formatBytes(wad.length)})`;

    setProgress(0.72, "instantiating WebAssembly…");
    const doom = new Doom({ onStdout: (text) => logEngine("out", text), onStderr: (text) => logEngine("err", text) });
    doom.addFile("freedoom1.wad", wad);

    state.saves = new SaveStore(doom.fs, { onSave: (count) => toast(`💾 ${count} file(s) kept in local storage`) });
    const restored = state.saves.restore();
    if (restored > 0) toast(`restored ${restored} file(s) from local storage`);

    state.renderer = new Renderer(ui.canvas);
    await doom.init({ wasmBytes });
    state.doom = doom;

    setProgress(0.88, "starting DOOM…");
    await new Promise((resolve) => setTimeout(resolve, 30));
    doom.boot();
    state.renderer.upload(doom.frameBytes(), doom.width, doom.height);
    state.renderer.draw();

    state.saves.watch();
    state.saves.saveNow();

    setProgress(1, `ready in ${Math.round(performance.now() - t0)} ms — Freedoom Phase 1 loaded`);
    ui.start.disabled = false;
    ui.start.textContent = "▶  Play";
    document.title = "Freedoom — running in WebAssembly";
  } catch (error) {
    console.error(error);
    ui.overlayText.textContent = `Could not start the game: ${error.message}`;
    ui.start.disabled = false;
    ui.start.textContent = "↻ Try again";
    setProgress(0, "failed");
  } finally {
    state.booting = false;
  }
}

let engineLogLines = 0;
function logEngine(kind, text) {
  if (engineLogLines++ < 40) console[kind === "err" ? "warn" : "log"](`[doom] ${text.trimEnd()}`);
}

// ------------------------------------------------------------------ run loop
/**
 * One animation frame: run as many 35 Hz game tics as real time allows (spiral
 * of death capped at 5 to keep the browser responsive) and present the last
 * frame.
 */
function frame(now) {
  if (!state.running) return;
  requestAnimationFrame(frame);

  const delta = Math.min(250, now - state.lastFrame || 0);
  state.lastFrame = now;
  state.accumulator += delta;

  let tics = 0;
  const doom = state.doom;
  while (state.accumulator >= TIC_MS && tics < 5) {
    if (!doom.tick()) {
      stop("the engine stopped");
      return;
    }
    state.accumulator -= TIC_MS;
    tics++;
    state.ticks++;
    state.mouse?.turner.update();
  }
  if (tics === 0) state.mouse?.turner.update();

  // Audio: top up the mixer's ring buffer for the next few milliseconds.
  state.audio?.pump();

  if (doom.frameCount() !== state.lastFrameCount) {
    state.lastFrameCount = doom.frameCount();
    state.renderer.upload(doom.frameBytes(), doom.width, doom.height);
    state.renderer.draw();
  }

  // Stats
  state.fpsFrames++;
  if (now - state.fpsSince > 500) {
    state.fps = Math.round((state.fpsFrames * 1000) / (now - state.fpsSince));
    state.fpsFrames = 0;
    state.fpsSince = now;
    ui.stats.fps.textContent = String(state.fps);
    const bytes = doom.memory?.buffer.byteLength ?? 0;
    ui.stats.mem.textContent = (bytes / 1048576).toFixed(0);
    ui.stats.state.textContent = doom.gamestate();
  }
}

async function start() {
  const doom = state.doom;
  if (!doom || state.running) return;

  ui.overlay.classList.add("hidden");
  ui.canvas.focus?.();
  lockPointer();

  try {
    if (!state.audio) {
      const context = await unlockAudio();
      state.audio = new AudioEngine(doom, context);
      await state.audio.start();
      // Swap in the music player now that we can make noise.
      const { MusicPlayer } = await import("./music.js");
      doom.music = new MusicPlayer(context);
      doom.setMusicVolume(state.music ? 127 : 0);
      state.audio.setSfxEnabled(state.sfx);
      ui.helpNotes.textContent = `Audio: ${state.audio.mode} @ ${Math.round(state.audio.sampleRate)} Hz`;
    } else {
      await state.audio.resume();
    }
  } catch (error) {
    console.warn("audio unavailable:", error);
    toast("Audio is unavailable - the game runs silently");
  }

  attachInput();
  state.lastFrame = performance.now();
  state.fpsSince = state.lastFrame;
  state.running = true;
  requestAnimationFrame(frame);
  toast("Arrow keys to move · Space opens doors · Ctrl fires · Esc for the menu");
}

function stop(reason = "") {
  if (!state.running) return;
  state.running = false;
  state.saves?.saveNow();
  state.mouse?.turner.release();
  state.touchControl?.releaseAll();
  if (reason) toast(reason);
}

// -------------------------------------------------------------------- input
function attachInput() {
  if (state.inputAttached) return;
  state.inputAttached = true;

  attachKeyboard(state.doom, {
    onAppKey: (action, code) => {
      if (action === "fullscreen") toggleFullscreen();
      else if (action === "help") toggleHelp();
      else if (action === "restart") location.reload();
      else setSfx(!state.sfx);
    },
  });

  state.mouse = attachMouse(state.doom, ui.canvas);
  state.touchControl = attachTouch(state.doom, ui.touch, ui.touch);
  ui.canvas.addEventListener("mousedown", (event) => {
    if (event.button === 0 && document.pointerLockElement !== ui.canvas) lockPointer();
  });
}

// ------------------------------------------------------------------ controls
function setSfx(enabled) {
  state.sfx = !!enabled;
  ui.buttons.sfx.classList.toggle("on", state.sfx);
  ui.buttons.sfx.classList.toggle("off", !state.sfx);
  state.audio?.setSfxEnabled(state.sfx);
  toast(state.sfx ? "Sound effects on" : "Sound effects off", 1400);
}

function setMusic(enabled) {
  state.music = !!enabled;
  ui.buttons.music.classList.toggle("on", state.music);
  ui.buttons.music.classList.toggle("off", !state.music);
  state.doom?.setMusicVolume(state.music ? 127 : 0);
  toast(state.music ? "Music on" : "Music off", 1400);
}

function toggleFullscreen() {
  const target = document.getElementById("stage");
  try {
    if (document.fullscreenElement) {
      document.exitFullscreen()?.catch?.(() => {});
    } else {
      (target.requestFullscreen ?? target.webkitRequestFullscreen)?.call(target)?.catch?.(() => {});
    }
  } catch (error) {
    // Embedded frames may forbid fullscreen - not worth interrupting the game.
    console.debug("fullscreen unavailable:", error.message);
  }
}

function toggleHelp() {
  const hidden = ui.help.classList.toggle("hidden");
  ui.buttons.help.classList.toggle("on", !hidden);
  ui.buttons.help.classList.toggle("off", hidden);
}

/** Pointer lock is optional (and may be denied inside an iframe). */
function lockPointer() {
  try {
    ui.canvas.requestPointerLock?.()?.catch?.(() => {});
  } catch (error) {
    console.debug("pointer lock unavailable:", error.message);
  }
}

ui.start.addEventListener("click", () => {
  if (!state.doom) return loadGame();
  start();
});

ui.buttons.sfx.addEventListener("click", () => setSfx(!state.sfx));
ui.buttons.music.addEventListener("click", () => setMusic(!state.music));
ui.buttons.full.addEventListener("click", toggleFullscreen);
ui.buttons.help.addEventListener("click", toggleHelp);

window.addEventListener("resize", () => state.renderer?.resize());
document.addEventListener("fullscreenchange", () => setTimeout(() => state.renderer?.resize(), 60));

// The canvas box can change without a window resize (panels, fullscreen,
// embedded frames), so watch it directly where that is supported.
if (typeof ResizeObserver !== "undefined") {
  const stage = document.getElementById("screen");
  if (stage) new ResizeObserver(() => state.renderer?.resize()).observe(stage);
}

// Pause the game when the tab is hidden (the engine clock keeps running, so
// this also prevents a huge catch-up burst on return).
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    state.saves?.saveNow();
    state.accumulator = 0;
  } else if (state.running) {
    state.lastFrame = performance.now();
    state.accumulator = 0;
  }
});

window.addEventListener("beforeunload", () => state.saves?.saveNow());

// -------------------------------------------------------------------- boot
loadGame().then(() => {
  // Give the player something to look at while the title screen loops.
  state.renderer?.draw();
});

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

// Expose a little of the state for tinkering from the console.
window.freedoom = { state, toast, setSfx, setMusic };
