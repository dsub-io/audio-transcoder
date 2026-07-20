# Third-party notices

`@dsub/audio-transcoder` is licensed separately under the PolyForm
Noncommercial License 1.0.0 in `LICENSE.md`. Third-party components retain the
licenses below; the dsub license does not restrict rights granted directly by
those licenses.

The package tarball includes the complete referenced license texts under
`THIRD_PARTY_LICENSES/`. A production web bundle can redistribute the
JavaScript, Worker, and embedded codec payloads, so downstream distributors
should make this notice, those license texts, and the source/build references
available with the deployed application. Distributors remain responsible for
meeting the applicable source, modification, and relinking requirements. This
summary is not legal advice; the included license texts control.

## MediaBunny 1.50.9

Applies to `mediabunny`, `@mediabunny/mp3-encoder`, and
`@mediabunny/flac-encoder` version 1.50.9.

- Copyright: MediaBunny contributors
- License: MPL-2.0
- Published source revision: [794b84884f1e23cb6241689b3563190d138bbd9a](https://github.com/Vanilagy/mediabunny/tree/794b84884f1e23cb6241689b3563190d138bbd9a)
- MP3 extension source and bridge: [packages/mp3-encoder](https://github.com/Vanilagy/mediabunny/tree/794b84884f1e23cb6241689b3563190d138bbd9a/packages/mp3-encoder)
- FLAC extension source and bridge: [packages/flac-encoder](https://github.com/Vanilagy/mediabunny/tree/794b84884f1e23cb6241689b3563190d138bbd9a/packages/flac-encoder)
- Full license: `THIRD_PARTY_LICENSES/MEDIABUNNY-MPL-2.0.txt`

Keep the MPL notices with distributions. If MPL-covered files are modified and
distributed, make the corresponding covered source available as required by
the MPL.

## LAME 3.100 in the MP3 encoder

The installed `@mediabunny/mp3-encoder@1.50.9` README identifies its embedded
WASM encoder as LAME 3.100. LAME 3.100's project `COPYING` is the GNU Library
General Public License, version 2, with the "or any later version" option; its
SPDX identifier is `LGPL-2.0-or-later`.

- Project: [LAME MP3 Encoder](https://lame.sourceforge.io/)
- Official license page: [license.txt](https://lame.sourceforge.io/license.txt)
- Exact source archive: [lame-3.100.tar.gz](https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz)
- Archive SHA-256: `ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e`
- MediaBunny build recipe: [MP3 encoder README at the published revision](https://github.com/Vanilagy/mediabunny/blob/794b84884f1e23cb6241689b3563190d138bbd9a/packages/mp3-encoder/README.md#building-and-development)
- MediaBunny bridge source: [lame-bridge.c](https://github.com/Vanilagy/mediabunny/blob/794b84884f1e23cb6241689b3563190d138bbd9a/packages/mp3-encoder/src/lame-bridge.c)
- Full license: `THIRD_PARTY_LICENSES/LAME-3.100-LGPL-2.0-or-later.txt`

The published recipe configures LAME with `--disable-decoder` and links
`libmp3lame.a`. LAME's own build files define that option as excluding the
mpg123 decoder and omit `mpglib/libmpgdecoder.la` from the library link. The
embedded payload therefore contains the encoder, not the decoder/mpglib
library. This narrows the shipped component set; it does not remove the LAME
LGPL obligations.

For a final web distribution, retain the acknowledgment and license, and assess
the LGPL source/relinking requirements for the exact deployed WASM and bridge.
The source archive and published bridge/build recipe above are provided to make
that assessment and source retrieval reproducible.

## libFLAC in the FLAC encoder

The installed `@mediabunny/flac-encoder@1.50.9` bundle identifies its embedded
encoder as `FLAC git-3f1ecff8 20260304`, resolving to the exact source revision
below.

- Component license: Xiph BSD (3-Clause-style)
- Exact source revision: [3f1ecff843dd1b8c07fbb5f59425a4ec71fe4f6c](https://github.com/xiph/flac/tree/3f1ecff843dd1b8c07fbb5f59425a4ec71fe4f6c)
- License at that revision: [COPYING.Xiph](https://github.com/xiph/flac/blob/3f1ecff843dd1b8c07fbb5f59425a4ec71fe4f6c/COPYING.Xiph)
- MediaBunny build recipe: [FLAC encoder README at the published revision](https://github.com/Vanilagy/mediabunny/blob/794b84884f1e23cb6241689b3563190d138bbd9a/packages/flac-encoder/README.md#building-and-development)
- MediaBunny bridge source: [bridge.c](https://github.com/Vanilagy/mediabunny/blob/794b84884f1e23cb6241689b3563190d138bbd9a/packages/flac-encoder/src/bridge.c)
- Full license: `THIRD_PARTY_LICENSES/LIBFLAC-XIPH-BSD.txt`

Binary distributions must reproduce the copyright notice, conditions, and
disclaimer in their documentation and/or other supplied materials.

## libsamplerate-js 2.1.2 and libsamplerate

The installed `@alexanderolsen/libsamplerate-js@2.1.2` npm metadata points to
source revision `bcb176448cf9700e9820b87afd29a78ab860cdf8`. That revision pins
its libsamplerate submodule to
`aee38d0bc797d0d1a3774ef574af1d5d248d2398`.

- Wrapper license: MIT
- Exact wrapper source: [bcb176448cf9700e9820b87afd29a78ab860cdf8](https://github.com/aolsenjazz/libsamplerate-js/tree/bcb176448cf9700e9820b87afd29a78ab860cdf8)
- Wrapper build script: [scripts/build_emscripten.sh](https://github.com/aolsenjazz/libsamplerate-js/blob/bcb176448cf9700e9820b87afd29a78ab860cdf8/scripts/build_emscripten.sh)
- libsamplerate license: BSD-2-Clause
- Exact libsamplerate source: [aee38d0bc797d0d1a3774ef574af1d5d248d2398](https://github.com/libsndfile/libsamplerate/tree/aee38d0bc797d0d1a3774ef574af1d5d248d2398)
- libsamplerate license at that revision: [COPYING](https://github.com/libsndfile/libsamplerate/blob/aee38d0bc797d0d1a3774ef574af1d5d248d2398/COPYING)
- Full licenses: `THIRD_PARTY_LICENSES/LIBSAMPLERATE-JS-MIT-AND-LIBSAMPLERATE-BSD-2-CLAUSE.txt`

Despite the package description calling it a WebAssembly port, this exact
revision's published build script sets Emscripten `WASM=0` and emits a
single-file JavaScript/asm.js artifact. Preserve both the wrapper MIT notice and
the embedded libsamplerate BSD-2-Clause notice in binary distributions.

