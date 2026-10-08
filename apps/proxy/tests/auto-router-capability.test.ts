/**
 * RSH-143 capability-index weighting pins. Uses the established synthetic
 * registry pattern (vi.mock on @routeshift/shared, cf. auto-router-flag-pin)
 * so ordering effects are provable, not incidental.
 *
 * Fixture pricing (total per 1M): high/low/mid/premium = 20, no-indices = 2
 * (10x cheaper), premium-fit = 30 (1.5x pricier than high's 20).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@routeshift/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@routeshift/shared')>();
  return {
    ...actual,
    MODEL_REGISTRY: [
    {
      provider: 'openai',
      canonical_name: 'high-agentic',
      api_model_id: 'high-agentic',
      context_window: 200_000,
      intelligence_tier: 3,
      capability_indices: { agentic: 95, coding: 60, intelligence: 80, source: 's', source_as_of: '2026-08-10' },
    },
    {
      provider: 'anthropic',
      canonical_name: 'low-agentic',
      api_model_id: 'low-agentic',
      context_window: 200_000,
      intelligence_tier: 3,
      capability_indices: { agentic: 40, coding: 90, intelligence: 85, source: 's', source_as_of: '2026-08-10' },
    },
    {
      provider: 'meta',
      canonical_name: 'mid-agentic',
      api_model_id: 'mid-agentic',
      context_window: 200_000,
      intelligence_tier: 3,
      // agentic exactly 50 → factor exactly 1.0: axis must STILL be recorded
      capability_indices: { agentic: 50, coding: 50, intelligence: 50, source: 's', source_as_of: '2026-08-10' },
    },
    {
      provider: 'groq',
      canonical_name: 'premium-fit',
      api_model_id: 'premium-fit',
      context_window: 200_000,
      intelligence_tier: 3,
      capability_indices: { agentic: 100, coding: 100, intelligence: 100, source: 's', source_as_of: '2026-08-10' },
    },
    {
      provider: 'google',
      canonical_name: 'no-indices',
      api_model_id: 'no-indices',
      context_window: 200_000,
      intelligence_tier: 3,
    },
    {
      provider: 'mistral',
      canonical_name: 'bad-indices',
      api_model_id: 'bad-indices',
      context_window: 200_000,
      intelligence_tier: 3,
      // invalid: undated provenance — must be treated as NO signal
      capability_indices: { agentic: 95, coding: 60, intelligence: 80, source: 's', source_as_of: '' },
    },
    {
      provider: 'qwen',
      canonical_name: 'coding-only',
      api_model_id: 'coding-only',
      context_window: 200_000,
      intelligence_tier: 3,
      // partial: no agentic axis — an agentic request must NOT claim the axis
      capability_indices: { coding: 85, source: 's', source_as_of: '2026-08-10' },
    },
  ],
  getModelPricing: (provider: string) =>
    provider === 'google'
      ? { provider, model: 'no-indices', input_per_million: 0.5, output_per_million: 1.5 }
      : provider === 'groq'
        ? { provider, model: 'premium-fit', input_per_million: 7.5, output_per_million: 22.5 }
        : { provider, model: 'x', input_per_million: 5, output_per_million: 15 },
  };
});

import {
  buildAutoRouteDecision,
  capabilityFactor,
  scoreModel,
  taskAxisFor,
} from '../src/routing/auto-router.js';
import type { AutoRouteProviderSignal } from '../src/routing/auto-router.js';

const SIGNALS: AutoRouteProviderSignal[] = [
  { provider: 'openai', credential_available: true, latency_p95_ms: 100, latency_sample_count: 50 },
  { provider: 'anthropic', credential_available: true, latency_p95_ms: 100, latency_sample_count: 50 },
  { provider: 'meta', credential_available: true, latency_p95_ms: 100, latency_sample_count: 50 },
  { provider: 'groq', credential_available: true, latency_p95_ms: 100, latency_sample_count: 50 },
  { provider: 'google', credential_available: true, latency_p95_ms: 100, latency_sample_count: 50 },
  { provider: 'mistral', credential_available: true, latency_p95_ms: 100, latency_sample_count: 50 },
  { provider: 'qwen', credential_available: true, latency_p95_ms: 100, latency_sample_count: 50 },
];

function decide(overrides: Record<string, unknown> = {}) {
  return buildAutoRouteDecision(
    {
      model_requested: 'auto',
      provider_requested: null,
      tags: [],
      estimated_input_tokens: 1000,
      ...overrides,
    },
    { enabled: true, strategy: 'balanced', max_fallbacks: 2 },
    { providerSignals: SIGNALS },
  );
}

/** Equal-priced indexed models only (openai/anthropic/meta at 20), no google/groq. */
function decideEqualPrice(overrides: Record<string, unknown> = {}) {
  const signals = SIGNALS.filter((s) => s.provider !== 'google' && s.provider !== 'groq');
  return buildAutoRouteDecision(
    {
      model_requested: 'auto',
      provider_requested: null,
      tags: [],
      estimated_input_tokens: 1000,
      ...overrides,
    },
    { enabled: true, strategy: 'balanced', max_fallbacks: 2 },
    { providerSignals: signals },
  );
}

describe('taskAxisFor (axis selection)', () => {
  it('maps tools/structured output to agentic, code blocks to coding, else intelligence', () => {
    expect(taskAxisFor({ model_requested: 'm', provider_requested: null, tags: [], has_tools: true })).toBe('agentic');
    expect(taskAxisFor({ model_requested: 'm', provider_requested: null, tags: [], has_structured_output: true })).toBe('agentic');
    expect(taskAxisFor({ model_requested: 'm', provider_requested: null, tags: [], has_code_blocks: true })).toBe('coding');
    expect(taskAxisFor({ model_requested: 'm', provider_requested: null, tags: [], has_tools: true, has_code_blocks: true })).toBe('agentic');
    expect(taskAxisFor({ model_requested: 'm', provider_requested: null, tags: [] })).toBe('intelligence');
  });
});

describe('capabilityFactor', () => {
  const withAxis = (axis: Partial<Record<'agentic' | 'coding' | 'intelligence', number>>) => ({
    ...axis,
    source: 's',
    source_as_of: '2026-08-10',
  });

  it('is 1.0 when no sourced indices exist (no signal)', () => {
    expect(capabilityFactor('agentic', undefined)).toBe(1);
  });

  it('rewards verified strength only: index/50 clamped to [1, 2]', () => {
    expect(capabilityFactor('agentic', withAxis({ agentic: 100 }))).toBe(2);
    expect(capabilityFactor('agentic', withAxis({ agentic: 75 }))).toBe(1.5);
    expect(capabilityFactor('agentic', withAxis({ agentic: 50 }))).toBe(1);
    // below 50 and 0 are NOT penalties: absence and verified-low both mean
    // "no bonus" so measuring a model can never hurt it (partial curation)
    expect(capabilityFactor('agentic', withAxis({ agentic: 25 }))).toBe(1);
    expect(capabilityFactor('agentic', withAxis({ agentic: 0 }))).toBe(1);
    // out-of-range values are an INVALID set — the validator rejects them
    // wholesale, so the router treats the set as absent (fail closed, 1.0)
    expect(capabilityFactor('agentic', withAxis({ agentic: 200 }))).toBe(1);
    expect(capabilityFactor('agentic', withAxis({ agentic: -5 }))).toBe(1);
  });

  it('treats a missing axis on a partial set as no signal', () => {
    expect(capabilityFactor('coding', withAxis({ agentic: 95 }))).toBe(1);
  });

  it('rejects invalid index sets wholesale (undated, junk keys)', () => {
    expect(capabilityFactor('agentic', { agentic: 95, coding: 60, source: 's', source_as_of: '' })).toBe(1);
    expect(capabilityFactor('agentic', { agentic: 95, coding: 60, source: 's', source_as_of: '2026-08-10', junk: 1 })).toBe(1);
  });
});

describe('scoreModel capability monotonicity (property pin)', () => {
  for (const strategy of ['cheapest', 'fastest', 'balanced'] as const) {
    it(`${strategy}: score strictly rises with the capability bonus and can flip a raw price order`, () => {
      const at1 = scoreModel(5, 15, 200_000, strategy, false, 3, 1);
      const at2 = scoreModel(5, 15, 200_000, strategy, false, 3, 2);
      expect(Number.isFinite(at1)).toBe(true);
      expect(Number.isFinite(at2)).toBe(true);
      expect(at2).toBeGreaterThan(at1); // STRICT: capability must matter
      // the bonus is bounded at 2x price-equivalence: raw 22 with bonus 2
      // (effective 11) beats raw 12 with no bonus — a real flip of the raw
      // price order, proving the divisor is applied
      const cheap = scoreModel(6, 6, 200_000, strategy, false, 3, 1); // total 12
      const dearBonus = scoreModel(10, 12, 200_000, strategy, false, 3, 2); // effective 11 < 12
      expect(dearBonus).toBeGreaterThan(cheap);
      // ...but a >2x price gap still wins raw (all else equal)
      const cheaper = scoreModel(5, 5, 200_000, strategy, false, 3, 1); // total 10
      const dearer = scoreModel(10, 12, 200_000, strategy, false, 3, 2); // effective 11 > 10
      expect(cheaper).toBeGreaterThan(dearer);
      // tier penalty dominates: a tier-1 model with MAX bonus still loses to
      // a tier-3 model with no bonus on a complex request (0.0001x vs 2x)
      const tier1MaxBonus = scoreModel(5, 15, 200_000, strategy, true, 1, 2);
      const tier3NoBonus = scoreModel(5, 15, 200_000, strategy, true, 3, 1);
      expect(tier3NoBonus).toBeGreaterThan(tier1MaxBonus);
    });
  }
});

describe('buildAutoRouteDecision capability weighting', () => {
  it('agentic request (tools) prefers the higher agentic index at equal price', () => {
    const decision = decideEqualPrice({ has_tools: true });
    expect(decision.model).toBe('high-agentic');
    expect(decision.auto_route?.capability_axis).toBe('agentic');
  });

  it('coding request (code blocks) prefers the higher coding index at equal price', () => {
    const decision = decideEqualPrice({ has_code_blocks: true });
    expect(decision.model).toBe('low-agentic');
    expect(decision.auto_route?.capability_axis).toBe('coding');
  });

  it('price still dominates: a 10x cheaper unindexed model wins even at max bonus', () => {
    // premium-fit (agentic 100 → bonus 2.0) costs 30 vs no-indices at 2:
    // 30/2 = 15 > 2, so balanced picks the cheap model
    const balanced = decide({ has_tools: true });
    expect(balanced.model).toBe('no-indices');
    expect(balanced.auto_route?.capability_axis).toBe('agentic'); // axis WAS applied
    const cheapest = buildAutoRouteDecision(
      { model_requested: 'auto', provider_requested: null, tags: [], has_tools: true },
      { enabled: true, strategy: 'cheapest', max_fallbacks: 2 },
      { providerSignals: SIGNALS },
    );
    expect(cheapest.model).toBe('no-indices');
    expect(cheapest.auto_route?.capability_axis).toBe('agentic');
  });

  it('the bonus is bounded: a 1.5x price gap flips when the expensive model has max fit', () => {
    // premium-fit (30, agentic 100 → effective 15) vs low-agentic (20,
    // agentic 40 → no bonus → effective 20): 15 < 20 on the value term →
    // the pricier, verified-fit model wins (bonus IS applied, bounded at 2x:
    // effective 15 is still more than half of 20).
    const decision = buildAutoRouteDecision(
      { model_requested: 'auto', provider_requested: null, tags: [], has_tools: true },
      { enabled: true, strategy: 'balanced', max_fallbacks: 2 },
      { providerSignals: SIGNALS.filter((s) => s.provider === 'anthropic' || s.provider === 'groq') },
    );
    expect(decision.model).toBe('premium-fit');
    expect(decision.auto_route?.capability_axis).toBe('agentic');
  });

  it('records no capability_axis when no candidate carries indices', () => {
    const decision = buildAutoRouteDecision(
      { model_requested: 'auto', provider_requested: null, tags: [], has_tools: true },
      { enabled: true, strategy: 'balanced', max_fallbacks: 2 },
      {
        providerSignals: [
          { provider: 'google', credential_available: true, latency_p95_ms: 100, latency_sample_count: 50 },
        ],
      },
    );
    expect(decision.model).toBe('no-indices');
    expect(decision.auto_route?.capability_axis).toBeUndefined();
  });

  it('records the axis even when every evaluated factor is exactly 1.0 (index 50)', () => {
    // mid-agentic has indices with agentic == 50 → factor 1.0. The axis was
    // still EVALUATED, so the metadata must say so (explainability contract).
    const decision = buildAutoRouteDecision(
      { model_requested: 'auto', provider_requested: null, tags: [], has_tools: true },
      { enabled: true, strategy: 'balanced', max_fallbacks: 2 },
      {
        providerSignals: [
          { provider: 'google', credential_available: true, latency_p95_ms: 100, latency_sample_count: 50 },
          { provider: 'meta', credential_available: true, latency_p95_ms: 100, latency_sample_count: 50 },
        ],
      },
    );
    expect(decision.auto_route?.capability_axis).toBe('agentic');
    expect(decision.model).toBe('no-indices'); // google is 10x cheaper and unindexed — price still wins
  });

  it('does NOT claim the axis when indices are invalid or missing the active axis', () => {
    // invalid set (undated provenance) is NO signal: with only bad-indices
    // and no-indices present, no valid agentic index exists → no axis claim
    const invalidOnly = buildAutoRouteDecision(
      { model_requested: 'auto', provider_requested: null, tags: [], has_tools: true },
      { enabled: true, strategy: 'balanced', max_fallbacks: 2 },
      {
        providerSignals: [
          { provider: 'google', credential_available: true, latency_p95_ms: 100, latency_sample_count: 50 },
          { provider: 'mistral', credential_available: true, latency_p95_ms: 100, latency_sample_count: 50 },
        ],
      },
    );
    expect(invalidOnly.auto_route?.capability_axis).toBeUndefined();

    // partial set missing the ACTIVE axis is NO signal for that axis:
    // coding-only has a valid coding index but no agentic index
    const partialOnTools = buildAutoRouteDecision(
      { model_requested: 'auto', provider_requested: null, tags: [], has_tools: true },
      { enabled: true, strategy: 'balanced', max_fallbacks: 2 },
      {
        providerSignals: [
          { provider: 'google', credential_available: true, latency_p95_ms: 100, latency_sample_count: 50 },
          { provider: 'qwen', credential_available: true, latency_p95_ms: 100, latency_sample_count: 50 },
        ],
      },
    );
    expect(partialOnTools.auto_route?.capability_axis).toBeUndefined();
    // ...but a coding request against the same partial set DOES claim coding
    const partialOnCoding = buildAutoRouteDecision(
      { model_requested: 'auto', provider_requested: null, tags: [], has_code_blocks: true },
      { enabled: true, strategy: 'balanced', max_fallbacks: 2 },
      {
        providerSignals: [
          { provider: 'google', credential_available: true, latency_p95_ms: 100, latency_sample_count: 50 },
          { provider: 'qwen', credential_available: true, latency_p95_ms: 100, latency_sample_count: 50 },
        ],
      },
    );
    expect(partialOnCoding.auto_route?.capability_axis).toBe('coding');
  });

  it('does NOT claim the axis when measured latency decides (fastest)', () => {
    // fastest with warm latency for every candidate compares by p95, not by
    // the weighted score — recording capability_axis would be a false claim
    const decision = buildAutoRouteDecision(
      { model_requested: 'auto', provider_requested: null, tags: [], has_tools: true },
      { enabled: true, strategy: 'fastest', max_fallbacks: 2 },
      { providerSignals: SIGNALS },
    );
    expect(decision.auto_route?.latency_mode).toBe('latency_measured');
    expect(decision.auto_route?.capability_axis).toBeUndefined();
  });

  it('DOES claim the axis under fastest when no latency is measured (score decides)', () => {
    const decision = buildAutoRouteDecision(
      { model_requested: 'auto', provider_requested: null, tags: [], has_tools: true },
      { enabled: true, strategy: 'fastest', max_fallbacks: 2 },
      {
        providerSignals: SIGNALS.map((s) => ({ provider: s.provider, credential_available: true })),
      },
    );
    expect(decision.auto_route?.latency_mode).toBe('throughput_heuristic');
    expect(decision.auto_route?.capability_axis).toBe('agentic');
  });

  it('DOES claim the axis under fastest with partial latency (>=2 unmeasured: score orders them)', () => {
    // one warm provider + two cold: the cold pair is ordered by the
    // capability-weighted score (fallback chain included), so the axis is real
    const decision = buildAutoRouteDecision(
      { model_requested: 'auto', provider_requested: null, tags: [], has_tools: true },
      { enabled: true, strategy: 'fastest', max_fallbacks: 2 },
      {
        providerSignals: [
          { provider: 'openai', credential_available: true, latency_p95_ms: 100, latency_sample_count: 50 },
          { provider: 'anthropic', credential_available: true },
          { provider: 'meta', credential_available: true },
        ],
      },
    );
    expect(decision.auto_route?.latency_mode).toBe('latency_measured_partial');
    expect(decision.auto_route?.capability_axis).toBe('agentic');
  });

  it('does NOT claim the axis under fastest when exactly one candidate is unmeasured', () => {
    // one cold candidate sorts after every measured one on latency alone —
    // the score never decides anything
    const decision = buildAutoRouteDecision(
      { model_requested: 'auto', provider_requested: null, tags: [], has_tools: true },
      { enabled: true, strategy: 'fastest', max_fallbacks: 2 },
      {
        providerSignals: [
          { provider: 'openai', credential_available: true, latency_p95_ms: 100, latency_sample_count: 50 },
          { provider: 'anthropic', credential_available: true, latency_p95_ms: 100, latency_sample_count: 50 },
          { provider: 'meta', credential_available: true },
        ],
      },
    );
    expect(decision.auto_route?.latency_mode).toBe('latency_measured_partial');
    expect(decision.auto_route?.capability_axis).toBeUndefined();
  });
});
