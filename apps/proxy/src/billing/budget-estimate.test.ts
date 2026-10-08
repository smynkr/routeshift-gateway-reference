import { describe, expect, it, vi } from 'vitest';
import type { CanonicalRequest } from '@routeshift/shared';

vi.mock('./credits.js', () => ({
  getCreditPricing: vi.fn(),
}));
vi.mock('../routing/fallback.js', () => ({
  projectQualityCascadeReservation: vi.fn(),
  estimateAttemptCostMicrocents: vi.fn(),
}));
vi.mock('../cost/calculator.js', () => ({
  computeRequestCostDetailed: vi.fn(),
}));

import { getCreditPricing } from './credits.js';
import { projectQualityCascadeReservation } from '../routing/fallback.js';
import { computeRequestCostDetailed } from '../cost/calculator.js';
import { estimateChatBudget, estimateEmbeddingBudget, utf8TokenUpperBound } from './budget-estimate.js';

const canonical: CanonicalRequest = {
  messages: [{ role: 'user', content: 'hello' }],
} as unknown as CanonicalRequest;

describe('estimateChatBudget', () => {
  it('covers the whole dispatchable fallback path plus plugin maximum', async () => {
    (getCreditPricing as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (projectQualityCascadeReservation as ReturnType<typeof vi.fn>).mockResolvedValue({
      costMicrocents: 1_500_000,
    });

    const estimate = await estimateChatBudget({
      originalModel: 'gpt-5.4', originalProvider: 'openai',
      provider: 'anthropic', model: 'claude-haiku-4-5', canonical,
      fallbackChain: [{ provider: 'google', model: 'gemini-2.5-flash' }],
      retryBudget: { maxRetries: 1 },
      pluginSurchargeMicrocents: 500_000,
    });

    expect(projectQualityCascadeReservation).toHaveBeenCalledWith(
      { provider: 'anthropic', model: 'claude-haiku-4-5' },
      [{ provider: 'google', model: 'gemini-2.5-flash' }],
      canonical,
      expect.objectContaining({ maxRetries: 1, pricingResolver: getCreditPricing }),
    );
    expect(estimate.estimatedMicrocents).toBe(2_000_000);
    expect(estimate.missingPricing).toBeUndefined();
  });

  it('returns estimatedMicrocents null with the missing-pricing target', async () => {
    (projectQualityCascadeReservation as ReturnType<typeof vi.fn>).mockResolvedValue({
      costMicrocents: 100,
      missingPricing: { provider: 'google', model: 'gemini-2.5-flash' },
    });

    const estimate = await estimateChatBudget({
      originalModel: 'm', originalProvider: 'openai',
      provider: 'openai', model: 'm', canonical,
      fallbackChain: [{ provider: 'google', model: 'gemini-2.5-flash' }],
      retryBudget: { maxRetries: 1 },
      pluginSurchargeMicrocents: 0,
    });

    expect(estimate.estimatedMicrocents).toBeNull();
    expect(estimate.missingPricing).toEqual({ provider: 'google', model: 'gemini-2.5-flash' });
  });

  it('has no plugin surcharge when it is zero', async () => {
    (projectQualityCascadeReservation as ReturnType<typeof vi.fn>).mockResolvedValue({
      costMicrocents: 42,
    });
    const estimate = await estimateChatBudget({
      originalModel: 'm', originalProvider: 'openai',
      provider: 'openai', model: 'm', canonical,
      fallbackChain: [],
      retryBudget: { maxRetries: 0 },
      pluginSurchargeMicrocents: 0,
    });
    expect(estimate.estimatedMicrocents).toBe(42);
  });
});

describe('utf8TokenUpperBound', () => {
  it('is conservative for dense UTF-8 scripts', () => {
    const cjk = '你好世界';
    const emoji = '😀😀';
    expect(utf8TokenUpperBound([cjk, emoji])).toBeGreaterThanOrEqual(cjk.length + emoji.length);
  });

  it('adds one token per input item', () => {
    expect(utf8TokenUpperBound(['', ''])).toBe(2);
  });
});

describe('estimateEmbeddingBudget', () => {
  it('uses input-only pricing and returns microcents when pricing exists', async () => {
    (computeRequestCostDetailed as ReturnType<typeof vi.fn>).mockResolvedValue({
      original_cost_microcents: 10,
      actual_cost_microcents: 10,
      actual_cost_known: true,
      original_cost_known: true,
      savings_microcents: 0,
    });

    const estimate = await estimateEmbeddingBudget({ provider: 'openai', model: 'text-embedding-3-small', inputTokens: 7 });

    expect(computeRequestCostDetailed).toHaveBeenCalledWith(
      'text-embedding-3-small', 'openai', 'text-embedding-3-small', 'openai',
      expect.objectContaining({ input_tokens: 7, output_tokens: 0, total_tokens: 7 }),
    );
    expect(estimate.estimatedMicrocents).toBe(10);
  });

  it('returns null when provider pricing is unknown', async () => {
    (computeRequestCostDetailed as ReturnType<typeof vi.fn>).mockResolvedValue({
      original_cost_microcents: 0,
      actual_cost_microcents: 0,
      actual_cost_known: false,
      original_cost_known: false,
      savings_microcents: 0,
    });

    const estimate = await estimateEmbeddingBudget({ provider: 'openai', model: 'unknown-embed', inputTokens: 3 });
    expect(estimate.estimatedMicrocents).toBeNull();
    expect(estimate.missingPricing).toEqual({ provider: 'openai', model: 'unknown-embed' });
  });
});
