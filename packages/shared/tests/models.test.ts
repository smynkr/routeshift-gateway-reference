import { describe, it, expect } from 'vitest';
import { getModelContextWindow, MODEL_REGISTRY, PROVIDERS, type Provider } from '../src/models';
import { getModelSource } from '../src/model-sources';

describe('models', () => {
  it('MODEL_REGISTRY is a non-empty array', () => {
    expect(Array.isArray(MODEL_REGISTRY)).toBe(true);
    expect(MODEL_REGISTRY.length).toBeGreaterThan(0);
  });

  it('every model has required fields (provider, canonical_name, api_model_id, context_window)', () => {
    for (const model of MODEL_REGISTRY) {
      expect(model.provider).toBeDefined();
      expect(typeof model.provider).toBe('string');
      expect(model.provider.length).toBeGreaterThan(0);

      expect(model.canonical_name).toBeDefined();
      expect(typeof model.canonical_name).toBe('string');
      expect(model.canonical_name.length).toBeGreaterThan(0);

      expect(model.api_model_id).toBeDefined();
      expect(typeof model.api_model_id).toBe('string');
      expect(model.api_model_id.length).toBeGreaterThan(0);

      expect(model.context_window).toBeDefined();
      expect(typeof model.context_window).toBe('number');
      expect(model.context_window).toBeGreaterThan(0);
    }
  });

  it('every model provider is in the PROVIDERS tuple', () => {
    const providerSet = new Set<string>(PROVIDERS);
    for (const model of MODEL_REGISTRY) {
      expect(providerSet.has(model.provider)).toBe(true);
    }
  });

  it('no duplicate canonical_name values', () => {
    const names = MODEL_REGISTRY.map((m) => m.canonical_name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  it('no duplicate api_model_id values', () => {
    const ids = MODEL_REGISTRY.map((m) => m.api_model_id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('PROVIDERS contains expected entries (openai, anthropic, google, native frontier providers)', () => {
    const providerList: readonly string[] = PROVIDERS;
    expect(providerList).toContain('openai');
    expect(providerList).toContain('anthropic');
    expect(providerList).toContain('google');
    expect(providerList).toContain('xai');
    expect(providerList).toContain('deepseek');
    expect(providerList).toContain('mistral');
    expect(providerList).toContain('meta');
  });

  it('registers the Cloudflare GLM-5.3 model and keeps GLM-5.2 as NeuralWatt legacy', () => {
    expect(PROVIDERS).toContain('cloudflare-workers-ai');
    expect(PROVIDERS).toContain('neuralwatt');

    const current = MODEL_REGISTRY.find((model) => model.canonical_name === '@cf/zai-org/glm-5.3-flash');
    expect(current).toMatchObject({
      provider: 'cloudflare-workers-ai',
      api_model_id: '@cf/zai-org/glm-5.3-flash',
      context_window: 1_048_576,
      auto_route: true,
      public: true,
      legacy: false,
      recommended: true,
    });

    const legacyNames = ['glm-5.2', 'glm-5.2-fast', 'glm-5.2-short', 'glm-5.2-short-fast', 'glm-5.2-short-fast-flex'];
    for (const name of legacyNames) {
      const contextWindow = name.includes('-short') ? 199_984 : 1_048_560;
      expect(MODEL_REGISTRY.find((model) => model.canonical_name === name), name).toMatchObject({
        provider: 'neuralwatt',
        api_model_id: name,
        context_window: contextWindow,
        auto_route: false,
        public: true,
        legacy: true,
        recommended: false,
      });
    }

    expect(getModelSource('cloudflare-workers-ai')).toMatchObject({
      models_url: 'https://developers.cloudflare.com/workers-ai/models/glm-5.3-flash/',
      pricing_urls: expect.arrayContaining([
        'https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/',
      ]),
    });
    expect(getModelSource('neuralwatt')).toMatchObject({
      models_url: 'https://api.neuralwatt.com/v1/models',
      pricing_urls: ['https://api.neuralwatt.com/v1/models'],
      last_verified: '2026-08-29',
    });
  });

  it('PROVIDERS is a non-empty tuple', () => {
    expect(PROVIDERS.length).toBeGreaterThan(0);
  });

  it('at least one model exists per expected frontier provider', () => {
    // azure remains a valid provider (alias/deployment + list pricing) but no
    // longer carries default registry entries; the GPT 5.x models are canonical
    // openai now.
    const expectedProviders: Provider[] = ['openai', 'anthropic', 'google'];
    for (const provider of expectedProviders) {
      const models = MODEL_REGISTRY.filter((m) => m.provider === provider);
      expect(models.length).toBeGreaterThan(0);
    }
  });

  it('exposes the current OpenAI GPT 5.x frontier (incl. premium gpt-5.5-pro) as auto-routable openai models', () => {
    const gpt54 = MODEL_REGISTRY.find((m) => m.canonical_name === 'gpt-5.4');
    const gpt55 = MODEL_REGISTRY.find((m) => m.canonical_name === 'gpt-5.5');
    const pro = MODEL_REGISTRY.find((m) => m.canonical_name === 'gpt-5.5-pro');

    expect(gpt54?.provider).toBe('openai');
    expect(gpt55?.provider).toBe('openai');
    expect(pro?.provider).toBe('openai');
    // auto_route omitted ⇒ enabled; assert it's not explicitly disabled.
    expect(gpt54?.auto_route).not.toBe(false);
    expect(gpt55?.auto_route).not.toBe(false);
    expect(getModelContextWindow('gpt-5.5')).toBe(1_000_000);
    expect(getModelContextWindow('gpt-5.5-pro')).toBe(1_000_000);
    expect(getModelContextWindow('gpt-5.4')).toBe(1_000_000);
    expect(getModelContextWindow('gpt-5.4-mini')).toBe(400_000);
    expect(getModelContextWindow('gpt-5.4-nano')).toBe(400_000);
  });

  it('pins official GPT-5.6 alias and variants as explicit-only OpenAI models (OpenAI docs verified 2026-08-26)', () => {
    const byName = Object.fromEntries(
      MODEL_REGISTRY.map((model) => [model.canonical_name, model]),
    ) as Record<string, (typeof MODEL_REGISTRY)[number] | undefined>;

    expect(byName['gpt-5.6']).toMatchObject({
      provider: 'openai',
      api_model_id: 'gpt-5.6-sol',
      context_window: 1_050_000,
      auto_route: false,
      public: true,
    });
    expect(byName['gpt-5.6-sol']).toBeUndefined();
    for (const modelName of ['gpt-5.6-terra', 'gpt-5.6-luna'] as const) {
      expect(byName[modelName]).toMatchObject({
        provider: 'openai',
        api_model_id: modelName,
        context_window: 1_050_000,
        auto_route: false,
        public: true,
      });
    }

    expect(getModelContextWindow('gpt-5.6')).toBe(1_050_000);
    expect(getModelContextWindow('gpt-5.6-sol')).toBe(1_050_000);
    expect(getModelContextWindow('gpt-5.6-terra')).toBe(1_050_000);
    expect(getModelContextWindow('gpt-5.6-luna')).toBe(1_050_000);

    const source = getModelSource('openai');
    expect(source?.models_url).toBe('https://developers.openai.com/api/docs/models');
    expect(source?.pricing_urls).toEqual(expect.arrayContaining([
      'https://developers.openai.com/api/docs/pricing',
      'https://developers.openai.com/api/docs/models/gpt-5.6-sol',
      'https://developers.openai.com/api/docs/models/gpt-5.6-terra',
      'https://developers.openai.com/api/docs/models/gpt-5.6-luna',
    ]));
  });

  it('curates only verified frontier models with existing explicit provider adapters (official pages verified 2026-08-26)', () => {
    const byName = Object.fromEntries(
      MODEL_REGISTRY.map((model) => [model.canonical_name, model]),
    ) as Record<string, (typeof MODEL_REGISTRY)[number] | undefined>;

    expect(byName['gemini-3.7-flash']).toMatchObject({
      provider: 'google',
      api_model_id: 'gemini-3.7-flash',
      context_window: 1_048_576,
      auto_route: false,
      public: true,
      supports_native_pdf: true,
    });
    expect(byName['gemini-2.5-flash-lite']).toMatchObject({
      provider: 'google',
      context_window: 1_048_576,
      auto_route: false,
      public: true,
    });
    expect(byName['gemini-3.5-flash-lite']).toMatchObject({
      provider: 'google',
      context_window: 1_048_576,
      auto_route: false,
      public: true,
    });
    expect(byName['kimi-k3']).toMatchObject({
      provider: 'moonshot',
      api_model_id: 'kimi-k3',
      context_window: 1_048_576,
      auto_route: false,
      public: true,
    });
    expect(byName['qwen3.8-max']).toMatchObject({
      provider: 'qwen',
      api_model_id: 'qwen3.8-max',
      context_window: 1_000_000,
      auto_route: false,
      public: true,
    });
  });

  it('does not auto-route official candidates without a compatible existing adapter', () => {
    const byName = Object.fromEntries(
      MODEL_REGISTRY.map((model) => [model.canonical_name, model]),
    ) as Record<string, (typeof MODEL_REGISTRY)[number] | undefined>;
    expect(byName['gpt-5.6-cyber']).toMatchObject({
      provider: 'openai',
      context_window: 400_000,
      auto_route: false,
      public: false,
    });
    expect(byName['grok-4.6']).toBeUndefined();
    expect(byName['grok-4.20-0309-reasoning']).toMatchObject({
      provider: 'xai',
      auto_route: false,
      public: false,
    });
    expect(byName['mistral-small-2603']).toBeUndefined();
    for (const modelName of ['kimi-k2.6', 'kimi-k2.7-code'] as const) {
      expect(byName[modelName]).toMatchObject({
        provider: 'moonshot',
        auto_route: false,
        public: false,
      });
    }
  });

  it('uses standard API context windows for MiMo and Qwen commercial models', () => {
    const byName = new Map(MODEL_REGISTRY.map((m) => [m.canonical_name, m]));

    expect(byName.get('mimo-v2.5-pro')).toMatchObject({
      provider: 'xiaomi',
      context_window: 1_000_000,
      auto_route: false,
    });
    expect(byName.get('mimo-v2-flash')).toMatchObject({
      provider: 'xiaomi',
      context_window: 128_000,
      auto_route: false,
    });
    expect(byName.get('qwen3.7-max')).toMatchObject({ provider: 'qwen', context_window: 262_144 });
    expect(byName.get('qwen3.7-plus')).toMatchObject({ provider: 'qwen', context_window: 1_000_000 });
    expect(byName.get('qwen3.6-flash')).toMatchObject({ provider: 'qwen', context_window: 1_000_000 });
  });

  it('includes GA Opus 4.8/4.7 and still excludes the never-shipped Sonnet 4.7', () => {
    const names = MODEL_REGISTRY.map((m) => m.canonical_name);
    expect(names).toContain('claude-opus-4-8');
    expect(names).toContain('claude-opus-4-7');
    expect(names).not.toContain('claude-sonnet-4-7');
  });

  it('includes native-provider frontier model registry entries', () => {
    const byName = new Map(MODEL_REGISTRY.map((m) => [m.canonical_name, m]));

    expect(byName.get('MiniMax-M2')).toMatchObject({ provider: 'minimax', api_model_id: 'MiniMax-M2' });
    expect(byName.get('kimi-k2.6')).toMatchObject({ provider: 'moonshot', api_model_id: 'kimi-k2.6' });
    expect(byName.get('kimi-k2.7-code')).toMatchObject({ provider: 'moonshot', api_model_id: 'kimi-k2.7-code' });
    expect(byName.get('Qwen3-Coder-480B-A35B-Instruct')).toMatchObject({ provider: 'qwen' });
    expect(byName.get('gpt-oss-120b')).toMatchObject({ provider: 'openai' });
    expect(byName.get('grok-4.20-reasoning')).toMatchObject({ provider: 'xai' });
    expect(byName.get('deepseek-v3.2')).toMatchObject({ provider: 'deepseek' });
    expect(byName.get('mistral-medium-3')).toMatchObject({ provider: 'mistral' });
    expect(byName.get('llama-4-maverick')).toMatchObject({ provider: 'meta' });
    expect(getModelContextWindow('MiniMax-M2')).toBe(200_000);
  });
});
