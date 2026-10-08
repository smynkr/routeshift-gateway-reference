import { describe, expect, it } from 'vitest';
import {
  buildModelDetail,
  buildModelsList,
  EFFECTIVE_DISPATCHABLE_CHAT_MODELS,
  EFFECTIVE_PUBLIC_MODELS,
  getRecommendedModels,
  reasoningModelOrder,
  mergeCatalogDefinitions,
} from '../src/catalog';
import { CURRENT_MODEL_FIXTURE, CURRENT_MODEL_ROLES } from '../src/current-models.generated';
import type { GeneratedCatalogModel } from '../src/generated-model-catalog';
import type { ModelDefinition } from '../src/models';
import { MODEL_REGISTRY } from '../src/models';

const generatedModel: GeneratedCatalogModel = {
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

function generated(overrides: Partial<GeneratedCatalogModel> = {}): GeneratedCatalogModel {
  return { ...generatedModel, ...overrides };
}

function autoRouteCandidates(registry: readonly ModelDefinition[]): ModelDefinition[] {
  return registry.filter((model) => model.auto_route !== false);
}

describe('effective public catalog', () => {
  it('publishes injected generated models with explicit-only metadata without routing them', () => {
    const list = buildModelsList(null, [], {}, [generatedModel]);
    const model = list.data.find((entry) => entry.id === generatedModel.canonical_name);

    expect(model).toMatchObject({
      id: 'gpt-4o-mini',
      owned_by: 'openai',
      catalog: {
        source: 'generated',
        routing: 'explicit_only',
        source_as_of: generatedModel.source_as_of,
      },
    });
    expect(autoRouteCandidates([])).not.toContainEqual(
      expect.objectContaining({ canonical_name: generatedModel.canonical_name }),
    );
  });

  it('lets curated definitions win canonical and API-ID collisions', () => {
    const curated: ModelDefinition[] = [{
      provider: 'openai',
      canonical_name: 'gpt-4o-mini',
      api_model_id: 'gpt-4o-mini',
      context_window: 16_384,
      auto_route: false,
      public: true,
    }];
    const list = buildModelsList(null, curated, {}, [generated({ context_window: 999_999 })]);

    expect(list.data.filter((entry) => entry.id === 'gpt-4o-mini')).toHaveLength(1);
    expect(list.data.find((entry) => entry.id === 'gpt-4o-mini')).toMatchObject({
      context_length: 16_384,
      catalog: { source: 'curated', routing: 'explicit_only' },
    });

    const apiCollision = generated({ canonical_name: 'generated-name', api_model_id: 'gpt-5.4' });
    const apiList = buildModelsList(null, MODEL_REGISTRY, {}, [apiCollision]);
    expect(apiList.data.map((entry) => entry.id)).not.toContain('generated-name');
    expect(apiList.data.find((entry) => entry.id === 'gpt-5.4')?.catalog?.source).toBe('curated');
  });

  it('rejects generated/generated canonical or API-ID collisions', () => {
    expect(() => buildModelsList(null, [], {}, [
      generated({ canonical_name: 'duplicate-a', api_model_id: 'duplicate-a' }),
      generated({ canonical_name: 'duplicate-b', api_model_id: 'duplicate-a' }),
    ])).toThrow(/generated.*collision/i);
  });

  it('uses one global bare-ID namespace for curated precedence and generated collisions', () => {
    const curated: ModelDefinition[] = [
      {
        provider: 'azure',
        canonical_name: 'azure-model',
        api_model_id: 'shared-api-id',
        context_window: 16_384,
      },
      {
        provider: 'openai',
        canonical_name: 'openai-model',
        api_model_id: 'openai-api-id',
        context_window: 16_384,
      },
    ];
    const generatedRows = [
      generated({ provider: 'zai', canonical_name: 'shared-api-id', api_model_id: 'zai-generated-id' }),
      generated({ provider: 'zai', canonical_name: 'openai-model', api_model_id: 'zai-other-id' }),
    ];

    expect(mergeCatalogDefinitions(curated, generatedRows)).toEqual(curated);
    expect(() => mergeCatalogDefinitions([], [
      generated({ canonical_name: 'global-a', api_model_id: 'global-b' }),
      generated({ provider: 'zai', canonical_name: 'global-c', api_model_id: 'global-a' }),
    ])).toThrow(/generated.*collision/i);
  });

  it('does not publish generated models for providers without runtime adapters', () => {
    const mistral = generated({
      provider: 'mistral',
      canonical_name: 'mistral-small-2603',
      api_model_id: 'mistral-small-2603',
    });

    expect(mergeCatalogDefinitions([], [mistral])).toEqual([]);
    const pricedMeta = generated({
      provider: 'meta',
      canonical_name: 'Llama-3.3-70B-Instruct',
      api_model_id: 'Llama-3.3-70B-Instruct',
    });
    expect(buildModelsList(null, [], {}, [pricedMeta]).data).toEqual([]);
  });

  it('detaches effective definitions and nested capability metadata from the registry', () => {
    const capability = {
      coding: 80,
      source: 'fixture',
      source_as_of: '2026-08-26',
    };
    const registry: ModelDefinition[] = [{
      provider: 'openai',
      canonical_name: 'detached-model',
      api_model_id: 'detached-model',
      context_window: 16_384,
      capability_indices: capability,
    }];
    const effective = mergeCatalogDefinitions(registry, []);
    const detached = effective[0] as ModelDefinition;

    detached.context_window = 99;
    detached.capability_indices!.coding = 1;

    expect(registry[0].context_window).toBe(16_384);
    expect(registry[0].capability_indices).toEqual(capability);
  });

  it('keeps generated models allowlist-visible only when their canonical ID is allowed', () => {
    expect(buildModelsList(null, [], {}, [generatedModel]).data.map((entry) => entry.id))
      .toContain('gpt-4o-mini');
    expect(buildModelsList(['gpt-4o-mini'], [], {}, [generatedModel]).data.map((entry) => entry.id))
      .toEqual(['gpt-4o-mini']);
    expect(buildModelsList(['other-model'], [], {}, [generatedModel]).data).toEqual([]);
  });

  it('resolves generated model details by canonical and API ID with allowlist enforcement', () => {
    const byCanonical = buildModelDetail('gpt-4o-mini', null, [], {}, [generatedModel]);
    const byApiId = buildModelDetail('gpt-4o-mini', ['gpt-4o-mini'], [], {}, [generatedModel]);

    expect(byCanonical).toMatchObject({ id: 'gpt-4o-mini', catalog: { source: 'generated' } });
    expect(byApiId?.id).toBe('gpt-4o-mini');
    expect(buildModelDetail('gpt-4o-mini', ['other-model'], [], {}, [generatedModel])).toBeNull();
  });

  it('returns recommendation IDs that exist in the effective public catalog', () => {
    const recommendations = getRecommendedModels();
    const publicIds = new Set(buildModelsList(null).data.map((model) => model.id));

    for (const id of Object.values(recommendations)) {
      expect(publicIds.has(id), `missing recommended model ${id}`).toBe(true);
    }
    expect(EFFECTIVE_PUBLIC_MODELS.length).toBeGreaterThan(0);
  });
  it('uses the newest priced GPT family and distinct role matches when recommendations disappear', () => {
    const syntheticCatalog = [
      {
        provider: 'openai',
        canonical_name: 'gpt-7.1',
        api_model_id: 'gpt-7.1',
        context_window: 1_000_000,
      },
      {
        provider: 'openai',
        canonical_name: 'gpt-7.1-sol',
        api_model_id: 'gpt-7.1-sol',
        context_window: 1_000_000,
      },
      {
        provider: 'openai',
        canonical_name: 'gpt-7.1-luna',
        api_model_id: 'gpt-7.1-luna',
        context_window: 1_000_000,
      },
      {
        provider: 'openai',
        canonical_name: 'gpt-7.1-coder',
        api_model_id: 'gpt-7.1-coder',
        context_window: 1_000_000,
      },
      {
        provider: 'openai',
        canonical_name: 'o7-reasoning',
        api_model_id: 'o7-reasoning',
        context_window: 1_000_000,
      },
    ] as const;
    const pricing = (provider: string, model: string) => ({
      provider,
      model,
      input_per_million: 1,
      output_per_million: 1,
    });

    expect(getRecommendedModels(syntheticCatalog, {
      default: 'missing-default',
      economy: 'missing-economy',
      coding: 'missing-coding',
      reasoning: 'missing-reasoning',
    }, pricing)).toEqual({
      default: 'gpt-7.1',
      economy: 'gpt-7.1-luna',
      coding: 'gpt-7.1-coder',
      reasoning: 'o7-reasoning',
    });
  });

  it('honors valid injected recommendations without reusing a role model', () => {
    const syntheticCatalog = [
      {
        provider: 'openai',
        canonical_name: 'gpt-7.1',
        api_model_id: 'gpt-7.1',
        context_window: 1_000_000,
      },
      {
        provider: 'openai',
        canonical_name: 'gpt-7.1-sol',
        api_model_id: 'gpt-7.1-sol',
        context_window: 1_000_000,
      },
      {
        provider: 'openai',
        canonical_name: 'gpt-7.1-luna',
        api_model_id: 'gpt-7.1-luna',
        context_window: 1_000_000,
      },
      {
        provider: 'openai',
        canonical_name: 'gpt-7.1-coder',
        api_model_id: 'gpt-7.1-coder',
        context_window: 1_000_000,
      },
      {
        provider: 'openai',
        canonical_name: 'o7-reasoning',
        api_model_id: 'o7-reasoning',
        context_window: 1_000_000,
      },
    ] as const;
    const pricing = (provider: string, model: string) => ({
      provider,
      model,
      input_per_million: 1,
      output_per_million: 1,
    });

    expect(getRecommendedModels(syntheticCatalog, {
      default: 'gpt-7.1-luna',
      economy: 'missing-economy',
      coding: 'gpt-7.1-sol',
      reasoning: 'missing-reasoning',
    }, pricing)).toEqual({
      default: 'gpt-7.1-luna',
      economy: 'gpt-7.1',
      coding: 'gpt-7.1-sol',
      reasoning: 'o7-reasoning',
    });
  });

  it('price-gates injected catalogs before resolving roles', () => {
    const syntheticCatalog = [
      {
        provider: 'openai',
        canonical_name: 'gpt-7.1',
        api_model_id: 'gpt-7.1',
        context_window: 1_000_000,
      },
      {
        provider: 'openai',
        canonical_name: 'gpt-7.1-luna',
        api_model_id: 'gpt-7.1-luna',
        context_window: 1_000_000,
      },
      {
        provider: 'openai',
        canonical_name: 'gpt-7.1-coder',
        api_model_id: 'gpt-7.1-coder',
        context_window: 1_000_000,
      },
      {
        provider: 'openai',
        canonical_name: 'o7-reasoning',
        api_model_id: 'o7-reasoning',
        context_window: 1_000_000,
      },
    ] as const;

    expect(() => getRecommendedModels(syntheticCatalog, undefined, () => null)).toThrow(
      /no priced models|fewer than four distinct priced models/i,
    );
  });

  it('falls back in stable code-unit order when no GPT family remains', () => {
    const syntheticCatalog = [
      {
        provider: 'zai',
        canonical_name: 'z-model',
        api_model_id: 'z-model',
        context_window: 1_000_000,
      },
      {
        provider: 'anthropic',
        canonical_name: 'a-model',
        api_model_id: 'a-model',
        context_window: 1_000_000,
      },
      {
        provider: 'google',
        canonical_name: 'g-model',
        api_model_id: 'g-model',
        context_window: 1_000_000,
      },
      {
        provider: 'openai',
        canonical_name: 'o-model',
        api_model_id: 'o-model',
        context_window: 1_000_000,
      },
    ] as const;
    const pricing = (provider: string, model: string) => ({
      provider,
      model,
      input_per_million: 1,
      output_per_million: 1,
    });

    expect(getRecommendedModels(syntheticCatalog, {
      default: 'missing-default',
      economy: 'missing-economy',
      coding: 'missing-coding',
      reasoning: 'missing-reasoning',
    }, pricing)).toEqual({
      default: 'a-model',
      economy: 'g-model',
      coding: 'o-model',
      reasoning: 'z-model',
    });
  });
  it('fails closed only when fewer than four distinct priced models remain', () => {
    const syntheticCatalog = [
      { provider: 'openai', canonical_name: 'gpt-7.1', api_model_id: 'gpt-7.1', context_window: 1_000_000 },
      { provider: 'openai', canonical_name: 'gpt-7.1-luna', api_model_id: 'gpt-7.1-luna', context_window: 1_000_000 },
      { provider: 'openai', canonical_name: 'gpt-7.1-coder', api_model_id: 'gpt-7.1-coder', context_window: 1_000_000 },
    ] as const;
    const pricing = (provider: string, model: string) => ({
      provider,
      model,
      input_per_million: 1,
      output_per_million: 1,
    });

    expect(() => getRecommendedModels(syntheticCatalog, undefined, pricing)).toThrow(
      /fewer than four distinct priced models/i,
    );
  });
  it('prefers the freshest OpenAI o-series reasoning model over provider order', () => {
    const syntheticCatalog = [
      { provider: 'openai' as const, canonical_name: 'gpt-7.1', api_model_id: 'gpt-7.1', context_window: 1_000_000 },
      { provider: 'openai' as const, canonical_name: 'gpt-7.1-luna', api_model_id: 'gpt-7.1-luna', context_window: 1_000_000 },
      { provider: 'openai' as const, canonical_name: 'gpt-7.1-coder', api_model_id: 'gpt-7.1-coder', context_window: 1_000_000 },
      { provider: 'azure' as const, canonical_name: 'o1', api_model_id: 'o1', context_window: 200_000 },
      { provider: 'openai' as const, canonical_name: 'o3', api_model_id: 'o3', context_window: 200_000 },
      { provider: 'openai' as const, canonical_name: 'o4-mini', api_model_id: 'o4-mini', context_window: 200_000 },
    ] as const;
    const pricing = (provider: string, model: string) => ({
      provider,
      model,
      input_per_million: 1,
      output_per_million: 1,
    });

    expect(getRecommendedModels(syntheticCatalog, undefined, pricing).reasoning).toBe('o4-mini');
  });
  it('prefers a stable same-family alias over a dated reasoning snapshot', () => {
    const syntheticCatalog = [
      { provider: 'openai' as const, canonical_name: 'gpt-7.1', api_model_id: 'gpt-7.1', context_window: 1_000_000 },
      { provider: 'openai' as const, canonical_name: 'gpt-7.1-luna', api_model_id: 'gpt-7.1-luna', context_window: 1_000_000 },
      { provider: 'openai' as const, canonical_name: 'gpt-7.1-coder', api_model_id: 'gpt-7.1-coder', context_window: 1_000_000 },
      { provider: 'openai' as const, canonical_name: 'o4-mini', api_model_id: 'o4-mini', context_window: 200_000 },
      { provider: 'openai' as const, canonical_name: 'o4-mini-2025-04-16', api_model_id: 'o4-mini-2025-04-16', context_window: 200_000 },
    ] as const;
    const pricing = (provider: string, model: string) => ({
      provider,
      model,
      input_per_million: 1,
      output_per_million: 1,
    });

    expect(getRecommendedModels(syntheticCatalog, undefined, pricing).reasoning).toBe('o4-mini');
  });
  it('orders dated snapshots newest first within the same reasoning base', () => {
    const snapshots: ModelDefinition[] = [
      { provider: 'openai', canonical_name: 'o3-2025-04-16', api_model_id: 'o3-2025-04-16', context_window: 200_000 },
      { provider: 'openai', canonical_name: 'o3-2025-05-01', api_model_id: 'o3-2025-05-01', context_window: 200_000 },
      { provider: 'openai', canonical_name: 'o3-2025-01-31', api_model_id: 'o3-2025-01-31', context_window: 200_000 },
    ];

    expect(snapshots.sort(reasoningModelOrder).map((model) => model.canonical_name)).toEqual([
      'o3-2025-05-01',
      'o3-2025-04-16',
      'o3-2025-01-31',
    ]);
  });
  it('keeps o-series snapshot comparisons antisymmetric and transitive', () => {
    const cohort: ModelDefinition[] = [
      { provider: 'openai', canonical_name: 'o3', api_model_id: 'o3', context_window: 200_000 },
      { provider: 'openai', canonical_name: 'o3-2025-04-16', api_model_id: 'o3-2025-04-16', context_window: 200_000 },
      { provider: 'openai', canonical_name: 'o3-mini-2025-01-31', api_model_id: 'o3-mini-2025-01-31', context_window: 200_000 },
    ];

    for (let first = 0; first < cohort.length; first += 1) {
      for (let second = first + 1; second < cohort.length; second += 1) {
        const forward = Math.sign(reasoningModelOrder(cohort[first], cohort[second]));
        const reverse = Math.sign(reasoningModelOrder(cohort[second], cohort[first]));
        expect(forward).not.toBe(0);
        expect(forward).toBe(-reverse);
      }
    }

    for (let first = 0; first < cohort.length; first += 1) {
      for (let second = 0; second < cohort.length; second += 1) {
        for (let third = 0; third < cohort.length; third += 1) {
          if (
            reasoningModelOrder(cohort[first], cohort[second]) < 0
            && reasoningModelOrder(cohort[second], cohort[third]) < 0
          ) {
            expect(reasoningModelOrder(cohort[first], cohort[third])).toBeLessThan(0);
          }
        }
      }
    }

    expect(cohort.sort(reasoningModelOrder).map((model) => model.canonical_name)).toEqual([
      'o3',
      'o3-2025-04-16',
      'o3-mini-2025-01-31',
    ]);
  });
  it('places a stable alias before dated snapshots of its exact base', () => {
    const candidates: ModelDefinition[] = [
      { provider: 'openai', canonical_name: 'o4-mini-2025-04-16', api_model_id: 'o4-mini-2025-04-16', context_window: 200_000 },
      { provider: 'openai', canonical_name: 'o4-mini', api_model_id: 'o4-mini', context_window: 200_000 },
    ];

    expect(candidates.sort(reasoningModelOrder).map((model) => model.canonical_name)).toEqual([
      'o4-mini',
      'o4-mini-2025-04-16',
    ]);
  });
  it('orders o-series reasoning models by major version before variant or freshness', () => {
    const candidates: ModelDefinition[] = [
      { provider: 'openai', canonical_name: 'o1-mini-2024-09-12', api_model_id: 'o1-mini-2024-09-12', context_window: 200_000 },
      { provider: 'openai', canonical_name: 'o4-2024-01-01', api_model_id: 'o4-2024-01-01', context_window: 200_000 },
      { provider: 'openai', canonical_name: 'o3-mini-2025-01-31', api_model_id: 'o3-mini-2025-01-31', context_window: 200_000 },
    ];

    expect(candidates.sort(reasoningModelOrder).map((model) => model.canonical_name)).toEqual([
      'o4-2024-01-01',
      'o3-mini-2025-01-31',
      'o1-mini-2024-09-12',
    ]);
  });
  it('keeps the generated role fixture aligned with the effective resolver', () => {
    const recommendations = getRecommendedModels();
    for (const role of CURRENT_MODEL_ROLES) {
      const model = EFFECTIVE_PUBLIC_MODELS.find((candidate) => candidate.canonical_name === recommendations[role]);
      expect(model).toMatchObject({
        canonical_name: CURRENT_MODEL_FIXTURE[role].canonical_name,
        provider: CURRENT_MODEL_FIXTURE[role].provider,
        context_window: CURRENT_MODEL_FIXTURE[role].context_window,
      });
    }
  });
  it('keeps public embeddings in the full catalog but out of dispatchable chat selectors', () => {
    const publicIds = new Set(EFFECTIVE_PUBLIC_MODELS.map((model) => model.canonical_name));
    const dispatchableIds = new Set(EFFECTIVE_DISPATCHABLE_CHAT_MODELS.map((model) => model.canonical_name));

    expect(publicIds.has('text-embedding-3-small')).toBe(true);
    expect(dispatchableIds.has('text-embedding-3-small')).toBe(false);
    expect(EFFECTIVE_DISPATCHABLE_CHAT_MODELS.every((model) => (
      !model.canonical_name.startsWith('text-embedding-')
    ))).toBe(true);
  });
});
