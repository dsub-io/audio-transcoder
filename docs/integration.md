# Framework integration

The package performs all audio work in the browser. It does not upload files or
require a server codec process. The default Worker is created lazily on the
first queued operation.

## Production defaults

Use these defaults until measurements justify a change:

- Start with `createAudioTranscoderWorkerPool({ concurrency: 1 })`.
- Load the tool at route or component level instead of in the application root.
- Wrap `file.arrayBuffer()` in `pool.schedule()` so queued files are not loaded
  into memory early.
- Pass the same `AbortSignal` to `schedule()` and the engine operation.
- Use `transferInput: true` only after giving up ownership of the source buffer.
- Terminate the pool when its owning page or component is disposed.
- Revoke download object URLs and remove completed input/output references.

The current API is whole-buffer based. A decoded PCM buffer uses approximately
`frames * channels * 4` bytes before input bytes, encoded output, Worker state,
and codec memory are counted. One minute of 48 kHz stereo PCM is about 22 MiB;
ten minutes is about 220 MiB. Concurrent jobs multiply that working set, so
`navigator.hardwareConcurrency` is not a safe pool-size default.

Suggested starting points:

| Workload | Concurrency | Reason |
| --- | ---: | --- |
| Unknown devices or mobile | 1 | Lowest predictable peak memory |
| Large or long files | 1 | Whole input and decoded PCM coexist |
| Measured desktop workflow with short files | 2 | Some CPU parallelism without an aggressive memory multiplier |
| WASM codec plugins | 1 | Each Worker may own a separate WASM heap |

Applications should enforce their own file-count and file-size policy. The
engine cannot know the browser's available memory and browsers do not expose a
portable, reliable budget API.

## Browser baseline

The Worker engines require module Workers, transferable `ArrayBuffer` values,
and `AbortController`. If Workers are unavailable, the package returns a
`WORKER_UNAVAILABLE` error instead of silently running expensive work on the
main thread.

Run consumer E2E coverage in Chromium, Firefox, and WebKit before release.
Chromium verifies the shared engine used by Chrome, Edge, and Opera, but it does
not replace a branded-browser check when the product promises one. Codec
plugins, especially WASM implementations, must pass the same matrix separately.

## Vite and React

No Vite configuration is required. Keep the pool inside the component that
owns the tool and release it from the effect cleanup:

```tsx
import { useEffect, useRef } from 'react';
import {
  createAudioTranscoderWorkerPool,
  type AudioTranscoderWorkerPool,
} from '@dsub/audio-transcoder';

export function AudioTool() {
  const poolRef = useRef<AudioTranscoderWorkerPool | null>(null);

  useEffect(() => {
    const pool = createAudioTranscoderWorkerPool({ concurrency: 1 });
    poolRef.current = pool;

    return () => {
      pool.terminate();
      if (poolRef.current === pool) poolRef.current = null;
    };
  }, []);

  // Event handlers use poolRef.current.
}
```

For an optional tool, lazy-load the route or component. For a dedicated tool
route, route-level splitting is normally enough; the Worker payload still does
not load until the first operation. Do not add this package to
`optimizeDeps.exclude` unless a measured Vite issue requires it.

## Next.js App Router

Put Worker operations in a Client Component. Importing the package is SSR-safe,
but creating or using browser Workers on the server is not:

```tsx
'use client';

import { useEffect, useRef } from 'react';
import {
  createAudioTranscoderWorkerPool,
  type AudioTranscoderWorkerPool,
} from '@dsub/audio-transcoder';

export function AudioTranscoderClient() {
  const poolRef = useRef<AudioTranscoderWorkerPool | null>(null);

  useEffect(() => {
    const pool = createAudioTranscoderWorkerPool({ concurrency: 1 });
    poolRef.current = pool;
    return () => {
      pool.terminate();
      poolRef.current = null;
    };
  }, []);

  // Render file controls and run work from client event handlers.
}
```

The validated Next.js/Turbopack path needs no `transpilePackages`, custom
webpack callback, or public Worker copy. If the engine should load only after a
user action, call `await import('@dsub/audio-transcoder')` inside the Client
Component. Keep the pool in a ref and still terminate it on unmount.

For dsub, the intended boundary is a server-rendered `/tools/audio-transcoder`
page containing one focused Client Component. The queue rows, retry policy,
download state, and user-visible progress stay in `dsub-io/web`; the engine
package remains UI-independent.

## Vue

Keep the pool as a non-reactive local value. Create it on mount and terminate it
on unmount:

```vue
<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import {
  createAudioTranscoderWorkerPool,
  type AudioTranscoderWorkerPool,
} from '@dsub/audio-transcoder';

let pool: AudioTranscoderWorkerPool | undefined;

onMounted(() => {
  pool = createAudioTranscoderWorkerPool({ concurrency: 1 });
});

onUnmounted(() => {
  pool?.terminate();
  pool = undefined;
});
</script>
```

Use a lazy route or `defineAsyncComponent()` when the tool is optional. In an
SSR Vue application, keep file and Worker operations in mounted client code. If
the pool must live in reactive state, wrap it with `shallowRef()` or `markRaw()`
instead of deep proxying it.

## Other component systems

The ownership rule is the same everywhere:

| Environment | Create | Dispose |
| --- | --- | --- |
| Svelte | Component initialization or `onMount` | `onDestroy` |
| Angular | `ngOnInit` or a component-scoped service | `ngOnDestroy` |
| Vanilla JavaScript | Tool initialization | Explicit `dispose()` or `pagehide` |
| Storybook | Inside the rendered story component | Component unmount cleanup |

Do not keep a global pool unless the application intentionally wants a
cross-route queue. A global pool makes cancellation, stale UI updates, and
memory ownership harder to reason about.

## Custom Worker entry

The default package Worker URL should be preferred. If a bundler or Content
Security Policy requires an application-owned entry, add a local file:

```ts
// audio-transcoder.worker.ts
import '@dsub/audio-transcoder/worker';
```

Then provide the module Worker explicitly:

```ts
const pool = createAudioTranscoderWorkerPool({
  concurrency: 1,
  workerFactory: () =>
    new Worker(new URL('./audio-transcoder.worker.ts', import.meta.url), {
      name: 'dsub-audio-transcoder',
      type: 'module',
    }),
});
```

Default production builds emit a same-origin Worker asset, so a CSP normally
needs `worker-src 'self'`. Add `blob:` only if the consumer's bundler actually
emits blob Worker URLs.

## Consumer release gate

Run both development and production paths because Worker asset handling can
differ between them:

1. Build the consuming application.
2. Serve the production output from its normal base path.
3. Run one real Worker encode or transcode in a browser.
4. Confirm progress reaches `1`, cancellation settles, and no console errors
   occur.
5. Confirm the Worker asset returns JavaScript rather than an HTML fallback.
6. Repeat the interaction in the development server.

For Storybook, test the built Storybook in addition to the development server.
The story should perform a tiny real encode and terminate its pool on unmount.

The `0.0.1` package tarball has been exercised in Vite 8.1.5 with Vue 3.5.40
and in Next.js 16.2.9 with Turbopack, in both development and production modes.
