import { describe, expect, it } from 'vitest';
import { MODEL_ENDPOINTS, PROVIDER_DATA_POLICY, getModelEndpoints } from '../src/provider-endpoints';
import { MODEL_REGISTRY } from '../src/models';

describe('provider endpoints and data policy', () => {
  it('does not expose retired hosted endpoints for parked Llama 3.1', () => {
    expect(MODEL_ENDPOINTS['llama-3.1-70b']).toBeUndefined();
    expect(getModelEndpoints('llama-3.1-70b')).toEqual([]);
  });

  it('keeps llama-3.1-70b parked in the non-public model catalog', async () => {
    const { MODEL_REGISTRY } = await import('../src/models');
    expect(MODEL_REGISTRY).toContainEqual(
      expect.objectContaining({
        provider: 'meta',
        canonical_name: 'llama-3.1-70b',
        api_model_id: 'llama-3.1-70b',
        auto_route: false,
      }),
    );
  });

  it('returns a defensive copy of endpoint arrays', () => {
    const endpoints = getModelEndpoints('llama-3.1-70b');
    endpoints.push({ provider: 'openai', model: 'bad', zdr: false });

    expect(getModelEndpoints('llama-3.1-70b')).toEqual([]);
  });

  it('maps GPT 5.x models to direct OpenAI and ZDR Azure endpoints', () => {
    expect(getModelEndpoints('gpt-5.5')).toEqual([
      { provider: 'openai', model: 'gpt-5.5', zdr: false, throughput_hint: 0.8 },
      { provider: 'azure', model: 'gpt-5.5', zdr: true, throughput_hint: 0.8 },
    ]);
    expect(getModelEndpoints('gpt-5.4-mini').map((endpoint) => endpoint.provider)).toEqual(['openai', 'azure']);
  });

  it('keeps GPT-5.6 alias and promoted endpoints explicit-only (official provider pages verified 2026-08-26)', () => {
    const byName = Object.fromEntries(
      MODEL_REGISTRY.map((model) => [model.canonical_name, model]),
    ) as Record<string, (typeof MODEL_REGISTRY)[number] | undefined>;
    expect(byName['gpt-5.6']).toMatchObject({
      provider: 'openai',
      api_model_id: 'gpt-5.6-sol',
      auto_route: false,
      public: true,
    });
    for (const modelName of ['gemini-3.7-flash', 'kimi-k3', 'qwen3.8-max'] as const) {
      expect(byName[modelName]).toMatchObject({
        api_model_id: modelName,
        auto_route: false,
        public: true,
      });
    }
    expect(getModelEndpoints('gpt-5.6')).toEqual([]);
  });

  it('tracks provider ZDR policy for data_collection=deny routing', () => {
    expect(PROVIDER_DATA_POLICY.azure.zdr).toBe(true);
    expect(PROVIDER_DATA_POLICY.openai.zdr).toBe(false);
    expect(PROVIDER_DATA_POLICY.anthropic.zdr).toBe(false);
  });
});
