# dsub audio transcoder

Browser-local audio inspection and transcoding engine for dsub tools.

This package provides framework-independent audio inspection, PCM decoding,
encoding, and transcoding primitives. It has no DOM or React dependency. UI
integrations should live in consumer applications such as `dsub-io/web`.

## Development

```sh
pnpm install
pnpm check
```

`pnpm check` runs strict type checking, unit tests with per-file 100% coverage,
the production build, a built-package API check, and a package contents smoke
test.

Framework-specific lifecycle, bundling, memory sizing, and production checks
are documented in [docs/integration.md](docs/integration.md).

## Public API

```ts
import {
  audioTranscoder,
  createAudioTranscoderEngine,
  createAudioTranscoderWorkerEngine,
  createAudioTranscoderWorkerPool,
  getEngineInfo,
  getVersion,
} from '@dsub/audio-transcoder';

audioTranscoder.getVersion();
getVersion();
getEngineInfo();

const isolatedEngine = createAudioTranscoderEngine();
isolatedEngine.getVersion();

const input = {
  data: await file.arrayBuffer(),
  name: file.name,
  size: file.size,
};

const metadata = isolatedEngine.inspect(input);
const controller = new AbortController();
const wav = await isolatedEngine.transcode(input, 'wav-pcm24', {
  signal: controller.signal,
  onProgress({ phase, progress }) {
    // progress is a number from 0 to 1, quantized to three decimal places.
    updateProgressUi(phase, progress);
  },
});
```

Call `controller.abort()` to cancel. Built-in PCM codecs process frames in
cooperative batches, so cancellation and UI updates can run between batches.
Progress events also include `operation`, `completedFrames`, and `totalFrames`.

For production browser UI, run decoding and encoding outside the main thread:

```ts
const workerEngine = createAudioTranscoderWorkerEngine();

try {
  const wav = await workerEngine.transcode(input, 'wav-pcm24', {
    signal: controller.signal,
    onProgress({ progress }) {
      updateProgressUi(progress);
    },
  });
} finally {
  workerEngine.terminate();
}
```

The Worker engine performs `decode`, `encode`, and `transcode` in a module Web
Worker. Header inspection, capabilities, and version queries stay synchronous
and local. Input buffers are copied by default so the caller can keep using
them. Set `transferInput: true` only when ownership may move to the Worker; the
original `ArrayBuffer` is then detached by the browser.

## Multi-file processing and memory

Use a Worker pool when users select multiple files. Calls are FIFO queued and
only `concurrency` operations run at once. The default is `1`; increase it only
after measuring peak memory on target devices.

```ts
const pool = createAudioTranscoderWorkerPool({ concurrency: 1 });

try {
  const results = await Promise.allSettled(
    files.map((file, index) => {
      const signal = getItemAbortSignal(index);

      return pool.schedule(
        async (engine) => {
          // File bytes are allocated only after a Worker slot is available.
          const data = await file.arrayBuffer();
          return engine.transcode(
            { data, name: file.name, size: file.size },
            'wav-pcm24',
            {
              signal,
              transferInput: true,
              onProgress: (event) => updateItem(index, event),
            },
          );
        },
        { signal },
      );
    }),
  );
} finally {
  pool.terminate();
}
```

The pool handles bounded FIFO scheduling, lazy Worker creation, queued
cancellation, reference cleanup, and idle Worker release after 30 seconds. It
can be reused after idle release; `terminate()` is permanent.

The caller must still:

- Use `schedule()` to avoid calling `file.arrayBuffer()` for every queued file
  up front.
- Pass the same `AbortSignal` to `schedule()` and the running engine operation.
- Call `terminate()` when the page or owning component is disposed.
- Use `transferInput: true` only when the source buffer will not be reused.
- Revoke download object URLs with `URL.revokeObjectURL()` and drop references
  to completed inputs and outputs when they are no longer needed.

Browsers do not provide portable forced garbage collection or a reliable memory
budget API. The pool can release references and Workers, but final reclamation
timing remains browser-controlled. Retry, priority, persistence, and visible
queue state belong in the consumer UI rather than this engine package.

The default Worker URL works without custom Vite or Next.js configuration in
the validated versions. If an application must own the Worker entry for CSP or
bundler reasons, create a local module containing only:

```ts
import '@dsub/audio-transcoder/worker';
```

Pass a module Worker for that file through `workerFactory`. See the integration
guide for the complete pattern.

The engine is a facade over separately registered inspector, decoder, and
encoder strategies. `createAudioTranscoderEngine({ plugins })` accepts custom
strategies for codecs such as browser/WASM FLAC or MP3 implementations without
coupling the core package to a UI framework.

Decoder and encoder plugins receive an operation context with `signal`,
`reportProgress(completedFrames, totalFrames)`, `checkpoint(...)`, and
`throwIfAborted()`. A plugin can therefore expose the same progress and
cancellation contract as the built-in codecs.

## Built-in capabilities

- Header inspection: WAV, AIFF/AIFC, CAF, FLAC, and MP3
- PCM decode: WAV, uncompressed AIFF, and LPCM CAF
- PCM encode: WAV 16-bit, WAV 24-bit, WAV 32-bit float, AIFF 16-bit, and AIFF
  24-bit
- Transcode: built-in PCM decode followed by one of the built-in encoders

FLAC and MP3 decoding/encoding are intentionally plugin boundaries at this
stage. Transcoding currently preserves the decoded sample rate and channel
layout; resampling and channel mixing will be separate strategies rather than
hidden quality-changing behavior.

Package metadata is generated from `package.json` before checking, testing, or
building, so Release Please remains the single version source of truth. Runtime
consumers can use `audioTranscoder.getVersion()`, `getVersion()`, or the
`AUDIO_TRANSCODER_VERSION` constant.

## Release

Release Please owns semantic versioning, changelog updates, GitHub releases, and
version changes. The initial package version is `0.0.1`.

After the one-time npm package bootstrap, Release Please also gates npm
publication. Validation and release creation run on dsub self-hosted runners;
the OIDC publish job alone runs on a GitHub-hosted runner. Enable it only after
`@dsub/audio-transcoder` trusts `.github/workflows/release.yml` on npmjs.com by
setting the repository variable `NPM_TRUSTED_PUBLISHING_ENABLED=true`.

## License

Required Notice: Copyright 2026 dsub.io. All rights reserved.

This software is source-available under the
[PolyForm Noncommercial License 1.0.0](LICENSE.md). Use, modification, and
redistribution are permitted only for noncommercial purposes. Commercial use
is prohibited.
