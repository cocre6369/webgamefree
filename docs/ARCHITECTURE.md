# Architecture: how DOOM ended up in a browser tab

This document explains the design decisions, the measurements behind them and
the dead ends that were walked into on the way. It assumes you know roughly what
DOOM is and have a passing familiarity with WebAssembly.

* [1. Choosing what to port](#1-choosing-what-to-port)
* [2. The toolchain: Zig instead of Emscripten](#2-the-toolchain-zig-instead-of-emscripten)
* [3. The seam: one tic per call](#3-the-seam-one-tic-per-call)
* [4. Video](#4-video)
* [5. Input](#5-input)
* [6. Sound](#6-sound)
* [7. Music](#7-music)
* [8. Files: the WASI shim](#8-files-the-wasi-shim)
* [9. The game data](#9-the-game-data)
* [10. Decompiling the result](#10-decompiling-the-result)
* [11. Measurements](#11-measurements)
* [12. Dead ends](#12-dead-ends)

---

## 1. Choosing what to port

The brief was "the best open source game, playable on the web". Plenty of
excellent open-source games exist — *SuperTuxKart*, *0 A.D.*, *Battle for
Wesnoth*, *OpenTTD*, *Cataclysm: DDA*, *Shattered Pixel Dungeon* — but only one
of them is *DOOM*: the game that defined a genre, whose source release in 1997 is
the reason "open source game" is a phrase at all, and whose engine is small
enough to be compiled for a browser in seconds.

Two obstacles come with DOOM, and both have clean answers:

* **The engine** is GPL and its original source expects DOS, then Win32/Unix.
  The [`doomgeneric`](https://github.com/ozkl/doomgeneric) port exists precisely
  to solve this: it compiles the id source unchanged and asks the platform for
  exactly six things (`DG_Init`, `DG_DrawFrame`, `DG_SleepMs`, `DG_GetTicksMs`,
  `DG_GetKey`, `DG_SetWindowTitle`). One new C file implements those against the
  browser and the engine does not need a single line changed.

* **The game data** (levels, sprites, textures, sounds, music) is not free:
  id's IWADs are commercial, shareware `doom1.wad` is "free to distribute" but
  not open source. [Freedoom](https://freedoom.github.io) is the answer — a
  complete, independent Doom 1 IWAD, BSD-3-Clause, with 1990s-era assets
  re-drawn from scratch by volunteers and still maintained (0.13.0, 2024). It is
  what Debian and every Linux distribution ships instead of DOOM.

So: `doomgeneric` + Freedoom Phase 1. Engine GPL, data BSD, no id assets, no
emulator, and a 640×400 software renderer that fits comfortably in a browser's
frame budget.

## 2. The toolchain: Zig instead of Emscripten

Emscripten is the obvious choice and it was the first thing tried. It is also a
~1.5 GB download that fetches LLVM, binaryen and node from
`storage.googleapis.com`, which is not among the hosts this sandbox can reach.
Rather than stop there, the build uses **Zig 0.14.1**, which ships a complete
Clang-based C compiler *and* wasi-libc, self-contained, installable from PyPI:

```
zig cc --target=wasm32-wasi -O3 -flto ...
```

That is the entire toolchain — no SDK to activate, no environment script, no
`emconfigure`. The trade-off is that everything Emscripten normally does for you
has to be done by hand:

| Emscripten would give you | what this project does instead |
|---|---|
| `--preload-file` + `FS` | a WASI virtual filesystem in JavaScript (`web/js/wasi.js`) |
| `emscripten_set_main_loop` | one tic per exported call, driven by `requestAnimationFrame` |
| `SDL2` audio callbacks | a mixer in C, pulled by the page's audio callback |
| `emscripten_get_now()` | a `web_now_ms` import |
| `EMSCRIPTEN_KEEPALIVE` exports | explicit `-Wl,--export=` list in `build.sh` |

The result is arguably better for this job: the module has **23 imports** (15
WASI filesystem/clock/random calls, 8 from the page) and **18 exports**, all of
which are documented in [`docs/decompiled/api.md`](decompiled/api.md). Nothing
magic is hidden in generated JavaScript.

Two compiler details were worth fighting for:

* `__wasm_call_ctors` is exported and called by the page, because a WASI
  *reactor* (which is what this is) never calls `_start`, and without the C
  static initialisers the engine's tables are full of zeros.
* `-Wl,--initial-memory=50331648` (48 MiB) and `--max-memory=1073741824`
  (1 GiB): the engine allocates its zone heap and the 5.7 MB IWAD lump cache at
  startup, and memory must be able to grow for the level data of later maps.

## 3. The seam: one tic per call

DOOM's main loop is written to own the CPU:

```c
for (;;) {
    I_StartFrame();
    TryRunTics();          // runs N tics, may call I_Sleep(1) in a loop
    S_UpdateSounds(...);
    D_Display();
    // ...and I_FinishUpdate() blits when it likes
}
```

`TryRunTics()` compares the wall clock against the game clock and either runs
tics or *waits*, calling `I_Sleep(1)` until the next tic is due. A browser tab
cannot afford either half: blocking the main thread for 28 ms per tic destroys
input latency and animation, and 35 blocking tics per second is exactly how a
web game feels broken.

The fix has three parts:

1. **The loop is cut open.** `doomgeneric_Tick()` — one pass of
   `I_StartFrame` / `TryRunTics` / `S_UpdateSounds` / `D_Display` — is exported as
   `dg_tick()`. `D_DoomLoop()` is never allowed to loop.
2. **The engine is put into `singletics` mode** (`dg_create()` sets it): every
   `TryRunTics()` call then advances the simulation by exactly one tic, which is
   exactly how DOOM plays back demos at a fixed rate.
3. **Sleeping is a lie.** `DG_SleepMs(ms)` does not sleep; it adds `ms` to a
   virtual offset that `DG_GetTicksMs()` adds to the real clock. The engine's
   wait loops see time pass, stop waiting and return — instantly — while the
   browser's main thread stays free.

JavaScript then owns the clock, with a classic fixed-step accumulator:

```js
state.accumulator += delta;                       // real ms since the last frame
while (state.accumulator >= TIC_MS && tics < 5) { // TIC_MS = 1000/35
  doom.tick();                                    // exactly one game tic
  state.accumulator -= TIC_MS;
  tics++;
}
```

The simulation therefore runs at exactly 35 Hz on every display, while rendering
still happens once per `requestAnimationFrame` — on a 144 Hz monitor the extra
frames redraw the same state (DOOM's own `D_Display()` is skipped when nothing
changed, so this is nearly free), and on a slow machine the tics catch up in
batches of at most five to avoid a death spiral. Hiding the tab resets the
accumulator, so coming back after an hour does not replay an hour of gameplay.

## 4. Video

`i_video.c` composes each frame into `I_VideoBuffer` (8-bit palette indices) and
`I_FinishUpdate()` converts it — through the palette, honouring `-gfxmode` — into
`DG_ScreenBuffer`, which this build declares as 640×400 of 32-bit words in
`0xAABBGGRR` order. In memory that is bytes `R, G, B, A` with alpha unused.

The natural thing to do would be a canvas `putImageData`. Instead the renderer
takes that memory *as it is* and uploads it:

```js
gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 640, 400, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
```

Because `DG_ScreenBuffer` lives in the WebAssembly linear memory, and a
`Uint8Array` view over it is valid until the memory grows, the browser can read
it directly — zero copies beyond the one the driver does, no colour conversion in
JavaScript, no per-pixel loop. The canvas is sized to the largest integer
multiple that fits, `image-rendering: pixelated` keeps the pixels square, and
the shader is a full-screen triangle generated from `gl_VertexID` (so there are
no vertex buffers to manage). A Canvas2D fallback exists for browsers without
WebGL2.

## 5. Input

DOOM was written for a DOS keyboard and speaks its own key codes (`KEY_FIRE`,
`KEY_UPARROW`, `0x80+0x3b`, plain ASCII for the rest). `web/js/input.js` maps
`KeyboardEvent.code` onto those, because `code` is layout-independent — a
player on AZERTY typing "W" gets `KeyW`, not a French letter.

The engine has no mouse support in this port, so mouse turning is synthesised:
horizontal movement fills a rotation budget, and every tic the "steerer" holds
the matching arrow key down while there is budget left. That is a hack, but it
produces the correct feel — turn speed is frame-rate independent, and
`pointerlock` gives unlimited rotation. Firing and pointer lock are wired
directly.

Touch devices get an on-screen D-pad and action buttons mapped to the same key
codes, shown only when `(hover: none)` / `(pointer: coarse)` matches.

## 6. Sound

The engine's audio is a vtable (`sound_module_t` in `i_sound.h`). `i_web_sound.c`
implements it:

* **Loading.** Sound effects are DMX lumps: an 8-byte header and 8-bit unsigned
  PCM. They are validated the way Chocolate Doom does (magic `0x03 0x00`,
  length sane, > 48 samples), converted to signed 16-bit mono, and cached per
  sound id.
* **Mixing.** 16 channels, each with a position, a 16.16 fixed-point resampling
  step (from the lump's native rate to the device rate), and per-channel left/
  right gains derived from the engine's `vol`/`sep`. `dg_mix_audio(ptr, frames)`
  renders a block of interleaved stereo samples into a buffer the page allocates.
* **Limiting.** What is on the wire is not silence: measurements while the game
  plays showed peaks hitting full scale with hard clipping, so the mixer runs the
  sum through a soft limiter (linear below ~-3.4 dBFS, asymptotic to full scale
  above it) and the per-channel gain leaves headroom for several simultaneous
  sounds.

Who calls `dg_mix_audio`? An audio device, conceptually — so it is hung off the
browser's audio callback, in one of two ways:

| | AudioWorklet (preferred) | ScriptProcessor (fallback) |
|---|---|---|
| needs | `SharedArrayBuffer` → cross-origin isolation (`serve.mjs` sends COOP/COEP) | nothing |
| mixing happens on | the main thread, into a ring buffer | the main thread, inside the callback |
| playback happens on | the audio thread, draining the ring | n/a |
| benefit | game hitches cannot cause audio dropouts | works everywhere |

Back-pressure is the audio engine's job: each frame it tops the ring up to
~120 ms of queued audio and never more than 8× the quantum. If the real audio
thread stops consuming (blocked context, suspended device, exotic browser) a
watchdog notices the read counter has not moved for two seconds and hot-swaps to
the `ScriptProcessorNode` path. `tools/audio-worklet-sim.mjs` runs both paths
with a simulated audio thread: 115,200 frames rendered, 0 underruns, no clipping.

## 7. Music

Freedoom ships 41 MIDI files; the original IWADs ship MUS, the DMX "compact
MIDI". A browser has neither an OPL2 chip nor a MIDI synthesiser, so
`web/js/music.js`:

1. parses **both** formats into a flat list of timed events (the MIDI parser
   handles format 0/1, running status, tempo meta-events, program changes and a
   merged multi-track timeline — 41/41 lumps, 381,148 events, 6,628 seconds of
   music parsed in this build),
2. synthesises them with Web Audio: each General MIDI programme maps to an
   oscillator type, filter and envelope (triangle basses, square brass,
   sawtooth leads, noise-based drums), and
3. schedules with a 500 ms lookahead refreshed every 100 ms, so playback timing
   is independent of frame rate and looping songs do not drift.

The C side just forwards lumps and commands — `web_music_register`, `_play`,
`_stop`, `_volume`, `_pause`, `_is_playing` — exactly as `music_module_t`
demands.

## 8. Files: the WASI shim

Compiling for `wasm32-wasi` means the engine expects a WASI host for `fopen`,
`fread`, `fseek`, `fwrite`, `unlink`, `clock_time_get`, `random_get`, `proc_exit`
and friends. Rather than ship a full WASI runtime, `web/js/wasi.js` implements
the 40-ish calls this game actually uses, on top of a virtual filesystem that is
a `Map` of paths to `Uint8Array`s.

That choice pays off twice:

* the 27.5 MiB IWAD is decompressed in the browser and injected directly into
  the filesystem — nothing is ever written to disk, and no 27 MiB blob is
  created in the page;
* DOOM's `default.cfg` and `doomsav*.dsg` files are plain buffers, so
  `savedata.js` mirrors them into `localStorage` and restores them on the next
  visit. Save/load in the menus just works.

Getting this right needed one non-obvious detail: wasi-libc registers *preopened
directories* by scanning file descriptors from 3 upwards until one answers
`EBADF`. If the preopen is missing, `open()` fails with `EBADF` and **never calls
`path_open` at all** — which is exactly what happened, and what the log line
`fopen(rel) -> 0 errno=8 (Bad file descriptor)` was trying to say. The shim now
registers fd 3 as the preopened root `/` and implements `fd_fdstat_get` for it,
which is what libc probes before it will open anything.

## 9. The game data

`tools/fetch-wad.mjs` documents (and repeats) how the IWAD in `web/assets/` was
obtained. The Freedoom release zip is the canonical source; when GitHub release
assets are not reachable, the same `freedoom1.wad` (byte-identical) is available
from an npm package that vendors it. The tool validates the `IWAD` magic, gzips
at level 9 and writes a sha256 next to the result.

The 2.80:1 compression ratio is what you would expect from 1990s art assets:
palette-indexed sprites and textures with large flat areas compress well, the
MIDI music much less so.

## 10. Decompiling the result

Shipping a binary blob and calling it a port is unsatisfying, so
`tools/decompile.mjs` opens it back up with [WABT](https://github.com/WebAssembly/wabt)
and [Binaryen](https://github.com/WebAssembly/binaryen):

* it decodes the module's sections by hand (types, imports, functions, memory,
  exports) to produce exact tables rather than guesses — the WAT text alone
  cannot tell you which of 388 anonymous functions is exported without this
  mapping;
* `docs/decompiled/api.md` lists all 23 imports and 18 exports with C
  signatures recovered from the type section, plus what each one is for;
* `docs/decompiled/exports.wat` prints the exported functions as WebAssembly
  text with their names restored from the export table;
* `--full` additionally dumps `doom.wat` (the entire module as text) and
  `doom.c` + `doom.h`, produced by WABT's `wasm2c`, which reconstructs the whole
  engine as C - 388 C functions, the memory helpers, and the import
  declarations. It is mechanical, unreadable C, but it compiles, and it shows
  the round trip closing:

  ```c
  /* src/doomgeneric_web.c, before the build */
  void dg_tick(void) { doomgeneric_Tick(); }

  /* docs/decompiled/doom.h, after decompiling the built module */
  /* export: 'dg_tick' */
  void w2c_doom_dg_tick(w2c_doom*);
  ```

  Those files are ~14 MB combined, so they are generated on demand and
  git-ignored rather than committed.

The interesting result of reading that output: the module contains **388
functions**, and only 18 of them are exported. The whole browser↔engine contract
is 18 functions and one 48 MiB memory. Everything else — the renderer, the
physics, the AI, the WAD parser — is sealed inside and cannot be touched by
JavaScript, which is exactly what you want from a port like this.

## 11. Measurements

Measured in Node 22 on the build machine (`tools/smoke.mjs`, `tools/*-sim.mjs`),
which shares V8 with Chrome and Firefox's JavaScriptCore is usually close behind:

| metric | value |
|---|---|
| engine module | 488,052 bytes (476 KiB), 187,732 bytes gzipped (183 KiB) |
| game data | 28,795,076 bytes → 10,278,537 gzipped (9.8 MiB) |
| first visit, total transfer | ≈ 10.0 MiB |
| instantiation | 7.9 ms |
| boot (IWAD load + first frame) | 44.8 ms |
| IWAD gunzip in the browser | 162 ms |
| one game tic (simulate, no video) | 0.72 ms — **39× real-time headroom** |
| audio mix, 1024 frames stereo | 0.028 ms (≈ 3.6% of a core when playing) |
| engine tics during the audio test | 1,382/second (needs 35) |

The 35 Hz simulation needs 28.6 ms per tic; the engine takes 0.72 ms. The
remaining budget goes to the browser: texture upload (a 1 MB blit, GPU-bound),
compositing, and the audio callback. In practice a modern laptop runs this at
the vsync rate with the CPU mostly idle.

## 12. Dead ends

Recorded so the next person does not have to rediscover them:

* **Emscripten** — unreachable in this sandbox (its binaryen/LLVM downloads come
  from `storage.googleapis.com`). Zig's `cc --target=wasm32-wasi` is a genuinely
  good substitute, and the resulting module is smaller than Emscripten's default.
* **Trying to boot the engine inside a Web Worker** — appealing for keeping the
  main thread free, but DOOM's zone allocator allocates 600 KB and the WAD cache
  wants tens of megabytes more; that is fine, but the video path then needs
  `OffscreenCanvas` + `transferControlToOffscreen`, and audio either moves to the
  worker (with `SharedArrayBuffer`, which needs the same COOP/COEP headers) or
  stays behind. It is a real option, not a free one — the current design already
  leaves the main thread ~97% idle during a frame.
* **Push-style audio** (`web_audio_submit` from wasm into a JS ring) was tried
  first and works, but it makes the engine drive the audio clock, which fights
  the tic-per-call design. Pull-style `dg_mix_audio()` is both simpler and
  keeps the audio callback in charge.
* **Patching the engine sources** — deliberately avoided. The upstream
  `doomgeneric` tree is compiled exactly as published; every platform-specific
  decision lives in `src/` and `web/`. That is what makes the GPL story clean
  (upstream corresponding source plus this repository's own sources) and what
  makes `build.sh` able to track upstream.
* **Shipping the WAD uncompressed** — 27.5 MiB versus 9.8 MiB. The decompression
  costs 162 ms and one `DecompressionStream`, and the smaller download is worth
  far more than that on any real connection.
