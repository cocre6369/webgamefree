# Third-party components and licences

This project is a *port*, so most of it is other people's work. Here is what is
inside, under which licence, and where the corresponding source lives.

## The game engine

| component | licence | source |
|---|---|---|
| DOOM engine (`web/doom.wasm` is a compiled copy) | **GPL-2.0-or-later** | <https://github.com/ozkl/doomgeneric> (compiled from the sources `build.sh` fetches) |
| id Software DOOM source release (1997) | GPL-2.0-or-later | contained in the repository above |
| Chocolate Doom / Simon Howard cleanups, mus2mid, etc. | GPL-2.0-or-later | contained in the repository above |

The engine is compiled from upstream sources *without modification*: `build.sh`
clones `ozkl/doomgeneric` into `.build/` and compiles that tree. The only files
added for this port are in `src/` (the browser platform layer) and `web/` (the
JavaScript application), all of which are licensed GPL-2.0-or-later as required
by linking with the engine. Because the WebAssembly module is a redistribution of
GPL code, the complete corresponding source is: the upstream `doomgeneric`
repository at the revision `build.sh` pins (plus the `.build/doomgeneric` tree the
build script creates), together with this repository.

## The game data

| component | licence | source |
|---|---|---|
| Freedoom Phase 1 IWAD (`web/assets/freedoom1.wad.gz`) | **BSD-3-Clause** | <https://freedoom.github.io> / <https://github.com/freedoom/freedoom> |

Freedoom is an independent, freely licensed game: all levels, sprites, textures,
sound effects and music in `freedoom1.wad` were created by the Freedoom
contributors, © 2001–2024. **No id Software assets are included in this
repository.** The full licence text ships with the data
(`web/assets/FREEDOOM-COPYING.txt`) and the contributor list is in
`web/assets/FREEDOOM-CREDITS.txt`. The IWAD itself is redistributed here
unmodified apart from gzip compression, which is permitted by clause 2 of the
BSD licence provided the copyright notice and disclaimer are retained — they
are, next to the compressed file.

## The toolchain

| component | licence | role |
|---|---|---|
| Zig 0.14.1 | MIT | the C compiler / linker (`zig cc --target=wasm32-wasi`) |
| wasi-libc | Apache-2.0 WITH LLVM-exception, MIT | C library linked into the module |
| Binaryen (`wasm-opt`) | Apache-2.0 | post-link optimisation and size reduction |
| WABT (`wasm2wat`, `wasm-objdump`) | Apache-2.0 | disassembly used by `tools/decompile.mjs` |
| Node.js | MIT | the server, the tests, the build scripts |

None of these are redistributed in this repository: `build.sh` and
`tools/fetch-wad.mjs` download them at build time into git-ignored directories
(`.tools/`, `.build/`), and `package.json`'s two dev dependencies (`binaryen`,
`wabt`) are development-time tools only.

## Trademarks

DOOM is a trademark of id Software LLC. Quake, Wolfenstein and other id
trademarks are property of their respective owners. Freedoom is a trademark of
the Freedoom project. This is an unofficial, non-commercial project, not
affiliated with, sponsored by or endorsed by id Software, Bethesda Softworks or
the Freedoom project.
