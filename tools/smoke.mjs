#!/usr/bin/env node
/**
 * smoke.mjs - headless proof that the WebAssembly build really runs.
 *
 * Boots the engine in Node (no browser needed), runs it, then drives it like a
 * player would - Escape opens the menu, N starts a new game, arrows walk, Ctrl
 * shoots - and writes PNG screenshots along the way.  Also mixes the audio
 * during demo playback to prove the sound system produces samples.
 *
 *   node tools/smoke.mjs [--frames 70] [--play] [--png out.png]
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { gunzipSync, deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Doom, TIC_MS } from "../web/js/doom.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// ---------------------------------------------------------------- PNG writer
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  const crcInput = Buffer.concat([Buffer.from(type, "ascii"), data]);
  out.writeUInt32BE(crc32(crcInput), 8 + data.length);
  return out;
}

/** Encode a DOOM framebuffer (BGRA bytes, alpha 0) as a PNG. */
function framebufferToPng(bytes, width, height) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4; // stored little-endian RGBA -> B,G,R,A
      raw[o++] = bytes[i + 2];
      raw[o++] = bytes[i + 1];
      raw[o++] = bytes[i];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------- main
const wasmPath = join(root, "web/doom.wasm");
const wadPath = join(root, "web/assets/freedoom1.wad.gz");
for (const file of [wasmPath, wadPath]) {
  if (!existsSync(file)) {
    console.error(`missing ${file} - run ./build.sh first`);
    process.exit(1);
  }
}

import { DOOM_KEY } from "../web/js/doom.js";

const frames = Number(arg("frames", 105));
const play = process.argv.includes("--play");
const pngPath = arg("png", join(root, "docs/screenshot-title.png"));

const wad = new Uint8Array(gunzipSync(readFileSync(wadPath)));
console.log(`IWAD      : ${wad.length} bytes (${(wad.length / 1048576).toFixed(1)} MiB decompressed)`);

const log = [];
const doom = new Doom({
  onStdout: (text) => log.push(text),
  onStderr: (text) => log.push(text),
});
doom.addFile("freedoom1.wad", wad);

const wasmBytes = readFileSync(wasmPath);
const t0 = performance.now();
await doom.init({ wasmBytes });
console.log(`wasm      : ${wasmBytes.length} bytes instantiated in ${(performance.now() - t0).toFixed(0)} ms`);

const t1 = performance.now();
doom.boot();
console.log(`boot      : engine initialised in ${(performance.now() - t1).toFixed(0)} ms`);
console.log(`video     : ${doom.width}x${doom.height}, ${doom.gamestate()} after boot`);

const wallStart = performance.now();
let ticks = 0;
const writePng = (path) => writeFileSync(path, framebufferToPng(doom.frameBytes(), doom.width, doom.height));
for (let i = 0; i < frames; i++) {
  doom.tick();
  ticks++;
  if (i % 35 === 0) doom.exports.dg_mix_audio(0, 0); // mixer must tolerate a zero-length request
  // pace exactly like the browser loop does (35 game tics per real second)
  const target = wallStart + ticks * TIC_MS;
  const slack = target - performance.now();
  if (slack > 0) await new Promise((resolve) => setTimeout(resolve, slack));
}

const wall = performance.now() - wallStart;
const expected = (frames * TIC_MS) / 1000;
const bytes = doom.frameBytes();
let distinct = new Set();
for (let i = 0; i < bytes.length; i += 4096) distinct.add(bytes[i]);
let nonZero = 0;
for (let i = 0; i < bytes.length; i += 4) {
  if (bytes[i] || bytes[i + 1] || bytes[i + 2]) nonZero++;
}

console.log(`ticks     : ${ticks} -> gametic ${doom.gametic()}, frames rendered ${doom.frameCount()}`);
console.log(`clock     : ${wall.toFixed(0)} ms of wall time for ${(expected * 1000).toFixed(0)} ms of game time`);
console.log(`frame     : ${nonZero}/${doom.width * doom.height} lit pixels, ${distinct.size} distinct byte values`);

writeFileSync(pngPath, framebufferToPng(bytes, doom.width, doom.height));
console.log(`screenshot: ${pngPath}`);

// ------------------------------------------------------------------ play
if (play) {
  const press = (key, ms = 120) => {
    doom.pushKey(true, key);
    const until = performance.now() + ms;
    while (performance.now() < until) doom.tick();
    doom.pushKey(false, key);
    return ms / TIC_MS;
  };
  const run = (n) => {
    for (let i = 0; i < n; i++) doom.tick();
    return n;
  };

  // The title screen.  Escape opens the menu, N picks "New Game".  Freedoom is
  // a Doom 1 style IWAD, so a new game asks for an episode first and then for a
  // difficulty - two more enters and we are standing in E1M1.
  console.log("\nplaying:");
  run(20);
  press(DOOM_KEY.ESCAPE);
  run(6);
  writePng(join(root, "docs/screenshot-menu.png"));
  console.log(`  Escape        : main menu, gamestate ${doom.gamestate()}`);

  press("n".charCodeAt(0));
  run(6);
  press(DOOM_KEY.ENTER); // episode 1 ("Outpost Outbreak")
  run(6);
  press(DOOM_KEY.ENTER); // "Hurt me plenty"
  run(6);
  press(DOOM_KEY.ENTER); // start the level
  run(24);
  console.log(`  new game      : gamestate ${doom.gamestate()}, gametic ${doom.gametic()}`);
  if (doom.gamestate() !== "GS_LEVEL") {
    console.error("FAIL: could not start a new game");
    process.exit(1);
  }

  // Walk forward, turn, shoot, open a door - a short scripted session.
  const before = doom.frameBytes().slice();
  doom.pushKey(true, DOOM_KEY.UPARROW);
  run(90);
  doom.pushKey(false, DOOM_KEY.UPARROW);
  press(DOOM_KEY.RIGHTARROW, 300);
  press(DOOM_KEY.FIRE, 120);
  run(8);
  press(DOOM_KEY.FIRE, 120);
  run(20);
  press(DOOM_KEY.USE, 120); // talk to a door
  run(40);
  writePng(join(root, "docs/screenshot-gameplay.png"));

  let changed = 0;
  const after = doom.frameBytes();
  for (let i = 0; i < after.length; i += 997) if (after[i] !== before[i]) changed++;
  console.log(`  walking+shooting: gametic ${doom.gametic()}, ${changed} sampled pixels moved`);
  if (changed < 100) {
    console.error("FAIL: the view did not change while playing");
    process.exit(1);
  }

  const audioFrames = 512;
  doom.prepareAudio({ sampleRate: 44100, maxFrames: audioFrames });
  let peak = 0;
  let nonSilent = 0;
  for (let i = 0; i < 700; i++) {
    doom.tick();
    const chunk = doom.mixAudio(audioFrames);
    let blockPeak = 0;
    for (let j = 0; j < chunk.length; j++) blockPeak = Math.max(blockPeak, Math.abs(chunk[j]));
    peak = Math.max(peak, blockPeak);
    if (blockPeak > 200) nonSilent++;
  }
  console.log(`  audio          : peak ${peak}, ${nonSilent}/700 mixing blocks non-silent`);
  if (peak < 1000) {
    console.error("FAIL: expected audible output while playing");
    process.exit(1);
  }
}

const expectedTic = frames + 1; // the engine also runs one tic inside dg_create()
if (doom.gametic() < expectedTic) {
  console.error(`FAIL: expected at least ${expectedTic} tics, got ${doom.gametic()}`);
  process.exit(1);
}
if (!play && doom.gametic() !== expectedTic) {
  console.error(`FAIL: expected exactly ${expectedTic} tics, got ${doom.gametic()}`);
  process.exit(1);
}
if (nonZero < doom.width * doom.height * 0.05) {
  console.error("FAIL: framebuffer looks empty");
  process.exit(1);
}
console.log(`engine log: ${log.length} lines, last: ${JSON.stringify(log.at(-1) || "")}`);
console.log("SMOKE TEST PASSED");
