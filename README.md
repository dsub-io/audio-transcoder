# dsub audio transcoder

Browser-local audio inspection and transcoding engine for dsub tools. The
package makes no media-upload requests: codec work runs in module Web Workers,
and files stay on the user's device unless the consumer application sends them
elsewhere. Lazy raw WebAssembly is fetched only from the asset source that the
host application explicitly configures; the package never selects a CDN.

> Licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE.md).
> Commercial use is not permitted by this package license.

## Quick Start

```sh
pnpm add @dsub/audio-transcoder
# or: npm install @dsub/audio-transcoder
```

This complete path opens temporary output only after a bounded Worker slot is
available. Keep the returned download cleanup function for as long as the link
is usable.

```ts
import {
  AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST,
  createAudioTranscoderOutputSession,
  createAudioTranscoderStreamWorkerPool,
  createSelfHostedRuntimeAssetSource,
  type AudioStreamTarget,
  type AudioTranscoderOutputArtifact,
} from '@dsub/audio-transcoder';

const pool = createAudioTranscoderStreamWorkerPool({
  codecAssets: {
    source: createSelfHostedRuntimeAssetSource(
      `/audio-transcoder-codecs/${AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST.version}`,
    ),
    onStateChange: ({ assetName, phase, loadedBytes, totalBytes }) => {
      console.log({ assetName, phase, loadedBytes, totalBytes });
    },
  },
  concurrency: 1,
  maxQueued: 8,
});
const outputSession = createAudioTranscoderOutputSession({
  memoryLimitBytes: 128 * 1024 * 1024,
  namespace: 'my-audio-tool',
});

async function transcodeFile(
  file: File,
  signal: AbortSignal,
): Promise<AudioTranscoderOutputArtifact> {
  return pool.schedule(
    async (engine) => {
      const input = { blob: file, name: file.name };
      const inputSupport = await engine.probeInputSupport(input, { signal });
      if (inputSupport.status !== 'supported') {
        throw new Error(`Input support: ${inputSupport.status}`);
      }

      const { channels, sampleRate } = inputSupport.inspection;
      if (channels === null || sampleRate === null) {
        throw new Error('The input channel count or sample rate is unknown.');
      }

      const target = {
        channels,
        presetId: 'wav-pcm24',
        sampleRate,
      } as const satisfies AudioStreamTarget;
      const outputSupport = await engine.probeOutputSupport(target, { signal });
      if (outputSupport.status !== 'supported') {
        throw new Error(outputSupport.message);
      }

      const pending = await outputSession.create();
      try {
        const result = await engine.transcode(
          input,
          target,
          pending.stream,
          { signal },
        );
        return await pending.complete({
          mimeType: result.preset.mimeType,
          name: replaceExtension(file.name, result.preset.extension),
        });
      } catch (error) {
        await pending.discard();
        throw error;
      }
    },
    { signal },
  );
}

async function offerDownload(
  file: File,
  signal: AbortSignal,
): Promise<() => Promise<void>> {
  const artifact = await transcodeFile(file, signal);
  let url: string;
  try {
    url = URL.createObjectURL(artifact.blob);
  } catch (error) {
    await artifact.dispose();
    throw error;
  }

  const link = document.createElement('a');
  link.download = artifact.name;
  link.href = url;
  link.textContent = `Download ${artifact.name}`;
  document.body.append(link);

  return async () => {
    link.remove();
    URL.revokeObjectURL(url);
    await artifact.dispose();
  };
}

function replaceExtension(name: string, extension: string): string {
  const dot = name.lastIndexOf('.');
  return `${dot > 0 ? name.slice(0, dot) : name}.${extension}`;
}

// On route teardown: abort active controllers, release download links, then:
async function disposeAudioTool(): Promise<void> {
  await pool.dispose();
  await outputSession.dispose();
}
```

Pass a `File` from a file input or drop event to `offerDownload()`. Revoke the
object URL and dispose its artifact when removing the link; then await
`disposeAudioTool()` when the tool route unmounts. Framework and `pagehide`
ownership are covered in [Browser integration](docs/integration.md).

## Runtime codec assets

The default stream Worker requires an explicit `codecAssets.source`. WAV and
AIFF use eager JavaScript and do not fetch a codec asset. Selecting or probing
AAC, Ogg Opus, MP3, or FLAC fetches that codec's raw `.wasm`; a sample-rate
change fetches only the selected `fast`, `balanced`, or `best` resampler. These
bytes execute directly in the existing module Worker. They are not embedded in
the engine package and do not create a nested or Blob Worker.

Codec assets are versioned with `@dsub/audio-transcoder` in the same public
GitHub release tag. They are not published as a separate npm package. The
convenience helper is an explicit jsDelivr opt-in:

```ts
import {
  createAudioTranscoderJsDelivrAssetSource,
  createAudioTranscoderStreamWorkerPool,
} from '@dsub/audio-transcoder';

const pool = createAudioTranscoderStreamWorkerPool({
  codecAssets: {
    // This call is the application's explicit decision to use jsDelivr.
    source: createAudioTranscoderJsDelivrAssetSource(),
  },
});
```

The helper always resolves the engine's baked exact version. For example, an
engine at `1.2.3` resolves AAC to
`https://cdn.jsdelivr.net/gh/dsub-io/audio-transcoder@v1.2.3/codec-assets/wasm/aac.wasm`;
it never uses a branch, `latest`, or a SemVer range. This URL is an example of
the versioned contract, not a claim that an illustrative version is published.
The matching public Git tag contains the exact modified source, build/relink
scripts, manifests, notices, and upstream archive URLs and hashes described in
[`codec-assets/README.md`](codec-assets/README.md).

Self-hosting is equally explicit. A primary source and its fallbacks are tried
sequentially in the configured order, never raced:

```ts
const version = AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST.version;
const pool = createAudioTranscoderStreamWorkerPool({
  codecAssets: {
    source: createSelfHostedRuntimeAssetSource(
      `https://assets.example.com/audio-transcoder/${version}`,
    ),
    fallbackSources: [createAudioTranscoderJsDelivrAssetSource()],
    onStateChange: (state) => console.log(state),
  },
});
```

Every fallback must serve the same stable paths and exact bytes. Before any
bytes are used, the runtime validates manifest schema and ABI compatibility,
then checks the decoded raw response size and SHA-256 against the manifest baked
into the engine. The state model begins at `idle`; `onStateChange` emits
`downloading`, `verifying`, `ready`, or final `error` transitions. With
compressed HTTP transfer, `totalBytes` can be `null` because `Content-Length`
may describe transport bytes while integrity covers the decoded raw WASM.

## Development

```sh
pnpm install
pnpm check
```

`pnpm check` runs strict type checking, unit tests with per-file 100% coverage,
the production build, built-package API verification, and a package-contents
smoke test. Framework lifecycle and deployment details are in
[docs/integration.md](docs/integration.md).

## Streaming API

Use the streaming Worker API for production transcoding. It reads `Blob` or
`File` input in bounded chunks and writes random-access output chunks instead
of materializing the complete input, decoded PCM, and output in JavaScript
memory at once.

### Input discovery and probing

`getCapabilities().inputFormats` provides extension and MIME hints for picker
UI. They are not support assertions. Every concrete file must pass
`probeInputSupport()` before conversion is enabled.

| Candidate container | Common extension hints | Decision path |
| --- | --- | --- |
| CAF LPCM | `.caf` | Built-in PCM |
| AIFF/AIFC PCM | `.aif`, `.aiff`, `.aifc` | Built-in PCM |
| MP4/QuickTime | `.m4a`, `.mp4`, `.mov`, `.qt` | Runtime-probed |
| Matroska/WebM | `.mka`, `.mkv`, `.webm` | Runtime-probed |
| WAV | `.wav`, `.wave` | Runtime-probed |
| Ogg | `.oga`, `.ogg`, `.opus` | Runtime-probed |
| FLAC / MP3 | `.flac`, `.mp3` | Runtime-probed |
| ADTS / MPEG-TS | `.aac`, `.adts`, `.ts` | Runtime-probed |

`recognized-unsupported` means a parser recognized the container but the
current runtime cannot decode its codec. `unsupported` means no installed
parser recognized the file headers. Probing reads metadata and decoder support;
runtime decoders validate at most the first decoded sample within the configured
`inputReadBytes` read budget. If that budget is too small to reach a verdict,
`probeInputSupport()` rejects with
`AudioTranscoderError.code === 'RESOURCE_LIMIT_EXCEEDED'`; this is not an
unsupported verdict. Increase the budget within its documented limit or ask the
user to choose a different file instead of disabling the format globally.

The engine adds no wall-clock deadline. Browser codec APIs are runtime-owned and
can stall, so UI probes should compose their lifecycle `AbortSignal` with an
application deadline. Treat a rejected or aborted probe as retryable rather
than permanently disabling the input format.

Every built-in inspection also exposes structured `sourceEncoding`. Use it
instead of parsing the human-readable `codec` field. PCM sources identify
integer versus float representation, bit depth, signedness, and endianness;
compressed sources identify lossless/lossy codec metadata when available.
This lets a consumer render, for example, `32-bit float` and `32-bit signed
integer` as distinct source formats.

### Output capabilities and runtime probing

`getCapabilities().outputFormats` is the immutable candidate manifest declared
by the package. It describes installed presets and their static constraints;
it does not prove that the current browser can initialize every codec runtime.
`implementation: 'runtime-asset'` means the encoder bytes are delivered
separately through the application's explicit asset provider, never bundled in
the core Worker.
The current manifest contains:

| Format | Preset IDs | Implementation | Channels | Encoder target sample rates |
| --- | --- | --- | ---: | --- |
| WAV | `wav-pcm16`, `wav-pcm24`, `wav-pcm32`, `wav-float32` | Built in, eager | 1-32 | 8,000-384,000 Hz |
| AIFF | `aiff-pcm16`, `aiff-pcm24` | Built in, eager | 1-32 | 8,000-384,000 Hz |
| AAC-LC (ADTS) | `aac-96kbps`, `aac-128kbps`, `aac-192kbps`, `aac-256kbps` | External raw WASM, lazy | 1-2 | 32,000, 44,100, or 48,000 Hz |
| Ogg Opus | `ogg-opus-64kbps`, `ogg-opus-96kbps`, `ogg-opus-128kbps`, `ogg-opus-192kbps` | External raw WASM, lazy | 1-2 | 48,000 Hz |
| MP3 | `mp3-128kbps` | External raw WASM, lazy | 1-2 | 16,000, 22,050, 24,000, 32,000, 44,100, or 48,000 Hz |
| MP3 | `mp3-192kbps`, `mp3-256kbps`, `mp3-320kbps` | External raw WASM, lazy | 1-2 | 32,000, 44,100, or 48,000 Hz |
| FLAC | `flac-16bit`, `flac-24bit` | External raw WASM, lazy | 1-8 | 8,000, 16,000, 22,050, 24,000, 32,000, 44,100, 48,000, 88,200, 96,000, 176,400, or 192,000 Hz |

Do not copy this table into application logic. Build format-specific controls
with `getAudioStreamOutputParameters()`: WAV exposes sample format and bit
depth, AIFF/FLAC expose bit depth, and AAC/Ogg Opus/MP3 expose bitrate. Pass the
semantic selection and inspected source to `resolveAudioStreamFormatTarget()`
to obtain the exact source-preserving target and probe target. Then call
`probeOutputSupport()` for that exact target.
Render `checking` while it runs and enable conversion only for `supported`.
Gray or omit explicit `unsupported-configuration` and `runtime-unavailable`
results. A rejected Promise is a retryable operation, resource, queue,
cancellation, or programmer error state, not an unsupported verdict.

The runtime probe performs a tiny real encode into a bounded discard sink. It
does not read an input, create OPFS state or an artifact, or load the resampler.
A static mismatch does not load a lazy codec. Identical requests are coalesced;
one probe runs at a time, at most eight unique targets wait, and up to 32
successful exact targets are cached. Unsupported results and rejected probes
are not cached. Cancelling the last subscriber stops shared work.

Do not infer codec support from the user agent,
`navigator.hardwareConcurrency`, or `navigator.deviceMemory`. Probe each
concrete input with `probeInputSupport()` and each exact output configuration
with `probeOutputSupport()`. Device hints may tune queue or concurrency only
after measurement; the default and recommended concurrency is `1`.

Probe the selected exact target first. Preflight other offered exact targets
sequentially and apply each verdict only to that target. Probing AAC, Ogg Opus,
MP3, or FLAC intentionally downloads that format's raw codec asset, so defer
those probes for a smaller initial transfer. Never start every probe
concurrently. See
[Browser integration](docs/integration.md#capability-driven-controls) for the
full UI and framework lifecycle guidance.

`loading: 'lazy'` describes asset ownership; it is not an engine-wide live
loading flag. Set the selected control to `checking` before awaiting
`probeOutputSupport()`, and set a job to `preparing` before calling
`transcode()`. Those host states cover Worker startup, dynamic import, WASM
compilation, and codec initialization before the first package progress event.
There is deliberately no eager `ready()` call that downloads every codec.

Ogg Opus always encodes at its 48 kHz codec clock. A 48 kHz source can keep the
source rate; any other supported source must select 48 kHz explicitly so the
resolver and runtime make resampling visible. Lower-rate MP3 combinations are
intentionally absent. LAME can silently encode
some requested high-bitrate, low-sample-rate combinations at a lower bitrate;
the public presets reject those combinations instead of misreporting the
result. Always use each preset's exact discrete rate array.

The target constraint describes the encoder. When the target rate differs from
the source rate, also respect `capabilities.limits.sampleRate.resampling`; the
default runtime allows conversion only from 8,000 through 192,000 Hz. Same-rate
pass-through uses `limits.sampleRate.passThrough`, currently 8,000 through
384,000 Hz.

The processing pipeline is interleaved Float32 PCM. `wav-pcm32` writes a
32-bit signed-integer WAV container, but its effective retained integer
precision is 24 bits, as reported by
`descriptor.processingPrecision.effectiveIntegerPrecisionBits`. It must not be
presented as preserving 32-bit integer source precision.

### Local output sessions

`createAudioTranscoderOutputSession()` provides a seekable temporary output
without requiring a directory picker. It prefers the
[origin private file system (OPFS)](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
and falls back to paged memory with a hard aggregate reservation limit.

The Quick Start shows the complete ownership path. An OPFS artifact remains
readable only until `artifact.dispose()` starts. The memory fallback's
`complete()` materializes a Blob and reserves copy headroom; creating an object
URL from that Blob adds no application-level copy. Revoke the URL before
awaiting artifact disposal. Failed cleanup remains session-tracked and is
retried by `outputSession.dispose()`.

OPFS data does not automatically disappear when a tab closes. Explicit,
awaited disposal is authoritative. An integrated transcoder should keep
`disposeOnPageHide` at its default `false` and install one app-level handler so
best-effort cleanup starts in the strict order of pool first and output session
second. The session option is only a convenience when no active
writer is owned independently of the session. Browsers do not wait for an async
`pagehide` handler, and BFCache transitions (`event.persisted`) intentionally
keep the runtime alive. A new session sweeps managed orphans at startup.
[Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API)
protect active sessions in other tabs; where locks are unavailable, only stale
lease directories older than the conservative fallback age are reclaimed.

### Queue and memory limits

The stream Worker engine and pool retain at most `maxQueued` waiting operations.
The default is `8`, the maximum is `64`, and active operations are excluded.
When full, a new operation rejects with
`AudioTranscoderError.code === 'QUEUE_CAPACITY_EXCEEDED'`. Pool concurrency
defaults to `1` and is limited to `4`; increase it only after measuring peak
memory on target devices. `getQueueSnapshot()` exposes active and queued counts.

Open each pending output inside `pool.schedule()` so queued jobs do not retain
writable destinations. A queued callback can retain its source `File` or `Blob`,
but does not read it into an `ArrayBuffer`; output storage starts only after a
Worker slot is available. Direct `pool.transcode()` calls accept an already-open
output and abort it if admission, queued cancellation, disposal, or Worker
startup fails. Pass the same `AbortSignal` to `schedule()`, probing, and
transcoding.

The destination remains abortable through encoder finalization and, on the
Worker path, until both Worker-side output completion and the success result
arrive. The final destination `close()` call is the explicit irreversible
commit point. Cancellation or disposal requested after that call starts waits
for its success or failure instead of reporting an abort for output that may
already have committed.

When running work rejects with `OPERATION_ABORTED`, the pool terminates that
Worker before reusing the slot, so a stalled native decoder cannot accumulate
across retries. Inside `schedule()`, discard owned output and rethrow the abort.
If using a standalone Worker engine instead of the pool, await `dispose()`
before creating a replacement and retrying.

`inputReadBytes`, `pcmChunkBytes`, and `outputChunkBytes` bound one source read,
decoded PCM yield, and encoded output chunk. They are not total heap limits.
MediaBunny caches, browser decoder state, the module Worker, WASM heaps, source
`Blob` objects, and output storage consume additional memory.
Browsers provide neither portable forced garbage collection nor a reliable
available-memory budget.

Use `await engine.dispose()` or `await pool.dispose()` whenever output abort and
writer-lock release must be complete before removing OPFS entries. `terminate()`
remains a fire-and-forget compatibility method and is not an awaited cleanup
barrier.

### Lazy codec assets and resamplers

WAV and AIFF encoding are built in and load eagerly. AAC-LC uses a pinned
minimal FFmpeg build, Ogg Opus uses pinned libopusenc/libopus/libogg, MP3 uses
pinned LAME, and FLAC uses pinned libFLAC. Their bridges load raw WASM from the
application's required `codecAssets` configuration only when a matching preset
is first selected or probed. The runtime has no implicit CDN, embedded WASM
payload, nested Worker, or server-side media processing path.

Sample-rate conversion uses three package-owned libsamplerate WASM modules, one
for each existing `best`, `balanced`, and `fast` quality contract. A conversion
loads only the selected module. `best` retains libsamplerate's complete
highest-quality sinc coefficient table; no coefficient, passband, or supported
rate/channel range is reduced to save bytes. A job whose target sample rate
equals its source rate takes the pass-through path and loads no resampler.

Vite production builds must preserve the Worker as an ES module so lazy
JavaScript glue remains split from the initial Worker:

```ts
import { defineConfig } from 'vite';

export default defineConfig({
  worker: { format: 'es' },
});
```

Without `worker.format: 'es'`, Vite's IIFE Worker output can inline lazy
JavaScript glue. Raw WASM still comes from the explicitly configured asset
source, but the initial Worker resource can grow.

For strict CSP, the module Worker needs `worker-src 'self'` and raw WASM needs
WebAssembly compilation. Fetches from a same-origin asset path need
`connect-src 'self'`; explicit jsDelivr use additionally needs
`connect-src https://cdn.jsdelivr.net`:

```http
Content-Security-Policy:
  script-src 'self' 'wasm-unsafe-eval';
  worker-src 'self';
  connect-src 'self' https://cdn.jsdelivr.net
```

See MDN's [`worker-src`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/worker-src)
and [`script-src`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src)
references. Remove the jsDelivr origin when all assets are same-origin; include
every configured cross-origin fallback in `connect-src`. A cross-origin asset
host must allow CORS. Serve `.wasm` as `application/wasm` and enable HTTP gzip
or Brotli as transport compression. The CDN or asset host sees only asset
requests; input audio remains local unless the application uploads it.

## Whole-buffer API

The whole-buffer API remains available for short inputs and compatibility. It
accepts a complete `ArrayBuffer` and can make the input, decoded Float32 PCM, and
encoded output coexist in memory.

Built-in capabilities are:

- Header inspection: WAV, AIFF/AIFC, CAF, FLAC, and MP3.
- PCM decode: WAV, uncompressed AIFF/AIFC, and LPCM CAF.
- PCM encode: WAV integer 16/24/32-bit and WAV float32; AIFF integer 16/24-bit.
- Transcode: a built-in PCM decoder followed by a built-in encoder.

The streaming AAC/Ogg Opus/MP3/FLAC encoders do not change the whole-buffer
plugin boundary. Whole-buffer encoding for those formats still requires a
plugin.

Whole-buffer operations use a 64 MiB safety guard and fail with
`RESOURCE_LIMIT_EXCEEDED`. Built-in WAV, AIFF/AIFC, and CAF decoders estimate
the expanded planar Float32 size from headers and reject oversized output before
allocating it. A plugin decoder can provide `estimateDecodedPcm()` for the same
preflight; without that hook, decoded PCM can only be checked after the plugin
has allocated it. `unsafeAllowLargeBuffers: true` explicitly bypasses the guard
but cannot prevent an out-of-memory failure.

```ts
import { createAudioTranscoderEngine } from '@dsub/audio-transcoder';

const engine = createAudioTranscoderEngine();

async function transcodeShortFile(file: File, signal: AbortSignal) {
  const input = {
    data: await file.arrayBuffer(),
    name: file.name,
    size: file.size,
  };

  const inspection = engine.inspect(input);
  const encoded = await engine.transcode(input, 'wav-pcm24', {
    signal,
    onProgress: ({ phase, progress }) => console.log(phase, progress),
  });

  return { encoded, inspection };
}
```

Whole-buffer Worker engines and pools use `maxQueued: 8` and
`maxQueuedBytes: 64 * 1024 * 1024` by default. The byte budget counts only
waiting operations: complete input buffers and unique PCM backing buffers are
counted conservatively, while active work is excluded. `unsafeAllowLargeBuffers`
does not bypass this aggregate waiting-queue limit. Pool snapshots expose
`maxQueuedBytes` and `queuedBytes`.

The pool cannot measure data captured by an arbitrary `schedule()` callback, so
that callback contributes zero to `queuedBytes`. Load the file inside the
callback after a slot is available. Whole-buffer APIs retain the synchronous
`terminate()` lifecycle because they do not own the streaming output locks
managed by the stream API.

## Version and release

Release Please owns semantic versioning, changelog updates, GitHub releases, and
package version changes. Runtime consumers can use `audioTranscoder.getVersion()`,
`getVersion()`, or `AUDIO_TRANSCODER_VERSION`.

The engine and its `codec-assets/` tree are one exact-version release. Release
Please owns the version, public tag, and GitHub release. The Release workflow
checks the tagged manifest and all seven raw WASM files through the exact
jsDelivr `/gh/dsub-io/audio-transcoder@v<version>/codec-assets` path, then
publishes only `@dsub/audio-transcoder` through npm Trusted Publishing (OIDC).
There is no separate codec npm package, manual publish path, recovery publish,
or manually created tag. The engine publication gate fails closed until the
tagged CDN assets pass their size, SHA-256, ABI, schema, and WebAssembly checks.

## License

Required Notice: Copyright 2026 dsub.io. All rights reserved.

This software is source-available under the
[PolyForm Noncommercial License 1.0.0](LICENSE.md). Use, modification, and
redistribution are permitted only for noncommercial purposes. Commercial use is
prohibited. Third-party dependency notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), with complete license texts
in [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES) and source/build materials under
`codec-build/` and `vendor/`. Released binaries identify their corresponding
source by the public Git tag matching the package version. Web distributors
should retain the required notices and that exact source/relink reference for
the raw assets they deploy.
