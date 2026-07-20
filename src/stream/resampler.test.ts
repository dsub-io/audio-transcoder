import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  moduleLoads: 0,
}));

vi.mock('@alexanderolsen/libsamplerate-js', () => {
  mocks.moduleLoads += 1;
  return { default: { create: mocks.create } };
});

import { createStreamingResampler } from './resampler.js';

interface ConverterStub {
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly full: ReturnType<typeof vi.fn>;
}

beforeEach(() => {
  mocks.create.mockReset();
});

describe('streaming resampler', () => {
  it('bypasses equal sample rates without allocating WASM state', async () => {
    await expect(
      createStreamingResampler(2, 384_000, 384_000, 'balanced'),
    ).resolves.toBeNull();
    expect(mocks.moduleLoads).toBe(0);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each([
    [7_999, 7_999],
    [384_001, 384_001],
    [8_000, 384_000],
    [384_000, 8_000],
    [48_000.5, 96_000],
    [48_000, 192_001],
  ])('rejects unsupported direct sample-rate pair %s -> %s', async (input, output) => {
    await expect(
      createStreamingResampler(2, input, output, 'balanced'),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each([
    ['best', 0],
    ['balanced', 1],
    ['fast', 2],
  ] as const)('maps %s quality and streams aligned frames', async (quality, converterType) => {
    const converter = createConverter({ channels: 2 });
    mocks.create.mockResolvedValue(converter);
    const resampler = await createStreamingResampler(
      2,
      48_000,
      24_000,
      quality,
    );

    expect(mocks.moduleLoads).toBe(1);
    expect(mocks.create).toHaveBeenCalledWith(2, 48_000, 24_000, {
      converterType,
    });
    const [first] = resampler!.process(new Float32Array([1, -1, 0.5, -0.5]));
    expect([...first!]).toEqual([1, -1]);
    const [second] = resampler!.process(
      new Float32Array([0.25, -0.25, 0.125, -0.125]),
    );
    expect([...second!]).toEqual([0.25, -0.25]);

    resampler!.close();
    resampler!.close();
    expect(converter.destroy).toHaveBeenCalledOnce();
    expect(() => [...resampler!.process(new Float32Array(2))]).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
    );
    expect(() => [...resampler!.flush(2)]).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
    );
  });

  it.each([new Error('WASM startup failed'), 'unknown startup failure'])(
    'normalizes converter initialization failure %s',
    async (failure) => {
      mocks.create.mockRejectedValue(failure);

      await expect(
        createStreamingResampler(2, 48_000, 44_100, 'balanced'),
      ).rejects.toMatchObject({
        code: 'WORKER_FAILURE',
        message: `Failed to initialize the bundled sample-rate converter: ${
          failure instanceof Error ? failure.message : failure
        }`,
      });
    },
  );

  it.each([-1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid flush frame count %s',
    async (totalInputFrames) => {
      const converter = createConverter({ channels: 1 });
      mocks.create.mockResolvedValue(converter);
      const resampler = await createStreamingResampler(
        1,
        48_000,
        24_000,
        'balanced',
      );

      expect(() => [...resampler!.flush(totalInputFrames)]).toThrow(
        expect.objectContaining({
          code: 'INVALID_AUDIO_DATA',
          message: 'totalInputFrames must be a non-negative safe integer.',
        }),
      );
      resampler!.close();
    },
  );

  it('rejects partial frames and flushes exactly the missing tail', async () => {
    const converter = createConverter({ channels: 2, delayedFrames: 2 });
    mocks.create.mockResolvedValue(converter);
    const resampler = await createStreamingResampler(
      2,
      48_000,
      24_000,
      'balanced',
    );

    expect(() => [...resampler!.process(new Float32Array(3))]).toThrow(
      expect.objectContaining({ code: 'INVALID_AUDIO_DATA' }),
    );
    const [first] = resampler!.process(new Float32Array(16));
    expect(first).toHaveLength(4);
    const tail = [...resampler!.flush(8)];
    expect(tail).toHaveLength(1);
    expect(tail[0]).toHaveLength(4);
    expect([...resampler!.flush(8)]).toHaveLength(0);
    resampler!.close();
  });

  it('fails if the converter cannot flush the expected tail', async () => {
    const converter = createConverter({ channels: 1, neverFlush: true });
    mocks.create.mockResolvedValue(converter);
    const resampler = await createStreamingResampler(
      1,
      48_000,
      96_000,
      'balanced',
    );

    expect([...resampler!.process(new Float32Array(4))]).toHaveLength(0);
    expect(() => [...resampler!.flush(4)]).toThrow(
      expect.objectContaining({
        code: 'INVALID_AUDIO_DATA',
        message: expect.stringContaining('flush'),
      }),
    );
    resampler!.close();
  });

  it('splits extreme upsampling so each reusable output buffer stays bounded', async () => {
    const channels = 32;
    const ratio = 24;
    const converter: ConverterStub = {
      destroy: vi.fn(),
      full: vi.fn(
        (
          input: Float32Array,
          output: Float32Array,
          outputLength: { frames: number },
        ) => {
          outputLength.frames = (input.length / channels) * ratio;
          return output;
        },
      ),
    };
    mocks.create.mockResolvedValue(converter);
    const resampler = await createStreamingResampler(
      channels,
      8_000,
      192_000,
      'balanced',
    );

    const chunks = [
      ...resampler!.process(new Float32Array(16_384 * channels)),
    ];

    expect(chunks.length).toBeGreaterThan(1);
    expect(converter.full).toHaveBeenCalledTimes(chunks.length);
    for (const [, output] of converter.full.mock.calls) {
      expect((output as Float32Array).byteLength).toBeLessThanOrEqual(
        4 * 1024 * 1024,
      );
    }
    resampler!.close();
  });

  it('bounds zero-fill input and output allocations during extreme downsampling flush', async () => {
    const channels = 1;
    const ratio = 8_000 / 192_000;
    const converter: ConverterStub = {
      destroy: vi.fn(),
      full: vi.fn(
        (
          input: Float32Array,
          output: Float32Array,
          outputLength: { frames: number },
        ) => {
          outputLength.frames = Math.ceil((input.length / channels) * ratio);
          return output;
        },
      ),
    };
    mocks.create.mockResolvedValue(converter);
    const resampler = await createStreamingResampler(
      channels,
      192_000,
      8_000,
      'balanced',
    );

    const chunks = [...resampler!.flush(2_000_000)];

    expect(chunks.length).toBeGreaterThan(1);
    expect(converter.full).toHaveBeenCalledTimes(chunks.length);
    for (const [input, output] of converter.full.mock.calls) {
      expect((input as Float32Array).byteLength).toBeLessThanOrEqual(
        4 * 1024 * 1024,
      );
      expect((output as Float32Array).byteLength).toBeLessThanOrEqual(
        4 * 1024 * 1024,
      );
    }
    resampler!.close();
  });
});

function createConverter(
  options: {
    readonly channels: number;
    readonly delayedFrames?: number;
    readonly neverFlush?: boolean;
  },
): ConverterStub {
  let call = 0;
  return {
    destroy: vi.fn(),
    full: vi.fn(
      (
        input: Float32Array,
        output: Float32Array,
        outputLength: { frames: number },
      ) => {
        call += 1;
        const channels = options.channels;
        const projected = Math.floor(input.length / channels / 2);
        const delayed = call === 1 ? (options.delayedFrames ?? 0) : 0;
        const frames = options.neverFlush
          ? 0
          : Math.max(0, projected - delayed);
        outputLength.frames = frames;
        for (let index = 0; index < frames * channels; index += 1) {
          output[index] = input[index] ?? 0;
        }
        return output;
      },
    ),
  };
}
