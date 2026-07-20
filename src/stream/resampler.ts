import type { AudioResampleQuality } from './contracts.js';
import { AudioTranscoderError } from '../errors.js';

interface SampleRateConverter {
  destroy(): void;
  full(
    input: Float32Array,
    output?: Float32Array | null,
    outputLength?: { frames: number } | null,
  ): Float32Array;
}

const CONVERTER_TYPES: Readonly<Record<AudioResampleQuality, 0 | 1 | 2>> =
  Object.freeze({
    balanced: 1,
    best: 0,
    fast: 2,
  });
const FLUSH_FRAMES = 16_384;
const MAX_INPUT_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_PASS_THROUGH_RATE = 384_000;
const MAX_RESAMPLE_RATE = 192_000;
const MIN_RESAMPLE_RATE = 8_000;
const FLOAT_BYTES = Float32Array.BYTES_PER_ELEMENT;

export interface StreamingResampler {
  /** Idempotently releases converter and WASM memory. */
  close(): void;
  /** Produces the final expected frames; yielded views must not be retained. */
  flush(totalInputFrames: number): Iterable<Float32Array>;
  /** Converts interleaved PCM; yielded views may be reused by the next call. */
  process(input: Float32Array): Iterable<Float32Array>;
}

export async function createStreamingResampler(
  channels: number,
  inputSampleRate: number,
  outputSampleRate: number,
  quality: AudioResampleQuality,
): Promise<StreamingResampler | null> {
  if (inputSampleRate === outputSampleRate) {
    validatePassThroughRate(inputSampleRate);
    return null;
  }
  validateResampleRate(inputSampleRate, 'inputSampleRate');
  validateResampleRate(outputSampleRate, 'outputSampleRate');

  const converter = await createSampleRateConverter(
    channels,
    inputSampleRate,
    outputSampleRate,
    quality,
  );
  const ratio = outputSampleRate / inputSampleRate;
  let closed = false;
  let producedFrames = 0;
  let outputBuffer = new Float32Array(0);
  const maxInputFramesByInput = Math.max(
    1,
    Math.floor(MAX_INPUT_BUFFER_BYTES / FLOAT_BYTES / channels),
  );
  const maxOutputSamples = Math.floor(MAX_OUTPUT_BUFFER_BYTES / FLOAT_BYTES);
  const maxInputFramesByOutput = Math.max(
    1,
    Math.floor((maxOutputSamples - channels) / (channels * ratio)),
  );
  const maxInputFrames = Math.min(
    maxInputFramesByInput,
    maxInputFramesByOutput,
  );

  const processChunk = (input: Float32Array): Float32Array => {
    const requiredSamples = Math.ceil(input.length * ratio) + channels;
    if (outputBuffer.length < requiredSamples) {
      outputBuffer = new Float32Array(requiredSamples);
    }
    const outputLength = { frames: 0 };
    converter.full(input, outputBuffer, outputLength);
    producedFrames += outputLength.frames;
    return outputBuffer.subarray(0, outputLength.frames * channels);
  };

  const process = function* (input: Float32Array): Iterable<Float32Array> {
    if (closed) {
      throw new AudioTranscoderError(
        'INVALID_CONFIGURATION',
        'The streaming resampler is already closed.',
      );
    }
    if (input.length % channels !== 0) {
      throw new AudioTranscoderError(
        'INVALID_AUDIO_DATA',
        'Interleaved resampler input must contain complete frames.',
      );
    }

    const inputFrames = input.length / channels;
    for (
      let startFrame = 0;
      startFrame < inputFrames;
      startFrame += maxInputFrames
    ) {
      const frames = Math.min(maxInputFrames, inputFrames - startFrame);
      const converted = processChunk(
        input.subarray(
          startFrame * channels,
          (startFrame + frames) * channels,
        ),
      );
      if (converted.length > 0) {
        yield converted;
      }
    }
  };

  return {
    close(): void {
      if (!closed) {
        converter.destroy();
        closed = true;
        outputBuffer = new Float32Array(0);
      }
    },
    *flush(totalInputFrames: number): Iterable<Float32Array> {
      if (closed) {
        throw new AudioTranscoderError(
          'INVALID_CONFIGURATION',
          'The streaming resampler is already closed.',
        );
      }
      if (!Number.isSafeInteger(totalInputFrames) || totalInputFrames < 0) {
        throw new AudioTranscoderError(
          'INVALID_AUDIO_DATA',
          'totalInputFrames must be a non-negative safe integer.',
        );
      }
      const expectedFrames = Math.floor(totalInputFrames * ratio);
      const requiredFrames = expectedFrames - producedFrames;
      if (requiredFrames <= 0) {
        return;
      }

      const flushBudgetFrames = Math.max(
        FLUSH_FRAMES,
        Math.ceil(requiredFrames / ratio) + 1,
      );
      let consumedZeroFrames = 0;
      let flushedFrames = 0;
      while (
        flushedFrames < requiredFrames &&
        consumedZeroFrames < flushBudgetFrames
      ) {
        const zeroFrames = Math.min(
          maxInputFrames,
          flushBudgetFrames - consumedZeroFrames,
        );
        consumedZeroFrames += zeroFrames;
        const flushed = processChunk(new Float32Array(zeroFrames * channels));
        const availableFrames = Math.min(
          flushed.length / channels,
          requiredFrames - flushedFrames,
        );
        if (availableFrames > 0) {
          flushedFrames += availableFrames;
          yield flushed.subarray(0, availableFrames * channels);
        }
      }
      if (flushedFrames < requiredFrames) {
        throw new AudioTranscoderError(
          'INVALID_AUDIO_DATA',
          'The sample-rate converter did not flush the expected audio tail.',
        );
      }
      producedFrames = expectedFrames;
    },
    process,
  };
}

async function createSampleRateConverter(
  channels: number,
  inputSampleRate: number,
  outputSampleRate: number,
  quality: AudioResampleQuality,
): Promise<SampleRateConverter> {
  try {
    const { default: LibSampleRate } = await import(
      '@alexanderolsen/libsamplerate-js'
    );
    return (await LibSampleRate.create(
      channels,
      inputSampleRate,
      outputSampleRate,
      { converterType: CONVERTER_TYPES[quality] },
    )) as SampleRateConverter;
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new AudioTranscoderError(
      'WORKER_FAILURE',
      `Failed to initialize the bundled sample-rate converter: ${reason}`,
    );
  }
}

function validatePassThroughRate(sampleRate: number): void {
  if (
    !Number.isSafeInteger(sampleRate) ||
    sampleRate < MIN_RESAMPLE_RATE ||
    sampleRate > MAX_PASS_THROUGH_RATE
  ) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      `Equal sample rates must be an integer from ${MIN_RESAMPLE_RATE} to ${MAX_PASS_THROUGH_RATE}.`,
    );
  }
}

function validateResampleRate(sampleRate: number, name: string): void {
  if (
    !Number.isSafeInteger(sampleRate) ||
    sampleRate < MIN_RESAMPLE_RATE ||
    sampleRate > MAX_RESAMPLE_RATE
  ) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      `${name} must be an integer from ${MIN_RESAMPLE_RATE} to ${MAX_RESAMPLE_RATE} when resampling.`,
    );
  }
}
