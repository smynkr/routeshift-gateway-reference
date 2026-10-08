#!/usr/bin/env tsx

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyCatalogRefresh } from './catalog-refresh-classifier.js';
import {
  fetchLiteLLMCatalogRaw,
  LITELLM_SOURCE,
  mappedProvider,
  parseLiteLLMCatalog,
  stripProviderPrefix,
  type LiteLLMEntry,
} from './litellm-source.js';
import { resolveCacheWritePolicy } from './cache-write-policy.js';
import { toOutputEntryResult, type OutputEntry } from './sync-pricing.js';
import { buildDocsCatalogArtifact, type DocsCatalogArtifactV1 } from '../src/docs-catalog.js';
import { PRICING_TABLE, type ModelPricing } from '../src/cost-tables.js';
import { getRecommendedModels, mergeCatalogDefinitions, type CatalogPricingLookup, type CatalogRecommendations, type EffectiveCatalogDefinition } from '../src/catalog.js';
import {
  GOOGLE_PREVIEW_QUARANTINE_IDS,
  MODEL_REGISTRY,
  PROVIDERS,
  type Provider,
} from '../src/models.js';
import type {
  CatalogCachePolicyDecision,
  CatalogContextDelta,
  CatalogFreshnessManifest,
  CatalogPriceDelta,
  CatalogRefreshPrevious,
  CatalogRefreshProposal,
  CatalogRefreshRecord,
  CatalogSnapshot,
  CatalogSnapshotInput,
  GeneratedCatalogModel,
  PreviousGeneratedCatalogModel,
} from './catalog-refresh-types.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
// Bedrock foundation-model IDs use the AWS version delimiter `:0`; this is a
// provider-specific extension, not a relaxation of the general model-ID rule.
const BEDROCK_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._~:-]*$/;
const MODALITY_DENYLIST = /audio|tts|text-to-speech|realtime|transcrib|whisper|dall-e|image|video|moderation/i;
// LiteLLM also stores image-generation keys with size/step wrappers and
// deployment-region wrappers (for example `50-steps/bedrock/...` or
// `bedrock/ap-northeast-1/...`). They are source keys, not provider API IDs;
// keep this explicit class out of the chat catalog without weakening SAFE_ID.
const NON_MODEL_SOURCE_KEY_PATTERNS = [
  /^(?:\d+-x-\d+\/)?(?:\d+|max)-steps\//i,
  /^(?:azure|bedrock)\/(?:global-standard|global|us|eu|apac|au|ca|jp|invoke|[a-z]{2}(?:-[a-z0-9]+)*-\d+)\//i,
  /^(?:gemini|vertex_ai)\/(?:gemini\/)?gemini-exp-\d+$/i,
];

const GEMINI_ALIAS_WRAPPER = /^gemini\/gemini-(?:flash|flash-lite)-latest$/i;

function isNonModelSourceKey(rawKey: string): boolean {
  return NON_MODEL_SOURCE_KEY_PATTERNS.some((pattern) => pattern.test(rawKey));
}

function isNonTokenChatEntry(entry: LiteLLMEntry): boolean {
  const record = entry as Record<string, unknown>;
  if (
    record.supports_audio_output === true
    || typeof record.input_cost_per_video_per_second === 'number'
    || typeof record.input_cost_per_second === 'number'
    || typeof record.output_cost_per_video_per_second === 'number'
    || typeof record.output_cost_per_audio_token === 'number'
    || typeof record.output_cost_per_second === 'number'
    || typeof record.code_interpreter_cost_per_session === 'number'
  ) {
    return true;
  }
  const outputModalities = record.supported_output_modalities;
  if (
    Array.isArray(outputModalities)
    && outputModalities.length > 0
    && outputModalities.every((modality) => modality === 'audio' || modality === 'image' || modality === 'video')
  ) {
    return true;
  }
  if (
    Array.isArray(record.tiered_pricing)
    && record.input_cost_per_token === undefined
    && record.output_cost_per_token === undefined
  ) {
    return true;
  }
  const supportedEndpoints = record.supported_endpoints;
  return Array.isArray(supportedEndpoints)
    && supportedEndpoints.length > 0
    && supportedEndpoints.every((endpoint) => (
      typeof endpoint === 'string' && !endpoint.includes('/v1/chat/completions')
    ));
}

const DISCONTINUED_MOONSHOT_PATTERNS = [
  /^kimi-k2(?:[.-]|$)/i,
  /^kimi-latest(?:[.-]|$)/i,
  /^kimi-thinking-preview(?:[.-]|$)/i,
];
const STALE_MODEL_PATTERNS: RegExp[] = [/(^|\.)claude-sonnet-4-7($|-)/];
export const MAX_CONTEXT_WINDOW = 32_000_000;
export const CATALOG_REFRESH_RULE_VERSION = 'catalog-refresh-v1';

const DEFAULT_SOURCE_URL = LITELLM_SOURCE;
const DEFAULT_GENERATED_AT = '1970-01-01T00:00:00.000Z';

interface NormalizedSnapshot {
  entries: Readonly<Record<string, LiteLLMEntry>>;
  sourceUrl: string;
  sourceHash: string;
  sourceAsOf: string;
  generatedAt: string;
}

interface GenerationOptions {
  generatedAt?: string;
}

export interface CatalogRefreshOutputPaths {
  generatedModels: string;
  pricing: string;
  manifest: string;
  currentModels: string;
  docsCatalog: string;
}

export interface CatalogRefreshWriteDependencies {
  /** Injectable cleanup seam used to prove backup failures cannot roll back installs. */
  remove?: (path: string) => void;
}
const CURATED_PRICING_BY_KEY = new Map<string, ModelPricing>(
  PRICING_TABLE.map((entry) => [`${entry.provider}:${entry.model}`, entry]),
);
const OPTIONAL_GENERATED_PRICING_FIELDS = [
  'cache_read_per_million',
  'cache_write_per_million',
  'input_per_million_above_272k',
  'output_per_million_above_272k',
  'cache_read_per_million_above_272k',
  'cache_write_per_million_above_272k',
] as const satisfies readonly (keyof ModelPricing)[];

function proposalPricingLookup(pricing: readonly OutputEntry[]): CatalogPricingLookup {
  const generatedPricing = new Map(
    pricing.map((entry) => [`${entry.provider}:${entry.model}`, entry] as const),
  );
  return (provider, model) => {
    const key = `${provider}:${model}`;
    const curated = CURATED_PRICING_BY_KEY.get(key);
    const generated = generatedPricing.get(key);
    if (curated && generated) {
      const merged = { ...curated };
      for (const field of OPTIONAL_GENERATED_PRICING_FIELDS) {
        if (merged[field] === undefined && generated[field] !== undefined) {
          merged[field] = generated[field];
        }
      }
      return merged;
    }
    return curated ?? generated ?? null;
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Hash the exact bytes fetched from LiteLLM for manifest provenance. */
export function hashCatalogBytes(bytes: Uint8Array): string {
  return sha256(bytes);
}

function stableCatalogHash(entries: Readonly<Record<string, LiteLLMEntry>>): string {
  const stable = Object.fromEntries(
    Object.entries(entries).sort(([a], [b]) => compareCodeUnits(a, b)),
  );
  return sha256(new TextEncoder().encode(stableJson(stable)));
}

function readSnapshotEntries(snapshot: CatalogSnapshotInput): Readonly<Record<string, LiteLLMEntry>> {
  const candidate = snapshot as CatalogSnapshot;
  if (candidate.entries) return candidate.entries;
  if (candidate.catalog) return candidate.catalog;
  if (candidate.data) return candidate.data;
  return snapshot as Readonly<Record<string, LiteLLMEntry>>;
}

function normalizeSnapshot(
  snapshot: CatalogSnapshotInput,
  options: GenerationOptions = {},
): NormalizedSnapshot {
  const entries = readSnapshotEntries(snapshot);
  const metadata = snapshot as CatalogSnapshot;
  const generatedAt = options.generatedAt
    ?? metadata.generated_at
    ?? metadata.generatedAt
    ?? metadata.fetched_at
    ?? metadata.fetchedAt
    ?? DEFAULT_GENERATED_AT;
  const sourceAsOf = metadata.source_as_of
    ?? metadata.sourceAsOf
    ?? generatedAt;
  const sourceUrl = metadata.source_url
    ?? metadata.sourceUrl
    ?? metadata.source
    ?? DEFAULT_SOURCE_URL;
  const sourceHash = metadata.source_hash
    ?? metadata.sourceHash
    ?? metadata.hash
    ?? ('raw_bytes' in metadata && metadata.raw_bytes
      ? sha256(metadata.raw_bytes)
      : 'raw' in metadata && metadata.raw
        ? sha256(typeof metadata.raw === 'string' ? new TextEncoder().encode(metadata.raw) : metadata.raw)
        : stableCatalogHash(entries));
  return { entries, sourceUrl, sourceHash, sourceAsOf, generatedAt };
}

function previousModels(previous: CatalogRefreshPrevious | null | undefined): readonly PreviousGeneratedCatalogModel[] {
  return previous?.generatedModels ?? previous?.generated_models ?? previous?.models ?? [];
}

function previousPricing(previous: CatalogRefreshPrevious | null | undefined): readonly OutputEntry[] {
  return previous?.pricing ?? [];
}

function previousQuarantined(previous: CatalogRefreshPrevious | null | undefined): readonly CatalogRefreshRecord[] {
  return previous?.quarantined ?? previous?.quarantined_records ?? [];
}

function previousCachePolicies(previous: CatalogRefreshPrevious | null | undefined): readonly CatalogCachePolicyDecision[] {
  return previous?.cachePolicies ?? previous?.cache_policy ?? [];
}

function modelKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

function sortRecords<T extends { provider: string; model: string }>(records: T[]): T[] {
  return records.sort((a, b) => {
    const providerOrder = compareCodeUnits(a.provider, b.provider);
    return providerOrder === 0 ? compareCodeUnits(a.model, b.model) : providerOrder;
  });
}

function sortModels(models: GeneratedCatalogModel[]): GeneratedCatalogModel[] {
  return models.sort((a, b) => {
    const providerOrder = compareCodeUnits(a.provider, b.provider);
    return providerOrder === 0
      ? compareCodeUnits(a.canonical_name, b.canonical_name)
      : providerOrder;
  });
}

function mapModels(models: readonly PreviousGeneratedCatalogModel[]): Map<string, PreviousGeneratedCatalogModel> {
  const map = new Map<string, PreviousGeneratedCatalogModel>();
  for (const model of models) {
    map.set(modelKey(model.provider, model.canonical_name).toLowerCase(), model);
  }
  return map;
}

function isStaleGeneratedModel(provider: string, model: string): boolean {
  if (provider === 'moonshot') {
    return DISCONTINUED_MOONSHOT_PATTERNS.some((pattern) => pattern.test(model));
  }
  if (provider !== 'anthropic' && provider !== 'bedrock') return false;
  return STALE_MODEL_PATTERNS.some((pattern) => pattern.test(model));
}

function runtimeQuarantineReason(provider: string, model: string): string | null {
  const lower = model.toLowerCase();
  if (provider === 'google' && GOOGLE_PREVIEW_QUARANTINE_IDS.some((id) => id === lower)) {
    return `unsupported_model_alias:${provider}:${model}`;
  }
  if (provider === 'bedrock' && !lower.includes('anthropic.') && !lower.includes('claude-')) {
    return `unsupported_runtime_model:${provider}:${model}`;
  }
  if (provider === 'openai' && /^gpt-5\.6-cyber$/.test(lower)) {
    return `unsupported_runtime_model:${provider}:${model}`;
  }
  if (provider === 'openai' && /^daybreak-(?:blue|red)-latest$/.test(lower)) {
    return `unsupported_model_alias:${provider}:${model}`;
  }
  return null;
}
function curatedIds(): Set<string> {
  const ids = new Set<string>();
  for (const model of MODEL_REGISTRY) {
    ids.add(modelKey(model.provider, model.canonical_name).toLowerCase());
    ids.add(modelKey(model.provider, model.api_model_id).toLowerCase());
  }
  return ids;
}

function contextWindow(entry: LiteLLMEntry): number | undefined {
  const context = entry.max_input_tokens ?? entry.max_tokens;
  return typeof context === 'number' ? context : undefined;
}

function invalidPriceReasons(
  provider: string,
  model: string,
  entry: LiteLLMEntry,
): string[] {
  const reasons: string[] = [];
  for (const [field, value] of [
    ['input', entry.input_cost_per_token],
    ['output', entry.output_cost_per_token],
  ] as const) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      reasons.push(`invalid_price:${provider}:${model}:${field}`);
    }
  }
  for (const [field, value] of [
    ['input_above_272k', entry.input_cost_per_token_above_272k_tokens],
    ['output_above_272k', entry.output_cost_per_token_above_272k_tokens],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      reasons.push(`invalid_price:${provider}:${model}:${field}`);
    }
  }
  return reasons;
}

function invalidCacheRateReasons(
  provider: string,
  model: string,
  entry: LiteLLMEntry,
): string[] {
  const reasons: string[] = [];
  for (const [field, value] of [
    ['cache_read', entry.cache_read_input_token_cost],
    ['cache_write', entry.cache_creation_input_token_cost],
    ['cache_read_above_272k', entry.cache_read_input_token_cost_above_272k_tokens],
    ['cache_write_above_272k', entry.cache_creation_input_token_cost_above_272k_tokens],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      reasons.push(`invalid_cache_rate:${provider}:${model}:${field}`);
    }
  }
  return reasons;
}

function invalidOutputEntryReasons(
  provider: string,
  model: string,
  entry: OutputEntry,
): string[] {
  const reasons: string[] = [];
  for (const [field, value] of [
    ['input_above_272k', entry.input_per_million_above_272k],
    ['output_above_272k', entry.output_per_million_above_272k],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      reasons.push(`invalid_price:${provider}:${model}:${field}`);
    }
  }
  for (const [field, value] of [
    ['input', entry.input_per_million],
    ['output', entry.output_per_million],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      reasons.push(`invalid_price:${provider}:${model}:${field}`);
    }
  }
  for (const [field, value] of [
    ['cache_read', entry.cache_read_per_million],
    ['cache_write', entry.cache_write_per_million],
    ['cache_read_above_272k', entry.cache_read_per_million_above_272k],
    ['cache_write_above_272k', entry.cache_write_per_million_above_272k],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      reasons.push(`invalid_cache_rate:${provider}:${model}:${field}`);
    }
  }
  return reasons;
}
function isLiteLLMEntry(value: unknown): value is LiteLLMEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (entry.litellm_provider !== undefined && typeof entry.litellm_provider !== 'string') return false;
  if (entry.mode !== undefined && typeof entry.mode !== 'string') return false;
  for (const field of [
    'input_cost_per_token',
    'output_cost_per_token',
    'cache_read_input_token_cost',
    'cache_creation_input_token_cost',
    'input_cost_per_token_above_272k_tokens',
    'output_cost_per_token_above_272k_tokens',
    'cache_read_input_token_cost_above_272k_tokens',
    'cache_creation_input_token_cost_above_272k_tokens',
    'max_input_tokens',
    'max_output_tokens',
    'max_tokens',
  ]) {
    if (entry[field] !== undefined && typeof entry[field] !== 'number') return false;
  }
  return true;
}


function unsupportedModality(entry: LiteLLMEntry, model: string): string | null {
  if (entry.mode && entry.mode !== 'chat') return entry.mode.toLowerCase();
  const match = model.match(MODALITY_DENYLIST);
  return match ? match[0].toLowerCase() : null;
}

function validContext(context: number | undefined): boolean {
  return typeof context === 'number'
    && Number.isFinite(context)
    && Number.isInteger(context)
    && context > 0
    && context <= MAX_CONTEXT_WINDOW;
}

function makeCacheDecision(
  provider: Provider,
  model: string,
  entry: LiteLLMEntry,
): CatalogCachePolicyDecision {
  const policy = resolveCacheWritePolicy(provider, model, entry);
  return {
    provider,
    model,
    kind: policy.kind,
    ...(policy.kind === 'unknown' ? { reason: policy.reason } : {}),
    ...(policy.kind === 'rate' ? { per_million: policy.perMillion } : {}),
    rule_version: CATALOG_REFRESH_RULE_VERSION,
  };
}

function mapByModel<T extends { provider: string; model: string }>(rows: readonly T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows) map.set(modelKey(row.provider, row.model).toLowerCase(), row);
  return map;
}

function addRecord(records: CatalogRefreshRecord[], record: CatalogRefreshRecord): void {
  if (!records.some((existing) => existing.provider === record.provider && existing.model === record.model && existing.reason === record.reason)) {
    records.push(record);
  }
}

function comparePricing(
  current: readonly OutputEntry[],
  previous: readonly OutputEntry[],
  reviewReasons: string[],
  removed: CatalogRefreshRecord[],
): CatalogPriceDelta[] {
  const currentByKey = mapByModel(current);
  const previousByKey = mapByModel(previous);
  const deltas: CatalogPriceDelta[] = [];
  for (const row of current) {
    const old = previousByKey.get(modelKey(row.provider, row.model).toLowerCase());
    if (!old) continue;
    const inputChanged = row.input_per_million !== old.input_per_million;
    const outputChanged = row.output_per_million !== old.output_per_million;
    const cacheChanged = row.cache_read_per_million !== old.cache_read_per_million
      || row.cache_write_per_million !== old.cache_write_per_million;
    const longFields = [
      ['input_above_272k', old.input_per_million_above_272k, row.input_per_million_above_272k],
      ['output_above_272k', old.output_per_million_above_272k, row.output_per_million_above_272k],
      ['cache_read_above_272k', old.cache_read_per_million_above_272k, row.cache_read_per_million_above_272k],
      ['cache_write_above_272k', old.cache_write_per_million_above_272k, row.cache_write_per_million_above_272k],
    ] as const;
    const longChanged = longFields.some(([, previousValue, nextValue]) => previousValue !== nextValue);
    if (!inputChanged && !outputChanged && !cacheChanged && !longChanged) continue;
    const input = old.input_per_million === 0
      ? 0
      : Math.abs(row.input_per_million - old.input_per_million) / old.input_per_million;
    const output = old.output_per_million === 0
      ? 0
      : Math.abs(row.output_per_million - old.output_per_million) / old.output_per_million;
    const delta: CatalogPriceDelta = {
      provider: row.provider,
      model: row.model,
      input,
      output,
      previous_input: old.input_per_million,
      next_input: row.input_per_million,
      previous_output: old.output_per_million,
      next_output: row.output_per_million,
    };
    for (const [field, previousValue, nextValue] of longFields) {
      if (previousValue === nextValue) continue;
      Object.assign(delta, {
        [field]: previousValue === undefined || nextValue === undefined || previousValue === 0
          ? 0
          : Math.abs(nextValue - previousValue) / previousValue,
        [`previous_${field}`]: previousValue,
        [`next_${field}`]: nextValue,
      });
    }
    deltas.push(delta);
    if (cacheChanged) {
      const reason = `cache_policy_transition:${row.provider}:${row.model}`;
      if (!reviewReasons.includes(reason)) reviewReasons.push(reason);
    }
  }
  for (const row of previous) {
    const key = modelKey(row.provider, row.model).toLowerCase();
    if (currentByKey.has(key)) continue;
    if (!removed.some((record) => record.provider === row.provider && record.model === row.model)) {
      removed.push({ provider: row.provider, model: row.model });
    }
    const reason = `pricing_removed:${row.provider}:${row.model}`;
    if (!reviewReasons.includes(reason)) reviewReasons.push(reason);
  }
  return sortRecords(deltas);
}
function sameCachePolicy(
  current: CatalogCachePolicyDecision,
  previous: CatalogCachePolicyDecision,
): boolean {
  return current.provider === previous.provider
    && current.model === previous.model
    && current.kind === previous.kind
    && current.reason === previous.reason
    && current.per_million === previous.per_million
    && current.rule_version === previous.rule_version;
}

function compareCachePolicies(
  current: readonly CatalogCachePolicyDecision[],
  previous: readonly CatalogCachePolicyDecision[],
  reviewReasons: string[],
): void {
  const previousByKey = mapByModel(previous);
  for (const decision of current) {
    const prior = previousByKey.get(modelKey(decision.provider, decision.model).toLowerCase());
    if (!prior || sameCachePolicy(decision, prior as CatalogCachePolicyDecision)) continue;
    const reason = `cache_policy_transition:${decision.provider}:${decision.model}`;
    if (!reviewReasons.includes(reason)) reviewReasons.push(reason);
  }
}

function compareModels(
  current: readonly GeneratedCatalogModel[],
  previous: readonly GeneratedCatalogModel[],
  reviewReasons: string[],
): {
  added: CatalogRefreshRecord[];
  changed: CatalogRefreshRecord[];
  removed: CatalogRefreshRecord[];
  contextDeltas: CatalogContextDelta[];
} {
  const currentByKey = mapModels(current);
  const previousByKey = mapModels(previous);
  const added: CatalogRefreshRecord[] = [];
  const changed: CatalogRefreshRecord[] = [];
  const removed: CatalogRefreshRecord[] = [];
  const contextDeltas: CatalogContextDelta[] = [];

  for (const model of current) {
    const key = modelKey(model.provider, model.canonical_name).toLowerCase();
    const old = previousByKey.get(key);
    if (!old) {
      added.push({ provider: model.provider, model: model.canonical_name });
      const reason = `missing_second_source_evidence:${model.provider}:${model.canonical_name}`;
      if (!reviewReasons.includes(reason)) reviewReasons.push(reason);
      continue;
    }
    if (model.api_model_id !== old.api_model_id || model.context_window !== old.context_window) {
      changed.push({ provider: model.provider, model: model.canonical_name });
    }
    if (model.context_window !== old.context_window) {
      const delta = old.context_window === 0
        ? 0
        : Math.abs(model.context_window - old.context_window) / old.context_window;
      contextDeltas.push({
        provider: model.provider,
        model: model.canonical_name,
        previous: old.context_window,
        next: model.context_window,
        delta,
      });
    }
  }
  for (const model of previous) {
    const key = modelKey(model.provider, model.canonical_name).toLowerCase();
    if (!currentByKey.has(key)) {
      const record = { provider: model.provider, model: model.canonical_name };
      removed.push(record);
      const reason = `model_removed:${model.provider}:${model.canonical_name}`;
      if (!reviewReasons.includes(reason)) reviewReasons.push(reason);
    }
  }

  return {
    added: sortRecords(added),
    changed: sortRecords(changed),
    removed: sortRecords(removed),
    contextDeltas: sortRecords(contextDeltas),
  };
}

/** Generate all refresh artifacts from one already-parsed upstream snapshot. */
export function generateCatalogRefresh(
  snapshot: CatalogSnapshotInput,
  previous: CatalogRefreshPrevious | null | undefined = {},
  generatedAtOrOptions?: string | GenerationOptions,
): CatalogRefreshProposal {
  const options: GenerationOptions = typeof generatedAtOrOptions === 'string'
    ? { generatedAt: generatedAtOrOptions }
    : generatedAtOrOptions ?? {};
  const normalized = normalizeSnapshot(snapshot, options);
  const invalidReasons: string[] = [];
  const reviewReasons: string[] = [];
  const quarantined: CatalogRefreshRecord[] = [];
  const generatedModels: GeneratedCatalogModel[] = [];
  const pricingByKey = new Map<string, OutputEntry>();
  const cachePolicies: CatalogCachePolicyDecision[] = [];
  const seenIds = new Map<string, { signature: string; hasTokenPrice: boolean }>();
  const curated = curatedIds();
  const supportedProviders = new Set<string>(PROVIDERS);

  const snapshotEntries = Object.entries(normalized.entries).sort(([a], [b]) => (
    Number(GEMINI_ALIAS_WRAPPER.test(a)) - Number(GEMINI_ALIAS_WRAPPER.test(b))
  ));
  for (const [rawKey, rawEntry] of snapshotEntries) {
    if (rawKey === 'sample_spec') continue;
    if (!isLiteLLMEntry(rawEntry)) {
      invalidReasons.push(`source_schema_invalid_entry:${rawKey}`);
      continue;
    }
    if (isNonModelSourceKey(rawKey)) continue;
    // The refresh artifacts are chat-model data. Ignore LiteLLM's valid
    // non-chat rows before any pricing, context, or ID validation.
    if (rawEntry.mode !== undefined && rawEntry.mode !== 'chat') continue;
    if (isNonTokenChatEntry(rawEntry)) continue;
    const provider = mappedProvider(rawEntry);
    if (!provider || !supportedProviders.has(provider)) continue;
    const model = stripProviderPrefix(rawKey);
    const key = modelKey(provider, model).toLowerCase();
    const isCurated = curated.has(key);

    const hasInputPrice = typeof rawEntry.input_cost_per_token === 'number' && rawEntry.input_cost_per_token > 0;
    const hasOutputPrice = typeof rawEntry.output_cost_per_token === 'number' && rawEntry.output_cost_per_token > 0;
    const hasTokenPrice = hasInputPrice || hasOutputPrice;
    const priorSeen = seenIds.get(key);
    if (priorSeen && priorSeen.hasTokenPrice !== hasTokenPrice) {
      invalidReasons.push(`duplicate_model_id:${provider}:${model}`);
      continue;
    }
    if (!hasTokenPrice) {
      if (priorSeen) continue;
      seenIds.set(key, { hasTokenPrice: false, signature: 'missing_token_pricing' });
      const reason = `missing_token_pricing:${provider}:${model}`;
      addRecord(quarantined, { provider, model, reason, kind: 'pricing' });
      reviewReasons.push(reason);
      continue;
    }

    const preflightPriceReasons = [
      ...invalidPriceReasons(provider, model, rawEntry),
      ...invalidCacheRateReasons(provider, model, rawEntry),
    ];
    if (preflightPriceReasons.length > 0) {
      invalidReasons.push(...preflightPriceReasons);
      continue;
    }

    const modality = unsupportedModality(rawEntry, model);
    if (modality) {
      invalidReasons.push(`unsupported_modality:${modality}:${provider}:${model}`);
      continue;
    }
    const validModelId = SAFE_ID.test(model)
      || (provider === 'bedrock' && BEDROCK_SAFE_ID.test(model));
    if (!SAFE_ID.test(provider) || !validModelId) {
      const reason = `unsafe_model_id:${provider}:${model}`;
      const sourceNamespace = model.includes('/')
        || model.startsWith('ft:')
        || model.includes('@');
      if (sourceNamespace) {
        addRecord(quarantined, { provider, model, reason, kind: 'model' });
        reviewReasons.push(reason);
      } else {
        invalidReasons.push(reason);
      }
      continue;
    }
    if (isStaleGeneratedModel(provider, model)) {
      const reason = `stale_model:${provider}:${model}`;
      addRecord(quarantined, { provider, model, reason, kind: 'model' });
      reviewReasons.push(reason);
      continue;
    }

    const pricingResult = toOutputEntryResult(rawKey, rawEntry);
    const cachePolicy = makeCacheDecision(provider as Provider, model, rawEntry);
    const context = contextWindow(rawEntry);
    const emittedSignature = JSON.stringify({
      pricing: pricingResult,
      cache_policy: cachePolicy,
      context_window: context,
    });
    const previousSeen = seenIds.get(key);
    if (previousSeen !== undefined) {
      if (previousSeen.hasTokenPrice && previousSeen.signature === emittedSignature) continue;
      if (GEMINI_ALIAS_WRAPPER.test(rawKey)) continue;
      invalidReasons.push(`duplicate_model_id:${provider}:${model}`);
      continue;
    }
    seenIds.set(key, { hasTokenPrice: true, signature: emittedSignature });

    if (pricingResult?.kind === 'quarantine') {
      addRecord(quarantined, {
        provider: pricingResult.provider,
        model: pricingResult.model,
        reason: pricingResult.reason,
        kind: 'cache_policy',
      });
      reviewReasons.push(pricingResult.reason);
      cachePolicies.push(cachePolicy);
      continue;
    }
    if (!pricingResult || pricingResult.kind !== 'entry') {
      if (!isCurated) invalidReasons.push(...invalidPriceReasons(provider, model, rawEntry));
      continue;
    }

    const pricing = pricingResult.entry;
    const emittedRateReasons = invalidOutputEntryReasons(provider, model, pricing);
    if (emittedRateReasons.length > 0) {
      invalidReasons.push(...emittedRateReasons);
      continue;
    }
    if (pricingByKey.has(key)) {
      invalidReasons.push(`duplicate_pricing_id:${provider}:${model}`);
    } else {
      pricingByKey.set(key, pricing);
    }
    cachePolicies.push(cachePolicy);
    const runtimeReason = runtimeQuarantineReason(provider, model);
    if (runtimeReason) {
      addRecord(quarantined, { provider, model, reason: runtimeReason, kind: 'model' });
      reviewReasons.push(runtimeReason);
      continue;
    }
    if (isCurated) continue;
    const priceReasons = invalidPriceReasons(provider, model, rawEntry);
    if (priceReasons.length > 0) {
      invalidReasons.push(...priceReasons);
      continue;
    }
    if (!validContext(context)) {
      if (context === undefined) {
        const reason = `missing_context_window:${provider}:${model}`;
        addRecord(quarantined, { provider, model, reason, kind: 'context' });
        reviewReasons.push(reason);
      } else {
        invalidReasons.push(`invalid_context_window:${provider}:${model}`);
      }
      continue;
    }
    generatedModels.push({
      provider: provider as Provider,
      canonical_name: model,
      api_model_id: model,
      context_window: context,
      source: 'generated',
      public: true,
      explicit_only: true,
      auto_route: false,
      source_url: normalized.sourceUrl,
      source_hash: normalized.sourceHash,
      source_as_of: normalized.sourceAsOf,
    });
  }

function globalProviderPriority(provider: string): number {
  // Bare IDs from a native provider must never be silently redirected to an
  // Azure/Bedrock deployment alias. Keep direct providers ahead of those
  // compatibility namespaces; ties retain the deterministic source order.
  return provider === 'azure' || provider === 'bedrock' ? 1 : 0;
}

function currentGlobalCollisionWins(current: GeneratedCatalogModel, prior: GeneratedCatalogModel): boolean {
  return globalProviderPriority(current.provider) < globalProviderPriority(prior.provider);
}

  const generatedById = new Map<string, GeneratedCatalogModel>();
  for (const model of generatedModels) {
    const id = model.canonical_name.toLowerCase();
    const prior = generatedById.get(id);
    if (!prior) {
      generatedById.set(id, model);
      continue;
    }
    const keepCurrent = currentGlobalCollisionWins(model, prior);
    const dropped = keepCurrent ? prior : model;
    const reason = `duplicate_global_model_id:${dropped.provider}:${dropped.canonical_name}`;
    addRecord(quarantined, { provider: dropped.provider, model: dropped.canonical_name, reason, kind: 'model' });
    reviewReasons.push(reason);
    if (keepCurrent) generatedById.set(id, model);
  }
  const dedupedGeneratedModels = [...generatedById.values()];
  const pricing = sortRecords([...pricingByKey.values()]);
  const previousModelsValue = previousModels(previous);
  const previousPricingValue = previousPricing(previous);
  const modelDiff = compareModels(dedupedGeneratedModels, previousModelsValue, reviewReasons);
  const removed = sortRecords(modelDiff.removed);
  const priceDeltas = comparePricing(pricing, previousPricingValue, reviewReasons, removed);
  compareCachePolicies(cachePolicies, previousCachePolicies(previous), reviewReasons);
  const proposalWithoutVerdict: Omit<CatalogRefreshProposal, 'verdict'> = {
    generatedModels: sortModels(dedupedGeneratedModels),
    pricing,
    added: modelDiff.added,
    changed: modelDiff.changed,
    removed,
    quarantined: sortRecords(quarantined),
    priceDeltas,
    contextDeltas: modelDiff.contextDeltas,
    cachePolicies: sortRecords(cachePolicies),
    invalidReasons: [...new Set(invalidReasons)],
    reviewReasons: [...new Set(reviewReasons)],
    manifest: {
      schema_version: 1,
      generated_at: normalized.generatedAt,
      source_url: normalized.sourceUrl,
      source_hash: normalized.sourceHash,
      previous_source_hash: previous?.source_hash ?? previous?.sourceHash ?? null,
      added: modelDiff.added,
      changed: modelDiff.changed,
      removed,
      quarantined: sortRecords(quarantined),
      price_deltas: priceDeltas,
      context_deltas: modelDiff.contextDeltas,
      cache_policy: sortRecords(cachePolicies),
      verdict: { kind: 'safe', reasons: [] },
    },
  };
  const verdict = classifyCatalogRefresh({
    ...proposalWithoutVerdict,
    verdict: { kind: 'safe', reasons: [] },
  }, previous ?? undefined);
  proposalWithoutVerdict.manifest.verdict = verdict;
  return { ...proposalWithoutVerdict, verdict };
}

function quoted(value: string): string {
  return JSON.stringify(value);
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  if (value === undefined) return 'null';
  return JSON.stringify(value);
}
function deterministicManifest(manifest: CatalogFreshnessManifest): CatalogFreshnessManifest {
  return {
    ...manifest,
    added: sortRecords([...manifest.added]),
    changed: sortRecords([...manifest.changed]),
    removed: sortRecords([...manifest.removed]),
    quarantined: sortRecords([...manifest.quarantined]),
    price_deltas: sortRecords([...manifest.price_deltas]),
    context_deltas: sortRecords([...manifest.context_deltas]),
    cache_policy: sortRecords([...manifest.cache_policy]),
    verdict: { ...manifest.verdict, reasons: [...manifest.verdict.reasons].sort() },
  };
}


/** Render the generated explicit-only supplement with stable ordering. */
export function renderGeneratedModels(models: readonly GeneratedCatalogModel[]): string {
  const ordered = sortModels([...models]);
  const lines = [
    '// AUTO-GENERATED — do not edit by hand.',
    '// Regenerate with: pnpm --filter @routeshift/shared refresh-catalog',
    "import type { Provider } from './models';",
    '',
    'export interface GeneratedCatalogModel {',
    '  provider: Provider;',
    '  canonical_name: string;',
    '  api_model_id: string;',
    '  context_window: number;',
    "  source: 'generated';",
    '  public: true;',
    '  explicit_only: true;',
    '  auto_route: false;',
    '  source_url: string;',
    '  source_hash: string;',
    '  source_as_of: string;',
    '}',
    '',
    'export const GENERATED_MODEL_CATALOG: GeneratedCatalogModel[] = [',
  ];
  for (const model of ordered) {
    lines.push(
      `  { provider: ${quoted(model.provider)}, canonical_name: ${quoted(model.canonical_name)}, api_model_id: ${quoted(model.api_model_id)}, context_window: ${model.context_window}, source: 'generated', public: true, explicit_only: true, auto_route: false, source_url: ${quoted(model.source_url)}, source_hash: ${quoted(model.source_hash)}, source_as_of: ${quoted(model.source_as_of)} },`,
    );
  }
  lines.push('];', 'export const GENERATED_MODELS = GENERATED_MODEL_CATALOG;', 'export default GENERATED_MODEL_CATALOG;', '', '');
  return lines.join('\n');
}
export function renderCurrentModels(
  recommendations: CatalogRecommendations,
  catalog: readonly EffectiveCatalogDefinition[],
): string {
  const roles = ['default', 'economy', 'coding', 'reasoning'] as const;
  const rows = roles.map((role) => {
    const canonicalName = recommendations[role];
    const model = catalog.find((candidate) => candidate.canonical_name === canonicalName);
    if (!model || model.public === false) {
      throw new Error(`Current model role ${role} does not resolve to a public catalog model: ${canonicalName}`);
    }
    return { role, canonicalName, provider: model.provider, contextWindow: model.context_window };
  });
  const lines = [
    '// AUTO-GENERATED — do not edit by hand.',
    '// Regenerate with: pnpm --filter @routeshift/shared refresh-catalog',
    "import type { Provider } from './models';",
    '',
    'export const CURRENT_MODEL_ROLES = [\'default\', \'economy\', \'coding\', \'reasoning\'] as const;',
    'export type CurrentModelRole = (typeof CURRENT_MODEL_ROLES)[number];',
    'export interface CurrentModelFixture {',
    '  provider: Provider;',
    '  canonical_name: string;',
    '  context_window: number;',
    '}',
    'export type CurrentModelFixtureSet = Record<CurrentModelRole, CurrentModelFixture>;',
    '',
    'export const CURRENT_MODEL_FIXTURE: CurrentModelFixtureSet = {',
  ];
  for (const row of rows) {
    lines.push(`  ${row.role}: { provider: ${quoted(row.provider)}, canonical_name: ${quoted(row.canonicalName)}, context_window: ${row.contextWindow} },`);
  }
  lines.push('};', '', 'export default CURRENT_MODEL_FIXTURE;', '');
  return lines.join('\n');
}


export function renderFreshnessManifest(manifest: CatalogFreshnessManifest): string {
  const json = JSON.stringify(JSON.parse(stableJson(deterministicManifest(manifest))), null, 2);
  return [
    '// AUTO-GENERATED — do not edit by hand.',
    '// Regenerate with: pnpm --filter @routeshift/shared refresh-catalog',
    '',
    `export const CATALOG_FRESHNESS_MANIFEST = ${json} as const;`,
    'export const CATALOG_FRESHNESS = CATALOG_FRESHNESS_MANIFEST;',
    'export default CATALOG_FRESHNESS_MANIFEST;',
    '',
  ].join('\n');
}

export function renderPricing(pricing: readonly OutputEntry[], sourceUrl: string, generatedAt: string): string {
  const ordered = sortRecords([...pricing]);
  const lines = [
    '// AUTO-GENERATED — do not edit by hand.',
    '// Regenerate with: pnpm --filter @routeshift/shared refresh-catalog',
    `// Source: ${sourceUrl}`,
    '',
    "import type { ModelPricing } from './cost-tables';",
    '',
    'export const LITELLM_GENERATED_PRICING: ModelPricing[] = [',
  ];
  for (const entry of ordered) {
    const cache = [
      entry.cache_read_per_million === undefined ? '' : `, cache_read_per_million: ${entry.cache_read_per_million}`,
      entry.cache_write_per_million === undefined ? '' : `, cache_write_per_million: ${entry.cache_write_per_million}`,
      entry.input_per_million_above_272k === undefined ? '' : `, input_per_million_above_272k: ${entry.input_per_million_above_272k}`,
      entry.output_per_million_above_272k === undefined ? '' : `, output_per_million_above_272k: ${entry.output_per_million_above_272k}`,
      entry.cache_read_per_million_above_272k === undefined ? '' : `, cache_read_per_million_above_272k: ${entry.cache_read_per_million_above_272k}`,
      entry.cache_write_per_million_above_272k === undefined ? '' : `, cache_write_per_million_above_272k: ${entry.cache_write_per_million_above_272k}`,
    ].join('');
    lines.push(
      `  { provider: ${quoted(entry.provider)}, model: ${quoted(entry.model)}, input_per_million: ${entry.input_per_million}, output_per_million: ${entry.output_per_million}${cache} },`,
    );
  }
  lines.push('];', '', `export const LITELLM_GENERATED_AT: string = ${quoted(generatedAt)};`, '');
  return lines.join('\n');
}
export function renderDocsCatalogArtifact(
  artifact: DocsCatalogArtifactV1 = buildDocsCatalogArtifact(),
): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

function outputPaths(outDir: string): CatalogRefreshOutputPaths {
  return {
    generatedModels: join(outDir, 'generated-model-catalog.ts'),
    pricing: join(outDir, 'litellm-pricing.generated.ts'),
    manifest: join(outDir, 'catalog-freshness.generated.ts'),
    currentModels: join(outDir, 'current-models.generated.ts'),
    docsCatalog: join(outDir, 'docs-catalog.generated.json'),
  };
}

function extractLiteral(source: string, marker: string, opening: '{' | '['): string {
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) throw new Error(`Missing generated export: ${marker}`);
  const equalsIndex = source.indexOf('=', markerIndex);
  const start = source.indexOf(opening, equalsIndex === -1 ? markerIndex : equalsIndex + 1);
  if (start === -1) throw new Error(`Missing generated literal: ${marker}`);
  const closing = opening === '{' ? '}' : ']';
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === opening) {
      depth += 1;
    } else if (character === closing) {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unterminated generated literal: ${marker}`);
}

function parseGeneratedArray(source: string, marker: string): unknown[] {
  const literal = extractLiteral(source, marker, '[')
    .replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g, '$1"$2":')
    .replace(/'/g, '"')
    .replace(/(\d)_(?=\d)/g, '$1')
    .replace(/,\s*([}\]])/g, '$1');
  const parsed: unknown = JSON.parse(literal);
  if (!Array.isArray(parsed)) throw new Error(`Generated export is not an array: ${marker}`);
  return parsed;
}

function parseGeneratedManifest(source: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(extractLiteral(source, 'export const CATALOG_FRESHNESS_MANIFEST', '{'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Generated freshness manifest is not an object');
  }
  return parsed as Record<string, unknown>;
}

function requireString(value: unknown, field: string, path: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid prior ${field} in ${path}`);
  return value;
}

function requireFiniteNumber(value: unknown, field: string, path: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new Error(`Invalid prior ${field} in ${path}`);
  }
  return value;
}

function parsePriorRecord(value: unknown, path: string): CatalogRefreshRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid prior quarantine record in ${path}`);
  }
  const row = value as Record<string, unknown>;
  const kind = row.kind;
  if (kind !== undefined && !['model', 'pricing', 'context', 'cache_policy'].includes(String(kind))) {
    throw new Error(`Invalid prior quarantine kind in ${path}`);
  }
  if (row.reason !== undefined && typeof row.reason !== 'string') {
    throw new Error(`Invalid prior quarantine reason in ${path}`);
  }
  return {
    provider: requireString(row.provider, 'provider', path),
    model: requireString(row.model, 'model', path),
    ...(row.reason === undefined ? {} : { reason: row.reason as string }),
    ...(kind === undefined ? {} : { kind: kind as CatalogRefreshRecord['kind'] }),
  };
}

function parsePriorCachePolicy(value: unknown, path: string): CatalogCachePolicyDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid prior cache policy in ${path}`);
  }
  const row = value as Record<string, unknown>;
  const kind = row.kind;
  if (!['rate', 'input_multiplier', 'not_billed', 'unknown'].includes(String(kind))) {
    throw new Error(`Invalid prior cache policy kind in ${path}`);
  }
  if (row.reason !== undefined && typeof row.reason !== 'string') {
    throw new Error(`Invalid prior cache policy reason in ${path}`);
  }
  if (row.per_million !== undefined) {
    requireFiniteNumber(row.per_million, 'per_million', path, 0);
  }
  return {
    provider: requireString(row.provider, 'provider', path),
    model: requireString(row.model, 'model', path),
    kind: kind as CatalogCachePolicyDecision['kind'],
    ...(row.reason === undefined ? {} : { reason: row.reason as string }),
    ...(row.per_million === undefined ? {} : { per_million: row.per_million as number }),
    rule_version: requireString(row.rule_version, 'rule_version', path),
  };
}

export function loadPreviousRefreshState(outDir: string): CatalogRefreshPrevious {
  const paths = outputPaths(resolve(outDir));
  const previous: CatalogRefreshPrevious = {};
  if (existsSync(paths.generatedModels)) {
    const rows = parseGeneratedArray(
      readFileSync(paths.generatedModels, 'utf8'),
      'export const GENERATED_MODEL_CATALOG',
    );
    previous.generatedModels = rows.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Invalid prior generated model in ${paths.generatedModels}`);
      }
      const row = value as Record<string, unknown>;
      return {
        provider: requireString(row.provider, 'provider', paths.generatedModels) as Provider,
        canonical_name: requireString(row.canonical_name, 'canonical_name', paths.generatedModels),
        api_model_id: requireString(row.api_model_id, 'api_model_id', paths.generatedModels),
        context_window: requireFiniteNumber(row.context_window, 'context_window', paths.generatedModels, 1),
      };
    });
  }
  if (existsSync(paths.pricing)) {
    const rows = parseGeneratedArray(
      readFileSync(paths.pricing, 'utf8'),
      'export const LITELLM_GENERATED_PRICING',
    );
    previous.pricing = rows.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Invalid prior pricing row in ${paths.pricing}`);
      }
      const row = value as Record<string, unknown>;
      const pricing: OutputEntry = {
        provider: requireString(row.provider, 'provider', paths.pricing),
        model: requireString(row.model, 'model', paths.pricing),
        input_per_million: requireFiniteNumber(row.input_per_million, 'input_per_million', paths.pricing, 0),
        output_per_million: requireFiniteNumber(row.output_per_million, 'output_per_million', paths.pricing, 0),
      };
      if (row.cache_read_per_million !== undefined) {
        pricing.cache_read_per_million = requireFiniteNumber(row.cache_read_per_million, 'cache_read_per_million', paths.pricing, 0);
      }
      if (row.cache_write_per_million !== undefined) {
        pricing.cache_write_per_million = requireFiniteNumber(row.cache_write_per_million, 'cache_write_per_million', paths.pricing, 0);
      }
      if (row.input_per_million_above_272k !== undefined) {
        pricing.input_per_million_above_272k = requireFiniteNumber(row.input_per_million_above_272k, 'input_per_million_above_272k', paths.pricing, Number.MIN_VALUE);
      }
      if (row.output_per_million_above_272k !== undefined) {
        pricing.output_per_million_above_272k = requireFiniteNumber(row.output_per_million_above_272k, 'output_per_million_above_272k', paths.pricing, Number.MIN_VALUE);
      }
      if (row.cache_read_per_million_above_272k !== undefined) {
        pricing.cache_read_per_million_above_272k = requireFiniteNumber(row.cache_read_per_million_above_272k, 'cache_read_per_million_above_272k', paths.pricing, 0);
      }
      if (row.cache_write_per_million_above_272k !== undefined) {
        pricing.cache_write_per_million_above_272k = requireFiniteNumber(row.cache_write_per_million_above_272k, 'cache_write_per_million_above_272k', paths.pricing, 0);
      }
      return pricing;
    });
  }
  if (existsSync(paths.manifest)) {
    const manifest = parseGeneratedManifest(readFileSync(paths.manifest, 'utf8'));
    previous.source_hash = typeof manifest.source_hash === 'string' ? manifest.source_hash : null;
    previous.generated_at = typeof manifest.generated_at === 'string' ? manifest.generated_at : undefined;

    const quarantineValue = manifest.quarantined ?? manifest.quarantined_records;
    if (quarantineValue !== undefined) {
      if (!Array.isArray(quarantineValue)) {
        throw new Error(`Invalid prior quarantined records in ${paths.manifest}`);
      }
      previous.quarantined = quarantineValue.map((value) => parsePriorRecord(value, paths.manifest));
    }

    const cachePolicyValue = manifest.cache_policy ?? manifest.cachePolicies;
    if (cachePolicyValue !== undefined) {
      if (!Array.isArray(cachePolicyValue)) {
        throw new Error(`Invalid prior cache policy records in ${paths.manifest}`);
      }
      const defaultRuleVersion = typeof manifest.cache_policy_rule_version === 'string'
        ? manifest.cache_policy_rule_version
        : typeof manifest.rule_version === 'string'
          ? manifest.rule_version
          : undefined;
      previous.cachePolicies = cachePolicyValue.map((value) => {
        if (
          defaultRuleVersion
          && value
          && typeof value === 'object'
          && !Array.isArray(value)
          && (value as Record<string, unknown>).rule_version === undefined
        ) {
          return parsePriorCachePolicy(
            { ...(value as Record<string, unknown>), rule_version: defaultRuleVersion },
            paths.manifest,
          );
        }
        return parsePriorCachePolicy(value, paths.manifest);
      });
    }
  }
  return previous;
}


/**
 * Stage and replace all generated outputs only after every renderer succeeds.
 * Invalid proposals never touch the output directory.
 */
export function writeCatalogRefreshOutputs(
  proposal: CatalogRefreshProposal,
  outDir: string,
  dependencies: CatalogRefreshWriteDependencies = {},
): CatalogRefreshOutputPaths {
  if (proposal.verdict.kind === 'invalid') {
    throw new Error(`Catalog refresh is invalid: ${proposal.verdict.reasons.join('; ')}`);
  }
  const targetDir = resolve(outDir);
  const paths = outputPaths(targetDir);
  const rendered = new Map<string, string>();
  try {
    rendered.set(paths.generatedModels, renderGeneratedModels(proposal.generatedModels));
    rendered.set(paths.pricing, renderPricing(proposal.pricing, proposal.manifest.source_url, proposal.manifest.generated_at));
    rendered.set(paths.manifest, renderFreshnessManifest(proposal.manifest));
    const effectiveCatalog = mergeCatalogDefinitions(MODEL_REGISTRY, proposal.generatedModels);
    const pricingLookup = proposalPricingLookup(proposal.pricing);
    const docsCatalog = buildDocsCatalogArtifact({
      generatedModels: proposal.generatedModels,
      pricingLookup,
      generatedAt: proposal.manifest.generated_at,
      sourceHash: proposal.manifest.source_hash,
    });
    rendered.set(paths.currentModels, renderCurrentModels(docsCatalog.recommendations, effectiveCatalog));
    rendered.set(paths.docsCatalog, renderDocsCatalogArtifact(docsCatalog));
  } catch (error) {
    throw new Error(`Catalog refresh rendering failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  mkdirSync(targetDir, { recursive: true });
  const staged: Array<{
    path: string;
    temporary: string;
    backup: string | null;
    installed: boolean;
  }> = [];
  const suffix = `${process.pid}-${Date.now()}`;
  let replacementsCommitted = false;
  try {
    let index = 0;
    for (const [path, content] of rendered) {
      const temporary = `${path}.tmp-${suffix}-${index++}`;
      const item: {
        path: string;
        temporary: string;
        backup: string | null;
        installed: boolean;
      } = { path, temporary, backup: null, installed: false };
      staged.push(item);
      writeFileSync(temporary, content, 'utf8');
    }
    for (const item of staged) {
      if (existsSync(item.path)) {
        item.backup = `${item.path}.bak-${suffix}`;
        renameSync(item.path, item.backup);
      }
      renameSync(item.temporary, item.path);
      item.installed = true;
    }
    replacementsCommitted = true;
  } catch (error) {
    if (!replacementsCommitted) {
      for (const item of [...staged].reverse()) {
        if (item.installed) rmSync(item.path, { force: true });
        if (item.backup && existsSync(item.backup)) renameSync(item.backup, item.path);
        rmSync(item.temporary, { force: true });
      }
    }
    throw error;
  }

  const remove = dependencies.remove ?? ((path: string) => rmSync(path, { force: true }));
  for (const item of staged) {
    if (item.backup) {
      try {
        remove(item.backup);
      } catch {
        // Replacements are already committed; cleanup is best effort and must
        // never roll back or remove the newly-installed outputs.
      }
    }
    try {
      remove(item.temporary);
    } catch {
      // A leftover sibling temp file is harmless and can be cleaned next run.
    }
  }
  return paths;
}

export interface RunCatalogRefreshOptions {
  outDir: string;
  generatedAt?: string;
  previous?: CatalogRefreshPrevious;
}

/** Fetch exactly once, hash the raw body, parse once, then generate and write. */
export async function runCatalogRefresh(options: RunCatalogRefreshOptions): Promise<CatalogRefreshProposal> {
  const fetched = await fetchLiteLLMCatalogRaw();
  const sourceHash = hashCatalogBytes(fetched.bytes);
  const entries = parseLiteLLMCatalog(fetched.text);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const proposal = generateCatalogRefresh(
    {
      entries,
      source_url: LITELLM_SOURCE,
      source_hash: sourceHash,
      source_as_of: generatedAt,
      generated_at: generatedAt,
    },
    options.previous ?? loadPreviousRefreshState(options.outDir),
  );
  writeCatalogRefreshOutputs(proposal, options.outDir);
  return proposal;
}

function parseCliOptions(argv: readonly string[]): RunCatalogRefreshOptions {
  let outDir: string | undefined;
  let generatedAt: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out-dir') outDir = argv[++index];
    else if (arg === '--generated-at') generatedAt = argv[++index];
  }
  if (!outDir) {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    outDir = join(scriptDir, '..', 'src');
  }
  return { outDir, generatedAt };
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const proposal = await runCatalogRefresh(options);
  console.log(JSON.stringify({
    verdict: proposal.verdict,
    generated_models: proposal.generatedModels.length,
    pricing: proposal.pricing.length,
    output_dir: resolve(options.outDir),
  }, null, 2));
}

const invokedDirectly = process.argv[1]?.endsWith('catalog-refresh.ts');
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
