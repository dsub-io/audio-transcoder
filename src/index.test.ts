import { describe, expect, it } from 'vitest';
import {
  AIFF_OUTPUT_PRESETS,
  AUDIO_TRANSCODER_PACKAGE,
  AUDIO_TRANSCODER_VERSION,
  AudioTranscoderError,
  WAV_OUTPUT_PRESETS,
  audioTranscoder,
  createAudioTranscoderEngine,
  getEngineInfo,
  getVersion,
  type AudioOutputPreset,
  type AudioTranscoderPlugin,
} from './index.js';
import { CodecRegistry } from './codecs/codec-registry.js';
import { DefaultAudioTranscoderEngine } from './engine/default-audio-transcoder-engine.js';

const SEMANTIC_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const UNKNOWN_INPUT = { data: new Uint8Array([1, 2, 3]).buffer };

describe('public package metadata', () => {
  it('exposes the package name and a semantic version', () => {
    expect(AUDIO_TRANSCODER_PACKAGE).toBe('@dsub/audio-transcoder');
    expect(AUDIO_TRANSCODER_VERSION).toMatch(SEMANTIC_VERSION_PATTERN);
  });

  it('provides both engine and functional version APIs', () => {
    expect(audioTranscoder.getVersion()).toBe(AUDIO_TRANSCODER_VERSION);
    expect(getVersion()).toBe(AUDIO_TRANSCODER_VERSION);
  });

  it('returns stable, immutable engine information', () => {
    const info = getEngineInfo();

    expect(info).toBe(audioTranscoder.getInfo());
    expect(info).toEqual({
      name: AUDIO_TRANSCODER_PACKAGE,
      version: AUDIO_TRANSCODER_VERSION,
    });
    expect(Object.isFrozen(info)).toBe(true);
  });
});

describe('built-in engine facade', () => {
  it('reports deterministic immutable capabilities', () => {
    const capabilities = audioTranscoder.getCapabilities();

    expect(capabilities.inspect).toEqual([
      'aif',
      'aifc',
      'aiff',
      'caf',
      'flac',
      'mp3',
      'wav',
    ]);
    expect(capabilities.decode).toEqual(['aif', 'aifc', 'aiff', 'caf', 'wav']);
    expect(capabilities.encode.map(({ id }) => id)).toEqual([
      'aiff-pcm16',
      'aiff-pcm24',
      'wav-float32',
      'wav-pcm16',
      'wav-pcm24',
    ]);
    expect(capabilities.encode).toEqual(
      [...AIFF_OUTPUT_PRESETS, ...WAV_OUTPUT_PRESETS].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    );
    expect(Object.isFrozen(capabilities)).toBe(true);
    expect(Object.isFrozen(capabilities.inspect)).toBe(true);
    expect(Object.isFrozen(capabilities.decode)).toBe(true);
    expect(Object.isFrozen(capabilities.encode)).toBe(true);
    expect(Object.isFrozen(capabilities.encode[0])).toBe(true);
  });

  it('returns immutable unknown inspection details', () => {
    const withExtension = audioTranscoder.inspect({
      ...UNKNOWN_INPUT,
      name: 'recording.xyz',
    });
    const withoutExtension = audioTranscoder.inspect(UNKNOWN_INPUT);

    expect(withExtension.container).toBe('XYZ');
    expect(withExtension.decodeSupport).toBe('unknown');
    expect(withoutExtension.container).toBe('Unknown');
    expect(Object.isFrozen(withExtension)).toBe(true);
    expect(Object.isFrozen(withExtension.notes)).toBe(true);
  });

  it('rejects unsupported input and output with stable error codes', async () => {
    await expect(audioTranscoder.decode(UNKNOWN_INPUT)).rejects.toMatchObject({
      code: 'UNSUPPORTED_INPUT',
      name: 'AudioTranscoderError',
    });
    await expect(
      audioTranscoder.encode(
        { channelData: [new Float32Array([0])], sampleRate: 48_000 },
        'missing',
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OUTPUT' });
  });
});

describe('plugin composition', () => {
  it('prioritizes plugins and supports async decode-to-encode transcoding', async () => {
    const preset = createTestPreset('test-output');
    const plugin: AudioTranscoderPlugin = {
      id: 'test-plugin',
      inspectors: [
        {
          formats: ['test'],
          id: 'test-inspector',
          inspect: () => ({
            bitDepth: 32,
            channels: 1,
            codec: 'Test PCM',
            container: 'TEST',
            decodeSupport: 'built-in',
            durationSeconds: 1,
            notes: ['plugin'],
            sampleRate: 1,
          }),
        },
      ],
      decoders: [
        {
          formats: ['test'],
          id: 'test-decoder',
          decode: async () => ({
            channelData: [new Float32Array([0.25])],
            durationSeconds: 1,
            sampleRate: 1,
            source: 'test decoder',
          }),
        },
      ],
      encoders: [
        {
          id: 'test-encoder',
          presets: [preset],
          encode: async (audio, selectedPreset) => ({
            data: new Uint8Array([audio.channelData.length]).buffer,
            preset: selectedPreset,
          }),
        },
      ],
    };
    const engine = createAudioTranscoderEngine({ plugins: [plugin] });

    const inspection = engine.inspect(UNKNOWN_INPUT);
    const decoded = await engine.decode(UNKNOWN_INPUT);
    const transcoded = await engine.transcode(UNKNOWN_INPUT, preset.id);

    expect(inspection.container).toBe('TEST');
    expect(Object.isFrozen(inspection.notes)).toBe(true);
    expect(decoded.source).toBe('test decoder');
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.channelData)).toBe(true);
    expect(new Uint8Array(transcoded.data)).toEqual(new Uint8Array([1]));
    expect(engine.getCapabilities().inspect).toContain('test');
    expect(engine.getCapabilities().encode).toContainEqual(preset);
  });

  it('creates independent facades over shared immutable metadata', () => {
    const first = createAudioTranscoderEngine();
    const second = createAudioTranscoderEngine();

    expect(first).not.toBe(second);
    expect(first.getInfo()).toEqual(second.getInfo());
    expect(first.getVersion()).toBe(AUDIO_TRANSCODER_VERSION);
  });

  it.each([
    ['plugin', duplicatePluginOptions()],
    ['inspector adapter', duplicateInspectorOptions()],
    ['decoder adapter', duplicateDecoderOptions()],
    ['encoder adapter', duplicateEncoderOptions()],
    ['output preset', duplicatePresetOptions()],
  ])('rejects duplicate %s registrations', (_kind, options) => {
    expect(() => createAudioTranscoderEngine(options)).toThrowError(
      expect.objectContaining({ code: 'DUPLICATE_REGISTRATION' }),
    );
  });
});

describe('DefaultAudioTranscoderEngine', () => {
  it('takes an immutable snapshot of injected engine information', () => {
    const source = { name: 'test-engine', version: '1.2.3' };
    const registry = new CodecRegistry({
      decoders: [],
      encoders: [],
      inspectors: [],
    });
    const engine = new DefaultAudioTranscoderEngine(source, registry);

    source.name = 'changed';
    source.version = '9.9.9';

    expect(engine.getInfo()).toEqual({
      name: 'test-engine',
      version: '1.2.3',
    });
    expect(engine.getVersion()).toBe('1.2.3');
    expect(Object.isFrozen(engine.getInfo())).toBe(true);
  });
});

describe('AudioTranscoderError', () => {
  it('preserves its machine-readable code and message', () => {
    const error = new AudioTranscoderError('INVALID_AUDIO_DATA', 'bad input');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AudioTranscoderError');
    expect(error.code).toBe('INVALID_AUDIO_DATA');
    expect(error.message).toBe('bad input');
  });
});

function createTestPreset(id: string): AudioOutputPreset {
  return {
    bitDepth: null,
    container: 'test',
    extension: 'test',
    id,
    mimeType: 'audio/test',
    sampleFormat: 'lossy',
  };
}

function duplicatePluginOptions() {
  return { plugins: [{ id: 'same' }, { id: 'same' }] };
}

function duplicateInspectorOptions() {
  const inspector = {
    formats: ['test'],
    id: 'same-inspector',
    inspect: () => null,
  };
  return {
    plugins: [
      { id: 'one', inspectors: [inspector] },
      { id: 'two', inspectors: [inspector] },
    ],
  };
}

function duplicateDecoderOptions() {
  const decoder = {
    formats: ['test'],
    id: 'same-decoder',
    decode: () => null,
  };
  return {
    plugins: [
      { id: 'one', decoders: [decoder] },
      { id: 'two', decoders: [decoder] },
    ],
  };
}

function duplicateEncoderOptions() {
  const encoder = {
    id: 'same-encoder',
    presets: [createTestPreset('one'), createTestPreset('two')],
    encode: () => ({ data: new ArrayBuffer(0), preset: createTestPreset('one') }),
  };
  return {
    plugins: [
      { id: 'one', encoders: [encoder] },
      { id: 'two', encoders: [encoder] },
    ],
  };
}

function duplicatePresetOptions() {
  return {
    plugins: [
      {
        id: 'duplicate-preset',
        encoders: [
          {
            id: 'custom-encoder',
            presets: [createTestPreset('wav-pcm16')],
            encode: (_audio: unknown, preset: AudioOutputPreset) => ({
              data: new ArrayBuffer(0),
              preset,
            }),
          },
        ],
      },
    ],
  };
}
