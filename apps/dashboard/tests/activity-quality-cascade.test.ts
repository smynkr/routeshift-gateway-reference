import { describe, expect, it } from 'vitest';
import { QUALITY_REASON_CODES } from '@routeshift/shared';
import {
  isQualityReasonCode,
  qualityReasonLabel,
  cascadeAttemptsHeader,
  isQualityCascadeLog,
} from '@/lib/quality-reasons';

describe('quality reason labels', () => {
  it('labels every shared quality reason code (exhaustive, no silent buckets)', () => {
    for (const code of QUALITY_REASON_CODES) {
      const label = qualityReasonLabel(code);
      expect(label, code).toBeTruthy();
      expect(label, code).not.toBe(code);
    }
  });

  it('returns null for unknown, absent, or non-quality codes so raw codes stay displayable', () => {
    expect(qualityReasonLabel('HTTP 503')).toBeNull();
    expect(qualityReasonLabel('provider_timeout: upstream took 30s')).toBeNull();
    expect(qualityReasonLabel('')).toBeNull();
    expect(qualityReasonLabel(null)).toBeNull();
    expect(qualityReasonLabel(undefined)).toBeNull();
  });

  it('recognizes exactly the shared quality reason codes', () => {
    for (const code of QUALITY_REASON_CODES) expect(isQualityReasonCode(code)).toBe(true);
    expect(isQualityReasonCode('HTTP 503')).toBe(false);
    expect(isQualityReasonCode('Circuit breaker open')).toBe(false);
    expect(isQualityReasonCode(null)).toBe(false);
  });

  it('is prototype-safe against inherited object members in logged codes', () => {
    for (const hostile of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(qualityReasonLabel(hostile), hostile).toBeNull();
      expect(isQualityReasonCode(hostile), hostile).toBe(false);
    }
  });
});

describe('cascade attempts header', () => {
  it('keeps the plain fallback header for non-cascade logs', () => {
    expect(
      cascadeAttemptsHeader({
        error_type: null,
        fallback_attempts: [{ provider: 'anthropic', model: 'claude-sonnet-4-5', error: 'HTTP 503' }],
      }),
    ).toBe('Fallback Attempts');
  });

  it('claims the quality header only when every attempt is quality-classified', () => {
    expect(
      cascadeAttemptsHeader({
        error_type: null,
        fallback_attempts: [
          { provider: 'openai', model: 'gpt-5.5-pro', error: 'quality_gate_empty_content' },
          { provider: 'openai', model: 'gpt-5.5-pro', error: 'quality_gate_max_tokens' },
        ],
      }),
    ).toBe('Quality Cascade Attempts');
  });

  it('uses the neutral cascade header when quality and provider failures mix', () => {
    expect(
      cascadeAttemptsHeader({
        error_type: null,
        fallback_attempts: [
          { provider: 'openai', model: 'gpt-5.5-pro', error: 'quality_gate_empty_content' },
          { provider: 'anthropic', model: 'claude-sonnet-4-6', error: 'HTTP 503' },
        ],
      }),
    ).toBe('Cascade Attempts');
    expect(
      cascadeAttemptsHeader({
        error_type: 'quality_gate_exhausted',
        fallback_attempts: [{ provider: 'openai', model: 'gpt-5.5', error: 'Circuit breaker open' }],
      }),
    ).toBe('Cascade Attempts');
  });
});

describe('quality cascade classification', () => {
  it('classifies a log as a quality cascade from its error_type alone', () => {
    expect(
      isQualityCascadeLog({ error_type: 'quality_gate_exhausted', fallback_attempts: [] }),
    ).toBe(true);
    expect(
      isQualityCascadeLog({ error_type: 'quality_gate_billing_ack_required', fallback_attempts: [] }),
    ).toBe(true);
  });

  it('classifies a log as a quality cascade when any attempt carries a quality code', () => {
    expect(
      isQualityCascadeLog({
        error_type: null,
        fallback_attempts: [
          { provider: 'openai', model: 'gpt-5.5-pro', error: 'quality_gate_empty_content' },
          { provider: 'anthropic', model: 'claude-sonnet-4-6', error: 'HTTP 503' },
        ],
      }),
    ).toBe(true);
  });

  it('keeps plain fallback logs out of the cascade bucket', () => {
    expect(
      isQualityCascadeLog({
        error_type: null,
        fallback_attempts: [
          { provider: 'anthropic', model: 'claude-sonnet-4-5', error: 'provider_timeout: upstream took 30s' },
        ],
      }),
    ).toBe(false);
    expect(isQualityCascadeLog({ error_type: 'rate_limit_error', fallback_attempts: [] })).toBe(false);
  });
});
