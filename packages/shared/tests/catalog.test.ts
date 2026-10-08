import { describe, expect, it } from 'vitest';
import { buildModelsList, buildModelDetail, getRecommendedModels, selectModels } from '../src/catalog';
import { EMBEDDING_MODELS } from '../src/embedding-models';
import type { EmbeddingModel } from '../src/embedding-models';
import { getModelPricing } from '../src/cost-tables';
import type { ModelDefinition } from '../src/models';
import type { GeneratedCatalogModel } from '../src/generated-model-catalog';

describe('buildModelsList', () => {
  it('returns an OpenAI-shaped list with pricing + endpoints', () => {
    const list = buildModelsList(null);
    expect(list.object).toBe('list');
    expect(Array.isArray(list.data)).toBe(true);
    const opus = list.data.find((m) => m.id === 'claude-opus-4-8');
    expect(opus).toBeDefined();
    expect(opus!.object).toBe('model');
    expect(opus!.owned_by).toBe('anthropic');
    const pricing = getModelPricing('anthropic', 'claude-opus-4-8')!;
    expect(opus!.pricing.prompt).toBe(String(pricing.input_per_million / 1e6));
    expect(opus!.pricing.completion).toBe(String(pricing.output_per_million / 1e6));
    expect(opus!.endpoints[0].provider).toBe('anthropic');
    expect(opus!.endpoints[0].data_policy).toEqual({ zdr: false });
  });

  it('filters to allowedModels when provided', () => {
    const list = buildModelsList(['gpt-5.4']);
    expect(list.data.map((m) => m.id)).toEqual(['gpt-5.4']);
  });

  it('surfaces provider endpoint fanout and data policy from the shared endpoint registry', () => {
    const list = buildModelsList(['gpt-5.5']);
    const model = list.data[0];

    expect(model.id).toBe('gpt-5.5');
    expect(model.endpoints.map((endpoint) => ({ provider: endpoint.provider, zdr: endpoint.data_policy.zdr }))).toEqual([
      { provider: 'openai', zdr: false },
      { provider: 'azure', zdr: true },
    ]);
  });

  it('surfaces corrected standard API context windows from the shared registry', () => {
    const list = buildModelsList(null);
    const byId = new Map(list.data.map((m) => [m.id, m]));

    expect(byId.get('gpt-5.5')?.context_length).toBe(1_000_000);
    expect(byId.get('gpt-5.4-mini')?.context_length).toBe(400_000);
    expect(byId.get('mimo-v2.5-pro')?.context_length).toBe(1_000_000);
    expect(byId.get('qwen3.7-max')?.context_length).toBe(262_144);
    expect(byId.get('qwen3.7-plus')?.context_length).toBe(1_000_000);
    expect(byId.get('qwen3.6-flash')?.context_length).toBe(1_000_000);
  });

  it('includes supported embedding models in the public catalog', () => {
    const list = buildModelsList(null);
    const ids = list.data.map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(Object.keys(EMBEDDING_MODELS)));

    const small = list.data.find((m) => m.id === 'text-embedding-3-small');
    const pricing = getModelPricing('openai', 'text-embedding-3-small')!;
    expect(small?.owned_by).toBe('openai');
    expect(small?.pricing.prompt).toBe(String(pricing.input_per_million / 1e6));
    expect(small?.pricing.completion).toBe('0');
    expect(small?.architecture).toEqual({
      modality: 'text->embedding',
      input_modalities: ['text'],
      output_modalities: ['embedding'],
    });
  });

  it('filters embedding models to allowedModels when provided', () => {
    const list = buildModelsList(['text-embedding-3-small']);
    expect(list.data.map((m) => m.id)).toEqual(['text-embedding-3-small']);
  });

  it('excludes non-public embedding models from the public catalog', () => {
    const embeddings: Record<string, EmbeddingModel> = {
      'text-embedding-3-small': { ...EMBEDDING_MODELS['text-embedding-3-small'], public: false },
    };
    expect(buildModelsList(null, [], embeddings, []).data.map((m) => m.id)).toEqual([]);
    expect(buildModelsList(['text-embedding-3-small'], [], embeddings, []).data.map((m) => m.id)).toEqual([
      'text-embedding-3-small',
    ]);
  });

  it('publishes generated models with catalog-only routing metadata', () => {
    const generated: GeneratedCatalogModel = {
      provider: 'openai',
      canonical_name: 'gpt-4o-mini',
      api_model_id: 'gpt-4o-mini',
      context_window: 128_000,
      source: 'generated',
      public: true,
      explicit_only: true,
      auto_route: false,
      source_url: 'https://example.test/litellm.json',
      source_hash: 'fixture-hash',
      source_as_of: '2026-08-26T12:00:00.000Z',
    };
    const model = buildModelsList(null, [], {}, [generated]).data[0];

    expect(model).toMatchObject({
      id: 'gpt-4o-mini',
      object: 'model',
      owned_by: 'openai',
      catalog: {
        source: 'generated',
        routing: 'explicit_only',
        source_as_of: '2026-08-26T12:00:00.000Z',
      },
    });
    expect(model).not.toHaveProperty('explicit_only');
  });

  it('derives curated routing metadata from the auto_route flag', () => {
    expect(buildModelsList(['gpt-5']).data[0].catalog).toEqual({
      source: 'curated',
      routing: 'explicit_only',
    });
    expect(buildModelsList(['gpt-5.4']).data[0].catalog).toEqual({
      source: 'curated',
      routing: 'auto_or_explicit',
    });
  });

  it('recommends Cloudflare GLM-5.3 while keeping GLM-5.2 legacy-only', () => {
    const current = buildModelsList(['@cf/zai-org/glm-5.3-flash']).data[0];
    const legacy = buildModelsList(['glm-5.2']).data[0];

    expect(current).toMatchObject({
      id: '@cf/zai-org/glm-5.3-flash',
      owned_by: 'cloudflare-workers-ai',
      context_length: 1_048_576,
      pricing: {
        prompt: String(0.15 / 1e6),
        completion: String(0.5 / 1e6),
        cache_read: String(0.03 / 1e6),
        cache_write: '0',
      },
      catalog: { source: 'curated', routing: 'auto_or_explicit' },
    });
    expect(legacy).toMatchObject({
      id: 'glm-5.2',
      owned_by: 'neuralwatt',
      context_length: 1_048_560,
      pricing: {
        prompt: String(1.45 / 1e6),
        completion: String(4.5 / 1e6),
        cache_read: String(0.145 / 1e6),
        cache_write: '0',
      },
      catalog: { source: 'curated', routing: 'explicit_only' },
    });
    const recommendations = getRecommendedModels();
    expect(recommendations.default).toBe('@cf/zai-org/glm-5.3-flash');
    const publicModels = buildModelsList(null).data;
    const defaultModel = publicModels.find((model) => model.id === recommendations.default);
    const economyModel = publicModels.find((model) => model.id === recommendations.economy);
    expect(defaultModel).toBeDefined();
    expect(economyModel).toBeDefined();
    const defaultPricing = getModelPricing(defaultModel!.owned_by, defaultModel!.id)!;
    const economyPricing = getModelPricing(economyModel!.owned_by, economyModel!.id)!;
    expect(economyPricing.input_per_million + economyPricing.output_per_million)
      .toBeLessThanOrEqual(defaultPricing.input_per_million + defaultPricing.output_per_million);
  });

  it('uses the provider data-policy fallback for endpoint rows without explicit endpoints', () => {
    const model = buildModelsList(
      ['gpt-4o'],
      [{
        provider: 'azure',
        canonical_name: 'gpt-4o',
        api_model_id: 'gpt-4o',
        context_window: 128_000,
      }],
      {},
      [],
    ).data[0];

    expect(model?.endpoints).toEqual([expect.objectContaining({
      provider: 'azure',
      data_policy: { zdr: true },
    })]);
  });

  it('publishes long-context threshold and input/output rates in catalog pricing', () => {
    const model = buildModelsList(['gpt-5.4']).data[0];

    expect(model?.pricing).toMatchObject({
      long_context_threshold: 272_000,
      input_above_272k: String(5 / 1e6),
      output_above_272k: String(22.5 / 1e6),
    });
  });

});
describe('buildModelDetail', () => {
  it('returns a single model item', () => {
    const m = buildModelDetail('gpt-5.4', null);
    expect(m?.id).toBe('gpt-5.4');
    expect(m?.object).toBe('model');
  });
  it('resolves a lookup by api_model_id to its canonical id', () => {
    // claude-opus-4-6 has api_model_id 'claude-opus-4-6-20250219'
    const m = buildModelDetail('claude-opus-4-6-20250219', null);
    expect(m?.id).toBe('claude-opus-4-6');
  });
  it('resolves OpenAI embedding model details', () => {
    const m = buildModelDetail('text-embedding-3-small', null);
    expect(m?.id).toBe('text-embedding-3-small');
    expect(m?.owned_by).toBe('openai');
    expect(m?.architecture?.output_modalities).toEqual(['embedding']);
    expect(m?.endpoints[0].api_model_id).toBe('text-embedding-3-small');
  });
  it('resolves Google embedding model details with paid-tier pricing', () => {
    const m = buildModelDetail('text-embedding-004', null);
    expect(m?.id).toBe('text-embedding-004');
    expect(m?.owned_by).toBe('google');
    expect(m?.pricing.prompt).toBe(String(0.025 / 1e6));
    expect(m?.pricing.completion).toBe('0');
  });
  it('returns null for unknown id', () => {
    expect(buildModelDetail('does-not-exist', null)).toBeNull();
  });
  it('returns null for an out-of-scope model under an allowlist', () => {
    expect(buildModelDetail('claude-opus-4-8', ['gpt-5.4'])).toBeNull();
  });
});

describe('selectModels public/allowlist filtering', () => {
  const synthetic: ModelDefinition[] = [
    { provider: 'openai', canonical_name: 'pub-model', api_model_id: 'pub-model', context_window: 1000 },
    { provider: 'openai', canonical_name: 'preview-model', api_model_id: 'preview-model', context_window: 1000, public: false },
  ];
  it('excludes public:false from the unauthenticated (null) catalog', () => {
    const ids = selectModels(synthetic, null).map((m) => m.canonical_name);
    expect(ids).toEqual(['pub-model']);
  });
  it('includes a public:false model when an allowlist explicitly scopes it', () => {
    const ids = selectModels(synthetic, ['preview-model']).map((m) => m.canonical_name);
    expect(ids).toEqual(['preview-model']);
  });
});
