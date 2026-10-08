import { CATALOG_FRESHNESS_MANIFEST } from './catalog-freshness.generated';
import {
  EFFECTIVE_PUBLIC_MODELS,
  buildModelsList,
  getRecommendedModels,
  mergeCatalogDefinitions,
  type CatalogModel,
  type CatalogPricingLookup,
  type CatalogRecommendations,
} from './catalog';
import { getModelPricing } from './cost-tables';
import { EMBEDDING_MODELS } from './embedding-models';
import { GENERATED_MODEL_CATALOG, type GeneratedCatalogModel } from './generated-model-catalog';
import { MODEL_REGISTRY, type Provider } from './models';
import { getModelSource } from './model-sources';

export interface DocsCatalogProvenanceV1 {
  source: 'curated' | 'generated';
  source_url?: string;
  source_hash?: string;
  source_as_of?: string;
}

export interface DocsCatalogModelV1 {
  id: string;
  provider: Provider;
  context_length: number;
  pricing: {
    input: string;
    output: string;
    cache_read?: string;
    cache_write?: string;
    long_context_threshold?: number;
    input_above_272k?: string;
    output_above_272k?: string;
    cache_read_above_272k?: string;
    cache_write_above_272k?: string;
  };
  routing: 'auto_or_explicit' | 'explicit_only';
  provenance: DocsCatalogProvenanceV1;
}

export interface DocsCatalogArtifactV1 {
  schema_version: 1;
  generated_at: string;
  source_hash: string;
  recommendations: {
    default: string;
    economy: string;
    coding: string;
    reasoning: string;
  };
  models: DocsCatalogModelV1[];
}
export interface DocsCatalogArtifactOptions {
  /** Optional generated candidate set used by the refresh writer before install. */
  generatedModels?: readonly GeneratedCatalogModel[];
  /** Optional in-memory pricing table used by the refresh writer before install. */
  pricingLookup?: CatalogPricingLookup;
  /** Optional resolved role recommendations for the same candidate catalog. */
  recommendations?: CatalogRecommendations;
  generatedAt?: string;
  sourceHash?: string;
}

export interface DocsCatalogFreshness {
  status: 'ok' | 'degraded';
  generated_at: string;
  age_seconds: number;
}

/** Eight days: stale docs are observable but do not take the proxy out of service. */
export const CATALOG_FRESHNESS_MAX_AGE_SECONDS = 691_200;

function timestampMillis(value: Date | string | number): number | null {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/**
 * Purely calculate catalog age from caller-supplied time and generation time.
 * Invalid and future timestamps fail closed with a non-negative age.
 */
export function getCatalogFreshness(
  now: Date | string | number,
  generatedAt: string = CATALOG_FRESHNESS_MANIFEST.generated_at,
): DocsCatalogFreshness {
  const generated_at = typeof generatedAt === 'string' ? generatedAt : String(generatedAt);
  const nowMillis = timestampMillis(now);
  const generatedMillis = timestampMillis(generated_at);
  if (nowMillis === null || generatedMillis === null || generatedMillis > nowMillis) {
    return { status: 'degraded', generated_at, age_seconds: 0 };
  }

  const ageMillis = nowMillis - generatedMillis;
  return {
    status: ageMillis <= CATALOG_FRESHNESS_MAX_AGE_SECONDS * 1000 ? 'ok' : 'degraded',
    generated_at,
    age_seconds: Math.floor(ageMillis / 1000),
  };
}

function compareDocsModels(left: DocsCatalogModelV1, right: DocsCatalogModelV1): number {
  if (left.provider < right.provider) return -1;
  if (left.provider > right.provider) return 1;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function buildProvenance(
  model: CatalogModel,
  generatedModels: readonly GeneratedCatalogModel[],
): DocsCatalogProvenanceV1 {
  if (model.catalog?.source === 'generated') {
    const definition = generatedModels.find((candidate) => candidate.canonical_name === model.id);
    if (definition) {
      return {
        source: 'generated',
        source_url: definition.source_url,
        source_hash: definition.source_hash,
        source_as_of: definition.source_as_of,
      };
    }
    return {
      source: 'generated',
      ...(model.catalog.source_as_of ? { source_as_of: model.catalog.source_as_of } : {}),
    };
  }

  const source = getModelSource(model.owned_by);
  return {
    source: 'curated',
    ...(source ? { source_url: source.models_url, source_as_of: source.last_verified } : {}),
  };
}

function toDocsCatalogModel(
  model: CatalogModel,
  generatedModels: readonly GeneratedCatalogModel[],
): DocsCatalogModelV1 {
  const pricing = {
    input: model.pricing.prompt,
    output: model.pricing.completion,
    ...(model.pricing.cache_read === undefined ? {} : { cache_read: model.pricing.cache_read }),
    ...(model.pricing.cache_write === undefined ? {} : { cache_write: model.pricing.cache_write }),
    ...(model.pricing.long_context_threshold === undefined
      ? {}
      : { long_context_threshold: model.pricing.long_context_threshold }),
    ...(model.pricing.input_above_272k === undefined ? {} : { input_above_272k: model.pricing.input_above_272k }),
    ...(model.pricing.output_above_272k === undefined ? {} : { output_above_272k: model.pricing.output_above_272k }),
    ...(model.pricing.cache_read_above_272k === undefined
      ? {}
      : { cache_read_above_272k: model.pricing.cache_read_above_272k }),
    ...(model.pricing.cache_write_above_272k === undefined
      ? {}
      : { cache_write_above_272k: model.pricing.cache_write_above_272k }),
  };
  return {
    id: model.id,
    provider: model.owned_by as Provider,
    context_length: model.context_length,
    pricing,
    routing: model.catalog?.routing ?? 'explicit_only',
    provenance: buildProvenance(model, generatedModels),
  };
}

/** Build the stable, unauthenticated docs artifact from the effective public catalog. */
export function buildDocsCatalogArtifact(
  options: DocsCatalogArtifactOptions = {},
): DocsCatalogArtifactV1 {
  const generatedModels = options.generatedModels ?? GENERATED_MODEL_CATALOG;
  const pricingLookup = options.pricingLookup ?? getModelPricing;
  const models = buildModelsList(
    null,
    MODEL_REGISTRY,
    EMBEDDING_MODELS,
    generatedModels,
    pricingLookup,
  ).data.map((model) => toDocsCatalogModel(model, generatedModels)).sort(compareDocsModels);
  const recommendationCatalog = options.generatedModels === undefined
    ? EFFECTIVE_PUBLIC_MODELS
    : mergeCatalogDefinitions(MODEL_REGISTRY, generatedModels).filter((model) => model.public !== false);
  return {
    schema_version: 1,
    generated_at: options.generatedAt ?? CATALOG_FRESHNESS_MANIFEST.generated_at,
    source_hash: options.sourceHash ?? CATALOG_FRESHNESS_MANIFEST.source_hash,
    recommendations: options.recommendations ?? getRecommendedModels(recommendationCatalog, undefined, pricingLookup),
    models,
  };
}
