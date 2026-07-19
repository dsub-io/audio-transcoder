import { AudioTranscoderError } from '../errors.js';
import type {
  AudioInput,
  AudioInspection,
  DecodedAudio,
} from '../engine/contracts.js';
import { readAscii, readInt64BE } from './binary.js';
import type {
  AudioCodecOperationContext,
  AudioDecoderAdapter,
  AudioInspectorAdapter,
} from './contracts.js';
import { readPcmSample } from './pcm.js';
import { processFrameBatches } from './frame-batches.js';

interface CafDescription {
  readonly bitDepth: number;
  readonly bytesPerPacket: number;
  readonly channels: number;
  readonly flags: number;
  readonly formatId: string;
  readonly framesPerPacket: number;
  readonly sampleRate: number;
}

interface CafData {
  readonly offset: number;
  readonly size: number;
}

interface CafFlags {
  readonly bigEndian: boolean;
  readonly float: boolean;
  readonly label: string;
  readonly signed: boolean;
}

interface ParsedCaf {
  readonly data: CafData | null;
  readonly description: CafDescription | null;
}

export const cafInspector: AudioInspectorAdapter = Object.freeze({
  formats: Object.freeze(['caf']),
  id: 'builtin.caf.inspector',
  inspect(input: AudioInput): AudioInspection | null {
    const view = new DataView(input.data);
    if (!isCaf(view)) {
      return null;
    }

    const parsed = parseCaf(view, input.size ?? input.data.byteLength);
    const description = parsed.description;
    const bytesPerFrame =
      description !== null && description.framesPerPacket > 0
        ? description.bytesPerPacket / description.framesPerPacket
        : null;
    const durationSeconds =
      description !== null &&
      parsed.data !== null &&
      bytesPerFrame !== null &&
      bytesPerFrame > 0 &&
      description.sampleRate > 0
        ? parsed.data.size / bytesPerFrame / description.sampleRate
        : null;
    const isLpcm = description?.formatId === 'lpcm';
    const builtIn =
      isLpcm && !hasUnsupportedLpcmLayout(description.flags);

    return {
      bitDepth: description?.bitDepth ?? null,
      channels: description?.channels ?? null,
      codec:
        description === null
          ? 'Unknown'
          : `${description.formatId} ${decodeCafFlags(description.flags).label}`,
      container: 'CAF',
      decodeSupport: builtIn ? 'built-in' : 'browser-dependent',
      durationSeconds,
      notes:
        description === null
          ? ['CAF desc chunk was not found.']
          : builtIn
            ? []
            : isLpcm
              ? ['CAF LPCM layout requires a codec plugin.']
              : ['Compressed CAF requires a browser decoder or codec plugin.'],
      sampleRate: description?.sampleRate ?? null,
    };
  },
});

export const cafDecoder: AudioDecoderAdapter = Object.freeze({
  formats: Object.freeze(['caf']),
  id: 'builtin.caf.decoder',
  async decode(
    input: AudioInput,
    context?: AudioCodecOperationContext,
  ): Promise<DecodedAudio | null> {
    const view = new DataView(input.data);
    if (!isCaf(view)) {
      return null;
    }

    const parsed = parseCaf(view, input.size ?? input.data.byteLength);
    const description = parsed.description;
    const data = parsed.data;
    if (description === null || data === null) {
      throw invalidCaf('CAF requires both desc and data chunks.');
    }
    if (description.formatId !== 'lpcm') {
      throw new AudioTranscoderError(
        'UNSUPPORTED_INPUT',
        `CAF format "${description.formatId}" is not built-in LPCM.`,
      );
    }
    if (hasUnsupportedLpcmLayout(description.flags)) {
      throw new AudioTranscoderError(
        'UNSUPPORTED_INPUT',
        'Non-interleaved or high-aligned CAF LPCM is not built in.',
      );
    }
    if (
      description.channels <= 0 ||
      !Number.isFinite(description.sampleRate) ||
      description.sampleRate <= 0 ||
      description.framesPerPacket <= 0 ||
      description.bytesPerPacket <= 0 ||
      description.bitDepth <= 0 ||
      description.bitDepth % 8 !== 0
    ) {
      throw invalidCaf('CAF LPCM description fields are invalid.');
    }

    const bytesPerSample = description.bitDepth / 8;
    const bytesPerFrame =
      description.bytesPerPacket / description.framesPerPacket;
    if (
      !Number.isInteger(bytesPerFrame) ||
      bytesPerSample * description.channels > bytesPerFrame
    ) {
      throw invalidCaf('CAF packet layout is not valid interleaved PCM.');
    }

    const availableBytes = Math.min(
      data.size,
      Math.max(0, view.byteLength - data.offset),
    );
    const frames = Math.floor(availableBytes / bytesPerFrame);
    if (frames === 0) {
      throw invalidCaf('CAF data chunk does not contain a complete frame.');
    }

    const flags = decodeCafFlags(description.flags);
    const channelData = Array.from(
      { length: description.channels },
      () => new Float32Array(frames),
    );

    await processFrameBatches(frames, context, (startFrame, endFrame) => {
      for (let frame = startFrame; frame < endFrame; frame += 1) {
        const frameOffset = data.offset + frame * bytesPerFrame;
        for (let channel = 0; channel < description.channels; channel += 1) {
          const target = channelData[channel]!;
          target[frame] = readPcmSample(
            view,
            frameOffset + channel * bytesPerSample,
            description.bitDepth,
            {
              float: flags.float,
              littleEndian: !flags.bigEndian,
              signed: flags.signed || flags.float,
            },
          );
        }
      }
    });

    return {
      channelData,
      durationSeconds: frames / description.sampleRate,
      sampleRate: description.sampleRate,
      source: 'CAF LPCM decoder',
    };
  },
});

function isCaf(view: DataView): boolean {
  return readAscii(view, 0, 4) === 'caff';
}

function parseCaf(view: DataView, fileSize: number): ParsedCaf {
  let offset = 8;
  let description: CafDescription | null = null;
  let data: CafData | null = null;

  while (offset + 12 <= view.byteLength) {
    const chunkType = readAscii(view, offset, 4);
    const chunkSize = readInt64BE(view, offset + 4);
    const dataOffset = offset + 12;
    const logicalSize =
      chunkSize < 0n ? BigInt(Math.max(0, fileSize - dataOffset)) : chunkSize;

    if (chunkType === 'desc' && logicalSize >= 32n && dataOffset + 32 <= view.byteLength) {
      description = {
        bitDepth: view.getUint32(dataOffset + 28, false),
        bytesPerPacket: view.getUint32(dataOffset + 16, false),
        channels: view.getUint32(dataOffset + 24, false),
        flags: view.getUint32(dataOffset + 12, false),
        formatId: readAscii(view, dataOffset + 8, 4),
        framesPerPacket: view.getUint32(dataOffset + 20, false),
        sampleRate: view.getFloat64(dataOffset, false),
      };
    }

    if (chunkType === 'data') {
      data = {
        offset: dataOffset + 4,
        size: Math.max(0, Number(logicalSize) - 4),
      };
      break;
    }

    const nextOffset = Number(BigInt(dataOffset) + logicalSize);
    if (!Number.isSafeInteger(nextOffset)) {
      break;
    }
    offset = nextOffset;
  }

  return { data, description };
}

function decodeCafFlags(flags: number): CafFlags {
  const float = Boolean(flags & 1);
  const bigEndian = Boolean(flags & 2);
  const signed = Boolean(flags & 4);
  const sampleFormat = float ? 'float' : signed ? 'signed int' : 'integer';

  return {
    bigEndian,
    float,
    label: `${sampleFormat} ${bigEndian ? 'BE' : 'LE'}`,
    signed,
  };
}

function hasUnsupportedLpcmLayout(flags: number): boolean {
  const alignedHigh = Boolean(flags & 16);
  const nonInterleaved = Boolean(flags & 32);
  return alignedHigh || nonInterleaved;
}

function invalidCaf(message: string): AudioTranscoderError {
  return new AudioTranscoderError('INVALID_AUDIO_DATA', message);
}
