import type { AudioTranscoderPlugin } from '../codecs/contracts.js';

export interface AudioTranscoderEngineInfo {
  readonly name: string;
  readonly version: string;
}

export interface AudioInput {
  /** Complete file bytes. May be detached when `transferInput` is enabled. */
  readonly data: ArrayBuffer;
  readonly name?: string;
  readonly size?: number;
}

export type AudioDecodeSupport =
  | 'browser-dependent'
  | 'built-in'
  | 'likely-browser'
  | 'unknown';

export interface AudioInspection {
  readonly bitDepth: number | null;
  readonly channels: number | null;
  readonly codec: string;
  readonly container: string;
  readonly decodeSupport: AudioDecodeSupport;
  readonly durationSeconds: number | null;
  readonly notes: readonly string[];
  readonly sampleRate: number | null;
}

export interface PcmAudio {
  readonly channelData: readonly Float32Array[];
  readonly sampleRate: number;
}

export interface DecodedAudio extends PcmAudio {
  readonly durationSeconds: number;
  readonly source: string;
}

export type AudioSampleFormat = 'float' | 'integer' | 'lossy';

export interface AudioOutputPreset {
  readonly bitDepth: number | null;
  readonly container: string;
  readonly extension: string;
  readonly id: string;
  readonly mimeType: string;
  readonly sampleFormat: AudioSampleFormat;
}

export interface EncodedAudio {
  readonly data: ArrayBuffer;
  readonly preset: AudioOutputPreset;
}

export interface AudioTranscoderCapabilities {
  readonly decode: readonly string[];
  readonly encode: readonly AudioOutputPreset[];
  readonly inspect: readonly string[];
}

export type AudioOperationKind = 'decode' | 'encode' | 'transcode';

export type AudioProgressPhase = 'decode' | 'encode' | 'finalize';

export interface AudioProgress {
  readonly completedFrames: number | null;
  readonly operation: AudioOperationKind;
  readonly phase: AudioProgressPhase;
  /** Overall operation progress from 0 to 1, quantized to three decimals. */
  readonly progress: number;
  readonly totalFrames: number | null;
}

export type AudioProgressListener = (progress: AudioProgress) => void;

export interface AudioOperationOptions {
  /** Receives immutable progress snapshots. */
  readonly onProgress?: AudioProgressListener;

  /** Cancels queued or running work. */
  readonly signal?: AbortSignal;

  /**
   * Transfers input ownership to a Worker instead of copying it. The source
   * ArrayBuffer is detached and must not be reused. Ignored by inline engines.
   */
  readonly transferInput?: boolean;
}

export interface CreateAudioTranscoderEngineOptions {
  /** Codec strategies checked before built-in adapters. */
  readonly plugins?: readonly AudioTranscoderPlugin[];
}

export interface AudioTranscoderEngine {
  /** Decodes supported input into planar Float32 PCM. */
  decode(
    input: AudioInput,
    options?: AudioOperationOptions,
  ): Promise<DecodedAudio>;
  /** Encodes planar PCM with a registered output preset. */
  encode(
    audio: PcmAudio,
    presetId: string,
    options?: AudioOperationOptions,
  ): Promise<EncodedAudio>;
  getCapabilities(): AudioTranscoderCapabilities;
  getInfo(): AudioTranscoderEngineInfo;
  getVersion(): string;
  /** Inspects headers synchronously without decoding audio payloads. */
  inspect(input: AudioInput): AudioInspection;

  /** Decodes then encodes while preserving sample rate and channel layout. */
  transcode(
    input: AudioInput,
    presetId: string,
    options?: AudioOperationOptions,
  ): Promise<EncodedAudio>;
}

export interface AudioTranscoderWorkerEngine extends AudioTranscoderEngine {
  /** Cancels pending work and releases the Worker. This instance is terminal. */
  terminate(): void;
}

export interface CreateAudioTranscoderWorkerEngineOptions {
  /**
   * Supplies a module Worker when a custom entry URL or CSP handling is
   * required. Import `@dsub/audio-transcoder/worker` from that entry module.
   */
  readonly workerFactory?: () => Worker;
}
