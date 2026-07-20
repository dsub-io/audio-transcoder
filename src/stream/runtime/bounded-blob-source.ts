import { CustomSource } from 'mediabunny';
import { AudioTranscoderError } from '../../errors.js';

/**
 * Creates a non-prefetching MediaBunny source with hard per-read and optional
 * cumulative read bounds.
 */
export function createBoundedBlobSource(
  blob: Blob,
  inputReadBytes: number,
  maxTotalReadBytes?: number,
): CustomSource {
  if (!(blob instanceof Blob)) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      'A Blob is required for bounded media input.',
    );
  }
  if (!Number.isSafeInteger(inputReadBytes) || inputReadBytes < 1) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      'inputReadBytes must be a positive safe integer.',
    );
  }
  if (
    maxTotalReadBytes !== undefined &&
    (!Number.isSafeInteger(maxTotalReadBytes) || maxTotalReadBytes < 1)
  ) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      'maxTotalReadBytes must be a positive safe integer when provided.',
    );
  }

  let totalReadBytes = 0;

  return new CustomSource({
    getSize: () => blob.size,
    maxCacheSize: inputReadBytes,
    prefetchProfile: 'none',
    read: async (start, end) => {
      assertReadRange(start, end, blob.size);
      const length = end - start;
      if (length > inputReadBytes) {
        throw new AudioTranscoderError(
          'INVALID_AUDIO_DATA',
          `Media input requested ${length} bytes; the per-read limit is ${inputReadBytes} bytes.`,
        );
      }
      if (
        maxTotalReadBytes !== undefined &&
        totalReadBytes > maxTotalReadBytes - length
      ) {
        throw new AudioTranscoderError(
          'RESOURCE_LIMIT_EXCEEDED',
          `Media input exceeded the ${maxTotalReadBytes}-byte cumulative read limit.`,
        );
      }
      totalReadBytes += length;

      const buffer = await blob.slice(start, end).arrayBuffer();
      if (buffer.byteLength !== length) {
        throw new AudioTranscoderError(
          'INVALID_AUDIO_DATA',
          'Media input returned an incomplete byte range.',
        );
      }
      return new Uint8Array(buffer);
    },
  });
}

function assertReadRange(start: number, end: number, size: number): void {
  if (
    !Number.isSafeInteger(start) ||
    start < 0 ||
    !Number.isSafeInteger(end) ||
    end <= start ||
    end > size
  ) {
    throw new AudioTranscoderError(
      'INVALID_AUDIO_DATA',
      'Media input requested an invalid byte range.',
    );
  }
}
