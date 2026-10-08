import { describe, it, expect } from 'vitest';
import {
  evaluateShadowEligibility,
  computeShadowSampling,
  type ShadowEligibilityInput,
  type ShadowExperimentConfig,
  type ShadowSamplingInput,
} from '../src/shadow-routing.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const SECRET = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04]);

function makeExperiment(overrides: Partial<ShadowExperimentConfig> = {}): ShadowExperimentConfig {
  return {
    id: 'exp-001',
    team_id: 'team-alpha',
    name: 'Test experiment',
    enabled: true,
    source_provider: 'openai',
    source_model: 'gpt-4.1',
    candidate_provider: 'anthropic',
    candidate_model: 'claude-sonnet-4-5',
    sample_rate_ppm: 500_000,
    sampling_version: 'v1',
    shadow_sampling_key_version: 'key-2026-07',
    starts_at: null,
    ends_at: null,
    max_samples: 1000,
    deadline_ms: 30_000,
    max_concurrency: 2,
    max_queue_count: 100,
    max_queue_bytes: 10_485_760,
    max_payload_bytes: 1_048_576,
    funding_mode: 'platform_funded',
    per_run_cap_microcents: 50_000_000,
    aggregate_cap_microcents: 5_000_000_000,
    verifier_version: 'v1',
    gate_fingerprint: 'sha256:abc123',
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    consent_provider_ack: true,
    consent_region_ack: true,
    consent_privacy_ack: true,
    approved_by: 'admin@example.test',
    approved_at: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

function makeEligibilityInput(overrides: Partial<ShadowEligibilityInput> = {}): ShadowEligibilityInput {
  return {
    experiment: makeExperiment(),
    team_id: 'team-alpha',
    request_opted_out: false,
    api_key_opted_out: false,
    is_streaming: false,
    is_cache_hit: false,
    has_plugins: false,
    has_tools: false,
    has_multimodal: false,
    served_provider: 'openai',
    served_model: 'gpt-4.1',
    key_allowed_models: null,
    candidate_key_present: true,
    candidate_pricing_known: true,
    current_time: '2026-07-15T12:00:00Z',
    payload_bytes: 4096,
    ...overrides,
  };
}

function makeSamplingInput(overrides: Partial<ShadowSamplingInput> = {}): ShadowSamplingInput {
  return {
    hmac_secret: SECRET,
    sampling_version: 'v1',
    experiment_id: 'exp-001',
    team_id: 'team-alpha',
    request_id: 'req-00000000-0000-4000-8000-000000000001',
    sample_rate_ppm: 500_000,
    ...overrides,
  };
}

// ─── Eligibility matrix ─────────────────────────────────────────────────────

describe('evaluateShadowEligibility', () => {
  it('passes all gates when every condition is met', () => {
    const result = evaluateShadowEligibility(makeEligibilityInput());
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('shadow_not_sampled');
    expect(result.experiment_id).toBe('exp-001');
  });

  // Table-driven: one row per gate, each failing exactly one condition.
  const cases: Array<{ name: string; overrides: Partial<ShadowEligibilityInput>; reason: string }> = [
    { name: 'no experiment', overrides: { experiment: null }, reason: 'shadow_no_active_experiment' },
    { name: 'experiment belongs to another team', overrides: { team_id: 'team-beta' }, reason: 'shadow_team_mismatch' },
    { name: 'disabled experiment', overrides: { experiment: makeExperiment({ enabled: false }) }, reason: 'shadow_disabled' },
    { name: 'request opted out', overrides: { request_opted_out: true }, reason: 'shadow_request_opted_out' },
    { name: 'api key opted out', overrides: { api_key_opted_out: true }, reason: 'shadow_api_key_opted_out' },
    { name: 'not started', overrides: { experiment: makeExperiment({ starts_at: '2026-08-01T00:00:00Z' }) }, reason: 'shadow_experiment_not_started' },
    { name: 'expired', overrides: { experiment: makeExperiment({ ends_at: '2026-07-01T00:00:00Z' }) }, reason: 'shadow_experiment_expired' },
    { name: 'missing consent', overrides: { experiment: makeExperiment({ consent_privacy_ack: false }) }, reason: 'shadow_consent_missing' },
    { name: 'source mismatch', overrides: { served_model: 'gpt-4.1-mini' }, reason: 'shadow_source_mismatch' },
    { name: 'streaming', overrides: { is_streaming: true }, reason: 'shadow_streaming_unsupported_v1' },
    { name: 'cache hit', overrides: { is_cache_hit: true }, reason: 'shadow_cache_hit' },
    { name: 'plugins', overrides: { has_plugins: true }, reason: 'shadow_plugins_unsupported_v1' },
    { name: 'tools', overrides: { has_tools: true }, reason: 'shadow_tools_unsupported_v1' },
    { name: 'multimodal', overrides: { has_multimodal: true }, reason: 'shadow_multimodal_unsupported_v1' },
    { name: 'same as primary', overrides: { experiment: makeExperiment({ candidate_provider: 'openai', candidate_model: 'gpt-4.1' }) }, reason: 'shadow_candidate_same_as_primary' },
    { name: 'disallowed by key', overrides: { key_allowed_models: ['gpt-4.1', 'gpt-4.1-mini'] }, reason: 'shadow_candidate_disallowed_by_key' },
    { name: 'candidate key missing', overrides: { candidate_key_present: false }, reason: 'shadow_candidate_key_missing' },
    { name: 'candidate pricing missing', overrides: { candidate_pricing_known: false }, reason: 'shadow_candidate_pricing_missing' },
    { name: 'payload too large', overrides: { payload_bytes: 2_000_000 }, reason: 'shadow_payload_too_large' },
  ];

  it.each(cases)('rejects with $reason when $name', ({ overrides, reason }) => {
    const result = evaluateShadowEligibility(makeEligibilityInput(overrides));
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe(reason);
  });

  // Opt-out precedence: request opt-out wins even when experiment is enabled.
  it('request opt-out overrides team opt-in', () => {
    const result = evaluateShadowEligibility(makeEligibilityInput({
      request_opted_out: true,
      experiment: makeExperiment({ enabled: true }),
    }));
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('shadow_request_opted_out');
  });

  it('api-key opt-out overrides team opt-in', () => {
    const result = evaluateShadowEligibility(makeEligibilityInput({
      api_key_opted_out: true,
      experiment: makeExperiment({ enabled: true }),
    }));
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('shadow_api_key_opted_out');
  });

  // Key allows the candidate model → passes.
  it('passes when key_allowed_models includes the candidate', () => {
    const result = evaluateShadowEligibility(makeEligibilityInput({
      key_allowed_models: ['gpt-4.1', 'claude-sonnet-4-5'],
    }));
    expect(result.eligible).toBe(true);
  });

  // Experiment with no time bounds passes.
  it('passes when starts_at and ends_at are null', () => {
    const result = evaluateShadowEligibility(makeEligibilityInput({
      experiment: makeExperiment({ starts_at: null, ends_at: null }),
    }));
    expect(result.eligible).toBe(true);
  });

  // First-failure ordering: opt-out checked before streaming.
  it('checks opt-out before modality gates', () => {
    const result = evaluateShadowEligibility(makeEligibilityInput({
      request_opted_out: true,
      is_streaming: true,
    }));
    expect(result.reason).toBe('shadow_request_opted_out');
  });

  it('reports a configured-source mismatch before unsupported request modality', () => {
    const result = evaluateShadowEligibility(makeEligibilityInput({
      served_model: 'gpt-4.1-mini',
      is_streaming: true,
    }));
    expect(result.reason).toBe('shadow_source_mismatch');
  });

  it('keeps request opt-out ahead of consent and time-window failures', () => {
    const result = evaluateShadowEligibility(makeEligibilityInput({
      request_opted_out: true,
      experiment: makeExperiment({
        consent_provider_ack: false,
        starts_at: '2026-08-01T00:00:00Z',
      }),
    }));
    expect(result.reason).toBe('shadow_request_opted_out');
  });

  it('compares instants rather than lexical timestamp strings', () => {
    const result = evaluateShadowEligibility(makeEligibilityInput({
      current_time: '2026-07-15T06:00:00-06:00',
      experiment: makeExperiment({ starts_at: '2026-07-15T12:30:00Z' }),
    }));
    expect(result.reason).toBe('shadow_experiment_not_started');
  });

  it.each([
    { approved_by: '   ' },
    { approved_at: 'not-a-timestamp' },
  ])('fails closed when accountable approval is malformed: %j', (approval) => {
    const result = evaluateShadowEligibility(makeEligibilityInput({
      experiment: makeExperiment(approval),
    }));
    expect(result.reason).toBe('shadow_consent_missing');
  });

  it.each([
    'not-a-timestamp',
    '2026-02-30T00:00:00Z',
    '2026-07-15T12:00:00',
  ])('reports a non-canonical current time distinctly from a not-started experiment: %s', (currentTime) => {
    const result = evaluateShadowEligibility(makeEligibilityInput({ current_time: currentTime }));
    expect(result.reason).toBe('shadow_invalid_current_time');
  });

  it('accepts valid Date instances returned by pg for approval and experiment windows', () => {
    const result = evaluateShadowEligibility(makeEligibilityInput({
      experiment: makeExperiment({
        approved_at: new Date('2026-07-01T00:00:00Z'),
        starts_at: new Date('2026-07-01T00:00:00Z'),
        ends_at: new Date('2026-08-01T00:00:00Z'),
      }),
    }));
    expect(result.eligible).toBe(true);
  });

  it('fails closed for invalid Date instances from a malformed DB boundary', () => {
    const invalid = new Date('invalid');
    expect(evaluateShadowEligibility(makeEligibilityInput({
      experiment: makeExperiment({ approved_at: invalid }),
    })).reason).toBe('shadow_consent_missing');
    expect(evaluateShadowEligibility(makeEligibilityInput({
      experiment: makeExperiment({ starts_at: invalid }),
    })).reason).toBe('shadow_experiment_not_started');
    expect(evaluateShadowEligibility(makeEligibilityInput({
      experiment: makeExperiment({ ends_at: invalid }),
    })).reason).toBe('shadow_experiment_expired');
  });

  it.each([
    { approved_at: '2026-02-30T00:00:00Z' },
    { starts_at: '2026-07-01T00:00:00+16:00' },
    { ends_at: '2026-07-01 00:00:00Z' },
  ])('fails closed for non-canonical timestamp strings: %j', (timestamps) => {
    const result = evaluateShadowEligibility(makeEligibilityInput({
      experiment: makeExperiment(timestamps),
    }));
    const expected = 'approved_at' in timestamps
      ? 'shadow_consent_missing'
      : 'starts_at' in timestamps
        ? 'shadow_experiment_not_started'
        : 'shadow_experiment_expired';
    expect(result.reason).toBe(expected);
  });
});

// ─── Deterministic sampling ─────────────────────────────────────────────────

describe('computeShadowSampling', () => {
  it('produces stable buckets for fixed inputs (golden vectors)', () => {
    const vectors = [
      { input: makeSamplingInput({ request_id: 'req-golden-1' }), expected: 548_645 },
      { input: makeSamplingInput({ request_id: 'req-golden-2' }), expected: 322_551 },
      { input: makeSamplingInput({ request_id: 'req-golden-3', team_id: 'team-beta' }), expected: 276_645 },
      { input: makeSamplingInput({ request_id: 'req-golden-4', sampling_version: 'v2' }), expected: 716_151 },
      { input: makeSamplingInput({ request_id: 'req-golden-5', experiment_id: 'exp-002' }), expected: 434_794 },
    ];
    for (const v of vectors) {
      const result = computeShadowSampling(v.input);
      expect(result.bucket).toBe(v.expected);
    }
  });

  // Edge cases.
  it('sample_rate_ppm=0 never samples', () => {
    for (let i = 0; i < 100; i++) {
      const result = computeShadowSampling(makeSamplingInput({
        request_id: `req-zero-${i}`,
        sample_rate_ppm: 0,
      }));
      expect(result.sampled).toBe(false);
    }
  });

  it('sample_rate_ppm=1_000_000 always samples', () => {
    for (let i = 0; i < 100; i++) {
      const result = computeShadowSampling(makeSamplingInput({
        request_id: `req-full-${i}`,
        sample_rate_ppm: 1_000_000,
      }));
      expect(result.sampled).toBe(true);
    }
  });

  it.each([-1, 1_000_001, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'fails closed for invalid sample_rate_ppm=%s',
    (sample_rate_ppm) => {
      expect(computeShadowSampling(makeSamplingInput({ sample_rate_ppm })).sampled).toBe(false);
    },
  );

  // Determinism: different inputs → different buckets.
  it('different request_id produces a different bucket', () => {
    const a = computeShadowSampling(makeSamplingInput({ request_id: 'req-a' }));
    const b = computeShadowSampling(makeSamplingInput({ request_id: 'req-b' }));
    // Not guaranteed to differ for ANY pair, but these specific ones do.
    // If this ever flakes, regenerate the request IDs.
    expect(a.bucket).not.toBe(b.bucket);
  });

  it('different team_id produces a different bucket', () => {
    const a = computeShadowSampling(makeSamplingInput({ team_id: 'team-a' }));
    const b = computeShadowSampling(makeSamplingInput({ team_id: 'team-b' }));
    expect(a.bucket).not.toBe(b.bucket);
  });

  it('different sampling_version produces a different bucket', () => {
    const a = computeShadowSampling(makeSamplingInput({ sampling_version: 'v1' }));
    const b = computeShadowSampling(makeSamplingInput({ sampling_version: 'v2' }));
    expect(a.bucket).not.toBe(b.bucket);
  });

  it('different experiment_id produces a different bucket', () => {
    const a = computeShadowSampling(makeSamplingInput({ experiment_id: 'exp-a' }));
    const b = computeShadowSampling(makeSamplingInput({ experiment_id: 'exp-b' }));
    expect(a.bucket).not.toBe(b.bucket);
  });

  // Empirical distribution: ~50% at 500_000 ppm.
  it('empirical distribution approximates the configured rate', () => {
    const N = 10_000;
    let sampled = 0;
    for (let i = 0; i < N; i++) {
      const result = computeShadowSampling(makeSamplingInput({
        request_id: `req-dist-${i}`,
        sample_rate_ppm: 500_000,
      }));
      if (result.sampled) sampled++;
    }
    const fraction = sampled / N;
    expect(fraction).toBeGreaterThan(0.45);
    expect(fraction).toBeLessThan(0.55);
  });

  // Canonical encoding safety: naive concatenation would collide.
  it('length-prefix encoding prevents concatenation collisions', () => {
    // version="ab", id="c" vs version="a", id="bc" — naive "ab"+"c" === "a"+"bc"
    const a = computeShadowSampling(makeSamplingInput({
      sampling_version: 'ab',
      experiment_id: 'c',
    }));
    const b = computeShadowSampling(makeSamplingInput({
      sampling_version: 'a',
      experiment_id: 'bc',
    }));
    expect(a.bucket).not.toBe(b.bucket);
  });

  // Result carries through the input metadata.
  it('result carries sampling_version, experiment_id, team_id', () => {
    const result = computeShadowSampling(makeSamplingInput({
      sampling_version: 'v42',
      experiment_id: 'exp-xyz',
      team_id: 'team-99',
    }));
    expect(result.sampling_version).toBe('v42');
    expect(result.experiment_id).toBe('exp-xyz');
    expect(result.team_id).toBe('team-99');
    expect(result.sample_rate_ppm).toBe(500_000);
  });
});
