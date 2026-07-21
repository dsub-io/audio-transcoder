import { describe, expect, it } from 'vitest';
import type { AudioInspection } from '../engine/contracts.js';
import {
  getAudioStreamOutputEncodingOptions,
  getAudioStreamOutputParameters,
  resolveAudioStreamFormatTarget,
} from './format-target.js';

const MONO_192K_SOURCE = Object.freeze({
  bitDepth: 32,
  channels: 1,
  codec: 'lpcm float BE',
  container: 'CAF',
  decodeSupport: 'built-in',
  durationSeconds: 1,
  notes: Object.freeze([]),
  sampleRate: 192_000,
} satisfies AudioInspection);

describe('semantic stream output parameters', () => {
  it('describes WAV sample format and dependent bit depth without UI labels', () => {
    expect(getAudioStreamOutputParameters('wav')).toEqual([
      {
        id: 'sample-format',
        options: [
          {
            presetIds: ['wav-pcm16', 'wav-pcm24', 'wav-pcm32'],
            value: 'integer',
          },
          { presetIds: ['wav-float32'], value: 'float' },
        ],
      },
      {
        id: 'bit-depth',
        options: [
          { presetIds: ['wav-pcm16'], value: 16 },
          { presetIds: ['wav-pcm24'], value: 24 },
          { presetIds: ['wav-pcm32', 'wav-float32'], value: 32 },
        ],
      },
    ]);

    expect(
      getAudioStreamOutputParameters('wav', { sampleFormat: 'float' }),
    ).toEqual([
      {
        id: 'sample-format',
        options: [
          {
            presetIds: ['wav-pcm16', 'wav-pcm24', 'wav-pcm32'],
            value: 'integer',
          },
          { presetIds: ['wav-float32'], value: 'float' },
        ],
      },
      {
        id: 'bit-depth',
        options: [{ presetIds: ['wav-float32'], value: 32 }],
      },
    ]);
  });

  it('describes MP3 bitrate values and stable preset identities', () => {
    expect(getAudioStreamOutputParameters('mp3')).toEqual([
      {
        id: 'bitrate-bps',
        options: [
          { presetIds: ['mp3-128kbps'], value: 128_000 },
          { presetIds: ['mp3-192kbps'], value: 192_000 },
          { presetIds: ['mp3-256kbps'], value: 256_000 },
          { presetIds: ['mp3-320kbps'], value: 320_000 },
        ],
      },
    ]);
    expect(getAudioStreamOutputEncodingOptions('missing')).toEqual([]);
  });

  it('describes the exact AAC and Ogg Opus bitrate choices', () => {
    expect(getAudioStreamOutputParameters('aac')).toEqual([
      {
        id: 'bitrate-bps',
        options: [
          { presetIds: ['aac-96kbps'], value: 96_000 },
          { presetIds: ['aac-128kbps'], value: 128_000 },
          { presetIds: ['aac-192kbps'], value: 192_000 },
          { presetIds: ['aac-256kbps'], value: 256_000 },
        ],
      },
    ]);
    expect(getAudioStreamOutputParameters('ogg')).toEqual([
      {
        id: 'bitrate-bps',
        options: [
          { presetIds: ['ogg-opus-64kbps'], value: 64_000 },
          { presetIds: ['ogg-opus-96kbps'], value: 96_000 },
          { presetIds: ['ogg-opus-128kbps'], value: 128_000 },
          { presetIds: ['ogg-opus-192kbps'], value: 192_000 },
        ],
      },
    ]);
  });
});

describe('semantic stream target resolution', () => {
  it('preserves source rate and channels while resolving an exact preset', () => {
    const result = resolveAudioStreamFormatTarget(
      {
        formatId: 'wav',
        parameters: { bitDepth: 24, sampleFormat: 'integer' },
      },
      MONO_192K_SOURCE,
    );

    expect(result).toMatchObject({
      probeTarget: {
        channels: 1,
        presetId: 'wav-pcm24',
        sampleRate: 192_000,
      },
      status: 'resolved',
      target: { presetId: 'wav-pcm24' },
    });
    expect(Object.keys(result.status === 'resolved' ? result.target : {})).toEqual([
      'presetId',
    ]);
  });

  it('includes an explicit resampling rate only when selected', () => {
    const result = resolveAudioStreamFormatTarget(
      {
        formatId: 'wav',
        presetId: 'wav-float32',
        sampleRate: 48_000,
      },
      MONO_192K_SOURCE,
    );

    expect(result).toMatchObject({
      probeTarget: {
        channels: 1,
        presetId: 'wav-float32',
        sampleRate: 48_000,
      },
      status: 'resolved',
      target: { presetId: 'wav-float32', sampleRate: 48_000 },
    });
  });

  it('requires an explicit 48 kHz target when Ogg Opus needs resampling', () => {
    expect(
      resolveAudioStreamFormatTarget(
        {
          formatId: 'ogg',
          parameters: { bitrateBps: 128_000 },
        },
        MONO_192K_SOURCE,
      ),
    ).toMatchObject({ reason: 'sample-rate', status: 'unsupported' });

    expect(
      resolveAudioStreamFormatTarget(
        {
          formatId: 'ogg',
          parameters: { bitrateBps: 128_000 },
          sampleRate: 48_000,
        },
        MONO_192K_SOURCE,
      ),
    ).toMatchObject({
      probeTarget: {
        channels: 1,
        presetId: 'ogg-opus-128kbps',
        sampleRate: 48_000,
      },
      status: 'resolved',
      target: { presetId: 'ogg-opus-128kbps', sampleRate: 48_000 },
    });
  });

  it('returns structured errors for ambiguous and unsupported selections', () => {
    expect(
      resolveAudioStreamFormatTarget({ formatId: 'wav' }, MONO_192K_SOURCE),
    ).toMatchObject({ reason: 'parameters', status: 'unsupported' });
    expect(
      resolveAudioStreamFormatTarget(
        { formatId: 'mp3', parameters: { bitrateBps: 320_000 } },
        MONO_192K_SOURCE,
      ),
    ).toMatchObject({ reason: 'sample-rate', status: 'unsupported' });
    expect(
      resolveAudioStreamFormatTarget(
        { formatId: 'flac', presetId: 'wav-pcm24' },
        MONO_192K_SOURCE,
      ),
    ).toMatchObject({ reason: 'preset', status: 'unsupported' });
  });

  it('rejects unknown formats and incomplete source inspection', () => {
    expect(
      resolveAudioStreamFormatTarget(
        { formatId: 'not-installed' },
        MONO_192K_SOURCE,
      ),
    ).toMatchObject({ reason: 'format', status: 'unsupported' });
    expect(
      resolveAudioStreamFormatTarget(
        { formatId: 'aiff', presetId: 'aiff-pcm16' },
        { ...MONO_192K_SOURCE, channels: null },
      ),
    ).toMatchObject({ reason: 'source-inspection', status: 'unsupported' });
    expect(
      resolveAudioStreamFormatTarget(
        { formatId: 'aiff', presetId: 'aiff-pcm16' },
        { ...MONO_192K_SOURCE, sampleRate: null },
      ),
    ).toMatchObject({ reason: 'source-inspection', status: 'unsupported' });
    expect(
      resolveAudioStreamFormatTarget(
        {
          formatId: 'wav',
          presetId: 'wav-pcm16',
          sampleRate: 48_000,
        },
        { ...MONO_192K_SOURCE, sampleRate: 48_000.5 },
      ),
    ).toMatchObject({ reason: 'source-inspection', status: 'unsupported' });
  });

  it.each([0, 1.5, 33])(
    'rejects an invalid source channel count of %s',
    (channels) => {
      expect(
        resolveAudioStreamFormatTarget(
          { formatId: 'aiff', presetId: 'aiff-pcm16' },
          { ...MONO_192K_SOURCE, channels },
        ),
      ).toMatchObject({ reason: 'channels', status: 'unsupported' });
    },
  );

  it('rejects source channels outside the selected preset range', () => {
    expect(
      resolveAudioStreamFormatTarget(
        { formatId: 'mp3', presetId: 'mp3-192kbps' },
        { ...MONO_192K_SOURCE, channels: 3, sampleRate: 48_000 },
      ),
    ).toMatchObject({ reason: 'channels', status: 'unsupported' });
  });

  it('rejects a preset that conflicts with semantic parameters', () => {
    expect(
      resolveAudioStreamFormatTarget(
        {
          formatId: 'wav',
          parameters: { bitDepth: 16 },
          presetId: 'wav-pcm24',
        },
        MONO_192K_SOURCE,
      ),
    ).toMatchObject({ reason: 'parameters', status: 'unsupported' });
  });

  it('distinguishes no semantic match from an ambiguous selection', () => {
    expect(
      resolveAudioStreamFormatTarget(
        { formatId: 'wav', parameters: { bitDepth: 12 } },
        MONO_192K_SOURCE,
      ),
    ).toMatchObject({
      message: expect.stringContaining('No preset'),
      reason: 'parameters',
      status: 'unsupported',
    });
    expect(
      resolveAudioStreamFormatTarget(
        { formatId: 'wav', parameters: { codec: 'pcm' } },
        MONO_192K_SOURCE,
      ),
    ).toMatchObject({
      message: expect.stringContaining('do not select one exact preset'),
      reason: 'parameters',
      status: 'unsupported',
    });
  });
});
