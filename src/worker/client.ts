import type {
  AudioInput,
  AudioInspection,
  AudioOperationOptions,
  AudioTranscoderCapabilities,
  AudioTranscoderEngineInfo,
  AudioTranscoderWorkerEngine,
  CreateAudioTranscoderWorkerEngineOptions,
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
import type {
  AudioWorkerRequest,
  AudioWorkerResponse,
  SerializedWorkerError,
} from './protocol.js';

type WorkerOperationRequestPayload =
  | Omit<Extract<AudioWorkerRequest, { readonly type: 'decode' }>, 'id'>
  | Omit<Extract<AudioWorkerRequest, { readonly type: 'encode' }>, 'id'>
  | Omit<Extract<AudioWorkerRequest, { readonly type: 'transcode' }>, 'id'>;

interface PendingOperation<T = DecodedAudio | EncodedAudio> {
  readonly abort: (() => void) | undefined;
  readonly onProgress: AudioOperationOptions['onProgress'];
  readonly reject: (reason: unknown) => void;
  readonly resolve: (value: T) => void;
}

/**
 * Creates one module Worker engine. Use a Worker pool for bounded multi-item
 * processing; concurrent calls here share a single Worker thread.
 */
export function createAudioTranscoderWorkerEngine(
  options: CreateAudioTranscoderWorkerEngineOptions = {},
): AudioTranscoderWorkerEngine {
  const localEngine = createAudioTranscoderEngine();
  const worker = createWorker(options.workerFactory);
  const pending = new Map<number, PendingOperation>();
  let nextOperationId = 1;
  let terminated = false;

  const cleanup = (id: number): PendingOperation => {
    const operation = pending.get(id)!;
    operation.abort?.();
    pending.delete(id);
    return operation;
  };

  const rejectAll = (error: AudioTranscoderError): void => {
    for (const id of pending.keys()) {
      cleanup(id).reject(error);
    }
  };

  const cancelOperation = (id: number): void => {
    try {
      worker.postMessage({ id, type: 'cancel' } satisfies AudioWorkerRequest);
    } catch {
      // The local promise still needs to settle if the worker is already broken.
    }
  };

  worker.addEventListener('message', (event: MessageEvent<AudioWorkerResponse>) => {
    const response = event.data;
    const operation = pending.get(response.id);
    if (operation === undefined) {
      return;
    }

    if (response.type === 'progress') {
      try {
        operation.onProgress?.(Object.freeze({ ...response.progress }));
      } catch (error) {
        cancelOperation(response.id);
        cleanup(response.id).reject(error);
      }
      return;
    }

    cleanup(response.id);
    if (response.type === 'error') {
      operation.reject(deserializeError(response.error));
    } else if (response.operation === 'decode') {
      operation.resolve(freezeDecodedAudio(response.value));
    } else {
      operation.resolve(freezeEncodedAudio(response.value));
    }
  });

  worker.addEventListener('error', (event: ErrorEvent) => {
    failWorker(event.message || 'Audio transcoder worker failed.');
  });

  worker.addEventListener('messageerror', () => {
    failWorker('Audio transcoder worker returned an unreadable message.');
  });

  const failWorker = (message: string): void => {
    if (terminated) {
      return;
    }
    terminated = true;
    worker.terminate();
    rejectAll(
      new AudioTranscoderError('WORKER_FAILURE', message),
    );
  };

  const run = <T extends DecodedAudio | EncodedAudio>(
    request: WorkerOperationRequestPayload,
    operationOptions: AudioOperationOptions,
    transfer: Transferable[],
  ): Promise<T> => {
    if (terminated) {
      return Promise.reject(createWorkerTerminatedError());
    }
    if (operationOptions.signal?.aborted) {
      return Promise.reject(createOperationAbortedError(operationOptions.signal));
    }

    const id = nextOperationId;
    nextOperationId += 1;

    return new Promise<T>((resolve, reject) => {
      const signal = operationOptions.signal;
      const abort =
        signal === undefined
          ? undefined
          : (): void => {
              cancelOperation(id);
              cleanup(id).reject(createOperationAbortedError(signal));
            };
      signal?.addEventListener('abort', abort!, { once: true });
      pending.set(id, {
        abort:
          signal === undefined
            ? undefined
            : () => signal.removeEventListener('abort', abort!),
        onProgress: operationOptions.onProgress,
        reject,
        resolve: resolve as PendingOperation['resolve'],
      });
      try {
        worker.postMessage({ ...request, id } as AudioWorkerRequest, transfer);
      } catch (error) {
        cleanup(id);
        reject(error);
      }
    });
  };

  return {
    decode(input, operationOptions = {}): Promise<DecodedAudio> {
      const prepared = prepareInput(input, operationOptions.transferInput);
      return run<DecodedAudio>(
        { input: prepared.value, type: 'decode' },
        operationOptions,
        prepared.transfer,
      );
    },
    encode(
      audio,
      presetId,
      operationOptions = {},
    ): Promise<EncodedAudio> {
      const prepared = preparePcmAudio(audio, operationOptions.transferInput);
      return run<EncodedAudio>(
        { audio: prepared.value, presetId, type: 'encode' },
        operationOptions,
        prepared.transfer,
      );
    },
    getCapabilities(): AudioTranscoderCapabilities {
      return localEngine.getCapabilities();
    },
    getInfo(): AudioTranscoderEngineInfo {
      return localEngine.getInfo();
    },
    getVersion(): string {
      return localEngine.getVersion();
    },
    inspect(input): AudioInspection {
      return localEngine.inspect(input);
    },
    terminate(): void {
      if (!terminated) {
        terminated = true;
        worker.terminate();
        rejectAll(createWorkerTerminatedError());
      }
    },
    transcode(
      input,
      presetId,
      operationOptions = {},
    ): Promise<EncodedAudio> {
      const prepared = prepareInput(input, operationOptions.transferInput);
      return run<EncodedAudio>(
        { input: prepared.value, presetId, type: 'transcode' },
        operationOptions,
        prepared.transfer,
      );
    },
  };
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
  return new Worker(new URL('./entry.js', import.meta.url), {
    name: 'dsub-audio-transcoder',
    type: 'module',
  });
}

interface PreparedValue<T> {
  readonly transfer: Transferable[];
  readonly value: T;
}

function prepareInput(
  input: AudioInput,
  transferInput: boolean | undefined,
): PreparedValue<AudioInput> {
  const data = transferInput === true ? input.data : input.data.slice(0);
  return { transfer: [data], value: { ...input, data } };
}

function preparePcmAudio(
  audio: PcmAudio,
  transferInput: boolean | undefined,
): PreparedValue<PcmAudio> {
  const channelData = audio.channelData.map((channel) =>
    transferInput === true && channel.buffer instanceof ArrayBuffer
      ? channel
      : channel.slice(),
  );
  const transfer = [
    ...new Set(
      channelData
        .map(({ buffer }) => buffer)
        .filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer),
    ),
  ];
  return { transfer, value: { channelData, sampleRate: audio.sampleRate } };
}

function deserializeError(error: SerializedWorkerError): Error {
  if (error.code !== undefined) {
    return new AudioTranscoderError(error.code, error.message);
  }
  const deserialized = new Error(error.message);
  deserialized.name = error.name;
  return deserialized;
}

function freezeDecodedAudio(audio: DecodedAudio): DecodedAudio {
  return Object.freeze({
    ...audio,
    channelData: Object.freeze([...audio.channelData]),
  });
}

function freezeEncodedAudio(audio: EncodedAudio): EncodedAudio {
  return Object.freeze({
    ...audio,
    preset: Object.freeze({ ...audio.preset }),
  });
}
