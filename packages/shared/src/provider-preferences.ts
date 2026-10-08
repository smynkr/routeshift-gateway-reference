import { PROVIDERS, type Provider } from './models';
import { getModelPricing } from './cost-tables';

export type DataCollectionPreference = 'allow' | 'deny';

export interface ProviderEndpoint {
  provider: string;
  model: string;
  zdr?: boolean;
  throughput_hint?: number;
  /** Jurisdictions backed by current endpoint evidence; absent metadata is never residency-eligible. */
  jurisdictions?: readonly string[];
  /** Residency evidence is configured only after provider/legal review; absent,
   * stale, malformed, or unverified evidence is never residency-eligible. */
  jurisdiction_evidence?: JurisdictionEvidence;
}

export interface JurisdictionEvidence {
  source: 'provider_legal_review' | 'provider_contract';
  status: 'verified';
  verified_at: string;
  expires_at: string;
}

export type ProviderSortPreference = 'price' | 'throughput';

export interface ProviderPreferences {
  order?: Provider[];
  allow?: Provider[];
  deny?: Provider[];
  data_collection?: DataCollectionPreference;
  /** Deterministically ranks eligible endpoints when RouteShift has enough local ranking data. */
  sort?: ProviderSortPreference;
  /** When false, RouteShift must not dispatch configured fallbacks for this request/preset. */
  allow_fallbacks?: boolean;
  /** Required endpoint jurisdictions. This is separate from retention/data-collection policy. */
  data_residency?: string[];
}

export type ProviderPreferenceResult<T extends ProviderEndpoint> =
  | { ok: true; endpoints: T[]; strippedRequestFields: string[]; allow_fallbacks?: boolean }
  | { ok: false; reason: 'no_eligible_provider' | 'no_eligible_provider_residency' | 'unsupported_provider_sort' };

export type ProviderPreferencesParseResult =
  | { ok: true; value: ProviderPreferences | null }
  | { ok: false; reason: 'invalid_provider_prefs' };

const PROVIDER_SET = new Set<string>(PROVIDERS);
const ALLOWED_KEYS = new Set(['order', 'allow', 'deny', 'data_collection', 'allow_fallbacks', 'sort', 'data_residency']);

export const MAX_JURISDICTION_CODES = 16;

export function parseProviderPreferences(value: unknown): ProviderPreferencesParseResult {
  if (value == null) return { ok: true, value: null };
  if (!isRecord(value)) return { ok: false, reason: 'invalid_provider_prefs' };

  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) return { ok: false, reason: 'invalid_provider_prefs' };
  }

  const prefs: ProviderPreferences = {};
  if (value.order !== undefined) {
    const order = parseProviderList(value.order);
    if (!order) return { ok: false, reason: 'invalid_provider_prefs' };
    prefs.order = order;
  }
  if (value.allow !== undefined) {
    const allow = parseProviderList(value.allow);
    if (!allow) return { ok: false, reason: 'invalid_provider_prefs' };
    prefs.allow = allow;
  }
  if (value.deny !== undefined) {
    const deny = parseProviderList(value.deny);
    if (!deny) return { ok: false, reason: 'invalid_provider_prefs' };
    prefs.deny = deny;
  }
  if (value.data_collection !== undefined) {
    if (value.data_collection !== 'allow' && value.data_collection !== 'deny') {
      return { ok: false, reason: 'invalid_provider_prefs' };
    }
    prefs.data_collection = value.data_collection;
  }
  if (value.data_residency !== undefined) {
    const jurisdictions = parseJurisdictions(value.data_residency);
    if (!jurisdictions) return { ok: false, reason: 'invalid_provider_prefs' };
    prefs.data_residency = jurisdictions;
  }
  if (value.sort !== undefined) {
    if (value.sort !== 'price' && value.sort !== 'throughput') {
      return { ok: false, reason: 'invalid_provider_prefs' };
    }
    prefs.sort = value.sort;
  }
  if (value.allow_fallbacks !== undefined) {
    if (typeof value.allow_fallbacks !== 'boolean') return { ok: false, reason: 'invalid_provider_prefs' };
    prefs.allow_fallbacks = value.allow_fallbacks;
  }

  return { ok: true, value: Object.keys(prefs).length > 0 ? prefs : null };
}

export function applyProviderPreferences<T extends ProviderEndpoint>(
  endpoints: readonly T[],
  prefs: ProviderPreferences = {},
): ProviderPreferenceResult<T> {
  let filtered = [...endpoints];

  if (prefs.allow && prefs.allow.length > 0) {
    const allowed = new Set(prefs.allow);
    filtered = filtered.filter((endpoint) => allowed.has(endpoint.provider as Provider));
  }

  if (prefs.deny && prefs.deny.length > 0) {
    const denied = new Set(prefs.deny);
    filtered = filtered.filter((endpoint) => !denied.has(endpoint.provider as Provider));
  }

  if (prefs.data_collection === 'deny') {
    filtered = filtered.filter((endpoint) => endpoint.zdr === true);
  }

  if (prefs.data_residency && prefs.data_residency.length > 0) {
    const requested = new Set(prefs.data_residency);
    filtered = filtered.filter((endpoint) => hasCurrentJurisdictionEvidence(endpoint.jurisdiction_evidence) &&
      endpoint.jurisdictions?.some((jurisdiction) => requested.has(jurisdiction)));
    if (filtered.length === 0) return { ok: false, reason: 'no_eligible_provider_residency' };
  }

  if (filtered.length === 0) return { ok: false, reason: 'no_eligible_provider' };

  const strippedRequestFields = hasProviderTargetingPreferences(prefs) ? ['provider'] : [];

  if (prefs.sort) {
    const sorted = sortEndpoints(filtered, prefs.sort);
    if (!sorted) return { ok: false, reason: 'unsupported_provider_sort' };
    filtered = sorted;
  }

  if (prefs.order && prefs.order.length > 0) {
    const order = new Map(prefs.order.map((provider, index) => [provider, index]));
    filtered = filtered
      .map((endpoint, index) => ({ endpoint, index }))
      .sort((a, b) => {
        const ao = order.get(a.endpoint.provider as Provider) ?? Number.MAX_SAFE_INTEGER;
        const bo = order.get(b.endpoint.provider as Provider) ?? Number.MAX_SAFE_INTEGER;
        return ao - bo || a.index - b.index;
      })
      .map(({ endpoint }) => endpoint);
  }

  return { ok: true, endpoints: filtered, strippedRequestFields, allow_fallbacks: prefs.allow_fallbacks };
}

export function hasCurrentJurisdictionEvidence(
  evidence: JurisdictionEvidence | undefined,
  now: Date = new Date(),
): boolean {
  if (!evidence || evidence.status !== 'verified') return false;
  if (evidence.source !== 'provider_legal_review' && evidence.source !== 'provider_contract') return false;
  if (typeof evidence.verified_at !== 'string' || typeof evidence.expires_at !== 'string') return false;

  const verifiedAt = Date.parse(evidence.verified_at);
  const expiresAt = Date.parse(evidence.expires_at);
  const nowMs = now.getTime();

  return (
    Number.isFinite(verifiedAt)
    && Number.isFinite(expiresAt)
    && Number.isFinite(nowMs)
    && verifiedAt <= nowMs
    && expiresAt > nowMs
    && expiresAt > verifiedAt
  );
}

function sortEndpoints<T extends ProviderEndpoint>(
  endpoints: T[],
  sort: ProviderSortPreference,
): T[] | null {
  if (endpoints.length <= 1) return endpoints;

  const annotated = endpoints.map((endpoint, index) => {
    const score = scoreEndpoint(endpoint, sort);
    return score == null ? null : { endpoint, index, score };
  });
  if (annotated.some((entry) => entry === null)) return null;

  return (annotated as Array<{ endpoint: T; index: number; score: number }>)
    .sort((a, b) => {
      const metric = sort === 'throughput' ? b.score - a.score : a.score - b.score;
      return metric || a.index - b.index;
    })
    .map(({ endpoint }) => endpoint);
}

function scoreEndpoint(endpoint: ProviderEndpoint, sort: ProviderSortPreference): number | null {
  if (sort === 'price') {
    const pricing = getModelPricing(endpoint.provider, endpoint.model);
    return pricing ? pricing.input_per_million + pricing.output_per_million : null;
  }
  if (sort === 'throughput') {
    return typeof endpoint.throughput_hint === 'number' ? endpoint.throughput_hint : null;
  }

  // RouteShift does not persist endpoint-level latency rankings yet. Failing is
  // more truthful than pretending latency sort has been applied.
  return null;
}

function parseProviderList(value: unknown): Provider[] | null {
  if (!Array.isArray(value) || value.length > 32) return null;
  const out: Provider[] = [];
  const seen = new Set<Provider>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !PROVIDER_SET.has(entry)) return null;
    const provider = entry as Provider;
    if (!seen.has(provider)) {
      seen.add(provider);
      out.push(provider);
    }
  }
  return out;
}

function parseJurisdictions(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_JURISDICTION_CODES) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !/^[A-Z]{2}(?:-[A-Z0-9]{1,8})?$/.test(item)) return null;
    if (!seen.has(item)) { seen.add(item); out.push(item); }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasProviderTargetingPreferences(prefs: ProviderPreferences): boolean {
  return Boolean(
    (prefs.order && prefs.order.length > 0) ||
      (prefs.allow && prefs.allow.length > 0) ||
      (prefs.deny && prefs.deny.length > 0) ||
      prefs.data_collection === 'deny' ||
      (prefs.data_residency && prefs.data_residency.length > 0) ||
      prefs.sort !== undefined,
  );
}
