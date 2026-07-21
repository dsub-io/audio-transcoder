import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST,
  AUDIO_TRANSCODER_CODEC_ASSET_PACKAGE,
} from '../dist/index.js';
import {
  CODEC_ASSET_LEGAL_FILES,
  CODEC_ASSET_PACKAGE_DESCRIPTION,
  CODEC_ASSET_PACKAGE_FILES,
} from './codec-asset-package-contract.mjs';
import { verifyPublishedCodecAssets } from './verify-published-codec-assets.mjs';

const baseUrl = `https://cdn.jsdelivr.net/npm/${AUDIO_TRANSCODER_CODEC_ASSET_PACKAGE}@${AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST.version}`;
const remotePackage = Object.freeze({
  author: 'dsub.io',
  description: CODEC_ASSET_PACKAGE_DESCRIPTION,
  files: CODEC_ASSET_PACKAGE_FILES,
  license: 'SEE LICENSE IN LICENSE.md',
  name: AUDIO_TRANSCODER_CODEC_ASSET_PACKAGE,
  publishConfig: Object.freeze({ access: 'public' }),
  repository: Object.freeze({
    type: 'git',
    url: 'git+https://github.com/dsub-io/audio-transcoder.git',
  }),
  sideEffects: false,
  version: AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST.version,
});
const runtimeAssetUrls = Object.values(
  AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST.assets,
).map(({ path }) => `${baseUrl}/${path}`);
const legalFileUrls = CODEC_ASSET_LEGAL_FILES.map(
  ({ packagePath }) => `${baseUrl}/${packagePath}`,
);

test('verifies the package, manifest, raw WASM, and legal file presence', async () => {
  const requests = [];
  const verified = [];

  await verifyPublishedCodecAssets({
    fetchAsset: createFixtureFetch({
      onRequest(url) {
        requests.push(url);
      },
    }),
    log(message) {
      verified.push(message);
    },
  });

  assert.deepEqual(requests, [
    `${baseUrl}/package.json`,
    `${baseUrl}/manifest.json`,
    ...runtimeAssetUrls,
    ...legalFileUrls,
  ]);
  assert.equal(
    verified.length,
    runtimeAssetUrls.length + legalFileUrls.length,
  );
});

test('fails closed when the exact codec asset release is unavailable', async () => {
  await assert.rejects(
    verifyPublishedCodecAssets({
      fetchAsset: async () => new Response(null, { status: 404 }),
      log() {},
    }),
    /HTTP 404/u,
  );
});

test('fails closed when the published manifest differs from the engine', async () => {
  await assert.rejects(
    verifyPublishedCodecAssets({
      fetchAsset: createFixtureFetch({
        manifest: {
          ...AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST,
          abiVersion: AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST.abiVersion + 1,
        },
      }),
      log() {},
    }),
    /manifest does not match/u,
  );
});

for (const [field, value, message] of [
  ['name', 'wrong-package', /package name does not match/u],
  ['version', '9.9.9', /package version does not match/u],
  ['description', 'wrong description', /package description does not match/u],
  ['author', 'wrong author', /package author does not match/u],
  ['license', 'MIT', /package license field does not match/u],
  ['sideEffects', true, /package sideEffects field does not match/u],
]) {
  test(`fails closed when published package ${field} differs`, async () => {
    await assert.rejects(
      verifyPublishedCodecAssets({
        fetchAsset: createFixtureFetch({
          packageJson: { ...remotePackage, [field]: value },
        }),
        log() {},
      }),
      message,
    );
  });
}

test('fails closed when published package publishConfig differs', async () => {
  await assert.rejects(
    verifyPublishedCodecAssets({
      fetchAsset: createFixtureFetch({
        packageJson: {
          ...remotePackage,
          publishConfig: { access: 'restricted' },
        },
      }),
      log() {},
    }),
    /package publishConfig does not match/u,
  );
});

test('fails closed when published package repository differs', async () => {
  await assert.rejects(
    verifyPublishedCodecAssets({
      fetchAsset: createFixtureFetch({
        packageJson: {
          ...remotePackage,
          repository: { type: 'git', url: 'https://example.test/wrong.git' },
        },
      }),
      log() {},
    }),
    /repository does not match/u,
  );
});

for (const [field, value, message] of [
  ['private', true, /must not be private/u],
  ['scripts', { prepublishOnly: 'exit 1' }, /development-only scripts/u],
]) {
  test(`fails closed when published package retains ${field}`, async () => {
    await assert.rejects(
      verifyPublishedCodecAssets({
        fetchAsset: createFixtureFetch({
          packageJson: { ...remotePackage, [field]: value },
        }),
        log() {},
      }),
      message,
    );
  });
}

test('fails closed when published package file allowlist differs', async () => {
  await assert.rejects(
    verifyPublishedCodecAssets({
      fetchAsset: createFixtureFetch({
        packageJson: { ...remotePackage, files: ['wasm'] },
      }),
      log() {},
    }),
    /package file allowlist does not match/u,
  );
});

for (const descriptor of CODEC_ASSET_LEGAL_FILES) {
  const targetUrl = `${baseUrl}/${descriptor.packagePath}`;
  test(`fails closed when ${descriptor.packagePath} is missing`, async () => {
    await assert.rejects(
      verifyPublishedCodecAssets({
        fetchAsset: createFixtureFetch({
          override(url) {
            return url === targetUrl
              ? new Response(null, { status: 404 })
              : undefined;
          },
        }),
        log() {},
      }),
      /HTTP 404/u,
    );
  });

}

function createFixtureFetch({
  manifest = AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST,
  onRequest = () => undefined,
  override = () => undefined,
  packageJson = remotePackage,
} = {}) {
  return async (input) => {
    const url = String(input);
    onRequest(url);
    const overridden = override(url);
    if (overridden !== undefined) {
      return overridden;
    }
    if (url === `${baseUrl}/package.json`) {
      return jsonResponse(packageJson);
    }
    if (url === `${baseUrl}/manifest.json`) {
      return jsonResponse(manifest);
    }

    const asset = Object.values(
      AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST.assets,
    ).find(({ path }) => url === `${baseUrl}/${path}`);
    if (asset !== undefined) {
      return fileResponse(`codec-assets/${asset.path}`);
    }
    const legalFile = CODEC_ASSET_LEGAL_FILES.find(
      ({ packagePath }) => url === `${baseUrl}/${packagePath}`,
    );
    if (legalFile !== undefined) {
      return fileResponse(legalFile.sourcePath);
    }
    return new Response(null, { status: 404 });
  };
}

async function fileResponse(sourcePath) {
  const bytes = await readFile(new URL(`../${sourcePath}`, import.meta.url));
  return new Response(bytes);
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  });
}
