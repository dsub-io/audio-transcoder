import { AudioTranscoderError } from '../errors.js';
import type { SerializedWorkerError } from './protocol.js';

export function serializeWorkerError(error: unknown): SerializedWorkerError {
  if (error instanceof AudioTranscoderError) {
    return { code: error.code, message: error.message, name: error.name };
  }
  if (error instanceof Error) {
    return { message: error.message, name: error.name };
  }
  return {
    message: typeof error === 'string' ? error : 'Unknown worker failure.',
    name: 'Error',
  };
}

export function deserializeWorkerError(error: SerializedWorkerError): Error {
  if (error.code !== undefined) {
    return new AudioTranscoderError(error.code, error.message);
  }
  const deserialized = new Error(error.message);
  deserialized.name = error.name;
  return deserialized;
}
