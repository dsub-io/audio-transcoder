import { createAudioTranscoderStreamEngine } from './engine.js';
import {
  exposeAudioTranscoderStreamWorker,
  type AudioTranscoderStreamWorkerScope,
} from './expose-worker.js';

exposeAudioTranscoderStreamWorker(
  createAudioTranscoderStreamEngine(),
  globalThis as unknown as AudioTranscoderStreamWorkerScope,
);
