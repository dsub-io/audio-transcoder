export {
  audioTranscoder,
  getEngineInfo,
  getVersion,
} from './audio-transcoder.js';
export { AIFF_OUTPUT_PRESETS } from './codecs/aiff.js';
export { WAV_OUTPUT_PRESETS } from './codecs/wav.js';
export { createAudioTranscoderEngine } from './engine/factory.js';
export { createAudioTranscoderWorkerEngine } from './worker/client.js';
export { createAudioTranscoderWorkerPool } from './worker/pool.js';
export { AudioTranscoderError } from './errors.js';
export {
  AUDIO_TRANSCODER_PACKAGE,
  AUDIO_TRANSCODER_VERSION,
} from './package-metadata.js';
export type {
  AudioCodecOperationContext,
  AudioDecoderAdapter,
  AudioEncoderAdapter,
  AudioInspectorAdapter,
  AudioTranscoderPlugin,
} from './codecs/contracts.js';
export type {
  AudioDecodeSupport,
  AudioInput,
  AudioInspection,
  AudioOperationKind,
  AudioOperationOptions,
  AudioOutputPreset,
  AudioProgress,
  AudioProgressListener,
  AudioProgressPhase,
  AudioSampleFormat,
  AudioTranscoderEngine,
  AudioTranscoderCapabilities,
  AudioTranscoderEngineInfo,
  AudioTranscoderWorkerEngine,
  CreateAudioTranscoderEngineOptions,
  CreateAudioTranscoderWorkerEngineOptions,
  DecodedAudio,
  EncodedAudio,
  PcmAudio,
} from './engine/contracts.js';
export type {
  AudioTranscoderErrorCode,
} from './errors.js';
export type {
  AudioTranscoderPoolScheduleOptions,
  AudioTranscoderQueueSnapshot,
  AudioTranscoderWorkerPool,
  CreateAudioTranscoderWorkerPoolOptions,
} from './worker/pool.js';
