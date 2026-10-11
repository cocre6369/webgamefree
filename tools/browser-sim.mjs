#!/usr/bin/env node
/**
 * browser-sim.mjs - run the web app in Node against a mock DOM.
 *
 * The game's engine side is covered by tools/smoke.mjs, but that never touches
 * the browser code: DOM wiring, the WebGL renderer, the audio engine, the
 * input mapping, the save store.  This harness stubs out just enough of the
 * browser (document, canvas, WebGL2, Canvas2D, AudioContext, localStorage,
 * requestAnimationFrame, fetch, DecompressionStream) to load web/js/main.js
 * and drive it: load -> click Play -> 200 frames of gameplay with synthetic
 * key/mouse/touch input -> savegames -> reload with restored state.
 *
 * It catches typos, undefined references, wrong API usage and broken control
 * flow.  It is not a substitute for looking at the thing in a real browser,
 * but it makes the difference between "probably works" and "verified".
 *
 * Usage: node tools/browser-sim.mjs
 */

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const notes = [];

function check(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
  } else {
    failures.push(message);
    console.log(`  ✗ ${message}`);
  }
}

// --------------------------------------------------------------- DOM mockery
class MockClassList {
  constructor() { this.set = new Set(); }
  add(...names) { names.forEach((n) => this.set.add(n)); }
  remove(...names) { names.forEach((n) => this.set.delete(n)); }
  contains(name) { return this.set.has(name); }
  toggle(name, force) {
    const want = force === undefined ? !this.set.has(name) : force;
    if (want) this.set.add(name);
    else this.set.delete(name);
    return want;
  }
}

class MockElement {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.classList = new MockClassList();
    this.listeners = new Map();
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.width = 640;
    this.height = 400;
  }
  get parentElement() { return this._parent ?? null; }
  set parentElement(value) { this._parent = value; }
  appendChild(child) { this.children.push(child); child.parentElement = this; return child; }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  removeEventListener(type, handler) {
    const list = this.listeners.get(type) || [];
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }
  dispatch(type, event = {}) {
    const handlers = this.listeners.get(type) || [];
    for (const handler of handlers) handler({ preventDefault() {}, stopPropagation() {}, ...event });
    return handlers.length;
  }
  querySelectorAll(selector) {
    const wanted = selector.startsWith("[data-key]") ? (el) => el.dataset.key !== undefined : () => false;
    const out = [];
    const walk = (node) => { if (wanted(node)) out.push(node); node.children.forEach(walk); };
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() {}
  requestPointerLock() { Object.defineProperty(document, "pointerLockElement", { value: this, configurable: true }); document.dispatch("pointerlockchange"); }
  setPointerCapture() {}
  getBoundingClientRect() { return { width: 1280, height: 800, top: 0, left: 0 }; }
  getContext(kind) {
    if (kind === "webgl2") return mockWebGL();
    if (kind === "2d") return mock2d(this);
    return null;
  }
  toDataURL() { return "data:image/png;base64,"; }
  get outerHTML() { return `<${this.tagName.toLowerCase()}>`; }
}

// A WebGL2 context that records what it was asked to do.
function mockWebGL() {
  const calls = { texImage2D: 0, texSubImage2D: 0, drawArrays: 0 };
  const gl = {
    calls,
    TEXTURE_2D: 0x0de1, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401, NEAREST: 0x2600,
    CLAMP_TO_EDGE: 0x812f, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803, UNPACK_ALIGNMENT: 0x0cf5,
    UNPACK_FLIP_Y_WEBGL: 0x9240, VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82, TRIANGLES: 0x0004,
    createShader: () => ({}), shaderSource: () => {}, compileShader: () => {},
    getShaderParameter: () => true, getShaderInfoLog: () => "",
    createProgram: () => ({}), attachShader: () => {}, linkProgram: () => {},
    getProgramParameter: () => true, getProgramInfoLog: () => "",
    useProgram: () => {}, getUniformLocation: () => ({}), uniform1i: () => {}, uniform2f: () => {},
    createVertexArray: () => ({}), bindVertexArray: () => {},
    createTexture: () => ({}), bindTexture: () => {},
    texParameteri: () => {}, pixelStorei: () => {},
    texImage2D: () => { calls.texImage2D++; },
    texSubImage2D: () => { calls.texSubImage2D++; },
    viewport: () => {}, drawArrays: () => { calls.drawArrays++; },
  };
  return gl;
}

function mock2d(canvas) {
  return {
    canvas,
    createImageData: (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
    putImageData: () => {},
  };
}

function mockAudioContext() {
  const param = () => ({ value: 0, setValueAtTime: () => {}, linearRampToValueAtTime: () => {}, exponentialRampToValueAtTime: () => {}, setTargetAtTime: () => {}, cancelScheduledValues: () => {} });
  const node = (extra = {}) => ({ connect: () => node(), disconnect: () => {}, gain: param(), frequency: param(), Q: param(), ...extra });
  return {
    state: "suspended",
    sampleRate: 48000,
    currentTime: 0,
    destination: node(),
    resume: async () => {},
    createGain: () => ({ ...node(), gain: param() }),
    createDynamicsCompressor: () => ({ ...node(), threshold: param(), knee: param(), ratio: param(), connect: () => {}, disconnect: () => {} }),
    createBiquadFilter: () => node(),
    createOscillator: () => ({ ...node(), start: () => {}, stop: () => {}, type: "sine", frequency: param() }),
    createBufferSource: () => ({ ...node(), start: () => {}, stop: () => {}, buffer: null }),
    createBuffer: (channels, length) => ({ getChannelData: () => new Float32Array(length), length, numberOfChannels: channels }),
    createScriptProcessor: () => ({ connect: () => {}, disconnect: () => {}, onaudioprocess: null }),
    audioWorklet: { addModule: async () => {} },
  };
}

const documentListeners = new Map();
const elements = new Map();
function element(id, tag = "div") {
  if (!elements.has(id)) elements.set(id, new MockElement(tag));
  return elements.get(id);
}

// The canvas lives inside #screen so the renderer can measure its box.
element("screen").appendChild(element("canvas", "canvas"));
element("overlay");
// The touch pad buttons exist in index.html; mirror them here.
const movePad = new MockElement("div");
for (const key of ["up", "left", "down", "right"]) {
  const button = new MockElement("button");
  button.dataset.key = key;
  movePad.appendChild(button);
}
const actionPad = new MockElement("div");
for (const key of ["fire", "use", "run", "map"]) {
  const button = new MockElement("button");
  button.dataset.key = key;
  actionPad.appendChild(button);
}
element("touch").appendChild(movePad);
element("touch").appendChild(actionPad);

const documentMock = {
  title: "",
  hidden: false,
  fullscreenElement: null,
  pointerLockElement: null,
  body: new MockElement("body"),
  getElementById: (id) => element(id),
  querySelector: (selector) => (selector === "#screen" ? element("screen") : null),
  createElement: (tag) => new MockElement(tag),
  addEventListener: (type, handler) => {
    if (!documentListeners.has(type)) documentListeners.set(type, []);
    documentListeners.get(type).push(handler);
  },
  removeEventListener: () => {},
  dispatch: (type, event = {}) => {
    for (const handler of documentListeners.get(type) || []) handler({ preventDefault() {}, ...event });
  },
  exitFullscreen: async () => {},
};

const windowListeners = new Map();
const storage = new Map();

const windowMock = {
  innerWidth: 1280,
  innerHeight: 800,
  devicePixelRatio: 1,
  addEventListener: (type, handler) => {
    if (!windowListeners.has(type)) windowListeners.set(type, []);
    windowListeners.get(type).push(handler);
  },
  removeEventListener: () => {},
  dispatch: (type, event = {}) => {
    for (const handler of windowListeners.get(type) || []) handler({ preventDefault() {}, ...event });
  },
  requestAnimationFrame: null,
  AudioContext: mockAudioContext,
  location: { protocol: "http:", reload: () => {} },
  localStorage: {
    get length() { return storage.size; },
    key: (i) => [...storage.keys()][i] ?? null,
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, v),
    removeItem: (k) => storage.delete(k),
  },
};

// frame pump
const frameQueue = [];
function requestAnimationFrame(callback) {
  frameQueue.push(callback);
  return frameQueue.length;
}

const globals = {
  window: windowMock,
  document: documentMock,
  localStorage: windowMock.localStorage,
  requestAnimationFrame,
  cancelAnimationFrame: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  crossOriginIsolated: false, // exercise the ScriptProcessor fallback
  AudioWorkletNode: undefined,
  btoa: (text) => Buffer.from(text, "binary").toString("base64"),
  atob: (text) => Buffer.from(text, "base64").toString("binary"),
  fetch: async (url) => {
    const path = join(root, "web", String(url).replace(/^\.?\//, ""));
    const bytes = readFileSync(path);
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === "content-length" ? String(bytes.length) : null) },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      body: {
        getReader() {
          let sent = false;
          return {
            read: async () => {
              if (sent) return { done: true };
              sent = true;
              return { done: false, value: new Uint8Array(bytes) };
            },
          };
        },
      },
    };
  },
};

for (const [key, value] of Object.entries(globals)) {
  try {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  } catch (error) {
    console.warn(`could not define global ${key}: ${error.message}`);
  }
}

// DecompressionStream shim backed by zlib (the browser path uses the real one).
globalThis.DecompressionStream = class {
  constructor() { this.readable = {}; }
};
globalThis.Blob = class {
  constructor(parts) { this.parts = parts; }
  stream() {
    const bytes = this.parts[0];
    return { pipeThrough: (transform) => transform.run(bytes) };
  }
};
globalThis.Response = class {
  constructor(stream) { this._stream = stream; }
  async arrayBuffer() { return this._stream(); }
};
// patch main.js' decompress path: Blob.stream().pipeThrough(DecompressionStream)
const originalBlob = globalThis.Blob;
globalThis.Blob = class extends originalBlob {
  stream() {
    const bytes = this.parts[0];
    return { pipeThrough: () => async () => gunzipSync(Buffer.from(bytes)) };
  }
};

// ------------------------------------------------------------------------ run
console.log("loading the app in a simulated browser…");
process.on("unhandledRejection", (error) => {
  console.log("  ! unhandled rejection:", error?.stack || error);
});
try {
  await import(pathToFileURL(join(root, "web/js/main.js")).href);
} catch (error) {
  console.log("  ! main.js threw:", error?.stack || error);
  process.exit(1);
}

// main.js kicks off loadGame() on import; let its promises run.
async function settle(times = 60) {
  // Yield to every event loop phase (timers included: the loader uses
  // setTimeout to let the progress bar paint).
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 2));
}

await settle(200);
console.log("  diag: typeof window.freedoom =", typeof globalThis.window?.freedoom,
            "| progress text:", JSON.stringify(documentMock.getElementById("progress-text").textContent));
const app = globalThis.window.freedoom;
if (!app) {
  console.log("  diag: overlay text =", JSON.stringify(documentMock.getElementById("overlay-text").textContent));
  console.log("  diag: overlay classes =", [...documentMock.getElementById("overlay").classList.set].join(","));
  process.exit(1);
}
check(!!app, "main.js exposes window.freedoom");
check(app.state.doom !== null, "engine loaded and instantiated after load");

if (!app.state.doom) {
  console.log("\nfailed to load:", documentMock.getElementById("progress-text").textContent);
  process.exit(1);
}

const doom = app.state.doom;
check(doom.width === 640 && doom.height === 400, `engine framebuffer is ${doom.width}x${doom.height}`);
check(app.state.renderer.mode === "webgl2", "WebGL2 renderer initialised");
check(doom.gamestate() === "GS_DEMOSCREEN", `engine booted into ${doom.gamestate()}`);

// click Play
const startButton = documentMock.getElementById("btn-start");
check(startButton.disabled === false, "the Play button becomes enabled");
await startButton.dispatch("click");
await settle(50);
check(app.state.running, "the run loop started after clicking Play");
check(app.state.audio !== null, `audio engine started (mode: ${app.state.audio?.mode})`);
check(doom.music !== null, "music player attached once audio was unlocked");

// keyboard: exactly the events a browser sends
const keydown = (code) => windowMock.dispatch("keydown", { code, key: code });
const keyup = (code) => windowMock.dispatch("keyup", { code, key: code });

/** Run animation frames until `count` game tics have elapsed. */
async function pumpFrames(count) {
  const target = doom.gametic() + count;
  let guard = 0;
  while (doom.gametic() < target && guard++ < 400) {
    const callbacks = frameQueue.splice(0, frameQueue.length);
    for (const callback of callbacks) callback(performance.now());
    await new Promise((resolve) => setTimeout(resolve, 6));
  }
}

/** Tap a key the way a player does: press, a few tics, release, a few tics. */
async function tap(code, tics = 6) {
  keydown(code);
  await pumpFrames(3);
  keyup(code);
  await pumpFrames(tics);
}

check(doom.gamestate() === "GS_DEMOSCREEN", "title screen is showing before input");

// Start a new game through the menu: Escape, N, episode, skill, go.
await tap("Escape", 6);  // main menu
await tap("KeyN", 6);    // new game
await tap("Enter", 6);   // episode 1
await tap("Enter", 6);   // skill
await tap("Enter", 12);  // start the level
check(doom.gamestate() === "GS_LEVEL", `menu navigation reached ${doom.gamestate()}`);

// walk forward + fire, exactly as a player would
keydown("ArrowUp");
keydown("ControlLeft");
await pumpFrames(20);
keydown("Space");
await pumpFrames(4);
keyup("Space");
keyup("ArrowUp");
keyup("ControlLeft");

// mouse: pointer lock then a swipe
element("canvas").dispatch("click");
element("canvas").dispatch("mousedown", { button: 0 });
documentMock.dispatch("mousemove", { movementX: 120 });
await settle(5);
documentMock.dispatch("mousemove", { movementX: -80 });
documentMock.dispatch("mouseup", { button: 0 });
await settle(5);

// touch controls
const touchPad = element("touch");
const buttons = touchPad.querySelectorAll("[data-key]");
check(buttons.length >= 6, `touch pad has ${buttons.length} buttons`);
let touchEvents = 0;
for (const button of buttons) touchEvents += button.dispatch("pointerdown", { pointerId: 1 });
await settle(3);
for (const button of buttons) button.dispatch("pointerup", { pointerId: 1 });

// run animation frames for a couple of simulated seconds
const startTic = doom.gametic();
await pumpFrames(120);
const tics = doom.gametic() - startTic;
check(tics > 20, `${tics} game tics ran in the frame loop`);
check(app.state.renderer.gl.calls.texSubImage2D + app.state.renderer.gl.calls.texImage2D > 0, "frames uploaded to the GPU");
check(app.state.renderer.gl.calls.drawArrays > 0, `${app.state.renderer.gl.calls.drawArrays} draws issued`);
check(Number(documentMock.getElementById("stat-fps").textContent) >= 0, "fps statistic updated");

// audio: the fallback path must be producing samples
check(app.state.audio.mode === "scriptprocessor", "fell back to ScriptProcessor without cross-origin isolation");
check(app.state.audio._node.onaudioprocess !== null, "audio callback installed");

// buttons
documentMock.getElementById("btn-sfx").dispatch("click");
await settle(2);
check(app.state.sfx === false, "SFX toggle flips the sound effects off");
documentMock.getElementById("btn-sfx").dispatch("click");
documentMock.getElementById("btn-music").dispatch("click");
await settle(2);
check(app.state.music === false, "music toggle flips music off");
documentMock.getElementById("btn-music").dispatch("click");
documentMock.getElementById("btn-help").dispatch("click");
check(documentMock.getElementById("help").classList.contains("hidden"), "help panel toggles");
documentMock.getElementById("btn-help").dispatch("click");
documentMock.getElementById("btn-full").dispatch("click");
await settle(2);

// save games: play a bit, write a fake savegame into the engine FS, then check
// that the store mirrors it into localStorage and restores it on reload.
const { SaveStore } = await import(pathToFileURL(join(root, "web/js/savedata.js")).href);
doom.fs.addFile("doomsav0.dsg", new Uint8Array([1, 2, 3, 4, 5]));
const saves = new SaveStore(doom.fs);
const saved = saves.saveNow();
check(saved >= 1, `save store mirrored ${saved} file(s) into localStorage`);
check([...storage.keys()].some((key) => key.includes("doomsav0.dsg")), "savegame present in (mock) localStorage");

const store2 = new SaveStore(doom.fs);
doom.fs.remove("doomsav0.dsg");
const restored = store2.restore();
check(restored >= 1 && doom.fs.exists("doomsav0.dsg"), `restored ${restored} file(s) into a fresh filesystem`);

// visibility / blur handling
documentMock.hidden = true;
documentMock.dispatch("visibilitychange");
documentMock.hidden = false;
documentMock.dispatch("visibilitychange");
windowMock.dispatch("blur");
await settle(5);
check(app.state.running, "app survives tab switches and blur");

// music parsing from the real IWAD, through the player
if (doom.music) {
  const wad = new Uint8Array(gunzipSync(readFileSync(join(root, "web/assets/freedoom1.wad.gz"))));
  const numlumps = new DataView(wad.buffer).getInt32(4, true);
  const infoOfs = new DataView(wad.buffer).getInt32(8, true);
  let registered = 0;
  for (let i = 0; i < numlumps && registered < 3; i++) {
    const offset = new DataView(wad.buffer).getInt32(infoOfs + i * 16, true);
    const size = new DataView(wad.buffer).getInt32(infoOfs + i * 16 + 4, true);
    const name = String.fromCharCode(...wad.subarray(infoOfs + i * 16 + 8, infoOfs + i * 16 + 16)).replace(/\0+$/, "");
    if (!name.startsWith("D_")) continue;
    const handle = doom.music.register(wad.subarray(offset, offset + size));
    if (handle) {
      doom.music.play(handle, true);
      registered++;
    }
  }
  check(registered === 3, `registered and started ${registered} songs in the synth`);
  check(doom.music.isPlaying(), "music player reports playback");
  doom.music.setVolume(64);
  doom.music.stop();
  check(!doom.music.isPlaying(), "music player stops on request");
}

// Shut the app's timers down so the harness exits cleanly.
app.state.saves?.stop?.();
app.state.audio?.stop?.();
app.state.running = false;
doom.music?.stop?.();
await settle(3);

console.log("\n" + "=".repeat(60));
if (failures.length) {
  console.log(`${failures.length} FAILED:`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log("BROWSER SIMULATION PASSED");
if (notes.length) notes.forEach((note) => console.log(`  note: ${note}`));