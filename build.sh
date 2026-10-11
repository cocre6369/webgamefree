#!/usr/bin/env bash
# ============================================================================
#  build.sh - compile DOOM to WebAssembly
# ============================================================================
#
#  Engine : doomgeneric (https://github.com/ozkl/doomgeneric), the id Software
#           DOOM source port with the platform layer made pluggable.
#           GPL-2.0-or-later.  See THIRD-PARTY.md.
#  Data   : Freedoom Phase 1 (https://freedoom.github.io), BSD-3-Clause.
#  Toolchain: Zig 0.14.1, which ships a full C -> wasm32 cross compiler and
#           wasi-libc.  No Emscripten, no system packages.
#
#  Steps:
#    1. fetch the toolchain into .tools/ (git-ignored, ~100 MB, once)
#    2. fetch the engine sources into .build/ (git-ignored, once)
#    3. compile every translation unit + the browser platform layer
#    4. link web/doom.wasm
#    5. optionally run wasm-opt (npx binaryen) to shrink it
#    6. optionally apply wasm2js-wasm2wat round trip for decompilation
#
#  Usage: ./build.sh [--no-opt] [--no-wad] [--clean]
# ============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLS="$HERE/.tools"
BUILD="$HERE/.build"
SDK="$BUILD/doomgeneric/doomgeneric"
OBJ="$BUILD/obj"
OUT="$HERE/web/doom.wasm"

ZIG_URL="https://files.pythonhosted.org/packages/9d/ef/494f128ea7ec3345850bbd75d2cb7b987006fb5601c37543e8fa83e5e3d4/ziglang-0.14.1-py3-none-manylinux_2_12_x86_64.manylinux2010_x86_64.musllinux_1_1_x86_64.whl"
ZIG="$TOOLS/zig/ziglang/zig"
DOOMGENERIC_REPO="https://github.com/ozkl/doomgeneric.git"

OPT=1
WAD=1
for arg in "$@"; do
    case "$arg" in
        --no-opt) OPT=0 ;;
        --no-wad) WAD=0 ;;
        --clean) rm -rf "$BUILD"; echo "cleaned $BUILD" ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

# ---------------------------------------------------------------- toolchain
if [ ! -x "$ZIG" ]; then
    echo "==> fetching the Zig 0.14.1 C toolchain (once, ~100 MB)"
    mkdir -p "$TOOLS/zig"
    curl -sSL -o "$TOOLS/zig.whl" "$ZIG_URL"
    (cd "$TOOLS/zig" && unzip -q -o "$TOOLS/zig.whl")
    chmod +x "$ZIG"
fi
"$ZIG" version >/dev/null

# ------------------------------------------------------------------ sources
if [ ! -f "$SDK/d_main.c" ]; then
    echo "==> fetching doomgeneric engine sources (once)"
    mkdir -p "$BUILD"
    git clone --depth 1 "$DOOMGENERIC_REPO" "$BUILD/doomgeneric"
fi

RESX=${DOOM_RESX:-640}
RESY=${DOOM_RESY:-400}

CFLAGS=(
    --target=wasm32-wasi
    -std=gnu99
    -O3
    -flto
    -DNDEBUG
    -DNORMALUNIX
    -D_DEFAULT_SOURCE
    -DFEATURE_SOUND
    -DDOOMGENERIC_RESX=$RESX
    -DDOOMGENERIC_RESY=$RESY
    -I"$SDK"
    -I"$HERE/src"
    -I"$HERE/src/compat"
    -Wno-implicit-function-declaration
    -Wno-int-conversion
    -Wno-incompatible-pointer-types
    -Wno-unused-value
    -Wno-parentheses
    -Wno-pointer-sign
    -Wno-format
)

LDFLAGS=(
    --target=wasm32-wasi
    -O3
    -flto
    -Wl,--no-entry
    -Wl,--export-memory
    -Wl,--initial-memory=50331648
    -Wl,--max-memory=1073741824
    -Wl,-z,stack-size=2097152
    -Wl,--gc-sections
    -Wl,--strip-debug
    -Wl,--export=__wasm_call_ctors
    -Wl,--export=dg_create
    -Wl,--export=dg_tick
    -Wl,--export=dg_framebuffer
    -Wl,--export=dg_width
    -Wl,--export=dg_height
    -Wl,--export=dg_frame_count
    -Wl,--export=dg_gametic
    -Wl,--export=dg_gamestate
    -Wl,--export=dg_sleep_ms
    -Wl,--export=dg_push_key
    -Wl,--export=dg_mix_audio
    -Wl,--export=dg_audio_rate
    -Wl,--export=dg_audio_init
    -Wl,--export=malloc
    -Wl,--export=free
)

# The engine translation units.  This is the same set the Linux/VT build uses,
# except that the platform layer (doomgeneric_linuxvt.c) is replaced by our
# own src/doomgeneric_web.c + src/i_web_sound.c.
SRC=(
    am_map.c d_event.c d_items.c d_iwad.c d_loop.c d_main.c d_mode.c d_net.c
    doomdef.c doomstat.c dstrings.c f_finale.c f_wipe.c g_game.c hu_lib.c
    hu_stuff.c info.c i_cdmus.c i_endoom.c i_joystick.c i_input.c i_scale.c
    i_sound.c i_system.c i_timer.c i_video.c memio.c m_argv.c m_bbox.c
    m_cheat.c m_config.c m_controls.c m_fixed.c m_menu.c m_misc.c m_random.c
    p_ceilng.c p_doors.c p_enemy.c p_floor.c p_inter.c p_lights.c p_map.c
    p_maputl.c p_mobj.c p_plats.c p_pspr.c p_saveg.c p_setup.c p_sight.c
    p_spec.c p_switch.c p_telept.c p_tick.c p_user.c r_bsp.c r_data.c r_draw.c
    r_main.c r_plane.c r_segs.c r_sky.c r_things.c sha1.c sounds.c statdump.c
    st_lib.c st_stuff.c s_sound.c tables.c v_video.c wi_stuff.c w_checksum.c
    w_file.c w_file_stdc.c w_main.c w_wad.c z_zone.c dummy.c mus2mid.c
    icon.c doomgeneric.c
)

mkdir -p "$OBJ"
echo "==> compiling ${#SRC[@]} engine sources + browser platform layer"

for f in "${SRC[@]}"; do
    o="$OBJ/${f%.c}.o"
    if [ ! -f "$o" ] || [ "$SDK/$f" -nt "$o" ]; then
        "$ZIG" cc "${CFLAGS[@]}" -c "$SDK/$f" -o "$o"
    fi
done

for f in "$HERE"/src/*.c; do
    o="$OBJ/$(basename "${f%.c}").o"
    if [ ! -f "$o" ] || [ "$f" -nt "$o" ]; then
        echo "    platform: $(basename "$f")"
        "$ZIG" cc "${CFLAGS[@]}" -c "$f" -o "$o"
    fi
done

echo "==> linking $OUT"
"$ZIG" cc "${LDFLAGS[@]}" "$OBJ"/*.o -o "$OUT"

# --------------------------------------------------------------- wasm-opt
if [ "$OPT" = "1" ]; then
    if command -v wasm-opt >/dev/null 2>&1; then
        WASM_OPT=wasm-opt
    elif [ -x "$HERE/node_modules/.bin/wasm-opt" ]; then
        WASM_OPT="$HERE/node_modules/.bin/wasm-opt"
    else
        WASM_OPT=""
    fi

    if [ -n "$WASM_OPT" ]; then
        echo "==> optimising with wasm-opt -O3"
        # The feature flags match what the wasi-libc / Zig output already uses
        # (bulk memory, non-trapping float to int, sign extension).
        "$WASM_OPT" -O3 \
            --enable-bulk-memory \
            --enable-nontrapping-float-to-int \
            --enable-sign-ext \
            --enable-mutable-globals \
            --enable-multivalue \
            --strip-debug "$OUT" -o "$OUT.opt"
        mv "$OUT.opt" "$OUT"
    else
        echo "    (wasm-opt not found - run 'npm install' for a smaller build)"
    fi
fi

# ------------------------------------------------------------------- WAD
if [ "$WAD" = "1" ] && [ ! -f "$HERE/web/assets/freedoom1.wad.gz" ]; then
    echo "==> WADRESSING: no gzipped IWAD in web/assets, running tools/fetch-wad.mjs"
    node "$HERE/tools/fetch-wad.mjs"
fi

# ------------------------------------------------------------------ report
RAW=$(stat -c%s "$OUT" 2>/dev/null || stat -f%z "$OUT")
GZ=$(gzip -9 -c "$OUT" | wc -c)
echo
echo "============================================================"
echo " web/doom.wasm      $(( RAW / 1024 )) KiB  ($(( GZ / 1024 )) KiB gzipped)"
if [ -f "$HERE/web/assets/freedoom1.wad.gz" ]; then
    WADRAW=$(( $(stat -c%s "$HERE/web/assets/freedoom1.wad.gz" 2>/dev/null || stat -f%z "$HERE/web/assets/freedoom1.wad.gz") / 1024 ))
    echo " freedoom1.wad.gz   $WADRAW KiB       (28795076 bytes decompressed)"
fi
echo "============================================================"
echo " next:  node serve.mjs          -> http://localhost:8000"
echo " or:    node tools/smoke.mjs    (headless test + screenshot)"
