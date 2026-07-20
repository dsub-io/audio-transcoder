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
