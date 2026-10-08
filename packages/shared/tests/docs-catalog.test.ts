import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CATALOG_FRESHNESS_MAX_AGE_SECONDS,
  buildDocsCatalogArtifact,
  getCatalogFreshness,
} from '../src/docs-catalog';
import type { GeneratedCatalogModel } from '../src/generated-model-catalog';
import { getModelPricing } from '../src/cost-tables';
describe('buildDocsCatalogArtifact', () => {
  it('returns a deterministic public v1 artifact with resolved recommendations', () => {
    const artifact = buildDocsCatalogArtifact();
    const ids = new Set(artifact.models.map((model) => model.id));

    expect(Object.keys(artifact).sort()).toEqual([
      'generated_at',
      'models',
      'recommendations',
      'schema_version',
      'source_hash',
    ]);
    expect(artifact.schema_version).toBe(1);
    expect(artifact.generated_at).toEqual(expect.any(String));
    expect(artifact.source_hash).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(artifact.recommendations).toEqual(expect.objectContaining({ default: expect.any(String) }));
    expect(artifact.models).toContainEqual(expect.objectContaining({
      id: 'gpt-5.6',
      provider: 'openai',
      context_length: 1_050_000,
      pricing: expect.objectContaining({ input: expect.any(String), output: expect.any(String) }),
      routing: 'explicit_only',
      provenance: expect.objectContaining({ source: 'curated' }),
    }));
    const gpt = artifact.models.find((model) => model.id === 'gpt-5.4');
    expect(gpt?.pricing).toMatchObject({
      long_context_threshold: 272_000,
      input_above_272k: String(5 / 1e6),
      output_above_272k: String(22.5 / 1e6),
    });
    expect(artifact.models.every((model) => Object.keys(model).sort().join(',') === 'context_length,id,pricing,provenance,provider,routing')).toBe(true);
    expect(artifact.models.every((model) => ids.has(model.id))).toBe(true);
    expect(Object.values(artifact.recommendations).every((id) => ids.has(id))).toBe(true);
    expect(ids.has('text-embedding-3-small')).toBe(true);
    expect(buildDocsCatalogArtifact()).toEqual(artifact);
  });
});
it('keeps the checked-in artifact byte-identical to the runtime builder', () => {
  const bytes = readFileSync(new URL('../src/docs-catalog.generated.json', import.meta.url), 'utf8');
  const runtimeArtifact = buildDocsCatalogArtifact();

  expect(JSON.parse(bytes)).toEqual(runtimeArtifact);
  expect(bytes).toBe(`${JSON.stringify(runtimeArtifact, null, 2)}\n`);
});
it('builds a proposal artifact from candidate definitions, pricing, and provenance', () => {
  const generatedAt = '2026-08-27T12:00:00.000Z';
  const sourceHash = 'b'.repeat(64);
  const generatedModels = [{
    provider: 'zai',
    canonical_name: 'zai-refresh-candidate',
    api_model_id: 'zai-refresh-candidate',
    context_window: 32_768,
    source: 'generated',
    public: true,
    explicit_only: true,
    auto_route: false,
    source_url: 'https://example.test/litellm.json',
    source_hash: sourceHash,
    source_as_of: generatedAt,
  }] satisfies GeneratedCatalogModel[];

  const artifact = buildDocsCatalogArtifact({
    generatedModels,
    pricingLookup: (provider, model) => provider === 'zai' && model === 'zai-refresh-candidate'
      ? { provider, model, input_per_million: 0.15, output_per_million: 0.6 }
      : getModelPricing(provider, model),
    generatedAt,
    sourceHash,
  });

  expect(artifact.generated_at).toBe(generatedAt);
  expect(artifact.source_hash).toBe(sourceHash);
  expect(artifact.models).toContainEqual({
    id: 'zai-refresh-candidate',
    provider: 'zai',
    context_length: 32_768,
    pricing: { input: '1.5e-7', output: '6e-7' },
    routing: 'explicit_only',
    provenance: {
      source: 'generated',
      source_url: 'https://example.test/litellm.json',
      source_hash: sourceHash,
      source_as_of: generatedAt,
    },
  });
});

describe('getCatalogFreshness', () => {
  const generatedAt = '2026-01-01T00:00:00.000Z';
  const generatedMs = Date.parse(generatedAt);

  it('accepts a catalog exactly at the eight-day maximum age', () => {
    expect(getCatalogFreshness(new Date(generatedMs + CATALOG_FRESHNESS_MAX_AGE_SECONDS * 1000), generatedAt)).toEqual({
      status: 'ok',
      generated_at: generatedAt,
      age_seconds: CATALOG_FRESHNESS_MAX_AGE_SECONDS,
    });
  });

  it('degrades a catalog older than eight days', () => {
    expect(getCatalogFreshness(new Date(generatedMs + (CATALOG_FRESHNESS_MAX_AGE_SECONDS + 1) * 1000), generatedAt)).toEqual({
      status: 'degraded',
      generated_at: generatedAt,
      age_seconds: CATALOG_FRESHNESS_MAX_AGE_SECONDS + 1,
    });
  });

  it('degrades invalid and future timestamps without a negative age', () => {
    expect(getCatalogFreshness(new Date(generatedMs), 'not-a-timestamp')).toEqual({
      status: 'degraded',
      generated_at: 'not-a-timestamp',
      age_seconds: 0,
    });
    expect(getCatalogFreshness(new Date(generatedMs), '2026-01-01T00:00:01.000Z')).toEqual({
      status: 'degraded',
      generated_at: '2026-01-01T00:00:01.000Z',
      age_seconds: 0,
    });
  });
});
