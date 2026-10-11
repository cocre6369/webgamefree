#!/usr/bin/env node
/**
 * decompile.mjs - read the compiled game back out again.
 *
 * The game ships as web/doom.wasm, a binary nobody can read.  This tool opens
 * it up with WABT and Binaryen and writes what is inside to docs/decompiled/:
 *
 *   api.md            imports, exports, memory layout - the engine's whole
 *                     contract with the browser, as tables
 *   exports.wat       the ~20 exported functions as WebAssembly text
 *   doom.wat          the *entire* module as WebAssembly text (--full)
 *   doom.c, doom.h    the entire module decompiled back into C by wasm2c
 *                     (--full, ~6 MB - the whole engine as C functions)
 *
 * The two full dumps are tens of megabytes of machine-generated code, so they
 * are written on demand (--full) and are not committed; everything small and
 * useful - the API tables and the exported functions - is.
 *
 * Usage:
 *   node tools/decompile.mjs            # api.md + exports.wat
 *   node tools/decompile.mjs --full     # also doom.wat and doom.dcmp.c
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wasmPath = join(root, "web/doom.wasm");
const outDir = join(root, "docs/decompiled");
const full = process.argv.includes("--full");

if (!existsSync(wasmPath)) {
  console.error(`missing ${wasmPath} - run ./build.sh first`);
  process.exit(1);
}

const require = createRequire(import.meta.url);
let wabt;
try {
  wabt = await require("wabt")();
} catch (error) {
  console.error("this tool needs the wabt package: npm install");
  console.error(String(error.message || error));
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

const wasm = readFileSync(wasmPath);
const bytes = new Uint8Array(wasm);
console.log(`doom.wasm: ${(wasm.length / 1024).toFixed(0)} KiB`);

// ------------------------------------------------------------------ sections
// Decode just enough of the binary to list imports/exports/memory precisely.
function leb(view, cursor) {
  let result = 0;
  let shift = 0;
  let byte;
  do {
    byte = view.getUint8(cursor.i++);
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return result >>> 0;
}

function utf8(view, cursor, length) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = view.getUint8(cursor.i++);
  return new TextDecoder().decode(out);
}

const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const cursor = { i: 8 };
const types = [];
const imports = [];
const exports = [];
const functions = []; // (imported first, then defined)
const memories = [];

const KIND = { 0: "func", 1: "table", 2: "memory", 3: "global" };
const TYPE = { 0x7f: "i32", 0x7e: "i64", 0x7d: "f32", 0x7c: "f64", 0x7b: "v128" };

function readType() {
  const kind = view.getUint8(cursor.i++);
  if (kind === 0x60) {
    const params = [];
    const paramCount = leb(view, cursor);
    for (let i = 0; i < paramCount; i++) params.push(TYPE[view.getUint8(cursor.i++)]);
    const results = [];
    const resultCount = leb(view, cursor);
    for (let i = 0; i < resultCount; i++) results.push(TYPE[view.getUint8(cursor.i++)]);
    return { params, results };
  }
  return null;
}

const definedFunctionTypes = []; // type index for each defined function, in order

while (cursor.i < bytes.byteLength) {
  const sectionId = view.getUint8(cursor.i++);
  const size = leb(view, cursor);
  const sectionEnd = cursor.i + size;

  if (sectionId === 1) {
    const count = leb(view, cursor);
    for (let i = 0; i < count; i++) {
      const type = readType();
      if (type) types.push(type);
    }
  } else if (sectionId === 2) {
    const count = leb(view, cursor);
    for (let i = 0; i < count; i++) {
      const moduleLength = leb(view, cursor);
      const module = utf8(view, cursor, moduleLength);
      const nameLength = leb(view, cursor);
      const name = utf8(view, cursor, nameLength);
      const kind = view.getUint8(cursor.i++);
      if (kind === 0) {
        const typeIndex = leb(view, cursor);
        imports.push({ module, name, kind: KIND[kind], typeIndex });
        functions.push({ name, imported: true, module });
      } else if (kind === 2) {
        const flags = view.getUint8(cursor.i++);
        let min = 0;
        let max = null;
        if (flags & 1) {
          min = leb(view, cursor);
          max = leb(view, cursor);
        } else {
          min = leb(view, cursor);
        }
        if (flags & 2) leb(view, cursor); // shared
        if (flags & 4) leb(view, cursor); // memory64
        memories.push({ name, module, min, max });
      } else {
        console.warn(`unhandled import kind ${kind}`);
        break;
      }
    }
  } else if (sectionId === 3) {
    const count = leb(view, cursor);
    for (let i = 0; i < count; i++) definedFunctionTypes.push(leb(view, cursor));
  } else if (sectionId === 5) {
    const count = leb(view, cursor);
    for (let i = 0; i < count; i++) {
      const flags = view.getUint8(cursor.i++);
      const min = leb(view, cursor);
      const max = flags & 1 ? leb(view, cursor) : null;
      memories.push({ name: `memory${i}`, module: null, min, max });
    }
  } else if (sectionId === 7) {
    const count = leb(view, cursor);
    for (let i = 0; i < count; i++) {
      const nameLength = leb(view, cursor);
      const name = utf8(view, cursor, nameLength);
      const kind = view.getUint8(cursor.i++);
      const index = leb(view, cursor);
      exports.push({ name, kind: KIND[kind], index });
    }
  } else if (sectionId === 12) {
    // data count - nothing to read
  }

  cursor.i = sectionEnd;
}

const pageSize = 65536;
const importedMemory = memories.find((memory) => memory.module);
const memorySummary = (importedMemory || memories[0]) ?? { min: 0, max: null };

// Function indices: imports first, then the module's own functions.  The
// build strips debug names, so signatures are recovered from the type section
// rather than from names in the text.
const importedFunctions = functions.filter((f) => f.imported).length;
const typeIndexOfFunction = (index) =>
  index < importedFunctions ? imports[index].typeIndex : definedFunctionTypes[index - importedFunctions];

for (const entry of exports) {
  if (entry.kind !== "func") continue;
  entry.type = types[typeIndexOfFunction(entry.index)];
}

/** C-ish signature of an exported function. */
function cSignature(name) {
  const entry = exports.find((e) => e.name === name);
  const type = entry?.type;
  if (!type) return `void ${name}(void)`;
  const params = type.params.map((kind, i) => `${kind} arg${i}`).join(", ");
  const result = type.results.length ? `${type.results[0]} ` : "void ";
  return `${result}${name}(${params || "void"})`;
}

// WebAssembly text of the whole module, used both for the API table and for
// the exports.wat extract.
const disassembled = wabt.readWasm(bytes, { readDebugNames: false });
const wat = disassembled.toText({ foldExprs: false, inlineExport: false });

/**
 * Split the module text into top-level function blocks.
 *
 * WABT prints the imported functions first, then the module's own functions in
 * index order, so the Nth `(func` block belongs to function index
 * importedFunctions + N.
 */
function watFunctionBlocks(text) {
  const blocks = [];
  let depth = 0;
  let start = -1;
  let inString = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && text[i - 1] !== "\\") inString = !inString;
    if (inString) continue;
    if (ch === ";" && text[i + 1] === ";") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "(") {
      depth++;
      // Inside "(module ..." the top-level forms sit at depth 2.
      if (depth === 2 && text.startsWith("(func", i)) start = i;
    } else if (ch === ")") {
      if (depth === 2 && start >= 0) {
        blocks.push({ text: text.slice(start, i + 1), index: blocks.length });
        start = -1;
      }
      depth--;
    }
  }
  return blocks;
}

// --------------------------------------------------------------- exports.wat
const blocks = watFunctionBlocks(wat);
const exportedFunctionNames = exports.filter((e) => e.kind === "func").map((e) => e.name);
const watExports = [];

for (const entry of exports) {
  if (entry.kind !== "func") continue;
  const block = blocks[entry.index - importedFunctions];
  if (!block) continue;
  // Give the anonymous function a name so the text is readable.
  const named = block.text.replace(/^\(func/, `(func $${entry.name}${
    entry.type && (entry.type.params.length || entry.type.results.length)
      ? ` (type ${entry.index})`
      : ""
  }`);
  watExports.push(
    `;; ${cSignature(entry.name)}\n;; export "${entry.name}" (function index ${entry.index})\n${named}`,
  );
}

writeFileSync(
  join(outDir, "exports.wat"),
  `;; Exported functions of doom.wasm, in WebAssembly text form.\n` +
    `;; Generated by tools/decompile.mjs from the build in web/doom.wasm.\n` +
    `;; ${exportedFunctionNames.length} exported functions; the module defines ${blocks.length}\n` +
    `;; functions plus ${importedFunctions} imports (${blocks.length + importedFunctions} in total).\n` +
    `;; Full module text: node tools/decompile.mjs --full\n\n` +
    watExports.join("\n\n") +
    "\n",
);

// -------------------------------------------------------------------- api.md
const describeMemory = `min ${memorySummary.min} pages (${(memorySummary.min * pageSize) / 1048576} MiB)` +
  (memorySummary.max ? `, max ${memorySummary.max} pages (${(memorySummary.max * pageSize) / 1048576} MiB)` : ", no maximum");

const api = `# Compiled API - what the browser and the engine say to each other

Generated by \`node tools/decompile.mjs\` from \`web/doom.wasm\`
(${(wasm.length / 1024).toFixed(0)} KiB, sha256 to be regenerated on every build).

This is the complete contract between the page and the game: ${imports.length} imports,
${exports.length} exports, one linear memory of ${describeMemory}. The module itself
defines ${definedFunctionTypes.length} functions and imports ${importedFunctions} more:
${definedFunctionTypes.length + importedFunctions} in total, of which the
${exports.filter((e) => e.kind === "func").length} listed here are reachable from
JavaScript. Everything else - renderer, physics, game logic, WAD parser - is
sealed inside.

## Memory

| | |
|---|---|
| name | \`${memorySummary.name ?? "memory"}\` |
| limits | ${describeMemory} |
| exported | ${exports.some((e) => e.kind === "memory") ? "yes" : "no"} |
| shared | no |

The engine's framebuffer lives at \`dg_framebuffer()\` and is
\`dg_width() * dg_height() * 4\` bytes of little-endian
\`0xAABBGGRR\` - that is, bytes in the order R, G, B, A with the alpha byte
unused. The renderer uploads it as an RGBA texture, one \`texSubImage2D\` per
frame and no CPU-side conversion.

## Imports (${imports.length})

| module | name | kind | purpose |
|---|---|---|---|
${imports
  .map((entry) => {
    const purpose =
      entry.module === "env"
        ? {
            web_now_ms: "the game clock, in milliseconds (performance.now)",
            web_music_register: "hand a MIDI/MUS lump to the Web Audio synth",
            web_music_unregister: "drop a song",
            web_music_play: "start a song (handle, looping)",
            web_music_stop: "stop the music",
            web_music_volume: "music volume 0-127",
            web_music_pause: "pause/resume the music",
            web_music_is_playing: "is the music playing?",
          }[entry.name] || "engine support"
        : `WASI preview1 - implemented in web/js/wasi.js (${entry.name})`;
    return `| \`${entry.module}\` | \`${entry.name}\` | ${entry.kind} | ${purpose} |`;
  })
  .join("\n")}

## Exports (${exports.length})

| name | kind | C signature |
|---|---|---|
${exports
  .filter((entry) => entry.kind === "func")
  .map((entry) => `| \`${entry.name}\` | func | \`${cSignature(entry.name).replace(/\|/g, "\\|")}\` |`)
  .join("\n")}
${exports.filter((e) => e.kind !== "func").map((e) => `| \`${e.name}\` | ${e.kind} | - |`).join("\n")}

## What the exports do

| name | notes |
|---|---|
| \`dg_create\` | loads the IWAD from the virtual filesystem, initialises the game, renders the first frame, switches the engine to one-tic-per-call mode |
| \`dg_tick\` | runs one 1/35 s game tic and renders one frame |
| \`dg_framebuffer\` | pointer to the ${640}x${400} RGBA framebuffer |
| \`dg_width\` / \`dg_height\` | framebuffer dimensions |
| \`dg_frame_count\` | incremented for every rendered frame; the page uses it to skip redundant uploads |
| \`dg_gametic\` | engine tic counter - a cheap "is it running?" probe |
| \`dg_gamestate\` | 0 level, 1 intermission, 2 finale, 3 demo/title |
| \`dg_push_key\` | queue a key event (pressed, doom key code) - see web/js/input.js |
| \`dg_mix_audio\` | mix \`frames\` stereo int16 samples into the given pointer |
| \`dg_audio_rate\` | sample rate the mixer is running at |
| \`dg_audio_init\` | tell the engine the device's sample rate |
| \`malloc\` / \`free\` | wasi-libc allocator, used for the import argument vector and audio buffers |
| \`__wasm_call_ctors\` | C static initialisers; the page calls it before \`dg_create\` |
| \`_start\` | WASI command entry - present for ABI completeness, never called |
| \`memory\` | the single linear memory |

Translated back to C, the platform layer that the engine calls and the page
invokes is just this (see src/doomgeneric_web.c):

\`\`\`c
void doomgeneric_Create(int argc, char **argv);   // called by dg_create()
void doomgeneric_Tick(void);                      // called by dg_tick()
\`\`\`

Everything else - input, timing, sound, music, video - goes through the
\`DG_*\` functions the engine expects every platform to provide.
`;

writeFileSync(join(outDir, "api.md"), api);
console.log(`wrote docs/decompiled/api.md (${imports.length} imports, ${exports.length} exports)`);
console.log(`wrote docs/decompiled/exports.wat (${watExports.length} functions)`);

// ------------------------------------------------------------------- --full
if (full) {
  console.log("disassembling the whole module…");
  writeFileSync(join(outDir, "doom.wat"), wat);
  console.log(`wrote docs/decompiled/doom.wat (${(wat.length / 1048576).toFixed(1)} MiB)`);

  // wasm2c turns the module back into C: one C function per WebAssembly
  // function, plus the memory helpers.  It is mechanical, unreadable C - but it
  // is a complete, compilable reconstruction of the engine.
  const local = join(root, "node_modules/.bin/wasm2c");
  const vendored = join(root, "node_modules/wabt/bin/wasm2c");
  const wasm2c = existsSync(local) ? local : existsSync(vendored) ? vendored : null;

  if (wasm2c) {
    try {
      execFileSync(wasm2c, [wasmPath, "-n", "doom", "-o", join(outDir, "doom.c")], { stdio: ["ignore", "ignore", "ignore"] });
      const c = statSync(join(outDir, "doom.c")).size;
      console.log(`wrote docs/decompiled/doom.c + doom.h (${(c / 1048576).toFixed(1)} MiB of C)`);
    } catch (error) {
      console.warn("wasm2c pass skipped:", error.message);
    }
  } else {
    console.warn("wasm2c not found - run npm install to enable the C decompilation");
  }
} else {
  console.log("(run with --full to also dump the entire module as .wat and as C)");
}
