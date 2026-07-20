import type { AudioStreamOutput, AudioStreamOutputChunk } from '../contracts.js';
import {
  collectFailures,
  invalidConfiguration,
  throwCollectedFailures,
  type OutputDestination,
} from './internal.js';

export async function createOpfsDestination(
  directory: FileSystemDirectoryHandle,
): Promise<OutputDestination> {
  const tempName = `output-${crypto.randomUUID()}.tmp`;
  const remove = createRemoval(directory, tempName);
  try {
    const handle = await directory.getFileHandle(tempName, { create: true });
    const writable = await handle.createWritable();
    return new OpfsDestination(handle, writable, remove);
  } catch (error) {
    await remove().catch(() => undefined);
    throw error;
  }
}

export async function removeEntryIfPresent(
  directory: FileSystemDirectoryHandle,
  name: string,
  recursive: boolean,
): Promise<void> {
  try {
    await directory.removeEntry(name, { recursive });
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
}

class OpfsDestination implements OutputDestination {
  private closed = false;
  private nativeSettlement: Promise<void> | undefined;
  private readonly writer: WritableStreamDefaultWriter<FileSystemWriteChunkType>;
  readonly storage = 'opfs' as const;
  readonly stream: AudioStreamOutput;

  constructor(
    private readonly handle: FileSystemFileHandle,
    writable: FileSystemWritableFileStream,
    private readonly remove: () => Promise<void>,
  ) {
    this.writer = writable.getWriter();
    this.stream = new WritableStream<AudioStreamOutputChunk>({
      abort: (reason) => this.abortNative(reason),
      close: () => this.closeNative(),
      write: (chunk) => this.writer.write(chunk),
    });
  }

  async complete(mimeType: string): Promise<Blob> {
    if (!this.closed) {
      throw invalidConfiguration(
        'Output stream must be closed before it is completed.',
      );
    }
    const file = await this.handle.getFile();
    return file.type === mimeType
      ? file
      : file.slice(0, file.size, mimeType);
  }

  async discard(): Promise<void> {
    const failures: unknown[] = [];
    collectFailures(
      await Promise.allSettled([this.abortNative(undefined)]),
      failures,
    );
    collectFailures(await Promise.allSettled([this.remove()]), failures);
    throwCollectedFailures(failures, 'Failed to discard OPFS output.');
  }

  private abortNative(reason: unknown): Promise<void> {
    return this.settleNative(() => this.writer.abort(reason));
  }

  private closeNative(): Promise<void> {
    return this.settleNative(async () => {
      await this.writer.close();
      this.closed = true;
    });
  }

  private settleNative(operation: () => Promise<void>): Promise<void> {
    this.nativeSettlement ??= operation().finally(() =>
      this.writer.releaseLock(),
    );
    return this.nativeSettlement;
  }
}

function createRemoval(
  directory: FileSystemDirectoryHandle,
  name: string,
): () => Promise<void> {
  let removed = false;
  let removalInFlight: Promise<void> | undefined;
  return () => {
    if (removed) {
      return Promise.resolve();
    }
    if (removalInFlight !== undefined) {
      return removalInFlight;
    }

    const attempt = removeEntryIfPresent(directory, name, false)
      .then(() => {
        removed = true;
      })
      .finally(() => {
        removalInFlight = undefined;
      });
    removalInFlight = attempt;
    return attempt;
  };
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'NotFoundError'
  );
}
