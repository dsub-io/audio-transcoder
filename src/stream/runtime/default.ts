import type {
  AudioStreamInputAdapter,
  AudioTranscoderStreamCodecRuntime,
} from './contracts.js';
import { MEDIABUNNY_WAV_ENCODER_ADAPTER } from './mediabunny-encoder.js';
import { AUDIO_TRANSCODER_STREAM_CAPABILITIES } from '../capabilities.js';
import {
  inspectCustomPcmBlob,
  openCustomPcmBlobSource,
} from '../pcm-blob.js';
import {
  inspectMediaBlob,
  openMediaBlobSource,
  probeMediaBlobSupport,
} from '../media-source.js';
import { createStreamingResampler } from '../resampler.js';
import { DEFAULT_AUDIO_STREAM_CODEC_RUNTIME_IDS } from './ids.js';

const BUILT_IN_PCM_INPUT_ADAPTER = Object.freeze<AudioStreamInputAdapter>({
  id: DEFAULT_AUDIO_STREAM_CODEC_RUNTIME_IDS.inputAdapters[0],
  inspect: (input, context) => inspectCustomPcmBlob(input, context.signal),
  open: (input, context) =>
    openCustomPcmBlobSource(
      input,
      context.inputReadBytes,
      context.pcmChunkBytes,
      context.signal,
    ),
});

const MEDIABUNNY_INPUT_ADAPTER = Object.freeze<AudioStreamInputAdapter>({
  id: DEFAULT_AUDIO_STREAM_CODEC_RUNTIME_IDS.inputAdapters[1],
  inspect: (input, context) =>
    inspectMediaBlob(input, context.inputReadBytes, context.signal),
  open: (input, context) =>
    openMediaBlobSource(
      input,
      context.inputReadBytes,
      context.pcmChunkBytes,
      context.signal,
    ),
  probe: (input, context) =>
    probeMediaBlobSupport(input, context.inputReadBytes, context.signal),
});

const LIBSAMPLERATE_ADAPTER = Object.freeze({
  id: DEFAULT_AUDIO_STREAM_CODEC_RUNTIME_IDS.resamplerAdapter,
  create: createStreamingResampler,
});

export const DEFAULT_AUDIO_TRANSCODER_STREAM_CODEC_RUNTIME: AudioTranscoderStreamCodecRuntime =
  Object.freeze({
    capabilities: AUDIO_TRANSCODER_STREAM_CAPABILITIES,
    encoder: MEDIABUNNY_WAV_ENCODER_ADAPTER,
    inputs: Object.freeze([
      BUILT_IN_PCM_INPUT_ADAPTER,
      MEDIABUNNY_INPUT_ADAPTER,
    ]),
    resampler: LIBSAMPLERATE_ADAPTER,
  });
