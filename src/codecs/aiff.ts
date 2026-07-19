import { AudioTranscoderError } from '../errors.js';
import type {
  AudioInput,
  AudioInspection,
  AudioOutputPreset,
  DecodedAudio,
  EncodedAudio,
  PcmAudio,
} from '../engine/contracts.js';
import {
  readAscii,
  readExtended80,
  writeAscii,
  writeExtended80,
  writeInt24BE,
} from './binary.js';
import type {
  AudioCodecOperationContext,
  AudioDecoderAdapter,
  AudioEncoderAdapter,
  AudioInspectorAdapter,
} from './contracts.js';
import {
  readPcmSample,
  sampleToInteger,
  validatePcmAudio,
} from './pcm.js';
import { processFrameBatches } from './frame-batches.js';

interface AiffCommon {
  readonly bitDepth: number;
  readonly channels: number;
  readonly compression: string;
  readonly frames: number;
  readonly sampleRate: number;
}

interface AiffSoundData {
  readonly offset: number;
  readonly size: number;
}

interface ParsedAiff {
  readonly common: AiffCommon | null;
  readonly formType: 'AIFC' | 'AIFF';
  readonly soundData: AiffSoundData | null;
}

export const AIFF_OUTPUT_PRESETS = Object.freeze([
  createPreset('aiff-pcm16', 16),
  createPreset('aiff-pcm24', 24),
]);

const AIFF_BIT_DEPTHS: Readonly<Record<string, 16 | 24>> = Object.freeze({
  'aiff-pcm16': 16,
  'aiff-pcm24': 24,
});

export const aiffInspector: AudioInspectorAdapter = Object.freeze({
  formats: Object.freeze(['aif', 'aifc', 'aiff']),
  id: 'builtin.aiff.inspector',
  inspect(input: AudioInput): AudioInspection | null {
    const view = new DataView(input.data);
    if (!isAiff(view)) {
      return null;
    }

    const parsed = parseAiff(view);
    const common = parsed.common;
    const builtIn = common?.compression === 'NONE';

    return {
      bitDepth: common?.bitDepth ?? null,
      channels: common?.channels ?? null,
      codec:
        common === null
          ? 'Unknown'
          : builtIn
            ? 'PCM integer'
            : `Compression ${common.compression}`,
      container: parsed.formType,
      decodeSupport: builtIn ? 'built-in' : 'browser-dependent',
      durationSeconds:
        common !== null && common.sampleRate > 0
          ? common.frames / common.sampleRate
          : null,
      notes:
        common === null
          ? ['AIFF COMM chunk was not found.']
          : parsed.soundData === null
            ? ['AIFF SSND chunk was not found.']
            : [],
      sampleRate: common?.sampleRate ?? null,
    };
  },
});

export const aiffDecoder: AudioDecoderAdapter = Object.freeze({
  formats: Object.freeze(['aif', 'aifc', 'aiff']),
  id: 'builtin.aiff.decoder',
  async decode(
    input: AudioInput,
    context?: AudioCodecOperationContext,
  ): Promise<DecodedAudio | null> {
    const view = new DataView(input.data);
    if (!isAiff(view)) {
      return null;
    }

    const parsed = parseAiff(view);
    const common = parsed.common;
    const soundData = parsed.soundData;
    if (common === null || soundData === null) {
      throw invalidAiff('AIFF requires both COMM and SSND chunks.');
    }
    if (common.compression !== 'NONE') {
      throw new AudioTranscoderError(
        'UNSUPPORTED_INPUT',
        `AIFF compression "${common.compression}" is not built-in PCM.`,
      );
    }
    if (
      common.channels <= 0 ||
      !Number.isFinite(common.sampleRate) ||
      common.sampleRate <= 0 ||
      common.bitDepth <= 0 ||
      common.bitDepth % 8 !== 0
    ) {
      throw invalidAiff('AIFF PCM format fields are invalid.');
    }

    const bytesPerSample = common.bitDepth / 8;
    const bytesPerFrame = common.channels * bytesPerSample;
    const availableBytes = Math.min(
      soundData.size,
      Math.max(0, view.byteLength - soundData.offset),
    );
    const frames = Math.min(
      common.frames,
      Math.floor(availableBytes / bytesPerFrame),
    );
    if (frames === 0) {
      throw invalidAiff('AIFF SSND chunk does not contain a complete frame.');
    }

    const channelData = Array.from(
      { length: common.channels },
      () => new Float32Array(frames),
    );
    await processFrameBatches(frames, context, (startFrame, endFrame) => {
      for (let frame = startFrame; frame < endFrame; frame += 1) {
        for (let channel = 0; channel < common.channels; channel += 1) {
          const target = channelData[channel]!;
          const offset =
            soundData.offset +
            (frame * common.channels + channel) * bytesPerSample;
          target[frame] = readPcmSample(
            view,
            offset,
            common.bitDepth,
            { float: false, littleEndian: false, signed: true },
          );
        }
      }
    });

    return {
      channelData,
      durationSeconds: frames / common.sampleRate,
      sampleRate: common.sampleRate,
      source: 'AIFF PCM decoder',
    };
  },
});

export const aiffEncoder: AudioEncoderAdapter = Object.freeze({
  id: 'builtin.aiff.encoder',
  presets: AIFF_OUTPUT_PRESETS,
  async encode(
    audio: PcmAudio,
    preset: AudioOutputPreset,
    context?: AudioCodecOperationContext,
  ): Promise<EncodedAudio> {
    const bitDepth = AIFF_BIT_DEPTHS[preset.id];
    if (bitDepth === undefined) {
      throw new AudioTranscoderError(
        'UNSUPPORTED_OUTPUT',
        `AIFF encoder does not support preset "${preset.id}".`,
      );
    }

    const { channels, frames, sampleRate } = validatePcmAudio(audio);
    const bytesPerSample = bitDepth / 8;
    const dataBytes = frames * channels * bytesPerSample;
    const soundChunkSize = 8 + dataBytes;
    const dataPadding = dataBytes % 2;
    const totalBytes = 12 + 8 + 18 + 8 + soundChunkSize + dataPadding;
    const buffer = new ArrayBuffer(totalBytes);
    const view = new DataView(buffer);

    writeAscii(view, 0, 'FORM');
    view.setUint32(4, totalBytes - 8, false);
    writeAscii(view, 8, 'AIFF');

    let offset = 12;
    writeAscii(view, offset, 'COMM');
    view.setUint32(offset + 4, 18, false);
    view.setUint16(offset + 8, channels, false);
    view.setUint32(offset + 10, frames, false);
    view.setUint16(offset + 14, bitDepth, false);
    writeExtended80(view, offset + 16, sampleRate);
    offset += 26;

    writeAscii(view, offset, 'SSND');
    view.setUint32(offset + 4, soundChunkSize, false);
    view.setUint32(offset + 8, 0, false);
    view.setUint32(offset + 12, 0, false);
    offset += 16;

    const soundDataOffset = offset;
    await processFrameBatches(frames, context, (startFrame, endFrame) => {
      for (let frame = startFrame; frame < endFrame; frame += 1) {
        for (let channel = 0; channel < channels; channel += 1) {
          const sample = audio.channelData[channel]![frame]!;
          const sampleOffset =
            soundDataOffset +
            (frame * channels + channel) * bytesPerSample;
          if (bitDepth === 16) {
            view.setInt16(sampleOffset, sampleToInteger(sample, 16), false);
          } else {
            writeInt24BE(view, sampleOffset, sampleToInteger(sample, 24));
          }
        }
      }
    });

    return Object.freeze({ data: buffer, preset });
  },
});

function isAiff(view: DataView): boolean {
  const formType = readAscii(view, 8, 4);
  return (
    readAscii(view, 0, 4) === 'FORM' &&
    (formType === 'AIFF' || formType === 'AIFC')
  );
}

function parseAiff(view: DataView): ParsedAiff {
  const formType = readAscii(view, 8, 4) as 'AIFC' | 'AIFF';
  let offset = 12;
  let common: AiffCommon | null = null;
  let soundData: AiffSoundData | null = null;

  while (offset + 8 <= view.byteLength) {
    const chunkId = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, false);
    const dataOffset = offset + 8;

    if (chunkId === 'COMM' && chunkSize >= 18 && dataOffset + 18 <= view.byteLength) {
      common = {
        bitDepth: view.getUint16(dataOffset + 6, false),
        channels: view.getUint16(dataOffset, false),
        compression:
          formType === 'AIFC' && chunkSize >= 22 && dataOffset + 22 <= view.byteLength
            ? readAscii(view, dataOffset + 18, 4)
            : 'NONE',
        frames: view.getUint32(dataOffset + 2, false),
        sampleRate: readExtended80(view, dataOffset + 8),
      };
    }

    if (chunkId === 'SSND' && chunkSize >= 8 && dataOffset + 8 <= view.byteLength) {
      const soundOffset = view.getUint32(dataOffset, false);
      soundData = {
        offset: dataOffset + 8 + soundOffset,
        size: Math.max(0, chunkSize - 8 - soundOffset),
      };
      break;
    }

    offset = dataOffset + chunkSize + (chunkSize % 2);
  }

  return { common, formType, soundData };
}

function createPreset(
  id: string,
  bitDepth: 16 | 24,
): AudioOutputPreset {
  return Object.freeze({
    bitDepth,
    container: 'aiff',
    extension: 'aiff',
    id,
    mimeType: 'audio/aiff',
    sampleFormat: 'integer',
  });
}

function invalidAiff(message: string): AudioTranscoderError {
  return new AudioTranscoderError('INVALID_AUDIO_DATA', message);
}
