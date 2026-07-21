import { describe, expect, it, vi } from 'vitest';
import type { AudioStreamOutputChunk } from './contracts.js';
import { createAudioStreamOutputTransaction } from './output-transaction.js';

const CHUNK: AudioStreamOutputChunk = {
  data: new Uint8Array([1, 2, 3]),
  position: 4,
  type: 'write',
};

describe('stream output transaction', () => {
  it('forwards writes and commits once while releasing the destination lock', async () => {
    const write = vi.fn();
    const close = vi.fn();
    const output = new WritableStream<AudioStreamOutputChunk>({ close, write });
    const transaction = createAudioStreamOutputTransaction(output);
    const writer = transaction.stream.getWriter();

    await writer.write(CHUNK);
    await transaction.commit();
    await transaction.commit();
    await transaction.abort(new Error('ignored after commit'));

    expect(write).toHaveBeenCalledWith(CHUNK, expect.anything());
    expect(close).toHaveBeenCalledOnce();
    expect(output.locked).toBe(false);
    await expect(writer.write(CHUNK)).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    });
    writer.releaseLock();
  });

  it('aborts once with the original reason and releases the lock', async () => {
    const abort = vi.fn();
    const output = new WritableStream<AudioStreamOutputChunk>({ abort });
    const transaction = createAudioStreamOutputTransaction(output);
    const reason = new Error('stop');

    await transaction.abort(reason);
    await transaction.abort(new Error('ignored'));

    expect(abort).toHaveBeenCalledWith(reason);
    expect(abort).toHaveBeenCalledOnce();
    expect(output.locked).toBe(false);
  });

  it('releases the destination lock before a non-cooperative abort settles', async () => {
    const abortSettlement = deferred<void>();
    const abort = vi.fn(() => abortSettlement.promise);
    const output = new WritableStream<AudioStreamOutputChunk>({ abort });
    const transaction = createAudioStreamOutputTransaction(output);
    const reason = new Error('stop');

    const pending = transaction.abort(reason);

    expect(output.locked).toBe(false);
    await vi.waitFor(() => expect(abort).toHaveBeenCalledWith(reason));
    abortSettlement.resolve();
    await pending;
  });

  it('keeps the destination abortable after the encoder closes its stream', async () => {
    const abort = vi.fn();
    const close = vi.fn();
    const output = new WritableStream<AudioStreamOutputChunk>({ abort, close });
    const transaction = createAudioStreamOutputTransaction(output);
    const reason = new Error('stop finalize');
    const encoderWriter = transaction.stream.getWriter();

    await encoderWriter.close();
    encoderWriter.releaseLock();

    expect(close).not.toHaveBeenCalled();

    await transaction.abort(reason);

    expect(abort).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledWith(reason);
    expect(close).not.toHaveBeenCalled();
    expect(output.locked).toBe(false);
  });

  it('treats destination close as an irreversible success-wins commit', async () => {
    const closeSettlement = deferred<void>();
    const abort = vi.fn();
    const close = vi.fn(() => closeSettlement.promise);
    const output = new WritableStream<AudioStreamOutputChunk>({ abort, close });
    const transaction = createAudioStreamOutputTransaction(output);
    const committing = transaction.commit();

    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    const aborting = transaction.abort(new Error('late cancellation'));

    expect(abort).not.toHaveBeenCalled();
    expect(output.locked).toBe(true);
    closeSettlement.resolve();
    await expect(Promise.all([committing, aborting])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(output.locked).toBe(false);
  });

  it('releases the destination lock when settlement rejects', async () => {
    const failure = new Error('close failed');
    const output = new WritableStream<AudioStreamOutputChunk>({
      close: async () => {
        throw failure;
      },
    });
    const transaction = createAudioStreamOutputTransaction(output);

    await expect(transaction.commit()).rejects.toBe(failure);
    expect(output.locked).toBe(false);
  });
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  reject(error: unknown): void;
  resolve(value: T): void;
} {
  let reject!: (error: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    reject = promiseReject;
    resolve = promiseResolve;
  });
  return { promise, reject, resolve };
}
