import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

test('runs the published-asset verifier from the extracted engine tarball', async () => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), 'audio-transcoder-packed-verifier-'),
  );

  try {
    await symlink(
      join(repositoryRoot, 'node_modules'),
      join(temporaryDirectory, 'node_modules'),
      'dir',
    );
    const { stdout } = await execFileAsync(
      'npm',
      [
        'pack',
        '--json',
        '--ignore-scripts',
        '--pack-destination',
        temporaryDirectory,
      ],
      { cwd: repositoryRoot },
    );
    const [{ filename }] = JSON.parse(stdout);
    await execFileAsync(
      'tar',
      [
        '-xzf',
        join(temporaryDirectory, filename),
        '-C',
        temporaryDirectory,
      ],
      { cwd: repositoryRoot },
    );

    const extractedRoot = join(temporaryDirectory, 'package');
    const [{ verifyPublishedCodecAssets }, publicApi, releaseContract] =
      await Promise.all([
        import(
          pathToFileURL(
            join(
              extractedRoot,
              'scripts/verify-published-codec-assets.mjs',
            ),
          ).href
        ),
        import(pathToFileURL(join(extractedRoot, 'dist/index.js')).href),
        import(
          pathToFileURL(
            join(extractedRoot, 'scripts/codec-asset-package-contract.mjs'),
          ).href
        ),
      ]);

    const baseUrl = `https://cdn.jsdelivr.net/npm/${publicApi.AUDIO_TRANSCODER_CODEC_ASSET_PACKAGE}@${publicApi.AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST.version}`;
    const remotePackage = {
      author: 'dsub.io',
      description: releaseContract.CODEC_ASSET_PACKAGE_DESCRIPTION,
      files: releaseContract.CODEC_ASSET_PACKAGE_FILES,
      license: 'SEE LICENSE IN LICENSE.md',
      name: publicApi.AUDIO_TRANSCODER_CODEC_ASSET_PACKAGE,
      publishConfig: { access: 'public' },
      repository: {
        type: 'git',
        url: 'git+https://github.com/dsub-io/audio-transcoder.git',
      },
      sideEffects: false,
      version: publicApi.AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST.version,
    };
    const verified = [];

    await verifyPublishedCodecAssets({
      fetchAsset: async (input) => {
        const url = String(input);
        if (url === `${baseUrl}/package.json`) {
          return jsonResponse(remotePackage);
        }
        if (url === `${baseUrl}/manifest.json`) {
          return jsonResponse(publicApi.AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST);
        }

        const asset = Object.values(
          publicApi.AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST.assets,
        ).find(({ path }) => url === `${baseUrl}/${path}`);
        if (asset !== undefined) {
          return fileResponse(`codec-assets/${asset.path}`);
        }

        const legalFile = releaseContract.CODEC_ASSET_LEGAL_FILES.find(
          ({ packagePath }) => url === `${baseUrl}/${packagePath}`,
        );
        if (legalFile !== undefined) {
          return fileResponse(legalFile.sourcePath);
        }
        return new Response(null, { status: 404 });
      },
      log(message) {
        verified.push(message);
      },
    });

    assert.equal(
      verified.length,
      Object.keys(publicApi.AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST.assets)
        .length + releaseContract.CODEC_ASSET_LEGAL_FILES.length,
    );
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

async function fileResponse(sourcePath) {
  const bytes = await readFile(join(repositoryRoot, sourcePath));
  return new Response(bytes);
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  });
}
