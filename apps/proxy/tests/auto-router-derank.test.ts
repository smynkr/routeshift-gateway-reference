/**
 * RSH-136 quality-derank pins. Synthetic registry via vi.mock (same pattern
 * as auto-router-capability): three equal-priced models (20) plus google at
 * 10x cheaper (2), one of which has a deranking verdict history.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@routeshift/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@routeshift/shared')>();
  return {
    ...actual,
    MODEL_REGISTRY: [
      {
        provider: 'openai',
        canonical_name: 'reliable-a',
        api_model_id: 'reliable-a',
        context_window: 200_000,
        intelligence_tier: 3,
      },
      {
        provider: 'anthropic',
        canonical_name: 'deranked-b',
        api_model_id: 'deranked-b',
        context_window: 200_000,
        intelligence_tier: 3,
      },
      {
        provider: 'google',
        canonical_name: 'cheap-c',
        api_model_id: 'cheap-c',
        context_window: 200_000,
        intelligence_tier: 3,
      },
    ],
    getModelPricing: (provider: string) =>
      provider === 'google'
        ? { provider, model: 'cheap-c', input_per_million: 0.5, output_per_million: 1.5 } // 10x cheaper
        : { provider, model: 'x', input_per_million: 5, output_per_million: 15 },
  };
});

import { buildAutoRouteDecision } from '../src/routing/auto-router.js';
import type { AutoRouteProviderSignal } from '../src/routing/auto-router.js';

const SIGNALS: AutoRouteProviderSignal[] = [
  { provider: 'openai', credential_available: true, latency_p95_ms: 100, latency_sample_count: 50 },
  { provider: 'anthropic', credential_available: true, latency_p95_ms: 100, latency_sample_count: 50 },
  { provider: 'google', credential_available: true, latency_p95_ms: 100, latency_sample_count: 50 },
];

/** Equal-priced candidates only (no google): ordering effects are provable. */
function decideEqualPrice(overrides: Record<string, unknown> = {}) {
  return buildAutoRouteDecision(
    {
      model_requested: 'auto',
      provider_requested: null,
      tags: [],
      estimated_input_tokens: 1000,
      ...overrides,
    },
    { enabled: true, strategy: 'balanced', max_fallbacks: 2, quality_derank: true },
    {
      providerSignals: SIGNALS.filter((s) => s.provider !== 'google'),
      ...overrides,
    },
  );
}

describe('quality derank (RSH-136)', () => {
  it('deranks a below-threshold provider:model: at equal price the healthy model wins', () => {
    const decision = decideEqualPrice({
      qualitySignals: [
        { provider: 'anthropic', model: 'deranked-b', verified: 5, rejected: 15 }, // pass rate 0.25 → floor
      ],
    });
    expect(decision.model).toBe('reliable-a');
    // explainability: which verdicts moved the provider
    const derank = decision.auto_route?.quality_derank;
    expect(derank).toBeDefined();
    expect(derank![0]).toMatchObject({ provider: 'anthropic', model: 'deranked-b', sample_count: 20 });
    expect(derank![0].pass_rate).toBeCloseTo(0.25, 10);
  });

  it('insufficient data is NOT a verdict: under-sampled models are not deranked', () => {
    const decision = decideEqualPrice({
      qualitySignals: [
        { provider: 'anthropic', model: 'deranked-b', verified: 5, rejected: 5 }, // 10 samples, 0.5 → deranked!
        { provider: 'openai', model: 'reliable-a', verified: 4, rejected: 4 }, // 8 samples → no signal
      ],
    });
    const derank = decision.auto_route?.quality_derank ?? [];
    const models = derank.map((d) => d.model);
    expect(models).toContain('deranked-b');
    expect(models).not.toContain('reliable-a');
    expect(decision.model).toBe('reliable-a');
  });

  it('a healthy pass rate records no derank at all', () => {
    const decision = decideEqualPrice({
      qualitySignals: [
        { provider: 'anthropic', model: 'deranked-b', verified: 18, rejected: 2 }, // 0.9 → healthy
      ],
    });
    expect(decision.auto_route?.quality_derank).toBeUndefined();
    // at equal price with equal scores the stable sort keeps registry order
    expect(decision.model).toBe('reliable-a');
  });

  it('keys signals by provider:model — same model under two providers cannot cross-contaminate', () => {
    // cheap-c (google) is NOT the same model as a hypothetical openai cheap-c
    const decision = buildAutoRouteDecision(
      { model_requested: 'auto', provider_requested: null, tags: [], estimated_input_tokens: 1000 },
      { enabled: true, strategy: 'balanced', max_fallbacks: 2, quality_derank: true },
      {
        providerSignals: SIGNALS,
        qualitySignals: [
          // a DIFFERENT provider's verdicts for the same model string must not
          // leak onto google's candidate
          { provider: 'anthropic', model: 'cheap-c', verified: 0, rejected: 20 },
        ],
      },
    );
    expect(decision.auto_route?.quality_derank).toBeUndefined();
  });

  it('price still dominates: a 10x cheaper model wins even when everything else is deranked', () => {
    const decision = buildAutoRouteDecision(
      { model_requested: 'auto', provider_requested: null, tags: [], estimated_input_tokens: 1000 },
      { enabled: true, strategy: 'balanced', max_fallbacks: 2, quality_derank: true },
      {
        providerSignals: SIGNALS,
        qualitySignals: [
          // floor penalty (0.3 → ~3.33x price-equivalent) on BOTH 20-price
          // models cannot overcome cheap-c's 10x price advantage
          { provider: 'openai', model: 'reliable-a', verified: 1, rejected: 19 },
          { provider: 'anthropic', model: 'deranked-b', verified: 1, rejected: 19 },
        ],
      },
    );
    expect(decision.model).toBe('cheap-c');
    expect(decision.auto_route?.quality_derank?.length).toBe(2);
  });

  it('records no derank metadata when the weighted score does not decide (fastest, measured)', () => {
    const decision = buildAutoRouteDecision(
      { model_requested: 'auto', provider_requested: null, tags: [] },
      { enabled: true, strategy: 'fastest', max_fallbacks: 2, quality_derank: true },
      {
        providerSignals: SIGNALS, // all measured → latency decides
        qualitySignals: [{ provider: 'anthropic', model: 'deranked-b', verified: 5, rejected: 15 }],
      },
    );
    expect(decision.auto_route?.latency_mode).toBe('latency_measured');
    expect(decision.auto_route?.quality_derank).toBeUndefined();
  });

  it('refuses to apply signals when the team did not opt in (defense in depth)', () => {
    const decision = buildAutoRouteDecision(
      { model_requested: 'auto', provider_requested: null, tags: [], estimated_input_tokens: 1000 },
      { enabled: true, strategy: 'balanced', max_fallbacks: 2, quality_derank: false },
      {
        providerSignals: SIGNALS.filter((s) => s.provider !== 'google'),
        qualitySignals: [{ provider: 'anthropic', model: 'deranked-b', verified: 0, rejected: 20 }],
      },
    );
    expect(decision.auto_route?.quality_derank).toBeUndefined();
    expect(decision.model).toBe('reliable-a'); // no derank applied → registry order at equal price
  });

  it('reports only score-ordered deranks under fastest with partial latency', () => {
    // openai measured (latency orders it), anthropic+google unmeasured (score
    // orders them, incl. the fallback chain): a derank on the MEASURED
    // candidate never influenced anything and must not be reported; a derank
    // on an unmeasured candidate must be.
    const decision = buildAutoRouteDecision(
      { model_requested: 'auto', provider_requested: null, tags: [] },
      { enabled: true, strategy: 'fastest', max_fallbacks: 2, quality_derank: true },
      {
        providerSignals: [
          { provider: 'openai', credential_available: true, latency_p95_ms: 100, latency_sample_count: 50 },
          { provider: 'anthropic', credential_available: true },
          { provider: 'google', credential_available: true },
        ],
        qualitySignals: [
          { provider: 'openai', model: 'reliable-a', verified: 0, rejected: 20 }, // measured → exclude
          { provider: 'anthropic', model: 'deranked-b', verified: 1, rejected: 19 }, // unmeasured → include
        ],
      },
    );
    expect(decision.auto_route?.latency_mode).toBe('latency_measured_partial');
    const derank = decision.auto_route?.quality_derank ?? [];
    const models = derank.map((d) => d.model);
    expect(models).toEqual(['deranked-b']);
  });

  it('emits NO quality_derank key when the only deranked candidates are measured (fastest)', () => {
    // measured-only deranks are never score-ordered → the filtered set is
    // empty → the metadata must not claim a derank pass with []
    const decision = buildAutoRouteDecision(
      { model_requested: 'auto', provider_requested: null, tags: [] },
      { enabled: true, strategy: 'fastest', max_fallbacks: 2, quality_derank: true },
      {
        providerSignals: [
          { provider: 'openai', credential_available: true, latency_p95_ms: 100, latency_sample_count: 50 },
          { provider: 'anthropic', credential_available: true, latency_p95_ms: 100, latency_sample_count: 50 },
          { provider: 'google', credential_available: true },
        ],
        qualitySignals: [
          { provider: 'openai', model: 'reliable-a', verified: 0, rejected: 20 }, // measured → excluded
          { provider: 'anthropic', model: 'deranked-b', verified: 0, rejected: 20 }, // measured → excluded
        ],
      },
    );
    expect(decision.auto_route?.latency_mode).toBe('latency_measured_partial');
    expect(decision.auto_route?.quality_derank).toBeUndefined();
  });

  it('no quality signals supplied = no deranking at all (handler only sends them when opted in)', () => {
    const decision = buildAutoRouteDecision(
      { model_requested: 'auto', provider_requested: null, tags: [] },
      { enabled: true, strategy: 'balanced', max_fallbacks: 2, quality_derank: true },
      { providerSignals: SIGNALS },
    );
    expect(decision.auto_route?.quality_derank).toBeUndefined();
  });
});
