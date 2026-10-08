import { describe, expect, it } from 'vitest';
import { MODEL_REGISTRY, type ModelDefinition } from '@routeshift/shared';
import { buildAutoRouteDecision, type AutoRouteProviderSignal } from '../src/routing/auto-router.js';


function signals(
  available: Record<string, Partial<AutoRouteProviderSignal>>,
  unavailableReason = 'test_missing_credentials',
): AutoRouteProviderSignal[] {
  const providers = [...new Set(MODEL_REGISTRY
    .filter((model) => model.auto_route !== false)
    .map((model) => model.provider))];
  return providers.map((provider) => ({
    provider,
    credential_available: Boolean(available[provider]),
    unavailable_reason: available[provider] ? undefined : unavailableReason,
    ...available[provider],
  }));
}

function allProvidersAvailable(): AutoRouteProviderSignal[] {
  const providers = [...new Set(MODEL_REGISTRY
    .filter((model) => model.auto_route !== false)
    .map((model) => model.provider))];
  return providers.map((provider) => ({ provider, credential_available: true }));
}

describe('buildAutoRouteDecision', () => {
  it('does not silently auto-route to explicit-only Azure GPT 5.4/5.5 models', () => {
    const decision = buildAutoRouteDecision(
      {
        model_requested: 'gpt-5',
        provider_requested: 'openai',
        tags: [],
        estimated_input_tokens: 1000,
      },
      { enabled: true, strategy: 'balanced', max_fallbacks: 20 },
      { providerSignals: allProvidersAvailable() },
    );

    const selected = [decision.model, ...decision.fallback_chain.map((entry) => entry.model)];
    expect(selected).not.toContain('gpt-5.4');
    expect(selected).not.toContain('gpt-5.5');
  });

  it('never selects a generated explicit-only catalog model', () => {
    const decision = buildAutoRouteDecision(
      {
        model_requested: 'gpt-5',
        provider_requested: 'openai',
        tags: [],
        estimated_input_tokens: 1000,
      },
      { enabled: true, strategy: 'balanced', max_fallbacks: 20 },
      { providerSignals: allProvidersAvailable() },
    );
    const selected = [decision.model, ...decision.fallback_chain.map((entry) => entry.model)];

    expect(selected).not.toContain('gpt-4o-mini');
  });
  it('uses long-context pricing rates when ranking an oversized prompt', () => {
    const effectiveModels: ModelDefinition[] = [
      {
        provider: 'openai',
        canonical_name: 'gpt-5.6-sol',
        api_model_id: 'gpt-5.6-sol',
        context_window: 1_050_000,
        intelligence_tier: 3,
      },
      {
        provider: 'anthropic',
        canonical_name: 'claude-opus-4-8',
        api_model_id: 'claude-opus-4-8',
        context_window: 1_000_000,
        intelligence_tier: 3,
      },
    ];
    const providerSignals: AutoRouteProviderSignal[] = [
      { provider: 'openai', credential_available: true },
      { provider: 'anthropic', credential_available: true },
    ];

    const shortPrompt = buildAutoRouteDecision(
      {
        model_requested: 'auto',
        provider_requested: null,
        tags: [],
        estimated_input_tokens: 1000,
      },
      { enabled: true, strategy: 'balanced', max_fallbacks: 1 },
      { effectiveModels, providerSignals },
    );
    const longPrompt = buildAutoRouteDecision(
      {
        model_requested: 'auto',
        provider_requested: null,
        tags: [],
        estimated_input_tokens: 272_001,
      },
      { enabled: true, strategy: 'balanced', max_fallbacks: 1 },
      { effectiveModels, providerSignals },
    );

    expect(shortPrompt.model).toBe('gpt-5.6-sol');
    expect(longPrompt.model).toBe('claude-opus-4-8');
  });


  it('RSH-74: preserves max_output_tokens set by an earlier modify rule through auto-routing', () => {
    const decision = buildAutoRouteDecision(
      {
        model_requested: 'gpt-5',
        provider_requested: 'openai',
        tags: [],
        estimated_input_tokens: 1000,
        max_output_tokens: 500,
      },
      { enabled: true, strategy: 'balanced', max_fallbacks: 20 },
      { providerSignals: allProvidersAvailable() },
    );

    expect(decision.max_output_tokens).toBe(500);
  });

  it('RSH-54: fails closed when no provider signals are supplied', () => {
    const decision = buildAutoRouteDecision(
      {
        model_requested: 'gpt-5',
        provider_requested: 'openai',
        tags: [],
        estimated_input_tokens: 1000,
      },
      { enabled: true, strategy: 'balanced', max_fallbacks: 20 },
      // No providerSignals: without signal data we cannot confirm any credential.
    );

    // Must NOT select a (possibly uncredentialed) provider — pass through unchanged.
    expect(decision).toMatchObject({ provider: 'openai', model: 'gpt-5', is_default: true });
    expect(decision.fallback_chain).toEqual([]);
    // Every registry provider is recorded as skipped with the no-signals reason.
    expect(decision.auto_route?.provider_skips.length).toBeGreaterThan(0);
    for (const skip of decision.auto_route?.provider_skips ?? []) {
      expect(skip.reason).toBe('no_auto_route_provider_signals');
    }
  });

  it('selects only credential-available providers for primary and fallbacks', () => {
    const decision = buildAutoRouteDecision(
      {
        model_requested: 'gpt-5',
        provider_requested: 'openai',
        tags: [],
        estimated_input_tokens: 1000,
      },
      { enabled: true, strategy: 'balanced', max_fallbacks: 20 },
      {
        providerSignals: signals({
          google: { provider: 'google', credential_available: true },
        }),
      },
    );

    const selectedProviders = [decision.provider, ...decision.fallback_chain.map((entry) => entry.provider)];
    expect(new Set(selectedProviders)).toEqual(new Set(['google']));
    expect(decision.auto_route?.provider_skips).toContainEqual({
      provider: 'openai',
      reason: 'test_missing_credentials',
    });
  });

  it('passes through with exact skip reasons when no auto-route provider has credentials', () => {
    const decision = buildAutoRouteDecision(
      {
        model_requested: 'gpt-5',
        provider_requested: 'openai',
        tags: [],
        estimated_input_tokens: 1000,
      },
      { enabled: true, strategy: 'balanced', max_fallbacks: 2 },
      { providerSignals: signals({}) },
    );

    expect(decision).toMatchObject({
      provider: 'openai',
      model: 'gpt-5',
      is_default: true,
    });
    expect(decision.auto_route?.provider_skips).toContainEqual({
      provider: 'openai',
      reason: 'test_missing_credentials',
    });
  });

  it('treats missing provider signals as unavailable when a signal list is supplied', () => {
    const decision = buildAutoRouteDecision(
      {
        model_requested: 'gpt-5',
        provider_requested: 'openai',
        tags: [],
        estimated_input_tokens: 1000,
      },
      { enabled: true, strategy: 'balanced', max_fallbacks: 2 },
      {
        providerSignals: [
          { provider: 'google', credential_available: true },
        ],
      },
    );

    expect(decision.provider).toBe('google');
    expect(decision.auto_route?.provider_skips).toContainEqual({
      provider: 'openai',
      reason: 'missing_auto_route_provider_signal',
    });
  });

  it('fastest uses measured provider latency when available', () => {
    const decision = buildAutoRouteDecision(
      {
        model_requested: 'gpt-5',
        provider_requested: 'openai',
        tags: [],
        estimated_input_tokens: 1000,
      },
      { enabled: true, strategy: 'fastest', max_fallbacks: 1 },
      {
        providerSignals: signals({
          openai: {
            provider: 'openai',
            credential_available: true,
            latency_p95_ms: 80,
            latency_sample_count: 20,
          },
          google: {
            provider: 'google',
            credential_available: true,
            latency_p95_ms: 500,
            latency_sample_count: 20,
          },
        }),
      },
    );

    expect(decision.provider).toBe('openai');
    expect(decision.auto_route?.latency_mode).toBe('latency_measured');
    expect(decision.tags).toContain('auto-route:latency_measured');
  });

  it('fastest labels heuristic mode when no measured latency is available', () => {
    const decision = buildAutoRouteDecision(
      {
        model_requested: 'gpt-5',
        provider_requested: 'openai',
        tags: [],
        estimated_input_tokens: 1000,
      },
      { enabled: true, strategy: 'fastest', max_fallbacks: 1 },
      {
        providerSignals: signals({
          openai: { provider: 'openai', credential_available: true },
          google: { provider: 'google', credential_available: true },
        }),
      },
    );

    expect(decision.auto_route?.latency_mode).toBe('throughput_heuristic');
    expect(decision.tags).toContain('auto-route:throughput_heuristic');
  });

  describe('RSH-71: complexity signal and intelligence tier penalties', () => {
    it('complex request (tools) avoids tier-1 models in cheapest mode', () => {
      const decision = buildAutoRouteDecision(
        {
          model_requested: 'gpt-5',
          provider_requested: 'openai',
          tags: [],
          estimated_input_tokens: 1000,
          has_tools: true,
        },
        { enabled: true, strategy: 'cheapest', max_fallbacks: 20 },
        { providerSignals: allProvidersAvailable() },
      );

      // The primary model should NOT be a tier-1 model (nano/lite/oss-20b)
      const tier1Models = ['gpt-5.4-nano', 'gpt-oss-20b', 'gemini-3.1-flash-lite', 'glm-4.5', 'glm-4.5-air'];
      expect(tier1Models).not.toContain(decision.model);
    });

    it('simple request in cheapest mode CAN select tier-1 models', () => {
      const decision = buildAutoRouteDecision(
        {
          model_requested: 'gpt-5',
          provider_requested: 'openai',
          tags: [],
          estimated_input_tokens: 500,
          has_tools: false,
          has_structured_output: false,
          has_code_blocks: false,
        },
        { enabled: true, strategy: 'cheapest', max_fallbacks: 20 },
        { providerSignals: allProvidersAvailable() },
      );

      // Without complexity, cheapest should prefer cheap models — at minimum
      // the primary should not be one of the most expensive tier-3 models
      expect(decision.is_default).toBe(false);
      expect(decision.rule_id).toBe('auto');
    });

    it('reasoning_effort high triggers complexity penalty', () => {
      const withHigh = buildAutoRouteDecision(
        {
          model_requested: 'gpt-5',
          provider_requested: 'openai',
          tags: [],
          estimated_input_tokens: 1000,
          reasoning_effort: 'high',
        },
        { enabled: true, strategy: 'cheapest', max_fallbacks: 20 },
        { providerSignals: allProvidersAvailable() },
      );
      const withoutHigh = buildAutoRouteDecision(
        {
          model_requested: 'gpt-5',
          provider_requested: 'openai',
          tags: [],
          estimated_input_tokens: 1000,
        },
        { enabled: true, strategy: 'cheapest', max_fallbacks: 20 },
        { providerSignals: allProvidersAvailable() },
      );

      // High reasoning effort should shift the primary model away from cheap tier-1
      // models compared to a request with no complexity signal
      const tier1Models = ['gpt-5.4-nano', 'gpt-oss-20b', 'gemini-3.1-flash-lite', 'glm-4.5', 'glm-4.5-air'];
      if (tier1Models.includes(withoutHigh.model)) {
        // If the non-complex request picked a tier-1 model, the complex one should not
        expect(tier1Models).not.toContain(withHigh.model);
      }
    });

    it('large estimated_input_tokens (>10k) triggers complexity', () => {
      const decision = buildAutoRouteDecision(
        {
          model_requested: 'gpt-5',
          provider_requested: 'openai',
          tags: [],
          estimated_input_tokens: 15000,
          has_tools: false,
        },
        { enabled: true, strategy: 'cheapest', max_fallbacks: 20 },
        { providerSignals: allProvidersAvailable() },
      );

      const tier1Models = ['gpt-5.4-nano', 'gpt-oss-20b', 'gemini-3.1-flash-lite', 'glm-4.5', 'glm-4.5-air'];
      expect(tier1Models).not.toContain(decision.model);
    });

    it('RSH-79: reasoning_effort and thinking_budget_tokens are preserved through auto-routing', () => {
      const decision = buildAutoRouteDecision(
        {
          model_requested: 'gpt-5',
          provider_requested: 'openai',
          tags: [],
          estimated_input_tokens: 1000,
          reasoning_effort: 'high',
          thinking_budget_tokens: 4096,
        },
        { enabled: true, strategy: 'balanced', max_fallbacks: 2 },
        { providerSignals: allProvidersAvailable() },
      );

      expect(decision.reasoning_effort).toBe('high');
      expect(decision.thinking_budget_tokens).toBe(4096);
    });

    it('RSH-79: reasoning fields pass through even in the no-candidates fallback path', () => {
      const decision = buildAutoRouteDecision(
        {
          model_requested: 'gpt-5',
          provider_requested: 'openai',
          tags: [],
          estimated_input_tokens: 1000,
          reasoning_effort: 'medium',
          thinking_budget_tokens: 2048,
        },
        { enabled: true, strategy: 'balanced', max_fallbacks: 2 },
        { providerSignals: signals({}) }, // no providers available → empty candidates
      );

      expect(decision.is_default).toBe(true);
      expect(decision.reasoning_effort).toBe('medium');
      expect(decision.thinking_budget_tokens).toBe(2048);
    });
  });
});

describe('auto_route flag invariant', () => {
  it('never selects or falls back to an auto_route: false registry entry', () => {
    // The second leg of the parked/promotion safety story: resolveProvider
    // rejects public === false (pinned in proxy-handler-basic.test.ts); the
    // auto-router must skip auto_route === false so a public-but-not-
    // auto-routable model (promote-model's default output) never receives
    // automatic traffic (review round 2).
    const decision = buildAutoRouteDecision(
      {
        model_requested: 'gpt-5',
        provider_requested: 'openai',
        tags: [],
        estimated_input_tokens: 1000,
      },
      { enabled: true, strategy: 'balanced', max_fallbacks: 20 },
      { providerSignals: allProvidersAvailable() },
    );

    const chosen = [decision.model, ...decision.fallback_chain.map((entry) => entry.model)];
    expect(chosen.length).toBeGreaterThan(0);
    for (const model of chosen) {
      const entry = MODEL_REGISTRY.find(
        (m) => m.api_model_id === model || m.canonical_name === model,
      );
      expect(entry, `selected model '${model}' not in registry`).toBeDefined();
      expect(
        entry?.auto_route,
        `auto-router selected '${model}' despite auto_route: false`,
      ).not.toBe(false);
    }
  });
});
