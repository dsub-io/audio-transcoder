import type {
  AudioStreamInput,
  AudioStreamInputSupportResult,
  AudioStreamInspection,
  AudioStreamOperationOptions,
  AudioStreamOutput,
  AudioStreamOutputProbeTarget,
  AudioStreamOutputSupportResult,
  AudioStreamProgress,
  AudioStreamTarget,
  AudioStreamTranscodeResult,
} from './contracts.js';
import type { SerializedWorkerError } from '../worker/protocol.js';

export type AudioStreamWorkerRequest =
  | {
      readonly id: number;
      readonly input: AudioStreamInput;
      readonly options: StreamWorkerOperationOptions;
      readonly type: 'inspect';
    }
  | {
      readonly id: number;
      readonly input: AudioStreamInput;
      readonly options: StreamWorkerOperationOptions;
      readonly type: 'probeInputSupport';
    }
  | {
      readonly id: number;
      readonly target: AudioStreamOutputProbeTarget;
      readonly type: 'probeOutputSupport';
    }
  | {
      readonly id: number;
      readonly input: AudioStreamInput;
      readonly options: StreamWorkerOperationOptions;
      readonly output: AudioStreamOutput;
      readonly target: AudioStreamTarget;
      readonly type: 'transcode';
    }
  | {
      readonly id: number;
      readonly type: 'cancel';
    };

export type StreamWorkerOperationOptions = Pick<
  AudioStreamOperationOptions,
  'inputReadBytes' | 'outputChunkBytes' | 'pcmChunkBytes'
>;

export type AudioStreamWorkerResponse =
  | {
      readonly id: number;
      readonly progress: AudioStreamProgress;
      readonly type: 'progress';
    }
  | {
      readonly id: number;
      readonly operation: 'inspect';
      readonly type: 'result';
      readonly value: AudioStreamInspection;
    }
  | {
      readonly id: number;
      readonly operation: 'probeInputSupport';
      readonly type: 'result';
      readonly value: AudioStreamInputSupportResult;
    }
  | {
      readonly id: number;
      readonly operation: 'probeOutputSupport';
      readonly type: 'result';
      readonly value: AudioStreamOutputSupportResult;
    }
  | {
      readonly id: number;
      readonly operation: 'transcode';
      readonly type: 'result';
      readonly value: AudioStreamTranscodeResult;
    }
  | {
      readonly error: SerializedWorkerError;
      readonly id: number;
      readonly type: 'error';
    };
