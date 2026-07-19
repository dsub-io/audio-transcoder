import type {
  AudioInput,
  AudioInspection,
  AudioOperationOptions,
  AudioTranscoderCapabilities,
  AudioTranscoderEngineInfo,
  AudioTranscoderWorkerEngine,
  DecodedAudio,
  EncodedAudio,
  PcmAudio,
} from '../engine/contracts.js';
import { createAudioTranscoderEngine } from '../engine/factory.js';
import {
  createOperationAbortedError,
  createWorkerTerminatedError,
} from '../engine/operation-errors.js';
import { AudioTranscoderError } from '../errors.js';
import { createAudioTranscoderWorkerEngine } from './client.js';

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/** Current bounded-queue and Worker allocation counts. */
export interface AudioTranscoderQueueSnapshot {
  readonly active: number;
  readonly concurrency: number;
  readonly queued: number;
  readonly terminated: boolean;
  readonly workers: number;
}

export interface AudioTranscoderPoolScheduleOptions {
  /** Cancels queued work. Running work must also receive this signal. */
  readonly signal?: AbortSignal;
}

/** A FIFO, concurrency-limited facade over lazily created Worker engines. */
export interface AudioTranscoderWorkerPool extends AudioTranscoderWorkerEngine {
  getQueueSnapshot(): AudioTranscoderQueueSnapshot;

  /**
   * Defers arbitrary work until a Worker slot is available. Use this to delay
   * `File.arrayBuffer()` and avoid retaining every input buffer in the queue.
   * The callback must pass `options.signal` to its running engine operation.
   */
  schedule<T>(
    operation: (engine: AudioTranscoderWorkerEngine) => Promise<T>,
    options?: AudioTranscoderPoolScheduleOptions,
  ): Promise<T>;
}

export interface CreateAudioTranscoderWorkerPoolOptions {
  /**
   * Maximum simultaneous whole-buffer operations and Workers. Defaults to 1;
   * raise it only after measuring peak memory on target devices.
   */
  readonly concurrency?: number;

  /**
   * Releases idle Workers after this delay and recreates them on demand.
   * Defaults to 30 seconds. Use `null` to keep idle Workers alive.
   */
  readonly idleTimeoutMs?: number | null;

  /**
   * Creates each Worker for custom entry URLs or CSP handling. The index is
   * stable from 0 to concurrency - 1.
   */
  readonly workerFactory?: (workerIndex: number) => Worker;
}

interface QueuedOperation {
  detachQueuedAbort: (() => void) | undefined;
  execute:
    | ((engine: AudioTranscoderWorkerEngine) => Promise<unknown>)
    | undefined;
  readonly reject: (reason: unknown) => void;
  readonly resolve: (value: unknown) => void;
}

interface WorkerSlot {
  active: boolean;
  engine: AudioTranscoderWorkerEngine | undefined;
  readonly index: number;
  operation: QueuedOperation | undefined;
}

/**
 * Creates a bounded FIFO queue backed by up to `concurrency` module Workers.
 * Workers are lazy and are released after the configured idle timeout.
 */
export function createAudioTranscoderWorkerPool(
  options: CreateAudioTranscoderWorkerPoolOptions = {},
): AudioTranscoderWorkerPool {
  const concurrency = validateConcurrency(options.concurrency ?? 1);
  const idleTimeoutMs = validateIdleTimeout(options.idleTimeoutMs);
  const slots = createWorkerSlots(concurrency);
  const queue: QueuedOperation[] = [];
  const localEngine = createAudioTranscoderEngine();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let terminated = false;

  const clearIdleRelease = (): void => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  const releaseIdleWorkers = (): void => {
    idleTimer = undefined;
    for (const slot of slots) {
      slot.engine?.terminate();
      slot.engine = undefined;
    }
  };

  const scheduleIdleRelease = (): void => {
    if (
      terminated ||
      idleTimeoutMs === null ||
      queue.length > 0 ||
      slots.some(({ active }) => active)
    ) {
      return;
    }
    if (idleTimeoutMs === 0) {
      releaseIdleWorkers();
      return;
    }

    clearIdleRelease();
    idleTimer = setTimeout(releaseIdleWorkers, idleTimeoutMs);
    (
      idleTimer as ReturnType<typeof setTimeout> & {
        unref?: () => void;
      }
    ).unref?.();
  };

  const getQueueSnapshot = (): AudioTranscoderQueueSnapshot =>
    Object.freeze({
      active: slots.filter(({ active }) => active).length,
      concurrency,
      queued: queue.length,
      terminated,
      workers: slots.filter(({ engine }) => engine !== undefined).length,
    });

  const shutdown = (error: AudioTranscoderError): void => {
    if (terminated) {
      return;
    }
    terminated = true;
    clearIdleRelease();

    for (const operation of queue.splice(0)) {
      operation.detachQueuedAbort?.();
      operation.detachQueuedAbort = undefined;
      operation.execute = undefined;
      operation.reject(error);
    }
    for (const slot of slots) {
      slot.operation?.reject(error);
      slot.operation = undefined;
      slot.active = false;
      slot.engine?.terminate();
      slot.engine = undefined;
    }
  };

  const createSlotEngine = (slot: WorkerSlot): AudioTranscoderWorkerEngine => {
    const workerFactory = options.workerFactory;
    const engine = createAudioTranscoderWorkerEngine(
      workerFactory === undefined
        ? {}
        : { workerFactory: () => workerFactory(slot.index) },
    );
    slot.engine = engine;
    return engine;
  };

  const drain = (): void => {
    if (terminated) {
      return;
    }

    for (const slot of slots) {
      if (slot.active) {
        continue;
      }
      const operation = queue.shift();
      if (operation === undefined) {
        scheduleIdleRelease();
        return;
      }

      operation.detachQueuedAbort?.();
      operation.detachQueuedAbort = undefined;
      const execute = operation.execute!;
      operation.execute = undefined;
      clearIdleRelease();

      let engine: AudioTranscoderWorkerEngine;
      try {
        engine = slot.engine ?? createSlotEngine(slot);
      } catch (error) {
        const workerError = normalizeWorkerFailure(error);
        operation.reject(workerError);
        shutdown(workerError);
        return;
      }

      slot.active = true;
      slot.operation = operation;
      let result: Promise<unknown>;
      try {
        result = execute(engine);
      } catch (error) {
        settleRejected(slot, operation, error);
        continue;
      }

      void result.then(
        (value) => {
          slot.active = false;
          slot.operation = undefined;
          operation.resolve(value);
          drain();
        },
        (error: unknown) => {
          settleRejected(slot, operation, error);
        },
      );
    }
  };

  const enqueue = <T>(
    execute: (engine: AudioTranscoderWorkerEngine) => Promise<T>,
    signal: AbortSignal | undefined,
  ): Promise<T> => {
    if (terminated) {
      return Promise.reject(createWorkerTerminatedError());
    }
    if (signal?.aborted) {
      return Promise.reject(createOperationAbortedError(signal));
    }

    return new Promise<T>((resolve, reject) => {
      const operation: QueuedOperation = {
        detachQueuedAbort: undefined,
        execute,
        reject,
        resolve: (value) => resolve(value as T),
      };

      if (signal !== undefined) {
        const abort = (): void => {
          queue.splice(queue.indexOf(operation), 1);
          operation.detachQueuedAbort?.();
          operation.detachQueuedAbort = undefined;
          operation.execute = undefined;
          operation.reject(createOperationAbortedError(signal));
          scheduleIdleRelease();
        };
        signal.addEventListener('abort', abort, { once: true });
        operation.detachQueuedAbort = () =>
          signal.removeEventListener('abort', abort);
      }

      clearIdleRelease();
      queue.push(operation);
      drain();
    });
  };

  const schedule = <T>(
    operation: (engine: AudioTranscoderWorkerEngine) => Promise<T>,
    scheduleOptions: AudioTranscoderPoolScheduleOptions = {},
  ): Promise<T> => enqueue(operation, scheduleOptions.signal);

  return {
    decode(
      input: AudioInput,
      operationOptions: AudioOperationOptions = {},
    ): Promise<DecodedAudio> {
      return enqueue(
        (engine) => engine.decode(input, operationOptions),
        operationOptions.signal,
      );
    },
    encode(
      audio: PcmAudio,
      presetId: string,
      operationOptions: AudioOperationOptions = {},
    ): Promise<EncodedAudio> {
      return enqueue(
        (engine) => engine.encode(audio, presetId, operationOptions),
        operationOptions.signal,
      );
    },
    getCapabilities(): AudioTranscoderCapabilities {
      return localEngine.getCapabilities();
    },
    getInfo(): AudioTranscoderEngineInfo {
      return localEngine.getInfo();
    },
    getQueueSnapshot,
    getVersion(): string {
      return localEngine.getVersion();
    },
    inspect(input: AudioInput): AudioInspection {
      return localEngine.inspect(input);
    },
    schedule,
    terminate(): void {
      shutdown(createWorkerTerminatedError());
    },
    transcode(
      input: AudioInput,
      presetId: string,
      operationOptions: AudioOperationOptions = {},
    ): Promise<EncodedAudio> {
      return enqueue(
        (engine) => engine.transcode(input, presetId, operationOptions),
        operationOptions.signal,
      );
    },
  };

  function settleRejected(
    slot: WorkerSlot,
    operation: QueuedOperation,
    error: unknown,
  ): void {
    slot.active = false;
    slot.operation = undefined;
    operation.reject(error);
    if (isFatalWorkerError(error)) {
      shutdown(error);
    } else {
      drain();
    }
  }
}

function validateConcurrency(concurrency: number): number {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      'Worker pool concurrency must be a positive safe integer.',
    );
  }
  return concurrency;
}

function validateIdleTimeout(
  idleTimeoutMs: number | null | undefined,
): number | null {
  const resolved =
    idleTimeoutMs === undefined ? DEFAULT_IDLE_TIMEOUT_MS : idleTimeoutMs;
  if (
    resolved !== null &&
    (!Number.isSafeInteger(resolved) || resolved < 0)
  ) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      'Worker pool idleTimeoutMs must be null or a non-negative safe integer.',
    );
  }
  return resolved;
}

function createWorkerSlots(concurrency: number): WorkerSlot[] {
  return Array.from({ length: concurrency }, (_value, index) => ({
    active: false,
    engine: undefined,
    index,
    operation: undefined,
  }));
}

function isFatalWorkerError(error: unknown): error is AudioTranscoderError {
  return (
    error instanceof AudioTranscoderError &&
    (error.code === 'WORKER_FAILURE' || error.code === 'WORKER_TERMINATED')
  );
}

function normalizeWorkerFailure(error: unknown): AudioTranscoderError {
  if (error instanceof AudioTranscoderError) {
    return error;
  }
  const message =
    error instanceof Error ? error.message : 'Audio Worker creation failed.';
  return new AudioTranscoderError('WORKER_FAILURE', message);
}
