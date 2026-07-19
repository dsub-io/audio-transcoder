import { describe, expect, it } from 'vitest';
import { createAudioTranscoderEngine } from '../index.js';
import { writeAscii } from './binary.js';
import { cafDecoder, cafInspector } from './caf.js';

const engine = createAudioTranscoderEngine();

describe('CAF LPCM codec', () => {
  it('inspects and decodes signed big-endian integer PCM', async () => {
    const data = createCaf({
      bitDepth: 16,
      channels: 2,
      flags: 6,
      payload: int16Payload([16_384, -16_384, 32_767, -32_768], false),
    });
    const inspection = engine.inspect({ data });
    const decoded = await engine.decode({ data });

    expect(inspection).toMatchObject({
      bitDepth: 16,
      channels: 2,
      codec: 'lpcm signed int BE',
      container: 'CAF',
      decodeSupport: 'built-in',
      sampleRate: 48_000,
    });
    expect(inspection.durationSeconds).toBeCloseTo(2 / 48_000, 10);
    expect(decoded.source).toBe('CAF LPCM decoder');
    expect([...decoded.channelData[0]!]).toEqual([0.5, 32_767 / 32_768]);
    expect([...decoded.channelData[1]!]).toEqual([-0.5, -1]);
  });

  it('decodes little-endian floating-point PCM', async () => {
    const payload = new ArrayBuffer(8);
    const payloadView = new DataView(payload);
    payloadView.setFloat32(0, 0.25, true);
    payloadView.setFloat32(4, -0.75, true);
    const data = createCaf({
      bitDepth: 32,
      channels: 1,
      flags: 1,
      payload: new Uint8Array(payload),
    });

    expect(engine.inspect({ data }).codec).toBe('lpcm float LE');
    expect([...(await engine.decode({ data })).channelData[0]!]).toEqual([
      0.25,
      -0.75,
    ]);
  });

  it('decodes unsigned 8-bit integer PCM', async () => {
    const data = createCaf({
      bitDepth: 8,
      channels: 1,
      flags: 0,
      payload: new Uint8Array([0, 128, 255]),
    });

    expect(engine.inspect({ data }).codec).toBe('lpcm integer LE');
    expect([...(await engine.decode({ data })).channelData[0]!]).toEqual([
      -1,
      0,
      127 / 128,
    ]);
  });

  it('supports an indefinite final data chunk using the logical file size', () => {
    const data = createCaf({
      bitDepth: 16,
      channels: 1,
      dataChunkSize: -1n,
      flags: 4,
      payload: int16Payload([0, 1], true),
    });
    const inspection = cafInspector.inspect({ data, size: data.byteLength });

    expect(inspection?.durationSeconds).toBeCloseTo(2 / 48_000, 10);
  });

  it('reports compressed and missing descriptions without claiming built-in decode', async () => {
    const compressed = createCaf({
      bitDepth: 0,
      bytesPerPacket: 0,
      channels: 2,
      flags: 0,
      formatId: 'aac ',
      framesPerPacket: 1024,
      payload: new Uint8Array([1, 2]),
    });
    const missing = createCaf({ includeDescription: false });

    expect(cafInspector.inspect({ data: compressed })).toMatchObject({
      codec: 'aac  integer LE',
      decodeSupport: 'browser-dependent',
      durationSeconds: null,
      notes: ['Compressed CAF requires a browser decoder or codec plugin.'],
    });
    expect(cafInspector.inspect({ data: missing })).toMatchObject({
      codec: 'Unknown',
      notes: ['CAF desc chunk was not found.'],
    });
    await expect(cafDecoder.decode({ data: compressed })).rejects.toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_INPUT' }),
    );
  });

  it.each([16, 32])(
    'routes unsupported LPCM layout flag %i to plugins',
    async (layoutFlag) => {
      const data = createCaf({
        flags: 4 | layoutFlag,
        payload: int16Payload([0], false),
      });

      expect(cafInspector.inspect({ data })).toMatchObject({
        decodeSupport: 'browser-dependent',
        notes: ['CAF LPCM layout requires a codec plugin.'],
      });
      await expect(cafDecoder.decode({ data })).rejects.toThrowError(
        expect.objectContaining({ code: 'UNSUPPORTED_INPUT' }),
      );
    },
  );

  it('returns null for unrelated input', async () => {
    const input = { data: new Uint8Array([1, 2, 3]).buffer };

    expect(cafInspector.inspect(input)).toBeNull();
    await expect(cafDecoder.decode(input)).resolves.toBeNull();
  });

  it('rejects CAF files missing required chunks', async () => {
    await expect(
      cafDecoder.decode({ data: createCaf({ includeDescription: false }) }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'INVALID_AUDIO_DATA' }));
    await expect(
      cafDecoder.decode({ data: createCaf({ includeData: false }) }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'INVALID_AUDIO_DATA' }));
  });

  it.each([
    ['channels', DESC_CHANNELS, 'uint32'],
    ['sample rate', DESC_SAMPLE_RATE, 'float64'],
    ['frames per packet', DESC_FRAMES_PER_PACKET, 'uint32'],
    ['bytes per packet', DESC_BYTES_PER_PACKET, 'uint32'],
    ['bit depth', DESC_BIT_DEPTH, 'uint32'],
  ] as const)('rejects invalid %s', async (_field, offset, kind) => {
    const data = createCaf({ payload: int16Payload([0], true) });
    const view = new DataView(data);
    if (kind === 'float64') {
      view.setFloat64(offset, 0, false);
    } else {
      view.setUint32(offset, 0, false);
    }

    await expect(cafDecoder.decode({ data })).rejects.toThrowError(
      expect.objectContaining({ code: 'INVALID_AUDIO_DATA' }),
    );
  });

  it('rejects a non-byte-aligned bit depth', async () => {
    const data = createCaf({
      bitDepth: 12,
      bytesPerPacket: 2,
      payload: new Uint8Array([0, 0]),
    });

    await expect(cafDecoder.decode({ data })).rejects.toThrowError(
      expect.objectContaining({ code: 'INVALID_AUDIO_DATA' }),
    );
  });

  it('rejects a non-finite sample rate', async () => {
    const data = createCaf({
      payload: int16Payload([0], true),
      sampleRate: Number.POSITIVE_INFINITY,
    });

    await expect(cafDecoder.decode({ data })).rejects.toThrowError(
      expect.objectContaining({ code: 'INVALID_AUDIO_DATA' }),
    );
  });

  it('rejects fractional and undersized packet layouts', async () => {
    const fractional = createCaf({
      bytesPerPacket: 3,
      framesPerPacket: 2,
      payload: new Uint8Array([0, 0, 0]),
    });
    const undersized = createCaf({
      bytesPerPacket: 1,
      channels: 2,
      payload: new Uint8Array([0]),
    });

    await expect(cafDecoder.decode({ data: fractional })).rejects.toThrowError(
      expect.objectContaining({ code: 'INVALID_AUDIO_DATA' }),
    );
    await expect(cafDecoder.decode({ data: undersized })).rejects.toThrowError(
      expect.objectContaining({ code: 'INVALID_AUDIO_DATA' }),
    );
  });

  it('rejects a data chunk without a complete frame', async () => {
    const data = createCaf({ payload: new Uint8Array() });

    await expect(cafDecoder.decode({ data })).rejects.toThrowError(
      expect.objectContaining({ code: 'INVALID_AUDIO_DATA' }),
    );
  });

  it('stops safely at an unrepresentable chunk size', () => {
    const data = new ArrayBuffer(20);
    const view = new DataView(data);
    writeAscii(view, 0, 'caff');
    writeAscii(view, 8, 'huge');
    view.setBigInt64(12, 0x7fffffffffffffffn, false);

    expect(cafInspector.inspect({ data })).toMatchObject({
      codec: 'Unknown',
    });
  });
});

const DESC_SAMPLE_RATE = 20;
const DESC_BYTES_PER_PACKET = 36;
const DESC_FRAMES_PER_PACKET = 40;
const DESC_CHANNELS = 44;
const DESC_BIT_DEPTH = 48;

interface CafFixtureOptions {
  readonly bitDepth?: number;
  readonly bytesPerPacket?: number;
  readonly channels?: number;
  readonly dataChunkSize?: bigint;
  readonly flags?: number;
  readonly formatId?: string;
  readonly framesPerPacket?: number;
  readonly includeData?: boolean;
  readonly includeDescription?: boolean;
  readonly payload?: Uint8Array;
  readonly sampleRate?: number;
}

function createCaf(options: CafFixtureOptions = {}): ArrayBuffer {
  const includeDescription = options.includeDescription ?? true;
  const includeData = options.includeData ?? true;
  const payload = options.payload ?? new Uint8Array([0, 0]);
  const channels = options.channels ?? 1;
  const bitDepth = options.bitDepth ?? 16;
  const framesPerPacket = options.framesPerPacket ?? 1;
  const bytesPerPacket =
    options.bytesPerPacket ?? channels * Math.ceil(bitDepth / 8) * framesPerPacket;
  const descriptionBytes = includeDescription ? 44 : 0;
  const dataBytes = includeData ? 16 + payload.byteLength : 0;
  const buffer = new ArrayBuffer(8 + descriptionBytes + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'caff');
  view.setUint16(4, 1, false);
  view.setUint16(6, 0, false);

  let chunkOffset = 8;
  if (includeDescription) {
    writeAscii(view, chunkOffset, 'desc');
    view.setBigInt64(chunkOffset + 4, 32n, false);
    const dataOffset = chunkOffset + 12;
    view.setFloat64(dataOffset, options.sampleRate ?? 48_000, false);
    writeAscii(view, dataOffset + 8, options.formatId ?? 'lpcm');
    view.setUint32(dataOffset + 12, options.flags ?? 4, false);
    view.setUint32(dataOffset + 16, bytesPerPacket, false);
    view.setUint32(dataOffset + 20, framesPerPacket, false);
    view.setUint32(dataOffset + 24, channels, false);
    view.setUint32(dataOffset + 28, bitDepth, false);
    chunkOffset += 44;
  }

  if (includeData) {
    writeAscii(view, chunkOffset, 'data');
    view.setBigInt64(
      chunkOffset + 4,
      options.dataChunkSize ?? BigInt(4 + payload.byteLength),
      false,
    );
    view.setUint32(chunkOffset + 12, 0, false);
    new Uint8Array(buffer, chunkOffset + 16).set(payload);
  }

  return buffer;
}

function int16Payload(values: readonly number[], littleEndian: boolean): Uint8Array {
  const buffer = new ArrayBuffer(values.length * 2);
  const view = new DataView(buffer);
  values.forEach((value, index) => {
    view.setInt16(index * 2, value, littleEndian);
  });
  return new Uint8Array(buffer);
}
