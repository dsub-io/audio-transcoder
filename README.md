# dsub audio transcoder

Browser-local audio inspection and transcoding engine for dsub tools. The
package makes no media-upload requests: codec work runs in module Web Workers,
and files stay on the user's device unless the consumer application sends them
elsewhere.

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
  createAudioTranscoderOutputSession,
  createAudioTranscoderStreamWorkerPool,
  type AudioStreamTarget,
  type AudioTranscoderOutputArtifact,
} from '@dsub/audio-transcoder';

const pool = createAudioTranscoderStreamWorkerPool({
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

### Output capabilities and runtime probing

`getCapabilities().outputFormats` is the immutable candidate manifest bundled
with the package. It describes installed presets and their static constraints;
it does not prove that the current browser can initialize every codec runtime.
The current manifest contains:

| Format | Preset IDs | Implementation | Channels | Encoder target sample rates |
| --- | --- | --- | ---: | --- |
| WAV | `wav-pcm16`, `wav-pcm24`, `wav-pcm32`, `wav-float32` | Built in, eager | 1-32 | 8,000-384,000 Hz |
| MP3 | `mp3-128kbps` | Bundled WASM, lazy | 1-2 | 16,000, 22,050, 24,000, 32,000, 44,100, or 48,000 Hz |
| MP3 | `mp3-192kbps`, `mp3-256kbps`, `mp3-320kbps` | Bundled WASM, lazy | 1-2 | 32,000, 44,100, or 48,000 Hz |
| FLAC | `flac-16bit`, `flac-24bit` | Bundled WASM, lazy | 1-8 | 8,000, 16,000, 22,050, 24,000, 32,000, 44,100, 48,000, 88,200, 96,000, 176,400, or 192,000 Hz |

Do not copy this table into application logic. Build controls from
`outputFormats`, apply each preset's channel and sample-rate constraints
synchronously, then call `probeOutputSupport()` for the exact explicit target.
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
sequentially and apply each verdict only to that target. MP3 or FLAC probing
intentionally downloads its lazy codec chunk, so defer those probes for a
smaller initial transfer. Never start every probe concurrently. See
[Browser integration](docs/integration.md#capability-driven-controls) for the
full UI and framework lifecycle guidance.

Lower-rate MP3 combinations are intentionally absent. LAME can silently encode
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

When running work rejects with `OPERATION_ABORTED`, the pool terminates that
Worker before reusing the slot, so a stalled native decoder cannot accumulate
across retries. Inside `schedule()`, discard owned output and rethrow the abort.
If using a standalone Worker engine instead of the pool, await `dispose()`
before creating a replacement and retrying.

`inputReadBytes`, `pcmChunkBytes`, and `outputChunkBytes` bound one source read,
decoded PCM yield, and encoded output chunk. They are not total heap limits.
MediaBunny caches, browser decoder state, Workers, nested codec Workers, WASM
heaps, source `Blob` objects, and output storage consume additional memory.
Browsers provide neither portable forced garbage collection nor a reliable
available-memory budget.

Use `await engine.dispose()` or `await pool.dispose()` whenever output abort and
writer-lock release must be complete before removing OPFS entries. `terminate()`
remains a fire-and-forget compatibility method and is not an awaited cleanup
barrier.

### Lazy codec and resampler chunks

WAV encoding is built in and loads eagerly. MP3 and FLAC use the official
[MediaBunny MP3 encoder](https://mediabunny.dev/guide/extensions/mp3-encoder)
and [MediaBunny FLAC encoder](https://mediabunny.dev/guide/extensions/flac-encoder).
Each extension is dynamically imported and registered inside the codec Worker
only when one of its presets is first selected. The extension code, nested Blob
Worker, and WASM payload are bundled with the application; there is no CDN fetch
or server-side media processing.

Sample-rate conversion uses `@alexanderolsen/libsamplerate-js`, whose current
distribution is an asm.js payload. It is also a separate dynamic import: a job
whose target sample rate equals its source rate does not load the resampler
chunk.

Vite production builds must preserve the Worker as an ES module for those
dynamic imports to remain separate network chunks:

```ts
import { defineConfig } from 'vite';

export default defineConfig({
  worker: { format: 'es' },
});
```

Without `worker.format: 'es'`, Vite's IIFE Worker output can inline the lazy
encoder and resampler modules. Encoding remains functional, but those payloads
increase the initial Worker resource cost.

For strict CSP, the core WAV path needs the same-origin module Worker. MP3/FLAC
extension use additionally needs a Blob Worker and WebAssembly compilation:

```http
Content-Security-Policy:
  script-src 'self' 'wasm-unsafe-eval';
  worker-src 'self' blob:
```

See MDN's [`worker-src`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/worker-src)
and [`script-src`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src)
references. `blob:` and `'wasm-unsafe-eval'` are needed for the bundled MP3/FLAC
extensions, not for built-in WAV encoding.

## Whole-buffer API

The whole-buffer API remains available for short inputs and compatibility. It
accepts a complete `ArrayBuffer` and can make the input, decoded Float32 PCM, and
encoded output coexist in memory.

Built-in capabilities are:

- Header inspection: WAV, AIFF/AIFC, CAF, FLAC, and MP3.
- PCM decode: WAV, uncompressed AIFF/AIFC, and LPCM CAF.
- PCM encode: WAV integer 16/24/32-bit and WAV float32; AIFF integer 16/24-bit.
- Transcode: a built-in PCM decoder followed by a built-in encoder.

The official streaming MP3/FLAC extensions do not change the whole-buffer
plugin boundary. Whole-buffer FLAC or MP3 decode/encode still requires a plugin.

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

## License

Required Notice: Copyright 2026 dsub.io. All rights reserved.

This software is source-available under the
[PolyForm Noncommercial License 1.0.0](LICENSE.md). Use, modification, and
redistribution are permitted only for noncommercial purposes. Commercial use is
prohibited. Bundled dependency notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), with complete license texts
in [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES). Web distributors should ship
those files with production bundles and follow the source/build checklist in
the notice.
