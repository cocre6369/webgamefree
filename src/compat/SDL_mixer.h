//
// SDL_mixer.h - stub header for the WebAssembly build.
//
// i_sound.c includes <SDL_mixer.h> under FEATURE_SOUND, but the browser build
// does not use SDL at all: the sound and music modules live in i_web_sound.c.
// Nothing from this header is referenced, it only has to exist so the engine
// can be compiled with FEATURE_SOUND enabled.
//
#ifndef WEB_DOOM_SDL_MIXER_STUB_H
#define WEB_DOOM_SDL_MIXER_STUB_H

#define MIX_MAX_VOLUME 128

#endif
