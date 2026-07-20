import { expect, test, type BrowserContext } from '@playwright/test';

const EXPECTED_OUTPUTS = [
  { bitDepth: 16, format: 'wav', formatTag: 1, presetId: 'wav-pcm16' },
  { bitDepth: 24, format: 'wav', formatTag: 1, presetId: 'wav-pcm24' },
  { bitDepth: 32, format: 'wav', formatTag: 1, presetId: 'wav-pcm32' },
  { bitDepth: 32, format: 'wav', formatTag: 3, presetId: 'wav-float32' },
  { bitrate: 128_000, format: 'mp3', presetId: 'mp3-128kbps' },
  { bitrate: 192_000, format: 'mp3', presetId: 'mp3-192kbps' },
  { bitrate: 256_000, format: 'mp3', presetId: 'mp3-256kbps' },
  { bitrate: 320_000, format: 'mp3', presetId: 'mp3-320kbps' },
  { bitDepth: 16, format: 'flac', presetId: 'flac-16bit' },
  { bitDepth: 24, format: 'flac', presetId: 'flac-24bit' },
] as const;

test('runs every advertised output preset in a real Worker', async ({ page }) => {
  await page.goto('/test/browser/');
  const results = await page.evaluate(() => window.runAudioStreamMatrix());

  expect(results.map(({ presetId }) => presetId)).toEqual(
    EXPECTED_OUTPUTS.map(({ presetId }) => presetId),
  );

  for (const expected of EXPECTED_OUTPUTS) {
    const result = results.find(({ presetId }) => presetId === expected.presetId);
    expect(result, `Missing ${expected.presetId} result`).toBeDefined();
    if (result === undefined) {
      continue;
    }

    expect(result.format).toBe(expected.format);
    expect(result.resultFormat).toBe(expected.format);
    expect(result.resultDetailsFormat).toBe(expected.format);
    expect(result.resultPresetId).toBe(expected.presetId);
    expect(result.bytesWritten).toBe(result.finalSize);
    expect(result.bytesWritten).toBeGreaterThan(32);
    expect(result.channels).toBe(2);
    expect(result.closedBeforeResolved).toBe(true);
    expect(result.maxChunkBytes).toBeLessThanOrEqual(64 * 1024);
    expect(result.maxChunkBytes).toBeGreaterThan(0);
    expect(result.sampleRate).toBe(44_100);
    expect(result.writes).toBeGreaterThan(0);
    expectProgress(result.progress);

    if (expected.format === 'wav') {
      expect(result.bitDepth).toBe(expected.bitDepth);
      expect(result.formatTag).toBe(expected.formatTag);
      expect(result.resultRf64).toBe(false);
      expect(result.bitrate).toBeNull();
      expect(result.mp3Frames).toBeNull();
      expect(result.flacTotalSamples).toBeNull();
    } else if (expected.format === 'mp3') {
      expect(
        result.bitrate,
        `MP3 frame bitrates: ${JSON.stringify(result.mp3FrameBitrates)}`,
      ).toBe(expected.bitrate);
      expect(result.bitDepth).toBeNull();
      expect(result.formatTag).toBeNull();
      expect(result.mp3Frames).toBeGreaterThan(1);
      expect(result.mp3FrameBitrates).toHaveLength(result.mp3Frames ?? 0);
      expect(
        result.mp3FrameBitrates?.slice(1).every(
          (bitrate) => bitrate === expected.bitrate,
        ),
      ).toBe(true);
      expect(['Info', 'Xing']).toContain(result.mp3SeekHeader);
      expect(result.mp3SeekHeaderFrames).toBeGreaterThan(0);
      expect(result.resultRf64).toBeNull();
      expect(result.flacTotalSamples).toBeNull();
    } else {
      expect(result.bitDepth).toBe(expected.bitDepth);
      expect(result.flacAudioFrame).toBe(true);
      expect(result.flacTotalSamples).toBeGreaterThan(0);
      expect(result.bitrate).toBeNull();
      expect(result.formatTag).toBeNull();
      expect(result.mp3Frames).toBeNull();
      expect(result.resultRf64).toBeNull();
    }
  }
});

test('encodes the exact MP3 preset-rate matrix and rejects impossible bitrates early', async ({
  page,
}) => {
  await page.goto('/test/browser/');
  const result = await page.evaluate(() => window.runMp3ConstraintMatrix());
  const acceptedMatrix = [
    ['mp3-128kbps', 128_000, [16_000, 22_050, 24_000, 32_000, 44_100, 48_000]],
    ['mp3-192kbps', 192_000, [32_000, 44_100, 48_000]],
    ['mp3-256kbps', 256_000, [32_000, 44_100, 48_000]],
    ['mp3-320kbps', 320_000, [32_000, 44_100, 48_000]],
  ] as const;
  const rejectedSampleRates = [
    8_000,
    11_025,
    12_000,
    16_000,
    22_050,
    24_000,
  ] as const;
  const highBitratePresets = [
    'mp3-192kbps',
    'mp3-256kbps',
    'mp3-320kbps',
  ] as const;
  const expectedRejected = [
    ...[8_000, 11_025, 12_000].map((sampleRate) => ({
      errorCode: 'UNSUPPORTED_OUTPUT',
      presetId: 'mp3-128kbps',
      sampleRate,
    })),
    ...highBitratePresets.flatMap((presetId) =>
      rejectedSampleRates.map((sampleRate) => ({
        errorCode: 'UNSUPPORTED_OUTPUT',
        presetId,
        sampleRate,
      })),
    ),
  ];
  const expectedAccepted = acceptedMatrix.flatMap(
    ([presetId, bitrate, sampleRates]) =>
      sampleRates.map((sampleRate) => ({ bitrate, presetId, sampleRate })),
  );

  expect(
    result.accepted.map(({ bitrate, presetId, sampleRate }) => ({
      bitrate,
      presetId,
      sampleRate,
    })),
  ).toEqual(expectedAccepted);
  for (const [index, encoded] of result.accepted.entries()) {
    const expected = expectedAccepted[index]!;
    expect(encoded.bitrate).toBe(expected.bitrate);
    expect(encoded.sampleRate).toBe(expected.sampleRate);
    expect(encoded.presetId).toBe(expected.presetId);
    expect(encoded.format).toBe('mp3');
    expect(encoded.bytesWritten).toBe(encoded.finalSize);
    expect(encoded.bytesWritten).toBeGreaterThan(32);
    expect(encoded.channels).toBe(2);
    expect(encoded.mp3Frames).toBeGreaterThan(0);
    expect(encoded.writes).toBeGreaterThan(0);
  }
  expect(result.invalid).toHaveLength(21);
  expect(result.invalid).toEqual(expectedRejected);
  expect(
    result.resourcesBeforeAcceptedEncoding.filter(
      (url) => classifyCodecRequest(url) === 'mp3',
    ),
  ).toEqual([]);
});

test('encodes the advertised FLAC Cartesian matrix and rejects invalid targets before loading FLAC', async ({
  page,
}) => {
  await page.goto('/test/browser/');
  const result = await page.evaluate(() => window.runFlacConstraintMatrix());
  const expectedRates = [
    8_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000, 88_200, 96_000,
    176_400, 192_000,
  ];
  expect(result.advertisedSampleRates).toEqual(expectedRates);
  expect(result.accepted).toHaveLength(44);

  const expected = (['flac-16bit', 'flac-24bit'] as const).flatMap(
    (presetId) =>
      expectedRates.flatMap((sampleRate) =>
        [1, 8].map((channels) => ({ channels, presetId, sampleRate })),
      ),
  );
  expect(
    result.accepted.map(({ channels, presetId, sampleRate }) => ({
      channels,
      presetId,
      sampleRate,
    })),
  ).toEqual(expected);
  for (const encoded of result.accepted) {
    expect(encoded.format).toBe('flac');
    expect(encoded.bitDepth).toBe(encoded.presetId === 'flac-16bit' ? 16 : 24);
    expect(encoded.flacAudioFrame).toBe(true);
    expect(encoded.expectedTotalSamples).toBe(1_024);
    expect(encoded.flacTotalSamples).toBe(1_024);
    expect(encoded.bytesWritten).toBe(encoded.finalSize);
    expect(encoded.closedBeforeResolved).toBe(true);
    expect(encoded.writes).toBeGreaterThan(0);
    expectProgress(encoded.progress);
  }
  expect(result.invalid).toEqual(
    (['flac-16bit', 'flac-24bit'] as const).flatMap((presetId) => [
      { channels: 1, errorCode: 'UNSUPPORTED_OUTPUT', presetId, sampleRate: 7_999, writes: 0 },
      { channels: 1, errorCode: 'UNSUPPORTED_OUTPUT', presetId, sampleRate: 384_001, writes: 0 },
      { channels: 1, errorCode: 'UNSUPPORTED_OUTPUT', presetId, sampleRate: 12_345, writes: 0 },
      { channels: 0, errorCode: 'UNSUPPORTED_OUTPUT', presetId, sampleRate: 8_000, writes: 0 },
      { channels: 9, errorCode: 'UNSUPPORTED_OUTPUT', presetId, sampleRate: 8_000, writes: 0 },
    ]),
  );
  expect(
    result.resourcesBeforeAcceptedEncoding.filter(
      (url) => classifyCodecRequest(url) === 'flac',
    ),
  ).toEqual([]);
});

test('encodes WAV preset, rate, and channel boundaries and rejects outside them early', async ({
  page,
}) => {
  await page.goto('/test/browser/');
  const result = await page.evaluate(() => window.runWavConstraintMatrix());
  const presets = [
    { bitDepth: 16, formatTag: 1, presetId: 'wav-pcm16' },
    { bitDepth: 24, formatTag: 1, presetId: 'wav-pcm24' },
    { bitDepth: 32, formatTag: 1, presetId: 'wav-pcm32' },
    { bitDepth: 32, formatTag: 3, presetId: 'wav-float32' },
  ] as const;
  const expected = presets.flatMap(({ presetId }) =>
    [8_000, 384_000].flatMap((sampleRate) =>
      [1, 32].map((channels) => ({ channels, presetId, sampleRate })),
    ),
  );
  expect(result.accepted).toHaveLength(16);
  expect(
    result.accepted.map(({ channels, presetId, sampleRate }) => ({
      channels,
      presetId,
      sampleRate,
    })),
  ).toEqual(expected);
  for (const encoded of result.accepted) {
    const preset = presets.find(({ presetId }) => presetId === encoded.presetId)!;
    expect(encoded.format).toBe('wav');
    expect(encoded.bitDepth).toBe(preset.bitDepth);
    expect(encoded.formatTag).toBe(preset.formatTag);
    expect(encoded.wavRiffBytes).toBe(encoded.finalSize - 8);
    expect(encoded.wavFmtChunks).toBe(1);
    expect(encoded.wavFmtBytes).toBe(16);
    expect(encoded.wavDataChunks).toBe(1);
    expect(encoded.wavBlockAlign).toBe(
      encoded.channels * (preset.bitDepth / 8),
    );
    expect(encoded.wavByteRate).toBe(
      encoded.sampleRate * encoded.channels * (preset.bitDepth / 8),
    );
    expect(encoded.wavFrames).toBe(1_024);
    expect(encoded.wavDataBytes).toBe(
      1_024 * encoded.channels * (preset.bitDepth / 8),
    );
    expect(encoded.wavDataEndsAtFileEnd).toBe(true);
    expect(encoded.finalSize).toBe(44 + (encoded.wavDataBytes ?? 0));
    expect(encoded.bytesWritten).toBe(encoded.finalSize);
    expect(encoded.closedBeforeResolved).toBe(true);
    expect(encoded.writes).toBeGreaterThan(0);
    expectProgress(encoded.progress);
  }
  expect(result.invalid).toEqual(
    presets.flatMap(({ presetId }) => [
      { channels: 1, errorCode: 'UNSUPPORTED_OUTPUT', presetId, sampleRate: 7_999, writes: 0 },
      { channels: 1, errorCode: 'UNSUPPORTED_OUTPUT', presetId, sampleRate: 384_001, writes: 0 },
      { channels: 0, errorCode: 'UNSUPPORTED_OUTPUT', presetId, sampleRate: 8_000, writes: 0 },
      { channels: 33, errorCode: 'UNSUPPORTED_OUTPUT', presetId, sampleRate: 8_000, writes: 0 },
    ]),
  );
});

test('enforces the cumulative FLAC probe budget without blocking adequate probe and transcode', async ({
  browserName,
  page,
}) => {
  await page.goto('/test/browser/');
  const result = await page.evaluate(() => window.runFlacProbeBudgetRegression());

  expect(result.fixtureBytes).toBeGreaterThan(result.lowBudgetBytes);
  if (browserName === 'webkit') {
    expect(result).toEqual(
      expect.objectContaining({
        adequateStatus: 'recognized-unsupported',
        lowBudgetErrorCode: 'RESOURCE_LIMIT_EXCEEDED',
        lowBudgetStatus: null,
        transcodeBytesWritten: 0,
        transcodeClosed: false,
        transcodeErrorCode: 'UNSUPPORTED_INPUT',
        transcodeFormat: null,
        transcodeWrites: 0,
      }),
    );
  } else {
    expect(result).toEqual(
      expect.objectContaining({
        adequateStatus: 'supported',
        lowBudgetErrorCode: 'RESOURCE_LIMIT_EXCEEDED',
        lowBudgetStatus: null,
        transcodeClosed: true,
        transcodeErrorCode: null,
        transcodeFormat: 'wav',
      }),
    );
    expect(result.transcodeBytesWritten).toBeGreaterThan(44);
    expect(result.transcodeWrites).toBeGreaterThan(0);
  }
});

test('probes output support in a real Worker without creating output artifacts', async ({
  page,
}) => {
  await page.goto('/test/browser/');
  const result = await page.evaluate(() => window.runOutputSupportProbe());
  const codecAssets = (resources: readonly string[]) =>
    [
      ...new Set(
        resources.map(classifyCodecRequest).filter(isCodecName),
      ),
    ].sort();

  expect(result.invalidMp3).toEqual({
    code: 'UNSUPPORTED_OUTPUT',
    status: 'unsupported-configuration',
  });
  expect(result.wav).toEqual({ code: 'SUPPORTED', status: 'supported' });
  expect(result.mp3).toEqual({ code: 'SUPPORTED', status: 'supported' });
  expect(result.flac).toEqual({ code: 'SUPPORTED', status: 'supported' });
  expect(codecAssets(result.resourcesAfterInvalidMp3)).toEqual([]);
  expect(codecAssets(result.resourcesAfterWav)).toEqual([]);
  expect(codecAssets(result.resourcesAfterMp3)).toEqual(['mp3']);
  expect(codecAssets(result.resourcesAfterFlac)).toEqual(['flac', 'mp3']);
  expect(result.outputArtifactsCreated).toBe(0);
  expect(result.disposed).toBe(true);
});

for (const scenario of [
  { expectedAssets: [] as const, format: 'wav', presetId: 'wav-pcm16' },
  { expectedAssets: ['mp3'] as const, format: 'mp3', presetId: 'mp3-128kbps' },
  { expectedAssets: ['flac'] as const, format: 'flac', presetId: 'flac-16bit' },
] as const) {
  test(`${scenario.presetId} loads only its required encoder assets`, async ({
    context,
    page,
  }) => {
    const requests = observeRequests(context);
    await page.goto('/test/browser/');
    const result = await page.evaluate(
      (presetId) => window.runSingleOutputPreset(presetId),
      scenario.presetId,
    );
    const observedResources = [...requests, ...result.workerResources];
    const codecAssets = [
      ...new Set(
        observedResources.map(classifyCodecRequest).filter(isCodecName),
      ),
    ].sort();

    expect(result.format).toBe(scenario.format);
    expect(
      codecAssets,
      `Observed resources:\n${observedResources.join('\n')}`,
    ).toEqual([...scenario.expectedAssets].sort());
  });
}

test('probes concrete input files without overstating static capabilities', async ({
  page,
}) => {
  await page.goto('/test/browser/');
  const result = await page.evaluate(() => window.runInputProbeMatrix());
  const advertised = new Map(result.advertised.map((entry) => [entry.id, entry]));

  expect(
    result.advertised
      .filter(({ path }) => path === 'built-in-pcm')
      .map(({ id }) => id),
  ).toEqual(['caf-lpcm', 'aiff-pcm', 'aifc-pcm']);
  for (const id of ['wave', 'mp3', 'flac']) {
    expect(advertised.get(id)?.path).toBe('runtime-probed');
  }

  const fixtures = new Map(result.fixtures.map((fixture) => [fixture.fixture, fixture]));
  for (const [name, capabilityId, container] of [
    ['caf', 'caf-lpcm', 'CAF'],
    ['aiff', 'aiff-pcm', 'AIFF'],
  ] as const) {
    const fixture = fixtures.get(name);
    expect(fixture).toEqual(
      expect.objectContaining({
        capabilityId,
        capabilityPath: 'built-in-pcm',
        container,
        decodeSupport: 'built-in',
        errorCode: null,
        probeStatus: 'supported',
        transcodeSucceeded: true,
      }),
    );
  }

  for (const name of ['wav', 'mp3', 'flac'] as const) {
    const fixture = fixtures.get(name);
    expect(fixture?.capabilityPath).toBe('runtime-probed');
    expect(fixture?.capabilityId).toBe(name === 'wav' ? 'wave' : name);
    expect(
      fixture?.transcodeSucceeded,
      `Probe/transcode disagreement for ${name}: ${JSON.stringify(fixture)}`,
    ).toBe(fixture?.probeStatus === 'supported');
    if (fixture?.probeStatus === 'supported') {
      expect(fixture.errorCode).toBeNull();
      expect(fixture.container).not.toBeNull();
    } else {
      expect(fixture?.errorCode).toBe('UNSUPPORTED_INPUT');
    }
  }

  expect(fixtures.get('unknown')).toEqual(
    expect.objectContaining({
      capabilityId: null,
      capabilityPath: null,
      container: null,
      decodeSupport: null,
      errorCode: 'UNSUPPORTED_INPUT',
      probeStatus: 'unsupported',
      transcodeSucceeded: false,
    }),
  );
});

test('uses an OPFS or bounded-memory output session and cleans it up', async ({
  page,
}) => {
  await page.goto('/test/browser/');
  const result = await page.evaluate(() => window.runOutputSessionSmoke());

  expect(['memory', 'opfs']).toContain(result.storage);
  expect(result.pendingStorage).toBe(result.storage);
  expect(result.artifactStorage).toBe(result.storage);
  expect(result.bytesWritten).toBe(result.artifactSize);
  expect(result.bytesWritten).toBeGreaterThan(44);
  expect(result.bitDepth).toBe(24);
  expect(result.channels).toBe(1);
  expect(result.sampleRate).toBe(44_100);
  expect(result.name).toBe('session-output.wav');
  expect(result.mimeType).toBe('audio/wav');
  expect(result.createAfterDisposeCode).toBe('INVALID_CONFIGURATION');
  expect(result.namespaceEntriesAfterDispose).toBe(
    result.storage === 'opfs' ? 0 : null,
  );
});

test('keeps a long conversion within configured chunk bounds', async ({ page }) => {
  await page.goto('/test/browser/');
  const result = await page.evaluate(() => window.runBoundedStreamStress());

  expect(result.bytesWritten).toBeGreaterThan(5 * 1024 * 1024);
  expect(result.closed).toBe(true);
  expect(result.maxChunkBytes).toBeLessThanOrEqual(64 * 1024);
  expect(result.progressEvents).toBeGreaterThan(2);
  expect(result.progressEvents).toBeLessThanOrEqual(1_002);
  expect(result.writes).toBeGreaterThan(1);
});

test('awaits disposal before checking an aborted OPFS transaction', async ({
  page,
}) => {
  await page.goto('/test/browser/');
  const opfs = await page.evaluate(async () => {
    try {
      if (navigator.storage.getDirectory === undefined) {
        return { available: false, reason: 'getDirectory is undefined' };
      }
      await navigator.storage.getDirectory();
      return { available: true, reason: '' };
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });
  test.skip(!opfs.available, `OPFS unavailable: ${opfs.reason}`);

  await expect(page.evaluate(() => window.runOpfsAbortSmoke())).resolves.toEqual({
    code: 'OPERATION_ABORTED',
    originalPreserved: true,
    size: 4,
  });
});

function expectProgress(progress: readonly number[]): void {
  expect(progress.length).toBeGreaterThanOrEqual(2);
  expect(progress[0]).toBe(0);
  expect(progress.at(-1)).toBe(1);
  expect(progress).toEqual([...progress].sort((left, right) => left - right));
  for (const value of progress) {
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(1);
    expect(value).toBe(Math.round(value * 1_000) / 1_000);
  }
}

function observeRequests(context: BrowserContext): string[] {
  const requests: string[] = [];
  context.on('request', (request) =>
    requests.push(decodeURIComponent(request.url())),
  );
  return requests;
}

function classifyCodecRequest(url: string): 'flac' | 'mp3' | null {
  const normalized = url.toLowerCase();
  if (normalized.includes('mediabunny') && normalized.includes('flac-encoder')) {
    return 'flac';
  }
  if (normalized.includes('mediabunny') && normalized.includes('mp3-encoder')) {
    return 'mp3';
  }
  return null;
}

function isCodecName(value: 'flac' | 'mp3' | null): value is 'flac' | 'mp3' {
  return value !== null;
}
