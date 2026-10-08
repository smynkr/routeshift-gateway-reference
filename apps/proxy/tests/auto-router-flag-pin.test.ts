/**
 * Non-vacuous pin for the auto-router's `auto_route === false` skip
 * (auto-router.ts:157). The registry-wide assertion in auto-router.test.ts
 * proves the chosen models happen to carry no parked flag; THIS test proves
 * the router actively skips a parked model that would otherwise WIN: the
 * synthetic registry makes the parked entry the cheapest candidate by two
 * orders of magnitude, so deleting the skip flips the decision and fails
 * the test (agy, review round 3).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@routeshift/shared', () => ({
  MODEL_REGISTRY: [
    // Would win any price-sensitive strategy if the skip were removed.
    // Default-public on purpose: the auto_route skip at auto-router.ts:157
    // must be the SOLE mechanism excluding this decoy — a public: false flag
    // would let a second exclusion path mask a deleted skip (kimi, round 4).
    {
      provider: 'openai',
      canonical_name: 'parked-decoy-9',
      api_model_id: 'parked-decoy-9',
      context_window: 1_000_000,
      auto_route: false,
      intelligence_tier: 3,
    },
    {
      provider: 'anthropic',
      canonical_name: 'legit-9',
      api_model_id: 'legit-9',
      context_window: 200_000,
      intelligence_tier: 3,
    },
  ],
  getModelPricing: (_provider: string, model: string) =>
    model === 'parked-decoy-9'
      ? { provider: 'openai', model, input_per_million: 0.01, output_per_million: 0.01 }
      : { provider: 'anthropic', model, input_per_million: 15, output_per_million: 75 },
  selectModelPricing: (pricing: { input_per_million: number; output_per_million: number }) => ({
    input_per_million: pricing.input_per_million,
    output_per_million: pricing.output_per_million,
    cache_read_per_million: pricing.input_per_million * 0.1,
    cache_write_per_million: pricing.input_per_million * 1.25,
    long_context: false,
  }),

}));
import { buildAutoRouteDecision, type AutoRouteProviderSignal } from '../src/routing/auto-router.js';

const SIGNALS: AutoRouteProviderSignal[] = [
  { provider: 'openai', credential_available: true, latency_p95_ms: 100, latency_sample_count: 50 },
  { provider: 'anthropic', credential_available: true, latency_p95_ms: 900, latency_sample_count: 50 },
];

describe('auto_route: false skip (non-vacuous pin)', () => {
  for (const strategy of ['cheapest', 'fastest', 'balanced'] as const) {
    it(`never selects the dominant parked decoy (strategy: ${strategy})`, () => {
      const decision = buildAutoRouteDecision(
        {
          model_requested: 'auto',
          provider_requested: null,
          tags: [],
          estimated_input_tokens: 1000,
        },
        { enabled: true, strategy, max_fallbacks: 20 },
        { providerSignals: SIGNALS },
      );
      const chosen = [decision.model, ...decision.fallback_chain.map((f) => f.model)];
      expect(chosen).not.toContain('parked-decoy-9');
      expect(decision.model).toBe('legit-9');
    });
  }
});
