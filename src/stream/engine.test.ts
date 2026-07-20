import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type {
  AudioStreamIntegerOutputPresetId,
  AudioStreamInspection,
  AudioStreamNonIntegerOutputPresetId,
  AudioStreamOutput,
  AudioStreamOutputChunk,
  AudioStreamOutputSupportResult,
  AudioStreamTarget,
} from './contracts.js';
import type { PcmStreamSource } from './pcm-source.js';
import { AUDIO_TRANSCODER_VERSION } from '../package-metadata.js';
import { AUDIO_TRANSCODER_STREAM_CAPABILITIES } from './capabilities.js';
import { DEFAULT_AUDIO_TRANSCODER_STREAM_CODEC_RUNTIME } from './runtime/default.js';

const mocks = vi.hoisted(() => ({
  addSample: vi.fn(),
  audioSampleSources: [] as unknown[],
  audioSamples: [] as unknown[],
  createReporter: vi.fn(),
  createResampler: vi.fn(),
  customInspect: vi.fn(),
  customOpen: vi.fn(),
  mediaInspect: vi.fn(),
  mediaOpen: vi.fn(),
  mediaProbe: vi.fn(),
  outputCancel: vi.fn(),
  outputFinalize: vi.fn(),
  outputStart: vi.fn(),
  outputs: [] as unknown[],
  streamTargets: [] as unknown[],
  wavFormats: [] as unknown[],
}));

vi.mock('mediabunny', () => {
  class StreamTarget {
    private writeListener: ((event: { end: number }) => void) | undefined;

    constructor(
      readonly writable: WritableStream<AudioStreamOutputChunk>,
      readonly options: { chunked: boolean; chunkSize: number },
    ) {
      mocks.streamTargets.push(this);
    }

    emitWrite(end: number): void {
      this.writeListener?.({ end });
    }

    on(type: string, listener: (event: { end: number }) => void): void {
      if (type === 'write') {
        this.writeListener = listener;
      }
    }

    async write(
      data: AudioStreamOutputChunk['data'],
      position = 0,
    ): Promise<void> {
      const writer = this.writable.getWriter();
      try {
        await writer.write({ data, position, type: 'write' });
      } finally {
        writer.releaseLock();
      }
      this.emitWrite(position + data.byteLength);
    }
  }

  class WavOutputFormat {
    constructor(readonly options: { large: boolean }) {
      mocks.wavFormats.push(this);
    }
  }

  class AudioSample {
    readonly close = vi.fn();

    constructor(readonly config: Record<string, unknown>) {
      mocks.audioSamples.push(this);
    }
  }

  class AudioSampleSource {
    readonly close = vi.fn();

    constructor(readonly options: { codec: string }) {
      mocks.audioSampleSources.push(this);
    }

    add(sample: unknown) {
      return mocks.addSample(this, sample);
    }
  }

  class Output {
    state = 'pending';
    audioSource: unknown;

    constructor(
      readonly options: { format: WavOutputFormat; target: StreamTarget },
    ) {
      mocks.outputs.push(this);
    }

    addAudioTrack(source: unknown): void {
      this.audioSource = source;
    }

    cancel() {
      return mocks.outputCancel(this);
    }

    finalize() {
      return mocks.outputFinalize(this);
    }

    start() {
      return mocks.outputStart(this);
    }
  }

  return {
    AudioSample,
    AudioSampleSource,
    Output,
    StreamTarget,
    WavOutputFormat,
  };
});

vi.mock('./pcm-blob.js', () => ({
  inspectCustomPcmBlob: mocks.customInspect,
  openCustomPcmBlobSource: mocks.customOpen,
}));

vi.mock('./media-source.js', () => ({
  inspectMediaBlob: mocks.mediaInspect,
  openMediaBlobSource: mocks.mediaOpen,
  probeMediaBlobSupport: mocks.mediaProbe,
}));

vi.mock('./resampler.js', () => ({
  createStreamingResampler: mocks.createResampler,
}));

vi.mock('./progress.js', () => ({
  createStreamProgressReporter: mocks.createReporter,
}));

import { createAudioTranscoderStreamEngine } from './engine.js';

const INPUT = { blob: new Blob(['audio']), name: 'source.caf' };
const INSPECTION: AudioStreamInspection = {
  bitDepth: 16,
  channels: 2,
  codec: 'lpcm signed integer LE',
  container: 'CAF',
  decodeSupport: 'built-in',
  durationSeconds: 1,
  notes: [],
  sampleRate: 48_000,
  size: INPUT.blob.size,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.audioSampleSources.length = 0;
  mocks.audioSamples.length = 0;
  mocks.outputs.length = 0;
  mocks.streamTargets.length = 0;
  mocks.wavFormats.length = 0;
  mocks.customInspect.mockResolvedValue(null);
  mocks.mediaInspect.mockResolvedValue(null);
  mocks.customOpen.mockResolvedValue(createSource());
  mocks.mediaOpen.mockResolvedValue(null);
  mocks.mediaProbe.mockResolvedValue(null);
  mocks.createResampler.mockResolvedValue(null);
  mocks.addSample.mockResolvedValue(undefined);
  mocks.outputStart.mockImplementation(async (output: MockOutput) => {
    output.state = 'started';
  });
  mocks.outputFinalize.mockImplementation(async (output: MockOutput) => {
    await output.options.target.write(new Uint8Array(100));
    output.state = 'finalized';
  });
  mocks.outputCancel.mockImplementation(async (output: MockOutput) => {
    output.state = 'canceled';
  });
  mocks.createReporter.mockReturnValue(createReporter());
});

describe('bounded streaming engine', () => {
  it('accepts an explicit codec runtime without changing the engine API', () => {
    const capabilities = Object.freeze({
      ...AUDIO_TRANSCODER_STREAM_CAPABILITIES,
      requiresSeekableOutput: true as const,
    });
    const engine = createAudioTranscoderStreamEngine({
      codecRuntime: {
        ...DEFAULT_AUDIO_TRANSCODER_STREAM_CODEC_RUNTIME,
        capabilities,
      },
    });

    expect(engine.getCapabilities()).toBe(capabilities);
  });

  it('keeps custom codec runtime cleanup failures secondary', async () => {
    const operationFailure = new Error('custom encoder failed');
    const cancel = vi.fn(async () => {
      throw new Error('custom cancel failed');
    });
    const engine = createAudioTranscoderStreamEngine({
      codecRuntime: {
        ...DEFAULT_AUDIO_TRANSCODER_STREAM_CODEC_RUNTIME,
        encoder: {
          id: 'custom-wasm',
          create: async () => ({
            cancel,
            finalize: vi.fn(),
            getBytesWritten: () => 0,
            start: vi.fn(),
            write: vi.fn(async () => {
              throw operationFailure;
            }),
          }),
        },
      },
    });

    await expect(
      engine.transcode(INPUT, { presetId: 'wav-pcm16' }, createOutput()),
    ).rejects.toBe(operationFailure);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('exposes package metadata and returns a custom inspection first', async () => {
    const engine = createAudioTranscoderStreamEngine();
    mocks.customInspect.mockResolvedValue(INSPECTION);

    expect(engine.getVersion()).toBe(AUDIO_TRANSCODER_VERSION);
    expect(engine.getInfo().version).toBe(AUDIO_TRANSCODER_VERSION);
    expect(engine.getCapabilities().outputPresets.map(({ id }) => id)).toEqual([
      'wav-pcm16',
      'wav-pcm24',
      'wav-pcm32',
      'wav-float32',
      'mp3-128kbps',
      'mp3-192kbps',
      'mp3-256kbps',
      'mp3-320kbps',
      'flac-16bit',
      'flac-24bit',
    ]);
    const inspection = await engine.inspect(INPUT, { inputReadBytes: 65_536 });
    expect(inspection).toEqual(INSPECTION);
    expect(inspection).not.toBe(INSPECTION);
    expect(Object.isFrozen(inspection)).toBe(true);
    expect(Object.isFrozen(inspection.notes)).toBe(true);
    expect(mocks.mediaInspect).not.toHaveBeenCalled();
  });

  it('probes one explicit output target with a tiny encode and caches the result', async () => {
    const engine = createAudioTranscoderStreamEngine();
    const target = {
      channels: 2,
      presetId: 'wav-pcm16' as const,
      sampleRate: 48_000,
    };

    const first = engine.probeOutputSupport(target);
    const second = engine.probeOutputSupport(target);

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'supported' }),
      expect.objectContaining({ status: 'supported' }),
    ] satisfies AudioStreamOutputSupportResult[]);
    await expect(engine.probeOutputSupport(target)).resolves.toMatchObject({
      code: 'SUPPORTED',
      reason: 'runtime-verified',
      status: 'supported',
    });
    expect(mocks.outputs).toHaveLength(1);
    expect(mocks.audioSamples).toHaveLength(1);
    expect(mocks.customOpen).not.toHaveBeenCalled();
    expect(mocks.mediaOpen).not.toHaveBeenCalled();
    expect(mocks.createResampler).not.toHaveBeenCalled();
  });

  it('returns static output mismatches before constructing an encoder', async () => {
    const result = await createAudioTranscoderStreamEngine().probeOutputSupport({
      channels: 2,
      presetId: 'mp3-320kbps',
      sampleRate: 24_000,
    });

    expect(result).toEqual({
      code: 'UNSUPPORTED_OUTPUT',
      message: 'Preset "mp3-320kbps" does not support 24000 Hz.',
      reason: 'sample-rate',
      status: 'unsupported-configuration',
    });
    expect(mocks.outputs).toHaveLength(0);
  });

  it('passes an operation signal into the encoder configuration', async () => {
    const controller = new AbortController();

    await expect(
      createAudioTranscoderStreamEngine().transcode(
        INPUT,
        { presetId: 'wav-pcm16' },
        createOutput(),
        { signal: controller.signal },
      ),
    ).resolves.toMatchObject({ format: 'wav' });
    expect(mocks.outputs).toHaveLength(1);
  });

  it('falls back to MediaBunny and then an immutable unknown inspection', async () => {
    const engine = createAudioTranscoderStreamEngine();
    const media = { ...INSPECTION, container: 'WAVE' };
    mocks.mediaInspect.mockResolvedValueOnce(media).mockResolvedValueOnce(null);

    const recognized = await engine.inspect(INPUT);
    expect(recognized).toEqual(media);
    expect(recognized).not.toBe(media);
    expect(Object.isFrozen(recognized.notes)).toBe(true);
    const unknown = await engine.inspect(INPUT);
    expect(unknown).toEqual({
      bitDepth: null,
      channels: null,
      codec: 'Unknown',
      container: 'Unknown',
      decodeSupport: 'unknown',
      durationSeconds: null,
      notes: ['No registered inspector recognized this file.'],
      sampleRate: null,
      size: INPUT.blob.size,
    });
    expect(Object.isFrozen(unknown)).toBe(true);
    expect(Object.isFrozen(unknown.notes)).toBe(true);
  });

  it.each(['built-in', 'likely-browser'] as const)(
    'reports %s decoder support as supported without opening a source',
    async (decodeSupport) => {
      const engine = createAudioTranscoderStreamEngine();
      const inspection = {
        ...INSPECTION,
        decodeSupport,
        notes: ['probed'],
      };
      if (decodeSupport === 'built-in') {
        mocks.customInspect.mockResolvedValue(inspection);
      } else {
        mocks.mediaProbe.mockResolvedValue(inspection);
      }

      const result = await engine.probeInputSupport(INPUT, {
        inputReadBytes: 65_536,
        pcmChunkBytes: 131_072,
      });

      expect(result).toEqual({ inspection, status: 'supported' });
      if (result.status !== 'supported') {
        throw new Error('Expected supported input result.');
      }
      expect(result.inspection).not.toBe(inspection);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.inspection)).toBe(true);
      expect(Object.isFrozen(result.inspection.notes)).toBe(true);
      expect(mocks.customOpen).not.toHaveBeenCalled();
      expect(mocks.mediaOpen).not.toHaveBeenCalled();
    },
  );

  it('distinguishes a recognized runtime decoder failure from an unknown file', async () => {
    const engine = createAudioTranscoderStreamEngine();
    const recognized = {
      ...INSPECTION,
      decodeSupport: 'browser-dependent' as const,
    };
    mocks.mediaProbe.mockResolvedValueOnce(recognized).mockResolvedValueOnce(null);

    await expect(engine.probeInputSupport(INPUT)).resolves.toEqual({
      inspection: recognized,
      status: 'recognized-unsupported',
    });
    const unsupported = await engine.probeInputSupport(INPUT);
    expect(unsupported).toEqual({ inspection: null, status: 'unsupported' });
    expect(Object.isFrozen(unsupported)).toBe(true);
  });

  it('normalizes probe cancellation and preserves non-abort adapter failures', async () => {
    const engine = createAudioTranscoderStreamEngine();
    const preAborted = new AbortController();
    preAborted.abort('already stopped');

    await expect(
      engine.probeInputSupport(INPUT, { signal: preAborted.signal }),
    ).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'already stopped',
    });
    expect(mocks.customInspect).not.toHaveBeenCalled();

    const duringProbe = new AbortController();
    mocks.customInspect.mockImplementationOnce(async () => {
      duringProbe.abort(new Error('probe stopped'));
      return INSPECTION;
    });
    await expect(
      engine.probeInputSupport(INPUT, { signal: duringProbe.signal }),
    ).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'probe stopped',
    });

    const adapterFailure = new Error('header probe failed');
    mocks.customInspect.mockRejectedValueOnce(adapterFailure);
    await expect(engine.probeInputSupport(INPUT)).rejects.toBe(adapterFailure);
  });

  it('transcodes with bounded defaults and finalizes all resources', async () => {
    const source = createSource({
      chunks: [new Float32Array([0.25, -0.25, 0.5, -0.5])],
      totalFrames: 2,
    });
    mocks.customOpen.mockResolvedValue(source);
    const engine = createAudioTranscoderStreamEngine();
    const close = vi.fn();

    const result = await engine.transcode(
      INPUT,
      { presetId: 'wav-pcm16' },
      createOutput({ close }),
    );
    const reporter = currentReporter();

    expect(result).toMatchObject({
      bytesWritten: 100,
      channels: 2,
      details: { format: 'wav', rf64: false },
      durationSeconds: 2 / 48_000,
      format: 'wav',
      rf64: false,
      sampleRate: 48_000,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.details)).toBe(true);
    expect(mocks.streamTargets[0]).toMatchObject({
      options: { chunked: true, chunkSize: 4 * 1024 * 1024 },
    });
    expect(mocks.wavFormats[0]).toMatchObject({ options: { large: false } });
    expect(mocks.audioSampleSources[0]).toMatchObject({
      options: { codec: 'pcm-s16' },
    });
    expect(sampleConfigs()).toEqual([
      expect.objectContaining({
        data: source.chunkValues[0],
        format: 'f32',
        numberOfChannels: 2,
        sampleRate: 48_000,
        timestamp: 0,
      }),
    ]);
    expect(sampleInstances()[0]?.close).toHaveBeenCalledOnce();
    expect(source.close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(reporter.report).toHaveBeenCalledWith('prepare');
    expect(reporter.report).toHaveBeenCalledWith('decode', 2 / 48_000, 1);
    expect(reporter.complete).toHaveBeenCalledOnce();
  });

  it('uses MediaBunny when no custom PCM source recognizes the input', async () => {
    const source = createSource();
    mocks.customOpen.mockResolvedValue(null);
    mocks.mediaOpen.mockResolvedValue(source);
    const engine = createAudioTranscoderStreamEngine();

    await engine.transcode(INPUT, { presetId: 'wav-pcm16' }, createOutput());

    expect(mocks.mediaOpen).toHaveBeenCalled();
    expect(source.close).toHaveBeenCalledOnce();
  });

  it('aborts the writable when no input decoder is available', async () => {
    mocks.customOpen.mockResolvedValue(null);
    mocks.mediaOpen.mockResolvedValue(null);
    const abort = vi.fn();
    const output = createOutput({ abort });

    await expect(
      createAudioTranscoderStreamEngine().transcode(
        INPUT,
        { presetId: 'wav-pcm16' },
        output,
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' });
    expect(abort).toHaveBeenCalledOnce();
  });

  it('keeps output abort failures secondary to the engine error', async () => {
    mocks.customOpen.mockResolvedValue(null);
    mocks.mediaOpen.mockResolvedValue(null);
    const output = createOutput({
      abort: vi.fn(async () => {
        throw new Error('abort failed');
      }),
    });

    await expect(
      createAudioTranscoderStreamEngine().transcode(
        INPUT,
        { presetId: 'wav-pcm16' },
        output,
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' });
  });

  it('does not abort a writable that became locked before setup failed', async () => {
    const output = createOutput();
    const writer = output.getWriter();
    mocks.customOpen.mockResolvedValue(null);
    mocks.mediaOpen.mockResolvedValue(null);

    await expect(
      createAudioTranscoderStreamEngine().transcode(
        INPUT,
        { presetId: 'wav-pcm16' },
        output,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    writer.releaseLock();
  });

  it('skips abort when setup locks the writable before failing', async () => {
    const output = createOutput();
    let writer: WritableStreamDefaultWriter<AudioStreamOutputChunk> | undefined;
    mocks.customOpen.mockImplementation(async () => {
      writer = output.getWriter();
      return null;
    });
    mocks.mediaOpen.mockResolvedValue(null);

    await expect(
      createAudioTranscoderStreamEngine().transcode(
        INPUT,
        { presetId: 'wav-pcm16' },
        output,
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' });
    writer!.releaseLock();
  });

  it('cancels a partially started output and ignores cancel failure', async () => {
    const source = createSource();
    mocks.customOpen.mockResolvedValue(source);
    const failure = new Error('start failed');
    mocks.outputStart.mockRejectedValue(failure);
    mocks.outputCancel.mockRejectedValue(new Error('cancel failed'));

    await expect(
      createAudioTranscoderStreamEngine().transcode(
        INPUT,
        { presetId: 'wav-pcm16' },
        createOutput(),
      ),
    ).rejects.toBe(failure);
    expect(mocks.outputCancel).toHaveBeenCalledOnce();
    expect(source.close).toHaveBeenCalledOnce();
  });

  it.each(['canceled', 'finalized'] as const)(
    'does not cancel an already %s output after a decoder error',
    async (state) => {
      const failure = new Error('decode failed');
      const source = createSource({
        chunksFactory: async function* () {
          outputInstances()[0]!.state = state;
          throw failure;
        },
      });
      mocks.customOpen.mockResolvedValue(source);

      await expect(
        createAudioTranscoderStreamEngine().transcode(
          INPUT,
          { presetId: 'wav-pcm16' },
          createOutput(),
        ),
      ).rejects.toBe(failure);
      expect(mocks.outputCancel).not.toHaveBeenCalled();
      expect(source.close).toHaveBeenCalledOnce();
    },
  );

  it('closes AudioSample and cancels output when encoding fails', async () => {
    const failure = new Error('encode failed');
    const abort = vi.fn(async () => {
      throw new Error('destination abort failed');
    });
    mocks.addSample.mockRejectedValue(failure);
    const source = createSource();
    mocks.customOpen.mockResolvedValue(source);

    await expect(
      createAudioTranscoderStreamEngine().transcode(
        INPUT,
        { presetId: 'wav-pcm16' },
        createOutput({ abort }),
      ),
    ).rejects.toBe(failure);
    expect(sampleInstances()[0]?.close).toHaveBeenCalledOnce();
    expect(mocks.outputCancel).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledWith(failure);
    expect(source.close).toHaveBeenCalledOnce();
  });

  it('rejects incomplete decoder frames before channel conversion', async () => {
    const source = createSource({ chunks: [new Float32Array([0, 1, 2])] });
    mocks.customOpen.mockResolvedValue(source);

    await expect(
      createAudioTranscoderStreamEngine().transcode(
        INPUT,
        { presetId: 'wav-pcm16' },
        createOutput(),
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_AUDIO_DATA',
      message: expect.stringContaining('complete interleaved frames'),
    });
  });

  it('rejects sources that produce no output frames', async () => {
    const source = createSource({ chunks: [new Float32Array()] });
    mocks.customOpen.mockResolvedValue(source);

    await expect(
      createAudioTranscoderStreamEngine().transcode(
        INPUT,
        { presetId: 'wav-pcm16' },
        createOutput(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_AUDIO_DATA' });
  });

  it('streams resampler chunks and its exact tail before closing WASM state', async () => {
    const source = createSource({
      chunks: [new Float32Array([1, -1, 0.5, -0.5])],
      sampleRate: 96_000,
      totalFrames: 2,
    });
    const resampler = {
      close: vi.fn(),
      flush: vi.fn(function* () {
        yield new Float32Array([0.125, -0.125]);
      }),
      process: vi.fn(function* () {
        yield new Float32Array();
        yield new Float32Array([0.25, -0.25]);
      }),
    };
    mocks.customOpen.mockResolvedValue(source);
    mocks.createResampler.mockResolvedValue(resampler);
    mocks.outputFinalize.mockImplementationOnce(async (output: MockOutput) => {
      expect(source.close).toHaveBeenCalledOnce();
      expect(resampler.close).toHaveBeenCalledOnce();
      output.options.target.emitWrite(100);
      output.state = 'finalized';
    });

    const result = await createAudioTranscoderStreamEngine().transcode(
      INPUT,
      { presetId: 'wav-pcm16', resampleQuality: 'best', sampleRate: 48_000 },
      createOutput(),
    );

    expect(mocks.createResampler).toHaveBeenCalledWith(2, 96_000, 48_000, 'best');
    expect(sampleConfigs().map(({ timestamp }) => timestamp)).toEqual([
      0,
      1 / 48_000,
    ]);
    expect(result.durationSeconds).toBe(2 / 48_000);
    expect(resampler.flush).toHaveBeenCalledWith(2);
    expect(resampler.close).toHaveBeenCalledOnce();
  });

  it('passes 384 kHz through without creating resampler state', async () => {
    mocks.customOpen.mockResolvedValue(
      createSource({ sampleRate: 384_000, totalFrames: 2 }),
    );

    const result = await createAudioTranscoderStreamEngine().transcode(
      INPUT,
      { presetId: 'wav-pcm24' },
      createOutput(),
    );

    expect(result.sampleRate).toBe(384_000);
    expect(mocks.createResampler).not.toHaveBeenCalled();
  });

  it.each([
    [384_000, 192_000],
    [192_000, 384_000],
  ])('rejects resampling outside the 192 kHz converter range: %s -> %s', async (sourceRate, targetRate) => {
    mocks.customOpen.mockResolvedValue(createSource({ sampleRate: sourceRate }));

    await expect(
      createAudioTranscoderStreamEngine().transcode(
        INPUT,
        { presetId: 'wav-pcm16', sampleRate: targetRate },
        createOutput(),
      ),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_OUTPUT',
      message:
        'Sample-rate conversion supports source and target rates from 8000 to 192000.',
    });
    expect(mocks.createResampler).not.toHaveBeenCalled();
  });

  it.each([
    [1, 2, [0.25, 0.25, -0.5, -0.5]],
    [2, 1, [0, 0]],
  ] as const)('mixes %i channels to %i', async (sourceChannels, targetChannels, expected) => {
    const values =
      sourceChannels === 1
        ? new Float32Array([0.25, -0.5])
        : new Float32Array([1, -1, 0.5, -0.5]);
    const source = createSource({
      channels: sourceChannels,
      chunks: [values],
      totalFrames: 2,
    });
    mocks.customOpen.mockResolvedValue(source);

    await createAudioTranscoderStreamEngine().transcode(
      INPUT,
      { channels: targetChannels, presetId: 'wav-pcm16' },
      createOutput(),
    );

    expect([...(sampleConfigs()[0]!.data as Float32Array)]).toEqual(expected);
  });

  it.each([
    ['wav-pcm24', 'pcm-s24'],
    ['wav-pcm32', 'pcm-s32'],
    ['wav-float32', 'pcm-f32'],
  ] as const)('selects streaming preset %s', async (presetId, codec) => {
    await createAudioTranscoderStreamEngine().transcode(
      INPUT,
      { presetId },
      createOutput(),
    );
    expect(mocks.audioSampleSources[0]).toMatchObject({ options: { codec } });
  });

  it.each([
    [{ presetId: 'missing' }, 'UNSUPPORTED_OUTPUT'],
    [{ presetId: 'wav-pcm16', sampleRate: 7_999 }, 'UNSUPPORTED_OUTPUT'],
    [{ presetId: 'wav-pcm16', sampleRate: 384_001 }, 'UNSUPPORTED_OUTPUT'],
    [{ presetId: 'wav-pcm16', sampleRate: 44_100.5 }, 'INVALID_CONFIGURATION'],
    [{ channels: 0, presetId: 'wav-pcm16' }, 'UNSUPPORTED_OUTPUT'],
    [{ channels: 33, presetId: 'wav-pcm16' }, 'UNSUPPORTED_OUTPUT'],
    [{ channels: 1.5, presetId: 'wav-pcm16' }, 'INVALID_CONFIGURATION'],
    [{ dither: 'bad', presetId: 'wav-pcm16' }, 'INVALID_CONFIGURATION'],
    [{ presetId: 'wav-pcm16', resampleQuality: 'bad' }, 'INVALID_CONFIGURATION'],
    [{ presetId: 'wav-pcm16', wavContainer: 'bad' }, 'INVALID_CONFIGURATION'],
  ] as const)('rejects invalid target %#', async (target, code) => {
    await expect(
      createAudioTranscoderStreamEngine().transcode(
        INPUT,
        target as AudioStreamTarget,
        createOutput(),
      ),
    ).rejects.toMatchObject({ code });
  });

  it('reports exact per-preset target constraints', async () => {
    await expect(
      createAudioTranscoderStreamEngine().transcode(
        INPUT,
        { channels: 3, presetId: 'mp3-128kbps' },
        createOutput(),
      ),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_OUTPUT',
      message: 'Preset "mp3-128kbps" supports output channels from 1 to 2.',
    });
    await expect(
      createAudioTranscoderStreamEngine().transcode(
        INPUT,
        { presetId: 'mp3-128kbps', sampleRate: 96_000 },
        createOutput(),
      ),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_OUTPUT',
      message:
        'Preset "mp3-128kbps" supports output sampleRate one of 16000, 22050, 24000, 32000, 44100, 48000.',
    });
  });

  it.each(['mp3-128kbps', 'wav-float32'] as const)(
    'rejects explicit TPDF for non-integer preset %s',
    async (presetId) => {
      await expect(
        createAudioTranscoderStreamEngine().transcode(
          INPUT,
          { dither: 'tpdf', presetId } as unknown as AudioStreamTarget,
          createOutput(),
        ),
      ).rejects.toMatchObject({
        code: 'INVALID_CONFIGURATION',
        message: `tpdf dither requires an integer lossless output; "${presetId}" is not integer lossless.`,
      });
    },
  );

  it('rejects WAV-only options for non-WAV presets', async () => {
    await expect(
      createAudioTranscoderStreamEngine().transcode(
        INPUT,
        {
          presetId: 'mp3-128kbps',
          wavContainer: 'rf64',
        } as unknown as AudioStreamTarget,
        createOutput(),
      ),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_OUTPUT',
      message:
        'wavContainer is only valid for WAV presets; "mp3-128kbps" outputs mp3.',
    });
  });

  it('omits WAV-only result state for non-WAV output', async () => {
    const createEncoder = vi.fn(async () => ({
      cancel: async () => undefined,
      finalize: async () => undefined,
      getBytesWritten: () => 12,
      start: async () => undefined,
      write: async () => undefined,
    }));
    const engine = createAudioTranscoderStreamEngine({
      codecRuntime: {
        ...DEFAULT_AUDIO_TRANSCODER_STREAM_CODEC_RUNTIME,
        encoder: { create: createEncoder, id: 'test-output' },
      },
    });

    const result = await engine.transcode(
      INPUT,
      { presetId: 'mp3-128kbps' },
      createOutput(),
    );

    expect(result).toMatchObject({
      bytesWritten: 12,
      details: { format: 'mp3' },
      format: 'mp3',
    });
    expect('rf64' in result).toBe(false);
    expect(Object.isFrozen(result.details)).toBe(true);
    expect(createEncoder).toHaveBeenCalledWith(
      expect.objectContaining({ rf64: false }),
    );
  });

  it('types explicit TPDF only for integer lossless preset IDs', () => {
    expectTypeOf<AudioStreamIntegerOutputPresetId>().toEqualTypeOf<
      | 'flac-16bit'
      | 'flac-24bit'
      | 'wav-pcm16'
      | 'wav-pcm24'
      | 'wav-pcm32'
    >();
    expectTypeOf<AudioStreamNonIntegerOutputPresetId>().toEqualTypeOf<
      | 'mp3-128kbps'
      | 'mp3-192kbps'
      | 'mp3-256kbps'
      | 'mp3-320kbps'
      | 'wav-float32'
    >();
    const integerTarget = {
      dither: 'tpdf',
      presetId: 'flac-24bit',
    } satisfies AudioStreamTarget;
    const lossyTarget = {
      dither: 'auto',
      presetId: 'mp3-128kbps',
    } satisfies AudioStreamTarget;
    // @ts-expect-error TPDF is invalid for lossy output.
    const invalidLossy: AudioStreamTarget = {
      dither: 'tpdf',
      presetId: 'mp3-128kbps',
    };
    // @ts-expect-error TPDF is invalid for float output.
    const invalidFloat: AudioStreamTarget = {
      dither: 'tpdf',
      presetId: 'wav-float32',
    };
    expect([integerTarget, lossyTarget, invalidLossy, invalidFloat]).toHaveLength(4);
  });

  it('rejects a missing target and unsupported multichannel conversion', async () => {
    await expect(
      createAudioTranscoderStreamEngine().transcode(
        INPUT,
        null as unknown as AudioStreamTarget,
        createOutput(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });

    mocks.customOpen.mockResolvedValue(createSource({ channels: 3 }));
    await expect(
      createAudioTranscoderStreamEngine().transcode(
        INPUT,
        { channels: 2, presetId: 'wav-pcm16' },
        createOutput(),
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OUTPUT' });
  });

  it.each([
    [{ channels: 0 }, 'channels'],
    [{ channels: 1.5 }, 'channels'],
    [{ channels: 33 }, 'channels'],
    [{ sampleRate: 7_999 }, 'sample rate'],
    [{ sampleRate: 48_000.5 }, 'sample rate'],
    [{ sampleRate: 384_001 }, 'sample rate'],
    [{ totalFrames: -1 }, 'frames'],
    [{ totalFrames: 1.5 }, 'frames'],
    [{ durationSeconds: -1 }, 'duration'],
    [{ durationSeconds: Number.POSITIVE_INFINITY }, 'duration'],
  ] as const)('rejects invalid source %#', async (overrides, _label) => {
    mocks.customOpen.mockResolvedValue(createSource(overrides));
    await expect(
      createAudioTranscoderStreamEngine().transcode(
        INPUT,
        { presetId: 'wav-pcm16' },
        createOutput(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_AUDIO_DATA' });
  });

  it('selects RIFF and RF64 from explicit and estimated sizes', async () => {
    const engine = createAudioTranscoderStreamEngine();
    const explicitRf64 = await engine.transcode(
      INPUT,
      { presetId: 'wav-pcm16', wavContainer: 'rf64' },
      createOutput(),
    );
    expect(explicitRf64.rf64).toBe(true);

    const explicitRiff = await engine.transcode(
      INPUT,
      { presetId: 'wav-pcm16', wavContainer: 'riff' },
      createOutput(),
    );
    expect(explicitRiff.rf64).toBe(false);

    mocks.customOpen.mockResolvedValue(
      createSource({ channels: 1, totalFrames: 0xffff_ff00 / 2 }),
    );
    const estimated = await engine.transcode(
      INPUT,
      { presetId: 'wav-pcm16' },
      createOutput(),
    );
    expect(estimated.rf64).toBe(true);
  });

  it('uses duration estimates and RF64 for unknown frame counts', async () => {
    const engine = createAudioTranscoderStreamEngine();
    mocks.customOpen.mockResolvedValue(
      createSource({
        channels: 1,
        durationSeconds: 0xffff_ff00 / 2 / 48_000,
        totalFrames: null,
      }),
    );
    await expect(
      engine.transcode(INPUT, { presetId: 'wav-pcm16' }, createOutput()),
    ).resolves.toMatchObject({ rf64: true });

    mocks.customOpen.mockResolvedValue(
      createSource({ durationSeconds: null, totalFrames: null }),
    );
    await expect(
      engine.transcode(
        INPUT,
        { presetId: 'wav-pcm16' },
        createOutput(),
      ),
    ).resolves.toMatchObject({ rf64: true });
  });

  it('rejects forced RIFF when the predicted PCM exceeds 4 GiB', async () => {
    mocks.customOpen.mockResolvedValue(
      createSource({ channels: 1, totalFrames: 0xffff_ff00 / 2 }),
    );
    await expect(
      createAudioTranscoderStreamEngine().transcode(
        INPUT,
        { presetId: 'wav-pcm16', wavContainer: 'riff' },
        createOutput(),
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OUTPUT' });
  });

  it.each([
    ['auto high-depth', { bitDepth: 32 }, { presetId: 'wav-pcm16' }],
    ['auto unknown-depth', { bitDepth: null }, { presetId: 'wav-pcm16' }],
    ['forced', { bitDepth: 16 }, { dither: 'tpdf', presetId: 'wav-pcm24' }],
  ] as const)('applies deterministic TPDF dither: %s', async (_label, sourceOptions, target) => {
    const source = createSource({
      ...sourceOptions,
      chunks: [new Float32Array([0, 0])],
    });
    mocks.customOpen.mockResolvedValue(source);
    await createAudioTranscoderStreamEngine().transcode(
      INPUT,
      target as AudioStreamTarget,
      createOutput(),
    );
    expect([...(sampleConfigs()[0]!.data as Float32Array)]).not.toEqual([0, 0]);
  });

  it.each([
    ['none', { bitDepth: 32 }, { dither: 'none', presetId: 'wav-pcm16' }],
    ['same depth', { bitDepth: 16 }, { presetId: 'wav-pcm16' }],
    ['float output', { bitDepth: 64 }, { presetId: 'wav-float32' }],
  ] as const)('does not dither when policy says %s', async (_label, sourceOptions, target) => {
    const source = createSource({
      ...sourceOptions,
      chunks: [new Float32Array([0, 0])],
    });
    mocks.customOpen.mockResolvedValue(source);
    await createAudioTranscoderStreamEngine().transcode(
      INPUT,
      target as AudioStreamTarget,
      createOutput(),
    );
    expect([...(sampleConfigs()[0]!.data as Float32Array)]).toEqual([0, 0]);
  });

  it('seeds dither without a file name and avoids the zero PRNG state', async () => {
    mocks.customOpen.mockResolvedValue(
      createSource({ chunks: [new Float32Array([0, 0])] }),
    );
    const engine = createAudioTranscoderStreamEngine();

    await engine.transcode(
      { blob: INPUT.blob },
      { dither: 'tpdf', presetId: 'wav-pcm16' },
      createOutput(),
    );
    expect([...(sampleConfigs()[0]!.data as Float32Array)]).not.toEqual([0, 0]);

    mocks.customOpen.mockResolvedValue(
      createSource({ chunks: [new Float32Array([0, 0])] }),
    );
    const zeroHashName = String.fromCharCode(6_377, 12_155);
    await engine.transcode(
      { blob: INPUT.blob, name: zeroHashName },
      { dither: 'tpdf', presetId: 'wav-pcm16' },
      createOutput(),
    );
    expect([...(sampleConfigs()[1]!.data as Float32Array)]).not.toEqual([0, 0]);
  });

  it.each([
    undefined,
    { blob: new Blob() },
    { blob: 'not a Blob' },
  ])('rejects invalid streaming input %#', async (input) => {
    await expect(
      createAudioTranscoderStreamEngine().inspect(input as never),
    ).rejects.toMatchObject({ code: 'INVALID_AUDIO_DATA' });
  });

  it('rejects non-stream and locked outputs', async () => {
    const engine = createAudioTranscoderStreamEngine();
    await expect(
      engine.transcode(INPUT, { presetId: 'wav-pcm16' }, {} as AudioStreamOutput),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });

    const output = createOutput();
    const writer = output.getWriter();
    await expect(
      engine.transcode(INPUT, { presetId: 'wav-pcm16' }, output),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    writer.releaseLock();
  });

  it.each([0, 65_535, 65_536.5, 64 * 1024 * 1024 + 1])(
    'rejects invalid input read bytes %s',
    async (inputReadBytes) => {
      await expect(
        createAudioTranscoderStreamEngine().inspect(INPUT, { inputReadBytes }),
      ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    },
  );

  it.each([0, 65_535, 65_536.5, 64 * 1024 * 1024 + 1])(
    'rejects invalid output chunk bytes %s',
    async (outputChunkBytes) => {
      await expect(
        createAudioTranscoderStreamEngine().transcode(
          INPUT,
          { presetId: 'wav-pcm16' },
          createOutput(),
          { outputChunkBytes },
        ),
      ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    },
  );

  it.each([0, 65_535, 65_536.5, 64 * 1024 * 1024 + 1])(
    'rejects invalid PCM chunk bytes %s',
    async (pcmChunkBytes) => {
      await expect(
        createAudioTranscoderStreamEngine().transcode(
          INPUT,
          { presetId: 'wav-pcm16' },
          createOutput(),
          { pcmChunkBytes },
        ),
      ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    },
  );
});

interface SourceOptions {
  readonly bitDepth?: number | null;
  readonly channels?: number;
  readonly chunks?: readonly Float32Array[];
  readonly chunksFactory?: () => AsyncGenerator<Float32Array, void, unknown>;
  readonly durationSeconds?: number | null;
  readonly sampleRate?: number;
  readonly totalFrames?: number | null;
}

function createSource(options: SourceOptions = {}): PcmStreamSource & {
  readonly chunkValues: readonly Float32Array[];
  readonly close: ReturnType<typeof vi.fn>;
} {
  const channels = options.channels ?? 2;
  const chunkValues = options.chunks ?? [new Float32Array([0, 0])];
  const chunksFactory = options.chunksFactory ?? (async function* () {
    for (const chunk of chunkValues) {
      yield chunk;
    }
  });
  const sampleRate = options.sampleRate ?? 48_000;
  const totalFrames = options.totalFrames === undefined ? 1 : options.totalFrames;
  const close = vi.fn((): void => undefined);
  return {
    channels,
    chunkValues,
    chunks: vi.fn(chunksFactory),
    close,
    durationSeconds:
      options.durationSeconds === undefined ? 1 : options.durationSeconds,
    inspection: {
      bitDepth: options.bitDepth === undefined ? 16 : options.bitDepth,
      channels,
      codec: 'test',
      container: 'test',
      decodeSupport: 'built-in',
      durationSeconds: 1,
      notes: [],
      sampleRate,
      size: INPUT.blob.size,
    },
    sampleRate,
    totalFrames,
  };
}

function createReporter() {
  return {
    complete: vi.fn(),
    report: vi.fn(),
    throwIfAborted: vi.fn(),
  };
}

function currentReporter(): ReturnType<typeof createReporter> {
  return mocks.createReporter.mock.results.at(-1)?.value as ReturnType<
    typeof createReporter
  >;
}

function createOutput(
  sink: UnderlyingSink<AudioStreamOutputChunk> = {},
): AudioStreamOutput {
  return new WritableStream<AudioStreamOutputChunk>(sink);
}

interface MockStreamTarget {
  emitWrite(end: number): void;
  write(
    data: AudioStreamOutputChunk['data'],
    position?: number,
  ): Promise<void>;
}

interface MockOutput {
  readonly options: { readonly target: MockStreamTarget };
  state: string;
}

interface MockAudioSample {
  readonly close: ReturnType<typeof vi.fn>;
  readonly config: Record<string, unknown>;
}

function outputInstances(): MockOutput[] {
  return mocks.outputs as MockOutput[];
}

function sampleInstances(): MockAudioSample[] {
  return mocks.audioSamples as MockAudioSample[];
}

function sampleConfigs(): Record<string, unknown>[] {
  return sampleInstances().map(({ config }) => config);
}
