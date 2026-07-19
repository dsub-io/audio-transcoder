import { AudioTranscoderError } from '../errors.js';
import type {
  AudioInput,
  AudioInspection,
  AudioOutputPreset,
  AudioTranscoderCapabilities,
  DecodedAudio,
  EncodedAudio,
  PcmAudio,
} from '../engine/contracts.js';
import type {
  AudioCodecOperationContext,
  AudioDecoderAdapter,
  AudioEncoderAdapter,
  AudioInspectorAdapter,
} from './contracts.js';

interface CodecRegistryOptions {
  readonly decoders: readonly AudioDecoderAdapter[];
  readonly encoders: readonly AudioEncoderAdapter[];
  readonly inspectors: readonly AudioInspectorAdapter[];
}

interface RegisteredEncoder {
  readonly adapter: AudioEncoderAdapter;
  readonly preset: AudioOutputPreset;
}

export class CodecRegistry {
  readonly #capabilities: AudioTranscoderCapabilities;
  readonly #decoders: readonly AudioDecoderAdapter[];
  readonly #encoders: ReadonlyMap<string, RegisteredEncoder>;
  readonly #inspectors: readonly AudioInspectorAdapter[];

  constructor(options: CodecRegistryOptions) {
    assertUniqueIds('inspector', options.inspectors);
    assertUniqueIds('decoder', options.decoders);
    assertUniqueIds('encoder', options.encoders);

    this.#inspectors = Object.freeze([...options.inspectors]);
    this.#decoders = Object.freeze([...options.decoders]);
    this.#encoders = registerEncoders(options.encoders);
    this.#capabilities = createCapabilities(
      this.#inspectors,
      this.#decoders,
      this.#encoders,
    );
  }

  inspect(input: AudioInput): AudioInspection {
    for (const inspector of this.#inspectors) {
      const result = inspector.inspect(input);
      if (result !== null) {
        return freezeInspection(result);
      }
    }

    return freezeInspection(createUnknownInspection(input));
  }

  async decode(
    input: AudioInput,
    context: AudioCodecOperationContext,
  ): Promise<DecodedAudio> {
    for (const decoder of this.#decoders) {
      context.throwIfAborted();
      const result = await decoder.decode(input, context);
      if (result !== null) {
        return freezeDecodedAudio(result);
      }
    }

    throw new AudioTranscoderError(
      'UNSUPPORTED_INPUT',
      'No registered decoder supports this audio input.',
    );
  }

  async encode(
    audio: PcmAudio,
    presetId: string,
    context: AudioCodecOperationContext,
  ): Promise<EncodedAudio> {
    context.throwIfAborted();
    const registration = this.#encoders.get(presetId);
    if (registration === undefined) {
      throw new AudioTranscoderError(
        'UNSUPPORTED_OUTPUT',
        `No registered encoder supports preset "${presetId}".`,
      );
    }

    return registration.adapter.encode(audio, registration.preset, context);
  }

  getCapabilities(): AudioTranscoderCapabilities {
    return this.#capabilities;
  }
}

function assertUniqueIds(
  kind: string,
  adapters: readonly { readonly id: string }[],
): void {
  const ids = new Set<string>();
  for (const adapter of adapters) {
    if (ids.has(adapter.id)) {
      throw new AudioTranscoderError(
        'DUPLICATE_REGISTRATION',
        `Duplicate ${kind} adapter id "${adapter.id}".`,
      );
    }
    ids.add(adapter.id);
  }
}

function registerEncoders(
  adapters: readonly AudioEncoderAdapter[],
): ReadonlyMap<string, RegisteredEncoder> {
  const registrations = new Map<string, RegisteredEncoder>();

  for (const adapter of adapters) {
    for (const preset of adapter.presets) {
      if (registrations.has(preset.id)) {
        throw new AudioTranscoderError(
          'DUPLICATE_REGISTRATION',
          `Duplicate output preset id "${preset.id}".`,
        );
      }
      registrations.set(preset.id, { adapter, preset: freezePreset(preset) });
    }
  }

  return registrations;
}

function createCapabilities(
  inspectors: readonly AudioInspectorAdapter[],
  decoders: readonly AudioDecoderAdapter[],
  encoders: ReadonlyMap<string, RegisteredEncoder>,
): AudioTranscoderCapabilities {
  return Object.freeze({
    inspect: uniqueSorted(inspectors.flatMap(({ formats }) => formats)),
    decode: uniqueSorted(decoders.flatMap(({ formats }) => formats)),
    encode: Object.freeze(
      [...encoders.values()]
        .map(({ preset }) => preset)
        .sort((left, right) => left.id.localeCompare(right.id)),
    ),
  });
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}

function freezePreset(preset: AudioOutputPreset): AudioOutputPreset {
  return Object.freeze({ ...preset });
}

function freezeInspection(inspection: AudioInspection): AudioInspection {
  return Object.freeze({
    ...inspection,
    notes: Object.freeze([...inspection.notes]),
  });
}

function freezeDecodedAudio(audio: DecodedAudio): DecodedAudio {
  return Object.freeze({
    ...audio,
    channelData: Object.freeze([...audio.channelData]),
  });
}

function createUnknownInspection(input: AudioInput): AudioInspection {
  const extension = input.name?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];

  return {
    bitDepth: null,
    channels: null,
    codec: 'Unknown',
    container: extension?.toUpperCase() ?? 'Unknown',
    decodeSupport: 'unknown',
    durationSeconds: null,
    notes: [
      'Unknown header. A browser or codec plugin may still support this input.',
    ],
    sampleRate: null,
  };
}
