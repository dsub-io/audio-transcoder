/*
 * Minimal dsub bridge for libsamplerate's stateful sinc API.
 *
 * libsamplerate is BSD-2-Clause licensed. The exact source revision and build
 * recipe are recorded in libsamplerate-PROVENANCE.md.
 */

#include <limits.h>
#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

#include "samplerate.h"

#ifndef DSUB_CONVERTER_TYPE
#error "DSUB_CONVERTER_TYPE must select exactly one libsamplerate sinc converter"
#endif

#define DSUB_MAX_CHANNELS 32
#define DSUB_MIN_RATIO (1.0 / 256.0)
#define DSUB_MAX_RATIO 256.0

typedef struct
{
	SRC_STATE *state ;
	float *input ;
	float *output ;
	int input_capacity_samples ;
	int output_capacity_samples ;
	int channels ;
	double ratio ;
	int last_input_frames_used ;
	int last_output_frames_gen ;
} DSUB_RESAMPLER ;

static int last_create_error = 0 ;

static int
resize_samples (float **buffer, int *capacity, int frames, int channels)
{
	if (frames < 0 || channels < 1 || frames > INT_MAX / channels)
		return -1 ;

	int samples = frames * channels ;
	if (samples <= *capacity)
		return 0 ;
	if ((size_t) samples > SIZE_MAX / sizeof (float))
		return -1 ;

	float *replacement = (float *) malloc ((size_t) samples * sizeof (float)) ;
	if (replacement == NULL)
		return -1 ;

	free (*buffer) ;
	*buffer = replacement ;
	*capacity = samples ;
	return 0 ;
}

DSUB_RESAMPLER *
dsub_resampler_create (int channels, double ratio)
{
	last_create_error = 0 ;
	if (channels < 1 || channels > DSUB_MAX_CHANNELS || !isfinite (ratio)
			|| ratio < DSUB_MIN_RATIO || ratio > DSUB_MAX_RATIO)
	{
		last_create_error = -1 ;
		return NULL ;
	}

	DSUB_RESAMPLER *resampler = (DSUB_RESAMPLER *) calloc (1, sizeof (*resampler)) ;
	if (resampler == NULL)
	{
		last_create_error = -1 ;
		return NULL ;
	}

	int error = 0 ;
	resampler->state = src_new (DSUB_CONVERTER_TYPE, channels, &error) ;
	if (resampler->state == NULL || error != 0)
	{
		last_create_error = error == 0 ? -1 : error ;
		free (resampler) ;
		return NULL ;
	}

	resampler->channels = channels ;
	resampler->ratio = ratio ;
	return resampler ;
}

int
dsub_resampler_last_create_error (void)
{
	return last_create_error ;
}

int
dsub_resampler_prepare (DSUB_RESAMPLER *resampler, int input_frames, int output_frames)
{
	if (resampler == NULL)
		return -1 ;
	if (resize_samples (&resampler->input, &resampler->input_capacity_samples,
			input_frames, resampler->channels) != 0)
		return -1 ;
	if (resize_samples (&resampler->output, &resampler->output_capacity_samples,
			output_frames, resampler->channels) != 0)
		return -1 ;
	return 0 ;
}

float *
dsub_resampler_input (DSUB_RESAMPLER *resampler)
{
	return resampler == NULL ? NULL : resampler->input ;
}

float *
dsub_resampler_output (DSUB_RESAMPLER *resampler)
{
	return resampler == NULL ? NULL : resampler->output ;
}

int
dsub_resampler_process (DSUB_RESAMPLER *resampler, int input_frames,
		int output_frames, int end_of_input)
{
	if (resampler == NULL || input_frames < 0 || output_frames < 0)
		return -1 ;
	if (input_frames > 0 && resampler->input == NULL)
		return -1 ;
	if (output_frames > 0 && resampler->output == NULL)
		return -1 ;

	SRC_DATA data = {
		.data_in = resampler->input,
		.data_out = resampler->output,
		.input_frames = input_frames,
		.output_frames = output_frames,
		.input_frames_used = 0,
		.output_frames_gen = 0,
		.end_of_input = end_of_input == 0 ? 0 : 1,
		.src_ratio = resampler->ratio,
	} ;
	int error = src_process (resampler->state, &data) ;
	resampler->last_input_frames_used = (int) data.input_frames_used ;
	resampler->last_output_frames_gen = (int) data.output_frames_gen ;
	return error ;
}

int
dsub_resampler_input_frames_used (DSUB_RESAMPLER *resampler)
{
	return resampler == NULL ? 0 : resampler->last_input_frames_used ;
}

int
dsub_resampler_output_frames_gen (DSUB_RESAMPLER *resampler)
{
	return resampler == NULL ? 0 : resampler->last_output_frames_gen ;
}

void
dsub_resampler_destroy (DSUB_RESAMPLER *resampler)
{
	if (resampler == NULL)
		return ;
	resampler->state = src_delete (resampler->state) ;
	free (resampler->input) ;
	free (resampler->output) ;
	free (resampler) ;
}
