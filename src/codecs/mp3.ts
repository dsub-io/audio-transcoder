import type {
  AudioInput,
  AudioInspection,
} from '../engine/contracts.js';
import { readAscii } from './binary.js';
import type { AudioInspectorAdapter } from './contracts.js';

const MPEG_1_LAYER_3_BITRATES = Object.freeze([
  null,
  32,
  40,
  48,
  56,
  64,
  80,
  96,
  112,
  128,
  160,
  192,
  224,
  256,
  320,
]);
const MPEG_2_LAYER_3_BITRATES = Object.freeze([
  null,
  8,
  16,
  24,
  32,
  40,
  48,
  56,
  64,
  80,
  96,
  112,
  128,
  144,
  160,
]);

export const mp3Inspector: AudioInspectorAdapter = Object.freeze({
  formats: Object.freeze(['mp3']),
  id: 'builtin.mp3.inspector',
  inspect(input: AudioInput): AudioInspection | null {
    const view = new DataView(input.data);
    const hasId3 = readAscii(view, 0, 3) === 'ID3';
    const frameOffset = findMp3Frame(view);
    if (!hasId3 && frameOffset < 0) {
      return null;
    }

    if (frameOffset < 0) {
      return {
        bitDepth: null,
        channels: null,
        codec: 'MP3',
        container: 'MP3',
        decodeSupport: 'likely-browser',
        durationSeconds: null,
        notes: ['No MP3 frame was found in the inspected data.'],
        sampleRate: null,
      };
    }

    const header = view.getUint32(frameOffset, false);
    const versionBits = (header >> 19) & 0x3;
    const layerBits = (header >> 17) & 0x3;
    const bitrateIndex = (header >> 12) & 0xf;
    const sampleRateIndex = (header >> 10) & 0x3;
    const channelMode = (header >> 6) & 0x3;
    const version =
      versionBits === 3
        ? 'MPEG-1'
        : versionBits === 2
          ? 'MPEG-2'
          : 'MPEG-2.5';
    const layer = layerBits === 1 ? 'Layer III' : `Layer bits ${layerBits}`;
    const sampleRate = mp3SampleRate(versionBits, sampleRateIndex);
    const bitrate = mp3Bitrate(versionBits, layerBits, bitrateIndex);
    const audioBytes = Math.max(
      0,
      (input.size ?? input.data.byteLength) - frameOffset,
    );

    return {
      bitDepth: null,
      channels: channelMode === 3 ? 1 : 2,
      codec: `${version} ${layer}`,
      container: 'MP3',
      decodeSupport: 'likely-browser',
      durationSeconds:
        bitrate === null ? null : (audioBytes * 8) / (bitrate * 1000),
      notes:
        bitrate === null
          ? ['Could not estimate the MP3 bitrate.']
          : [`Estimated bitrate ${bitrate} kbps.`],
      sampleRate,
    };
  },
});

function looksLikeMp3Frame(view: DataView, offset: number): boolean {
  const header = view.getUint32(offset, false);
  const versionBits = (header >> 19) & 0x3;
  const layerBits = (header >> 17) & 0x3;
  const bitrateIndex = (header >> 12) & 0xf;
  const sampleRateIndex = (header >> 10) & 0x3;
  return (
    header >>> 21 === 0x7ff &&
    versionBits !== 1 &&
    layerBits !== 0 &&
    bitrateIndex !== 15 &&
    sampleRateIndex !== 3
  );
}

function findMp3Frame(view: DataView): number {
  let offset = 0;
  if (readAscii(view, 0, 3) === 'ID3' && view.byteLength >= 10) {
    offset = 10 + readSynchsafeInteger(view, 6);
  }

  for (let index = offset; index + 4 <= view.byteLength; index += 1) {
    if (looksLikeMp3Frame(view, index)) {
      return index;
    }
  }
  return -1;
}

function readSynchsafeInteger(view: DataView, offset: number): number {
  return (
    (view.getUint8(offset) << 21) |
    (view.getUint8(offset + 1) << 14) |
    (view.getUint8(offset + 2) << 7) |
    view.getUint8(offset + 3)
  );
}

function mp3SampleRate(versionBits: number, index: number): number {
  const base = [44_100, 48_000, 32_000][index]!;
  if (versionBits === 3) {
    return base;
  }
  if (versionBits === 2) {
    return base / 2;
  }
  return base / 4;
}

function mp3Bitrate(
  versionBits: number,
  layerBits: number,
  index: number,
): number | null {
  if (index === 0 || layerBits !== 1) {
    return null;
  }
  const table =
    versionBits === 3
      ? MPEG_1_LAYER_3_BITRATES
      : MPEG_2_LAYER_3_BITRATES;
  return table[index]!;
}
