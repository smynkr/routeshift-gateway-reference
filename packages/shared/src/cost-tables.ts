import type { TokenUsage } from './token-usage';
import { LITELLM_GENERATED_PRICING } from './litellm-pricing.generated';

export interface ModelPricing {
  provider: string;
  model: string;
  input_per_million: number;
  output_per_million: number;
  cache_read_per_million?: number;
  cache_write_per_million?: number;
  /** GPT-5.6-style rates used when total prompt tokens exceed 272K. */
  input_per_million_above_272k?: number;
  output_per_million_above_272k?: number;
  cache_read_per_million_above_272k?: number;
  cache_write_per_million_above_272k?: number;
}

/**
 * Providers whose curated pricing rows are DELIBERATELY zero-rated because
 * the provider bills by subscription, not per token (xiaomi Token Plan:
 * per-request cost is reported as 0 by design; subscription cost lives
 * outside the table). Zero rates anywhere else are not pricing — billing
 * $0/request while looking accounted-for. Single source consumed by
 * promote-model.ts and the dispatch pricing gate (glm + kimi, review round 4).
 */
export const SUBSCRIPTION_PRICED_PROVIDERS = ['xiaomi'] as const;

export const PRICING_TABLE: ReadonlyArray<ModelPricing> = [
  { provider: 'openai', model: 'gpt-5', input_per_million: 1.25, output_per_million: 10.0 },
  // Azure deployment-scoped GPT 5.x models. Keep per-platform list pricing
  // distinct from OpenAI-direct pricing. Global-zone rows use `azure:<model>`;
  // Data Zone variants can be added as explicit model keys if/when RouteShift
  // needs zone-aware selection. They are excluded from MODEL_REGISTRY because
  // deployments are selected via provider strategy / aliases, not auto-routing.
  { provider: 'azure', model: 'gpt-5.4', input_per_million: 2.5, output_per_million: 15.0, cache_read_per_million: 0.25 },
  { provider: 'azure', model: 'gpt-5.4-mini', input_per_million: 0.75, output_per_million: 4.5 },
  { provider: 'azure', model: 'gpt-5.4-nano', input_per_million: 0.2, output_per_million: 1.25 },
  { provider: 'azure', model: 'gpt-5.5', input_per_million: 5.0, output_per_million: 30.0, cache_read_per_million: 0.5 },
  { provider: 'azure', model: 'gpt-5.5-pro', input_per_million: 10.0, output_per_million: 45.0, cache_read_per_million: 1.0 },
  { provider: 'azure', model: 'gpt-oss-120b', input_per_million: 0.15, output_per_million: 0.6 },
  { provider: 'openai', model: 'gpt-4.1', input_per_million: 2.0, output_per_million: 8.0 },
  { provider: 'openai', model: 'gpt-4.1-mini', input_per_million: 0.4, output_per_million: 1.6 },
  { provider: 'openai', model: 'gpt-4.1-nano', input_per_million: 0.1, output_per_million: 0.4 },
  { provider: 'openai', model: 'o3', input_per_million: 2.0, output_per_million: 8.0 },
  { provider: 'openai', model: 'o4-mini', input_per_million: 1.1, output_per_million: 4.4 },
  { provider: 'anthropic', model: 'claude-opus-4-5', input_per_million: 5.0, output_per_million: 25.0 },
  { provider: 'anthropic', model: 'claude-sonnet-4-5', input_per_million: 3.0, output_per_million: 15.0 },
  { provider: 'anthropic', model: 'claude-opus-4-6', input_per_million: 5.0, output_per_million: 25.0 },
  { provider: 'anthropic', model: 'claude-sonnet-4-6', input_per_million: 3.0, output_per_million: 15.0 },
  { provider: 'anthropic', model: 'claude-haiku-4-5', input_per_million: 1.0, output_per_million: 5.0 },
  { provider: 'google', model: 'gemini-2.5-pro', input_per_million: 1.25, output_per_million: 10.0 },
  { provider: 'google', model: 'gemini-2.5-flash', input_per_million: 0.15, output_per_million: 0.6 },
  // ── Current frontier (RTSH model refresh). Cache-read rates intentionally
  //    omitted: the default 0.1x-input fallback already matches each vendor's
  //    published cache-hit price (Opus 5*0.1=0.50, Sonnet 0.30, gemini-pro 0.20). ──
  // Embedding models — output_per_million: 0 (embeddings have no output tokens)
  { provider: 'openai', model: 'text-embedding-3-small', input_per_million: 0.02, output_per_million: 0 },
  { provider: 'openai', model: 'text-embedding-3-large', input_per_million: 0.13, output_per_million: 0 },
  // text-embedding-004: RouteShift routes Google embeddings, so cost accounting
  // uses Google's paid-tier rate (~$0.025/M input tokens).
  { provider: 'google', model: 'text-embedding-004', input_per_million: 0.025, output_per_million: 0 },
  { provider: 'openai', model: 'gpt-5.5', input_per_million: 5.0, output_per_million: 30.0 },
  { provider: 'openai', model: 'gpt-5.5-pro', input_per_million: 30.0, output_per_million: 180.0 },
  { provider: 'openai', model: 'gpt-5.4', input_per_million: 2.5, output_per_million: 15.0 },
  { provider: 'openai', model: 'gpt-5.4-mini', input_per_million: 0.75, output_per_million: 4.5 },
  { provider: 'openai', model: 'gpt-5.4-nano', input_per_million: 0.2, output_per_million: 1.25 },
  // OpenAI GPT-5.6 family — standard short-context rates, including the
  // documented 1.25x cache-write charge (verified 2026-08-26).
  { provider: 'openai', model: 'gpt-5.6', input_per_million: 4.0, output_per_million: 20.0, cache_read_per_million: 0.4, cache_write_per_million: 5.0, input_per_million_above_272k: 8.0, output_per_million_above_272k: 30.0, cache_read_per_million_above_272k: 0.8, cache_write_per_million_above_272k: 10.0 },
  { provider: 'openai', model: 'gpt-5.6-sol', input_per_million: 4.0, output_per_million: 20.0, cache_read_per_million: 0.4, cache_write_per_million: 5.0, input_per_million_above_272k: 8.0, output_per_million_above_272k: 30.0, cache_read_per_million_above_272k: 0.8, cache_write_per_million_above_272k: 10.0 },
  { provider: 'openai', model: 'gpt-5.6-terra', input_per_million: 2.0, output_per_million: 12.0, cache_read_per_million: 0.2, cache_write_per_million: 2.5, input_per_million_above_272k: 4.0, output_per_million_above_272k: 18.0, cache_read_per_million_above_272k: 0.4, cache_write_per_million_above_272k: 5.0 },
  { provider: 'openai', model: 'gpt-5.6-luna', input_per_million: 0.2, output_per_million: 1.2, cache_read_per_million: 0.02, cache_write_per_million: 0.25, input_per_million_above_272k: 0.4, output_per_million_above_272k: 1.8, cache_read_per_million_above_272k: 0.04, cache_write_per_million_above_272k: 0.5 },
  // GPT-5.6 Cyber is retained only as a hidden approval-gated compatibility
  // row; it is never exposed or dispatched by RouteShift.
  { provider: 'openai', model: 'gpt-5.6-cyber', input_per_million: 12.5, output_per_million: 75.0, cache_read_per_million: 1.25, cache_write_per_million: 15.625 },
  { provider: 'anthropic', model: 'claude-opus-4-8', input_per_million: 5.0, output_per_million: 25.0 },
  { provider: 'anthropic', model: 'claude-opus-4-7', input_per_million: 5.0, output_per_million: 25.0 },
  // Claude Fable 5 (GA 2026-06-09, Anthropic's most capable widely released model).
  // $10 / $50 per MTok is 2x Opus 4.x. Same pricing as Claude Mythos 5
  // (limited-release Project Glasswing sibling without safety classifiers).
  { provider: 'anthropic', model: 'claude-fable-5', input_per_million: 10.0, output_per_million: 50.0 },
  // Claude Sonnet 5 follows RouteShift's established Sonnet = 0.6x Opus pattern.
  { provider: 'anthropic', model: 'claude-sonnet-5', input_per_million: 3.0, output_per_million: 15.0 },
  { provider: 'google', model: 'gemini-3.1-pro', input_per_million: 2.0, output_per_million: 12.0 },
  { provider: 'google', model: 'gemini-3.5-flash', input_per_million: 1.5, output_per_million: 9.0 },
  { provider: 'google', model: 'gemini-3-flash', input_per_million: 0.5, output_per_million: 3.0 },
  { provider: 'google', model: 'gemini-3.1-flash-lite', input_per_million: 0.25, output_per_million: 1.5 },
  // Google Gemini 3.7 Flash — paid-tier standard price through 2026-12-31;
  // the API documents cache hits at 10% and no token-priced write class.
  { provider: 'google', model: 'gemini-3.7-flash', input_per_million: 0.75, output_per_million: 3.75, cache_read_per_million: 0.075, cache_write_per_million: 0 },
  // Stable Google Flash-Lite rows retained with official paid-tier prices and
  // 10% cache-read rates (verified 2026-08-26).
  { provider: 'google', model: 'gemini-2.5-flash-lite', input_per_million: 0.1, output_per_million: 0.4, cache_read_per_million: 0.01, cache_write_per_million: 0 },
  { provider: 'google', model: 'gemini-3.5-flash-lite', input_per_million: 0.3, output_per_million: 2.5, cache_read_per_million: 0.03, cache_write_per_million: 0 },
  // Z.ai (Zhipu GLM) — public USD pricing (verify quarterly; revisit if Zhipu adjusts).
  { provider: 'zai', model: 'glm-4.5', input_per_million: 0.3, output_per_million: 1.4 },
  { provider: 'zai', model: 'glm-4.5-air', input_per_million: 0.05, output_per_million: 0.2 },
  { provider: 'zai', model: 'glm-4.6', input_per_million: 0.6, output_per_million: 2.2 },
  { provider: 'zai', model: 'glm-4.7', input_per_million: 0.6, output_per_million: 2.2 },
  { provider: 'zai', model: 'glm-4.5-flash', input_per_million: 0, output_per_million: 0 },
  { provider: 'zai', model: 'glm-4.7-flash', input_per_million: 0, output_per_million: 0 },
  // cache_write_per_million: 0 — these providers (z.ai, MiniMax, Moonshot,
  // DeepSeek, Qwen, xAI) use a cache-hit/cache-miss model and do NOT bill a
  // separate cache-write; an explicit 0 stops the Anthropic-style 1.25x-input
  // fallback (see CACHE_WRITE_INPUT_MULTIPLIER) from overcharging them.
  { provider: 'zai', model: 'glm-5', input_per_million: 1.0, output_per_million: 3.2, cache_read_per_million: 0.1, cache_write_per_million: 0 },
  { provider: 'zai', model: 'glm-5-turbo', input_per_million: 0.2, output_per_million: 0.8 },
  { provider: 'zai', model: 'glm-5.1', input_per_million: 1.0, output_per_million: 3.5 },
  // Cloudflare Workers AI GLM-5.3-Flash — official model page pricing:
  // $0.15/M input, $0.50/M output, $0.03/M cached input; no write charge.
  { provider: 'cloudflare-workers-ai', model: '@cf/zai-org/glm-5.3-flash', input_per_million: 0.15, output_per_million: 0.5, cache_read_per_million: 0.03, cache_write_per_million: 0 },
  // NeuralWatt GLM-5.2 compatibility pricing, retained for legacy IDs. Values
  // mirror the provider's public /v1/models catalog (verified 2026-08-29).
  { provider: 'neuralwatt', model: 'glm-5.2', input_per_million: 1.45, output_per_million: 4.5, cache_read_per_million: 0.145, cache_write_per_million: 0 },
  { provider: 'neuralwatt', model: 'glm-5.2-fast', input_per_million: 1.45, output_per_million: 4.5, cache_read_per_million: 0.145, cache_write_per_million: 0 },
  { provider: 'neuralwatt', model: 'glm-5.2-short', input_per_million: 1.45, output_per_million: 4.5, cache_read_per_million: 0.145, cache_write_per_million: 0 },
  { provider: 'neuralwatt', model: 'glm-5.2-short-fast', input_per_million: 1.45, output_per_million: 4.5, cache_read_per_million: 0.145, cache_write_per_million: 0 },
  { provider: 'neuralwatt', model: 'glm-5.2-short-fast-flex', input_per_million: 1.45, output_per_million: 4.5, cache_read_per_million: 0.145, cache_write_per_million: 0 },
  // Xiaomi remains subscription-based (Token Plan), not per-token. Set to 0 so
  // per-request cost is reported as 0; subscription cost lives outside this table.
  // input/output are 0 (subscription, not per-token) so the cache-write fallback
  // already resolves to 0; the explicit cache_write_per_million: 0 documents that
  // Xiaomi has no per-token cache-write charge either, consistent with the other
  // cache-hit/miss providers above.
  { provider: 'xiaomi', model: 'mimo-v2.5-pro', input_per_million: 0, output_per_million: 0, cache_write_per_million: 0 },
  { provider: 'xiaomi', model: 'mimo-v2-flash', input_per_million: 0, output_per_million: 0, cache_write_per_million: 0 },
  { provider: 'minimax', model: 'MiniMax-M2', input_per_million: 0.3, output_per_million: 1.2, cache_read_per_million: 0.03, cache_write_per_million: 0 },
  // Moonshot (Kimi) K2 rows — refreshed 2026-06-29 from platform.kimi.ai/docs/pricing
  // Kimi K3 — official cache-hit/miss and output prices (verified 2026-08-26);
  // no separate token-priced cache-write class is published.
  { provider: 'moonshot', model: 'kimi-k3', input_per_million: 3.0, output_per_million: 15.0, cache_read_per_million: 0.3, cache_write_per_million: 0 },
  // (per 1M tokens, USD; cache_read = cache-hit price; no separate cache-write charge).
  { provider: 'moonshot', model: 'kimi-k2.6', input_per_million: 0.95, output_per_million: 4.0, cache_read_per_million: 0.16, cache_write_per_million: 0 },
  { provider: 'moonshot', model: 'kimi-k2.7-code', input_per_million: 0.95, output_per_million: 4.0, cache_read_per_million: 0.19, cache_write_per_million: 0 },
  // Alibaba DashScope (Qwen) — international USD pricing; verify quarterly.
  { provider: 'qwen', model: 'qwen3.7-max', input_per_million: 1.6, output_per_million: 6.4 },
  { provider: 'qwen', model: 'qwen3.7-plus', input_per_million: 0.8, output_per_million: 2.0 },
  { provider: 'qwen', model: 'qwen3.6-flash', input_per_million: 0.2, output_per_million: 0.6 },
  { provider: 'qwen', model: 'Qwen3-Next-80B-Thinking', input_per_million: 0.15, output_per_million: 1.2 },
  { provider: 'qwen', model: 'Qwen3-Next-80B-Instruct', input_per_million: 0.15, output_per_million: 1.2 },
  { provider: 'qwen', model: 'Qwen3-Coder-480B-A35B-Instruct', input_per_million: 0.22, output_per_million: 1.8, cache_read_per_million: 0.022, cache_write_per_million: 0 },
  { provider: 'qwen', model: 'Qwen3-235B-A22B-Instruct-2507', input_per_million: 0.22, output_per_million: 0.88 },
  // Qwen3.8-Max — international standard rates from Alibaba's pricing page;
  // context-cache hits are 10% of input and explicit cache creation is 125%.
  { provider: 'qwen', model: 'qwen3.8-max', input_per_million: 2.0, output_per_million: 6.0, cache_read_per_million: 0.2, cache_write_per_million: 2.5 },
  { provider: 'openai', model: 'gpt-oss-120b', input_per_million: 0.09, output_per_million: 0.36 },
  { provider: 'openai', model: 'gpt-oss-20b', input_per_million: 0.07, output_per_million: 0.25, cache_read_per_million: 0.007 },
  { provider: 'xai', model: 'grok-4.20-reasoning', input_per_million: 1.25, output_per_million: 2.5, cache_read_per_million: 0.2, cache_write_per_million: 0 },
  { provider: 'xai', model: 'grok-4.1-fast', input_per_million: 0.2, output_per_million: 0.5, cache_read_per_million: 0.05, cache_write_per_million: 0 },
  // Legacy hyphenated Grok 4.1 IDs remain priced for historical logs only;
  // they are public:false and have no current xAI provenance (verified absent
  // from the 2026-08-26 official model page).
  { provider: 'xai', model: 'grok-4-1-fast', input_per_million: 0.2, output_per_million: 0.5, cache_read_per_million: 0.05, cache_write_per_million: 0 },
  { provider: 'xai', model: 'grok-4-1-fast-non-reasoning', input_per_million: 0.2, output_per_million: 0.5, cache_read_per_million: 0.05, cache_write_per_million: 0 },
  { provider: 'xai', model: 'grok-4-1-fast-non-reasoning-latest', input_per_million: 0.2, output_per_million: 0.5, cache_read_per_million: 0.05, cache_write_per_million: 0 },
  { provider: 'xai', model: 'grok-4-1-fast-reasoning', input_per_million: 0.2, output_per_million: 0.5, cache_read_per_million: 0.05, cache_write_per_million: 0 },
  { provider: 'xai', model: 'grok-4-1-fast-reasoning-latest', input_per_million: 0.2, output_per_million: 0.5, cache_read_per_million: 0.05, cache_write_per_million: 0 },
  { provider: 'deepseek', model: 'deepseek-v3.1', input_per_million: 0.6, output_per_million: 1.7, cache_read_per_million: 0.06, cache_write_per_million: 0 },
  { provider: 'deepseek', model: 'deepseek-v3.2', input_per_million: 0.56, output_per_million: 1.68, cache_read_per_million: 0.056, cache_write_per_million: 0 },
  { provider: 'deepseek', model: 'deepseek-r1-0528', input_per_million: 1.35, output_per_million: 5.4 },
  { provider: 'mistral', model: 'mistral-medium-3', input_per_million: 0.4, output_per_million: 2.0 },
  { provider: 'mistral', model: 'mistral-small-3.1', input_per_million: 0.1, output_per_million: 0.3 },
  { provider: 'mistral', model: 'codestral-2', input_per_million: 0.3, output_per_million: 0.9 },
  { provider: 'meta', model: 'llama-3.3-70b', input_per_million: 0.72, output_per_million: 0.72 },
  { provider: 'meta', model: 'llama-3.1-70b', input_per_million: 0.72, output_per_million: 0.72 },
  { provider: 'meta', model: 'llama-4-scout', input_per_million: 0.25, output_per_million: 0.7 },
  { provider: 'meta', model: 'llama-4-maverick', input_per_million: 0.35, output_per_million: 1.15 },
  // RSH-166 drift candidates without generated-table coverage: the three meta
  // variants are the same base models as the canonical entries above (full
  // vendor instruct names); the zai flash models are free on the Z.ai
  // platform per the LiteLLM catalog (0/0 rows).
  { provider: 'meta', model: 'Llama-3.3-70B-Instruct', input_per_million: 0.72, output_per_million: 0.72 },
  { provider: 'meta', model: 'Llama-4-Maverick-17B-128E-Instruct-FP8', input_per_million: 0.35, output_per_million: 1.15 },
  { provider: 'meta', model: 'Llama-4-Scout-17B-16E-Instruct-FP8', input_per_million: 0.25, output_per_million: 0.7 },
  // RSH-168 data-hygiene overrides (LiteLLM upstream anomalies; verified
  // 2026-08-10 against the AWS Bedrock price list, aws.amazon.com/bedrock/
  // pricing/ — re-verify at the next weekly sync review): hand-curated rows
  // win over the generated table by Map last-write-wins.
  // (a) Bedrock bare moonshotai.kimi-k2.5 output 3.03 matches NO AWS region;
  //     AWS lists Kimi K2.5 at $0.60 in / $3.00 out (US regions) with APAC
  //     premium $0.72 / $3.60 — the bare row is the US rate.
  { provider: 'bedrock', model: 'moonshotai.kimi-k2.5', input_per_million: 0.6, output_per_million: 3 },
  // (b) us-gov meta.llama3-8b output 2.65 is the 70B INPUT rate misfiled into
  //     the 8B output field (the adjacent us-gov 70B rows are 2.65/3.50); AWS
  //     lists Llama-3-8B at $0.30 in / $0.60 out across commercial regions.
  { provider: 'bedrock', model: 'us-gov-east-1/meta.llama3-8b-instruct-v1:0', input_per_million: 0.3, output_per_million: 0.6 },
  { provider: 'bedrock', model: 'us-gov-west-1/meta.llama3-8b-instruct-v1:0', input_per_million: 0.3, output_per_million: 0.6 },
  // AWS regional rows retained for explicit historical routing (verified
  // against the Bedrock pricing page on 2026-08-26).
  { provider: 'bedrock', model: 'ap-northeast-1/moonshotai.kimi-k2.5', input_per_million: 0.72, output_per_million: 3.6 },
  { provider: 'bedrock', model: 'us-gov-east-1/meta.llama3-70b-instruct-v1:0', input_per_million: 2.65, output_per_million: 3.5 },
  { provider: 'bedrock', model: 'us-gov-west-1/meta.llama3-70b-instruct-v1:0', input_per_million: 2.65, output_per_million: 3.5 },
];


const pricingMap = new Map<string, ModelPricing>();
for (const entry of PRICING_TABLE) {
  pricingMap.set(`${entry.provider}:${entry.model}`, entry);
}

const generatedPricingMap = new Map<string, ModelPricing>();
for (const entry of LITELLM_GENERATED_PRICING) {
  generatedPricingMap.set(`${entry.provider}:${entry.model}`, entry);
}

// Some generated upstream pricing snapshots can contain speculative or stale
// model IDs. Keep explicit removals here so deleted/nonexistent models do not
// remain priceable just because an older generated table still mentions them.
const REMOVED_MODEL_PATTERNS = [
  // claude-opus-4-7 is now GA and hand-priced below — no longer removed.
  /(^|\.)claude-sonnet-4-7($|-)/,
];

function isRemovedModel(provider: string, model: string): boolean {
  if (provider !== 'anthropic' && provider !== 'bedrock') return false;
  return REMOVED_MODEL_PATTERNS.some((pattern) => pattern.test(model));
}

// Hand-curated wins. Falling through to the generated table is what keeps
// us correct on models LiteLLM tracks but we haven't manually priced — the
// override path stays manual on purpose so a fresh frontier model whose
// price LiteLLM hasn't picked up yet doesn't silently get the wrong number.
const OPTIONAL_GENERATED_PRICING_FIELDS = [
  'cache_read_per_million',
  'cache_write_per_million',
  'input_per_million_above_272k',
  'output_per_million_above_272k',
  'cache_read_per_million_above_272k',
  'cache_write_per_million_above_272k',
] as const satisfies readonly (keyof ModelPricing)[];

function mergeCuratedPricing(base: ModelPricing, generated: ModelPricing): ModelPricing {
  const merged = { ...base };
  for (const field of OPTIONAL_GENERATED_PRICING_FIELDS) {
    if (merged[field] === undefined && generated[field] !== undefined) {
      merged[field] = generated[field];
    }
  }
  return merged;
}

export function getModelPricing(provider: string, model: string): ModelPricing | null {
  const key = `${provider}:${model}`;
  if (isRemovedModel(provider, model)) return null;
  const curated = pricingMap.get(key);
  const generated = generatedPricingMap.get(key);
  if (curated && generated) return mergeCuratedPricing(curated, generated);
  return curated ?? generated ?? null;
}

// Standard cache-token multipliers (relative to the input rate) used when a
// model's pricing entry doesn't declare explicit cache rates. These match
// Anthropic's published ratios. NOTE: many non-Anthropic providers (MiniMax,
// Moonshot, DeepSeek, z.ai, Qwen, xAI) use a cache-hit/cache-miss model with NO
// separate cache-write charge — those rows set cache_write_per_million: 0
// explicitly so this 1.25x fallback does not overcharge them.
const CACHE_READ_INPUT_MULTIPLIER = 0.1;
const CACHE_WRITE_INPUT_MULTIPLIER = 1.25;
// Extended 1-hour TTL tier: Anthropic charges ~2.0× input price for cache
// writes with `cache_control: { type: "ephemeral", ttl: "1h" }`. Using the
// default 1.25× for 1h writes would undercount actual_cost_microcents by ~38%.
const CACHE_WRITE_INPUT_MULTIPLIER_1H = 2.0;

/** Prompt-token boundary at which providers' long-context rates apply. */
export const LONG_CONTEXT_THRESHOLD_TOKENS = 272_000;

export interface SelectedPricingRates {
  input_per_million: number;
  output_per_million: number;
  cache_read_per_million: number;
  cache_write_per_million: number;
  long_context: boolean;
}

/**
 * Select one coherent pricing tier for a prompt. Every estimator and the
 * settlement calculator must use this helper so long-context fallback rules
 * cannot drift between admission and billing.
 */
export function selectModelPricing(pricing: ModelPricing, promptTokens: number): SelectedPricingRates {
  const hasLongContextRates = [
    pricing.input_per_million_above_272k,
    pricing.output_per_million_above_272k,
    pricing.cache_read_per_million_above_272k,
    pricing.cache_write_per_million_above_272k,
  ].some((rate) => rate !== undefined);
  const long_context = Number.isFinite(promptTokens)
    && promptTokens > LONG_CONTEXT_THRESHOLD_TOKENS
    && hasLongContextRates;
  const input_per_million = long_context
    ? pricing.input_per_million_above_272k ?? pricing.input_per_million
    : pricing.input_per_million;
  const output_per_million = long_context
    ? pricing.output_per_million_above_272k ?? pricing.output_per_million
    : pricing.output_per_million;
  const cache_read_per_million = long_context
    ? pricing.cache_read_per_million_above_272k
      ?? pricing.cache_read_per_million
      ?? input_per_million * CACHE_READ_INPUT_MULTIPLIER
    : pricing.cache_read_per_million ?? input_per_million * CACHE_READ_INPUT_MULTIPLIER;
  const cache_write_per_million = long_context
    ? pricing.cache_write_per_million_above_272k
      ?? pricing.cache_write_per_million
      ?? input_per_million * CACHE_WRITE_INPUT_MULTIPLIER
    : pricing.cache_write_per_million ?? input_per_million * CACHE_WRITE_INPUT_MULTIPLIER;
  return {
    input_per_million,
    output_per_million,
    cache_read_per_million,
    cache_write_per_million,
    long_context,
  };
}

export function calculateCostMicrocents(
  usage: Pick<TokenUsage, 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_write_tokens' | 'cache_write_ttl'>,
  pricing: ModelPricing,
): { input: number; output: number; cache_read: number; cache_write: number; total: number } {
  const cacheReadTokens = usage.cache_read_tokens ?? 0;
  const cacheWriteTokens = usage.cache_write_tokens ?? 0;
  const promptTokens = usage.input_tokens + cacheReadTokens + cacheWriteTokens;
  const rates = selectModelPricing(pricing, promptTokens);
  // Extended 1-hour TTL tier costs ~2.0x input vs the default 1.25x. Scale the
  // selected tier rate so explicit long-context rates behave like fallback rates.
  const cacheWriteRate =
    usage.cache_write_ttl === '1h'
      ? rates.cache_write_per_million * (CACHE_WRITE_INPUT_MULTIPLIER_1H / CACHE_WRITE_INPUT_MULTIPLIER)
      : rates.cache_write_per_million;
  const input = Math.round(usage.input_tokens * rates.input_per_million * 100);
  const output = Math.round(usage.output_tokens * rates.output_per_million * 100);
  const cache_read = Math.round(cacheReadTokens * rates.cache_read_per_million * 100);
  const cache_write = Math.round(cacheWriteTokens * cacheWriteRate * 100);
  return { input, output, cache_read, cache_write, total: input + output + cache_read + cache_write };
}
