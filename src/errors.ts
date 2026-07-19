export type AudioTranscoderErrorCode =
  | 'DUPLICATE_REGISTRATION'
  | 'INVALID_CONFIGURATION'
  | 'INVALID_AUDIO_DATA'
  | 'INVALID_PROGRESS'
  | 'OPERATION_ABORTED'
  | 'UNSUPPORTED_INPUT'
  | 'UNSUPPORTED_OUTPUT'
  | 'WORKER_FAILURE'
  | 'WORKER_TERMINATED'
  | 'WORKER_UNAVAILABLE';

export class AudioTranscoderError extends Error {
  readonly code: AudioTranscoderErrorCode;

  constructor(code: AudioTranscoderErrorCode, message: string) {
    super(message);
    this.name = 'AudioTranscoderError';
    this.code = code;
  }
}
