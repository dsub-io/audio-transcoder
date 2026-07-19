import { readFile } from 'node:fs/promises';

const packageJsonUrl = new URL('../package.json', import.meta.url);
const packageJson = JSON.parse(await readFile(packageJsonUrl, 'utf8'));
const licenseText = await readFile(
  new URL('../LICENSE.md', import.meta.url),
  'utf8',
);
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

if (
  packageJson.exports?.['./worker']?.import !== './dist/worker/entry.js' ||
  !packageJson.sideEffects?.includes('./dist/worker/entry.js')
) {
  throw new Error('Worker subpath export and side-effect metadata must agree');
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

const pool = publicApi.createAudioTranscoderWorkerPool();
if (
  pool.getVersion() !== packageJson.version ||
  pool.getQueueSnapshot().workers !== 0
) {
  throw new Error('Built package failed the lazy Worker pool smoke test');
}
pool.terminate();
