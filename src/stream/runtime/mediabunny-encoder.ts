import {
  AudioSample,
  AudioSampleSource,
  FlacOutputFormat,
  Mp3OutputFormat,
  Output,
  StreamTarget,
  WavOutputFormat,
} from 'mediabunny';
import {
  findStreamOutputPresetDescriptor,
  isStreamOutputConfigurationSupported,
  type StreamOutputPresetDescriptor,
} from '../../codecs/stream-output-presets.js';
import { AudioTranscoderError } from '../../errors.js';
import { createOperationAbortedError } from '../../engine/operation-errors.js';
import type {
  AudioStreamEncoder,
  AudioStreamEncoderAdapter,
  AudioStreamEncoderConfiguration,
} from './contracts.js';
import { DEFAULT_AUDIO_STREAM_CODEC_RUNTIME_IDS } from './ids.js';
import {
  ensureMediaBunnyCodecRegistered,
  type EnsureMediaBunnyCodecRegistered,
} from './lazy-codec-registration.js';

export function createMediaBunnyStreamEncoderAdapter(
  ensureCodecRegistered: EnsureMediaBunnyCodecRegistered =
    ensureMediaBunnyCodecRegistered,
): AudioStreamEncoderAdapter {
  return Object.freeze({
    id: DEFAULT_AUDIO_STREAM_CODEC_RUNTIME_IDS.encoderAdapter,
    async create(
      configuration: AudioStreamEncoderConfiguration,
    ): Promise<AudioStreamEncoder> {
      throwIfAborted(configuration.signal);
      const descriptor = resolvePreset(configuration.preset.id);
      if (
        !isStreamOutputConfigurationSupported(
          descriptor,
          configuration.channels,
          configuration.sampleRate,
        )
      ) {
        throw new AudioTranscoderError(
          'UNSUPPORTED_OUTPUT',
          `Preset "${descriptor.preset.id}" does not support ${configuration.channels} channels at ${configuration.sampleRate} Hz.`,
        );
      }
      const wasmCodec = descriptor.wasmCodec;
      if (wasmCodec !== null) {
        const registration = Promise.resolve().then(() =>
          ensureCodecRegistered(wasmCodec),
        );
        await waitForCodecRegistration(registration, configuration.signal);
      }
      throwIfAborted(configuration.signal);
      const encoder = await createMediaBunnyEncoder(configuration, descriptor);
      if (configuration.signal?.aborted) {
        const error = createOperationAbortedError(configuration.signal);
        await encoder.cancel(error);
        throw error;
      }
      return encoder;
    },
  });
}

export const MEDIABUNNY_STREAM_ENCODER_ADAPTER =
  createMediaBunnyStreamEncoderAdapter();

/** @deprecated Internal compatibility alias. */
export const MEDIABUNNY_WAV_ENCODER_ADAPTER =
  MEDIABUNNY_STREAM_ENCODER_ADAPTER;

async function createMediaBunnyEncoder(
  configuration: AudioStreamEncoderConfiguration,
  descriptor: StreamOutputPresetDescriptor,
): Promise<AudioStreamEncoder> {
  const streamTarget = new StreamTarget(configuration.writable, {
    chunked: true,
    chunkSize: configuration.outputChunkBytes,
  });
  let bytesWritten = 0;
  streamTarget.on('write', ({ end }) => {
    bytesWritten = Math.max(bytesWritten, end);
  });

  const output = new Output({
    format: createOutputFormat(descriptor, configuration.rf64),
    target: streamTarget,
  });

  try {
    const source = new AudioSampleSource(descriptor.encoding);
    let sourceClosed = false;
    const closeSource = (): void => {
      if (!sourceClosed) {
        sourceClosed = true;
        source.close();
      }
    };
    output.addAudioTrack(source);

    const cancel = async (): Promise<void> => {
      closeSource();
      if (output.state !== 'canceled' && output.state !== 'finalized') {
        await output.cancel().catch(() => undefined);
      }
    };

    return {
      cancel,
      async finalize(): Promise<void> {
        try {
          throwIfAborted(configuration.signal);
          closeSource();
          await output.finalize();
          throwIfAborted(configuration.signal);
        } catch (error) {
          await cancel();
          throw error;
        }
      },
      getBytesWritten: () => bytesWritten,
      async start(): Promise<void> {
        throwIfAborted(configuration.signal);
        await output.start();
        throwIfAborted(configuration.signal);
      },
      async write(samples, frameOffset): Promise<void> {
        throwIfAborted(configuration.signal);
        const sample = new AudioSample({
          data: samples,
          format: 'f32',
          numberOfChannels: configuration.channels,
          sampleRate: configuration.sampleRate,
          timestamp: frameOffset / configuration.sampleRate,
        });
        try {
          await source.add(sample);
          throwIfAborted(configuration.signal);
        } finally {
          sample.close();
        }
      },
    };
  } catch (error) {
    await output.cancel().catch(() => undefined);
    throw error;
  }
}

async function waitForCodecRegistration(
  registration: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) {
    await registration;
    return;
  }
  throwIfAborted(signal);
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = (): void => reject(createOperationAbortedError(signal));
    signal.addEventListener('abort', abort, { once: true });
  });
  void registration.catch(() => undefined);
  try {
    await Promise.race([registration, aborted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createOperationAbortedError(signal);
  }
}

function createOutputFormat(
  descriptor: StreamOutputPresetDescriptor,
  rf64: boolean | null,
): FlacOutputFormat | Mp3OutputFormat | WavOutputFormat {
  switch (descriptor.format) {
    case 'flac':
      return new FlacOutputFormat({ appendOnly: false });
    case 'mp3':
      return new Mp3OutputFormat({ xingHeader: true });
    case 'wav':
      return new WavOutputFormat({ large: rf64 === true });
  }
}

function resolvePreset(presetId: string): StreamOutputPresetDescriptor {
  const descriptor = findStreamOutputPresetDescriptor(presetId);
  if (descriptor === undefined) {
    throw new AudioTranscoderError(
      'UNSUPPORTED_OUTPUT',
      `The MediaBunny adapter does not support preset "${presetId}".`,
    );
  }
  return descriptor;
}
