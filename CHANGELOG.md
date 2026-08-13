# Changelog

## [0.4.0](https://github.com/dsub-io/audio-transcoder/compare/v0.3.1...v0.4.0) (2026-08-13)


### Features

* support HTTP range audio inputs ([#25](https://github.com/dsub-io/audio-transcoder/issues/25)) ([5fd08ba](https://github.com/dsub-io/audio-transcoder/commit/5fd08ba5abe4d21f4bcfd27dfe54f975ed1283b1))

## [0.3.1](https://github.com/dsub-io/audio-transcoder/compare/v0.3.0...v0.3.1) (2026-07-30)


### Bug Fixes

* enforce declaration and release validation ([#22](https://github.com/dsub-io/audio-transcoder/issues/22)) ([44c9f13](https://github.com/dsub-io/audio-transcoder/commit/44c9f1341fc7605a3a24eba66f182997fe9421e0))

## [0.3.0](https://github.com/dsub-io/audio-transcoder/compare/v0.2.0...v0.3.0) (2026-07-28)


### ⚠ BREAKING CHANGES

* memory-backed output sessions now reserve artifact and Blob materialization capacity when create() resolves. Concurrent callers should pass maxMemoryArtifactBytes per pending output.

### Features

* reserve browser output capacity safely ([5436515](https://github.com/dsub-io/audio-transcoder/commit/543651529af0d9758bed245d2ab1fdf60c65c412))

## [0.2.0](https://github.com/dsub-io/audio-transcoder/compare/v0.1.2...v0.2.0) (2026-07-21)


### Features

* add source-aware output selection ([#17](https://github.com/dsub-io/audio-transcoder/issues/17)) ([66812c6](https://github.com/dsub-io/audio-transcoder/commit/66812c6aaa9f4443a22119762e36bd163f2e2390))

## [0.1.2](https://github.com/dsub-io/audio-transcoder/compare/v0.1.1...v0.1.2) (2026-07-21)


### Bug Fixes

* prevent bundlers from resolving runtime AAC WASM ([#15](https://github.com/dsub-io/audio-transcoder/issues/15)) ([625e87b](https://github.com/dsub-io/audio-transcoder/commit/625e87b5ff7017f4bf63659fc850eb1930f0e5a9))

## [0.1.1](https://github.com/dsub-io/audio-transcoder/compare/v0.1.0...v0.1.1) (2026-07-21)


### Bug Fixes

* serve codec assets from release tags ([#13](https://github.com/dsub-io/audio-transcoder/issues/13)) ([0612f89](https://github.com/dsub-io/audio-transcoder/commit/0612f89844d100cab1c52f179727608a4b7c1cfe))

## [0.1.0](https://github.com/dsub-io/audio-transcoder/compare/v0.0.3...v0.1.0) (2026-07-21)


### ⚠ BREAKING CHANGES

* default stream workers now require codecAssets, and runtime output descriptors use runtime-asset instead of bundled-wasm.

### Features

* add source-aware browser codec outputs ([#11](https://github.com/dsub-io/audio-transcoder/issues/11)) ([9134b25](https://github.com/dsub-io/audio-transcoder/commit/9134b25dd7b93c31d598ed0e6cc7b866dced040a))

## [0.0.3](https://github.com/dsub-io/audio-transcoder/compare/v0.0.2...v0.0.3) (2026-07-20)


### Features

* add bounded browser streaming runtime ([f6d84b2](https://github.com/dsub-io/audio-transcoder/commit/f6d84b2e1a5c4992f0fd63b8bfc9522aed7c1cc9))


### Miscellaneous Chores

* set release version ([0a8078a](https://github.com/dsub-io/audio-transcoder/commit/0a8078abfdb170ec2d5e8aa05e39e543b4d065d8))

## [0.0.2](https://github.com/dsub-io/audio-transcoder/compare/v0.0.1...v0.0.2) (2026-07-19)


### Bug Fixes

* declare noncommercial source license ([1f94a0c](https://github.com/dsub-io/audio-transcoder/commit/1f94a0c24e1721db072da0615d9f82c00c1af6c1))

## 0.0.1 (2026-07-19)

### Features

* add browser audio transcoding engine ([32453a2](https://github.com/dsub-io/audio-transcoder/commit/32453a2f483f6d73fe2323a718dcc2d8351c0475))
