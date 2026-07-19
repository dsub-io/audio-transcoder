import { describe, expect, it } from 'vitest';
import { writeAscii } from './binary.js';
import { mp3Inspector } from './mp3.js';

describe('MP3 header inspection', () => {
  it('reads a naked MPEG-1 Layer III frame', () => {
    const data = createMp3Frame({
      bitrateIndex: 9,
      channelMode: 0,
      layerBits: 1,
      sampleRateIndex: 0,
      versionBits: 3,
    });
    const inspection = mp3Inspector.inspect({ data, size: 16_000 });

    expect(inspection).toEqual({
      bitDepth: null,
      channels: 2,
      codec: 'MPEG-1 Layer III',
      container: 'MP3',
      decodeSupport: 'likely-browser',
      durationSeconds: 1,
      notes: ['Estimated bitrate 128 kbps.'],
      sampleRate: 44_100,
    });
  });

  it('skips a synchsafe ID3 tag and detects mono MPEG-2 audio', () => {
    const frame = new Uint8Array(
      createMp3Frame({
        bitrateIndex: 8,
        channelMode: 3,
        layerBits: 1,
        sampleRateIndex: 1,
        versionBits: 2,
      }),
    );
    const data = createId3File(frame, 1);
    const inspection = mp3Inspector.inspect({ data });

    expect(inspection).toMatchObject({
      channels: 1,
      codec: 'MPEG-2 Layer III',
      notes: ['Estimated bitrate 64 kbps.'],
      sampleRate: 24_000,
    });
  });

  it.each([
    [0, 1, 3, 2, 'MPEG-1 Layer III', 32_000],
    [1, 1, 0, 0, 'MPEG-2.5 Layer III', 11_025],
    [1, 2, 3, 0, 'MPEG-1 Layer bits 2', 44_100],
    [0, 1, 3, 0, 'MPEG-1 Layer III', 44_100],
  ] as const)(
    'handles bitrate=%i layer=%i version=%i sample-index=%i',
    (bitrateIndex, layerBits, versionBits, sampleRateIndex, codec, sampleRate) => {
      const data = createMp3Frame({
        bitrateIndex,
        channelMode: 0,
        layerBits,
        sampleRateIndex,
        versionBits,
      });
      const inspection = mp3Inspector.inspect({ data, size: 0 });

      expect(inspection).toMatchObject({ codec, sampleRate });
      if (bitrateIndex === 0 || layerBits !== 1) {
        expect(inspection?.durationSeconds).toBeNull();
        expect(inspection?.notes).toEqual(['Could not estimate the MP3 bitrate.']);
      } else {
        expect(inspection?.durationSeconds).toBe(0);
      }
    },
  );

  it('reports an ID3-tagged input without a visible frame', () => {
    const data = createId3File(new Uint8Array(), 0);

    expect(mp3Inspector.inspect({ data })).toEqual({
      bitDepth: null,
      channels: null,
      codec: 'MP3',
      container: 'MP3',
      decodeSupport: 'likely-browser',
      durationSeconds: null,
      notes: ['No MP3 frame was found in the inspected data.'],
      sampleRate: null,
    });
  });

  it('returns null for unrelated or invalid frame data', () => {
    expect(mp3Inspector.inspect({ data: new Uint8Array([1, 2, 3]).buffer })).toBeNull();
    for (const options of [
      {
        bitrateIndex: 1,
        channelMode: 0,
        layerBits: 1,
        sampleRateIndex: 0,
        versionBits: 1,
      },
      {
        bitrateIndex: 1,
        channelMode: 0,
        layerBits: 0,
        sampleRateIndex: 0,
        versionBits: 3,
      },
      {
        bitrateIndex: 15,
        channelMode: 0,
        layerBits: 1,
        sampleRateIndex: 0,
        versionBits: 3,
      },
      {
        bitrateIndex: 1,
        channelMode: 0,
        layerBits: 1,
        sampleRateIndex: 3,
        versionBits: 3,
      },
    ]) {
      expect(mp3Inspector.inspect({ data: createMp3Frame(options) })).toBeNull();
    }
  });
});

interface Mp3HeaderOptions {
  readonly bitrateIndex: number;
  readonly channelMode: number;
  readonly layerBits: number;
  readonly sampleRateIndex: number;
  readonly versionBits: number;
}

function createMp3Frame(options: Mp3HeaderOptions): ArrayBuffer {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  const header =
    0xffe00000 |
    (options.versionBits << 19) |
    (options.layerBits << 17) |
    (1 << 16) |
    (options.bitrateIndex << 12) |
    (options.sampleRateIndex << 10) |
    (options.channelMode << 6);
  view.setUint32(0, header >>> 0, false);
  return buffer;
}

function createId3File(frame: Uint8Array, tagSize: number): ArrayBuffer {
  const buffer = new ArrayBuffer(10 + tagSize + frame.byteLength);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'ID3');
  view.setUint8(3, 4);
  view.setUint8(9, tagSize & 0x7f);
  new Uint8Array(buffer, 10 + tagSize).set(frame);
  return buffer;
}
