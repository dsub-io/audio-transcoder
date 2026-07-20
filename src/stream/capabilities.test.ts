import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AudioStreamOutputPresetId } from './contracts.js';
import {
  AUDIO_STREAM_INPUT_FORMATS,
  AUDIO_STREAM_OUTPUT_FORMATS,
  AUDIO_TRANSCODER_STREAM_CAPABILITIES,
  type AudioStreamBuiltInOutputFormatDescriptor,
  type AudioStreamBundledWasmOutputFormatDescriptor,
  type AudioStreamInputFormatId,
  type AudioStreamLosslessOutputPresetDescriptor,
  type AudioStreamLossyOutputPresetDescriptor,
} from './capabilities.js';

describe('stream capability discovery', () => {
  it('describes installed input paths without asserting extension support', () => {
    expect(AUDIO_STREAM_INPUT_FORMATS.map(({ id, path }) => ({ id, path }))).toEqual([
      { id: 'caf-lpcm', path: 'built-in-pcm' },
      { id: 'aiff-pcm', path: 'built-in-pcm' },
      { id: 'aifc-pcm', path: 'built-in-pcm' },
      { id: 'mp4', path: 'runtime-probed' },
      { id: 'quicktime', path: 'runtime-probed' },
      { id: 'matroska', path: 'runtime-probed' },
      { id: 'webm', path: 'runtime-probed' },
      { id: 'wave', path: 'runtime-probed' },
      { id: 'ogg', path: 'runtime-probed' },
      { id: 'flac', path: 'runtime-probed' },
      { id: 'mp3', path: 'runtime-probed' },
      { id: 'adts', path: 'runtime-probed' },
      { id: 'mpeg-ts', path: 'runtime-probed' },
    ]);
    expect(AUDIO_STREAM_INPUT_FORMATS.every(Object.isFrozen)).toBe(true);
    expect(
      AUDIO_STREAM_INPUT_FORMATS.every(
        ({ extensionHints, mimeTypeHints }) =>
          Object.isFrozen(extensionHints) && Object.isFrozen(mimeTypeHints),
      ),
    ).toBe(true);
    expect(AUDIO_TRANSCODER_STREAM_CAPABILITIES.inputFormats).toBe(
      AUDIO_STREAM_INPUT_FORMATS,
    );
    expectTypeOf(AUDIO_STREAM_INPUT_FORMATS[0].id).toEqualTypeOf<'caf-lpcm'>();
    expectTypeOf<AudioStreamInputFormatId>().toEqualTypeOf<
      | 'adts'
      | 'aifc-pcm'
      | 'aiff-pcm'
      | 'caf-lpcm'
      | 'flac'
      | 'matroska'
      | 'mp3'
      | 'mp4'
      | 'mpeg-ts'
      | 'ogg'
      | 'quicktime'
      | 'wave'
      | 'webm'
    >();
  });

  it('exposes deterministic built-in and bundled-WASM outputs', () => {
    expect(
      AUDIO_STREAM_OUTPUT_FORMATS.map(
        ({ id, implementation, loading, requiresSeekableOutput }) => ({
          id,
          implementation,
          loading,
          requiresSeekableOutput,
        }),
      ),
    ).toEqual([
      {
        id: 'wav',
        implementation: 'built-in',
        loading: 'eager',
        requiresSeekableOutput: true,
      },
      {
        id: 'mp3',
        implementation: 'bundled-wasm',
        loading: 'lazy',
        requiresSeekableOutput: true,
      },
      {
        id: 'flac',
        implementation: 'bundled-wasm',
        loading: 'lazy',
        requiresSeekableOutput: true,
      },
    ]);
    expect(
      AUDIO_STREAM_OUTPUT_FORMATS[0].presets.map(
        ({ bitDepth, codec, processingPrecision }) => ({
          bitDepth,
          codec,
          processingPrecision,
        }),
      ),
    ).toEqual([
      {
        bitDepth: 16,
        codec: 'pcm-s16',
        processingPrecision: {
          effectiveIntegerPrecisionBits: 16,
          sampleFormat: 'float32',
        },
      },
      {
        bitDepth: 24,
        codec: 'pcm-s24',
        processingPrecision: {
          effectiveIntegerPrecisionBits: 24,
          sampleFormat: 'float32',
        },
      },
      {
        bitDepth: 32,
        codec: 'pcm-s32',
        processingPrecision: {
          effectiveIntegerPrecisionBits: 24,
          sampleFormat: 'float32',
        },
      },
      {
        bitDepth: 32,
        codec: 'pcm-f32',
        processingPrecision: {
          effectiveIntegerPrecisionBits: 24,
          sampleFormat: 'float32',
        },
      },
    ]);
    expect(
      AUDIO_STREAM_OUTPUT_FORMATS[1].presets.map(
        ({ bitrate, preset }) => [preset.id, bitrate],
      ),
    ).toEqual([
      ['mp3-128kbps', 128_000],
      ['mp3-192kbps', 192_000],
      ['mp3-256kbps', 256_000],
      ['mp3-320kbps', 320_000],
    ]);
    expect(
      AUDIO_STREAM_OUTPUT_FORMATS[2].presets.map(
        ({ bitDepth, preset, processingPrecision }) => [
          preset.id,
          bitDepth,
          processingPrecision.effectiveIntegerPrecisionBits,
        ],
      ),
    ).toEqual([
      ['flac-16bit', 16, 16],
      ['flac-24bit', 24, 24],
    ]);
    expect(
      AUDIO_STREAM_OUTPUT_FORMATS[1].presets.map(({ preset, target }) => ({
        presetId: preset.id,
        sampleRates: target.sampleRate.kind === 'discrete'
          ? target.sampleRate.values
          : [],
      })),
    ).toEqual([
      {
        presetId: 'mp3-128kbps',
        sampleRates: [16_000, 22_050, 24_000, 32_000, 44_100, 48_000],
      },
      { presetId: 'mp3-192kbps', sampleRates: [32_000, 44_100, 48_000] },
      { presetId: 'mp3-256kbps', sampleRates: [32_000, 44_100, 48_000] },
      { presetId: 'mp3-320kbps', sampleRates: [32_000, 44_100, 48_000] },
    ]);
    expect(AUDIO_STREAM_OUTPUT_FORMATS[2].presets[0].target).toEqual({
      channels: { maximum: 8, minimum: 1 },
      sampleRate: {
        kind: 'discrete',
        values: [8_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000, 88_200, 96_000, 176_400, 192_000],
      },
    });
    expect(Object.isFrozen(AUDIO_STREAM_OUTPUT_FORMATS)).toBe(true);
    for (const format of AUDIO_STREAM_OUTPUT_FORMATS) {
      expect(Object.isFrozen(format)).toBe(true);
      for (const preset of format.presets) {
        expect(Object.isFrozen(preset)).toBe(true);
        expect(Object.isFrozen(preset.target)).toBe(true);
        expect(Object.isFrozen(preset.target.channels)).toBe(true);
        expect(Object.isFrozen(preset.target.sampleRate)).toBe(true);
        if (preset.target.sampleRate.kind === 'discrete') {
          expect(Object.isFrozen(preset.target.sampleRate.values)).toBe(true);
        }
        if (preset.kind === 'lossless') {
          expect(Object.isFrozen(preset.processingPrecision)).toBe(true);
        }
      }
    }
    expect(AUDIO_TRANSCODER_STREAM_CAPABILITIES.outputFormats).toBe(
      AUDIO_STREAM_OUTPUT_FORMATS,
    );
    expect(AUDIO_TRANSCODER_STREAM_CAPABILITIES.requiresSeekableOutput).toBe(
      true,
    );
    expectTypeOf(
      AUDIO_TRANSCODER_STREAM_CAPABILITIES.outputPresets[0]!.id,
    ).toEqualTypeOf<AudioStreamOutputPresetId>();
    expectTypeOf(
      AUDIO_STREAM_OUTPUT_FORMATS[0].presets[0].preset.id,
    ).toEqualTypeOf<'wav-pcm16'>();
    expectTypeOf(
      AUDIO_STREAM_OUTPUT_FORMATS[1].presets[0].preset.id,
    ).toEqualTypeOf<'mp3-128kbps'>();
    expectTypeOf(
      AUDIO_STREAM_OUTPUT_FORMATS[2].presets[0].preset.id,
    ).toEqualTypeOf<'flac-16bit'>();
    expectTypeOf<
      AudioStreamBuiltInOutputFormatDescriptor['loading']
    >().toEqualTypeOf<'eager'>();
    expectTypeOf<
      AudioStreamBundledWasmOutputFormatDescriptor['loading']
    >().toEqualTypeOf<'lazy'>();
    expectTypeOf<
      AudioStreamLosslessOutputPresetDescriptor['bitDepth']
    >().toEqualTypeOf<number>();
    expectTypeOf<
      AudioStreamLossyOutputPresetDescriptor['bitrate']
    >().toEqualTypeOf<number>();
  });

  it('separates source pass-through, resampling, queue, and concurrency limits', () => {
    expect(AUDIO_TRANSCODER_STREAM_CAPABILITIES.limits).toMatchObject({
      maximumConcurrency: 4,
      queue: { defaultMaximumQueued: 8, maximumQueued: 64 },
      recommendedConcurrency: 1,
      sampleRate: {
        maximum: 384_000,
        minimum: 8_000,
        passThrough: { maximum: 384_000, minimum: 8_000 },
        resampling: { maximum: 192_000, minimum: 8_000 },
      },
    });
    expect(Object.isFrozen(AUDIO_TRANSCODER_STREAM_CAPABILITIES.limits.queue)).toBe(
      true,
    );
    expect(
      Object.isFrozen(
        AUDIO_TRANSCODER_STREAM_CAPABILITIES.limits.sampleRate.passThrough,
      ),
    ).toBe(true);
    expect(
      Object.isFrozen(
        AUDIO_TRANSCODER_STREAM_CAPABILITIES.limits.sampleRate.resampling,
      ),
    ).toBe(true);
  });
});
