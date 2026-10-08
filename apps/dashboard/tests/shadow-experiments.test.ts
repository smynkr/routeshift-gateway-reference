import { describe, expect, it } from 'vitest';
import {
  MICROCENTS_TO_USD,
  POSTGRES_INTEGER_MAX,
  SAMPLE_RATE_MAX_PPM,
  deriveExperimentStatus,
  extractProxyError,
  formatMicrocentsAsUsd,
  formatSampleRatePercent,
  isValidOptionalTimestamp,
  isValidUsdAmountInput,
  microcentsToUsdInput,
  percentToPpm,
  ppmToPercent,
  usdToMicrocents,
  validateExperimentBounds,
} from '@/lib/shadow-experiments';

describe('deriveExperimentStatus', () => {
  const base = { enabled: false, disabled_reason: null, kill_switch_at: null };

  it('defaults to disabled for a plain created-disabled row', () => {
    expect(deriveExperimentStatus(base)).toBe('disabled');
  });

  it('reports enabled only for rows flagged enabled without lifecycle annotations', () => {
    expect(deriveExperimentStatus({ ...base, enabled: true })).toBe('enabled');
  });

  it('reports quarantined when disabled_reason is set, even if enabled is true', () => {
    expect(deriveExperimentStatus({ ...base, disabled_reason: 'invalid_execution_bound_contract' })).toBe('quarantined');
    expect(deriveExperimentStatus({ ...base, enabled: true, disabled_reason: 'missing_enablement_consent_contract' })).toBe('quarantined');
  });

  it('treats empty or whitespace disabled_reason as unset', () => {
    expect(deriveExperimentStatus({ ...base, disabled_reason: '' })).toBe('disabled');
    expect(deriveExperimentStatus({ ...base, disabled_reason: '   ' })).toBe('disabled');
  });

  it('kills take precedence over quarantine and enablement', () => {
    expect(deriveExperimentStatus({ ...base, kill_switch_at: '2026-08-04T10:00:00Z' })).toBe('killed');
    expect(deriveExperimentStatus({
      ...base,
      enabled: true,
      disabled_reason: 'invalid_execution_bound_contract',
      kill_switch_at: '2026-08-04T10:00:00Z',
    })).toBe('killed');
  });
});

describe('ppm ↔ percent conversion', () => {
  it('converts ppm to percent (50,000 ppm = 5%)', () => {
    expect(ppmToPercent(50_000)).toBe(5);
    expect(ppmToPercent(0)).toBe(0);
    expect(ppmToPercent(SAMPLE_RATE_MAX_PPM)).toBe(100);
    expect(ppmToPercent(12_500)).toBe(1.25);
  });

  it('converts percent to ppm and round-trips', () => {
    expect(percentToPpm(5)).toBe(50_000);
    expect(percentToPpm(0)).toBe(0);
    expect(percentToPpm(100)).toBe(1_000_000);
    expect(percentToPpm(0.0001)).toBe(1);
    expect(percentToPpm(ppmToPercent(123_456))).toBe(123_456);
  });

  it('formats display percentages without float noise or trailing zeros', () => {
    expect(formatSampleRatePercent(50_000)).toBe('5%');
    expect(formatSampleRatePercent(0)).toBe('0%');
    expect(formatSampleRatePercent(1_000_000)).toBe('100%');
    expect(formatSampleRatePercent(12_500)).toBe('1.25%');
    expect(formatSampleRatePercent(1)).toBe('0.0001%');
    expect(formatSampleRatePercent(333_333)).toBe('33.3333%');
  });
});

describe('validateExperimentBounds (mirrors proxy ranges)', () => {
  it('accepts a fully valid bound set', () => {
    expect(validateExperimentBounds({
      sample_rate_ppm: 50_000,
      max_samples: 1_000,
      deadline_ms: 30_000,
      max_concurrency: 2,
      max_queue_count: 100,
      max_queue_bytes: 10_485_760,
      max_payload_bytes: 1_048_576,
      per_run_cap_microcents: 50_000_000,
      aggregate_cap_microcents: 5_000_000_000,
    })).toEqual([]);
  });

  it('validates only present fields (empty input is valid)', () => {
    expect(validateExperimentBounds({})).toEqual([]);
    expect(validateExperimentBounds({ max_samples: -5 })).toHaveLength(1);
  });

  it('accepts sample_rate_ppm at both range edges and rejects outside them', () => {
    expect(validateExperimentBounds({ sample_rate_ppm: 0 })).toEqual([]);
    expect(validateExperimentBounds({ sample_rate_ppm: 1_000_000 })).toEqual([]);
    expect(validateExperimentBounds({ sample_rate_ppm: -1 })).toHaveLength(1);
    expect(validateExperimentBounds({ sample_rate_ppm: 1_000_001 })).toHaveLength(1);
    expect(validateExperimentBounds({ sample_rate_ppm: 0.5 })).toHaveLength(1);
    expect(validateExperimentBounds({ sample_rate_ppm: NaN })).toHaveLength(1);
  });

  it('requires positive-minimum bounds to be >= 1 up to the Postgres INTEGER max', () => {
    for (const field of ['deadline_ms', 'max_concurrency', 'max_payload_bytes'] as const) {
      expect(validateExperimentBounds({ [field]: 1 }), `${field} min`).toEqual([]);
      expect(validateExperimentBounds({ [field]: POSTGRES_INTEGER_MAX }), `${field} max`).toEqual([]);
      expect(validateExperimentBounds({ [field]: 0 }), `${field} below min`).toHaveLength(1);
      expect(validateExperimentBounds({ [field]: POSTGRES_INTEGER_MAX + 1 }), `${field} above max`).toHaveLength(1);
    }
  });

  it('allows zero-minimum bounds up to the Postgres INTEGER max', () => {
    for (const field of ['max_samples', 'max_queue_count', 'max_queue_bytes'] as const) {
      expect(validateExperimentBounds({ [field]: 0 }), `${field} min`).toEqual([]);
      expect(validateExperimentBounds({ [field]: POSTGRES_INTEGER_MAX }), `${field} max`).toEqual([]);
      expect(validateExperimentBounds({ [field]: -1 }), `${field} below min`).toHaveLength(1);
      expect(validateExperimentBounds({ [field]: POSTGRES_INTEGER_MAX + 1 }), `${field} above max`).toHaveLength(1);
    }
  });

  it('accepts microcent caps up to MAX_SAFE_INTEGER and rejects non-safe or negative values', () => {
    for (const field of ['per_run_cap_microcents', 'aggregate_cap_microcents'] as const) {
      expect(validateExperimentBounds({ [field]: 0 }), `${field} min`).toEqual([]);
      expect(validateExperimentBounds({ [field]: Number.MAX_SAFE_INTEGER }), `${field} max`).toEqual([]);
      expect(validateExperimentBounds({ [field]: -1 }), `${field} below min`).toHaveLength(1);
      expect(validateExperimentBounds({ [field]: Number.MAX_SAFE_INTEGER + 1 }), `${field} above max`).toHaveLength(1);
      expect(validateExperimentBounds({ [field]: 1.5 }), `${field} non-integer`).toHaveLength(1);
    }
  });

  it('enforces aggregate >= per_run with the proxy message verbatim', () => {
    const errors = validateExperimentBounds({
      per_run_cap_microcents: 50_000_000,
      aggregate_cap_microcents: 49_999_999,
    });
    expect(errors).toContain('aggregate_cap_microcents must be >= per_run_cap_microcents');
  });

  it('accepts aggregate equal to per_run', () => {
    expect(validateExperimentBounds({
      per_run_cap_microcents: 50_000_000,
      aggregate_cap_microcents: 50_000_000,
    })).toEqual([]);
  });

  it('collects multiple violations instead of stopping at the first', () => {
    const errors = validateExperimentBounds({
      sample_rate_ppm: -1,
      deadline_ms: 0,
      max_samples: -3,
    });
    expect(errors).toHaveLength(3);
  });
});

describe('isValidOptionalTimestamp (mirrors proxy isOptionalTimestamp)', () => {
  it('treats null and undefined as valid (field omitted)', () => {
    expect(isValidOptionalTimestamp(null)).toBe(true);
    expect(isValidOptionalTimestamp(undefined)).toBe(true);
  });

  it('accepts ISO-8601 timestamps with a timezone designator', () => {
    expect(isValidOptionalTimestamp('2026-08-04T10:00:00Z')).toBe(true);
    expect(isValidOptionalTimestamp('2026-08-04T10:00Z')).toBe(true);
    expect(isValidOptionalTimestamp('2026-08-04T10:00:00.123456Z')).toBe(true);
    expect(isValidOptionalTimestamp('2026-08-04T10:00:00+05:30')).toBe(true);
    expect(isValidOptionalTimestamp('2026-08-04T10:00:00-0800')).toBe(true);
  });

  it('rejects timestamps without a timezone', () => {
    expect(isValidOptionalTimestamp('2026-08-04T10:00:00')).toBe(false);
    expect(isValidOptionalTimestamp('2026-08-04')).toBe(false);
  });

  it('rejects impossible calendar dates and times', () => {
    expect(isValidOptionalTimestamp('2026-02-30T10:00:00Z')).toBe(false);
    expect(isValidOptionalTimestamp('2026-13-01T10:00:00Z')).toBe(false);
    expect(isValidOptionalTimestamp('2026-00-10T10:00:00Z')).toBe(false);
    expect(isValidOptionalTimestamp('2026-08-04T25:00:00Z')).toBe(false);
    expect(isValidOptionalTimestamp('2026-08-04T10:60:00Z')).toBe(false);
    expect(isValidOptionalTimestamp('2026-08-04T10:00:61Z')).toBe(false);
  });

  it('rejects out-of-range UTC offsets, non-strings, and garbage', () => {
    expect(isValidOptionalTimestamp('2026-08-04T10:00:00+16:00')).toBe(false);
    expect(isValidOptionalTimestamp('2026-08-04T10:00:00+05:60')).toBe(false);
    expect(isValidOptionalTimestamp(123)).toBe(false);
    expect(isValidOptionalTimestamp('not-a-timestamp')).toBe(false);
    expect(isValidOptionalTimestamp('')).toBe(false);
  });
});

describe('microcent / USD formatting', () => {
  it('expands microcents to exact USD without ever rounding a cap', () => {
    expect(formatMicrocentsAsUsd(0)).toBe('$0.00');
    expect(formatMicrocentsAsUsd(1)).toBe('$0.00000001');
    expect(formatMicrocentsAsUsd(1_500_000)).toBe('$0.015');
    expect(formatMicrocentsAsUsd(12804445717)).toBe('$128.04445717');
    expect(formatMicrocentsAsUsd(200_000_000)).toBe('$2');
    expect(formatMicrocentsAsUsd(123_456_789)).toBe('$1.23456789');
  });

  it('trims trailing zeros but never renders a nonzero amount as $0.00', () => {
    expect(formatMicrocentsAsUsd(50_000_000)).toBe('$0.5');
    expect(formatMicrocentsAsUsd(5_000_000_000)).toBe('$50');
    expect(formatMicrocentsAsUsd(500_000)).toBe('$0.005');
    expect(formatMicrocentsAsUsd(100_000_000)).toBe('$1');
    expect(formatMicrocentsAsUsd(120_000_000)).toBe('$1.2');
    expect(formatMicrocentsAsUsd(99_999_999)).toBe('$0.99999999');
  });

  it('clamps negative input to $0.00 (proxy floors caps at 0)', () => {
    expect(formatMicrocentsAsUsd(-1)).toBe('$0.00');
    expect(formatMicrocentsAsUsd(-1234567)).toBe('$0.00');
  });

  it('converts USD to microcents without float drift', () => {
    expect(usdToMicrocents(0.5)).toBe(50_000_000);
    expect(usdToMicrocents(50)).toBe(5_000_000_000);
    expect(usdToMicrocents(0.1)).toBe(10_000_000);
    expect(usdToMicrocents(0)).toBe(0);
    expect(usdToMicrocents(0.57)).toBe(57_000_000);
  });

  it('converts USD to microcents exactly via BigInt (no ±1 drift near MAX_SAFE_INTEGER)', () => {
    expect(usdToMicrocents(0)).toBe(0);
    expect(usdToMicrocents('0.00000001')).toBe(1);
    expect(usdToMicrocents('0.015')).toBe(1_500_000);
    expect(usdToMicrocents('128.04445717')).toBe(12804445717);
    // MAX_SAFE_INTEGER microcents — the round-2 drift target. Assert EXACT.
    expect(usdToMicrocents('90071992.54740991')).toBe(9007199254740991);
    expect(usdToMicrocents('90071992.54740991')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rejects USD input that overflows the safe-integer microcent range', () => {
    // 9007199254740992 microcents = MAX_SAFE_INTEGER + 1 → not representable.
    expect(usdToMicrocents('90071992.54740992')).toBeNaN();
  });

  it('round-trips through the MICROCENTS_TO_USD constant', () => {
    expect(MICROCENTS_TO_USD).toBe(100_000_000);
    expect(usdToMicrocents(1) / MICROCENTS_TO_USD).toBe(1);
  });
});

describe('microcentsToUsdInput (edit-mode cap prefill)', () => {
  it('expands to a plain decimal string, never scientific notation', () => {
    expect(microcentsToUsdInput(1)).toBe('0.00000001');
    expect(microcentsToUsdInput(0)).toBe('0');
    expect(microcentsToUsdInput(1_500_000)).toBe('0.015');
    expect(microcentsToUsdInput(200_000_000)).toBe('2');
    expect(microcentsToUsdInput(12804445717)).toBe('128.04445717');
  });

  it('always satisfies isValidUsdAmountInput across the stored range', () => {
    for (const value of [0, 1, 500_000, 12804445717, 7778758330654, Number.MAX_SAFE_INTEGER]) {
      const prefilled = microcentsToUsdInput(value);
      expect(isValidUsdAmountInput(prefilled), `prefill for ${value} = "${prefilled}"`).toBe(true);
    }
  });

  it('round-trips exactly through usdToMicrocents, including MAX_SAFE_INTEGER', () => {
    for (const value of [0, 1, 1_500_000, 12804445717, 7778758330654, Number.MAX_SAFE_INTEGER]) {
      expect(usdToMicrocents(microcentsToUsdInput(value)), `round-trip for ${value}`).toBe(value);
    }
  });
});

describe('extractProxyError (shared envelope extraction)', () => {
  it('extracts message and code from the object envelope', () => {
    expect(extractProxyError({ error: { message: 'x', code: 'y' } }, 'fallback')).toEqual({
      message: 'x',
      code: 'y',
    });
  });

  it('extracts a flat-string envelope with a null code', () => {
    expect(extractProxyError({ error: 'msg' }, 'fallback')).toEqual({ message: 'msg', code: null });
  });

  it('preserves the code when the envelope has a code but no usable message', () => {
    expect(extractProxyError({ error: { code: 'only_code' } }, 'fallback')).toEqual({
      message: 'fallback',
      code: 'only_code',
    });
    expect(extractProxyError({ error: { message: '', code: 'x' } }, 'fallback')).toEqual({
      message: 'fallback',
      code: 'x',
    });
  });

  it('falls back with a null code when there is neither message nor code', () => {
    expect(extractProxyError({ error: '' }, 'fallback')).toEqual({ message: 'fallback', code: null });
    expect(extractProxyError({ error: {} }, 'fallback')).toEqual({ message: 'fallback', code: null });
    expect(extractProxyError({}, 'fallback')).toEqual({ message: 'fallback', code: null });
  });

  it('falls back for null and non-object payloads', () => {
    expect(extractProxyError(null, 'fallback')).toEqual({ message: 'fallback', code: null });
    expect(extractProxyError('not-an-object', 'fallback')).toEqual({ message: 'fallback', code: null });
    expect(extractProxyError(42, 'fallback')).toEqual({ message: 'fallback', code: null });
  });
});

describe('isValidUsdAmountInput (raw-string USD validation)', () => {
  it('accepts plain decimals with up to 8 fractional digits', () => {
    expect(isValidUsdAmountInput('0')).toBe(true);
    expect(isValidUsdAmountInput('50')).toBe(true);
    expect(isValidUsdAmountInput('0.5')).toBe(true);
    expect(isValidUsdAmountInput('0.50')).toBe(true);
    expect(isValidUsdAmountInput('128.04445717')).toBe(true);
    expect(isValidUsdAmountInput('0.00000001')).toBe(true);
    expect(isValidUsdAmountInput('123456789.12345678')).toBe(true);
  });

  it('trims surrounding whitespace before validating', () => {
    expect(isValidUsdAmountInput(' 0.5 ')).toBe(true);
    expect(isValidUsdAmountInput('\t12\n')).toBe(true);
  });

  it('rejects more than 8 fractional digits', () => {
    expect(isValidUsdAmountInput('0.000000001')).toBe(false);
    expect(isValidUsdAmountInput('1.123456789')).toBe(false);
  });

  it('rejects exponent, hex, sign, and malformed decimal forms', () => {
    expect(isValidUsdAmountInput('1e2')).toBe(false);
    expect(isValidUsdAmountInput('0x10')).toBe(false);
    expect(isValidUsdAmountInput('-1')).toBe(false);
    expect(isValidUsdAmountInput('+1')).toBe(false);
    expect(isValidUsdAmountInput('.5')).toBe(false);
    expect(isValidUsdAmountInput('5.')).toBe(false);
    expect(isValidUsdAmountInput('abc')).toBe(false);
  });

  it('rejects empty and whitespace-only input', () => {
    expect(isValidUsdAmountInput('')).toBe(false);
    expect(isValidUsdAmountInput('   ')).toBe(false);
  });
});
