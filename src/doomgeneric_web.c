//
// doomgeneric_web.c
//
// Web (WebAssembly / WASI) platform back end for doomgeneric.
//
// This file is the "hardware" of the port.  doomgeneric asks its platform
// layer for six things: initialisation, a frame-ready callback, a sleep
// function, a millisecond clock, a key queue and a window title setter.
// Everything below implements those against the browser instead of against
// a framebuffer device / SDL / X11:
//
//   * The video buffer is the engine's own DG_ScreenBuffer, written by
//     i_video.c as little-endian 0xAABBGGRR words (RGBA byte order with a
//     zero alpha byte).  JavaScript reads it straight out of linear memory
//     and uploads it as a GL texture, so no CPU-side conversion is needed.
//
//   * The clock is provided by JavaScript (performance.now()).  Sleeping is
//     *instantaneous*: the time that was asked for is added to a virtual
//     offset instead of blocking.  The engine's wait loops (TryRunTics,
//     d_main.c) then see time pass and return immediately, which keeps the
//     browser's main thread responsive.  Together with singletics (one game
//     tic per dg_tick() call, set in dg_create) JavaScript owns the game
//     clock completely.
//
//   * Input is a ring buffer of (pressed, doom-key) pairs filled from
//     JavaScript via dg_push_key() and drained by the engine through
//     DG_GetKey().
//
// Additionally exported for JavaScript: dg_create(), dg_tick(),
// dg_framebuffer(), dg_width(), dg_height(), dg_frame_count(),
// dg_gametic(), dg_gamestate() and dg_wad_ready().
//

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "doomgeneric.h"
#include "doomkeys.h"
#include "doomtype.h"
#include "d_loop.h"
#include "doomdef.h"
#include "doomstat.h"

// ---------------------------------------------------------------------------
// Imports from JavaScript
// ---------------------------------------------------------------------------

#define WEB_IMPORT(name) __attribute__((import_module("env"), import_name(name)))

// Milliseconds since the game was started (monotonic, fractional part
// truncated).  Supplied by JavaScript.
WEB_IMPORT("web_now_ms") extern uint32_t web_now_ms(void);

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

// d_loop.c owns the real definition; there is no header for it.
extern boolean singletics;

extern void doomgeneric_Create(int argc, char** argv);
extern void doomgeneric_Tick(void);


static uint32_t s_virtual_sleep_ms = 0;
static uint32_t s_frame_count = 0;

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

void DG_Init(void)
{
}

void DG_DrawFrame(void)
{
    // i_video.c has just finished composing the frame into DG_ScreenBuffer.
    // Bump a counter so JavaScript can tell a fresh frame from a stale one.
    s_frame_count++;
}

uint32_t* dg_framebuffer(void)
{
    return (uint32_t*)DG_ScreenBuffer;
}

int dg_width(void)
{
    return DOOMGENERIC_RESX;
}

int dg_height(void)
{
    return DOOMGENERIC_RESY;
}

uint32_t dg_frame_count(void)
{
    return s_frame_count;
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

void DG_SleepMs(uint32_t ms)
{
    // Never block the browser's main thread.  Pretend the sleep happened by
    // moving the virtual clock forward; the engine's wait loops observe the
    // passage of time and return on their next iteration.
    s_virtual_sleep_ms += ms;
}

uint32_t DG_GetTicksMs(void)
{
    return web_now_ms() + s_virtual_sleep_ms;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

#define KEY_QUEUE_SIZE 256

static uint16_t s_key_queue[KEY_QUEUE_SIZE];
static unsigned int s_key_queue_read = 0;
static unsigned int s_key_queue_write = 0;

// Called from JavaScript: pressed != 0 for key down, doomkey is one of the
// KEY_* codes from doomkeys.h.
void dg_push_key(int pressed, int doomkey)
{
    unsigned int next = (s_key_queue_write + 1) % KEY_QUEUE_SIZE;

    if (next == s_key_queue_read)
    {
        // Queue full - drop the event rather than stall the game.
        return;
    }

    s_key_queue[s_key_queue_write] = (uint16_t)(((pressed ? 1 : 0) << 8) |
                                                (doomkey & 0xFF));
    s_key_queue_write = next;
}

int DG_GetKey(int* pressed, unsigned char* doomkey)
{
    uint16_t data;

    if (s_key_queue_read == s_key_queue_write)
    {
        return 0; // queue empty
    }

    data = s_key_queue[s_key_queue_read];
    s_key_queue_read++;
    s_key_queue_read %= KEY_QUEUE_SIZE;

    *pressed = data >> 8;
    *doomkey = (unsigned char)(data & 0xFF);

    return 1;
}

void DG_SetWindowTitle(const char* title)
{
    (void)title;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

static char* s_argv[3];

// Initialise the engine.  This loads the IWAD, sets up the game and renders
// the very first frame.  Returns to JavaScript with the engine sitting in its
// "one tick per call" state.
void dg_create(void)
{
    s_argv[0] = (char*)"doom";
    s_argv[1] = (char*)"-iwad";
    s_argv[2] = (char*)"freedoom1.wad";

    doomgeneric_Create(3, s_argv);

    // From here on JavaScript drives the clock: exactly one game tic per
    // dg_tick() call.  See the comment block at the top of this file.
    singletics = 1;
}

// Run one game tic and render one frame.
void dg_tick(void)
{
    doomgeneric_Tick();
}

uint32_t dg_gametic(void)
{
    return (uint32_t)gametic;
}

int dg_gamestate(void)
{
    return (int)gamestate;
}

uint32_t dg_sleep_ms(void)
{
    return s_virtual_sleep_ms;
}

// The WASI libc startup object expects a main().  Nothing calls it - the
// browser drives the engine through dg_create()/dg_tick() - but it has to
// exist for the link to succeed.
int main(void)
{
    dg_create();
    for (;;)
    {
        dg_tick();
    }
    return 0;
}


// WASI has no shell.  The engine only calls system() for the external music
// command ("snd_musiccmd") which is unused in the browser build.
int system(const char* command)
{
    (void)command;
    return -1;
}
