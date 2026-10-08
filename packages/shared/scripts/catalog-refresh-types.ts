import type { Provider } from '../src/models.js';
import type { OutputEntry } from './sync-pricing.js';
import type { LiteLLMEntry } from './litellm-source.js';

/** Parsed one-shot LiteLLM input plus the provenance needed for generated files. */
export interface CatalogSnapshot {
  /** Parsed upstream records. `catalog` is accepted as a compatibility alias. */
  entries?: Readonly<Record<string, LiteLLMEntry>>;
  catalog?: Readonly<Record<string, LiteLLMEntry>>;
  data?: Readonly<Record<string, LiteLLMEntry>>;
  source_url?: string;
  sourceUrl?: string;
  source?: string;
  source_hash?: string;
  sourceHash?: string;
  hash?: string;
  source_as_of?: string;
  sourceAsOf?: string;
  fetched_at?: string;
  fetchedAt?: string;
  generated_at?: string;
  generatedAt?: string;
  /** Raw source bytes are optional for callers that hash before constructing a snapshot. */
  raw_bytes?: Uint8Array;
  raw?: Uint8Array | string;
}

/** Previously committed generated state used only for a pure in-memory diff. */
export type PreviousGeneratedCatalogModel = Pick<
  GeneratedCatalogModel,
  'provider' | 'canonical_name' | 'api_model_id' | 'context_window'
>;

export interface CatalogRefreshPrevious {
  generatedModels?: readonly PreviousGeneratedCatalogModel[];
  generated_models?: readonly PreviousGeneratedCatalogModel[];
  models?: readonly PreviousGeneratedCatalogModel[];
  pricing?: readonly OutputEntry[];
  quarantined?: readonly CatalogRefreshRecord[];
  quarantined_records?: readonly CatalogRefreshRecord[];
  cachePolicies?: readonly CatalogCachePolicyDecision[];
  cache_policy?: readonly CatalogCachePolicyDecision[];
  source_hash?: string | null;
  sourceHash?: string | null;
  generated_at?: string;
  generatedAt?: string;
}
export interface GeneratedCatalogModel {
  provider: Provider;
  canonical_name: string;
  api_model_id: string;
  context_window: number;
  source: 'generated';
  public: true;
  explicit_only: true;
  auto_route: false;
  source_url: string;
  source_hash: string;
  source_as_of: string;
}

export interface CatalogRefreshRecord {
  provider: string;
  model: string;
  reason?: string;
  kind?: 'model' | 'pricing' | 'context' | 'cache_policy';
}

/** Per-field fractional change. A value of 0.25 is exactly the safe boundary. */
export interface CatalogPriceDelta {
  provider: string;
  model: string;
  input: number;
  output: number;
  previous_input?: number;
  next_input?: number;
  previous_output?: number;
  next_output?: number;
  input_above_272k?: number;
  output_above_272k?: number;
  cache_read_above_272k?: number;
  cache_write_above_272k?: number;
  previous_input_above_272k?: number;
  next_input_above_272k?: number;
  previous_output_above_272k?: number;
  next_output_above_272k?: number;
  previous_cache_read_above_272k?: number;
  next_cache_read_above_272k?: number;
  previous_cache_write_above_272k?: number;
  next_cache_write_above_272k?: number;
}

export interface CatalogContextDelta {
  provider: string;
  model: string;
  previous: number;
  next: number;
  delta?: number;
}

export interface CatalogCachePolicyDecision {
  provider: string;
  model: string;
  kind: 'rate' | 'input_multiplier' | 'not_billed' | 'unknown';
  reason?: string;
  per_million?: number;
  rule_version: string;
}

export interface CatalogFreshnessManifest {
  schema_version: 1;
  generated_at: string;
  source_url: string;
  source_hash: string;
  previous_source_hash: string | null;
  added: readonly CatalogRefreshRecord[];
  changed: readonly CatalogRefreshRecord[];
  removed: readonly CatalogRefreshRecord[];
  quarantined: readonly CatalogRefreshRecord[];
  price_deltas: readonly CatalogPriceDelta[];
  context_deltas: readonly CatalogContextDelta[];
  cache_policy: readonly CatalogCachePolicyDecision[];
  verdict: CatalogRefreshVerdict;
}

export type CatalogRefreshVerdict =
  | { kind: 'safe'; reasons: string[] }
  | { kind: 'review_required'; reasons: string[] }
  | { kind: 'invalid'; reasons: string[] };

export interface CatalogRefreshProposal {
  generatedModels: GeneratedCatalogModel[];
  pricing: OutputEntry[];
  added: CatalogRefreshRecord[];
  changed: CatalogRefreshRecord[];
  removed: CatalogRefreshRecord[];
  quarantined: CatalogRefreshRecord[];
  priceDeltas: CatalogPriceDelta[];
  contextDeltas: CatalogContextDelta[];
  cachePolicies: CatalogCachePolicyDecision[];
  invalidReasons: string[];
  reviewReasons: string[];
  manifest: CatalogFreshnessManifest;
  verdict: CatalogRefreshVerdict;
}

/** Input accepted by the pure generator; a bare parsed catalog is also supported. */
export type CatalogSnapshotInput = CatalogSnapshot | Readonly<Record<string, LiteLLMEntry>>;
