import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AudioProgress,
  DecodedAudio,
  EncodedAudio,
} from '../engine/contracts.js';
import { AUDIO_TRANSCODER_VERSION } from '../package-metadata.js';
import { createAudioTranscoderWorkerEngine } from './client.js';
import type { AudioWorkerRequest, AudioWorkerResponse } from './protocol.js';

const PRESET = {
  bitDepth: 16,
  container: 'wav',
  extension: 'wav',
  id: 'wav-pcm16',
  mimeType: 'audio/wav',
  sampleFormat: 'integer' as const,
};
const DECODED: DecodedAudio = {
  channelData: [new Float32Array([0.25])],
  durationSeconds: 1,
  sampleRate: 1,
  source: 'worker',
};
const ENCODED: EncodedAudio = { data: new ArrayBuffer(1), preset: PRESET };
const PROGRESS: AudioProgress = {
  completedFrames: 1,
  operation: 'decode',
  phase: 'decode',
  progress: 0.5,
  totalFrames: 2,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('audio worker client', () => {
  it('keeps metadata and inspection local while decoding in the worker', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const inputData = new Uint8Array([1, 2, 3]).buffer;
    const progress = vi.fn();
    const result = engine.decode(
      { data: inputData, name: 'unknown.bin' },
      { onProgress: progress },
    );
    const request = worker.posts[0];

    expect(engine.getVersion()).toBe(AUDIO_TRANSCODER_VERSION);
    expect(engine.getInfo().version).toBe(AUDIO_TRANSCODER_VERSION);
    expect(engine.getCapabilities().decode).toContain('wav');
    expect(engine.inspect({ data: inputData }).container).toBe('Unknown');
    expect(request?.message).toMatchObject({ id: 1, type: 'decode' });
    const requestedInput = request?.message as Extract<
      AudioWorkerRequest,
      { type: 'decode' }
    >;
    expect(requestedInput.input.data).not.toBe(inputData);
    expect(new Uint8Array(requestedInput.input.data)).toEqual(
      new Uint8Array(inputData),
    );
    expect(request?.transfer).toEqual([requestedInput.input.data]);

    worker.emitMessage({ id: 999, operation: 'decode', type: 'result', value: DECODED });
    worker.emitMessage({ id: 1, progress: PROGRESS, type: 'progress' });
    worker.emitMessage({ id: 1, operation: 'decode', type: 'result', value: DECODED });

    const decoded = await result;
    const progressEvent = progress.mock.calls[0]?.[0] as AudioProgress;
    expect(decoded).toEqual(DECODED);
    expect(decoded).not.toBe(DECODED);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.channelData)).toBe(true);
    expect(progressEvent).toEqual(PROGRESS);
    expect(Object.isFrozen(progressEvent)).toBe(true);
  });

  it('encodes copied PCM channels and transcodes copied input buffers', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const channel = new Float32Array([0, 1]);
    const encodeResult = engine.encode(
      { channelData: [channel], sampleRate: 48_000 },
      PRESET.id,
    );
    const encodeRequest = worker.posts[0]?.message as Extract<
      AudioWorkerRequest,
      { type: 'encode' }
    >;

    expect(encodeRequest.audio.channelData[0]).not.toBe(channel);
    expect(encodeRequest.audio.channelData[0]).toEqual(channel);
    expect(worker.posts[0]?.transfer).toEqual([
      encodeRequest.audio.channelData[0]?.buffer,
    ]);
    worker.emitMessage({ id: 1, operation: 'encode', type: 'result', value: ENCODED });
    const encoded = await encodeResult;
    expect(encoded).toEqual(ENCODED);
    expect(encoded).not.toBe(ENCODED);
    expect(Object.isFrozen(encoded)).toBe(true);
    expect(Object.isFrozen(encoded.preset)).toBe(true);

    const inputData = new ArrayBuffer(2);
    const transcodeResult = engine.transcode(
      { data: inputData },
      PRESET.id,
    );
    const transcodeRequest = worker.posts[1]?.message as Extract<
      AudioWorkerRequest,
      { type: 'transcode' }
    >;
    expect(transcodeRequest.input.data).not.toBe(inputData);
    worker.emitMessage({
      id: 2,
      operation: 'transcode',
      type: 'result',
      value: ENCODED,
    });
    await expect(transcodeResult).resolves.toEqual(ENCODED);
  });

  it('transfers original ArrayBuffers only when explicitly requested', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const inputData = new ArrayBuffer(2);
    const decodeResult = engine.decode(
      { data: inputData },
      { transferInput: true },
    );
    const decodeRequest = worker.posts[0]?.message as Extract<
      AudioWorkerRequest,
      { type: 'decode' }
    >;
    expect(decodeRequest.input.data).toBe(inputData);
    worker.emitMessage({ id: 1, operation: 'decode', type: 'result', value: DECODED });
    await decodeResult;

    const channel = new Float32Array([1]);
    const encodeResult = engine.encode(
      { channelData: [channel, channel], sampleRate: 1 },
      PRESET.id,
      { transferInput: true },
    );
    const encodeRequest = worker.posts[1]?.message as Extract<
      AudioWorkerRequest,
      { type: 'encode' }
    >;
    expect(encodeRequest.audio.channelData).toEqual([channel, channel]);
    expect(worker.posts[1]?.transfer).toEqual([channel.buffer]);
    worker.emitMessage({ id: 2, operation: 'encode', type: 'result', value: ENCODED });
    await encodeResult;
  });

  it('copies SharedArrayBuffer channels because they are not transferable', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const channel = new Float32Array(new SharedArrayBuffer(4));
    const result = engine.encode(
      { channelData: [channel], sampleRate: 1 },
      PRESET.id,
      { transferInput: true },
    );
    const request = worker.posts[0]?.message as Extract<
      AudioWorkerRequest,
      { type: 'encode' }
    >;

    expect(request.audio.channelData[0]).not.toBe(channel);
    expect(request.audio.channelData[0]?.buffer).toBeInstanceOf(ArrayBuffer);
    worker.emitMessage({ id: 1, operation: 'encode', type: 'result', value: ENCODED });
    await result;
  });

  it.each([
    [{ code: 'UNSUPPORTED_INPUT' as const, message: 'coded', name: 'AudioTranscoderError' }, 'AudioTranscoderError'],
    [{ message: 'plain', name: 'TypeError' }, 'TypeError'],
  ])('reconstructs worker errors %#', async (error, expectedName) => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const result = engine.decode({ data: new ArrayBuffer(1) });

    worker.emitMessage({ error, id: 1, type: 'error' });

    await expect(result).rejects.toMatchObject({
      message: error.message,
      name: expectedName,
    });
  });

  it.each([
    [new Error('error stop'), 'error stop'],
    ['string stop', 'string stop'],
    [123, 'Audio operation was aborted.'],
  ])('rejects pre-aborted operations without posting %#', async (reason, message) => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const signal = { aborted: true, reason } as AbortSignal;

    await expect(
      engine.decode({ data: new ArrayBuffer(1) }, { signal }),
    ).rejects.toMatchObject({ code: 'OPERATION_ABORTED', message });
    expect(worker.posts).toHaveLength(0);
  });

  it('cancels active operations and settles even if cancellation posting fails', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const controller = new AbortController();
    const result = engine.decode(
      { data: new ArrayBuffer(1) },
      { signal: controller.signal },
    );

    worker.throwOnCancel = true;
    controller.abort('active stop');

    await expect(result).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'active stop',
    });
    worker.emitMessage({ id: 1, operation: 'decode', type: 'result', value: DECODED });
  });

  it('cancels and rejects when a progress listener throws', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const failure = new Error('UI callback failed');
    const result = engine.decode(
      { data: new ArrayBuffer(1) },
      {
        onProgress() {
          throw failure;
        },
      },
    );

    worker.emitMessage({ id: 1, progress: PROGRESS, type: 'progress' });

    await expect(result).rejects.toBe(failure);
    expect(worker.posts.at(-1)?.message).toEqual({ id: 1, type: 'cancel' });
  });

  it('settles a callback failure if cancellation posting also fails', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const result = engine.decode(
      { data: new ArrayBuffer(1) },
      { onProgress: () => { throw new Error('callback'); } },
    );
    worker.throwOnCancel = true;

    worker.emitMessage({ id: 1, progress: PROGRESS, type: 'progress' });

    await expect(result).rejects.toThrow('callback');
  });

  it('cleans up and rejects synchronous postMessage failures', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    worker.throwOnOperation = true;

    await expect(engine.decode({ data: new ArrayBuffer(1) })).rejects.toThrow(
      'post failed',
    );
  });

  it.each([
    ['error message', 'error', 'worker crashed'],
    ['fallback error message', 'error', ''],
    ['message deserialization', 'messageerror', ''],
  ] as const)('rejects pending work after %s', async (_case, eventType, message) => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const result = engine.decode({ data: new ArrayBuffer(1) });

    if (eventType === 'error') {
      worker.emitError(message);
    } else {
      worker.emitMessageError();
    }

    await expect(result).rejects.toMatchObject({ code: 'WORKER_FAILURE' });
    expect(worker.terminated).toBe(true);
    await expect(engine.decode({ data: new ArrayBuffer(1) })).rejects.toMatchObject({
      code: 'WORKER_TERMINATED',
    });
  });

  it('terminates idempotently and rejects every pending operation', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const first = engine.decode({ data: new ArrayBuffer(1) });
    const second = engine.encode(
      { channelData: [new Float32Array(1)], sampleRate: 1 },
      PRESET.id,
    );

    engine.terminate();
    engine.terminate();
    worker.emitError('late error');

    await expect(first).rejects.toMatchObject({ code: 'WORKER_TERMINATED' });
    await expect(second).rejects.toMatchObject({ code: 'WORKER_TERMINATED' });
    expect(worker.terminateCalls).toBe(1);
  });

  it('uses the native module Worker by default', () => {
    const worker = new WorkerStub();
    const WorkerConstructor = vi.fn(function WorkerConstructor(
      _url: URL,
      _options: WorkerOptions,
    ) {
      return worker;
    });
    vi.stubGlobal('Worker', WorkerConstructor);

    const engine = createAudioTranscoderWorkerEngine();

    expect(WorkerConstructor).toHaveBeenCalledWith(expect.any(URL), {
      name: 'dsub-audio-transcoder',
      type: 'module',
    });
    engine.terminate();
  });

  it('fails clearly when Web Workers are unavailable', () => {
    vi.stubGlobal('Worker', undefined);

    expect(() => createAudioTranscoderWorkerEngine()).toThrowError(
      expect.objectContaining({ code: 'WORKER_UNAVAILABLE' }),
    );
  });
});

interface WorkerPost {
  readonly message: AudioWorkerRequest;
  readonly transfer: readonly Transferable[];
}

class WorkerStub {
  readonly posts: WorkerPost[] = [];
  readonly listeners = {
    error: [] as ((event: ErrorEvent) => void)[],
    message: [] as ((event: MessageEvent<AudioWorkerResponse>) => void)[],
    messageerror: [] as (() => void)[],
  };
  terminateCalls = 0;
  terminated = false;
  throwOnCancel = false;
  throwOnOperation = false;

  addEventListener(type: string, listener: EventListener): void {
    if (type === 'message') {
      this.listeners.message.push(
        listener as unknown as (event: MessageEvent<AudioWorkerResponse>) => void,
      );
    } else if (type === 'error') {
      this.listeners.error.push(listener as unknown as (event: ErrorEvent) => void);
    } else {
      this.listeners.messageerror.push(listener as unknown as () => void);
    }
  }

  emitError(message: string): void {
    for (const listener of this.listeners.error) {
      listener({ message } as ErrorEvent);
    }
  }

  emitMessage(message: AudioWorkerResponse): void {
    for (const listener of this.listeners.message) {
      listener({ data: message } as MessageEvent<AudioWorkerResponse>);
    }
  }

  emitMessageError(): void {
    for (const listener of this.listeners.messageerror) {
      listener();
    }
  }

  postMessage(message: AudioWorkerRequest, transfer: Transferable[] = []): void {
    if (
      (message.type === 'cancel' && this.throwOnCancel) ||
      (message.type !== 'cancel' && this.throwOnOperation)
    ) {
      throw new Error('post failed');
    }
    this.posts.push({ message, transfer });
  }

  terminate(): void {
    this.terminateCalls += 1;
    this.terminated = true;
  }
}

function createEngine(worker: WorkerStub) {
  return createAudioTranscoderWorkerEngine({
    workerFactory: () => worker as unknown as Worker,
  });
}
