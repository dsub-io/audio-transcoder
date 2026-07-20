import { AudioTranscoderError } from '../../errors.js';
import type { BundledWasmOutputCodec } from '../../codecs/stream-output-presets.js';

export type MediaBunnyCodecRegistrationLoader = () => Promise<() => void>;

export type MediaBunnyCodecRegistrationLoaders = Readonly<
  Record<BundledWasmOutputCodec, MediaBunnyCodecRegistrationLoader>
>;

export type EnsureMediaBunnyCodecRegistered = (
  codec: BundledWasmOutputCodec,
) => Promise<void>;

export const MEDIABUNNY_CODEC_REGISTRATION_LOADERS: MediaBunnyCodecRegistrationLoaders =
  Object.freeze({
    async flac() {
      const extension = await import('@mediabunny/flac-encoder');
      return extension.registerFlacEncoder;
    },
    async mp3() {
      const extension = await import('@mediabunny/mp3-encoder');
      return extension.registerMp3Encoder;
    },
  });

/**
 * Creates a Worker-local, concurrency-safe extension registrar. Rejections stay
 * cached because MediaBunny's global encoder registry cannot be rolled back.
 */
export function createLazyMediaBunnyCodecRegistrar(
  loaders: MediaBunnyCodecRegistrationLoaders =
    MEDIABUNNY_CODEC_REGISTRATION_LOADERS,
): EnsureMediaBunnyCodecRegistered {
  const registrations = new Map<BundledWasmOutputCodec, Promise<void>>();

  return (codec): Promise<void> => {
    const existing = registrations.get(codec);
    if (existing !== undefined) {
      return existing;
    }

    const initialization = Promise.resolve()
      .then(loaders[codec])
      .then((register) => register())
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        throw new AudioTranscoderError(
          'WORKER_FAILURE',
          `Failed to initialize the bundled ${codec.toUpperCase()} encoder: ${reason}`,
        );
      });
    registrations.set(codec, initialization);
    return initialization;
  };
}

export const ensureMediaBunnyCodecRegistered =
  createLazyMediaBunnyCodecRegistrar();
