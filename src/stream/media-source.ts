import {
  ALL_FORMATS,
  type AudioSample,
  AudioSampleSink,
  Input,
  type InputAudioTrack,
} from 'mediabunny';
import type {
  AudioStreamInput,
  AudioStreamInspection,
} from './contracts.js';
import type { PcmStreamSource } from './pcm-source.js';
import { AudioTranscoderError } from '../errors.js';
import { createOperationAbortedError } from '../engine/operation-errors.js';
import { createBoundedBlobSource } from './runtime/bounded-blob-source.js';

interface MediaProbe {
  readonly canDecode: boolean;
  readonly dispose: () => void;
  readonly input: Input<ReturnType<typeof createBoundedBlobSource>>;
  readonly inspection: AudioStreamInspection;
  readonly track: InputAudioTrack;
}

type DecoderValidation = 'decoded' | 'empty' | 'failed';

export async function inspectMediaBlob(
  streamInput: AudioStreamInput,
  inputReadBytes: number,
  signal?: AbortSignal,
): Promise<AudioStreamInspection | null> {
  const probe = await probeMediaBlob(streamInput, inputReadBytes, signal);
  if (probe === null) {
    return null;
  }
  probe.dispose();
  return probe.inspection;
}

export async function probeMediaBlobSupport(
  streamInput: AudioStreamInput,
  inputReadBytes: number,
  signal?: AbortSignal,
): Promise<AudioStreamInspection | null> {
  const probe = await probeMediaBlob(
    streamInput,
    inputReadBytes,
    signal,
    inputReadBytes,
  );
  if (probe === null) {
    return null;
  }

  try {
    if (!probe.canDecode) {
      return probe.inspection;
    }
    const validation = await validateFirstDecodedSample(probe, signal);
    if (validation === 'decoded') {
      return probe.inspection;
    }
    return withUnsupportedDecoder(
      probe.inspection,
      validation === 'empty'
        ? 'The audio track did not produce a decodable sample.'
        : 'The browser decoder could not decode the first audio sample.',
    );
  } finally {
    probe.dispose();
  }
}

export async function openMediaBlobSource(
  streamInput: AudioStreamInput,
  inputReadBytes: number,
  pcmChunkBytes: number,
  signal?: AbortSignal,
): Promise<PcmStreamSource | null> {
  assertPcmChunkBytes(pcmChunkBytes);
  const probe = await probeMediaBlob(streamInput, inputReadBytes, signal);
  if (probe === null) {
    return null;
  }
  if (!probe.canDecode) {
    probe.dispose();
    throw new AudioTranscoderError(
      'UNSUPPORTED_INPUT',
      `${probe.inspection.container} ${probe.inspection.codec} cannot be decoded in this browser.`,
    );
  }

  const { inspection, track } = probe;

  return {
    channels: inspection.channels!,
    chunks: (chunkSignal?: AbortSignal) =>
      decodeChunks(
        track,
        inspection,
        pcmChunkBytes,
        probe.dispose,
        chunkSignal,
      ),
    close: probe.dispose,
    durationSeconds: inspection.durationSeconds,
    inspection,
    sampleRate: inspection.sampleRate!,
    totalFrames: null,
  };
}

async function probeMediaBlob(
  streamInput: AudioStreamInput,
  inputReadBytes: number,
  signal?: AbortSignal,
  maxTotalReadBytes?: number,
): Promise<MediaProbe | null> {
  throwIfAborted(signal);
  const input = new Input({
    formats: ALL_FORMATS,
    source: createBoundedBlobSource(
      streamInput.blob,
      inputReadBytes,
      maxTotalReadBytes,
    ),
  });
  let disposed = false;
  const dispose = (): void => {
    if (!disposed) {
      disposed = true;
      input.dispose();
    }
  };

  try {
    if (!(await input.canRead())) {
      dispose();
      return null;
    }
    const track = await input.getPrimaryAudioTrack();
    if (track === null) {
      throw new AudioTranscoderError(
        'UNSUPPORTED_INPUT',
        'The selected file does not contain an audio track.',
      );
    }
    const [format, codec, channels, sampleRate, rawDurationSeconds, canDecode] =
      await Promise.all([
        input.getFormat(),
        track.getCodec(),
        track.getNumberOfChannels(),
        track.getSampleRate(),
        track.getDurationFromMetadata(),
        track.canDecode(),
      ]);
    throwIfAborted(signal);
    assertAudioParameters(channels, sampleRate);
    const durationSeconds =
      rawDurationSeconds !== null &&
      Number.isFinite(rawDurationSeconds) &&
      rawDurationSeconds >= 0
        ? rawDurationSeconds
        : null;

    const codecName = codec ?? 'Unknown';
    const bitDepth = getPcmBitDepth(codecName);
    const inspection: AudioStreamInspection = Object.freeze({
      bitDepth,
      channels,
      codec: codecName,
      container: format.name,
      decodeSupport: canDecode
        ? bitDepth === null
          ? 'likely-browser'
          : 'built-in'
        : 'browser-dependent',
      durationSeconds,
      notes: canDecode ? [] : ['A browser decoder or codec plugin is required.'],
      sampleRate,
      size: streamInput.blob.size,
    });
    return { canDecode, dispose, input, inspection, track };
  } catch (error) {
    dispose();
    if (signal?.aborted) {
      throw createOperationAbortedError(signal);
    }
    throw error;
  }
}

async function validateFirstDecodedSample(
  probe: MediaProbe,
  signal?: AbortSignal,
): Promise<DecoderValidation> {
  let iterator: AsyncIterator<AudioSample> | undefined;
  let sample: AudioSample | undefined;
  let validation: DecoderValidation = 'failed';
  const failures: unknown[] = [];
  const abort = (): void => probe.dispose();
  signal?.addEventListener('abort', abort, { once: true });

  try {
    throwIfAborted(signal);
    iterator = new AudioSampleSink(probe.track)
      .samples()
      [Symbol.asyncIterator]();
    const result = await iterator.next();
    throwIfAborted(signal);
    if (result.done) {
      validation = 'empty';
    } else {
      sample = result.value;
      assertDecodedSample(sample, probe.inspection);
      validation = 'decoded';
    }
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      sample?.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await iterator?.return?.();
    } catch (error) {
      failures.push(error);
    }
    signal?.removeEventListener('abort', abort);
  }

  throwIfAborted(signal);
  const resourceFailure = failures.find(isResourceLimitError);
  if (resourceFailure !== undefined) {
    throw resourceFailure;
  }
  if (failures.length > 0) {
    return 'failed';
  }
  return validation;
}

function isResourceLimitError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'RESOURCE_LIMIT_EXCEEDED'
  );
}

function withUnsupportedDecoder(
  inspection: AudioStreamInspection,
  note: string,
): AudioStreamInspection {
  return Object.freeze({
    ...inspection,
    decodeSupport: 'browser-dependent',
    notes: Object.freeze([...inspection.notes, note]),
  });
}

async function* decodeChunks(
  track: InputAudioTrack,
  inspection: AudioStreamInspection,
  pcmChunkBytes: number,
  closeInput: () => void,
  signal?: AbortSignal,
): AsyncGenerator<Float32Array, void, unknown> {
  const abort = (): void => closeInput();
  let decodedSamples = 0;
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const sink = new AudioSampleSink(track);
    for await (const sample of sink.samples()) {
      decodedSamples += 1;
      try {
        throwIfAborted(signal);
        assertDecodedSample(sample, inspection);

        const frameBytes =
          sample.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
        if (frameBytes > pcmChunkBytes) {
          throw new AudioTranscoderError(
            'INVALID_CONFIGURATION',
            `pcmChunkBytes must be at least ${frameBytes} bytes for ${sample.numberOfChannels} channels.`,
          );
        }

        const maxFramesPerChunk = Math.floor(pcmChunkBytes / frameBytes);
        for (
          let frameOffset = 0;
          frameOffset < sample.numberOfFrames;
          frameOffset += maxFramesPerChunk
        ) {
          throwIfAborted(signal);
          const frameCount = Math.min(
            maxFramesPerChunk,
            sample.numberOfFrames - frameOffset,
          );
          const samples = new Float32Array(
            frameCount * sample.numberOfChannels,
          );
          sample.copyTo(samples, {
            format: 'f32',
            frameCount,
            frameOffset,
            planeIndex: 0,
          });
          yield samples;
        }
      } finally {
        sample.close();
      }
    }
    if (decodedSamples === 0) {
      throw new AudioTranscoderError(
        'UNSUPPORTED_INPUT',
        `${inspection.container} ${inspection.codec} did not produce a decoded audio sample in this browser.`,
      );
    }
  } catch (error) {
    if (signal?.aborted) {
      throw createOperationAbortedError(signal);
    }
    if (decodedSamples === 0 && isEncodingError(error)) {
      throw new AudioTranscoderError(
        'UNSUPPORTED_INPUT',
        `${inspection.container} ${inspection.codec} could not decode its first audio sample in this browser.`,
      );
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

function isEncodingError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'name' in error &&
    error.name === 'EncodingError'
  );
}

function assertDecodedSample(
  sample: Pick<
    AudioSample,
    'numberOfChannels' | 'numberOfFrames' | 'sampleRate'
  >,
  inspection: AudioStreamInspection,
): void {
  if (
    sample.numberOfChannels !== inspection.channels ||
    sample.sampleRate !== inspection.sampleRate
  ) {
    throw new AudioTranscoderError(
      'INVALID_AUDIO_DATA',
      'Audio parameters changed during decoding.',
    );
  }
  if (
    !Number.isSafeInteger(sample.numberOfFrames) ||
    sample.numberOfFrames < 0
  ) {
    throw new AudioTranscoderError(
      'INVALID_AUDIO_DATA',
      'The decoded audio sample has an invalid frame count.',
    );
  }
}

function assertPcmChunkBytes(pcmChunkBytes: number): void {
  if (!Number.isSafeInteger(pcmChunkBytes) || pcmChunkBytes < 1) {
    throw new AudioTranscoderError(
      'INVALID_CONFIGURATION',
      'pcmChunkBytes must be a positive safe integer.',
    );
  }
}

function assertAudioParameters(channels: number, sampleRate: number): void {
  if (
    !Number.isSafeInteger(channels) ||
    channels < 1 ||
    channels > 32 ||
    !Number.isSafeInteger(sampleRate) ||
    sampleRate < 1
  ) {
    throw new AudioTranscoderError(
      'INVALID_AUDIO_DATA',
      'Decoded audio parameters are invalid.',
    );
  }
}

function getPcmBitDepth(codec: string): number | null {
  const match = /^pcm-(?:[suf])(8|16|24|32|64)(?:be)?$/.exec(codec);
  return match === null ? null : Number(match[1]);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createOperationAbortedError(signal);
  }
}
