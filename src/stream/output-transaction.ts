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

/** Keeps a seekable destination abortable until the encoder fully succeeds. */
export function createAudioStreamOutputTransaction(
  output: AudioStreamOutput,
): AudioStreamOutputTransaction {
  const writer = output.getWriter();
  let settlement: Promise<void> | null = null;

  const settle = (operation: () => Promise<void>): Promise<void> => {
    if (settlement === null) {
      settlement = (async () => {
        try {
          await operation();
        } finally {
          writer.releaseLock();
        }
      })();
    }
    return settlement;
  };
  const abort = (reason: unknown): Promise<void> =>
    settle(() => writer.abort(reason));
  const commit = (): Promise<void> => settle(() => writer.close());

  const stream = new WritableStream<AudioStreamOutputChunk>({
    abort,
    close: commit,
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
