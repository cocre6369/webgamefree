//
// i_web_sound.c
//
// Sound and music back end for the browser.
//
// The engine talks to its platform through two vtables declared in i_sound.h
// (sound_module_t / music_module_t) and picked up by i_sound.c when
// FEATURE_SOUND is defined.  This file implements them:
//
//   * DG_sound_module - a small mixing desk.  Sound effects are DMX format
//     lumps in the IWAD: an 8 byte header followed by 8 bit unsigned PCM.
//     Chocolate Doom's rule for DMX quirks is followed (skip the first and
//     last 16 bytes of sample data), the samples are converted to signed 16
//     bit mono and cached, and the mixer resamples and pans them into an
//     interleaved stereo buffer at the host's sample rate.
//
//     The browser pulls audio: JavaScript owns the audio device and calls the
//     exported dg_mix_audio() from its audio callback.
//
//   * DG_music_module - hands the MUS lumps to JavaScript, where music.js
//     plays them through the Web Audio API (there is no OPL2 chip in a
//     browser, so the JS side is a small software synth).
//

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

#include "doomtype.h"
#include "deh_str.h"
#include "i_sound.h"
#include "i_system.h"
#include "m_argv.h"
#include "m_misc.h"
#include "sounds.h"
#include "w_wad.h"
#include "z_zone.h"

#define WEB_IMPORT(name) __attribute__((import_module("env"), import_name(name)))

// JavaScript side of the music player (see web/js/music.js).
WEB_IMPORT("web_music_register") extern int web_music_register(const void* data, int len);
WEB_IMPORT("web_music_unregister") extern void web_music_unregister(int handle);
WEB_IMPORT("web_music_play") extern void web_music_play(int handle, int looping);
WEB_IMPORT("web_music_stop") extern void web_music_stop(void);
WEB_IMPORT("web_music_volume") extern void web_music_volume(int volume);
WEB_IMPORT("web_music_pause") extern void web_music_pause(int paused);
WEB_IMPORT("web_music_is_playing") extern int web_music_is_playing(void);

#define WEB_CHANNELS 16

typedef struct
{
    int16_t* samples; // mono, signed 16 bit, native lump rate
    uint32_t length; // number of samples
    uint32_t rate; // native sample rate (usually 11025)
    uint32_t refcount; // channels currently using it
} web_sfx_t;

typedef struct
{
    web_sfx_t* sfx;
    uint32_t position; // 16.16 fixed point playback position
    uint32_t step; // 16.16 fixed point increment per output sample
    float gain_left;
    float gain_right;
    boolean active;
} web_channel_t;

static web_channel_t s_channels[WEB_CHANNELS];
static web_sfx_t* s_cache[NUMSFX]; // one entry per engine sound id
static boolean s_use_sfx_prefix = true;
static boolean s_initialised = false;
static uint32_t s_output_rate = 44100;
static float s_master_volume = 1.0f;

// ---------------------------------------------------------------------------
// Sample cache
// ---------------------------------------------------------------------------

// Convert one DMX sound lump to signed 16 bit mono.  Returns NULL if the lump
// is not a usable sound (the same validation Chocolate Doom's SDL backend does).
static web_sfx_t* ConvertLump(int lumpnum)
{
    byte* data;
    unsigned int lumplen;
    uint32_t samplerate;
    uint32_t length;
    web_sfx_t* sfx;
    uint32_t i;

    if (lumpnum < 0 || lumpnum >= numlumps)
    {
        return NULL;
    }

    data = W_CacheLumpNum(lumpnum, PU_STATIC);
    lumplen = W_LumpLength(lumpnum);

    if (lumplen < 8 || data[0] != 0x03 || data[1] != 0x00)
    {
        W_ReleaseLumpNum(lumpnum);
        return NULL;
    }

    samplerate = (uint32_t)((data[3] << 8) | data[2]);
    length = (uint32_t)((data[7] << 24) | (data[6] << 16) | (data[5] << 8) | data[4]);

    if (length > lumplen - 8 || length <= 48 || samplerate == 0)
    {
        W_ReleaseLumpNum(lumpnum);
        return NULL;
    }

    // DMX skips the first and the last 16 bytes of the data block.
    data += 16;
    length -= 32;

    sfx = malloc(sizeof(web_sfx_t));
    if (sfx == NULL)
    {
        W_ReleaseLumpNum(lumpnum);
        return NULL;
    }

    sfx->samples = malloc(length * sizeof(int16_t));
    if (sfx->samples == NULL)
    {
        free(sfx);
        W_ReleaseLumpNum(lumpnum);
        return NULL;
    }

    // 8 bit unsigned PCM -> signed 16 bit
    for (i = 0; i < length; ++i)
    {
        sfx->samples[i] = (int16_t)(((int)data[8 + i] - 128) << 8);
    }

    sfx->length = length;
    sfx->rate = samplerate;
    sfx->refcount = 0;

    W_ReleaseLumpNum(lumpnum);
    return sfx;
}

static web_sfx_t* CacheSfx(sfxinfo_t* sfxinfo)
{
    char namebuf[9];
    int lumpnum;
    web_sfx_t* sfx;

    if (sfxinfo->driver_data != NULL)
    {
        return (web_sfx_t*)sfxinfo->driver_data;
    }

    if (sfxinfo->lumpnum < 0)
    {
        sfxinfo_t* linked = sfxinfo->link != NULL ? sfxinfo->link : sfxinfo;
        if (s_use_sfx_prefix)
        {
            M_snprintf(namebuf, sizeof(namebuf), "ds%s", DEH_String(linked->name));
        }
        else
        {
            M_StringCopy(namebuf, DEH_String(linked->name), sizeof(namebuf));
        }
        lumpnum = W_CheckNumForName(namebuf);
        if (lumpnum < 0)
        {
            return NULL;
        }
        sfxinfo->lumpnum = lumpnum;
    }

    sfx = ConvertLump(sfxinfo->lumpnum);
    if (sfx == NULL)
    {
        return NULL;
    }

    sfxinfo->driver_data = sfx;
    return sfx;
}

// ---------------------------------------------------------------------------
// Mixer
// ---------------------------------------------------------------------------

static void SetChannelParams(int channel, int vol, int sep)
{
    web_channel_t* ch = &s_channels[channel];
    float left = (float)((254 - sep) * vol) / 127.0f; // 0..255, SDL_mixer style
    float right = (float)(sep * vol) / 127.0f;

    if (left < 0)
        left = 0;
    if (left > 255)
        left = 255;
    if (right < 0)
        right = 0;
    if (right > 255)
        right = 255;

    // A centred sound at full volume sits at 0.6 of full scale, which leaves
    // the DOS-style headroom for several sounds playing at once.
    ch->gain_left = (left / 255.0f) * 1.2f * s_master_volume;
    ch->gain_right = (right / 255.0f) * 1.2f * s_master_volume;
}

static void ClearChannel(int channel)
{
    web_channel_t* ch = &s_channels[channel];

    if (ch->active && ch->sfx != NULL && ch->sfx->refcount > 0)
    {
        ch->sfx->refcount--;
    }

    ch->sfx = NULL;
    ch->position = 0;
    ch->active = false;
    ch->gain_left = 0.0f;
    ch->gain_right = 0.0f;
}

// Soft limiter: linear below the knee, then asymptotic towards full scale.
// Keeps loud moments (a rocket plus three imps) from turning into hard
// clipping noise.
static int32_t SoftClip(int32_t value)
{
    const int32_t knee = 22000;
    const int32_t range = 32767 - knee;
    int32_t sign = 1;
    int32_t magnitude = value;
    int32_t distance;
    int32_t limited;

    if (magnitude < 0)
    {
        sign = -1;
        magnitude = -magnitude;
    }
    if (magnitude <= knee)
    {
        return value;
    }

    distance = magnitude - knee;
    limited = knee + (distance * range) / (distance + range);

    return sign * limited;
}

// Mix interleaved stereo signed 16 bit samples.  Exported to JavaScript and
// called from the audio callback.
void dg_mix_audio(int16_t* out, int frames)
{
    int i, c;

    for (i = 0; i < frames; ++i)
    {
        int32_t left = 0;
        int32_t right = 0;

        for (c = 0; c < WEB_CHANNELS; ++c)
        {
            web_channel_t* ch = &s_channels[c];

            if (!ch->active || ch->sfx == NULL)
            {
                continue;
            }

            uint32_t index = ch->position >> 16;
            if (index >= ch->sfx->length)
            {
                ClearChannel(c);
                continue;
            }

            int32_t value = ch->sfx->samples[index];
            left += (int32_t)(value * ch->gain_left);
            right += (int32_t)(value * ch->gain_right);

            ch->position += ch->step;
            if ((ch->position >> 16) >= ch->sfx->length)
            {
                ClearChannel(c);
            }
        }

        out[i * 2 + 0] = (int16_t)SoftClip(left);
        out[i * 2 + 1] = (int16_t)SoftClip(right);
    }
}

uint32_t dg_audio_rate(void)
{
    return s_output_rate;
}

void dg_audio_init(uint32_t rate)
{
    s_output_rate = rate;
}

// ---------------------------------------------------------------------------
// sound_module_t
// ---------------------------------------------------------------------------

static snddevice_t web_sound_devices[] = {
    SNDDEVICE_SB,
};

static boolean I_WEB_InitSound(boolean use_sfx_prefix)
{
    int i;

    s_use_sfx_prefix = use_sfx_prefix;

    for (i = 0; i < WEB_CHANNELS; ++i)
    {
        ClearChannel(i);
    }
    memset(s_cache, 0, sizeof(s_cache));

    if (snd_samplerate > 0)
    {
        s_output_rate = (uint32_t)snd_samplerate;
    }

    s_initialised = true;
    return true;
}

static void I_WEB_ShutdownSound(void)
{
    int i;

    for (i = 0; i < WEB_CHANNELS; ++i)
    {
        ClearChannel(i);
    }

    for (i = 0; i < NUMSFX; ++i)
    {
        if (s_cache[i] != NULL)
        {
            free(s_cache[i]->samples);
            free(s_cache[i]);
            s_cache[i] = NULL;
        }
    }

    s_initialised = false;
}

static int I_WEB_GetSfxLumpNum(sfxinfo_t* sfxinfo)
{
    char namebuf[9];
    sfxinfo_t* linked = sfxinfo;

    if (sfxinfo->link != NULL)
    {
        linked = sfxinfo->link;
    }

    if (s_use_sfx_prefix)
    {
        M_snprintf(namebuf, sizeof(namebuf), "ds%s", DEH_String(linked->name));
    }
    else
    {
        M_StringCopy(namebuf, DEH_String(linked->name), sizeof(namebuf));
    }

    return W_GetNumForName(namebuf);
}

static void I_WEB_UpdateSound(void)
{
    int i;

    // Retire channels whose sound has finished.
    for (i = 0; i < WEB_CHANNELS; ++i)
    {
        web_channel_t* ch = &s_channels[i];

        if (ch->active && ch->sfx != NULL && (ch->position >> 16) >= ch->sfx->length)
        {
            ClearChannel(i);
        }
    }
}

static void I_WEB_UpdateSoundParams(int channel, int vol, int sep)
{
    if (!s_initialised || channel < 0 || channel >= WEB_CHANNELS)
    {
        return;
    }

    SetChannelParams(channel, vol, sep);
}

static int I_WEB_StartSound(sfxinfo_t* sfxinfo, int channel, int vol, int sep)
{
    web_channel_t* ch;
    web_sfx_t* sfx;

    if (!s_initialised || channel < 0 || channel >= WEB_CHANNELS)
    {
        return -1;
    }

    sfx = CacheSfx(sfxinfo);
    if (sfx == NULL)
    {
        return -1;
    }

    ch = &s_channels[channel];
    ClearChannel(channel);

    ch->sfx = sfx;
    ch->position = 0;
    ch->active = true;
    // 16.16 fixed point resampling step: native rate -> output rate.
    ch->step = (uint32_t)(((uint64_t)sfx->rate << 16) / s_output_rate);
    if (ch->step == 0)
    {
        ch->step = 1;
    }

    sfx->refcount++;
    SetChannelParams(channel, vol, sep);

    return channel;
}

static void I_WEB_StopSound(int channel)
{
    if (!s_initialised || channel < 0 || channel >= WEB_CHANNELS)
    {
        return;
    }

    ClearChannel(channel);
}

static boolean I_WEB_SoundIsPlaying(int channel)
{
    if (!s_initialised || channel < 0 || channel >= WEB_CHANNELS)
    {
        return false;
    }

    web_channel_t* ch = &s_channels[channel];
    return ch->active && ch->sfx != NULL && (ch->position >> 16) < ch->sfx->length;
}

static void I_WEB_CacheSounds(sfxinfo_t* sounds, int num_sounds)
{
    int i;

    for (i = 0; i < num_sounds && i < NUMSFX; ++i)
    {
        if (sounds[i].name[0] == '\0')
        {
            continue;
        }
        s_cache[i] = CacheSfx(&sounds[i]);
    }
}

sound_module_t DG_sound_module = {
    web_sound_devices,
    arrlen(web_sound_devices),
    I_WEB_InitSound,
    I_WEB_ShutdownSound,
    I_WEB_GetSfxLumpNum,
    I_WEB_UpdateSound,
    I_WEB_UpdateSoundParams,
    I_WEB_StartSound,
    I_WEB_StopSound,
    I_WEB_SoundIsPlaying,
    I_WEB_CacheSounds,
};

// ---------------------------------------------------------------------------
// music_module_t - the browser has a synth, so hand it the MUS lump
// ---------------------------------------------------------------------------

static snddevice_t web_music_devices[] = {
    SNDDEVICE_SB,
};

static boolean I_WEB_InitMusic(void)
{
    web_music_volume(127);
    return true;
}

static void I_WEB_ShutdownMusic(void)
{
    web_music_stop();
}

static void I_WEB_SetMusicVolume(int volume)
{
    web_music_volume(volume);
}

static void I_WEB_PauseSong(void)
{
    web_music_pause(1);
}

static void I_WEB_ResumeSong(void)
{
    web_music_pause(0);
}

static void* I_WEB_RegisterSong(void* data, int len)
{
    int handle = web_music_register(data, len);
    if (handle <= 0)
    {
        return NULL;
    }
    return (void*)(intptr_t)handle;
}

static void I_WEB_UnRegisterSong(void* handle)
{
    if (handle == NULL)
    {
        return;
    }
    web_music_unregister((int)(intptr_t)handle);
}

static void I_WEB_PlaySong(void* handle, boolean looping)
{
    if (handle == NULL)
    {
        return;
    }
    web_music_play((int)(intptr_t)handle, looping ? 1 : 0);
}

static void I_WEB_StopSong(void)
{
    web_music_stop();
}

static boolean I_WEB_MusicIsPlaying(void)
{
    return web_music_is_playing() != 0;
}

static void I_WEB_PollMusic(void)
{
}

music_module_t DG_music_module = {
    web_music_devices,
    arrlen(web_music_devices),
    I_WEB_InitMusic,
    I_WEB_ShutdownMusic,
    I_WEB_SetMusicVolume,
    I_WEB_PauseSong,
    I_WEB_ResumeSong,
    I_WEB_RegisterSong,
    I_WEB_UnRegisterSong,
    I_WEB_PlaySong,
    I_WEB_StopSong,
    I_WEB_MusicIsPlaying,
    I_WEB_PollMusic,
};

// i_sound.c binds the libsamplerate options when FEATURE_SOUND is defined.
// There is no libsamplerate in this build - samples are resampled by the
// mixer in dg_mix_audio() - but the variables are referenced by the config
// loader, so they have to exist.
int use_libsamplerate = 0;
float libsamplerate_scale = 0.65f;
