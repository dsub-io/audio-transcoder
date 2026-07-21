/*
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Adapted for dsub's raw-WASM ABI from MediaBunny's LAME bridge at commit
 * 794b84884f1e23cb6241689b3563190d138bbd9a.
 */

#include <limits.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <lame.h>

#if defined(__GNUC__)
#define DSUB_EXPORT __attribute__((used, visibility("default")))
#else
#define DSUB_EXPORT
#endif

#define DSUB_MP3_ABI_VERSION 1
#define DSUB_MP3_ERROR_BAD_ARGUMENT -1000
#define DSUB_MP3_ERROR_ALLOCATION -1001
#define DSUB_MP3_ERROR_BAD_STATE -1002

typedef struct {
  lame_global_flags *lame;
  short *pcm;
  size_t pcm_capacity_bytes;
  unsigned char *output;
  size_t output_capacity_bytes;
  int channels;
  int sample_rate;
  int bitrate;
} DsubMp3Encoder;

static int dsub_last_create_error = 0;

static int dsub_is_supported_configuration(
    int channels, int sample_rate, int bitrate) {
  int supported_sample_rate =
      sample_rate == 16000 || sample_rate == 22050 || sample_rate == 24000 ||
      sample_rate == 32000 || sample_rate == 44100 || sample_rate == 48000;
  int supported_bitrate = bitrate == 128000 || bitrate == 192000 ||
                          bitrate == 256000 || bitrate == 320000;
  return (channels == 1 || channels == 2) && supported_sample_rate &&
         supported_bitrate && (bitrate == 128000 || sample_rate >= 32000);
}

static int dsub_init_lame(DsubMp3Encoder *state) {
  int error;
  lame_global_flags *lame = lame_init();
  if (lame == NULL) return DSUB_MP3_ERROR_ALLOCATION;

#define DSUB_LAME_SET(call)       \
  do {                            \
    error = (call);               \
    if (error < 0) goto fail;     \
  } while (0)

  DSUB_LAME_SET(lame_set_num_channels(lame, state->channels));
  DSUB_LAME_SET(lame_set_in_samplerate(lame, state->sample_rate));
  DSUB_LAME_SET(lame_set_out_samplerate(lame, state->sample_rate));
  DSUB_LAME_SET(lame_set_brate(lame, state->bitrate / 1000));
  DSUB_LAME_SET(lame_set_bWriteVbrTag(lame, 0));

#undef DSUB_LAME_SET

  error = lame_init_params(lame);
  if (error < 0) goto fail;
  state->lame = lame;
  return 0;

fail:
  lame_close(lame);
  return error;
}

static int dsub_grow_buffer(
    void **buffer, size_t *capacity, size_t required) {
  void *next;
  if (required <= *capacity) return 0;
  next = realloc(*buffer, required);
  if (next == NULL) return DSUB_MP3_ERROR_ALLOCATION;
  *buffer = next;
  *capacity = required;
  return 0;
}

DSUB_EXPORT int dsub_mp3_abi_version(void) {
  return DSUB_MP3_ABI_VERSION;
}

DSUB_EXPORT uintptr_t dsub_mp3_create(
    int channels, int sample_rate, int bitrate) {
  DsubMp3Encoder *state;
  int error;
  dsub_last_create_error = 0;
  if (!dsub_is_supported_configuration(channels, sample_rate, bitrate)) {
    dsub_last_create_error = DSUB_MP3_ERROR_BAD_ARGUMENT;
    return 0;
  }

  state = (DsubMp3Encoder *)calloc(1, sizeof(*state));
  if (state == NULL) {
    dsub_last_create_error = DSUB_MP3_ERROR_ALLOCATION;
    return 0;
  }
  state->channels = channels;
  state->sample_rate = sample_rate;
  state->bitrate = bitrate;
  error = dsub_init_lame(state);
  if (error < 0) {
    dsub_last_create_error = error;
    free(state);
    return 0;
  }
  return (uintptr_t)state;
}

DSUB_EXPORT int dsub_mp3_last_create_error(void) {
  return dsub_last_create_error;
}

DSUB_EXPORT uintptr_t dsub_mp3_prepare_pcm(
    uintptr_t handle, int frames) {
  DsubMp3Encoder *state = (DsubMp3Encoder *)handle;
  size_t required;
  int error;
  if (state == NULL || state->lame == NULL || frames <= 0) return 0;
  if ((size_t)frames > SIZE_MAX / (sizeof(short) * (size_t)state->channels)) {
    return 0;
  }
  required = (size_t)frames * (size_t)state->channels * sizeof(short);
  error = dsub_grow_buffer(
      (void **)&state->pcm, &state->pcm_capacity_bytes, required);
  return error < 0 ? 0 : (uintptr_t)state->pcm;
}

DSUB_EXPORT int dsub_mp3_encode(uintptr_t handle, int frames) {
  DsubMp3Encoder *state = (DsubMp3Encoder *)handle;
  size_t pcm_required;
  size_t output_required;
  short *right;
  int error;
  if (state == NULL || state->lame == NULL || state->pcm == NULL ||
      frames <= 0) {
    return DSUB_MP3_ERROR_BAD_STATE;
  }
  if ((size_t)frames > SIZE_MAX / (sizeof(short) * (size_t)state->channels)) {
    return DSUB_MP3_ERROR_BAD_ARGUMENT;
  }
  pcm_required = (size_t)frames * (size_t)state->channels * sizeof(short);
  if (pcm_required > state->pcm_capacity_bytes ||
      frames > (INT_MAX - 7201) / 5 * 4) {
    return DSUB_MP3_ERROR_BAD_ARGUMENT;
  }

  output_required = (size_t)frames + ((size_t)frames + 3) / 4 + 7200;
  error = dsub_grow_buffer(
      (void **)&state->output, &state->output_capacity_bytes, output_required);
  if (error < 0) return error;

  right = state->pcm + (state->channels - 1) * frames;
  return lame_encode_buffer(
      state->lame,
      state->pcm,
      right,
      frames,
      state->output,
      (int)output_required);
}

DSUB_EXPORT int dsub_mp3_flush(uintptr_t handle) {
  DsubMp3Encoder *state = (DsubMp3Encoder *)handle;
  int error;
  if (state == NULL || state->lame == NULL) return DSUB_MP3_ERROR_BAD_STATE;
  error = dsub_grow_buffer(
      (void **)&state->output, &state->output_capacity_bytes, 7200);
  if (error < 0) return error;
  return lame_encode_flush(state->lame, state->output, 7200);
}

DSUB_EXPORT uintptr_t dsub_mp3_output(uintptr_t handle) {
  DsubMp3Encoder *state = (DsubMp3Encoder *)handle;
  return state == NULL ? 0 : (uintptr_t)state->output;
}

DSUB_EXPORT int dsub_mp3_reset(uintptr_t handle) {
  DsubMp3Encoder *state = (DsubMp3Encoder *)handle;
  if (state == NULL || state->lame == NULL) return DSUB_MP3_ERROR_BAD_STATE;
  lame_close(state->lame);
  state->lame = NULL;
  return dsub_init_lame(state);
}

DSUB_EXPORT void dsub_mp3_destroy(uintptr_t handle) {
  DsubMp3Encoder *state = (DsubMp3Encoder *)handle;
  if (state == NULL) return;
  if (state->lame != NULL) lame_close(state->lame);
  free(state->pcm);
  free(state->output);
  memset(state, 0, sizeof(*state));
  free(state);
}
