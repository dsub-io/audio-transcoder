import { createHash } from 'node:crypto';

export const CODEC_ASSET_PACKAGE_NAME = '@dsub/audio-transcoder-codecs';
export const CODEC_ASSET_PACKAGE_DESCRIPTION =
  'Version-locked raw WebAssembly codec assets for @dsub/audio-transcoder.';
export const CODEC_ASSET_PACKAGE_PUBLISH_BLOCK_MESSAGE =
  'Development codec candidates are private; build the release from a clean Release Please tag with --release.';
export const CODEC_ASSET_PACKAGE_PUBLISH_GUARD =
  `node -e "throw new Error('${CODEC_ASSET_PACKAGE_PUBLISH_BLOCK_MESSAGE}')"`;

export const CODEC_ASSET_LEGAL_FILES = Object.freeze(
  [
    {
      bytes: 1_125,
      packagePath: 'LICENSE.md',
      sha256: 'd543883ef32d09a235d66e070642529f9bcc64f4993164e294435cd034a6ebde',
      sourcePath: 'codec-assets/LICENSE.md',
    },
    {
      bytes: 4_626,
      packagePath: 'LICENSE.DSUB.md',
      sha256: 'ee93868271dc47567a01dfa524769816d4bc1950e936880aae373630362b2a8d',
      sourcePath: 'LICENSE.md',
    },
    {
      bytes: 6_199,
      packagePath: 'README.md',
      sha256: '978485e7af17027530dc3e3b7c18975068080a9be236d124c186e86e153bcfc3',
      sourcePath: 'codec-assets/README.md',
    },
    {
      bytes: 12_656,
      packagePath: 'THIRD_PARTY_NOTICES.md',
      sha256: '6ae224bdfda181239fb8d39f6cec0a66702b3f8893c70d945e06a952184a8eb0',
      sourcePath: 'THIRD_PARTY_NOTICES.md',
    },
    {
      bytes: 5_093,
      packagePath:
        'THIRD_PARTY_LICENSES/EMSCRIPTEN-MIT-AND-UIUC-NCSA.txt',
      sha256: '620a78084fc7ca97c0b5dea9abf891f3ffcadfdbf305276f099c9c4e12fc1d86',
      sourcePath:
        'THIRD_PARTY_LICENSES/EMSCRIPTEN-MIT-AND-UIUC-NCSA.txt',
    },
    {
      bytes: 25_284,
      packagePath:
        'THIRD_PARTY_LICENSES/LAME-3.100-LGPL-2.0-or-later.txt',
      sha256: 'bfe4a52dc4645385f356a8e83cc54216a293e3b6f1cb4f79f5fc0277abf937fd',
      sourcePath:
        'THIRD_PARTY_LICENSES/LAME-3.100-LGPL-2.0-or-later.txt',
    },
    {
      bytes: 1_509,
      packagePath: 'THIRD_PARTY_LICENSES/LIBFLAC-XIPH-BSD.txt',
      sha256: '7866ee98760fc1f0156b4fe6bf530257e02be487ab3fd94e2b63799dd32d6b2c',
      sourcePath: 'THIRD_PARTY_LICENSES/LIBFLAC-XIPH-BSD.txt',
    },
    {
      bytes: 4_986,
      packagePath:
        'THIRD_PARTY_LICENSES/LIBOPUSENC-LIBOPUS-LIBOGG-XIPH-BSD.txt',
      sha256: '32b6760cab1917431fa2f36af6c655165bf71047e20b93a13c32a893687df826',
      sourcePath:
        'THIRD_PARTY_LICENSES/LIBOPUSENC-LIBOPUS-LIBOGG-XIPH-BSD.txt',
    },
    {
      bytes: 1_381,
      packagePath:
        'THIRD_PARTY_LICENSES/LIBSAMPLERATE-BSD-2-CLAUSE.txt',
      sha256: '61fc66af7da8e2f97f82b91e42c46fa136f92118dee8ac6674bc33892d74ae66',
      sourcePath:
        'THIRD_PARTY_LICENSES/LIBSAMPLERATE-BSD-2-CLAUSE.txt',
    },
    {
      bytes: 16_726,
      packagePath: 'THIRD_PARTY_LICENSES/MEDIABUNNY-MPL-2.0.txt',
      sha256: '3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04',
      sourcePath: 'THIRD_PARTY_LICENSES/MEDIABUNNY-MPL-2.0.txt',
    },
    {
      bytes: 16_726,
      packagePath: 'codec-build/aac/LICENSE.BRIDGE-MPL-2.0.txt',
      sha256: '3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04',
      sourcePath: 'codec-build/aac/LICENSE.BRIDGE-MPL-2.0.txt',
    },
    {
      bytes: 26_517,
      packagePath: 'codec-build/aac/LICENSE.FFMPEG-LGPL-2.1.txt',
      sha256: '246041b6ecf9bc32d718a62c57877c78b5eb397b6467e74ed7ae2626ab189c30',
      sourcePath: 'codec-build/aac/LICENSE.FFMPEG-LGPL-2.1.txt',
    },
  ].map(Object.freeze),
);

export const CODEC_ASSET_PACKAGE_FILES = Object.freeze([
  'LICENSE.md',
  'LICENSE.DSUB.md',
  'README.md',
  'THIRD_PARTY_LICENSES',
  'THIRD_PARTY_NOTICES.md',
  'codec-build/aac/LICENSE.BRIDGE-MPL-2.0.txt',
  'codec-build/aac/LICENSE.FFMPEG-LGPL-2.1.txt',
  'manifest.json',
  'wasm',
]);

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function assertCodecAssetLegalFile(bytes, descriptor, source) {
  if (
    bytes.byteLength !== descriptor.bytes ||
    sha256(bytes) !== descriptor.sha256
  ) {
    throw new Error(
      `${source} differs from the audited codec asset legal payload: ${descriptor.packagePath}`,
    );
  }
}
