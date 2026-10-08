import { describe, expect, it } from 'vitest';
import { EMBEDDING_MODELS, resolveEmbeddingModel, getModelPricing } from '@routeshift/shared';

describe('embedding models', () => {
  it('maps known embedding models to providers', () => {
    expect(resolveEmbeddingModel('text-embedding-3-small')).toBe('openai');
    expect(resolveEmbeddingModel('text-embedding-004')).toBe('google');
  });
  it('returns null for unknown / chat models', () => {
    expect(resolveEmbeddingModel('gpt-5.4')).toBeNull();
    expect(resolveEmbeddingModel('nope')).toBeNull();
  });
  it('has a pricing row for each embedding model (output 0)', () => {
    for (const name of Object.keys(EMBEDDING_MODELS)) {
      const e = EMBEDDING_MODELS[name];
      const p = getModelPricing(e.provider, name);
      expect(p, `pricing for ${name}`).not.toBeNull();
      expect(p!.output_per_million).toBe(0);
    }
  });
  it('prices text-embedding-004 at the Google paid-tier input rate', () => {
    const p = getModelPricing('google', 'text-embedding-004');
    expect(p?.input_per_million).toBe(0.025);
    expect(p?.output_per_million).toBe(0);
  });
});
