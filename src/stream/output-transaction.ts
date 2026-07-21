import type {
  AudioStreamOutput,
  AudioStreamOutputChunk,
} from './contracts.js';
import { AudioTranscoderError } from '../errors.js';

export interface AudioStreamOutputTransaction {
  abort(reason: unknown): Promise<void>;
  commit(): Promise<void>;
  readonly stream: AudioStreamOutput;
}

/**
 * Keeps a seekable destination abortable until the encoder fully succeeds.
 * `commit()` starts the destination's irreversible close; once it starts,
 * success (or a close failure) wins over later cancellation.
 */
export function createAudioStreamOutputTransaction(
  output: AudioStreamOutput,
): AudioStreamOutputTransaction {
  const writer = output.getWriter();
  let settlement: Promise<void> | null = null;
  let abortSettlement: Promise<void> | null = null;
  let writerReleased = false;

  const releaseWriter = (): void => {
    writerReleased = true;
    writer.releaseLock();
  };

  const commit = (): Promise<void> => {
    if (settlement === null) {
      settlement = (async () => {
        try {
          await writer.close();
        } finally {
          releaseWriter();
        }
      })();
    }
    return settlement;
  };
  const abort = (reason: unknown): Promise<void> => {
    if (abortSettlement !== null) {
      return abortSettlement;
    }
    if (writerReleased) {
      return settlement!;
    }
    if (settlement !== null) {
      // WritableStream cannot dispatch abort after close has started. Treat
      // commit as the explicit irreversible boundary and preserve its result.
      return settlement;
    }
    abortSettlement = writer.abort(reason);
    settlement = abortSettlement;
    releaseWriter();
    return abortSettlement;
  };

  const stream = new WritableStream<AudioStreamOutputChunk>({
    abort,
    // Encoder finalization closes its own writable side before the engine has
    // finished successfully. Keep the destination open until the engine calls
    // commit so a concurrent cancellation can still reach the destination's
    // abort hook.
    close() {},
    write(chunk) {
      if (settlement !== null) {
        throw new AudioTranscoderError(
          'INVALID_CONFIGURATION',
          'The streaming output transaction is already settled.',
        );
      }
      return writer.write(chunk);
    },
  });

  return { abort, commit, stream };
}
