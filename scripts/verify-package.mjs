import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const packageJsonUrl = new URL('../package.json', import.meta.url);
const packageJson = JSON.parse(await readFile(packageJsonUrl, 'utf8'));
const licenseText = await readFile(
  new URL('../LICENSE.md', import.meta.url),
  'utf8',
);
const thirdPartyText = await readFile(
  new URL('../THIRD_PARTY_NOTICES.md', import.meta.url),
  'utf8',
);
const thirdPartyLicenses = {
  'LAME-3.100-LGPL-2.0-or-later.txt':
    'bfe4a52dc4645385f356a8e83cc54216a293e3b6f1cb4f79f5fc0277abf937fd',
  'LIBFLAC-XIPH-BSD.txt':
    '7866ee98760fc1f0156b4fe6bf530257e02be487ab3fd94e2b63799dd32d6b2c',
  'LIBSAMPLERATE-JS-MIT-AND-LIBSAMPLERATE-BSD-2-CLAUSE.txt':
    '69f1609423518937e0c70baade7a15e4eaaaee7109a8b0e793733b0f89ec6f72',
  'MEDIABUNNY-MPL-2.0.txt':
    '3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04',
};
const publicApi = await import('../dist/index.js');

if (
  packageJson.author !== 'dsub.io' ||
  packageJson.license !== 'SEE LICENSE IN LICENSE.md' ||
  !licenseText.startsWith(
    'Required Notice: Copyright 2026 dsub.io. All rights reserved.',
  ) ||
  !licenseText.includes('# PolyForm Noncommercial License 1.0.0')
) {
  throw new Error('Package ownership and license metadata must agree');
}

const requiredNoticeText = [
  'summary is not legal advice',
  'MPL-2.0',
  '794b84884f1e23cb6241689b3563190d138bbd9a',
  'LAME 3.100',
  'LGPL-2.0-or-later',
  'ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e',
  'lame-3.100.tar.gz',
  '--disable-decoder',
  'mpglib/libmpgdecoder.la',
  '3f1ecff843dd1b8c07fbb5f59425a4ec71fe4f6c',
  'COPYING.Xiph',
  'bcb176448cf9700e9820b87afd29a78ab860cdf8',
  'aee38d0bc797d0d1a3774ef574af1d5d248d2398',
  'scripts/build_emscripten.sh',
  'WASM=0',
  'https://github.com/Vanilagy/mediabunny/tree/794b84884f1e23cb6241689b3563190d138bbd9a/packages/mp3-encoder',
  'https://github.com/Vanilagy/mediabunny/tree/794b84884f1e23cb6241689b3563190d138bbd9a/packages/flac-encoder',
  'https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz',
  'https://github.com/Vanilagy/mediabunny/blob/794b84884f1e23cb6241689b3563190d138bbd9a/packages/mp3-encoder/README.md#building-and-development',
  'https://github.com/Vanilagy/mediabunny/blob/794b84884f1e23cb6241689b3563190d138bbd9a/packages/mp3-encoder/src/lame-bridge.c',
  'https://github.com/xiph/flac/tree/3f1ecff843dd1b8c07fbb5f59425a4ec71fe4f6c',
  'https://github.com/xiph/flac/blob/3f1ecff843dd1b8c07fbb5f59425a4ec71fe4f6c/COPYING.Xiph',
  'https://github.com/Vanilagy/mediabunny/blob/794b84884f1e23cb6241689b3563190d138bbd9a/packages/flac-encoder/README.md#building-and-development',
  'https://github.com/Vanilagy/mediabunny/blob/794b84884f1e23cb6241689b3563190d138bbd9a/packages/flac-encoder/src/bridge.c',
  'https://github.com/aolsenjazz/libsamplerate-js/tree/bcb176448cf9700e9820b87afd29a78ab860cdf8',
  'https://github.com/aolsenjazz/libsamplerate-js/blob/bcb176448cf9700e9820b87afd29a78ab860cdf8/scripts/build_emscripten.sh',
  'https://github.com/libsndfile/libsamplerate/tree/aee38d0bc797d0d1a3774ef574af1d5d248d2398',
  'https://github.com/libsndfile/libsamplerate/blob/aee38d0bc797d0d1a3774ef574af1d5d248d2398/COPYING',
  ...Object.keys(thirdPartyLicenses).map(
    (fileName) => `THIRD_PARTY_LICENSES/${fileName}`,
  ),
];

if (
  packageJson.dependencies?.mediabunny !== '1.50.9' ||
  packageJson.dependencies?.['@mediabunny/mp3-encoder'] !== '1.50.9' ||
  packageJson.dependencies?.['@mediabunny/flac-encoder'] !== '1.50.9' ||
  packageJson.dependencies?.['@alexanderolsen/libsamplerate-js'] !== '2.1.2' ||
  !packageJson.files?.includes('LICENSE.md') ||
  !packageJson.files?.includes('THIRD_PARTY_NOTICES.md') ||
  !packageJson.files?.includes('THIRD_PARTY_LICENSES') ||
  requiredNoticeText.some((required) => !thirdPartyText.includes(required))
) {
  throw new Error('Package legal files and third-party notices must agree');
}

for (const [fileName, expectedSha256] of Object.entries(thirdPartyLicenses)) {
  const license = await readFile(
    new URL(`../THIRD_PARTY_LICENSES/${fileName}`, import.meta.url),
  );
  const actualSha256 = createHash('sha256').update(license).digest('hex');
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `Third-party license ${fileName} is missing or differs from its audited source`,
    );
  }
}

if (
  packageJson.exports?.['./worker']?.import !== './dist/worker/entry.js' ||
  packageJson.exports?.['./stream-worker']?.import !==
    './dist/stream/worker-entry.js' ||
  !packageJson.sideEffects?.includes('./dist/worker/entry.js') ||
  !packageJson.sideEffects?.includes('./dist/stream/worker-entry.js')
) {
  throw new Error('Worker exports and side-effect metadata must agree');
}

for (const mapPath of ['../dist/index.js.map']) {
  const sourceMap = JSON.parse(
    await readFile(new URL(mapPath, import.meta.url), 'utf8'),
  );
  if (
    !Array.isArray(sourceMap.sources) ||
    !Array.isArray(sourceMap.sourcesContent) ||
    sourceMap.sourcesContent.length !== sourceMap.sources.length ||
    sourceMap.sourcesContent.some((source) => typeof source !== 'string')
  ) {
    throw new Error(`${mapPath} must embed every referenced source`);
  }
}

const info = publicApi.getEngineInfo();

if (publicApi.getVersion() !== packageJson.version) {
  throw new Error('Built package version does not match package.json');
}

if (info.name !== packageJson.name || info.version !== packageJson.version) {
  throw new Error('Built engine information does not match package.json');
}

if (!Object.isFrozen(info)) {
  throw new Error('Built engine information must be immutable');
}

const progressEvents = [];
const encoded = await publicApi.audioTranscoder.encode(
  {
    channelData: [new Float32Array([-1, 0, 1])],
    sampleRate: 48_000,
  },
  'wav-pcm16',
  {
    onProgress(progress) {
      progressEvents.push(progress);
    },
  },
);
const inspection = publicApi.audioTranscoder.inspect({ data: encoded.data });

if (
  inspection.container !== 'WAV' ||
  inspection.sampleRate !== 48_000 ||
  inspection.bitDepth !== 16
) {
  throw new Error('Built package failed the WAV encode and inspect smoke test');
}

if (
  progressEvents.length === 0 ||
  progressEvents[0].progress !== 0 ||
  progressEvents.at(-1).progress !== 1 ||
  progressEvents.some(
    ({ progress }) =>
      progress < 0 ||
      progress > 1 ||
      Math.round(progress * 1_000) / 1_000 !== progress,
  )
) {
  throw new Error('Built package exposed invalid progress values');
}

if (typeof publicApi.createAudioTranscoderWorkerEngine !== 'function') {
  throw new Error('Built package does not export its Worker engine factory');
}

if (
  publicApi.AUDIO_TRANSCODER_WHOLE_BUFFER_LIMIT_BYTES !==
  64 * 1024 * 1024
) {
  throw new Error('Built package does not export its whole-buffer safety limit');
}

const codecRuntime =
  publicApi.AUDIO_TRANSCODER_STREAM_CAPABILITIES?.codecRuntime;
const streamCapabilities = publicApi.AUDIO_TRANSCODER_STREAM_CAPABILITIES;
const expectedStreamPresets = [
  'wav-pcm16',
  'wav-pcm24',
  'wav-pcm32',
  'wav-float32',
  'mp3-128kbps',
  'mp3-192kbps',
  'mp3-256kbps',
  'mp3-320kbps',
  'flac-16bit',
  'flac-24bit',
];
const expectedMp3SampleRates = [
  ['mp3-128kbps', [16_000, 22_050, 24_000, 32_000, 44_100, 48_000]],
  ['mp3-192kbps', [32_000, 44_100, 48_000]],
  ['mp3-256kbps', [32_000, 44_100, 48_000]],
  ['mp3-320kbps', [32_000, 44_100, 48_000]],
];
const mp3OutputFormat = streamCapabilities.outputFormats.find(
  ({ id }) => id === 'mp3',
);
const mp3SampleRateContractIsValid =
  mp3OutputFormat !== undefined &&
  JSON.stringify(
    mp3OutputFormat.presets.map(({ preset, target }) => [
      preset.id,
      target.sampleRate.kind === 'discrete'
        ? [...target.sampleRate.values]
        : null,
    ]),
  ) === JSON.stringify(expectedMp3SampleRates);

if (
  typeof publicApi.createAudioTranscoderStreamEngine !== 'function' ||
  typeof publicApi.createAudioTranscoderStreamWorkerEngine !== 'function' ||
  typeof publicApi.exposeAudioTranscoderStreamWorker !== 'function' ||
  typeof publicApi.createAudioTranscoderOutputSession !== 'function' ||
  publicApi.AUDIO_TRANSCODER_OUTPUT_MEMORY_LIMIT_BYTES !== 128 * 1024 * 1024 ||
  typeof codecRuntime !== 'object' ||
  codecRuntime === null ||
  !Array.isArray(codecRuntime.inputAdapters) ||
  streamCapabilities.outputPresets
    .map(({ id }) => id)
    .join(',') !== expectedStreamPresets.join(',') ||
  streamCapabilities.outputFormats
    .map(({ id, implementation, loading }) =>
      `${id}:${implementation}:${loading}`,
    )
    .join(',') !==
    'wav:built-in:eager,mp3:bundled-wasm:lazy,flac:bundled-wasm:lazy' ||
  !mp3SampleRateContractIsValid ||
  streamCapabilities.inputFormats.length === 0 ||
  streamCapabilities.inputFormats.some(
    ({ extensionHints, mimeTypeHints }) =>
      !Object.isFrozen(extensionHints) || !Object.isFrozen(mimeTypeHints),
  ) ||
  codecRuntime.inputAdapters.join(',') !== 'dsub-pcm,mediabunny' ||
  codecRuntime.encoderAdapter !== 'mediabunny' ||
  codecRuntime.resamplerAdapter !== 'libsamplerate-js' ||
  !Object.isFrozen(codecRuntime.inputAdapters) ||
  !Object.isFrozen(codecRuntime) ||
  streamCapabilities.limits.recommendedConcurrency !== 1 ||
  streamCapabilities.limits.maximumConcurrency !== 4 ||
  streamCapabilities.limits.queue.defaultMaximumQueued !== 8 ||
  streamCapabilities.limits.queue.maximumQueued !== 64 ||
  streamCapabilities.limits.sampleRate.resampling.maximum !== 192_000
) {
  throw new Error('Built package exposed an invalid streaming capability matrix');
}

const inlineStreamEngine = publicApi.createAudioTranscoderStreamEngine();
if (
  inlineStreamEngine.getCapabilities() !==
    streamCapabilities ||
  typeof inlineStreamEngine.probeInputSupport !== 'function'
) {
  throw new Error('Built package exposed an invalid direct stream engine');
}

const outputSession = publicApi.createAudioTranscoderOutputSession({
  memoryLimitBytes: 64,
  namespace: 'package-smoke',
});
if ((await outputSession.getStorageMode()) !== 'memory') {
  throw new Error('Node package smoke expected the bounded memory output fallback');
}
const pendingOutput = await outputSession.create();
const outputWriter = pendingOutput.stream.getWriter();
await outputWriter.write({
  data: new Uint8Array([0x64, 0x73, 0x75, 0x62]),
  position: 0,
  type: 'write',
});
await outputWriter.close();
const outputArtifact = await pendingOutput.complete({
  mimeType: 'application/octet-stream',
  name: 'smoke.bin',
});
if (
  outputArtifact.size !== 4 ||
  outputArtifact.storage !== 'memory' ||
  outputSession.getMemoryReservation().reservedBytes !== 4
) {
  throw new Error('Built package failed the bounded output-session smoke test');
}
await outputArtifact.dispose();
await outputSession.dispose();

const pool = publicApi.createAudioTranscoderWorkerPool();
const poolSnapshot = pool.getQueueSnapshot();
if (
  pool.getVersion() !== packageJson.version ||
  poolSnapshot.maxQueued !== 8 ||
  poolSnapshot.maxQueuedBytes !== 64 * 1024 * 1024 ||
  poolSnapshot.queuedBytes !== 0 ||
  poolSnapshot.workers !== 0
) {
  throw new Error('Built package failed the lazy Worker pool smoke test');
}
pool.terminate();

const streamPool = publicApi.createAudioTranscoderStreamWorkerPool();
if (
  streamPool.getVersion() !== packageJson.version ||
  streamPool.getCapabilities() !==
    publicApi.AUDIO_TRANSCODER_STREAM_CAPABILITIES ||
  streamPool.getQueueSnapshot().workers !== 0
) {
  throw new Error('Built package failed the lazy stream Worker pool smoke test');
}
await streamPool.dispose();

const uncalledWorkerFactory = () => {
  throw new Error('A lazy package smoke test must not create a Worker');
};
const defaultEntryStreamPool = publicApi.createAudioTranscoderStreamWorkerPool({
  workerFactory: uncalledWorkerFactory,
});
if (defaultEntryStreamPool.getCapabilities() !== streamCapabilities) {
  throw new Error('workerFactory alone must retain the default stream runtime');
}
await defaultEntryStreamPool.dispose();

const customRuntimeStreamPool =
  publicApi.createAudioTranscoderStreamWorkerPool({
    capabilities: streamCapabilities,
    runtime: 'custom',
    workerFactory: uncalledWorkerFactory,
  });
if (customRuntimeStreamPool.getCapabilities() !== streamCapabilities) {
  throw new Error('Custom stream runtime must expose its paired capabilities');
}
await customRuntimeStreamPool.dispose();

let rejectedUnpairedCapabilities = false;
try {
  publicApi.createAudioTranscoderStreamWorkerPool({
    capabilities: streamCapabilities,
  });
} catch (error) {
  rejectedUnpairedCapabilities = error?.code === 'INVALID_CONFIGURATION';
}
if (!rejectedUnpairedCapabilities) {
  throw new Error('Unpaired custom stream capabilities must be rejected');
}
