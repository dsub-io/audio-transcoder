import { beforeEach, describe, expect, it, vi } from 'vitest';

interface CapturedCustomSourceOptions {
  readonly getSize: () => number;
  readonly maxCacheSize: number;
  readonly prefetchProfile: string;
  readonly read: (start: number, end: number) => Promise<Uint8Array>;
}

const mocks = vi.hoisted(() => ({
  options: [] as CapturedCustomSourceOptions[],
}));

vi.mock('mediabunny', () => ({
  CustomSource: class CustomSource {
    constructor(options: CapturedCustomSourceOptions) {
      mocks.options.push(options);
    }
  },
}));

import { createBoundedBlobSource } from './bounded-blob-source.js';

beforeEach(() => {
  mocks.options.length = 0;
});

describe('bounded MediaBunny Blob source', () => {
  it('configures the public CustomSource API without prefetching', () => {
    const blob = new Blob(['abcdef']);

    const source = createBoundedBlobSource(blob, 4);

    expect(source.constructor.name).toBe('CustomSource');
    expect(currentOptions()).toMatchObject({
      maxCacheSize: 4,
      prefetchProfile: 'none',
    });
    expect(currentOptions().getSize()).toBe(6);
  });

  it.each([
    ['non-Blob input', {} as Blob, 4],
    ['zero bound', new Blob(), 0],
    ['unsafe bound', new Blob(), 1.5],
  ] as const)('rejects invalid configuration: %s', (_label, blob, limit) => {
    expect(() => createBoundedBlobSource(blob, limit)).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
    );
    expect(mocks.options).toHaveLength(0);
  });

  it.each([0, 1.5] as const)(
    'rejects an invalid cumulative read bound: %s',
    (limit) => {
      expect(() => createBoundedBlobSource(new Blob(), 4, limit)).toThrowError(
        expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
      );
    },
  );

  it('reads exactly the requested range into one ArrayBuffer', async () => {
    createBoundedBlobSource(new Blob([new Uint8Array([10, 20, 30, 40, 50])]), 4);

    const bytes = await currentOptions().read(1, 5);
    const view = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    );

    expect([...bytes]).toEqual([20, 30, 40, 50]);
    expect(bytes.byteOffset).toBe(0);
    expect(bytes.byteLength).toBe(4);
    expect(view.buffer).toBe(bytes.buffer);
    expect(view.getUint8(2)).toBe(40);
  });

  it('rejects a single read larger than the configured bound', async () => {
    createBoundedBlobSource(new Blob(['abcdef']), 4);

    await expect(currentOptions().read(0, 5)).rejects.toMatchObject({
      code: 'INVALID_AUDIO_DATA',
      message: expect.stringContaining('per-read limit is 4 bytes'),
    });
  });

  it('enforces the cumulative read bound across source reads', async () => {
    createBoundedBlobSource(new Blob(['abcdef']), 4, 5);

    await expect(currentOptions().read(0, 3)).resolves.toHaveLength(3);
    await expect(currentOptions().read(3, 6)).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED',
      message: expect.stringContaining('5-byte cumulative read limit'),
    });
  });

  it.each([
    ['fractional start', 0.5, 1],
    ['negative start', -1, 1],
    ['fractional end', 0, 1.5],
    ['empty range', 1, 1],
    ['reversed range', 2, 1],
    ['past EOF', 0, 5],
  ] as const)('rejects an invalid read range: %s', async (_label, start, end) => {
    createBoundedBlobSource(new Blob(['abcd']), 8);

    await expect(currentOptions().read(start, end)).rejects.toMatchObject({
      code: 'INVALID_AUDIO_DATA',
      message: expect.stringContaining('invalid byte range'),
    });
  });

  it('rejects a Blob that returns fewer bytes than requested', async () => {
    const blob = new IncompleteBlob(['abcd']);
    createBoundedBlobSource(blob, 4);

    await expect(currentOptions().read(0, 2)).rejects.toMatchObject({
      code: 'INVALID_AUDIO_DATA',
      message: expect.stringContaining('incomplete byte range'),
    });
  });
});

class IncompleteBlob extends Blob {
  override slice(): Blob {
    return new Blob([new Uint8Array([1])]);
  }
}

function currentOptions(): CapturedCustomSourceOptions {
  const options = mocks.options.at(-1);
  if (options === undefined) {
    throw new Error('Expected CustomSource options.');
  }
  return options;
}
