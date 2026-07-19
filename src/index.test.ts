import { describe, expect, it } from 'vitest';
import { AUDIO_TRANSCODER_PACKAGE } from './index.js';

describe('AUDIO_TRANSCODER_PACKAGE', () => {
  it('identifies the package boundary', () => {
    expect(AUDIO_TRANSCODER_PACKAGE).toBe('@dsub/audio-transcoder');
  });
});
