import { describe, it, expect, vi, beforeEach } from 'vitest';

// Replace the generated table with a deterministic fixture so we can verify
// the fallthrough order in cost-tables.ts independent of the live LiteLLM
// import.
vi.mock('../src/litellm-pricing.generated', () => ({
  LITELLM_GENERATED_PRICING: [
    // Model present only in the generated table (the fallthrough case).
    { provider: 'openai', model: 'gpt-4o-mini', input_per_million: 0.15, output_per_million: 0.6 },
    // Model that ALSO exists in the hand-curated table — the override path
    // should win, so we plant a wrong price here that should never be returned.
    { provider: 'openai', model: 'gpt-5', input_per_million: 999, output_per_million: 999 },
  ],
}));

const { getModelPricing } = await import('../src/cost-tables');

describe('getModelPricing fallthrough (hand-curated → generated → null)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the hand-curated price when both sources have the entry', () => {
    const pricing = getModelPricing('openai', 'gpt-5');
    expect(pricing).not.toBeNull();
    // Hand-curated price is 1.25 / 10.0; the mocked generated entry has 999 / 999.
    expect(pricing!.input_per_million).toBe(1.25);
    expect(pricing!.output_per_million).toBe(10.0);
  });

  it('falls through to the generated table when only the generated table has the entry', () => {
    const pricing = getModelPricing('openai', 'gpt-4o-mini');
    expect(pricing).not.toBeNull();
    expect(pricing!.input_per_million).toBe(0.15);
    expect(pricing!.output_per_million).toBe(0.6);
  });

  it('returns null when neither table has the entry', () => {
    const pricing = getModelPricing('openai', 'definitely-not-a-real-model-xyz');
    expect(pricing).toBeNull();
  });
});
