/**
 * Stable rejected-operation categories. Registration, configuration, data, and
 * progress codes identify caller or adapter contract violations. Unsupported
 * codes mean no installed path can perform the requested operation. Abort,
 * queue, and resource codes are control-flow or limit failures, not support
 * verdicts. Worker codes describe availability or terminal Worker lifecycle
 * failures. Output-support verdicts are returned values and are not this type.
 */
export type AudioTranscoderErrorCode =
  | 'DUPLICATE_REGISTRATION'
  | 'INVALID_CONFIGURATION'
  | 'INVALID_AUDIO_DATA'
  | 'INVALID_PROGRESS'
  | 'OPERATION_ABORTED'
  | 'QUEUE_CAPACITY_EXCEEDED'
  | 'RESOURCE_LIMIT_EXCEEDED'
  | 'UNSUPPORTED_INPUT'
  | 'UNSUPPORTED_OUTPUT'
  | 'WORKER_FAILURE'
  | 'WORKER_TERMINATED'
  | 'WORKER_UNAVAILABLE';

/** Package-defined error; branch on `code`, not the human-readable message. */
export class AudioTranscoderError extends Error {
  readonly code: AudioTranscoderErrorCode;

  constructor(code: AudioTranscoderErrorCode, message: string) {
    super(message);
    this.name = 'AudioTranscoderError';
    this.code = code;
  }
}
