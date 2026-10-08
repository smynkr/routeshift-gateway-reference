// apps/proxy/tests/fallback.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the shared circuit-breaker singleton so fallback tests don't accumulate
// real breaker state across cases (and so we can assert breaker interactions).
// Default isOpen=false keeps the pre-existing tests' behavior unchanged.
const breaker = vi.hoisted(() => ({
  isOpen: vi.fn(() => false),
  recordFailure: vi.fn(),
  recordSuccess: vi.fn(),
}));
vi.mock('../src/routing/circuit-breaker.js', () => ({ circuitBreaker: breaker }));

import type { GeneratedCatalogModel } from '@routeshift/shared';
import { executeFallbackChain, estimateAttemptCostMicrocents, projectQualityCascadeReservation } from '../src/routing/fallback.js';

describe('executeFallbackChain', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    breaker.isOpen.mockReset();
    breaker.isOpen.mockReturnValue(false);
    breaker.recordFailure.mockReset();
    breaker.recordSuccess.mockReset();
  });

  it('returns successful fallback result', async () => {
    // Mock: first fallback succeeds
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));

    const result = await executeFallbackChain(
      [{ provider: 'anthropic', model: 'claude-haiku-4-5' }],
      { model: 'gpt-4.1', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      (p) => p === 'anthropic' ? 'key' : undefined,
      { provider: 'openai', model: 'gpt-4.1', error: 'HTTP 500' },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected fallback success');
    expect(result.providerId).toBe('anthropic');
    expect(result.model).toBe('claude-haiku-4-5');
    expect(result.attempts).toHaveLength(1); // Just the primary error
    expect(result.aggregateActualCostKnown).toBe(true);
  });

  it('propagates an unknown-cost primary dispatch into a successful fallback result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));

    const result = await executeFallbackChain(
      [{ provider: 'anthropic', model: 'claude-haiku-4-5' }],
      { model: 'gpt-4.1', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      () => 'key',
      { provider: 'openai', model: 'gpt-4.1', error: 'Network error: reset', actual_cost_known: false },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected fallback success');
    expect(result.aggregateActualCostKnown).toBe(false);
    expect(result.aggregateActualCostMicrocents).toBe(0);
    expect(result.aggregateInputTokens).toBe(0);
  });

  it('tries multiple fallbacks until one succeeds', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve({ ok: false, status: 500 });
      return Promise.resolve({ ok: true, status: 200 });
    }));

    const result = await executeFallbackChain(
      [
        { provider: 'anthropic', model: 'claude-haiku-4-5' },
        { provider: 'google', model: 'gemini-2.5-flash' },
      ],
      { model: 'gpt-4.1', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      () => 'key',
      { provider: 'openai', model: 'gpt-4.1', error: 'HTTP 500' },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected fallback success');
    expect(result.providerId).toBe('google');
    expect(result.attempts).toHaveLength(2); // primary + first fallback failure
    expect(result.attempts[1]).toMatchObject({ error: 'HTTP 500', actual_cost_known: false });
    expect(result.aggregateActualCostKnown).toBe(false);
  });

  it.each([429, 400])('keeps a fallback HTTP %i attempt as exact known-zero', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status }));

    const result = await executeFallbackChain(
      [{ provider: 'anthropic', model: 'claude-haiku-4-5' }],
      { model: 'gpt-4.1', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      () => 'key',
      { provider: 'openai', model: 'gpt-4.1', error: 'HTTP 500', actual_cost_known: false },
    );

    expect(result.ok).toBe(false);
    expect(result.attempts.at(-1)).toMatchObject({ error: `HTTP ${status}`, actual_cost_known: true });
  });

  it('returns exhausted attempts when all fallbacks fail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const result = await executeFallbackChain(
      [{ provider: 'anthropic', model: 'claude-haiku-4-5' }],
      { model: 'gpt-4.1', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      () => 'key',
      { provider: 'openai', model: 'gpt-4.1', error: 'HTTP 500' },
    );

    expect(result).toEqual({
      ok: false,
      attempts: [
        { provider: 'openai', model: 'gpt-4.1', error: 'HTTP 500' },
        { provider: 'anthropic', model: 'claude-haiku-4-5', error: 'HTTP 500', actual_cost_known: false },
      ],
    });
  });

  it('prevents loops (skips already-tried provider:model)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    await executeFallbackChain(
      [
        { provider: 'openai', model: 'gpt-4.1' }, // Same as primary — should skip
        { provider: 'anthropic', model: 'claude-haiku-4-5' },
      ],
      { model: 'gpt-4.1', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      () => 'key',
      { provider: 'openai', model: 'gpt-4.1', error: 'HTTP 500' },
    );

    // Should only call fetch once (for anthropic, skipping the duplicate openai)
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('skips entries without API key', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    await executeFallbackChain(
      [
        { provider: 'google', model: 'gemini-2.5-flash' }, // No key
        { provider: 'anthropic', model: 'claude-haiku-4-5' },
      ],
      { model: 'gpt-4.1', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      (p) => p === 'anthropic' ? 'key' : undefined,
      { provider: 'openai', model: 'gpt-4.1', error: 'HTTP 500' },
    );

    expect(mockFetch).toHaveBeenCalledTimes(1); // Only anthropic
  });

  it('skips fallback models with insufficient context window', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    const hugePrompt = 'x'.repeat(5_000_000);
    const result = await executeFallbackChain(
      [{ provider: 'openai', model: 'o3' }],
      { model: 'gpt-4.1', messages: [{ role: 'user', content: hugePrompt }], stream: false },
      () => 'key',
      { provider: 'openai', model: 'gpt-4.1', error: 'HTTP 500' },
    );

    expect(result.ok).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('counts canonical native PDF bytes when guarding fallback context', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    const result = await executeFallbackChain(
      [{ provider: 'openai', model: 'o3' }],
      {
        model: 'claude-haiku-4-5',
        messages: [{
          role: 'user',
          content: [{
            type: 'pdf',
            pdf: { media_type: 'application/pdf', data: 'A'.repeat(1_000_000) },
          }],
        }],
        stream: false,
      },
      () => 'key',
      { provider: 'anthropic', model: 'claude-haiku-4-5', error: 'HTTP 500' },
    );

    expect(result.ok).toBe(false);
    expect(result.attempts).toContainEqual({
      provider: 'openai',
      model: 'o3',
      error: 'Context window too small',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('skips an oversized generated catalog target using its effective context window', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const generatedTarget: GeneratedCatalogModel = {
      provider: 'qwen',
      canonical_name: 'generated-small-context',
      api_model_id: 'generated-small-context',
      context_window: 10,
      source: 'generated',
      public: true,
      explicit_only: true,
      auto_route: false,
      source_url: 'https://example.test/catalog.json',
      source_hash: 'fixture-hash',
      source_as_of: '2026-08-26T12:00:00.000Z',
    };
    const budget = {
      maxRetries: 1,
      effectiveModels: [generatedTarget],
    };
    const result = await executeFallbackChain(
      [{ provider: 'qwen', model: 'generated-small-context' }],
      { model: 'gpt-4.1', messages: [{ role: 'user', content: 'x'.repeat(100) }], stream: false },
      () => 'key',
      { provider: 'openai', model: 'gpt-4.1', error: 'HTTP 500' },
      budget,
    );
    expect(result.ok).toBe(false);
    expect(result.attempts).toContainEqual({
      provider: 'qwen',
      model: 'generated-small-context',
      error: 'Context window too small',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });


  it('records unknown fallback providers as failed attempts', async () => {
    vi.stubGlobal('fetch', vi.fn());

    const result = await executeFallbackChain(
      [{ provider: 'does-not-exist', model: 'model-x' }],
      { model: 'gpt-4.1', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      () => 'key',
      { provider: 'openai', model: 'gpt-4.1', error: 'HTTP 500' },
    );

    expect(result.ok).toBe(false);
  });

  it('records thrown fetch errors during fallback attempts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket hang up')));

    const result = await executeFallbackChain(
      [{ provider: 'anthropic', model: 'claude-haiku-4-5' }],
      { model: 'gpt-4.1', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      () => 'key',
      { provider: 'openai', model: 'gpt-4.1', error: 'HTTP 500' },
    );

    expect(result.ok).toBe(false);
  });

  // ---------------------------------------------------------------------
  // LAY-321: retry budget
  // ---------------------------------------------------------------------
  it('LAY-321: max_retries=0 prevents any fallback attempt', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    const result = await executeFallbackChain(
      [
        { provider: 'anthropic', model: 'claude-haiku-4-5' },
        { provider: 'google', model: 'gemini-2.5-flash' },
      ],
      { model: 'gpt-4.1', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      () => 'key',
      { provider: 'openai', model: 'gpt-4.1', error: 'HTTP 500' },
      { maxRetries: 0 },
    );

    expect(result.ok).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('LAY-321: max_retries=1 caps the chain at one fallback attempt', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal('fetch', mockFetch);

    const result = await executeFallbackChain(
      [
        { provider: 'anthropic', model: 'claude-haiku-4-5' },
        { provider: 'google', model: 'gemini-2.5-flash' },
        { provider: 'together', model: 'llama-3.1-70b' },
      ],
      { model: 'gpt-4.1', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      () => 'key',
      { provider: 'openai', model: 'gpt-4.1', error: 'HTTP 500' },
      { maxRetries: 1 },
    );

    expect(result.ok).toBe(false);
    // Exactly one upstream call — the second chain entry should never be dispatched.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('LAY-321: skipped entries (context-window, no key) do not burn retry slots', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    // Big prompt → o3 (200k window) is OK but a 32k-window model would be skipped.
    // Use a no-key entry first; budget=1 should still let the second entry dispatch.
    const result = await executeFallbackChain(
      [
        { provider: 'google', model: 'gemini-2.5-flash' }, // no key
        { provider: 'anthropic', model: 'claude-haiku-4-5' },
      ],
      { model: 'gpt-4.1', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      (p) => (p === 'anthropic' ? 'key' : undefined),
      { provider: 'openai', model: 'gpt-4.1', error: 'HTTP 500' },
      { maxRetries: 1 },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected fallback success');
    expect(result.providerId).toBe('anthropic');
  });

  it('LAY-321: maxCostMicrocents stops the chain before exceeding the ceiling', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal('fetch', mockFetch);

    // Estimate enough output tokens that a single attempt's projected cost is non-trivial.
    // With maxCostMicrocents = 1 (a microcent), even the cheapest priced model
    // overshoots, so no fallback should dispatch.
    const result = await executeFallbackChain(
      [{ provider: 'anthropic', model: 'claude-haiku-4-5' }],
      { model: 'gpt-4.1', messages: [{ role: 'user', content: 'Hi there!' }], stream: false },
      () => 'key',
      { provider: 'openai', model: 'gpt-4.1', error: 'HTTP 500' },
      {
        maxRetries: 5,
        maxCostMicrocents: 1,
        estimatedInputTokens: 1000,
        estimatedMaxOutputTokens: 4096,
      },
    );

    expect(result.ok).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('LAY-321: maxCostMicrocents skips unknown-priced models instead of treating them as free', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    expect(estimateAttemptCostMicrocents('unknown-provider', 'unpriced-model', 100, 100)).toBeNull();

    const result = await executeFallbackChain(
      [{ provider: 'anthropic', model: 'unpriced-model' }],
      { model: 'gpt-4.1', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      () => 'key',
      { provider: 'openai', model: 'gpt-4.1', error: 'HTTP 500' },
      { maxRetries: 5, maxCostMicrocents: 1_000_000, estimatedInputTokens: 100, estimatedMaxOutputTokens: 100 },
    );

    expect(result.ok).toBe(false);
    expect(result.attempts).toContainEqual({
      provider: 'anthropic',
      model: 'unpriced-model',
      error: 'Retry budget exhausted (unknown_pricing)',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not dispatch a priced fallback under a max-cost ceiling when the primary price is unknown', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const result = await executeFallbackChain(
      [{ provider: 'anthropic', model: 'priced-fallback' }],
      { model: 'gpt-4.1', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      () => 'key',
      { provider: 'openai', model: 'unpriced-primary', error: 'HTTP 500' },
      {
        maxRetries: 1,
        maxCostMicrocents: 1_000_000,
        pricingResolver: async (provider) => provider === 'openai'
          ? null
          : { provider, model: 'priced-fallback', input_per_million: 1, output_per_million: 1 },
      },
    );

    expect(result).toEqual({
      ok: false,
      attempts: [
        { provider: 'openai', model: 'unpriced-primary', error: 'HTTP 500' },
        { provider: 'openai', model: 'unpriced-primary', error: 'Retry budget exhausted (primary_unknown_pricing)' },
      ],
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('credits mode skips an unpriced fallback before resolving a platform key or dispatching', async () => {
    const mockFetch = vi.fn();
    const getProviderConfig = vi.fn(() => 'platform-key');
    vi.stubGlobal('fetch', mockFetch);

    const result = await executeFallbackChain(
      [{ provider: 'anthropic', model: 'unpriced-model' }],
      { model: 'gpt-4.1', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      getProviderConfig,
      { provider: 'openai', model: 'gpt-4.1', error: 'HTTP 500' },
      {
        maxRetries: 5,
        requireKnownPricing: true,
        pricingResolver: async () => null,
      },
    );

    expect(result).toEqual({
      ok: false,
      attempts: [
        { provider: 'openai', model: 'gpt-4.1', error: 'HTTP 500' },
        { provider: 'anthropic', model: 'unpriced-model', error: 'Missing model pricing' },
      ],
    });
    expect(getProviderConfig).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('credits mode dispatches a fallback after the pricing resolver confirms a price', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    const result = await executeFallbackChain(
      [{ provider: 'anthropic', model: 'db-priced-model' }],
      { model: 'gpt-4.1', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      () => 'platform-key',
      { provider: 'openai', model: 'gpt-4.1', error: 'HTTP 500' },
      {
        maxRetries: 5,
        requireKnownPricing: true,
        pricingResolver: async () => ({
          provider: 'anthropic',
          model: 'db-priced-model',
          input_per_million: 1,
          output_per_million: 2,
        }),
      },
    );

    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('LAY-321: records missing provider keys as explicit exhausted-chain attempts', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const result = await executeFallbackChain(
      [{ provider: 'anthropic', model: 'claude-haiku-4-5' }],
      { model: 'gpt-4.1', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      () => undefined,
      { provider: 'openai', model: 'gpt-4.1', error: 'HTTP 500' },
    );

    expect(result).toEqual({
      ok: false,
      attempts: [
        { provider: 'openai', model: 'gpt-4.1', error: 'HTTP 500' },
        { provider: 'anthropic', model: 'claude-haiku-4-5', error: 'No provider key configured' },
      ],
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('LAY-321: no budget (undefined) preserves prior unlimited-chain behavior', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    const result = await executeFallbackChain(
      [
        { provider: 'anthropic', model: 'claude-haiku-4-5' },
        { provider: 'google', model: 'gemini-2.5-flash' },
        { provider: 'together', model: 'llama-3.1-70b' },
      ],
      { model: 'gpt-4.1', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      () => 'key',
      { provider: 'openai', model: 'gpt-4.1', error: 'HTTP 500' },
    );

    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  // ---------------------------------------------------------------------
  // Circuit breaker integration (fallback targets were never breaker-gated)
  // ---------------------------------------------------------------------
  it('skips a fallback target whose circuit is open without consuming a retry', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);
    // First fallback's circuit is open; second is healthy.
    breaker.isOpen.mockImplementation((p: string, m: string) => p === 'anthropic' && m === 'claude-haiku-4-5');

    const result = await executeFallbackChain(
      [
        { provider: 'anthropic', model: 'claude-haiku-4-5' }, // circuit open -> skipped
        { provider: 'google', model: 'gemini-2.5-flash' },
      ],
      { model: 'gpt-4.1', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      () => 'key',
      { provider: 'openai', model: 'gpt-4.1', error: 'HTTP 500' },
      { maxRetries: 1 },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected fallback success');
    // The open entry was skipped (not dispatched) and did NOT burn the single
    // retry slot — the healthy second entry still got its attempt.
    expect(result.providerId).toBe('google');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.attempts).toContainEqual({ provider: 'anthropic', model: 'claude-haiku-4-5', error: 'Circuit breaker open' });
  });

  it('records breaker success when a fallback succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    await executeFallbackChain(
      [{ provider: 'anthropic', model: 'claude-haiku-4-5' }],
      { model: 'gpt-4.1', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      () => 'key',
      { provider: 'openai', model: 'gpt-4.1', error: 'HTTP 500' },
    );
    expect(breaker.recordSuccess).toHaveBeenCalledWith('anthropic', 'claude-haiku-4-5');
    expect(breaker.recordFailure).not.toHaveBeenCalled();
  });

  it('feeds the breaker on retryable HTTP and network errors, but not on 4xx', async () => {
    // 400 (client/request fault) must NOT trip the breaker.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400 }));
    await executeFallbackChain(
      [{ provider: 'anthropic', model: 'claude-haiku-4-5' }],
      { model: 'gpt-4.1', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      () => 'key',
      { provider: 'openai', model: 'gpt-4.1', error: 'HTTP 500' },
    );
    expect(breaker.recordFailure).not.toHaveBeenCalled();

    // 503 (retryable) DOES trip the breaker.
    breaker.recordFailure.mockClear();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    await executeFallbackChain(
      [{ provider: 'anthropic', model: 'claude-haiku-4-5' }],
      { model: 'gpt-4.1', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      () => 'key',
      { provider: 'openai', model: 'gpt-4.1', error: 'HTTP 500' },
    );
    expect(breaker.recordFailure).toHaveBeenCalledWith('anthropic', 'claude-haiku-4-5');

    // A thrown fetch (network fault) also trips the breaker.
    breaker.recordFailure.mockClear();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket hang up')));
    await executeFallbackChain(
      [{ provider: 'google', model: 'gemini-2.5-flash' }],
      { model: 'gpt-4.1', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      () => 'key',
      { provider: 'openai', model: 'gpt-4.1', error: 'HTTP 500' },
    );
    expect(breaker.recordFailure).toHaveBeenCalledWith('google', 'gemini-2.5-flash');
  });
});

describe('projectQualityCascadeReservation', () => {
  const canonical = { model: 'gpt-4.1', messages: [{ role: 'user' as const, content: 'Hi' }], stream: false };
  const pricing = vi.fn(async () => ({ input_per_million: 1, output_per_million: 2 }));

  beforeEach(() => {
    breaker.isOpen.mockReset();
    breaker.isOpen.mockReturnValue(false);
    pricing.mockClear();
  });

  it('uses the DB-aware resolver rather than static catalog pricing', async () => {
    const result = await projectQualityCascadeReservation(
      { provider: 'openai', model: 'gpt-4.1' }, [], canonical,
      { maxRetries: 0, estimatedInputTokens: 10, estimatedMaxOutputTokens: 20, pricingResolver: pricing },
    );
    expect(result).toEqual({ costMicrocents: 5_000 });
    expect(pricing).toHaveBeenCalledWith('openai', 'gpt-4.1');
  });
  it('uses the long-context tier for retry estimates above 272K prompt tokens', () => {
    const pricingForLongModel = {
      provider: 'openai',
      model: 'gpt-5.6-sol',
      input_per_million: 4,
      output_per_million: 20,
      input_per_million_above_272k: 8,
      output_per_million_above_272k: 30,
    };

    // The shared catalog's long tier is selected by prompt-token count, not
    // by the caller's output estimate. Keep this assertion at the retry
    // estimator boundary so max-cost admission cannot under-reserve.
    expect(
      estimateAttemptCostMicrocents('openai', 'gpt-5.6-sol', 272_001, 1),
    ).toBe(
      Math.ceil(
        272_001 * pricingForLongModel.input_per_million_above_272k * 100
          + pricingForLongModel.output_per_million_above_272k * 100,
      ),
    );
  });

  it('applies the long-context tier before max-cost fallback admission', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);
    const result = await executeFallbackChain(
      [{ provider: 'openai', model: 'gpt-5.6-sol' }],
      { model: 'gpt-5.6-terra', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      () => 'key',
      { provider: 'openai', model: 'gpt-5.6-terra', error: 'HTTP 500' },
      {
        maxRetries: 1,
        maxCostMicrocents: 200_000_000,
        estimatedInputTokens: 272_001,
        estimatedMaxOutputTokens: 1,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.attempts).toContainEqual({
      provider: 'openai',
      model: 'gpt-5.6-sol',
      error: 'Retry budget exhausted (max_cost_microcents)',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });


  it('always reserves the unavoidable primary even when max_cost is lower', async () => {
    const result = await projectQualityCascadeReservation(
      { provider: 'openai', model: 'gpt-4.1' }, [{ provider: 'anthropic', model: 'claude-haiku-4-5' }], canonical,
      { maxRetries: 1, maxCostMicrocents: 1, estimatedInputTokens: 10, estimatedMaxOutputTokens: 20, pricingResolver: pricing },
    );
    expect(result).toEqual({ costMicrocents: 5_000 });
  });

  it('includes a circuit-open fallback because its transient state can change before dispatch', async () => {
    breaker.isOpen.mockImplementation((provider: string) => provider === 'anthropic');
    const result = await projectQualityCascadeReservation(
      { provider: 'openai', model: 'gpt-4.1' }, [
        { provider: 'openai', model: 'gpt-4.1' },
        { provider: 'anthropic', model: 'claude-haiku-4-5' },
        { provider: 'google', model: 'gemini-2.5-flash' },
      ], canonical,
      { maxRetries: 2, estimatedInputTokens: 10, estimatedMaxOutputTokens: 20, pricingResolver: pricing },
    );
    expect(result).toEqual({ costMicrocents: 15_000 });
  });

  it('reserves the maximum retry path, not the sum of mutually exclusive fallbacks', async () => {
    const result = await projectQualityCascadeReservation(
      { provider: 'openai', model: 'gpt-4.1' }, [
        { provider: 'anthropic', model: 'claude-haiku-4-5' },
        { provider: 'google', model: 'gemini-2.5-flash' },
      ], canonical,
      { maxRetries: 1, estimatedInputTokens: 10, estimatedMaxOutputTokens: 20, pricingResolver: pricing },
    );
    // Every attempt costs 5,000µ¢. At most one fallback can execute.
    expect(result).toEqual({ costMicrocents: 10_000 });
  });

  it('caps a conservative retry projection at the exact remaining max-cost capacity', async () => {
    const result = await projectQualityCascadeReservation(
      { provider: 'openai', model: 'gpt-4.1' }, [
        { provider: 'anthropic', model: 'claude-haiku-4-5' },
        { provider: 'google', model: 'gemini-2.5-flash' },
      ], canonical,
      {
        maxRetries: 2, maxCostMicrocents: 10, estimatedInputTokens: 0, estimatedMaxOutputTokens: 1,
        pricingResolver: async (provider) => provider === 'openai'
          ? { input_per_million: 0, output_per_million: 0 }
          : { input_per_million: 0, output_per_million: 0.06 },
      },
    );
    // Each fallback is 6µ¢; their total exceeds the 10µ¢ remaining capacity.
    expect(result).toEqual({ costMicrocents: 10 });
  });

  it('projects a truly unique long candidate chain without path enumeration', async () => {
    const chain = Array.from({ length: 1_000 }, (_, i) => ({
      provider: 'anthropic',
      model: `projection-candidate-${i}`,
    }));
    const result = await projectQualityCascadeReservation(
      { provider: 'openai', model: 'gpt-4.1' }, chain, canonical,
      { maxRetries: 500, estimatedInputTokens: 10, estimatedMaxOutputTokens: 20, pricingResolver: pricing },
    );
    // The first 500 unique fallbacks can execute, each at 5,000µ¢, in addition
    // to the unavoidable 5,000µ¢ primary.
    expect(result).toEqual({ costMicrocents: 2_505_000 });
    // Projection intentionally resolves each unique candidate; caching or bulk
    // resolution belongs outside this pure admission calculation.
    expect(pricing).toHaveBeenCalledTimes(1_001);
  });
});
