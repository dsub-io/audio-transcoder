import type {
  AudioInput,
  AudioInspection,
  AudioOutputPreset,
  DecodedAudio,
  EncodedAudio,
  PcmAudio,
} from '../engine/contracts.js';

export type MaybePromise<T> = Promise<T> | T;

export interface AudioCodecOperationContext {
  readonly signal: AbortSignal | undefined;

  /** Reports progress, yields to the event loop, then checks cancellation. */
  checkpoint(completedFrames: number, totalFrames: number): Promise<void>;

  /** Reports monotonic integer frame counts without yielding. */
  reportProgress(completedFrames: number, totalFrames: number): void;

  /** Throws `OPERATION_ABORTED` when the operation signal is aborted. */
  throwIfAborted(): void;
}

export interface AudioInspectorAdapter {
  readonly formats: readonly string[];
  readonly id: string;
  inspect(input: AudioInput): AudioInspection | null;
}

export interface AudioDecoderAdapter {
  readonly formats: readonly string[];
  readonly id: string;
  decode(
    input: AudioInput,
    context?: AudioCodecOperationContext,
  ): MaybePromise<DecodedAudio | null>;
}

export interface AudioEncoderAdapter {
  readonly id: string;
  readonly presets: readonly AudioOutputPreset[];
  encode(
    audio: PcmAudio,
    preset: AudioOutputPreset,
    context?: AudioCodecOperationContext,
  ): MaybePromise<EncodedAudio>;
}

export interface AudioTranscoderPlugin {
  /** Optional decode strategies checked before built-in decoders. */
  readonly decoders?: readonly AudioDecoderAdapter[];
  /** Optional encode strategies with globally unique preset IDs. */
  readonly encoders?: readonly AudioEncoderAdapter[];
  readonly id: string;
  /** Optional header inspectors checked before built-in inspectors. */
  readonly inspectors?: readonly AudioInspectorAdapter[];
}
