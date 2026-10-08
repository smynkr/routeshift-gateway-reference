// Authoritative model-source index.
//
// The official provider pages we treat as the source of truth for model
// identifiers, context windows, and per-token pricing. MODEL_REGISTRY (models.ts)
// and COST_TABLE (cost-tables.ts) are RECONCILED from these — they are not
// independent sources. Periodically re-check each provider's pages, update the
// registry/cost-table to match, and bump `last_verified`.
//
// Why this file exists: model line-ups and prices drift (e.g. kimi-k2-thinking
// was deprecated and replaced by kimi-k2.6 / kimi-k2.7-code). Without a tracked
// list of authoritative pages, the registry silently goes stale and the key-test
// + benchmark lookups reference models that no longer exist. Keep the URLs here
// and refresh from them rather than guessing or hard-coding from memory.
//
// Rule: only add a provider entry once its URLs have been opened and the
// registry/cost-table reconciled against them. Do NOT add unverified URLs —
// an authoritative index that contains guesses is worse than an incomplete one.

export interface ModelSource {
  /** Provider id as used in MODEL_REGISTRY / COST_TABLE. */
  provider: string;
  /** Official model list / specifications (ids, context windows). */
  models_url: string;
  /** Official pricing page(s): per-1M-token input / cache-hit / output. */
  pricing_urls: string[];
  /** Machine-readable docs index, when the provider publishes one (handy for refresh tooling). */
  llms_txt?: string;
  /** ISO date the registry + cost-table entries for this provider were last reconciled against these pages. */
  last_verified: string;
  notes?: string;
}

export const MODEL_SOURCES: ModelSource[] = [
  {
    provider: 'openai',
    models_url: 'https://developers.openai.com/api/docs/models',
    pricing_urls: [
      'https://developers.openai.com/api/docs/pricing',
      'https://developers.openai.com/api/docs/models/gpt-5.6-sol',
      'https://developers.openai.com/api/docs/models/gpt-5.6-terra',
      'https://developers.openai.com/api/docs/models/gpt-5.6-luna',
      'https://developers.openai.com/api/docs/models/gpt-5.6-cyber',
    ],
    last_verified: '2026-08-26',
    notes:
      'GPT-5.6 Sol, Terra, and Luna are official IDs with 1,050,000-token ' +
      'contexts. Direct standard prices are $4/$20, $2/$12, and $0.20/$1.20 ' +
      'per million input/output tokens; cache reads are $0.40/$0.20/$0.02 and ' +
      'cache writes are 1.25x input. The unsuffixed gpt-5.6 alias maps to Sol. ' +
      'GPT-5.6 Cyber is official (400,000 context, $12.50/$75) but requires ' +
      'Daybreak approval and supports Responses API rather than the current ' +
      'OpenAI Chat Completions adapter, so it is not curated.',
  },
  {
    provider: 'google',
    models_url: 'https://ai.google.dev/gemini-api/docs/models',
    pricing_urls: [
      'https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash',
      'https://ai.google.dev/gemini-api/docs/pricing',
    ],
    last_verified: '2026-08-26',
    notes:
      'gemini-3.7-flash is a stable official ID with 1,048,576 input tokens ' +
      'and 65,536 output tokens. Paid standard pricing through 2026-12-31 is ' +
      '$0.75/M input, $3.75/M output, and $0.075/M cached input; the existing ' +
      'Gemini adapter accepts the model explicitly. No separate token-priced ' +
      'cache-write class is published.',
  },
  {
    provider: 'moonshot',
    models_url: 'https://platform.kimi.ai/docs/models',
    pricing_urls: [
      'https://platform.kimi.ai/docs/pricing/chat',
      'https://platform.kimi.ai/docs/pricing/chat-k3',
    ],
    last_verified: '2026-08-26',
    notes:
      'kimi-k3 is the official Moonshot flagship with a 1,048,576-token context. ' +
      'The official price is $3.00/M cache-miss input, $0.30/M cache-hit input, ' +
      'and $15.00/M output. The existing Anthropic-compatible adapter accepts ' +
      'the model explicitly; no separate token-priced cache-write class is published.',
  },
  {
    provider: 'qwen',
    models_url: 'https://www.alibabacloud.com/help/en/model-studio/models',
    pricing_urls: [
      'https://www.alibabacloud.com/help/en/model-studio/model-pricing',
    ],
    last_verified: '2026-08-26',
    notes:
      'qwen3.8-max is the official international DashScope ID with a 1,000,000-token ' +
      'context and $2.00/M input, $6.00/M output standard pricing. Alibaba documents ' +
      'context-cache hits at 10% of input and explicit cache creation at 125% of input. ' +
      'The existing Qwen OpenAI-compatible adapter forwards the exact model ID.',
  },
  {
    provider: 'cloudflare-workers-ai',
    models_url: 'https://developers.cloudflare.com/workers-ai/models/glm-5.3-flash/',
    pricing_urls: [
      'https://developers.cloudflare.com/workers-ai/models/glm-5.3-flash/',
      'https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/',
    ],
    last_verified: '2026-08-29',
    notes:
      'Cloudflare hosts @cf/zai-org/glm-5.3-flash with a 1,048,576-token ' +
      'context, function calling, reasoning, and vision. The model page reports ' +
      'performance above GLM-5.2 and approaching Claude Opus 4.8; that frontier ' +
      'position is the basis for intelligence_tier 3. Official pricing is ' +
      '$0.15/M input, $0.50/M output, and $0.03/M cached input.',
  },
  {
    provider: 'neuralwatt',
    models_url: 'https://api.neuralwatt.com/v1/models',
    pricing_urls: [
      'https://api.neuralwatt.com/v1/models',
    ],
    last_verified: '2026-08-29',
    notes:
      'The public OpenAI-compatible model catalog reports GLM-5.2 and its ' +
      'retained variants at $1.45/M input, $4.50/M output, and $0.145/M cached ' +
      'input. Full-context variants advertise max_model_len 1,048,560; short ' +
      'variants advertise max_model_len 199,984.',
  },
  {
    provider: 'xai',
    models_url: 'https://docs.x.ai/developers/models',
    pricing_urls: [
      'https://docs.x.ai/developers/models/grok-4.6',
      'https://docs.x.ai/developers/models/grok-4.20',
    ],
    last_verified: '2026-08-26',
    notes:
      'Official pages list grok-4.6 (500,000 context; $2/$6 below 200K) and ' +
      'grok-4.20-0309-reasoning (1,000,000 context; $1.25/$2.50 below 200K). ' +
      'RouteShift has no xAI runtime adapter, so these remain generated/parked ' +
      'explicit-only records and are not curated or auto-routed.',
  },
  {
    provider: 'mistral',
    models_url: 'https://docs.mistral.ai/models',
    pricing_urls: [
      'https://docs.mistral.ai/models/mistral-small-4-0-26-03',
      'https://mistral.ai/pricing/api/',
    ],
    last_verified: '2026-08-26',
    notes:
      'The official Mistral Small 4 page identifies API model ID mistral-small-2603, ' +
      '256,000 context, and $0.15/M input plus $0.60/M output. RouteShift has no ' +
      'Mistral runtime adapter, so the candidate remains generated explicit-only ' +
      'and is not curated or auto-routed.',
  },
  {
    provider: 'azure',
    models_url: 'https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure',
    pricing_urls: [
      'https://azure.microsoft.com/en-us/pricing/details/azure-openai/',
    ],
    last_verified: '2026-08-26',
    notes:
      'Microsoft lists gpt-5.6-sol, gpt-5.6-terra, and gpt-5.6-luna at ' +
      '1,050,000 context with Chat Completions support. The Azure pricing page ' +
      'shows no numeric GPT-5.6 prices in the fetched table and says cache-write ' +
      'charges are not active yet; retain the exact ' +
      'azure_gpt_5_6_cache_write_policy_unverified quarantine rather than ' +
      'inheriting direct OpenAI cache billing.',
  },
  {
    provider: 'bedrock',
    models_url: 'https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards.html',
    pricing_urls: [
      'https://aws.amazon.com/bedrock/pricing/',
      'https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html',
    ],
    last_verified: '2026-08-26',
    notes:
      'AWS model cards and prompt-caching guidance separately list openai.gpt-5.6-sol, ' +
      'openai.gpt-5.6-terra, and openai.gpt-5.6-luna. AWS documents 1.25x input ' +
      'cache-write billing and 90%-discounted reads for GPT-5.6, while GPT-5.5 ' +
      'and earlier OpenAI-on-Bedrock models have no write fee. The current Bedrock ' +
      'adapter remains Claude-only; no new Bedrock adapter or route is added.',
  },
];

/** Look up the authoritative source record for a provider, if tracked. */
export function getModelSource(provider: string): ModelSource | undefined {
  return MODEL_SOURCES.find((s) => s.provider === provider);
}
