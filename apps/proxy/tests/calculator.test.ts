import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getModelPricing, calculateCostMicrocents } from '@routeshift/shared';

// Mock the DB pricing module — must use the path as imported by calculator.ts
const mockGetDbPricing = vi.fn();
vi.mock('../src/cost/pricing-db.js', () => ({
  getDbPricing: (...args: unknown[]) => mockGetDbPricing(...args),
}));

const mockCaptureException = vi.fn();
vi.mock('../src/observability/sentry.js', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

import { computeRequestCost, computeRequestCostDetailed } from '../src/cost/calculator.js';

const usage = { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 };

describe('computeRequestCost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDbPricing.mockResolvedValue(null); // default: no DB override
  });

  // Sanity-check that the @routeshift/shared module is working
  it('shared module sanity check', () => {
    const pricing = getModelPricing('openai', 'gpt-4.1');
    expect(pricing).not.toBeNull();
    expect(pricing!.input_per_million).toBe(2.0);

    const cost = calculateCostMicrocents(usage, pricing!);
    expect(cost.total).toBe(600000);
  });

  // Note: computeRequestCost signature is (modelRequested, providerRequested, modelResolved, providerResolved, usage)

  it('with static pricing (no DB override), correct microcents', async () => {
    const result = await computeRequestCost(
      'gpt-4.1', 'openai',   // requested (model, provider)
      'gpt-4.1', 'openai',   // resolved (same)
      usage,
    );

    // input: 1000 * 2.0 * 100 = 200000, output: 500 * 8.0 * 100 = 400000
    expect(result.original_cost_microcents).toBe(600000);
    expect(result.actual_cost_microcents).toBe(600000);
    expect(result.actual_cost_known).toBe(true);
    expect(result.savings_microcents).toBe(0);
  });

  it('with DB pricing override, uses DB values', async () => {
    mockGetDbPricing.mockImplementation(async (provider: string, model: string) => {
      if (provider === 'openai' && model === 'gpt-4.1') {
        return { provider: 'openai', model: 'gpt-4.1', input_per_million: 1.5, output_per_million: 6.0 };
      }
      return null;
    });

    const result = await computeRequestCost(
      'gpt-4.1', 'openai',
      'gpt-4.1', 'openai',
      usage,
    );

    // input: 1000 * 1.5 * 100 = 150000, output: 500 * 6.0 * 100 = 300000
    expect(result.original_cost_microcents).toBe(450000);
    expect(result.actual_cost_microcents).toBe(450000);
  });
  it('settles the same long-context tier used by admission above 272K prompt tokens', async () => {
    const result = await computeRequestCost(
      'gpt-5.6-sol',
      'openai',
      'gpt-5.6-sol',
      'openai',
      { input_tokens: 272_001, output_tokens: 1, total_tokens: 272_002 },
    );

    expect(result.actual_cost_microcents).toBe(
      Math.round(272_001 * 8 * 100) + Math.round(1 * 30 * 100),
    );
    expect(result.actual_cost_known).toBe(true);
  });


  it('DB unavailable falls back to static pricing', async () => {
    // getDbPricing returns null when DB is unavailable
    mockGetDbPricing.mockResolvedValue(null);

    const result = await computeRequestCost(
      'gpt-4.1', 'openai',
      'claude-haiku-4-5', 'anthropic',
      usage,
    );

    // Original: gpt-4.1 static pricing: 1000*2.0*100 + 500*8.0*100 = 200000+400000 = 600000
    // Actual: claude-haiku-4-5 static pricing: 1000*1.0*100 + 500*5.0*100 = 100000+250000 = 350000
    expect(result.original_cost_microcents).toBe(600000);
    expect(result.actual_cost_microcents).toBe(350000);
  });

  it('original cost > actual cost produces savings', async () => {
    const result = await computeRequestCost(
      'gpt-4.1', 'openai',          // expensive
      'gpt-4.1-mini', 'openai',     // cheaper
      usage,
    );

    // Original: 1000*2.0*100 + 500*8.0*100 = 600000
    // Actual: 1000*0.4*100 + 500*1.6*100 = 40000 + 80000 = 120000
    expect(result.original_cost_microcents).toBe(600000);
    expect(result.actual_cost_microcents).toBe(120000);
    expect(result.savings_microcents).toBe(480000);
    expect(result.savings_microcents).toBeGreaterThan(0);
  });

  it('original cost < actual cost produces negative savings (cost increase)', async () => {
    const result = await computeRequestCost(
      'gpt-4.1-mini', 'openai',     // cheaper
      'gpt-4.1', 'openai',          // more expensive
      usage,
    );

    // Original: 120000, Actual: 600000
    // The code computes originalCost - actualCost = 120000 - 600000 = -480000
    // Note: the source code does NOT clamp to zero -- it returns the raw difference
    expect(result.savings_microcents).toBe(-480000);
  });

  it('reports reasoning output cost separately from total actual cost', async () => {
    const result = await computeRequestCost(
      'gpt-4.1', 'openai',
      'gpt-4.1', 'openai',
      { ...usage, reasoning_tokens: 100 },
    );

    expect(result).toMatchObject({
      actual_cost_microcents: 600000,
      reasoning_cost_microcents: 80000,
    });
    expect(result.actual_cost_microcents).not.toBe(result.reasoning_cost_microcents);
  });
  it('uses the original prompt size to price reasoning output in the long tier', async () => {
    const result = await computeRequestCost(
      'gpt-5.6-sol', 'openai',
      'gpt-5.6-sol', 'openai',
      {
        input_tokens: 272_001,
        output_tokens: 500,
        total_tokens: 272_501,
        reasoning_tokens: 100,
      },
    );

    expect(result.reasoning_cost_microcents).toBe(300_000);
    expect(result.actual_cost_microcents).toBe(
      Math.round(272_001 * 8 * 100) + Math.round(500 * 30 * 100),
    );
  });


  it('marks reasoning output cost unknown when resolved pricing is missing', async () => {
    const result = await computeRequestCost(
      'gpt-4.1', 'openai',
      'unpriced-reasoning-resolved', 'openai',
      { ...usage, reasoning_tokens: 100 },
    );

    expect(result).toHaveProperty('reasoning_cost_microcents', null);
  });

  // M3 (money-path hardening): a pricing gap bills $0 outside credits mode, so
  // it must page via Sentry — once per provider:model pair, not per request.
  // Model names are unique per test because the dedupe Set is module-level.
  describe('missing-pricing Sentry alert', () => {
    it('unpriced resolved model: cost 0, alert fired once with resolved tag, deduped on repeat', async () => {
      const first = await computeRequestCost(
        'gpt-4.1', 'openai',
        'unpriced-m3-resolved', 'openai',
        usage,
      );
      expect(first.actual_cost_microcents).toBe(0);
      expect(first.actual_cost_known).toBe(false);
      expect(first.savings_microcents).toBe(0);
      expect(mockCaptureException).toHaveBeenCalledTimes(1);
      const [err, ctx] = mockCaptureException.mock.calls[0];
      expect((err as Error).message).toContain('missing_model_pricing: openai:unpriced-m3-resolved');
      expect(ctx.tags).toMatchObject({
        component: 'cost-calculator',
        provider: 'openai',
        model: 'unpriced-m3-resolved',
        pricing_side: 'resolved',
      });

      // Same unpriced pair again → warn still happens, but no second Sentry event.
      await computeRequestCost('gpt-4.1', 'openai', 'unpriced-m3-resolved', 'openai', usage);
      expect(mockCaptureException).toHaveBeenCalledTimes(1);
    });

    it('unpriced requested model: alert tagged with the requested side', async () => {
      await computeRequestCost(
        'unpriced-m3-requested', 'openai',
        'gpt-4.1', 'openai',
        usage,
      );
      expect(mockCaptureException).toHaveBeenCalledTimes(1);
      expect(mockCaptureException.mock.calls[0][1].tags).toMatchObject({
        model: 'unpriced-m3-requested',
        pricing_side: 'requested',
      });
    });

    it('fully priced request never alerts', async () => {
      await computeRequestCost('gpt-4.1', 'openai', 'gpt-4.1-mini', 'openai', usage);
      expect(mockCaptureException).not.toHaveBeenCalled();
    });
  });
});

describe('computeRequestCostDetailed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDbPricing.mockResolvedValue(null);
  });

  it('distinguishes a priced zero-cost request from missing pricing without returning pricing data', async () => {
    mockGetDbPricing.mockImplementation(async (provider: string, model: string) => (
      provider === 'openai' && model === 'priced-zero-detail'
        ? { provider, model, input_per_million: 0, output_per_million: 0 }
        : null
    ));

    const detailed = await computeRequestCostDetailed(
      'priced-zero-detail', 'openai', 'priced-zero-detail', 'openai', usage,
    );

    expect(detailed).toEqual({
      original_cost_microcents: 0,
      original_cost_known: true,
      actual_cost_microcents: 0,
      actual_cost_known: true,
      savings_microcents: 0,
    });
    expect(detailed).not.toHaveProperty('original_pricing');
    expect(detailed).not.toHaveProperty('actual_pricing');
  });

  it('marks a missing resolved price unknown even though its numeric lower bound is zero', async () => {
    const detailed = await computeRequestCostDetailed(
      'gpt-4.1', 'openai', 'unpriced-detail-resolved', 'openai', usage,
    );

    expect(detailed).toMatchObject({
      original_cost_microcents: 600_000,
      original_cost_known: true,
      actual_cost_microcents: 0,
      actual_cost_known: false,
      savings_microcents: 0,
    });
  });

  it('marks a missing requested price unknown without changing the resolved exact cost', async () => {
    const detailed = await computeRequestCostDetailed(
      'unpriced-detail-requested', 'openai', 'gpt-4.1', 'openai', usage,
    );

    expect(detailed).toMatchObject({
      original_cost_microcents: 0,
      original_cost_known: false,
      actual_cost_microcents: 600_000,
      actual_cost_known: true,
      savings_microcents: 0,
    });
  });

  it('keeps computeRequestCost on its legacy result shape', async () => {
    const legacy = await computeRequestCost('gpt-4.1', 'openai', 'gpt-4.1', 'openai', usage);

    expect(legacy).not.toHaveProperty('original_cost_known');
    expect(legacy).toEqual({
      original_cost_microcents: 600_000,
      actual_cost_microcents: 600_000,
      actual_cost_known: true,
      savings_microcents: 0,
    });
  });
});
