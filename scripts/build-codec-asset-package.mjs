import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertCodecAssetLegalFile,
  CODEC_ASSET_LEGAL_FILES,
  CODEC_ASSET_PACKAGE_DESCRIPTION,
  CODEC_ASSET_PACKAGE_FILES,
  CODEC_ASSET_PACKAGE_NAME,
  CODEC_ASSET_PACKAGE_PUBLISH_GUARD,
} from './codec-asset-package-contract.mjs';
import { prepareCodecAssets } from './prepare-codec-assets.mjs';
import { verifyReleaseState } from './verify-release-state.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const outputDirectory = resolve(
  repositoryRoot,
  '.artifacts/codec-assets-package',
);
const packageJson = JSON.parse(
  await readFile(resolve(repositoryRoot, 'package.json'), 'utf8'),
);
const arguments_ = process.argv.slice(2);
const releaseMode = arguments_.includes('--release');
const unknownArguments = arguments_.filter((argument) => argument !== '--release');
if (unknownArguments.length > 0) {
  throw new Error(`Unknown codec package build argument: ${unknownArguments[0]}`);
}
if (releaseMode) {
  await verifyReleaseState({ repositoryRoot });
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await prepareCodecAssets({
  outputDirectory,
  repositoryRoot,
  version: packageJson.version,
});

const assetPackage = {
  name: CODEC_ASSET_PACKAGE_NAME,
  version: packageJson.version,
  description: CODEC_ASSET_PACKAGE_DESCRIPTION,
  author: packageJson.author,
  license: 'SEE LICENSE IN LICENSE.md',
  repository: packageJson.repository,
  sideEffects: false,
  publishConfig: { access: 'public' },
  files: CODEC_ASSET_PACKAGE_FILES,
  ...(releaseMode
    ? {}
    : {
        private: true,
        scripts: { prepublishOnly: CODEC_ASSET_PACKAGE_PUBLISH_GUARD },
      }),
};
await writeFile(
  resolve(outputDirectory, 'package.json'),
  `${JSON.stringify(assetPackage, null, 2)}\n`,
);

for (const descriptor of CODEC_ASSET_LEGAL_FILES) {
  const source = resolve(repositoryRoot, descriptor.sourcePath);
  const destination = resolve(outputDirectory, descriptor.packagePath);
  const bytes = await readFile(source);
  assertCodecAssetLegalFile(bytes, descriptor, descriptor.sourcePath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
}

console.log(outputDirectory);
