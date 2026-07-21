import type { AudioInspection } from '../engine/contracts.js';
import type {
  AudioStreamOutputProbeTarget,
  AudioStreamTarget,
} from './contracts.js';
import {
  AUDIO_TRANSCODER_STREAM_CAPABILITIES,
  type AudioStreamOutputFormatDescriptor,
  type AudioStreamOutputPresetDescriptor,
  type AudioStreamOutputSampleRateConstraints,
  type AudioTranscoderStreamCapabilities,
} from './capabilities.js';

export const AUDIO_STREAM_SOURCE_SAMPLE_RATE = 'source' as const;

export type AudioStreamSampleRateSelection =
  | typeof AUDIO_STREAM_SOURCE_SAMPLE_RATE
  | number;

export type AudioStreamOutputParameterId =
  | 'bit-depth'
  | 'bitrate-bps'
  | 'codec'
  | 'sample-format';

export type AudioStreamOutputParameterValue = number | string;

export interface AudioStreamOutputParameterSelection {
  readonly bitDepth?: number;
  readonly bitrateBps?: number;
  readonly codec?: string;
  readonly sampleFormat?: 'float' | 'integer' | 'lossy';
}

export interface AudioStreamOutputEncodingOption {
  readonly bitDepth: number | null;
  readonly bitrateBps: number | null;
  readonly codec: string;
  readonly kind: 'lossless' | 'lossy';
  readonly presetId: string;
  readonly sampleFormat: 'float' | 'integer' | 'lossy';
}

export interface AudioStreamOutputParameterOption {
  readonly presetIds: readonly string[];
  readonly value: AudioStreamOutputParameterValue;
}

export interface AudioStreamOutputParameterDescriptor {
  readonly id: AudioStreamOutputParameterId;
  readonly options: readonly AudioStreamOutputParameterOption[];
}

export interface AudioStreamFormatTargetSelection {
  readonly formatId: string;
  readonly parameters?: AudioStreamOutputParameterSelection;
  readonly presetId?: string;
  readonly sampleRate?: AudioStreamSampleRateSelection;
}

export type AudioStreamFormatTargetResolutionErrorReason =
  | 'channels'
  | 'format'
  | 'parameters'
  | 'preset'
  | 'sample-rate'
  | 'source-inspection';

export interface AudioStreamFormatTargetResolutionError {
  readonly message: string;
  readonly reason: AudioStreamFormatTargetResolutionErrorReason;
  readonly status: 'unsupported';
}

export interface AudioStreamResolvedFormatTarget {
  readonly format: AudioStreamOutputFormatDescriptor;
  readonly preset: AudioStreamOutputPresetDescriptor;
  readonly probeTarget: AudioStreamOutputProbeTarget;
  readonly status: 'resolved';
  readonly target: AudioStreamTarget;
}

export type AudioStreamFormatTargetResolution =
  | AudioStreamFormatTargetResolutionError
  | AudioStreamResolvedFormatTarget;

const PARAMETER_ORDER = Object.freeze([
  'codec',
  'sample-format',
  'bit-depth',
  'bitrate-bps',
] as const satisfies readonly AudioStreamOutputParameterId[]);

/** Returns stable semantic encoding values for every installed preset. */
export function getAudioStreamOutputEncodingOptions(
  formatId: string,
  capabilities: AudioTranscoderStreamCapabilities =
    AUDIO_TRANSCODER_STREAM_CAPABILITIES,
): readonly AudioStreamOutputEncodingOption[] {
  const format = findFormat(formatId, capabilities);
  if (format === undefined) {
    return Object.freeze([]);
  }
  return Object.freeze(format.presets.map(toEncodingOption));
}

/**
 * Describes only parameters that vary within a format. Options are filtered by
 * the other partial selections, so invalid combinations never need to be
 * duplicated in a consumer.
 */
export function getAudioStreamOutputParameters(
  formatId: string,
  selection: AudioStreamOutputParameterSelection = {},
  capabilities: AudioTranscoderStreamCapabilities =
    AUDIO_TRANSCODER_STREAM_CAPABILITIES,
): readonly AudioStreamOutputParameterDescriptor[] {
  const allOptions = getAudioStreamOutputEncodingOptions(formatId, capabilities);
  return Object.freeze(
    PARAMETER_ORDER.flatMap((id) => {
      const allValues = uniqueParameterValues(allOptions, id);
      if (allValues.length <= 1) {
        return [];
      }
      const candidates = allOptions.filter((option) =>
        matchesSelection(option, selection, id),
      );
      const options = uniqueParameterValues(candidates, id).map((value) =>
        Object.freeze({
          presetIds: Object.freeze(
            candidates
              .filter((candidate) => parameterValue(candidate, id) === value)
              .map(({ presetId }) => presetId),
          ),
          value,
        }),
      );
      return [Object.freeze({ id, options: Object.freeze(options) })];
    }),
  );
}

/**
 * Resolves a semantic format selection against one inspected source. Source
 * channel layout and sample rate are preserved unless an explicit rate is
 * selected. The exact target still requires a runtime output probe.
 */
export function resolveAudioStreamFormatTarget(
  selection: AudioStreamFormatTargetSelection,
  inspection: AudioInspection,
  capabilities: AudioTranscoderStreamCapabilities =
    AUDIO_TRANSCODER_STREAM_CAPABILITIES,
): AudioStreamFormatTargetResolution {
  const format = findFormat(selection.formatId, capabilities);
  if (format === undefined) {
    return unsupported('format', `Output format "${selection.formatId}" is not installed.`);
  }

  const preset = resolvePreset(format, selection);
  if ('reason' in preset) {
    return preset;
  }

  if (inspection.channels === null || inspection.sampleRate === null) {
    return unsupported(
      'source-inspection',
      'The source channel count and sample rate must be known.',
    );
  }
  if (
    !Number.isSafeInteger(inspection.sampleRate) ||
    inspection.sampleRate <= 0
  ) {
    return unsupported(
      'source-inspection',
      'The source sample rate must be a positive integer.',
    );
  }

  const channels = inspection.channels;
  if (
    !Number.isSafeInteger(channels) ||
    channels < capabilities.limits.channels.minimum ||
    channels > capabilities.limits.channels.maximum ||
    channels < preset.target.channels.minimum ||
    channels > preset.target.channels.maximum
  ) {
    return unsupported(
      'channels',
      `Preset "${preset.preset.id}" does not support ${channels} source channels.`,
    );
  }

  const sampleRateSelection =
    selection.sampleRate ?? AUDIO_STREAM_SOURCE_SAMPLE_RATE;
  const sampleRate =
    sampleRateSelection === AUDIO_STREAM_SOURCE_SAMPLE_RATE
      ? inspection.sampleRate
      : sampleRateSelection;
  if (
    !Number.isSafeInteger(sampleRate) ||
    sampleRate <= 0 ||
    !supportsSampleRate(preset.target.sampleRate, sampleRate) ||
    !supportsSampleRatePath(
      capabilities,
      inspection.sampleRate,
      sampleRate,
    )
  ) {
    return unsupported(
      'sample-rate',
      `Preset "${preset.preset.id}" does not support ${sampleRate} Hz for this source.`,
    );
  }

  const probeTarget = Object.freeze({
    channels,
    presetId: preset.preset.id,
    sampleRate,
  }) as AudioStreamOutputProbeTarget;
  const target = Object.freeze({
    presetId: preset.preset.id,
    ...(sampleRateSelection === AUDIO_STREAM_SOURCE_SAMPLE_RATE
      ? {}
      : { sampleRate }),
  }) as AudioStreamTarget;

  return Object.freeze({
    format,
    preset,
    probeTarget,
    status: 'resolved' as const,
    target,
  });
}

function findFormat(
  formatId: string,
  capabilities: AudioTranscoderStreamCapabilities,
): AudioStreamOutputFormatDescriptor | undefined {
  return capabilities.outputFormats.find(({ id }) => id === formatId);
}

function resolvePreset(
  format: AudioStreamOutputFormatDescriptor,
  selection: AudioStreamFormatTargetSelection,
): AudioStreamOutputPresetDescriptor | AudioStreamFormatTargetResolutionError {
  if (selection.presetId !== undefined) {
    const preset = format.presets.find(
      ({ preset: candidate }) => candidate.id === selection.presetId,
    );
    if (preset === undefined) {
      return unsupported(
        'preset',
        `Preset "${selection.presetId}" is not installed for format "${format.id}".`,
      );
    }
    if (!matchesSelection(toEncodingOption(preset), selection.parameters ?? {})) {
      return unsupported(
        'parameters',
        `Preset "${selection.presetId}" does not match the selected encoding parameters.`,
      );
    }
    return preset;
  }

  const candidates = format.presets.filter((candidate) =>
    matchesSelection(toEncodingOption(candidate), selection.parameters ?? {}),
  );
  if (candidates.length !== 1) {
    return unsupported(
      'parameters',
      candidates.length === 0
        ? `No preset for format "${format.id}" matches the selected encoding parameters.`
        : `The encoding parameters for format "${format.id}" do not select one exact preset.`,
    );
  }
  return candidates[0]!;
}

function toEncodingOption(
  descriptor: AudioStreamOutputPresetDescriptor,
): Readonly<AudioStreamOutputEncodingOption> {
  return Object.freeze({
    bitDepth: descriptor.kind === 'lossless' ? descriptor.bitDepth : null,
    bitrateBps: descriptor.kind === 'lossy' ? descriptor.bitrate : null,
    codec: descriptor.codec.startsWith('pcm-') ? 'pcm' : descriptor.codec,
    kind: descriptor.kind,
    presetId: descriptor.preset.id,
    sampleFormat: descriptor.preset.sampleFormat,
  });
}

function matchesSelection(
  option: AudioStreamOutputEncodingOption,
  selection: AudioStreamOutputParameterSelection,
  ignored?: AudioStreamOutputParameterId,
): boolean {
  return (
    (ignored === 'bit-depth' ||
      selection.bitDepth === undefined ||
      option.bitDepth === selection.bitDepth) &&
    (ignored === 'bitrate-bps' ||
      selection.bitrateBps === undefined ||
      option.bitrateBps === selection.bitrateBps) &&
    (ignored === 'codec' ||
      selection.codec === undefined ||
      option.codec === selection.codec) &&
    (ignored === 'sample-format' ||
      selection.sampleFormat === undefined ||
      option.sampleFormat === selection.sampleFormat)
  );
}

function uniqueParameterValues(
  options: readonly AudioStreamOutputEncodingOption[],
  id: AudioStreamOutputParameterId,
): readonly AudioStreamOutputParameterValue[] {
  const values = new Set<AudioStreamOutputParameterValue>();
  for (const option of options) {
    const value = parameterValue(option, id);
    if (value !== null) {
      values.add(value);
    }
  }
  return Object.freeze([...values]);
}

function parameterValue(
  option: AudioStreamOutputEncodingOption,
  id: AudioStreamOutputParameterId,
): AudioStreamOutputParameterValue | null {
  switch (id) {
    case 'bit-depth':
      return option.bitDepth;
    case 'bitrate-bps':
      return option.bitrateBps;
    case 'codec':
      return option.codec;
    case 'sample-format':
      return option.sampleFormat;
  }
}

function supportsSampleRate(
  constraint: AudioStreamOutputSampleRateConstraints,
  sampleRate: number,
): boolean {
  return constraint.kind === 'range'
    ? sampleRate >= constraint.minimum && sampleRate <= constraint.maximum
    : constraint.values.includes(sampleRate);
}

function supportsSampleRatePath(
  capabilities: AudioTranscoderStreamCapabilities,
  sourceSampleRate: number,
  targetSampleRate: number,
): boolean {
  const constraint =
    sourceSampleRate === targetSampleRate
      ? capabilities.limits.sampleRate.passThrough
      : capabilities.limits.sampleRate.resampling;
  return (
    sourceSampleRate >= constraint.minimum &&
    sourceSampleRate <= constraint.maximum &&
    targetSampleRate >= constraint.minimum &&
    targetSampleRate <= constraint.maximum
  );
}

function unsupported(
  reason: AudioStreamFormatTargetResolutionErrorReason,
  message: string,
): Readonly<AudioStreamFormatTargetResolutionError> {
  return Object.freeze({ message, reason, status: 'unsupported' as const });
}
