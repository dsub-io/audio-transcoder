import { describe, expect, it, vi } from 'vitest';

const extensionMocks = vi.hoisted(() => ({
  registerFlacEncoder: vi.fn(),
  registerMp3Encoder: vi.fn(),
}));

vi.mock('@mediabunny/flac-encoder', () => ({
  registerFlacEncoder: extensionMocks.registerFlacEncoder,
}));

vi.mock('@mediabunny/mp3-encoder', () => ({
  registerMp3Encoder: extensionMocks.registerMp3Encoder,
}));

import {
  createLazyMediaBunnyCodecRegistrar,
  MEDIABUNNY_CODEC_REGISTRATION_LOADERS,
} from './lazy-codec-registration.js';

describe('lazy MediaBunny codec registration', () => {
  it('loads and registers each default extension only when requested', async () => {
    const ensureRegistered = createLazyMediaBunnyCodecRegistrar();

    expect(extensionMocks.registerFlacEncoder).not.toHaveBeenCalled();
    expect(extensionMocks.registerMp3Encoder).not.toHaveBeenCalled();

    await ensureRegistered('mp3');
    expect(extensionMocks.registerMp3Encoder).toHaveBeenCalledOnce();
    expect(extensionMocks.registerFlacEncoder).not.toHaveBeenCalled();

    await ensureRegistered('flac');
    expect(extensionMocks.registerFlacEncoder).toHaveBeenCalledOnce();
  });

  it('returns one in-flight initialization to concurrent callers', async () => {
    let release: ((register: () => void) => void) | undefined;
    const register = vi.fn();
    const mp3 = vi.fn(
      () =>
        new Promise<() => void>((resolve) => {
          release = resolve;
        }),
    );
    const ensureRegistered = createLazyMediaBunnyCodecRegistrar({
      flac: vi.fn().mockResolvedValue(vi.fn()),
      mp3,
    });

    const first = ensureRegistered('mp3');
    const second = ensureRegistered('mp3');
    expect(second).toBe(first);
    expect(mp3).not.toHaveBeenCalled();

    await Promise.resolve();
    expect(mp3).toHaveBeenCalledOnce();
    release?.(register);
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(register).toHaveBeenCalledOnce();
  });

  it('wraps load errors and keeps the rejected initialization cached', async () => {
    const load = vi.fn().mockRejectedValue(new Error('chunk unavailable'));
    const ensureRegistered = createLazyMediaBunnyCodecRegistrar({
      flac: load,
      mp3: vi.fn().mockResolvedValue(vi.fn()),
    });

    const first = ensureRegistered('flac');
    await expect(first).rejects.toMatchObject({
      code: 'WORKER_FAILURE',
      message:
        'Failed to initialize the bundled FLAC encoder: chunk unavailable',
    });
    const second = ensureRegistered('flac');
    expect(second).toBe(first);
    await expect(second).rejects.toMatchObject({ code: 'WORKER_FAILURE' });
    expect(load).toHaveBeenCalledOnce();
  });

  it('wraps non-Error registration failures', async () => {
    const ensureRegistered = createLazyMediaBunnyCodecRegistrar({
      flac: vi.fn().mockResolvedValue(vi.fn()),
      mp3: vi.fn().mockResolvedValue(() => {
        throw 'registration rejected';
      }),
    });

    await expect(ensureRegistered('mp3')).rejects.toMatchObject({
      code: 'WORKER_FAILURE',
      message:
        'Failed to initialize the bundled MP3 encoder: registration rejected',
    });
  });

  it('exposes immutable default loader selection', () => {
    expect(Object.isFrozen(MEDIABUNNY_CODEC_REGISTRATION_LOADERS)).toBe(true);
  });
});
