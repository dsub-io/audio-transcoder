import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import {
  AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST,
  AUDIO_TRANSCODER_CODEC_ASSET_PACKAGE,
  createAudioTranscoderCodecAssetProvider,
  createAudioTranscoderJsDelivrAssetSource,
} from '../dist/index.js';
import {
  assertCodecAssetLegalFile,
  CODEC_ASSET_LEGAL_FILES,
  CODEC_ASSET_PACKAGE_DESCRIPTION,
  CODEC_ASSET_PACKAGE_FILES,
} from './codec-asset-package-contract.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;

export async function verifyPublishedCodecAssets({
  fetchAsset = globalThis.fetch.bind(globalThis),
  log = console.log,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive integer.');
  }

  const source = createAudioTranscoderJsDelivrAssetSource();
  const baseUrl = `https://cdn.jsdelivr.net/npm/${source.packageName}@${source.packageVersion}`;
  const fetchWithTimeout = (input, init = {}) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal =
      init.signal === undefined
        ? timeoutSignal
        : AbortSignal.any([init.signal, timeoutSignal]);
    return fetchAsset(input, { ...init, signal });
  };
  const readJson = async (url) => {
    const response = await fetchWithTimeout(url);
    if (!response.ok) {
      throw new Error(`${url}: HTTP ${response.status}`);
    }
    return response.json();
  };
  const readBytes = async (url) => {
    const response = await fetchWithTimeout(url);
    if (!response.ok) {
      throw new Error(`${url}: HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  };

  const remotePackage = await readJson(`${baseUrl}/package.json`);
  assert.equal(
    remotePackage.name,
    AUDIO_TRANSCODER_CODEC_ASSET_PACKAGE,
    'Published codec asset package name does not match the engine contract.',
  );
  assert.equal(
    remotePackage.version,
    AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST.version,
    'Published codec asset package version does not match the engine contract.',
  );
  assert.equal(
    remotePackage.description,
    CODEC_ASSET_PACKAGE_DESCRIPTION,
    'Published codec asset package description does not match the release contract.',
  );
  assert.equal(
    remotePackage.author,
    'dsub.io',
    'Published codec asset package author does not match the release contract.',
  );
  assert.equal(
    remotePackage.license,
    'SEE LICENSE IN LICENSE.md',
    'Published codec asset package license field does not match the release contract.',
  );
  assert.equal(
    remotePackage.sideEffects,
    false,
    'Published codec asset package sideEffects field does not match the release contract.',
  );
  assert.deepEqual(
    remotePackage.publishConfig,
    { access: 'public' },
    'Published codec asset package publishConfig does not match the release contract.',
  );
  assert.deepEqual(
    remotePackage.repository,
    {
      type: 'git',
      url: 'git+https://github.com/dsub-io/audio-transcoder.git',
    },
    'Published codec asset repository does not match the public source contract.',
  );
  assert.equal(
    remotePackage.private,
    undefined,
    'Published codec asset package must not be private.',
  );
  assert.equal(
    remotePackage.scripts,
    undefined,
    'Published codec asset package must not retain development-only scripts.',
  );
  assert.deepEqual(
    remotePackage.files,
    CODEC_ASSET_PACKAGE_FILES,
    'Published codec asset package file allowlist does not match the release contract.',
  );

  const remoteManifest = await readJson(`${baseUrl}/manifest.json`);
  assert.deepEqual(
    remoteManifest,
    AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST,
    'Published codec asset manifest does not match the engine contract.',
  );

  const provider = createAudioTranscoderCodecAssetProvider({
    source,
    fetch: fetchWithTimeout,
  });
  for (const assetName of Object.keys(
    AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST.assets,
  )) {
    const bytes = await provider.load(assetName);
    assert.equal(
      WebAssembly.validate(bytes),
      true,
      `Published runtime asset is not valid WebAssembly: ${assetName}`,
    );
    log(`Verified ${provider.resolveUrl(assetName)}`);
  }

  for (const descriptor of CODEC_ASSET_LEGAL_FILES) {
    const url = `${baseUrl}/${descriptor.packagePath}`;
    const remoteBytes = await readBytes(url);
    assertCodecAssetLegalFile(remoteBytes, descriptor, url);
    log(`Verified ${url}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await verifyPublishedCodecAssets();
}
