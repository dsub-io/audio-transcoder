import type {
  AudioStreamInput,
  AudioStreamInputSupportResult,
  AudioStreamInspection,
  AudioStreamOperationOptions,
  AudioStreamOutput,
  AudioStreamOutputChunk,
  AudioStreamOutputProbeOptions,
  AudioStreamOutputProbeTarget,
  AudioStreamOutputSupportResult,
  AudioStreamTarget,
  AudioStreamTranscodeResult,
  AudioTranscoderStreamWorkerEngine,
  AudioTranscoderStreamWorkerRuntimeOptions,
  CreateAudioTranscoderStreamWorkerEngineOptions,
} from './contracts.js';
import type {
  AudioStreamWorkerRequest,
  AudioStreamWorkerResponse,
  StreamWorkerOperationOptions,
} from './protocol.js';
import {
  createOperationAbortedError,
  createWorkerTerminatedError,
} from '../engine/operation-errors.js';
import { AudioTranscoderError } from '../errors.js';
import { packageEngineInfo } from '../package-metadata.js';
import { deserializeWorkerError } from '../worker/serialized-error.js';
import { AUDIO_TRANSCODER_STREAM_CAPABILITIES } from './capabilities.js';
import type { AudioTranscoderStreamCapabilities } from './capabilities.js';
import {
  createAudioStreamOutputProbeCoordinator,
  probeAudioStreamOutputSupport,
} from './output-support-probe.js';

type StreamOperation =
  | 'inspect'
  | 'probeInputSupport'
  | 'probeOutputSupport'
  | 'transcode';
type StreamResult =
  | AudioStreamInputSupportResult
  | AudioStreamInspection
  | AudioStreamOutputSupportResult
  | AudioStreamTranscodeResult;

interface QueuedOperation {
  abortListener: (() => void) | undefined;
  cancelReason: unknown;
  cancelRequested: boolean;
  readonly id: number;
  readonly onProgress: AudioStreamOperationOptions['onProgress'];
  readonly outputBridge: OutputBridge | undefined;
  posted: boolean;
  readonly reject: (reason: unknown) => void;
  readonly request: AudioStreamWorkerRequest;
  readonly resolve: (value: StreamResult) => void;
  settling: boolean;
  readonly signal: AbortSignal | undefined;
  readonly transfer: Transferable[];
}

interface OutputBridgeSettlement {
  readonly reason: unknown;
  readonly status: 'closed' | 'failed';
}

interface OutputBridge {
  abort(reason: unknown): Promise<void>;
  readonly completion: Promise<OutputBridgeSettlement>;
  readonly stream: AudioStreamOutput;
}

/** Creates a serial, bounded-memory module Worker for streaming operations. */
export function createAudioTranscoderStreamWorkerEngine(
  options: CreateAudioTranscoderStreamWorkerEngineOptions = {},
): AudioTranscoderStreamWorkerEngine {
  const { capabilities, workerFactory } =
    resolveAudioTranscoderStreamWorkerRuntime(options);
  const maxQueued = resolveMaxQueued(options.maxQueued, capabilities);
  const worker = createWorker(workerFactory);
  const outputProbeCoordinator = createAudioStreamOutputProbeCoordinator();
  const queue: QueuedOperation[] = [];
  const pendingOutputCleanups = new Set<Promise<void>>();
  let active: QueuedOperation | undefined;
  let disposal: Promise<void> | undefined;
  let nextOperationId = 1;
  let terminated = false;

  const detachAbort = (operation: QueuedOperation): void => {
    if (operation.abortListener !== undefined) {
      operation.signal?.removeEventListener('abort', operation.abortListener);
      operation.abortListener = undefined;
    }
  };

  const drain = (): void => {
    if (terminated || active !== undefined) {
      return;
    }
    const operation = queue.shift();
    if (operation === undefined) {
      return;
    }
    active = operation;
    operation.posted = true;
    try {
      worker.postMessage(operation.request, operation.transfer);
    } catch (error) {
      operation.settling = true;
      detachAbort(operation);
      void trackOutputBridgeAbort(operation, error).then(() => {
        if (active === operation) {
          active = undefined;
          operation.reject(error);
          drain();
        }
      });
    }
  };

  const trackOutputBridgeAbort = (
    operation: QueuedOperation,
    reason: unknown,
  ): Promise<void> => {
    const cleanup = waitForOutputBridgeAbort(operation, reason);
    pendingOutputCleanups.add(cleanup);
    void cleanup.then(() => pendingOutputCleanups.delete(cleanup));
    return cleanup;
  };

  const rejectAll = async (error: AudioTranscoderError): Promise<void> => {
    const operations = active === undefined ? queue.splice(0) : [active, ...queue.splice(0)];
    active = undefined;
    const cleanups: Promise<void>[] = [];
    for (const operation of operations) {
      detachAbort(operation);
      cleanups.push(trackOutputBridgeAbort(operation, error));
      operation.reject(
        operation.cancelRequested ? operation.cancelReason : error,
      );
    }
    await Promise.all([...cleanups, ...pendingOutputCleanups]);
  };

  const beginDisposal = (error: AudioTranscoderError): Promise<void> => {
    if (disposal === undefined) {
      terminated = true;
      worker.terminate();
      disposal = rejectAll(error);
      outputProbeCoordinator.clear(error);
    }
    return disposal;
  };

  const failWorker = (message: string): void => {
    if (!terminated) {
      void beginDisposal(new AudioTranscoderError('WORKER_FAILURE', message));
    }
  };

  worker.addEventListener(
    'message',
    (event: MessageEvent<AudioStreamWorkerResponse>) => {
      const response = event.data;
      const operation = active;
      if (operation === undefined || response.id !== operation.id) {
        return;
      }
      if (response.type === 'progress') {
        if (!operation.cancelRequested) {
          try {
            operation.onProgress?.(Object.freeze({ ...response.progress }));
          } catch (error) {
            cancelActive(operation, error);
          }
        }
        return;
      }
      if (operation.settling) {
        return;
      }
      operation.settling = true;
      detachAbort(operation);
      void (async () => {
        const operationError = operation.cancelRequested
          ? operation.cancelReason
          : response.type === 'error'
            ? deserializeWorkerError(response.error)
            : undefined;
        if (operation.cancelRequested || response.type === 'error') {
          await waitForOutputBridgeAbort(operation, operationError);
        }
        const outputSettlement =
          !operation.cancelRequested && response.type === 'result'
            ? await operation.outputBridge?.completion
            : undefined;
        if (active !== operation) {
          return;
        }
        active = undefined;
        if (operation.cancelRequested) {
          operation.reject(operation.cancelReason);
        } else if (response.type === 'error') {
          operation.reject(operationError);
        } else if (outputSettlement?.status === 'failed') {
          operation.reject(outputSettlement.reason);
        } else {
          operation.resolve(freezeResult(response.operation, response.value));
        }
        drain();
      })();
    },
  );
  worker.addEventListener('error', (event: ErrorEvent) => {
    failWorker(event.message || 'Audio stream worker failed.');
  });
  worker.addEventListener('messageerror', () => {
    failWorker('Audio stream worker returned an unreadable message.');
  });

  const enqueue = <T extends StreamResult>(
    operation: StreamOperation,
    createRequest: (id: number) => AudioStreamWorkerRequest,
    operationOptions: AudioStreamOperationOptions,
    transfer: Transferable[],
    outputBridge?: OutputBridge,
  ): Promise<T> => {
    const admissionError = getAdmissionError(operationOptions.signal);
    if (admissionError !== undefined) {
      return Promise.reject(admissionError);
    }
    const id = nextOperationId;
    nextOperationId += 1;

    return new Promise<T>((resolve, reject) => {
      const queued: QueuedOperation = {
        abortListener: undefined,
        cancelReason: undefined,
        cancelRequested: false,
        id,
        onProgress:
          operation === 'transcode' ? operationOptions.onProgress : undefined,
        outputBridge,
        posted: false,
        reject,
        request: createRequest(id),
        resolve: (value) => resolve(value as T),
        settling: false,
        signal: operationOptions.signal,
        transfer,
      };
      const signal = operationOptions.signal;
      if (signal !== undefined) {
        queued.abortListener = (): void => {
          const error = createOperationAbortedError(signal);
          if (queued.posted) {
            cancelActive(queued, error);
          } else {
            const queueIndex = queue.indexOf(queued);
            if (queueIndex >= 0) {
              queue.splice(queueIndex, 1);
            }
            detachAbort(queued);
            void trackOutputBridgeAbort(queued, error);
            queued.reject(error);
          }
        };
        signal.addEventListener('abort', queued.abortListener, { once: true });
      }
      queue.push(queued);
      drain();
    });
  };

  const cancelActive = (
    operation: QueuedOperation,
    error: unknown,
  ): void => {
    if (operation.cancelRequested) {
      return;
    }
    operation.cancelRequested = true;
    operation.cancelReason = error;
    detachAbort(operation);
    void trackOutputBridgeAbort(operation, error);
    try {
      worker.postMessage({ id: operation.id, type: 'cancel' } satisfies AudioStreamWorkerRequest);
    } catch {
      // The terminal Worker event still controls when the next job may start.
    }
  };

  const getAdmissionError = (
    signal: AbortSignal | undefined,
  ): unknown | undefined => {
    if (terminated) {
      return createWorkerTerminatedError();
    }
    if (signal?.aborted) {
      return createOperationAbortedError(signal);
    }
    if (active !== undefined && queue.length >= maxQueued) {
      return new AudioTranscoderError(
        'QUEUE_CAPACITY_EXCEEDED',
        `Audio stream Worker queue is full (maxQueued: ${maxQueued}; active operation excluded).`,
      );
    }
    return undefined;
  };

  return {
    dispose(): Promise<void> {
      return beginDisposal(createWorkerTerminatedError());
    },
    getCapabilities: () => capabilities,
    getInfo: () => packageEngineInfo,
    getVersion: () => packageEngineInfo.version,
    inspect(input, operationOptions = {}): Promise<AudioStreamInspection> {
      return enqueue(
        'inspect',
        (id) => ({
          id,
          input,
          options: workerOptions(operationOptions),
          type: 'inspect',
        }),
        operationOptions,
        [],
      );
    },
    probeInputSupport(
      input,
      operationOptions = {},
    ): Promise<AudioStreamInputSupportResult> {
      return enqueue(
        'probeInputSupport',
        (id) => ({
          id,
          input,
          options: workerOptions(operationOptions),
          type: 'probeInputSupport',
        }),
        operationOptions,
        [],
      );
    },
    async probeOutputSupport(
      target: AudioStreamOutputProbeTarget,
      operationOptions: AudioStreamOutputProbeOptions = {},
    ): Promise<AudioStreamOutputSupportResult> {
      if (terminated) {
        throw createWorkerTerminatedError();
      }
      return probeAudioStreamOutputSupport(
        capabilities,
        outputProbeCoordinator,
        target,
        operationOptions.signal,
        (resolvedTarget, signal) =>
          enqueue(
            'probeOutputSupport',
            (id) => ({
              id,
              target: resolvedTarget,
              type: 'probeOutputSupport',
            }),
            { signal },
            [],
          ),
      );
    },
    terminate(): void {
      void beginDisposal(createWorkerTerminatedError());
    },
    transcode(
      input: AudioStreamInput,
      target: AudioStreamTarget,
      output: AudioStreamOutput,
      operationOptions: AudioStreamOperationOptions = {},
    ): Promise<AudioStreamTranscodeResult> {
      const admissionError = getAdmissionError(operationOptions.signal);
      if (admissionError !== undefined) {
        return Promise.reject(admissionError);
      }
      let bridge: OutputBridge;
      try {
        bridge = createOutputBridge(output);
      } catch (error) {
        return Promise.reject(error);
      }
      return enqueue(
        'transcode',
        (id) => ({
          id,
          input,
          options: workerOptions(operationOptions),
          output: bridge.stream,
          target,
          type: 'transcode',
        }),
        operationOptions,
        [bridge.stream as unknown as Transferable],
        bridge,
      );
    },
  };
}

type ResolvedAudioTranscoderStreamWorkerRuntime<WorkerFactory> =
  | {
      readonly capabilities: AudioTranscoderStreamCapabilities;
      readonly runtime: 'custom';
      readonly workerFactory: WorkerFactory;
    }
  | {
      readonly capabilities: typeof AUDIO_TRANSCODER_STREAM_CAPABILITIES;
      readonly runtime: 'default';
      readonly workerFactory: WorkerFactory | undefined;
    };

/** @internal Shared by the Worker pool so both public factories enforce one contract. */
export function resolveAudioTranscoderStreamWorkerRuntime<WorkerFactory>(
  options: AudioTranscoderStreamWorkerRuntimeOptions<WorkerFactory>,
): ResolvedAudioTranscoderStreamWorkerRuntime<WorkerFactory> {
  if (options === null || typeof options !== 'object') {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      'Stream Worker options must be an object.',
    );
  }

  const runtimeOptions = options as {
    readonly capabilities?: unknown;
    readonly runtime?: unknown;
    readonly workerFactory?: unknown;
  };
  const runtime = runtimeOptions.runtime ?? 'default';
  if (runtime !== 'custom' && runtime !== 'default') {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      "Stream Worker runtime must be either 'default' or 'custom'.",
    );
  }
  if (
    runtimeOptions.workerFactory !== undefined &&
    typeof runtimeOptions.workerFactory !== 'function'
  ) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      'Stream Worker workerFactory must be a function.',
    );
  }

  if (runtime === 'default') {
    if (runtimeOptions.capabilities !== undefined) {
      throw new AudioTranscoderError(
        'INVALID_CONFIGURATION',
        "Custom stream capabilities require runtime: 'custom' and a matching workerFactory.",
      );
    }
    return {
      capabilities: AUDIO_TRANSCODER_STREAM_CAPABILITIES,
      runtime,
      workerFactory: runtimeOptions.workerFactory as WorkerFactory | undefined,
    };
  }

  if (
    runtimeOptions.capabilities === null ||
    typeof runtimeOptions.capabilities !== 'object' ||
    !('limits' in runtimeOptions.capabilities) ||
    runtimeOptions.capabilities.limits === null ||
    typeof runtimeOptions.capabilities.limits !== 'object'
  ) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      "Custom stream runtime requires a capability manifest and workerFactory.",
    );
  }
  if (typeof runtimeOptions.workerFactory !== 'function') {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      "Custom stream runtime requires a capability manifest and workerFactory.",
    );
  }

  return {
    capabilities: runtimeOptions.capabilities as AudioTranscoderStreamCapabilities,
    runtime,
    workerFactory: runtimeOptions.workerFactory as WorkerFactory,
  };
}

async function waitForOutputBridgeAbort(
  operation: QueuedOperation,
  reason: unknown,
): Promise<void> {
  try {
    await operation.outputBridge?.abort(reason);
  } catch {
    // The operation error remains primary when destination cleanup also fails.
  }
}

function resolveMaxQueued(
  value: number | undefined,
  capabilities: typeof AUDIO_TRANSCODER_STREAM_CAPABILITIES | {
    readonly limits: {
      readonly queue?: {
        readonly defaultMaximumQueued: number;
        readonly maximumQueued: number;
      };
    };
  },
): number {
  const defaultLimits = AUDIO_TRANSCODER_STREAM_CAPABILITIES.limits.queue;
  const runtimeLimits = capabilities.limits.queue ?? defaultLimits;
  const maximum = Math.min(runtimeLimits.maximumQueued, defaultLimits.maximumQueued);
  const resolved = value ?? runtimeLimits.defaultMaximumQueued;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 0 ||
    resolved > maximum
  ) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      `Stream Worker maxQueued must be an integer from 0 to ${maximum}.`,
    );
  }
  return resolved;
}

function createOutputBridge(output: AudioStreamOutput): OutputBridge {
  if (!(output instanceof WritableStream) || output.locked) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      'Streaming output must be an unlocked WritableStream.',
    );
  }

  const writer = output.getWriter();
  let abortPromise: Promise<void> | undefined;
  let settled = false;
  let resolveCompletion!: (settlement: OutputBridgeSettlement) => void;
  const completion = new Promise<OutputBridgeSettlement>((resolve) => {
    resolveCompletion = resolve;
  });

  const settle = (settlement: OutputBridgeSettlement): void => {
    if (!settled) {
      settled = true;
      writer.releaseLock();
      resolveCompletion(settlement);
    }
  };
  const fail = (reason: unknown): void => {
    settle({ reason, status: 'failed' });
  };
  const abortOnce = async (reason: unknown): Promise<void> => {
    if (settled) {
      return;
    }
    try {
      await writer.abort(reason);
      fail(reason);
    } catch (error) {
      fail(error);
      throw error;
    }
  };
  const abort = (reason: unknown): Promise<void> => {
    abortPromise ??= abortOnce(reason);
    return abortPromise;
  };

  const stream = new WritableStream<AudioStreamOutputChunk>({
    abort,
    async close() {
      try {
        await writer.close();
        settle({ reason: undefined, status: 'closed' });
      } catch (error) {
        fail(error);
        throw error;
      }
    },
    async write(chunk) {
      try {
        await writer.write(chunk);
      } catch (error) {
        fail(error);
        throw error;
      }
    },
  });

  return { abort, completion, stream };
}

function createWorker(workerFactory: (() => Worker) | undefined): Worker {
  if (workerFactory !== undefined) {
    return workerFactory();
  }
  if (typeof Worker === 'undefined') {
    throw new AudioTranscoderError(
      'WORKER_UNAVAILABLE',
      'Web Workers are unavailable in this environment.',
    );
  }
  return new Worker(new URL('./worker-entry.js', import.meta.url), {
    name: 'dsub-audio-stream-transcoder',
    type: 'module',
  });
}

function workerOptions(
  options: AudioStreamOperationOptions,
): StreamWorkerOperationOptions {
  return {
    ...(options.inputReadBytes === undefined
      ? {}
      : { inputReadBytes: options.inputReadBytes }),
    ...(options.outputChunkBytes === undefined
      ? {}
      : { outputChunkBytes: options.outputChunkBytes }),
    ...(options.pcmChunkBytes === undefined
      ? {}
      : { pcmChunkBytes: options.pcmChunkBytes }),
  };
}

function freezeResult(
  operation: StreamOperation,
  result: StreamResult,
): StreamResult {
  if (operation === 'transcode') {
    const transcodeResult = result as AudioStreamTranscodeResult;
    return Object.freeze({
      ...transcodeResult,
      details: Object.freeze({ ...transcodeResult.details }),
      preset: Object.freeze({
        ...transcodeResult.preset,
      }),
    }) as AudioStreamTranscodeResult;
  }
  if (operation === 'probeInputSupport') {
    const support = result as AudioStreamInputSupportResult;
    return Object.freeze({
      ...support,
      inspection:
        support.inspection === null
          ? null
          : freezeInspection(support.inspection),
    }) as AudioStreamInputSupportResult;
  }
  if (operation === 'probeOutputSupport') {
    return Object.freeze({
      ...(result as AudioStreamOutputSupportResult),
    }) as AudioStreamOutputSupportResult;
  }
  return freezeInspection(result as AudioStreamInspection);
}

function freezeInspection(
  inspection: AudioStreamInspection,
): AudioStreamInspection {
  return Object.freeze({
    ...inspection,
    notes: Object.freeze([...inspection.notes]),
  });
}
