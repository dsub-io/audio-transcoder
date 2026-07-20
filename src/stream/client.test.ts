import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type {
  AudioTranscoderCustomStreamWorkerRuntimeOptions,
  AudioTranscoderDefaultStreamWorkerRuntimeOptions,
  AudioStreamInputSupportResult,
  AudioStreamInspection,
  AudioStreamOutputChunk,
  AudioStreamOutputSupportResult,
  AudioStreamProgress,
  AudioStreamTranscodeResult,
  AudioTranscoderStreamWorkerRuntimeOptions,
  CreateAudioTranscoderStreamWorkerEngineOptions,
} from './contracts.js';
import { createAudioTranscoderStreamWorkerEngine } from './client.js';
import type {
  AudioStreamWorkerRequest,
  AudioStreamWorkerResponse,
} from './protocol.js';
import { AUDIO_TRANSCODER_STREAM_CAPABILITIES } from './capabilities.js';
import type { AudioTranscoderStreamCapabilities } from './capabilities.js';
import { AUDIO_TRANSCODER_VERSION } from '../package-metadata.js';

const INSPECTION: AudioStreamInspection = {
  bitDepth: 24,
  channels: 1,
  codec: 'pcm-s24',
  container: 'WAVE',
  decodeSupport: 'built-in',
  durationSeconds: 1,
  notes: [],
  sampleRate: 48_000,
  size: 100,
};
const PRESET = {
  bitDepth: 16,
  container: 'wav',
  extension: 'wav',
  id: 'wav-pcm16',
  mimeType: 'audio/wav',
  sampleFormat: 'integer' as const,
};
const RESULT: AudioStreamTranscodeResult = {
  bytesWritten: 64,
  channels: 1,
  details: { format: 'wav', rf64: false },
  durationSeconds: 1,
  format: 'wav',
  preset: PRESET,
  rf64: false,
  sampleRate: 48_000,
};
const PROGRESS: AudioStreamProgress = {
  durationSeconds: 1,
  phase: 'decode',
  processedSeconds: 0.5,
  progress: 0.49,
};
const SUPPORTED_INPUT: AudioStreamInputSupportResult = {
  inspection: INSPECTION,
  status: 'supported',
};
const SUPPORTED_OUTPUT: AudioStreamOutputSupportResult = {
  code: 'SUPPORTED',
  message: 'The output runtime probe succeeded.',
  reason: 'runtime-verified',
  status: 'supported',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('stream worker client', () => {
  it('serializes operations and transfers output only when its turn starts', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const input = { blob: new Blob(['audio']), name: 'source.wav' };
    const onProgress = vi.fn();
    const inspection = engine.inspect(input, { inputReadBytes: 65_536 });
    const output = new WritableStream();
    const transcode = engine.transcode(
      input,
      { presetId: 'wav-pcm16' },
      output,
      { onProgress, outputChunkBytes: 65_536, pcmChunkBytes: 131_072 },
    );

    expect(engine.getVersion()).toBe(AUDIO_TRANSCODER_VERSION);
    expect(engine.getInfo().version).toBe(AUDIO_TRANSCODER_VERSION);
    expect(engine.getCapabilities().limits.recommendedConcurrency).toBe(1);
    expect(worker.posts).toHaveLength(1);
    expect(worker.posts[0]).toMatchObject({
      message: {
        id: 1,
        options: { inputReadBytes: 65_536 },
        type: 'inspect',
      },
      transfer: [],
    });
    worker.emit({ id: 999, operation: 'inspect', type: 'result', value: INSPECTION });
    worker.emit({ id: 1, operation: 'inspect', type: 'result', value: INSPECTION });
    const inspected = await inspection;
    expect(inspected).toEqual(INSPECTION);
    expect(inspected).not.toBe(INSPECTION);
    expect(Object.isFrozen(inspected)).toBe(true);
    expect(Object.isFrozen(inspected.notes)).toBe(true);

    expect(worker.posts[1]?.message).toMatchObject({
      id: 2,
      options: { outputChunkBytes: 65_536, pcmChunkBytes: 131_072 },
      type: 'transcode',
    });
    expect(worker.posts[1]?.transfer).toHaveLength(1);
    expect(worker.posts[1]?.transfer[0]).not.toBe(output);
    expect(worker.posts[1]?.message).toMatchObject({
      output: worker.posts[1]?.transfer[0],
    });
    worker.emit({ id: 2, progress: PROGRESS, type: 'progress' });
    await worker.closePostedOutput(2);
    worker.emit({ id: 2, operation: 'transcode', type: 'result', value: RESULT });
    const converted = await transcode;
    expect(onProgress).toHaveBeenCalledWith(PROGRESS);
    expect(Object.isFrozen(onProgress.mock.calls[0]?.[0])).toBe(true);
    expect(converted).toEqual(RESULT);
    expect(converted).not.toBe(RESULT);
    expect(Object.isFrozen(converted)).toBe(true);
    expect(Object.isFrozen(converted.preset)).toBe(true);
    expect(output.locked).toBe(false);
    engine.terminate();
  });

  it('probes concrete input support through the Worker and freezes results', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const input = { blob: new Blob(['audio']), name: 'candidate.mp3' };
    const supported = engine.probeInputSupport(input, {
      inputReadBytes: 65_536,
    });

    expect(worker.posts[0]).toMatchObject({
      message: {
        id: 1,
        input,
        options: { inputReadBytes: 65_536 },
        type: 'probeInputSupport',
      },
      transfer: [],
    });
    worker.emit({
      id: 1,
      operation: 'probeInputSupport',
      type: 'result',
      value: SUPPORTED_INPUT,
    });
    const supportedResult = await supported;
    expect(supportedResult).toEqual(SUPPORTED_INPUT);
    if (supportedResult.status !== 'supported') {
      throw new Error('Expected supported input result.');
    }
    expect(supportedResult).not.toBe(SUPPORTED_INPUT);
    expect(Object.isFrozen(supportedResult)).toBe(true);
    expect(Object.isFrozen(supportedResult.inspection)).toBe(true);
    expect(Object.isFrozen(supportedResult.inspection.notes)).toBe(true);

    const unsupported = engine.probeInputSupport(input);
    worker.emit({
      id: 2,
      operation: 'probeInputSupport',
      type: 'result',
      value: { inspection: null, status: 'unsupported' },
    });
    await expect(unsupported).resolves.toEqual({
      inspection: null,
      status: 'unsupported',
    });
    engine.terminate();
  });

  it('coalesces, freezes, and caches exact runtime output probes', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const target = {
      channels: 2,
      presetId: 'wav-pcm16' as const,
      sampleRate: 48_000,
    };
    const first = engine.probeOutputSupport(target);
    const second = engine.probeOutputSupport(target);
    await flushMicrotasks();

    expect(worker.posts).toEqual([
      {
        message: { id: 1, target, type: 'probeOutputSupport' },
        transfer: [],
      },
    ]);
    worker.emit({
      id: 1,
      operation: 'probeOutputSupport',
      type: 'result',
      value: SUPPORTED_OUTPUT,
    });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual(SUPPORTED_OUTPUT);
    expect(firstResult).toBe(secondResult);
    expect(firstResult).not.toBe(SUPPORTED_OUTPUT);
    expect(Object.isFrozen(firstResult)).toBe(true);
    await expect(engine.probeOutputSupport(target)).resolves.toBe(firstResult);
    expect(worker.posts).toHaveLength(1);
    engine.terminate();
  });

  it('returns static output mismatches without posting to the Worker', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);

    await expect(engine.probeOutputSupport({
      channels: 2,
      presetId: 'mp3-320kbps',
      sampleRate: 24_000,
    })).resolves.toMatchObject({
      reason: 'sample-rate',
      status: 'unsupported-configuration',
    });
    expect(worker.posts).toHaveLength(0);
    engine.terminate();
  });

  it('cancels output-probe subscribers independently and aborts shared work last', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const target = {
      channels: 2,
      presetId: 'wav-pcm16' as const,
      sampleRate: 48_000,
    };
    const firstController = new AbortController();
    const first = engine.probeOutputSupport(target, {
      signal: firstController.signal,
    });
    const retained = engine.probeOutputSupport(target);
    const firstAssertion = expect(first).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
    });
    await flushMicrotasks();
    firstController.abort('first stopped');
    await firstAssertion;
    expect(worker.posts).toHaveLength(1);

    worker.emit({
      id: 1,
      operation: 'probeOutputSupport',
      type: 'result',
      value: SUPPORTED_OUTPUT,
    });
    await expect(retained).resolves.toMatchObject({ status: 'supported' });

    const otherTarget = { ...target, sampleRate: 44_100 };
    const lastController = new AbortController();
    const last = engine.probeOutputSupport(otherTarget, {
      signal: lastController.signal,
    });
    const lastAssertion = expect(last).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
    });
    await flushMicrotasks();
    lastController.abort('last stopped');
    await lastAssertion;
    expect(worker.posts.at(-1)?.message).toEqual({ id: 2, type: 'cancel' });
    worker.emit({
      error: {
        code: 'OPERATION_ABORTED',
        message: 'last stopped',
        name: 'AudioTranscoderError',
      },
      id: 2,
      type: 'error',
    });
    await Promise.resolve();
    engine.terminate();
  });

  it('rejects output-probe queue errors and never serves cached support after termination', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker, { maxQueued: 0 });
    const active = engine.inspect({ blob: new Blob(['active']) });

    await expect(engine.probeOutputSupport({
      channels: 2,
      presetId: 'wav-pcm16',
      sampleRate: 48_000,
    })).rejects.toMatchObject({ code: 'QUEUE_CAPACITY_EXCEEDED' });
    worker.emit({ id: 1, operation: 'inspect', type: 'result', value: INSPECTION });
    await active;

    const probe = engine.probeOutputSupport({
      channels: 2,
      presetId: 'wav-pcm16',
      sampleRate: 48_000,
    });
    await flushMicrotasks();
    worker.emit({
      id: 2,
      operation: 'probeOutputSupport',
      type: 'result',
      value: SUPPORTED_OUTPUT,
    });
    await probe;
    engine.terminate();
    await expect(engine.probeOutputSupport({
      channels: 2,
      presetId: 'wav-pcm16',
      sampleRate: 48_000,
    })).rejects.toMatchObject({ code: 'WORKER_TERMINATED' });
    expect(worker.posts).toHaveLength(2);
  });

  it('returns the capability manifest supplied for a custom Worker runtime', () => {
    const worker = new WorkerStub();
    const capabilities = {
      ...AUDIO_TRANSCODER_STREAM_CAPABILITIES,
      limits: {
        ...AUDIO_TRANSCODER_STREAM_CAPABILITIES.limits,
        recommendedConcurrency: 2,
      },
    };
    const engine = createAudioTranscoderStreamWorkerEngine({
      capabilities,
      runtime: 'custom',
      workerFactory: () => worker as unknown as Worker,
    });

    expect(engine.getCapabilities()).toBe(capabilities);
    engine.terminate();
  });

  it('keeps custom entries for the default runtime type-safe', () => {
    type Factory = () => Worker;

    expectTypeOf<{}>().toMatchTypeOf<
      CreateAudioTranscoderStreamWorkerEngineOptions
    >();
    expectTypeOf<{ workerFactory: Factory }>().toMatchTypeOf<
      CreateAudioTranscoderStreamWorkerEngineOptions
    >();
    expectTypeOf<{
      runtime: 'custom';
      capabilities: AudioTranscoderStreamCapabilities;
      workerFactory: Factory;
    }>().toMatchTypeOf<CreateAudioTranscoderStreamWorkerEngineOptions>();
    expectTypeOf<{
      capabilities: AudioTranscoderStreamCapabilities;
    }>().not.toMatchTypeOf<CreateAudioTranscoderStreamWorkerEngineOptions>();
    expectTypeOf<{
      capabilities: AudioTranscoderStreamCapabilities;
      workerFactory: Factory;
    }>().not.toMatchTypeOf<CreateAudioTranscoderStreamWorkerEngineOptions>();
    expectTypeOf<{
      runtime: 'custom';
      capabilities: AudioTranscoderStreamCapabilities;
    }>().not.toMatchTypeOf<CreateAudioTranscoderStreamWorkerEngineOptions>();
    expectTypeOf<{
      runtime: 'custom';
      workerFactory: Factory;
    }>().not.toMatchTypeOf<CreateAudioTranscoderStreamWorkerEngineOptions>();
    expectTypeOf<AudioTranscoderStreamWorkerRuntimeOptions<Factory>>()
      .toMatchTypeOf<
        | AudioTranscoderCustomStreamWorkerRuntimeOptions<Factory>
        | AudioTranscoderDefaultStreamWorkerRuntimeOptions<Factory>
      >();
  });

  it('uses built-in capabilities with a custom default-runtime entry', () => {
    const worker = new WorkerStub();
    const workerFactory = vi.fn(() => worker as unknown as Worker);
    const engine = createAudioTranscoderStreamWorkerEngine({ workerFactory });

    expect(workerFactory).toHaveBeenCalledOnce();
    expect(engine.getCapabilities()).toBe(AUDIO_TRANSCODER_STREAM_CAPABILITIES);
    engine.terminate();
  });

  it('rejects invalid runtime and capability combinations from JavaScript', () => {
    const workerFactory = vi.fn(() => new WorkerStub() as unknown as Worker);
    const capabilities = {
      ...AUDIO_TRANSCODER_STREAM_CAPABILITIES,
      codecRuntime: {
        ...AUDIO_TRANSCODER_STREAM_CAPABILITIES.codecRuntime,
        encoderAdapter: 'custom-runtime',
      },
    };
    const invalidOptions: unknown[] = [
      null,
      1,
      { runtime: 'unknown' },
      { workerFactory: 1 },
      { capabilities, workerFactory },
      { capabilities, runtime: 'default', workerFactory },
      { capabilities, runtime: 'custom' },
      { runtime: 'custom', workerFactory },
      { capabilities: null, runtime: 'custom', workerFactory },
      { capabilities: {}, runtime: 'custom', workerFactory },
      { capabilities: { limits: null }, runtime: 'custom', workerFactory },
      { capabilities: { limits: 1 }, runtime: 'custom', workerFactory },
    ];

    for (const options of invalidOptions) {
      expect(() =>
        createAudioTranscoderStreamWorkerEngine(
          options as CreateAudioTranscoderStreamWorkerEngineOptions,
        ),
      ).toThrow(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }));
    }
    expect(workerFactory).not.toHaveBeenCalled();
  });

  it('waits for the destination close before settling or draining', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    let finishClose = (): void => undefined;
    const closeGate = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const output = new WritableStream({ close: () => closeGate });
    const result = engine.transcode(
      { blob: new Blob(['a']) },
      { presetId: 'wav-pcm16' },
      output,
    );
    const next = engine.inspect({ blob: new Blob(['b']) });
    const close = worker.closePostedOutput(1);
    worker.emit({ id: 1, operation: 'transcode', type: 'result', value: RESULT });
    worker.emit({ id: 1, operation: 'transcode', type: 'result', value: RESULT });
    const settled = vi.fn();
    void result.then(settled, settled);
    await Promise.resolve();

    expect(settled).not.toHaveBeenCalled();
    expect(worker.posts).toHaveLength(1);
    finishClose();
    await close;
    await expect(result).resolves.toMatchObject({ bytesWritten: 64 });
    expect(worker.posts[1]?.message).toMatchObject({ id: 2, type: 'inspect' });
    worker.emit({ id: 2, operation: 'inspect', type: 'result', value: INSPECTION });
    await next;
    engine.terminate();
  });

  it('forwards output writes and rejects destination write failures', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const writes: AudioStreamOutputChunk[] = [];
    const successful = engine.transcode(
      { blob: new Blob(['a']) },
      { presetId: 'wav-pcm16' },
      new WritableStream({
        write: (chunk) => {
          writes.push(chunk);
        },
      }),
    );
    const chunk: AudioStreamOutputChunk = {
      data: new Uint8Array([1, 2, 3]),
      position: 4,
      type: 'write',
    };
    await worker.writePostedOutput(1, chunk);
    await worker.closePostedOutput(1);
    worker.emit({ id: 1, operation: 'transcode', type: 'result', value: RESULT });
    await successful;
    expect(writes).toEqual([chunk]);

    const writeError = new Error('destination write failed');
    const failed = engine.transcode(
      { blob: new Blob(['b']) },
      { presetId: 'wav-pcm16' },
      new WritableStream({
        write() {
          throw writeError;
        },
      }),
    );
    await expect(worker.writePostedOutput(2, chunk)).rejects.toBe(writeError);
    worker.emit({ id: 2, operation: 'transcode', type: 'result', value: RESULT });
    await expect(failed).rejects.toBe(writeError);
    engine.terminate();
  });

  it('propagates destination close failures', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const closeError = new Error('destination close failed');
    const result = engine.transcode(
      { blob: new Blob(['a']) },
      { presetId: 'wav-pcm16' },
      new WritableStream({
        close() {
          throw closeError;
        },
      }),
    );

    await expect(worker.closePostedOutput(1)).rejects.toBe(closeError);
    worker.emit({
      error: { message: 'worker observed close failure', name: 'Error' },
      id: 1,
      type: 'error',
    });
    await expect(result).rejects.toThrow('worker observed close failure');
    engine.terminate();
  });

  it('rejects invalid, locked, and pre-aborted transcode outputs', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    await expect(
      engine.transcode(
        { blob: new Blob(['a']) },
        { presetId: 'wav-pcm16' },
        {} as WritableStream<AudioStreamOutputChunk>,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });

    const locked = new WritableStream<AudioStreamOutputChunk>();
    const writer = locked.getWriter();
    await expect(
      engine.transcode(
        { blob: new Blob(['a']) },
        { presetId: 'wav-pcm16' },
        locked,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    writer.releaseLock();

    const controller = new AbortController();
    controller.abort('already stopped');
    const untouched = new WritableStream<AudioStreamOutputChunk>();
    await expect(
      engine.transcode(
        { blob: new Blob(['a']) },
        { presetId: 'wav-pcm16' },
        untouched,
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'already stopped',
    });
    expect(untouched.locked).toBe(false);
    expect(worker.posts).toHaveLength(0);
    engine.terminate();
  });

  it('rejects transcode after termination without locking its destination', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const abort = vi.fn();
    const output = new WritableStream<AudioStreamOutputChunk>({ abort });
    engine.terminate();

    await expect(
      engine.transcode(
        { blob: new Blob(['a']) },
        { presetId: 'wav-pcm16' },
        output,
      ),
    ).rejects.toMatchObject({ code: 'WORKER_TERMINATED' });
    expect(output.locked).toBe(false);
    expect(abort).not.toHaveBeenCalled();
    expect(worker.posts).toHaveLength(0);
  });

  it('aborts bridged outputs on post failure and ignores abort cleanup errors', async () => {
    const worker = new WorkerStub();
    worker.throwNextOperation = true;
    const engine = createEngine(worker);
    const abortError = new Error('destination abort failed');
    const output = new WritableStream<AudioStreamOutputChunk>({
      abort() {
        throw abortError;
      },
    });
    const result = engine.transcode(
      { blob: new Blob(['a']) },
      { presetId: 'wav-pcm16' },
      output,
    );

    await expect(result).rejects.toThrow('post failed');
    await flushMicrotasks();
    expect(output.locked).toBe(false);
    engine.terminate();
  });

  it('does not settle a failed post twice when disposal wins output cleanup', async () => {
    const worker = new WorkerStub();
    worker.throwNextOperation = true;
    const engine = createEngine(worker);
    const outputAbort = deferred<void>();
    const output = new WritableStream<AudioStreamOutputChunk>({
      abort: () => outputAbort.promise,
    });
    const result = engine.transcode(
      { blob: new Blob(['a']) },
      { presetId: 'wav-pcm16' },
      output,
    );

    const disposal = engine.dispose();
    await expect(result).rejects.toMatchObject({ code: 'WORKER_TERMINATED' });
    outputAbort.resolve();
    await disposal;
    expect(output.locked).toBe(false);
  });

  it('releases a closed bridge on termination and ignores late settlement', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const closed = engine.transcode(
      { blob: new Blob(['a']) },
      { presetId: 'wav-pcm16' },
      new WritableStream(),
    );
    await worker.closePostedOutput(1);
    engine.terminate();
    await expect(closed).rejects.toMatchObject({ code: 'WORKER_TERMINATED' });

    const failureWorker = new WorkerStub();
    const failureEngine = createEngine(failureWorker);
    const failed = failureEngine.transcode(
      { blob: new Blob(['b']) },
      { presetId: 'wav-pcm16' },
      new WritableStream(),
    );
    failureWorker.emit({
      id: 1,
      operation: 'transcode',
      type: 'result',
      value: RESULT,
    });
    failureWorker.emitError('worker failed after result');
    await expect(failed).rejects.toMatchObject({ code: 'WORKER_FAILURE' });
  });

  it('settles an output bridge only once during close and terminate races', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    let finishClose = (): void => undefined;
    const closeGate = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const result = engine.transcode(
      { blob: new Blob(['a']) },
      { presetId: 'wav-pcm16' },
      new WritableStream({ close: () => closeGate }),
    );
    const close = worker.closePostedOutput(1);

    engine.terminate();
    finishClose();
    await close.catch(() => undefined);
    await expect(result).rejects.toMatchObject({ code: 'WORKER_TERMINATED' });
  });

  it('aborts a queued transcode without posting or retaining its output', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const active = engine.inspect({ blob: new Blob(['a']) });
    const controller = new AbortController();
    const abort = vi.fn();
    const output = new WritableStream<AudioStreamOutputChunk>({ abort });
    const queued = engine.transcode(
      { blob: new Blob(['b']) },
      { presetId: 'wav-pcm16' },
      output,
      { signal: controller.signal },
    );
    controller.abort('remove output');

    await expect(queued).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'remove output',
    });
    await flushMicrotasks();
    expect(abort).toHaveBeenCalledOnce();
    expect(output.locked).toBe(false);
    expect(worker.posts).toHaveLength(1);
    worker.emit({ id: 1, operation: 'inspect', type: 'result', value: INSPECTION });
    await active;
    engine.terminate();
  });

  it.each([
    [
      { code: 'UNSUPPORTED_INPUT' as const, message: 'no codec', name: 'AudioTranscoderError' },
      'AudioTranscoderError',
    ],
    [{ message: 'plain error', name: 'TypeError' }, 'TypeError'],
  ])('deserializes worker errors %#', async (error, name) => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const result = engine.inspect({ blob: new Blob(['x']) });
    worker.emit({ error, id: 1, type: 'error' });
    await expect(result).rejects.toMatchObject({ message: error.message, name });
    engine.terminate();
  });

  it('aborts and unlocks output before draining after a Worker error', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const abort = vi.fn();
    const output = new WritableStream<AudioStreamOutputChunk>({ abort });
    const failed = engine.transcode(
      { blob: new Blob(['a']) },
      { presetId: 'wav-pcm16' },
      output,
    );
    const next = engine.inspect({ blob: new Blob(['b']) });

    worker.emit({
      error: { message: 'codec failed', name: 'Error' },
      id: 1,
      type: 'error',
    });

    await expect(failed).rejects.toMatchObject({ message: 'codec failed' });
    expect(abort).toHaveBeenCalledOnce();
    expect(abort.mock.calls[0]?.[0]).toMatchObject({ message: 'codec failed' });
    expect(output.locked).toBe(false);
    expect(worker.posts[1]?.message).toMatchObject({ id: 2, type: 'inspect' });
    worker.emit({ id: 2, operation: 'inspect', type: 'result', value: INSPECTION });
    await next;
    engine.terminate();
  });

  it('keeps the Worker error primary when destination abort also fails', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const output = new WritableStream<AudioStreamOutputChunk>({
      abort() {
        throw new Error('destination abort failed');
      },
    });
    const result = engine.transcode(
      { blob: new Blob(['a']) },
      { presetId: 'wav-pcm16' },
      output,
    );

    worker.emit({
      error: { message: 'codec failed', name: 'Error' },
      id: 1,
      type: 'error',
    });

    await expect(result).rejects.toMatchObject({ message: 'codec failed' });
    expect(output.locked).toBe(false);
    engine.terminate();
  });

  it('rejects pre-aborted and queued-aborted jobs without posting them', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const pre = new AbortController();
    pre.abort('already stopped');
    await expect(
      engine.inspect({ blob: new Blob(['x']) }, { signal: pre.signal }),
    ).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'already stopped',
    });

    const active = engine.inspect({ blob: new Blob(['a']) });
    const queuedController = new AbortController();
    const queued = engine.inspect(
      { blob: new Blob(['b']) },
      { signal: queuedController.signal },
    );
    queuedController.abort('remove queued');
    await expect(queued).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'remove queued',
    });
    expect(worker.posts).toHaveLength(1);
    worker.emit({ id: 1, operation: 'inspect', type: 'result', value: INSPECTION });
    await active;
    engine.terminate();
  });

  it('waits for terminal cleanup after running cancellation', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const controller = new AbortController();
    const active = engine.inspect(
      { blob: new Blob(['a']) },
      { signal: controller.signal },
    );
    const next = engine.inspect({ blob: new Blob(['b']) });
    controller.abort('stop running');

    expect(worker.posts[1]?.message).toEqual({ id: 1, type: 'cancel' });
    expect(worker.posts).toHaveLength(2);
    const settled = vi.fn();
    void active.then(settled, settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    worker.emit({ id: 1, progress: PROGRESS, type: 'progress' });
    expect(worker.posts).toHaveLength(2);
    worker.emit({
      error: { message: 'worker canceled', name: 'Error' },
      id: 1,
      type: 'error',
    });
    await expect(active).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'stop running',
    });
    expect(worker.posts[2]?.message).toMatchObject({ id: 2, type: 'inspect' });
    worker.emit({ id: 2, operation: 'inspect', type: 'result', value: INSPECTION });
    await next;
    engine.terminate();
  });

  it('keeps cancellation primary without waiting for the Worker stream to close', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const controller = new AbortController();
    const abort = vi.fn((_reason: unknown) => {
      throw new Error('destination abort failed');
    });
    const output = new WritableStream<AudioStreamOutputChunk>({ abort });
    const active = engine.transcode(
      { blob: new Blob(['a']) },
      { presetId: 'wav-pcm16' },
      output,
      { signal: controller.signal },
    );
    const next = engine.inspect({ blob: new Blob(['b']) });
    const settled = vi.fn();
    void active.then(settled, settled);

    controller.abort('stop transcode');
    await flushMicrotasks();

    expect(abort).toHaveBeenCalledOnce();
    expect(abort.mock.calls[0]?.[0]).toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'stop transcode',
    });
    expect(output.locked).toBe(false);
    expect(settled).not.toHaveBeenCalled();
    expect(worker.posts).toHaveLength(2);
    expect(worker.posts[1]?.message).toEqual({ id: 1, type: 'cancel' });

    worker.emit({ id: 1, operation: 'transcode', type: 'result', value: RESULT });
    await expect(active).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'stop transcode',
    });
    expect(worker.posts[2]?.message).toMatchObject({ id: 2, type: 'inspect' });
    worker.emit({ id: 2, operation: 'inspect', type: 'result', value: INSPECTION });
    await next;
    engine.terminate();
  });

  it('preserves a local cancellation when the Worker fails during cleanup', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const controller = new AbortController();
    const active = engine.inspect(
      { blob: new Blob(['a']) },
      { signal: controller.signal },
    );
    const queued = engine.inspect({ blob: new Blob(['b']) });
    controller.abort('stop running');
    worker.emitError('cleanup crashed');

    await expect(active).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'stop running',
    });
    await expect(queued).rejects.toMatchObject({ code: 'WORKER_FAILURE' });
    expect(worker.terminateCalls).toBe(1);
  });

  it('cancels when a progress listener fails, even if cancel posting fails', async () => {
    const worker = new WorkerStub();
    worker.throwOnCancel = true;
    const engine = createEngine(worker);
    const listenerError = new Error('UI failed');
    const result = engine.transcode(
      { blob: new Blob(['a']) },
      { presetId: 'wav-pcm16' },
      new WritableStream(),
      {
        onProgress() {
          throw listenerError;
        },
      },
    );

    worker.emit({ id: 1, progress: PROGRESS, type: 'progress' });
    worker.emit({ id: 1, progress: PROGRESS, type: 'progress' });
    await worker.abortPostedOutput(1, listenerError);
    worker.emit({ id: 1, operation: 'transcode', type: 'result', value: RESULT });
    await expect(result).rejects.toBe(listenerError);
    engine.terminate();
  });

  it('does not cancel twice when a progress listener aborts and then throws', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const controller = new AbortController();
    const result = engine.transcode(
      { blob: new Blob(['a']) },
      { presetId: 'wav-pcm16' },
      new WritableStream(),
      {
        onProgress() {
          controller.abort('listener stopped');
          throw new Error('late listener failure');
        },
        signal: controller.signal,
      },
    );

    worker.emit({ id: 1, progress: PROGRESS, type: 'progress' });
    await worker.abortPostedOutput(1, 'listener stopped');
    worker.emit({ id: 1, operation: 'transcode', type: 'result', value: RESULT });
    await expect(result).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'listener stopped',
    });
    expect(worker.posts.filter(({ message }) => message.type === 'cancel')).toHaveLength(1);
    engine.terminate();
  });

  it('recovers from synchronous post failures and drains the next job', async () => {
    const worker = new WorkerStub();
    worker.throwNextOperation = true;
    const engine = createEngine(worker);
    const failed = engine.inspect({ blob: new Blob(['a']) });
    const next = engine.inspect({ blob: new Blob(['b']) });

    await expect(failed).rejects.toThrow('post failed');
    expect(worker.posts[0]?.message).toMatchObject({ id: 2, type: 'inspect' });
    worker.emit({ id: 2, operation: 'inspect', type: 'result', value: INSPECTION });
    await next;
    engine.terminate();
  });

  it.each(['error', 'messageerror'] as const)(
    'fails active and queued work on worker %s',
    async (failureType) => {
      const worker = new WorkerStub();
      const engine = createEngine(worker);
      const active = engine.inspect({ blob: new Blob(['a']) });
      const queued = engine.inspect({ blob: new Blob(['b']) });
      if (failureType === 'error') {
        worker.emitError('stream crashed');
      } else {
        worker.emitMessageError();
      }

      await expect(active).rejects.toMatchObject({ code: 'WORKER_FAILURE' });
      await expect(queued).rejects.toMatchObject({ code: 'WORKER_FAILURE' });
      expect(worker.terminateCalls).toBe(1);
      await expect(
        engine.inspect({ blob: new Blob(['c']) }),
      ).rejects.toMatchObject({ code: 'WORKER_TERMINATED' });
      worker.emitError('late failure');
    },
  );

  it('uses a fallback message for message-less Worker errors', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const active = engine.inspect({ blob: new Blob(['a']) });
    worker.emitError('');
    await expect(active).rejects.toMatchObject({
      code: 'WORKER_FAILURE',
      message: 'Audio stream worker failed.',
    });
  });

  it('hard-bounds waiting work and releases capacity after queued cancellation', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker, { maxQueued: 1 });
    const active = engine.inspect({ blob: new Blob(['a']) });
    const controller = new AbortController();
    const queued = engine.inspect(
      { blob: new Blob(['b']) },
      { signal: controller.signal },
    );
    const abort = vi.fn();
    const rejectedOutput = new WritableStream<AudioStreamOutputChunk>({ abort });

    await expect(
      engine.transcode(
        { blob: new Blob(['c']) },
        { presetId: 'wav-pcm16' },
        rejectedOutput,
      ),
    ).rejects.toMatchObject({
      code: 'QUEUE_CAPACITY_EXCEEDED',
      message:
        'Audio stream Worker queue is full (maxQueued: 1; active operation excluded).',
    });
    expect(rejectedOutput.locked).toBe(false);
    expect(abort).not.toHaveBeenCalled();
    expect(worker.posts).toHaveLength(1);

    controller.abort('remove queued');
    const replacement = engine.inspect({ blob: new Blob(['d']) });
    await expect(queued).rejects.toMatchObject({
      code: 'OPERATION_ABORTED',
      message: 'remove queued',
    });
    worker.emit({ id: 1, operation: 'inspect', type: 'result', value: INSPECTION });
    await active;
    await flushMicrotasks();
    expect(worker.posts[1]?.message).toMatchObject({ id: 3, type: 'inspect' });
    worker.emit({ id: 3, operation: 'inspect', type: 'result', value: INSPECTION });
    await replacement;
    await engine.dispose();
  });

  it('ignores a detached queued-abort callback after cancellation', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const active = engine.inspect({ blob: new Blob(['a']) });
    const abort = createRetainedAbortSignal();
    const queued = engine.inspect(
      { blob: new Blob(['b']) },
      { signal: abort.signal },
    );

    abort.abort('remove queued');
    await expect(queued).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    abort.invokeDetachedListener();
    worker.emit({ id: 1, operation: 'inspect', type: 'result', value: INSPECTION });
    await active;
    await engine.dispose();
  });

  it('awaits active and queued output aborts during idempotent disposal', async () => {
    const worker = new WorkerStub();
    const engine = createEngine(worker, { maxQueued: 1 });
    const firstAbort = deferred<void>();
    const secondAbort = deferred<void>();
    const firstOutput = new WritableStream<AudioStreamOutputChunk>({
      abort: () => firstAbort.promise,
    });
    const secondOutput = new WritableStream<AudioStreamOutputChunk>({
      abort: () => secondAbort.promise,
    });
    const active = engine.transcode(
      { blob: new Blob(['a']) },
      { presetId: 'wav-pcm16' },
      firstOutput,
    );
    const queued = engine.transcode(
      { blob: new Blob(['b']) },
      { presetId: 'wav-pcm16' },
      secondOutput,
    );

    const disposal = engine.dispose();
    expect(engine.dispose()).toBe(disposal);
    engine.terminate();
    expect(worker.terminateCalls).toBe(1);
    await expect(active).rejects.toMatchObject({ code: 'WORKER_TERMINATED' });
    await expect(queued).rejects.toMatchObject({ code: 'WORKER_TERMINATED' });
    let disposed = false;
    void disposal.then(() => {
      disposed = true;
    });
    await flushMicrotasks();
    expect(disposed).toBe(false);
    expect(firstOutput.locked).toBe(true);
    expect(secondOutput.locked).toBe(true);

    firstAbort.resolve();
    await flushMicrotasks();
    expect(firstOutput.locked).toBe(false);
    expect(secondOutput.locked).toBe(true);
    expect(disposed).toBe(false);

    secondAbort.resolve();
    await disposal;
    expect(firstOutput.locked).toBe(false);
    expect(secondOutput.locked).toBe(false);
    expect(disposed).toBe(true);
  });

  it.each([-1, 1.5, 65, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid maxQueued %s before creating a Worker',
    (maxQueued) => {
      const workerFactory = vi.fn();
      expect(() =>
        createAudioTranscoderStreamWorkerEngine({ maxQueued, workerFactory }),
      ).toThrow(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }));
      expect(workerFactory).not.toHaveBeenCalled();
    },
  );

  it('accepts queue-capacity boundaries', async () => {
    const minimum = createEngine(new WorkerStub(), { maxQueued: 0 });
    const maximum = createEngine(new WorkerStub(), { maxQueued: 64 });

    await Promise.all([minimum.dispose(), maximum.dispose()]);
  });

  it('uses default queue limits for a legacy capability manifest', async () => {
    const capabilities = {
      ...AUDIO_TRANSCODER_STREAM_CAPABILITIES,
      limits: {
        ...AUDIO_TRANSCODER_STREAM_CAPABILITIES.limits,
        queue: undefined,
      },
    } as unknown as typeof AUDIO_TRANSCODER_STREAM_CAPABILITIES;
    const engine = createEngine(new WorkerStub(), {
      capabilities,
      runtime: 'custom',
    });

    expect(engine.getCapabilities()).toBe(capabilities);
    await engine.dispose();
  });

  it('terminates idempotently with and without pending work', async () => {
    const idleWorker = new WorkerStub();
    const idle = createEngine(idleWorker);
    idle.terminate();
    idle.terminate();
    await idle.dispose();
    expect(idleWorker.terminateCalls).toBe(1);

    const worker = new WorkerStub();
    const engine = createEngine(worker);
    const active = engine.inspect({ blob: new Blob(['a']) });
    const queued = engine.inspect({ blob: new Blob(['b']) });
    engine.terminate();
    const disposal = engine.dispose();
    await expect(active).rejects.toMatchObject({ code: 'WORKER_TERMINATED' });
    await expect(queued).rejects.toMatchObject({ code: 'WORKER_TERMINATED' });
    await disposal;
  });

  it('uses the native module Worker and fails clearly without Workers', () => {
    const worker = new WorkerStub();
    const WorkerConstructor = vi.fn(function WorkerConstructor(
      _url: URL,
      _options: WorkerOptions,
    ) {
      return worker;
    });
    vi.stubGlobal('Worker', WorkerConstructor);
    const engine = createAudioTranscoderStreamWorkerEngine();
    expect(WorkerConstructor).toHaveBeenCalledWith(expect.any(URL), {
      name: 'dsub-audio-stream-transcoder',
      type: 'module',
    });
    engine.terminate();

    vi.stubGlobal('Worker', undefined);
    expect(() => createAudioTranscoderStreamWorkerEngine()).toThrow(
      expect.objectContaining({ code: 'WORKER_UNAVAILABLE' }),
    );
  });
});

interface WorkerPost {
  readonly message: AudioStreamWorkerRequest;
  readonly transfer: readonly Transferable[];
}

class WorkerStub {
  readonly listeners = {
    error: [] as ((event: ErrorEvent) => void)[],
    message: [] as ((event: MessageEvent<AudioStreamWorkerResponse>) => void)[],
    messageerror: [] as (() => void)[],
  };
  readonly posts: WorkerPost[] = [];
  terminateCalls = 0;
  throwNextOperation = false;
  throwOnCancel = false;

  addEventListener(type: string, listener: EventListener): void {
    if (type === 'message') {
      this.listeners.message.push(
        listener as unknown as (
          event: MessageEvent<AudioStreamWorkerResponse>,
        ) => void,
      );
    } else if (type === 'error') {
      this.listeners.error.push(listener as unknown as (event: ErrorEvent) => void);
    } else {
      this.listeners.messageerror.push(listener as unknown as () => void);
    }
  }

  emit(message: AudioStreamWorkerResponse): void {
    for (const listener of this.listeners.message) {
      listener({ data: message } as MessageEvent<AudioStreamWorkerResponse>);
    }
  }

  emitError(message: string): void {
    for (const listener of this.listeners.error) {
      listener({ message } as ErrorEvent);
    }
  }

  emitMessageError(): void {
    for (const listener of this.listeners.messageerror) {
      listener();
    }
  }

  postMessage(
    message: AudioStreamWorkerRequest,
    transfer: Transferable[] = [],
  ): void {
    if (message.type === 'cancel' && this.throwOnCancel) {
      throw new Error('cancel failed');
    }
    if (message.type !== 'cancel' && this.throwNextOperation) {
      this.throwNextOperation = false;
      throw new Error('post failed');
    }
    this.posts.push({ message, transfer });
  }

  terminate(): void {
    this.terminateCalls += 1;
  }

  async abortPostedOutput(id: number, reason: unknown): Promise<void> {
    const writer = this.postedOutput(id).getWriter();
    try {
      await writer.abort(reason);
    } finally {
      writer.releaseLock();
    }
  }

  async closePostedOutput(id: number): Promise<void> {
    const writer = this.postedOutput(id).getWriter();
    try {
      await writer.close();
    } finally {
      writer.releaseLock();
    }
  }

  async writePostedOutput(
    id: number,
    chunk: AudioStreamOutputChunk,
  ): Promise<void> {
    const writer = this.postedOutput(id).getWriter();
    try {
      await writer.write(chunk);
    } finally {
      writer.releaseLock();
    }
  }

  private postedOutput(id: number): WritableStream<AudioStreamOutputChunk> {
    const post = this.posts.find(
      ({ message }) => message.type === 'transcode' && message.id === id,
    );
    if (post?.message.type !== 'transcode') {
      throw new Error(`No transcode output was posted for operation ${id}.`);
    }
    return post.message.output;
  }
}

function createEngine(
  worker: WorkerStub,
  options: EngineHarnessOptions = {},
) {
  const workerFactory = () => worker as unknown as Worker;
  return options.runtime === 'custom'
    ? createAudioTranscoderStreamWorkerEngine({ ...options, workerFactory })
    : createAudioTranscoderStreamWorkerEngine({ ...options, workerFactory });
}

type EngineHarnessOptions =
  | {
      readonly capabilities: AudioTranscoderStreamCapabilities;
      readonly maxQueued?: number;
      readonly runtime: 'custom';
    }
  | {
      readonly capabilities?: never;
      readonly maxQueued?: number;
      readonly runtime?: 'default';
    };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function createRetainedAbortSignal() {
  let aborted = false;
  let activeListener: (() => void) | undefined;
  let detachedListener: (() => void) | undefined;
  let reason: unknown;
  const signal = {
    addEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
      activeListener =
        typeof listener === 'function'
          ? () => listener.call(signal, new Event('abort'))
          : () => listener.handleEvent(new Event('abort'));
    },
    get aborted() {
      return aborted;
    },
    get reason() {
      return reason;
    },
    removeEventListener() {
      detachedListener = activeListener;
      activeListener = undefined;
    },
  } as unknown as AbortSignal;
  return {
    abort(abortReason: unknown): void {
      aborted = true;
      reason = abortReason;
      activeListener?.();
    },
    invokeDetachedListener(): void {
      detachedListener?.();
    },
    signal,
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}
