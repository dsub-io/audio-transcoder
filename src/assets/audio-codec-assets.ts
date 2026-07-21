import {
  GENERATED_CODEC_ASSET_MANIFEST,
  GENERATED_CODEC_ASSET_PACKAGE,
} from '../generated/codec-asset-metadata.js';
import {
  createJsDelivrRuntimeAssetSource,
  createRuntimeAssetProvider,
  type JsDelivrRuntimeAssetSource,
  type RuntimeAssetFetch,
  type RuntimeAssetLoadState,
  type RuntimeAssetProvider,
  type RuntimeAssetSource,
  type RuntimeAssetStateListener,
} from './runtime-asset-provider.js';

export const AUDIO_TRANSCODER_CODEC_ASSET_PACKAGE =
  GENERATED_CODEC_ASSET_PACKAGE;

export const AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST =
  freezeCodecAssetManifest(GENERATED_CODEC_ASSET_MANIFEST);

export type AudioTranscoderCodecAssetId =
  keyof typeof AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST.assets;

export interface AudioTranscoderCodecAssetProvider
  extends Omit<
    RuntimeAssetProvider,
    'getState' | 'load' | 'resolveUrl' | 'resolveUrls'
  > {
  getState(assetName: AudioTranscoderCodecAssetId): RuntimeAssetLoadState;
  load(
    assetName: AudioTranscoderCodecAssetId,
    signal?: AbortSignal,
  ): Promise<Uint8Array<ArrayBuffer>>;
  resolveUrl(assetName: AudioTranscoderCodecAssetId): string;
  resolveUrls(assetName: AudioTranscoderCodecAssetId): readonly string[];
}

export interface CreateAudioTranscoderCodecAssetProviderOptions {
  /** Explicitly selected by the application; no CDN is chosen implicitly. */
  readonly source: RuntimeAssetSource;
  readonly fallbackSources?: readonly RuntimeAssetSource[];
  readonly fetch?: RuntimeAssetFetch;
}

export interface AudioTranscoderCodecAssetsConfiguration {
  /** Primary source selected explicitly by the host application. */
  readonly source: RuntimeAssetSource;
  /** Optional same-manifest mirrors tried in order after the primary fails. */
  readonly fallbackSources?: readonly RuntimeAssetSource[];
  /** Receives Worker-local download, verification, readiness, and error state. */
  readonly onStateChange?: RuntimeAssetStateListener;
}

/**
 * Returns the version-locked jsDelivr source matching this engine package.
 * Applications still opt into it explicitly by passing the result to the
 * codec asset provider or Worker configuration.
 */
export function createAudioTranscoderJsDelivrAssetSource(): JsDelivrRuntimeAssetSource {
  return createJsDelivrRuntimeAssetSource(
    AUDIO_TRANSCODER_CODEC_ASSET_PACKAGE,
    AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST.version,
  );
}

export function createAudioTranscoderCodecAssetProvider(
  options: CreateAudioTranscoderCodecAssetProviderOptions,
): AudioTranscoderCodecAssetProvider {
  return createRuntimeAssetProvider({
    expectedAbiVersion: AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST.abiVersion,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.fallbackSources === undefined
      ? {}
      : { fallbackSources: options.fallbackSources }),
    manifest: AUDIO_TRANSCODER_CODEC_ASSET_MANIFEST,
    source: options.source,
  }) as AudioTranscoderCodecAssetProvider;
}

function freezeCodecAssetManifest<
  T extends typeof GENERATED_CODEC_ASSET_MANIFEST,
>(manifest: T): T {
  for (const descriptor of Object.values(manifest.assets)) {
    Object.freeze(descriptor);
  }
  Object.freeze(manifest.assets);
  return Object.freeze(manifest);
}
