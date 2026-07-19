import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AudioProgress,
  DecodedAudio,
  EncodedAudio,
} from '../engine/contracts.js';
import { AUDIO_TRANSCODER_VERSION } from '../package-metadata.js';
import type { AudioWorkerRequest, AudioWorkerResponse } from './protocol.js';
import { createAudioTranscoderWorkerPool } from './pool.js';

const PRESET = {
  bitDepth: 16,
  container: 'wav',
  extension: 'wav',
  id: 'wav-pcm16',
  mimeType: 'audio/wav',
  sampleFormat: 'integer' as const,
};
const DECODED: DecodedAudio = {
  channelData: [new Float32Array([0])],
  durationSeconds: 1,
  sampleRate: 1,
  source: 'pool worker',
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('audio transcoder Worker pool', () => {
  it('creates Workers lazily while keeping metadata and inspection local', async () => {
    const harness = createPoolHarness();
    const { pool } = harness;

    expect(harness.created).toHaveLength(0);
    expect(pool.getVersion()).toBe(AUDIO_TRANSCODER_VERSION);
    expect(pool.getInfo().version).toBe(AUDIO_TRANSCODER_VERSION);
    expect(pool.getCapabilities().decode).toContain('wav');
    expect(pool.inspect({ data: new ArrayBuffer(0) }).container).toBe('Unknown');
    expect(pool.getQueueSnapshot()).toEqual({
      active: 0,
      concurrency: 1,
      queued: 0,
      terminated: false,
      workers: 0,
    });
    expect(Object.isFrozen(pool.getQueueSnapshot())).toBe(true);

    const result = pool.decode({ data: new ArrayBuffer(1) });

    expect(harness.created).toHaveLength(1);
    expect(pool.getQueueSnapshot()).toMatchObject({ active: 1, workers: 1 });
    harness.created[0]!.worker.emitMessage({
      id: 1,
      operation: 'decode',
      type: 'result',
      value: DECODED,
    });

    await expect(result).resolves.toEqual(DECODED);
    await flushMicrotasks();
    expect(pool.getQueueSnapshot()).toMatchObject({ active: 0, queued: 0 });
    pool.terminate();
  });

  it('runs up to N operations and preserves FIFO order for overflow', async () => {
    const harness = createPoolHarness({ concurrency: 2, idleTimeoutMs: null });
    const progress = vi.fn();
    const decoded = harness.pool.decode(
      { data: new ArrayBuffer(1) },
      { onProgress: progress },
    );
    const encoded = harness.pool.encode(
      { channelData: [new Float32Array(1)], sampleRate: 1 },
      PRESET.id,
    );
    const transcoded = harness.pool.transcode(
      { data: new ArrayBuffer(1) },
      PRESET.id,
    );

    expect(harness.created.map(({ index }) => index)).toEqual([0, 1]);
    expect(harness.created[0]?.worker.posts[0]?.message.type).toBe('decode');
    expect(harness.created[1]?.worker.posts[0]?.message.type).toBe('encode');
    expect(harness.pool.getQueueSnapshot()).toEqual({
      active: 2,
      concurrency: 2,
      queued: 1,
      terminated: false,
      workers: 2,
    });

    harness.created[0]!.worker.emitMessage({
      id: 1,
      progress: PROGRESS,
      type: 'progress',
    });
    harness.created[0]!.worker.emitMessage({
      id: 1,
      operation: 'decode',
      type: 'result',
      value: DECODED,
    });
    await decoded;
    await flushMicrotasks();

    expect(progress).toHaveBeenCalledWith(PROGRESS);
    expect(harness.created[0]?.worker.posts[1]?.message.type).toBe('transcode');
    harness.created[1]!.worker.emitMessage({
      id: 1,
      operation: 'encode',
      type: 'result',
      value: ENCODED,
    });
    harness.created[0]!.worker.emitMessage({
      id: 2,
      operation: 'transcode',
      type: 'result',
      value: ENCODED,
    });

    await expect(Promise.all([encoded, transcoded])).resolves.toEqual([
      ENCODED,
      ENCODED,
    ]);
    await flushMicrotasks();
    expect(harness.pool.getQueueSnapshot()).toMatchObject({
      active: 0,
      queued: 0,
      workers: 2,
    });
    harness.pool.terminate();
  });

  it('defers scheduled input loading until a slot is available', async () => {
    const harness = createPoolHarness({ idleTimeoutMs: null });
    const firstLoad = vi.fn();
    const secondLoad = vi.fn();
    const first = harness.pool.schedule(async (engine) => {
      firstLoad();
      return engine.decode({ data: new ArrayBuffer(1) });
    });
    const second = harness.pool.schedule(async (engine) => {
      secondLoad();
      return engine.decode({ data: new ArrayBuffer(1) });
    });

    expect(firstLoad).toHaveBeenCalledOnce();
    expect(secondLoad).not.toHaveBeenCalled();
    expect(harness.pool.getQueueSnapshot().queued).toBe(1);

    harness.created[0]!.worker.emitMessage({
      id: 1,
      operation: 'decode',
      type: 'result',
      value: DECODED,
    });
    await first;
    await flushMicrotasks();

    expect(secondLoad).toHaveBeenCalledOnce();
    harness.created[0]!.worker.emitMessage({
      id: 2,
      operation: 'decode',
      type: 'result',
      value: DECODED,
    });
    await second;
    harness.pool.terminate();
  });

  it('cancels queued work without posting it to a Worker', async () => {
    const harness = createPoolHarness({ idleTimeoutMs: null });
    const active = harness.pool.decode({ data: new ArrayBuffer(1) });
    const controller = new AbortController();
    const queued = harness.pool.decode(
      { data: new ArrayBuffer(1) },
      { signal: controller.signal },
    );

    expect(harness.pool.getQueueSnapshot().queued).toBe(1);
    controller.abort('remove queued item');

    await expect(queued).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'remove queued item',
    });
    expect(harness.created[0]?.worker.posts).toHaveLength(1);
    expect(harness.pool.getQueueSnapshot().queued).toBe(0);

    harness.created[0]!.worker.emitMessage({
      id: 1,
      operation: 'decode',
      type: 'result',
      value: DECODED,
    });
    await active;
    harness.pool.terminate();
  });

  it('delegates running cancellation and starts the next queued item', async () => {
    const harness = createPoolHarness({ idleTimeoutMs: null });
    const controller = new AbortController();
    const active = harness.pool.decode(
      { data: new ArrayBuffer(1) },
      { signal: controller.signal },
    );
    const next = harness.pool.decode({ data: new ArrayBuffer(1) });

    controller.abort('stop active item');

    await expect(active).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'stop active item',
    });
    await flushMicrotasks();
    expect(harness.created[0]?.worker.posts[1]?.message).toEqual({
      id: 1,
      type: 'cancel',
    });
    expect(harness.created[0]?.worker.posts[2]?.message.type).toBe('decode');

    harness.created[0]!.worker.emitMessage({
      id: 2,
      operation: 'decode',
      type: 'result',
      value: DECODED,
    });
    await next;
    harness.pool.terminate();
  });

  it('rejects pre-aborted work before allocating a Worker', async () => {
    const harness = createPoolHarness();
    const signal = {
      aborted: true,
      reason: 'already cancelled',
    } as AbortSignal;

    await expect(
      harness.pool.schedule(async () => 1, { signal }),
    ).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'already cancelled',
    });
    expect(harness.created).toHaveLength(0);
    harness.pool.terminate();
  });

  it('continues after synchronous and non-fatal operation failures', async () => {
    const harness = createPoolHarness({ idleTimeoutMs: null });
    const synchronous = harness.pool.schedule(() => {
      throw new Error('synchronous failure');
    });

    await expect(synchronous).rejects.toThrow('synchronous failure');

    const failed = harness.pool.decode({ data: new ArrayBuffer(1) });
    const next = harness.pool.decode({ data: new ArrayBuffer(1) });
    harness.created[0]!.worker.emitMessage({
      error: {
        code: 'UNSUPPORTED_INPUT',
        message: 'bad file',
        name: 'AudioTranscoderError',
      },
      id: 1,
      type: 'error',
    });

    await expect(failed).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' });
    await flushMicrotasks();
    expect(harness.created[0]?.worker.posts[1]?.message.type).toBe('decode');
    harness.created[0]!.worker.emitMessage({
      id: 2,
      operation: 'decode',
      type: 'result',
      value: DECODED,
    });
    await next;
    harness.pool.terminate();
  });

  it('terminates the pool after a fatal Worker failure', async () => {
    const harness = createPoolHarness({ idleTimeoutMs: null });
    const active = harness.pool.decode({ data: new ArrayBuffer(1) });
    const queued = harness.pool.decode({ data: new ArrayBuffer(1) });

    harness.created[0]!.worker.emitError('worker crashed');

    await expect(active).rejects.toMatchObject({
      code: 'WORKER_FAILURE',
      message: 'worker crashed',
    });
    await expect(queued).rejects.toMatchObject({ code: 'WORKER_FAILURE' });
    await flushMicrotasks();
    expect(harness.pool.getQueueSnapshot()).toMatchObject({
      active: 0,
      queued: 0,
      terminated: true,
      workers: 0,
    });
    await expect(
      harness.pool.decode({ data: new ArrayBuffer(1) }),
    ).rejects.toMatchObject({ code: 'WORKER_TERMINATED' });
    harness.pool.terminate();
  });

  it('terminates active and queued work idempotently', async () => {
    const harness = createPoolHarness({ idleTimeoutMs: null });
    const active = harness.pool.decode({ data: new ArrayBuffer(1) });
    const queued = harness.pool.decode({ data: new ArrayBuffer(1) });

    harness.pool.terminate();
    harness.pool.terminate();

    await expect(active).rejects.toMatchObject({ code: 'WORKER_TERMINATED' });
    await expect(queued).rejects.toMatchObject({ code: 'WORKER_TERMINATED' });
    await flushMicrotasks();
    expect(harness.created[0]?.worker.terminateCalls).toBe(1);
    expect(harness.pool.getQueueSnapshot()).toMatchObject({
      active: 0,
      terminated: true,
      workers: 0,
    });
  });

  it('settles scheduled work even when its callback ignores Worker termination', async () => {
    const harness = createPoolHarness({ idleTimeoutMs: null });
    let finish!: () => void;
    const active = harness.pool.schedule(
      async () =>
        new Promise<number>((resolve) => {
          finish = () => resolve(1);
        }),
    );

    harness.pool.terminate();

    await expect(active).rejects.toMatchObject({ code: 'WORKER_TERMINATED' });
    finish();
    await flushMicrotasks();
    expect(harness.pool.getQueueSnapshot().active).toBe(0);
  });

  it('releases idle Workers and recreates them on demand', async () => {
    vi.useFakeTimers();
    const harness = createPoolHarness({ idleTimeoutMs: 10 });
    const first = harness.pool.decode({ data: new ArrayBuffer(1) });
    harness.created[0]!.worker.emitMessage({
      id: 1,
      operation: 'decode',
      type: 'result',
      value: DECODED,
    });
    await first;
    await flushMicrotasks();

    expect(harness.pool.getQueueSnapshot().workers).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(harness.created[0]?.worker.terminateCalls).toBe(1);
    expect(harness.pool.getQueueSnapshot()).toMatchObject({
      terminated: false,
      workers: 0,
    });

    const second = harness.pool.decode({ data: new ArrayBuffer(1) });
    expect(harness.created).toHaveLength(2);
    expect(harness.created[1]?.index).toBe(0);
    harness.created[1]!.worker.emitMessage({
      id: 1,
      operation: 'decode',
      type: 'result',
      value: DECODED,
    });
    await second;
    harness.pool.terminate();
  });

  it('supports immediate idle release and disabling idle release', async () => {
    const immediate = createPoolHarness({ idleTimeoutMs: 0 });
    const immediateResult = immediate.pool.decode({ data: new ArrayBuffer(1) });
    immediate.created[0]!.worker.emitMessage({
      id: 1,
      operation: 'decode',
      type: 'result',
      value: DECODED,
    });
    await immediateResult;
    await flushMicrotasks();
    expect(immediate.pool.getQueueSnapshot().workers).toBe(0);
    immediate.pool.terminate();

    vi.useFakeTimers();
    const retained = createPoolHarness({ idleTimeoutMs: null });
    const retainedResult = retained.pool.decode({ data: new ArrayBuffer(1) });
    retained.created[0]!.worker.emitMessage({
      id: 1,
      operation: 'decode',
      type: 'result',
      value: DECODED,
    });
    await retainedResult;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(retained.pool.getQueueSnapshot().workers).toBe(1);
    retained.pool.terminate();
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid concurrency %s',
    (concurrency) => {
      expect(() =>
        createAudioTranscoderWorkerPool({ concurrency }),
      ).toThrowError(
        expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
      );
    },
  );

  it.each([-1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid idle timeout %s',
    (idleTimeoutMs) => {
      expect(() =>
        createAudioTranscoderWorkerPool({ idleTimeoutMs }),
      ).toThrowError(
        expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
      );
    },
  );

  it.each([
    [new Error('factory error'), 'factory error'],
    ['unknown factory error', 'Audio Worker creation failed.'],
  ])('normalizes lazy Worker factory failures %#', async (failure, message) => {
    const pool = createAudioTranscoderWorkerPool({
      workerFactory() {
        throw failure;
      },
    });

    await expect(pool.decode({ data: new ArrayBuffer(1) })).rejects.toMatchObject({
      code: 'WORKER_FAILURE',
      message,
    });
    expect(pool.getQueueSnapshot().terminated).toBe(true);
  });

  it('preserves engine errors when the native Worker is unavailable', async () => {
    vi.stubGlobal('Worker', undefined);
    const pool = createAudioTranscoderWorkerPool();

    await expect(pool.decode({ data: new ArrayBuffer(1) })).rejects.toMatchObject({
      code: 'WORKER_UNAVAILABLE',
    });
    expect(pool.getQueueSnapshot().terminated).toBe(true);
  });
});

interface CreatedWorker {
  readonly index: number;
  readonly worker: WorkerStub;
}

function createPoolHarness(
  options: {
    readonly concurrency?: number;
    readonly idleTimeoutMs?: number | null;
  } = {},
) {
  const created: CreatedWorker[] = [];
  const pool = createAudioTranscoderWorkerPool({
    ...options,
    workerFactory(index) {
      const worker = new WorkerStub();
      created.push({ index, worker });
      return worker as unknown as Worker;
    },
  });
  return { created, pool };
}

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

  postMessage(message: AudioWorkerRequest, transfer: Transferable[] = []): void {
    this.posts.push({ message, transfer });
  }

  terminate(): void {
    this.terminateCalls += 1;
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}
