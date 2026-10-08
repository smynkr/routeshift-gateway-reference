/**
 * Dispatch pricing gate: every MODEL_REGISTRY entry that can receive customer
 * traffic — `public !== false`, i.e. dispatchable via resolveProvider — must
 * resolve to POSITIVE pricing via getModelPricing() (curated PRICING_TABLE,
 * then the generated LiteLLM fallback).
 *
 * The predicate is dispatchability, not auto-route eligibility: a public
 * model with auto_route: false is still explicitly requestable and billable
 * (proxy-handler resolveProvider only rejects public === false), and plain
 * `promote-model.ts <name>` mints exactly that shape by default. Gating on
 * auto_route alone would leave the promotion tool's own default output
 * unguarded (review round 2).
 *
 * Positivity matters as much as presence: a $0/$0 row is not pricing — it
 * bills $0 per request while looking accounted-for. The sole exception is
 * xiaomi's documented Token Plan subscription convention (per-request cost is
 * deliberately reported as 0; subscription cost lives outside the table) —
 * the same carve-out promote-model.ts applies.
 */
import { describe, expect, it } from 'vitest';
import { MODEL_REGISTRY, PROVIDERS_WITHOUT_RUNTIME_ADAPTER } from '../src/models';
import { getModelPricing, SUBSCRIPTION_PRICED_PROVIDERS } from '../src/cost-tables';
import { buildModelsList } from '../src/catalog';
import type { GeneratedCatalogModel } from '../src/generated-model-catalog';

const SUBSCRIPTION_PROVIDERS = new Set<string>(SUBSCRIPTION_PRICED_PROVIDERS);

function positivelyPriced(provider: string, model: string): boolean {
  const p = getModelPricing(provider, model);
  if (p === null) return false;
  return p.input_per_million > 0 || p.output_per_million > 0 || SUBSCRIPTION_PROVIDERS.has(provider);
}

describe('dispatch pricing gate', () => {
  it('every dispatchable (public) registry entry has positive getModelPricing()', () => {
    // Same resolution contract as promote-model.ts: canonical_name, then
    // api_model_id when it differs (getModelPricing does not alias internally).
    const unpriced = MODEL_REGISTRY.filter((model) => {
      if (model.public === false) return false;
      if (positivelyPriced(model.provider, model.canonical_name)) return false;
      return (
        model.api_model_id === model.canonical_name ||
        !positivelyPriced(model.provider, model.api_model_id)
      );
    }).map((model) => `${model.provider}/${model.canonical_name}`);
    expect(
      unpriced,
      `dispatchable models with missing/zero pricing (curated or generated): ${unpriced.join(', ')}`,
    ).toEqual([]);
  });

  it('no public entry belongs to a provider without a registered runtime adapter', () => {
    // A public entry on an unroutable provider is publicly listed yet 400s
    // "Unknown provider" on every request. promote-model.ts refuses to mint
    // this shape; this gate catches a hand edit that bypasses the tool (and
    // keeps the parked-regression coverage intact after a promotion moves an
    // entry out of the public === false set).
    const unroutable = new Set<string>(PROVIDERS_WITHOUT_RUNTIME_ADAPTER);
    const bad = MODEL_REGISTRY.filter(
      (model) => model.public !== false && unroutable.has(model.provider),
    ).map((model) => `${model.provider}/${model.canonical_name}`);
    expect(
      bad,
      `public entries on providers with no runtime adapter (must stay parked): ${bad.join(', ')}`,
    ).toEqual([]);
  });

  it('keeps generated explicit-only models out of curated auto-route candidates', () => {
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
    const publicIds = buildModelsList(null, [], {}, [generated]).data.map((model) => model.id);
    const autoRouteIds = MODEL_REGISTRY
      .filter((model) => model.auto_route !== false)
      .map((model) => model.canonical_name);

    expect(publicIds).toContain('gpt-4o-mini');
    expect(autoRouteIds).not.toContain('gpt-4o-mini');
  });
});
