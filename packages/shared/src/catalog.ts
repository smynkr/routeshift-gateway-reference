import { CATALOG_FRESHNESS_MANIFEST } from './catalog-freshness.generated';
import { EMBEDDING_MODELS, type EmbeddingModel } from './embedding-models';
import { GENERATED_MODEL_CATALOG, type GeneratedCatalogModel } from './generated-model-catalog';
import { getModelPricing, LONG_CONTEXT_THRESHOLD_TOKENS, type ModelPricing } from './cost-tables';
import { MODEL_REGISTRY, PROVIDERS_WITHOUT_RUNTIME_ADAPTER, type ModelDefinition, type Provider } from './models';
import { getModelEndpoints, PROVIDER_DATA_POLICY } from './provider-endpoints';
import { isValidCapabilityIndices, type CapabilityIndices } from './capability-sources';

export type GeneratedCatalogDefinition = GeneratedCatalogModel;
export interface EffectiveEmbeddingDefinition {
  provider: Provider;
  canonical_name: string;
  api_model_id: string;
  context_window: number;
  public?: boolean;
  auto_route: false;
  kind: 'embedding';
}
export type EffectiveCatalogDefinition =
  | ModelDefinition
  | GeneratedCatalogDefinition
  | EffectiveEmbeddingDefinition;

export interface CatalogPricing {
  prompt: string;
  completion: string;
  cache_read?: string;
  cache_write?: string;
  long_context_threshold?: number;
  input_above_272k?: string;
  output_above_272k?: string;
  cache_read_above_272k?: string;
  cache_write_above_272k?: string;
}

export interface CatalogEndpoint {
  provider: string;
  api_model_id: string;
  context_length: number;
  pricing: CatalogPricing;
  data_policy: { zdr: boolean };
}
export interface CatalogArchitecture {
  modality: string;
  input_modalities: string[];
  output_modalities: string[];
}
export interface CatalogModel {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  name: string;
  context_length: number;
  pricing: CatalogPricing;
  architecture?: CatalogArchitecture;
  /** Sourced OpenRouter-style capability indices; absent = no verified source. */
  capability_indices?: CapabilityIndices;
  /** Optional provenance and routing metadata; OpenAI fields above remain stable. */
  catalog?: {
    source: 'curated' | 'generated';
    routing: 'auto_or_explicit' | 'explicit_only';
    source_as_of?: string;
  };
  endpoints: CatalogEndpoint[];
}
export interface CatalogList { object: 'list'; data: CatalogModel[]; }

export interface CatalogRecommendations {
  default: string;
  economy: string;
  coding: string;
  reasoning: string;
}

const RECOMMENDATION_KEYS = ['default', 'economy', 'coding', 'reasoning'] as const;
type RecommendationKey = (typeof RECOMMENDATION_KEYS)[number];

function usdPerToken(perMillion: number): string {
  return String(perMillion / 1e6);
}

function toCatalogPricing(pricing: ModelPricing): CatalogPricing {
  const result: CatalogPricing = {
    prompt: usdPerToken(pricing.input_per_million),
    completion: usdPerToken(pricing.output_per_million),
  };
  if (pricing.cache_read_per_million !== undefined) {
    result.cache_read = usdPerToken(pricing.cache_read_per_million);
  }
  if (pricing.cache_write_per_million !== undefined) {
    result.cache_write = usdPerToken(pricing.cache_write_per_million);
  }
  const hasLongContextRates = [
    pricing.input_per_million_above_272k,
    pricing.output_per_million_above_272k,
    pricing.cache_read_per_million_above_272k,
    pricing.cache_write_per_million_above_272k,
  ].some((rate) => rate !== undefined);
  if (hasLongContextRates) {
    result.long_context_threshold = LONG_CONTEXT_THRESHOLD_TOKENS;
    if (pricing.input_per_million_above_272k !== undefined) {
      result.input_above_272k = usdPerToken(pricing.input_per_million_above_272k);
    }
    if (pricing.output_per_million_above_272k !== undefined) {
      result.output_above_272k = usdPerToken(pricing.output_per_million_above_272k);
    }
    if (pricing.cache_read_per_million_above_272k !== undefined) {
      result.cache_read_above_272k = usdPerToken(pricing.cache_read_per_million_above_272k);
    }
    if (pricing.cache_write_per_million_above_272k !== undefined) {
      result.cache_write_above_272k = usdPerToken(pricing.cache_write_per_million_above_272k);
    }
  }
  return result;
}

function endpointToCatalogEndpoint(
  endpoint: { provider: string; model: string; zdr: boolean },
  fallbackContextLength: number,
  pricingLookup: CatalogPricingLookup,
): CatalogEndpoint | null {
  const pricing = pricingLookup(endpoint.provider, endpoint.model);
  if (!pricing) return null;
  return {
    provider: endpoint.provider,
    api_model_id: endpoint.model,
    context_length: fallbackContextLength,
    pricing: toCatalogPricing(pricing),
    data_policy: { zdr: endpoint.zdr },
  };
}

function toCatalogModel(
  m: EffectiveCatalogDefinition,
  pricingLookup: CatalogPricingLookup,
): CatalogModel | null {
  const pricing = pricingLookup(m.provider, m.canonical_name)
    ?? (m.api_model_id === m.canonical_name ? null : pricingLookup(m.provider, m.api_model_id));
  if (!pricing) return null; // unpriced models are omitted (catalog gap)
  const price = toCatalogPricing(pricing);
  const endpoints = getModelEndpoints(m.canonical_name)
    .map((endpoint) => endpointToCatalogEndpoint(endpoint, m.context_window, pricingLookup))
    .filter((endpoint): endpoint is CatalogEndpoint => endpoint !== null);
  if (endpoints.length === 0) {
    endpoints.push({
      provider: m.provider,
      api_model_id: m.api_model_id,
      context_length: m.context_window,
      pricing: price,
      data_policy: { zdr: PROVIDER_DATA_POLICY[m.provider].zdr },
    });
  }
  // Fail closed on provenance: an invalid/undated index set is a registry
  // bug the gate test catches — it must never reach a public surface, so it
  // is omitted exactly like an unpriced model is omitted.
  const candidateCapability = 'capability_indices' in m ? m.capability_indices : undefined;
  const capability_indices = candidateCapability && isValidCapabilityIndices(candidateCapability)
    ? { ...candidateCapability } // copy: catalog consumers must not mutate the registry
    : undefined;
  const generated = 'source' in m && m.source === 'generated';
  const catalog = generated
    ? { source: 'generated' as const, routing: 'explicit_only' as const, source_as_of: m.source_as_of }
    : {
      source: 'curated' as const,
      routing: m.auto_route === false ? 'explicit_only' as const : 'auto_or_explicit' as const,
    };

  return {
    id: m.canonical_name,
    object: 'model',
    created: 0,
    owned_by: m.provider,
    name: m.canonical_name,
    context_length: m.context_window,
    pricing: price,
    ...(capability_indices ? { capability_indices } : {}),
    catalog,
    endpoints,
  };
}

function toEmbeddingCatalogModel(
  canonicalName: string,
  m: EmbeddingModel,
  pricingLookup: CatalogPricingLookup,
): CatalogModel | null {
  const pricing = pricingLookup(m.provider, canonicalName) ?? pricingLookup(m.provider, m.api_model_id);
  if (!pricing) return null;
  const price = toCatalogPricing(pricing);
  return {
    id: canonicalName,
    object: 'model',
    created: 0,
    owned_by: m.provider,
    name: canonicalName,
    context_length: m.context_window,
    pricing: price,
    architecture: {
      modality: 'text->embedding',
      input_modalities: ['text'],
      output_modalities: ['embedding'],
    },
    catalog: { source: 'curated', routing: 'explicit_only' },
    endpoints: [{
      provider: m.provider,
      api_model_id: m.api_model_id,
      context_length: m.context_window,
      pricing: price,
      data_policy: { zdr: PROVIDER_DATA_POLICY[m.provider].zdr },
    }],
  };
}
function definitionId(id: string): string {
  return id.toLowerCase();
}

function detachCuratedDefinition(model: ModelDefinition): ModelDefinition {
  return {
    ...model,
    ...(model.capability_indices ? { capability_indices: { ...model.capability_indices } } : {}),
  };
}

/** Merge curated routing definitions with the generated public supplement. */
export function mergeCatalogDefinitions(
  registry: readonly ModelDefinition[],
  generated: readonly GeneratedCatalogModel[],
): EffectiveCatalogDefinition[] {
  const curatedById = new Map<string, ModelDefinition>();
  const detachedCurated = registry.map((model) => {
    const detached = detachCuratedDefinition(model);
    for (const id of [detached.canonical_name, detached.api_model_id]) {
      const key = definitionId(id);
      if (!curatedById.has(key)) curatedById.set(key, detached);
    }
    return detached;
  });

  const generatedById = new Map<string, GeneratedCatalogModel>();
  const merged: EffectiveCatalogDefinition[] = [...detachedCurated];
  for (const model of generated) {
    const ids = [model.canonical_name, model.api_model_id].map(definitionId);
    if (ids.some((id) => curatedById.has(id))) continue;
    const collision = ids.find((id) => generatedById.has(id));
    if (collision) {
      throw new Error(`generated model collision: ${collision}`);
    }
    const detached = { ...model };
    for (const id of ids) generatedById.set(id, detached);
    if (PROVIDERS_WITHOUT_RUNTIME_ADAPTER.some((provider) => provider === detached.provider)) continue;
    merged.push(detached);
  }
  return merged;
}

function effectiveEmbeddingDefinitions(): EffectiveEmbeddingDefinition[] {
  return Object.entries(EMBEDDING_MODELS).map(([canonical_name, model]) => ({
    provider: model.provider,
    canonical_name,
    api_model_id: model.api_model_id,
    context_window: model.context_window,
    ...(model.public === undefined ? {} : { public: model.public }),
    auto_route: false as const,
    kind: 'embedding' as const,
  }));
}

function isEmbeddingDefinition(model: EffectiveCatalogDefinition): model is EffectiveEmbeddingDefinition {
  return 'kind' in model && model.kind === 'embedding';
}

function isDispatchableChatDefinition(model: EffectiveCatalogDefinition): boolean {
  return !isEmbeddingDefinition(model)
    && model.public !== false
    && !PROVIDERS_WITHOUT_RUNTIME_ADAPTER.includes(model.provider as typeof PROVIDERS_WITHOUT_RUNTIME_ADAPTER[number]);
}

/** All public catalog definitions, including embeddings that are not chat-routable. */
export const EFFECTIVE_PUBLIC_MODELS: readonly EffectiveCatalogDefinition[] = [
  ...mergeCatalogDefinitions(MODEL_REGISTRY, GENERATED_MODEL_CATALOG)
    .filter((model) => model.public !== false),
  ...effectiveEmbeddingDefinitions(),
].filter((model) => model.public !== false);

/** Effective chat definitions safe for aliases, presets, and routing selectors. */
export const EFFECTIVE_DISPATCHABLE_CHAT_MODELS: readonly EffectiveCatalogDefinition[] =
  EFFECTIVE_PUBLIC_MODELS.filter(isDispatchableChatDefinition);

/** Pure: pick effective definitions visible for this caller.
 *  filterAllowed semantics (allowlist values are CANONICAL names, matching
 *  ApiKeyInfo.allowedModels which is compared post-alias-resolution):
 *    null       => public catalog (exclude public:false)
 *    []         => none (authenticated but explicitly scoped to zero models)
 *    [names...] => only those canonical_names (public flag ignored — an
 *                  authenticated key explicitly scoped to a model still sees it)
 *  The HTTP handler maps a key with no/empty allowedModels to null (full
 *  catalog), so [] only arises from a deliberate zero-scope. */
export function selectModels<T extends EffectiveCatalogDefinition>(
  registry: readonly T[],
  filterAllowed: string[] | null,
): T[] {
  return registry.filter((m) => {
    if (filterAllowed === null) return m.public !== false;
    return filterAllowed.includes(m.canonical_name);
  });
}

function selectEmbeddingModels(
  embeddingModels: Record<string, EmbeddingModel>,
  filterAllowed: string[] | null,
): Array<[string, EmbeddingModel]> {
  return Object.entries(embeddingModels).filter(([canonicalName, m]) => {
    if (filterAllowed === null) return m.public !== false;
    return filterAllowed.includes(canonicalName);
  });
}

/** filterAllowed: null = unauthenticated (full PUBLIC catalog); non-null = a key's allowedModels scope. */
export function buildModelsList(
  filterAllowed: string[] | null,
  registry: readonly ModelDefinition[] = MODEL_REGISTRY,
  embeddingModels: Record<string, EmbeddingModel> = EMBEDDING_MODELS,
  generated: readonly GeneratedCatalogModel[] = GENERATED_MODEL_CATALOG,
  pricingLookup: CatalogPricingLookup = getModelPricing,
): CatalogList {
  const data: CatalogModel[] = [];
  const effective = mergeCatalogDefinitions(registry, generated);
  for (const m of selectModels(effective, filterAllowed)) {
    const cm = toCatalogModel(m, pricingLookup);
    if (cm) data.push(cm);
  }
  // Embeddings are catalog-discoverable without entering MODEL_REGISTRY chat routing.
  for (const [canonicalName, m] of selectEmbeddingModels(embeddingModels, filterAllowed)) {
    const cm = toEmbeddingCatalogModel(canonicalName, m, pricingLookup);
    if (cm) data.push(cm);
  }
  return { object: 'list', data };
}
export function buildModelDetail(
  id: string,
  filterAllowed: string[] | null,
  registry: readonly ModelDefinition[] = MODEL_REGISTRY,
  embeddingModels: Record<string, EmbeddingModel> = EMBEDDING_MODELS,
  generated: readonly GeneratedCatalogModel[] = GENERATED_MODEL_CATALOG,
  pricingLookup: CatalogPricingLookup = getModelPricing,
): CatalogModel | null {
  const effective = mergeCatalogDefinitions(registry, generated);
  const m = effective.find((x) => x.canonical_name === id || x.api_model_id === id);
  if (m) {
    if (selectModels([m], filterAllowed).length === 0) return null;
    return toCatalogModel(m, pricingLookup);
  }
  const embedding = Object.entries(embeddingModels).find(
    ([canonicalName, x]) => canonicalName === id || x.api_model_id === id,
  );
  if (!embedding) return null;
  const [canonicalName, model] = embedding;
  if (selectEmbeddingModels({ [canonicalName]: model }, filterAllowed).length === 0) return null;
  return toEmbeddingCatalogModel(canonicalName, model, pricingLookup);
}

export function stableModelOrder(a: EffectiveCatalogDefinition, b: EffectiveCatalogDefinition): number {
  const providerOrder = a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0;
  return providerOrder || (a.canonical_name < b.canonical_name ? -1 : a.canonical_name > b.canonical_name ? 1 : 0);
}

export type CatalogPricingLookup = (provider: string, model: string) => ModelPricing | null | undefined;

function hasCatalogPricing(
  model: EffectiveCatalogDefinition,
  pricingLookup: CatalogPricingLookup,
): boolean {
  const canonicalPricing = pricingLookup(model.provider, model.canonical_name);
  if (canonicalPricing !== null && canonicalPricing !== undefined) return true;
  if (model.api_model_id === model.canonical_name) return false;
  const apiPricing = pricingLookup(model.provider, model.api_model_id);
  return apiPricing !== null && apiPricing !== undefined;
}

function distinctPricedCandidates(
  effectiveCatalog: readonly EffectiveCatalogDefinition[],
  pricingLookup: CatalogPricingLookup,
): EffectiveCatalogDefinition[] {
  const seen = new Set<string>();
  return effectiveCatalog
    .filter((model) => !isEmbeddingDefinition(model) && model.public !== false && hasCatalogPricing(model, pricingLookup))
    .slice()
    .sort(stableModelOrder)
    .filter((model) => {
      if (seen.has(model.canonical_name)) return false;
      seen.add(model.canonical_name);
      return true;
    });
}

function highestGptAlias(candidates: readonly EffectiveCatalogDefinition[]): string | undefined {
  return candidates
    .map((model) => ({ model, match: /^gpt-(\d+)\.(\d+)$/.exec(model.canonical_name) }))
    .filter((entry): entry is { model: EffectiveCatalogDefinition; match: RegExpExecArray } => entry.match !== null)
    .sort((a, b) => {
      const majorOrder = Number(b.match[1]) - Number(a.match[1]);
      const minorOrder = Number(b.match[2]) - Number(a.match[2]);
      return majorOrder || minorOrder || stableModelOrder(a.model, b.model);
    })[0]?.model.canonical_name;
}
function numericVersionTokens(model: string): number[] {
  return [...model.matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
}

interface ParsedOSeriesModel {
  major: number;
  variantRank: number;
  base: string;
  date?: string;
}

function parseOSeriesModel(canonicalName: string): ParsedOSeriesModel | null {
  const snapshot = /^(.*)-(\d{4}(?:-\d{2}){1,2})$/.exec(canonicalName);
  const base = snapshot?.[1] ?? canonicalName;
  const match = /^o(\d+)(?:-(.*))?$/i.exec(base);
  if (!match) return null;

  const variant = match[2] ?? '';
  return {
    major: Number(match[1]),
    variantRank: /^mini(?:-|$)/i.test(variant) ? 1 : 0,
    base,
    ...(snapshot?.[2] ? { date: snapshot[2] } : {}),
  };
}

/** Compare reasoning model freshness before applying the stable catalog tie-break. */
export function reasoningModelOrder(a: EffectiveCatalogDefinition, b: EffectiveCatalogDefinition): number {
  const aOSeries = parseOSeriesModel(a.canonical_name);
  const bOSeries = parseOSeriesModel(b.canonical_name);
  if (aOSeries || bOSeries) {
    if (!aOSeries) return 1;
    if (!bOSeries) return -1;

    if (aOSeries.major !== bOSeries.major) return aOSeries.major > bOSeries.major ? -1 : 1;
    if (aOSeries.variantRank !== bOSeries.variantRank) {
      return aOSeries.variantRank < bOSeries.variantRank ? -1 : 1;
    }

    const baseOrder = aOSeries.base < bOSeries.base ? -1 : aOSeries.base > bOSeries.base ? 1 : 0;
    if (baseOrder !== 0) return baseOrder;

    const aIsStableAlias = aOSeries.date === undefined;
    const bIsStableAlias = bOSeries.date === undefined;
    if (aIsStableAlias !== bIsStableAlias) return aIsStableAlias ? -1 : 1;
    if (aOSeries.date !== undefined && bOSeries.date !== undefined && aOSeries.date !== bOSeries.date) {
      return aOSeries.date > bOSeries.date ? -1 : 1;
    }
    return stableModelOrder(a, b);
  }

  const aTokens = numericVersionTokens(a.canonical_name);
  const bTokens = numericVersionTokens(b.canonical_name);
  for (let index = 0; index < Math.max(aTokens.length, bTokens.length); index += 1) {
    const aToken = aTokens[index] ?? -1;
    const bToken = bTokens[index] ?? -1;
    if (aToken !== bToken) return aToken > bToken ? -1 : 1;
  }
  return stableModelOrder(a, b);
}

function modelPriceTotal(
  model: EffectiveCatalogDefinition,
  pricingLookup: CatalogPricingLookup,
): number {
  const pricing = pricingLookup(model.provider, model.canonical_name)
    ?? (model.api_model_id === model.canonical_name ? null : pricingLookup(model.provider, model.api_model_id));
  return pricing ? pricing.input_per_million + pricing.output_per_million : Number.POSITIVE_INFINITY;
}

function recommendationFallbacks(
  candidates: readonly EffectiveCatalogDefinition[],
  pricingLookup: CatalogPricingLookup,
): Record<RecommendationKey, string[]> {
  const stableIds = candidates.map((model) => model.canonical_name);
  const fallback = stableIds[0];
  if (!fallback || stableIds.length < RECOMMENDATION_KEYS.length) {
    throw new Error('effective public catalog has fewer than four distinct priced models');
  }
  const alias = highestGptAlias(candidates);
  const recommended = candidates
    .filter((model) => 'recommended' in model && model.recommended === true)
    .map((model) => model.canonical_name);
  const economyCandidates = candidates.filter((model) => model.auto_route !== false);
  const cheapest = (economyCandidates.length > 0 ? economyCandidates : candidates)
    .slice()
    .sort((a, b) => modelPriceTotal(a, pricingLookup) - modelPriceTotal(b, pricingLookup) || stableModelOrder(a, b))[0];
  const aliasEconomy = alias
    ? candidates.find((model) => model.canonical_name === `${alias}-luna`)
    : undefined;
  const economy = aliasEconomy && cheapest
    && modelPriceTotal(aliasEconomy, pricingLookup) <= modelPriceTotal(cheapest, pricingLookup)
    ? aliasEconomy.canonical_name
    : cheapest?.canonical_name;
  const candidateIds = new Set(stableIds);
  const firstDistinct = (preferred: readonly string[]): string[] => [
    ...preferred.filter((id) => candidateIds.has(id)),
    ...stableIds,
  ];

  return {
    default: firstDistinct(recommended.length > 0 ? recommended : alias ? [alias] : []),
    economy: firstDistinct(economy ? [economy] : []),
    coding: firstDistinct(candidates.filter((model) => /code|coder/i.test(model.canonical_name)).map((model) => model.canonical_name)),
    reasoning: firstDistinct(candidates
      .filter((model) => /reason|thinking|^o\d/i.test(model.canonical_name))
      .sort(reasoningModelOrder)
      .map((model) => model.canonical_name)),
  };
}

function chooseDistinctRecommendation(
  requested: unknown,
  fallbackCandidates: readonly string[],
  candidateIds: ReadonlySet<string>,
  used: Set<string>,
): string {
  const options = [
    ...(typeof requested === 'string' ? [requested] : []),
    ...fallbackCandidates,
  ];
  for (const id of options) {
    if (candidateIds.has(id) && !used.has(id)) {
      used.add(id);
      return id;
    }
  }
  throw new Error('effective public catalog has fewer than four distinct priced models');
}

/**
 * Resolve current role recommendations against an effective public catalog.
 *
 * The optional catalog, recommendation, and pricing arguments are injectable
 * pure seams for callers/tests. Injected catalogs are still price-gated using
 * the supplied lookup; the no-argument call uses the real pricing table.
 */
export function getRecommendedModels(
  effectiveCatalog: readonly EffectiveCatalogDefinition[] = EFFECTIVE_PUBLIC_MODELS,
  recommendationOverrides?: Partial<Record<RecommendationKey, unknown>>,
  pricingLookup: CatalogPricingLookup = getModelPricing,
): CatalogRecommendations {
  const candidates = distinctPricedCandidates(effectiveCatalog, pricingLookup);
  const fallbackCandidates = recommendationFallbacks(candidates, pricingLookup);
  const candidateIds = new Set(candidates.map((model) => model.canonical_name));
  const manifest = CATALOG_FRESHNESS_MANIFEST as unknown as {
    recommendations?: Partial<Record<RecommendationKey, unknown>>;
  };
  const requestedRecommendations = recommendationOverrides ?? manifest.recommendations;
  const used = new Set<string>();
  const recommendations = {} as CatalogRecommendations;
  for (const key of RECOMMENDATION_KEYS) {
    recommendations[key] = chooseDistinctRecommendation(
      requestedRecommendations?.[key],
      fallbackCandidates[key],
      candidateIds,
      used,
    );
  }
  return recommendations;
}
