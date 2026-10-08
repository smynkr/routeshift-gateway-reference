import type { Provider } from './models';
import type { JurisdictionEvidence } from './provider-preferences';

export interface ModelProviderEndpoint {
  provider: Provider;
  model: string;
  /** Zero-data-retention / no-training eligible endpoint. */
  zdr: boolean;
  /** Coarse maintained throughput rank; higher is faster. Used only for deterministic provider.sort='throughput'. */
  throughput_hint?: number;
  /** Jurisdictions backed by current provider/legal evidence. */
  jurisdictions?: readonly string[];
  /** Evidence must pass hasCurrentJurisdictionEvidence before routing eligibility. */
  jurisdiction_evidence?: JurisdictionEvidence;
}

export interface ProviderDataPolicy {
  /** True when RouteShift can treat this provider as ZDR/no-training for data_collection=deny. */
  zdr: boolean;
}

export const PROVIDER_DATA_POLICY: Record<Provider, ProviderDataPolicy> = {
  openai: { zdr: false },
  anthropic: { zdr: false },
  google: { zdr: false },
  together: { zdr: false },
  groq: { zdr: false },
  zai: { zdr: false },
  'cloudflare-workers-ai': { zdr: false },
  neuralwatt: { zdr: false },
  xiaomi: { zdr: false },
  minimax: { zdr: false },
  moonshot: { zdr: false },
  qwen: { zdr: false },
  azure: { zdr: true },
  bedrock: { zdr: true },
  xai: { zdr: false },
  deepseek: { zdr: false },
  mistral: { zdr: false },
  meta: { zdr: false },
};

// RSH-164 evidence standard: a jurisdiction may be claimed only when the
// provider's contract/legal terms guarantee processing STAYS in that region.
// A "default" processing location is not a guarantee (traffic may be
// load-balanced or failed over elsewhere) — claiming it would turn the
// fail-closed data_residency filter into a fail-open compliance risk.
//
// 2026-08-10 review of 13 providers' public terms found NO claim that meets
// the bar. The strongest candidate (DeepSeek's "we directly collect, process
// and store your Personal Data in People's Republic of China") fails on the
// same policy's hedges: storage "may be" outside the user's country, explicit
// cross-border transfers "where required", user input shared with third-party
// APIs (Bing), and the API surface explicitly excluded from that policy's
// coverage. Full per-provider audit (verbatim quotes, URLs, verdicts):
// docs/compliance/RSH-164-jurisdiction-review.md. The catalog therefore
// declares zero evidence and every residency preference stays 422
// fail-closed; the lifecycle machinery (jurisdiction-evidence.ts) + registry
// staleness gate ship ready for the first defensible claim.

export const MODEL_ENDPOINTS: Record<string, ModelProviderEndpoint[]> = {
  'gpt-5.5': [
    { provider: 'openai', model: 'gpt-5.5', zdr: PROVIDER_DATA_POLICY.openai.zdr, throughput_hint: 0.8 },
    { provider: 'azure', model: 'gpt-5.5', zdr: PROVIDER_DATA_POLICY.azure.zdr, throughput_hint: 0.8 },
  ],
  'gpt-5.5-pro': [
    { provider: 'openai', model: 'gpt-5.5-pro', zdr: PROVIDER_DATA_POLICY.openai.zdr, throughput_hint: 0.8 },
    { provider: 'azure', model: 'gpt-5.5-pro', zdr: PROVIDER_DATA_POLICY.azure.zdr, throughput_hint: 0.8 },
  ],
  'gpt-5.4': [
    { provider: 'openai', model: 'gpt-5.4', zdr: PROVIDER_DATA_POLICY.openai.zdr, throughput_hint: 0.8 },
    { provider: 'azure', model: 'gpt-5.4', zdr: PROVIDER_DATA_POLICY.azure.zdr, throughput_hint: 0.8 },
  ],
  'gpt-5.4-mini': [
    { provider: 'openai', model: 'gpt-5.4-mini', zdr: PROVIDER_DATA_POLICY.openai.zdr, throughput_hint: 0.8 },
    { provider: 'azure', model: 'gpt-5.4-mini', zdr: PROVIDER_DATA_POLICY.azure.zdr, throughput_hint: 0.8 },
  ],
  'gpt-5.4-nano': [
    { provider: 'openai', model: 'gpt-5.4-nano', zdr: PROVIDER_DATA_POLICY.openai.zdr, throughput_hint: 0.8 },
    { provider: 'azure', model: 'gpt-5.4-nano', zdr: PROVIDER_DATA_POLICY.azure.zdr, throughput_hint: 0.8 },
  ],
  'gpt-oss-120b': [
    { provider: 'openai', model: 'gpt-oss-120b', zdr: PROVIDER_DATA_POLICY.openai.zdr, throughput_hint: 0.8 },
    { provider: 'azure', model: 'gpt-oss-120b', zdr: PROVIDER_DATA_POLICY.azure.zdr, throughput_hint: 0.8 },
  ],
};

export function getModelEndpoints(model: string): ModelProviderEndpoint[] {
  return [...(MODEL_ENDPOINTS[model] ?? [])];
}
