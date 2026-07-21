/*
 * Deterministic, bounded bridge around libopusenc's pull API.
 *
 * This file is project code. The linked Xiph libraries and their exact source
 * archives are recorded in ogg-opus-PROVENANCE.md.
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <ogg/ogg.h>
#include <opus.h>
#include <opusenc.h>

#define DSUB_OPUS_SAMPLE_RATE 48000
#define DSUB_OPUS_FRAME_SAMPLES 960
#define DSUB_OPUS_MAX_CHANNELS 2
#define DSUB_OPUS_MAX_PCM_SAMPLES \
  (DSUB_OPUS_FRAME_SAMPLES * DSUB_OPUS_MAX_CHANNELS)
#define DSUB_OGG_MAX_PAGE_BYTES (255 * 255 + 27 + 255)
#define DSUB_OGG_SERIAL ((opus_int32)0x44535542)

#define DSUB_ERROR_BAD_STATE -1000
#define DSUB_ERROR_BAD_PAGE -1001
#define DSUB_ERROR_BAD_SERIAL -1002
#define DSUB_ERROR_BAD_SEQUENCE -1003
#define DSUB_ERROR_BAD_GRANULE -1004
#define DSUB_ERROR_PAGE_TOO_LARGE -1005

#if defined(__GNUC__)
#define DSUB_EXPORT __attribute__((used, visibility("default")))
#else
#define DSUB_EXPORT
#endif

typedef struct {
  OggOpusEnc *encoder;
  float pcm[DSUB_OPUS_MAX_PCM_SAMPLES];
  unsigned char *page;
  opus_int32 page_length;
  opus_int64 frames_written;
  opus_int32 expected_page_sequence;
  int channels;
  int drained;
  int eos_seen;
  int preskip;
  int preskip_seen;
} DsubOggOpusEncoder;

static int dsub_last_create_error = OPE_OK;

static int dsub_validate_page(DsubOggOpusEncoder *state) {
  ogg_page page;
  int header_length;
  int page_sequence;
  int serial;

  if (state->page == NULL || state->page_length < 27 ||
      state->page_length > DSUB_OGG_MAX_PAGE_BYTES ||
      memcmp(state->page, "OggS", 4) != 0) {
    return state->page_length > DSUB_OGG_MAX_PAGE_BYTES
               ? DSUB_ERROR_PAGE_TOO_LARGE
               : DSUB_ERROR_BAD_PAGE;
  }

  header_length = 27 + state->page[26];
  if (header_length > state->page_length) return DSUB_ERROR_BAD_PAGE;

  page.header = state->page;
  page.header_len = header_length;
  page.body = state->page + header_length;
  page.body_len = state->page_length - header_length;

  if (ogg_page_version(&page) != 0) return DSUB_ERROR_BAD_PAGE;
  serial = ogg_page_serialno(&page);
  if ((opus_int32)serial != DSUB_OGG_SERIAL) return DSUB_ERROR_BAD_SERIAL;
  page_sequence = ogg_page_pageno(&page);
  if (page_sequence != state->expected_page_sequence) {
    return DSUB_ERROR_BAD_SEQUENCE;
  }
  state->expected_page_sequence++;

  if (page_sequence == 0) {
    const unsigned char *packet = page.body;
    if (!ogg_page_bos(&page) || page.body_len < 19 ||
        memcmp(packet, "OpusHead", 8) != 0) {
      return DSUB_ERROR_BAD_PAGE;
    }
    state->preskip = packet[10] | (packet[11] << 8);
    state->preskip_seen = 1;
  } else if (ogg_page_bos(&page)) {
    return DSUB_ERROR_BAD_PAGE;
  }

  if (ogg_page_eos(&page)) {
    const ogg_int64_t expected_granule =
        (ogg_int64_t)state->preskip + (ogg_int64_t)state->frames_written;
    if (!state->preskip_seen || state->eos_seen ||
        ogg_page_granulepos(&page) != expected_granule) {
      return DSUB_ERROR_BAD_GRANULE;
    }
    state->eos_seen = 1;
  }

  return OPE_OK;
}

DSUB_EXPORT uintptr_t dsub_ogg_opus_create(int channels, int bitrate_bps) {
  DsubOggOpusEncoder *state = NULL;
  OggOpusComments *comments = NULL;
  int error = OPE_OK;

  dsub_last_create_error = OPE_OK;
  if (channels < 1 || channels > DSUB_OPUS_MAX_CHANNELS ||
      bitrate_bps < 500 || bitrate_bps > 512000) {
    dsub_last_create_error = OPE_BAD_ARG;
    return 0;
  }

  state = (DsubOggOpusEncoder *)calloc(1, sizeof(*state));
  if (state == NULL) {
    dsub_last_create_error = OPE_ALLOC_FAIL;
    return 0;
  }
  state->channels = channels;

  comments = ope_comments_create();
  if (comments == NULL) {
    dsub_last_create_error = OPE_ALLOC_FAIL;
    free(state);
    return 0;
  }

  state->encoder = ope_encoder_create_pull(
      comments, DSUB_OPUS_SAMPLE_RATE, channels, 0, &error);
  ope_comments_destroy(comments);
  if (state->encoder == NULL) {
    dsub_last_create_error = error;
    free(state);
    return 0;
  }

#define DSUB_CTL(request)                         \
  do {                                            \
    error = ope_encoder_ctl(state->encoder, request); \
    if (error != OPE_OK) goto fail;               \
  } while (0)

  DSUB_CTL(OPE_SET_SERIALNO(DSUB_OGG_SERIAL));
  DSUB_CTL(OPE_SET_COMMENT_PADDING(0));
  DSUB_CTL(OPE_SET_DECISION_DELAY(0));
  DSUB_CTL(OPE_SET_MUXING_DELAY(DSUB_OPUS_FRAME_SAMPLES));
  DSUB_CTL(OPUS_SET_BITRATE(bitrate_bps));
  DSUB_CTL(OPUS_SET_VBR(1));
  DSUB_CTL(OPUS_SET_VBR_CONSTRAINT(0));
  DSUB_CTL(OPUS_SET_COMPLEXITY(10));
  DSUB_CTL(OPUS_SET_DTX(0));

#undef DSUB_CTL

  error = ope_encoder_flush_header(state->encoder);
  if (error != OPE_OK) goto fail;
  return (uintptr_t)state;

fail:
  dsub_last_create_error = error;
  ope_encoder_destroy(state->encoder);
  free(state);
  return 0;
}

DSUB_EXPORT int dsub_ogg_opus_last_create_error(void) {
  return dsub_last_create_error;
}

DSUB_EXPORT uintptr_t dsub_ogg_opus_pcm(uintptr_t handle) {
  DsubOggOpusEncoder *state = (DsubOggOpusEncoder *)handle;
  return state == NULL ? 0 : (uintptr_t)state->pcm;
}

DSUB_EXPORT int dsub_ogg_opus_pcm_capacity_frames(void) {
  return DSUB_OPUS_FRAME_SAMPLES;
}

DSUB_EXPORT int dsub_ogg_opus_max_page_bytes(void) {
  return DSUB_OGG_MAX_PAGE_BYTES;
}

DSUB_EXPORT int dsub_ogg_opus_write(uintptr_t handle, int frames) {
  DsubOggOpusEncoder *state = (DsubOggOpusEncoder *)handle;
  int error;
  if (state == NULL || state->encoder == NULL || state->drained || frames < 0 ||
      frames > DSUB_OPUS_FRAME_SAMPLES) {
    return DSUB_ERROR_BAD_STATE;
  }
  error = ope_encoder_write_float(state->encoder, state->pcm, frames);
  if (error == OPE_OK) state->frames_written += frames;
  return error;
}

DSUB_EXPORT int dsub_ogg_opus_drain(uintptr_t handle) {
  DsubOggOpusEncoder *state = (DsubOggOpusEncoder *)handle;
  int error;
  if (state == NULL || state->encoder == NULL || state->drained) {
    return DSUB_ERROR_BAD_STATE;
  }
  error = ope_encoder_drain(state->encoder);
  if (error == OPE_OK) state->drained = 1;
  return error;
}

DSUB_EXPORT int dsub_ogg_opus_pull_page(uintptr_t handle) {
  DsubOggOpusEncoder *state = (DsubOggOpusEncoder *)handle;
  int result;
  int validation;
  if (state == NULL || state->encoder == NULL) return DSUB_ERROR_BAD_STATE;
  state->page = NULL;
  state->page_length = 0;
  result = ope_encoder_get_page(
      state->encoder, &state->page, &state->page_length, 0);
  if (result <= 0) return result;
  validation = dsub_validate_page(state);
  return validation == OPE_OK ? 1 : validation;
}

DSUB_EXPORT uintptr_t dsub_ogg_opus_page(uintptr_t handle) {
  DsubOggOpusEncoder *state = (DsubOggOpusEncoder *)handle;
  return state == NULL ? 0 : (uintptr_t)state->page;
}

DSUB_EXPORT int dsub_ogg_opus_page_length(uintptr_t handle) {
  DsubOggOpusEncoder *state = (DsubOggOpusEncoder *)handle;
  return state == NULL ? 0 : state->page_length;
}

DSUB_EXPORT int dsub_ogg_opus_eos_seen(uintptr_t handle) {
  DsubOggOpusEncoder *state = (DsubOggOpusEncoder *)handle;
  return state == NULL ? 0 : state->eos_seen;
}

DSUB_EXPORT void dsub_ogg_opus_destroy(uintptr_t handle) {
  DsubOggOpusEncoder *state = (DsubOggOpusEncoder *)handle;
  if (state == NULL) return;
  if (state->encoder != NULL) ope_encoder_destroy(state->encoder);
  memset(state, 0, sizeof(*state));
  free(state);
}
