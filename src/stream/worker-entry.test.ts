import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AudioStreamInspection,
  AudioStreamOutputSupportResult,
  AudioTranscoderStreamEngine,
} from './contracts.js';
import type {
  AudioStreamWorkerRequest,
  AudioStreamWorkerResponse,
} from './protocol.js';
import { AUDIO_TRANSCODER_STREAM_CAPABILITIES } from './capabilities.js';

const mocks = vi.hoisted(() => ({
  createEngine: vi.fn(),
}));

vi.mock('./engine.js', () => ({
  createAudioTranscoderStreamEngine: mocks.createEngine,
}));

const INSPECTION: AudioStreamInspection = {
  bitDepth: 16,
  channels: 2,
  codec: 'pcm-s16',
  container: 'WAVE',
  decodeSupport: 'built-in',
  durationSeconds: 1,
  notes: [],
  sampleRate: 48_000,
  size: 10,
};
const SUPPORTED_OUTPUT: AudioStreamOutputSupportResult = {
  code: 'SUPPORTED',
  message: 'The output runtime probe succeeded.',
  reason: 'runtime-verified',
  status: 'supported',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('stream worker entry', () => {
  it('installs the serial stream Worker host', async () => {
    const engine: AudioTranscoderStreamEngine = {
      getCapabilities: () => AUDIO_TRANSCODER_STREAM_CAPABILITIES,
      getInfo: () => ({ name: 'test', version: '0.0.0' }),
      getVersion: () => '0.0.0',
      inspect: async () => INSPECTION,
      probeInputSupport: async () => ({
        inspection: INSPECTION,
        status: 'supported',
      }),
      probeOutputSupport: async () => SUPPORTED_OUTPUT,
      transcode: vi.fn(),
    };
    mocks.createEngine.mockReturnValue(engine);
    const addEventListener = vi.fn();
    const postMessage = vi.fn();
    vi.stubGlobal('addEventListener', addEventListener);
    vi.stubGlobal('postMessage', postMessage);

    await import('./worker-entry.js');
    const handleMessage = addEventListener.mock.calls[0]?.[1] as (
      event: MessageEvent<AudioStreamWorkerRequest>,
    ) => void;
    handleMessage({
      data: {
        id: 1,
        input: { blob: new Blob(['audio']) },
        options: {},
        type: 'inspect',
      },
    } as MessageEvent<AudioStreamWorkerRequest>);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.createEngine).toHaveBeenCalledOnce();
    expect(addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
    expect(postMessage).toHaveBeenCalledWith({
      id: 1,
      operation: 'inspect',
      type: 'result',
      value: INSPECTION,
    } satisfies AudioStreamWorkerResponse);
  });
});
