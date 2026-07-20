export const DEFAULT_AUDIO_STREAM_CODEC_RUNTIME_IDS = Object.freeze({
  encoderAdapter: 'mediabunny',
  inputAdapters: Object.freeze(['dsub-pcm', 'mediabunny'] as const),
  resamplerAdapter: 'libsamplerate-js',
});
