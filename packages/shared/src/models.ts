import type { CapabilityIndices } from './capability-sources';

export const PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'together',
  'groq',
  'zai',
  'cloudflare-workers-ai',
  'neuralwatt',
  'xiaomi',
  'minimax',
  'moonshot',
  'qwen',
  'azure',
  'bedrock',
  'xai',
  'deepseek',
  'mistral',
  'meta',
] as const;

/**
 * Catalog providers with NO registered runtime adapter in the proxy yet.
 * These are priced (for planning) and can hold dashboard keys, but the proxy
 * cannot dispatch to them: promoting a model of one of these providers mints
 * a publicly-listed model that 400s "Unknown provider" on every request.
 * Consumed by scripts/promote-model.ts (refuses promotion), the shared
 * pricing gate, and apps/proxy/src/audit-findings-regression.test.ts — when
 * an adapter lands, remove the provider here (routeshift-provider-onboarding)
 * and all three follow.
 */
export const PROVIDERS_WITHOUT_RUNTIME_ADAPTER = [
  'meta',
  'xai',
  'deepseek',
  'mistral',
] as const;
export type Provider = (typeof PROVIDERS)[number];

/** Google preview IDs explicitly quarantined from generated and prefix catalogs. */
export const GOOGLE_PREVIEW_QUARANTINE_IDS = [
  'gemini-2.5-flash-lite-preview-06-17',
  'gemini-2.5-flash-lite-preview-09-2025',
  'gemini-2.5-flash-preview-09-2025',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite-preview',
  'gemini-3.1-pro-preview',
  'gemini-3.1-pro-preview-customtools',
] as const;

export interface ModelDefinition {
  provider: Provider;
  canonical_name: string;
  api_model_id: string;
  context_window: number;
  max_output?: number;
  /**
   * If false, the model is visible for explicit rules/aliases but excluded from
   * automatic routing. Use for deployment-scoped/preview/vendor-specific models
   * that require explicit provider-key metadata or commercial approval.
   */
  auto_route?: boolean;
  /**
   * If false, the model is hidden from the UNAUTHENTICATED /v1/models catalog
   * (preview / deployment-scoped / commercial-approval-only). Authenticated keys
   * still see it when it is within their allowedModels. Defaults to true.
   */
  public?: boolean;
  /**
   * True for externally addressable compatibility models retained after a
   * provider migration. Legacy models remain requestable but never auto-route.
   */
  legacy?: boolean;
  /**
   * True when this model is the preferred current recommendation for its role.
   */
  recommended?: boolean;
  intelligence_tier?: 1 | 2 | 3;
  /**
   * OpenRouter-style capability indices (0-100) with provenance. Optional and
   * deliberately ABSENT for every model today: the source (OpenRouter's
   * performance data) is only reachable through their OAuth-gated MCP server,
   * so values are populated by the documented curation procedure in
   * capability-sources.ts — never derived, never invented. The auto-router
   * treats missing indices as "no signal" (factor 1.0, never a penalty).
   * Bounds + provenance are enforced by the registry gate test.
   */
  capability_indices?: CapabilityIndices;
  /**
   * The native adapter for this exact provider/model can accept a validated
   * PDF content block. Missing is deliberately false: do not infer support
   * from a provider family or a model-name prefix.
   */
  supports_native_pdf?: boolean;
}

const modelContextMap = new Map<string, number>();

export function getModelContextWindow(model: string): number | null {
  if (modelContextMap.size === 0) {
    for (const m of MODEL_REGISTRY) {
      modelContextMap.set(m.canonical_name, m.context_window);
      if (m.api_model_id !== m.canonical_name) {
        modelContextMap.set(m.api_model_id, m.context_window);
      }
    }
  }
  return modelContextMap.get(model) ?? null;
}

/**
 * Native PDF support is an adapter contract, not a routing guess. This stays
 * false for compatible/Bedrock providers until their wire format has its own
 * tested implementation.
 */
export function supportsNativePdf(provider: string, model: string): boolean {
  return MODEL_REGISTRY.some((entry) => (
    entry.provider === provider
    && entry.supports_native_pdf === true
    && (entry.canonical_name === model || entry.api_model_id === model)
  ));
}

export const MODEL_REGISTRY: ModelDefinition[] = [
  // ── OpenAI: current frontier (auto-routed). Older GPT-4.x / o-series and
  //    base gpt-5 stay priced below for historical request_logs but are
  //    excluded from auto-routing via auto_route:false. ──
  { provider: 'openai', canonical_name: 'gpt-5.5', api_model_id: 'gpt-5.5', context_window: 1_000_000, intelligence_tier: 3 },
  { provider: 'openai', canonical_name: 'gpt-5.5-pro', api_model_id: 'gpt-5.5-pro', context_window: 1_000_000, intelligence_tier: 3 },
  { provider: 'openai', canonical_name: 'gpt-5.4', api_model_id: 'gpt-5.4', context_window: 1_000_000, intelligence_tier: 3 },
  { provider: 'openai', canonical_name: 'gpt-5.4-mini', api_model_id: 'gpt-5.4-mini', context_window: 400_000, intelligence_tier: 2 },
  { provider: 'openai', canonical_name: 'gpt-5.4-nano', api_model_id: 'gpt-5.4-nano', context_window: 400_000, intelligence_tier: 1 },
  // GPT-5.6 family — official OpenAI IDs and 1,050,000 context (verified 2026-08-26).
  // The unsuffixed alias maps to the Sol snapshot; all GPT-5.6 rows remain
  // explicit-only until a reviewed auto-route policy exists.
  { provider: 'openai', canonical_name: 'gpt-5.6', api_model_id: 'gpt-5.6-sol', context_window: 1_050_000, auto_route: false, public: true, intelligence_tier: 3 },
  { provider: 'openai', canonical_name: 'gpt-5.6-terra', api_model_id: 'gpt-5.6-terra', context_window: 1_050_000, auto_route: false, public: true, intelligence_tier: 2 },
  { provider: 'openai', canonical_name: 'gpt-5.6-luna', api_model_id: 'gpt-5.6-luna', context_window: 1_050_000, auto_route: false, public: true, intelligence_tier: 1 },
  // GPT-5.6 Cyber is Responses-only and approval-gated; retain a hidden
  // compatibility record so the gpt-* prefix fallback cannot dispatch it.
  { provider: 'openai', canonical_name: 'gpt-5.6-cyber', api_model_id: 'gpt-5.6-cyber', context_window: 400_000, auto_route: false, public: false, intelligence_tier: 3 },
  { provider: 'openai', canonical_name: 'gpt-oss-120b', api_model_id: 'gpt-oss-120b', context_window: 128_000, intelligence_tier: 2 },
  { provider: 'openai', canonical_name: 'gpt-oss-20b', api_model_id: 'gpt-oss-20b', context_window: 128_000, intelligence_tier: 1 },
  { provider: 'openai', canonical_name: 'gpt-5', api_model_id: 'gpt-5', context_window: 1_000_000, auto_route: false, intelligence_tier: 3 },
  { provider: 'openai', canonical_name: 'gpt-4.1', api_model_id: 'gpt-4.1', context_window: 1_000_000, auto_route: false, intelligence_tier: 3 },
  { provider: 'openai', canonical_name: 'gpt-4.1-mini', api_model_id: 'gpt-4.1-mini', context_window: 1_000_000, auto_route: false, intelligence_tier: 2 },
  { provider: 'openai', canonical_name: 'gpt-4.1-nano', api_model_id: 'gpt-4.1-nano', context_window: 1_000_000, auto_route: false, intelligence_tier: 1 },
  { provider: 'openai', canonical_name: 'o3', api_model_id: 'o3', context_window: 200_000, auto_route: false, intelligence_tier: 3 },
  { provider: 'openai', canonical_name: 'o4-mini', api_model_id: 'o4-mini', context_window: 200_000, auto_route: false, intelligence_tier: 2 },
  // Azure offers the same GPT 5.x models as deployments; they are represented
  // by the canonical openai entries above and reachable on Azure via
  // model_aliases / provider strategies. Azure-specific list pricing is still
  // kept in cost-tables (azure:gpt-5.4 / azure:gpt-5.5) for explicit routing.
  // ── Anthropic: current frontier (auto-routed). 4.5 line kept priced for history. ──
  { provider: 'anthropic', canonical_name: 'claude-opus-4-8', api_model_id: 'claude-opus-4-8', context_window: 1_000_000, intelligence_tier: 3, supports_native_pdf: true },
  { provider: 'anthropic', canonical_name: 'claude-opus-4-7', api_model_id: 'claude-opus-4-7', context_window: 1_000_000, intelligence_tier: 3, supports_native_pdf: true },
  // Claude Fable 5 — GA 2026-06-09. 1M context, max 128k output. Priced 2x Opus.
  { provider: 'anthropic', canonical_name: 'claude-fable-5', api_model_id: 'claude-fable-5', context_window: 1_000_000, intelligence_tier: 3, supports_native_pdf: true },
  // Claude Sonnet 5 — same-generation mid-tier release as Claude Fable 5.
  { provider: 'anthropic', canonical_name: 'claude-sonnet-5', api_model_id: 'claude-sonnet-5', context_window: 1_000_000, intelligence_tier: 3, supports_native_pdf: true },
  { provider: 'anthropic', canonical_name: 'claude-opus-4-6', api_model_id: 'claude-opus-4-6-20250219', context_window: 1_000_000, intelligence_tier: 3, supports_native_pdf: true },
  { provider: 'anthropic', canonical_name: 'claude-sonnet-4-6', api_model_id: 'claude-sonnet-4-6-20250514', context_window: 1_000_000, intelligence_tier: 3, supports_native_pdf: true },
  { provider: 'anthropic', canonical_name: 'claude-haiku-4-5', api_model_id: 'claude-haiku-4-5-20251001', context_window: 200_000, intelligence_tier: 2, supports_native_pdf: true },
  { provider: 'anthropic', canonical_name: 'claude-opus-4-5', api_model_id: 'claude-opus-4-5', context_window: 1_000_000, auto_route: false, intelligence_tier: 3, supports_native_pdf: true },
  { provider: 'anthropic', canonical_name: 'claude-sonnet-4-5', api_model_id: 'claude-sonnet-4-5', context_window: 1_000_000, auto_route: false, intelligence_tier: 3, supports_native_pdf: true },
  // ── Google: Gemini 3.x current (auto-routed). 2.5 line kept priced for history. ──
  { provider: 'google', canonical_name: 'gemini-3.1-pro', api_model_id: 'gemini-3.1-pro', context_window: 1_000_000, intelligence_tier: 3, supports_native_pdf: true },
  { provider: 'google', canonical_name: 'gemini-3.5-flash', api_model_id: 'gemini-3.5-flash', context_window: 1_000_000, intelligence_tier: 2, supports_native_pdf: true },
  { provider: 'google', canonical_name: 'gemini-3-flash', api_model_id: 'gemini-3-flash', context_window: 1_000_000, intelligence_tier: 2, supports_native_pdf: true },
  { provider: 'google', canonical_name: 'gemini-3.1-flash-lite', api_model_id: 'gemini-3.1-flash-lite', context_window: 1_000_000, intelligence_tier: 1, supports_native_pdf: true },
  // Gemini 3.7 Flash — stable Google API model; explicit-only until a
  // reviewed auto-route policy is added (official pages verified 2026-08-26).
  { provider: 'google', canonical_name: 'gemini-3.7-flash', api_model_id: 'gemini-3.7-flash', context_window: 1_048_576, auto_route: false, public: true, intelligence_tier: 2, supports_native_pdf: true },
  { provider: 'google', canonical_name: 'gemini-2.5-flash-lite', api_model_id: 'gemini-2.5-flash-lite', context_window: 1_048_576, auto_route: false, public: true, intelligence_tier: 1, supports_native_pdf: true },
  { provider: 'google', canonical_name: 'gemini-3.5-flash-lite', api_model_id: 'gemini-3.5-flash-lite', context_window: 1_048_576, auto_route: false, public: true, intelligence_tier: 1, supports_native_pdf: true },
  { provider: 'google', canonical_name: 'gemini-2.5-pro', api_model_id: 'gemini-2.5-pro', context_window: 1_000_000, auto_route: false, intelligence_tier: 3, supports_native_pdf: true },
  { provider: 'google', canonical_name: 'gemini-2.5-flash', api_model_id: 'gemini-2.5-flash', context_window: 1_000_000, auto_route: false, intelligence_tier: 2, supports_native_pdf: true },
  // Z.ai (Zhipu GLM) — LAY-295
  { provider: 'zai', canonical_name: 'glm-4.5', api_model_id: 'glm-4.5', context_window: 128_000, intelligence_tier: 1 },
  { provider: 'zai', canonical_name: 'glm-4.5-air', api_model_id: 'glm-4.5-air', context_window: 128_000, intelligence_tier: 1 },
  { provider: 'zai', canonical_name: 'glm-4.6', api_model_id: 'glm-4.6', context_window: 200_000, intelligence_tier: 2 },
  { provider: 'zai', canonical_name: 'glm-4.7', api_model_id: 'glm-4.7', context_window: 200_000, intelligence_tier: 3 },
  { provider: 'zai', canonical_name: 'glm-5', api_model_id: 'glm-5', context_window: 256_000, intelligence_tier: 3 },
  { provider: 'zai', canonical_name: 'glm-5-turbo', api_model_id: 'glm-5-turbo', context_window: 128_000, intelligence_tier: 2 },
  { provider: 'zai', canonical_name: 'glm-5.1', api_model_id: 'glm-5.1', context_window: 256_000, intelligence_tier: 3 },
  // Cloudflare Workers AI — current recommended GLM-5.3-Flash.
  { provider: 'cloudflare-workers-ai', canonical_name: '@cf/zai-org/glm-5.3-flash', api_model_id: '@cf/zai-org/glm-5.3-flash', context_window: 1_048_576, intelligence_tier: 3, auto_route: true, public: true, legacy: false, recommended: true },
  // NeuralWatt — externally addressable GLM-5.2 compatibility IDs. Keep these
  // explicit-only and identity-preserving until usage reaches zero.
  { provider: 'neuralwatt', canonical_name: 'glm-5.2', api_model_id: 'glm-5.2', context_window: 1_048_560, auto_route: false, public: true, legacy: true, recommended: false, intelligence_tier: 3 },
  { provider: 'neuralwatt', canonical_name: 'glm-5.2-fast', api_model_id: 'glm-5.2-fast', context_window: 1_048_560, auto_route: false, public: true, legacy: true, recommended: false, intelligence_tier: 3 },
  { provider: 'neuralwatt', canonical_name: 'glm-5.2-short', api_model_id: 'glm-5.2-short', context_window: 199_984, auto_route: false, public: true, legacy: true, recommended: false, intelligence_tier: 2 },
  { provider: 'neuralwatt', canonical_name: 'glm-5.2-short-fast', api_model_id: 'glm-5.2-short-fast', context_window: 199_984, auto_route: false, public: true, legacy: true, recommended: false, intelligence_tier: 2 },
  { provider: 'neuralwatt', canonical_name: 'glm-5.2-short-fast-flex', api_model_id: 'glm-5.2-short-fast-flex', context_window: 199_984, auto_route: false, public: true, legacy: true, recommended: false, intelligence_tier: 2 },
  // Xiaomi MiMo (Token Plan) — LAY-294
  { provider: 'xiaomi', canonical_name: 'mimo-v2.5-pro', api_model_id: 'mimo-v2.5-pro', context_window: 1_000_000, auto_route: false, intelligence_tier: 2 },
  { provider: 'xiaomi', canonical_name: 'mimo-v2-flash', api_model_id: 'mimo-v2-flash', context_window: 128_000, auto_route: false, intelligence_tier: 1 },
  // MiniMax (Anthropic-compat) — LAY-296 / RTSH-4
  { provider: 'minimax', canonical_name: 'MiniMax-M2', api_model_id: 'MiniMax-M2', context_window: 200_000, intelligence_tier: 2 },
  // Kimi K2 is discontinued; retain hidden historical rows for pricing/logs.
  { provider: 'moonshot', canonical_name: 'kimi-k2.6', api_model_id: 'kimi-k2.6', context_window: 262_144, auto_route: false, public: false, intelligence_tier: 3 },
  { provider: 'moonshot', canonical_name: 'kimi-k2.7-code', api_model_id: 'kimi-k2.7-code', context_window: 262_144, auto_route: false, public: false, intelligence_tier: 3 },
  // Anthropic-compatible adapter supports explicit dispatch (verified 2026-08-26).
  { provider: 'moonshot', canonical_name: 'kimi-k3', api_model_id: 'kimi-k3', context_window: 1_048_576, auto_route: false, public: true, intelligence_tier: 3 },
  // Alibaba DashScope (Qwen) — LAY-297
  { provider: 'qwen', canonical_name: 'qwen3.7-max', api_model_id: 'qwen3.7-max', context_window: 262_144, intelligence_tier: 3 },
  { provider: 'qwen', canonical_name: 'qwen3.7-plus', api_model_id: 'qwen3.7-plus', context_window: 1_000_000, intelligence_tier: 2 },
  { provider: 'qwen', canonical_name: 'qwen3.6-flash', api_model_id: 'qwen3.6-flash', context_window: 1_000_000, intelligence_tier: 2 },
  { provider: 'qwen', canonical_name: 'Qwen3-Next-80B-Thinking', api_model_id: 'Qwen3-Next-80B-Thinking', context_window: 128_000, intelligence_tier: 3 },
  { provider: 'qwen', canonical_name: 'Qwen3-Next-80B-Instruct', api_model_id: 'Qwen3-Next-80B-Instruct', context_window: 128_000, intelligence_tier: 2 },
  { provider: 'qwen', canonical_name: 'Qwen3-Coder-480B-A35B-Instruct', api_model_id: 'Qwen3-Coder-480B-A35B-Instruct', context_window: 256_000, intelligence_tier: 2 },
  { provider: 'qwen', canonical_name: 'Qwen3-235B-A22B-Instruct-2507', api_model_id: 'Qwen3-235B-A22B-Instruct-2507', context_window: 256_000, intelligence_tier: 2 },
  // Qwen3.8-Max — official international DashScope model; explicit-only
  // because this is a new curated row (verified 2026-08-26).
  { provider: 'qwen', canonical_name: 'qwen3.8-max', api_model_id: 'qwen3.8-max', context_window: 1_000_000, auto_route: false, public: true, intelligence_tier: 3 },
  // Native providers below are priced for internal planning/history but are not
  // registered in the proxy runtime yet. Keep them out of public discovery until
  // routing, credentials UI, and provider adapters are wired end to end.
  { provider: 'xai', canonical_name: 'grok-4.20-reasoning', api_model_id: 'grok-4.20-reasoning', context_window: 256_000, auto_route: false, public: false, intelligence_tier: 3 },
  { provider: 'xai', canonical_name: 'grok-4.1-fast', api_model_id: 'grok-4.1-fast', context_window: 256_000, auto_route: false, public: false, intelligence_tier: 2 },
  { provider: 'deepseek', canonical_name: 'deepseek-v3.1', api_model_id: 'deepseek-v3.1', context_window: 128_000, auto_route: false, public: false, intelligence_tier: 2 },
  { provider: 'deepseek', canonical_name: 'deepseek-v3.2', api_model_id: 'deepseek-v3.2', context_window: 128_000, auto_route: false, public: false, intelligence_tier: 3 },
  { provider: 'deepseek', canonical_name: 'deepseek-r1-0528', api_model_id: 'deepseek-r1-0528', context_window: 128_000, auto_route: false, public: false, intelligence_tier: 3 },
  { provider: 'mistral', canonical_name: 'mistral-medium-3', api_model_id: 'mistral-medium-3', context_window: 128_000, auto_route: false, public: false, intelligence_tier: 2 },
  { provider: 'mistral', canonical_name: 'mistral-small-3.1', api_model_id: 'mistral-small-3.1', context_window: 128_000, auto_route: false, public: false, intelligence_tier: 1 },
  { provider: 'mistral', canonical_name: 'codestral-2', api_model_id: 'codestral-2', context_window: 256_000, auto_route: false, public: false, intelligence_tier: 2 },
  { provider: 'meta', canonical_name: 'llama-3.3-70b', api_model_id: 'llama-3.3-70b', context_window: 128_000, auto_route: false, public: false, intelligence_tier: 2 },
  { provider: 'meta', canonical_name: 'llama-3.1-70b', api_model_id: 'llama-3.1-70b', context_window: 128_000, auto_route: false, public: false, intelligence_tier: 2 },
  { provider: 'meta', canonical_name: 'llama-4-scout', api_model_id: 'llama-4-scout', context_window: 1_000_000, auto_route: false, public: false, intelligence_tier: 2 },
  { provider: 'meta', canonical_name: 'llama-4-maverick', api_model_id: 'llama-4-maverick', context_window: 1_000_000, auto_route: false, public: false, intelligence_tier: 3 },
  // ── 2026-08-10 detect-model-drift candidates (RSH-166, GH #206). Parked:
  //    never auto-routed, hidden from public discovery until promoted via
  //    the provider-onboarding flow. Prefix-passthrough-covered ids (gpt-* /
  //    o3-* / o4-* / claude-* / gemini-*) are deliberately NOT parked here: an
  //    exact parked match would revoke working passthrough traffic (pinned by
  //    tests/proxy-handler-basic.test.ts); they keep resolving via prefix and
  //    are left to priced manual onboarding. Pricing: sync-pricing + explicit. ──
  { provider: 'deepseek', canonical_name: 'deepseek-r1', api_model_id: 'deepseek-r1', context_window: 65_536, auto_route: false, public: false },
  { provider: 'deepseek', canonical_name: 'deepseek-v3', api_model_id: 'deepseek-v3', context_window: 65_536, auto_route: false, public: false },
  { provider: 'meta', canonical_name: 'Llama-3.3-70B-Instruct', api_model_id: 'Llama-3.3-70B-Instruct', context_window: 128_000, auto_route: false, public: false },
  { provider: 'meta', canonical_name: 'Llama-4-Maverick-17B-128E-Instruct-FP8', api_model_id: 'Llama-4-Maverick-17B-128E-Instruct-FP8', context_window: 1_000_000, auto_route: false, public: false },
  { provider: 'meta', canonical_name: 'Llama-4-Scout-17B-16E-Instruct-FP8', api_model_id: 'Llama-4-Scout-17B-16E-Instruct-FP8', context_window: 10_000_000, auto_route: false, public: false },
  { provider: 'minimax', canonical_name: 'MiniMax-M2.1', api_model_id: 'MiniMax-M2.1', context_window: 1_000_000, auto_route: false, public: false },
  { provider: 'minimax', canonical_name: 'MiniMax-M2.1-lightning', api_model_id: 'MiniMax-M2.1-lightning', context_window: 1_000_000, auto_route: false, public: false },
  { provider: 'minimax', canonical_name: 'MiniMax-M2.5', api_model_id: 'MiniMax-M2.5', context_window: 1_000_000, auto_route: false, public: false },
  { provider: 'minimax', canonical_name: 'MiniMax-M2.5-lightning', api_model_id: 'MiniMax-M2.5-lightning', context_window: 1_000_000, auto_route: false, public: false },
  { provider: 'mistral', canonical_name: 'mistral-medium', api_model_id: 'mistral-medium', context_window: 32_000, auto_route: false, public: false },
  { provider: 'mistral', canonical_name: 'mistral-medium-3-1-2508', api_model_id: 'mistral-medium-3-1-2508', context_window: 131_072, auto_route: false, public: false },
  { provider: 'mistral', canonical_name: 'mistral-medium-3-5', api_model_id: 'mistral-medium-3-5', context_window: 262_144, auto_route: false, public: false },
  { provider: 'mistral', canonical_name: 'mistral-small', api_model_id: 'mistral-small', context_window: 32_000, auto_route: false, public: false },
  { provider: 'xai', canonical_name: 'grok-4', api_model_id: 'grok-4', context_window: 256_000, auto_route: false, public: false },
  { provider: 'zai', canonical_name: 'glm-4.5-airx', api_model_id: 'glm-4.5-airx', context_window: 128_000, auto_route: false, public: false },
  { provider: 'zai', canonical_name: 'glm-4.5-flash', api_model_id: 'glm-4.5-flash', context_window: 128_000, auto_route: false, public: false },
  { provider: 'zai', canonical_name: 'glm-4.5-x', api_model_id: 'glm-4.5-x', context_window: 128_000, auto_route: false, public: false },
  { provider: 'zai', canonical_name: 'glm-4.7-flash', api_model_id: 'glm-4.7-flash', context_window: 200_000, auto_route: false, public: false },
  { provider: 'zai', canonical_name: 'glm-5-code', api_model_id: 'glm-5-code', context_window: 200_000, auto_route: false, public: false },
// ── Auto-proposed parked candidates (detect-models 2026-08-10) — inert until promoted. ──
  { provider: 'mistral', canonical_name: 'mistral-medium-2312', api_model_id: 'mistral-medium-2312', context_window: 32_000, auto_route: false, public: false },
  { provider: 'mistral', canonical_name: 'mistral-medium-2505', api_model_id: 'mistral-medium-2505', context_window: 131_072, auto_route: false, public: false },
  { provider: 'mistral', canonical_name: 'mistral-medium-2508', api_model_id: 'mistral-medium-2508', context_window: 131_072, auto_route: false, public: false },
  { provider: 'mistral', canonical_name: 'mistral-medium-2604', api_model_id: 'mistral-medium-2604', context_window: 262_144, auto_route: false, public: false },
  { provider: 'mistral', canonical_name: 'mistral-medium-latest', api_model_id: 'mistral-medium-latest', context_window: 262_144, auto_route: false, public: false },
  { provider: 'mistral', canonical_name: 'mistral-small-3-2-2506', api_model_id: 'mistral-small-3-2-2506', context_window: 131_072, auto_route: false, public: false },
  { provider: 'mistral', canonical_name: 'mistral-small-latest', api_model_id: 'mistral-small-latest', context_window: 131_072, auto_route: false, public: false },
  { provider: 'xai', canonical_name: 'grok-4-0709', api_model_id: 'grok-4-0709', context_window: 256_000, auto_route: false, public: false },
  // Legacy xAI IDs retained as non-public historical records. The official
  // 2026-08-26 xAI catalog no longer lists these and RouteShift has no xAI
  // adapter; they must not dispatch or enter automatic routing.
  { provider: 'xai', canonical_name: 'grok-4-1-fast', api_model_id: 'grok-4-1-fast', context_window: 2_000_000, auto_route: false, public: false },
  { provider: 'xai', canonical_name: 'grok-4-1-fast-non-reasoning', api_model_id: 'grok-4-1-fast-non-reasoning', context_window: 2_000_000, auto_route: false, public: false },
  { provider: 'xai', canonical_name: 'grok-4-1-fast-non-reasoning-latest', api_model_id: 'grok-4-1-fast-non-reasoning-latest', context_window: 2_000_000, auto_route: false, public: false },
  { provider: 'xai', canonical_name: 'grok-4-1-fast-reasoning', api_model_id: 'grok-4-1-fast-reasoning', context_window: 2_000_000, auto_route: false, public: false },
  { provider: 'xai', canonical_name: 'grok-4-1-fast-reasoning-latest', api_model_id: 'grok-4-1-fast-reasoning-latest', context_window: 2_000_000, auto_route: false, public: false },
  { provider: 'xai', canonical_name: 'grok-4-fast-non-reasoning', api_model_id: 'grok-4-fast-non-reasoning', context_window: 2_000_000, auto_route: false, public: false },
  { provider: 'xai', canonical_name: 'grok-4-fast-reasoning', api_model_id: 'grok-4-fast-reasoning', context_window: 2_000_000, auto_route: false, public: false },
  { provider: 'xai', canonical_name: 'grok-4-latest', api_model_id: 'grok-4-latest', context_window: 256_000, auto_route: false, public: false },
  { provider: 'xai', canonical_name: 'grok-4.20-0309-reasoning', api_model_id: 'grok-4.20-0309-reasoning', context_window: 2_000_000, auto_route: false, public: false },
  { provider: 'xai', canonical_name: 'grok-4.20-beta-0309-non-reasoning', api_model_id: 'grok-4.20-beta-0309-non-reasoning', context_window: 2_000_000, auto_route: false, public: false },
  { provider: 'xai', canonical_name: 'grok-4.20-beta-0309-reasoning', api_model_id: 'grok-4.20-beta-0309-reasoning', context_window: 2_000_000, auto_route: false, public: false },
  { provider: 'xai', canonical_name: 'grok-4.20-multi-agent-beta-0309', api_model_id: 'grok-4.20-multi-agent-beta-0309', context_window: 2_000_000, auto_route: false, public: false },
  { provider: 'xai', canonical_name: 'grok-4.3', api_model_id: 'grok-4.3', context_window: 1_000_000, auto_route: false, public: false },
  { provider: 'xai', canonical_name: 'grok-4.3-latest', api_model_id: 'grok-4.3-latest', context_window: 1_000_000, auto_route: false, public: false },
  { provider: 'xai', canonical_name: 'grok-4.5', api_model_id: 'grok-4.5', context_window: 500_000, auto_route: false, public: false },
  { provider: 'xai', canonical_name: 'grok-4.5-latest', api_model_id: 'grok-4.5-latest', context_window: 500_000, auto_route: false, public: false },
  // ── 2026-08-10 drift-cycle covered ids (RSH-167): prefix-passthrough
  //    ids onboarded via PRICED MANUAL ONBOARDING. These resolve by prefix
  //    today; a parked (public:false) exact match would REVOKE that working
  //    passthrough, so they land PUBLIC and priced (auto_route: false —
  //    visible for explicit rules/aliases, never auto-routed; public is
  //    written EXPLICITLY so a future default change cannot silently park
  //    working routes). Context and pricing come from the LiteLLM catalog;
  //    the pricing gate covers all. Modality-denylisted ids (audio/TTS,
  //    per the propose-parked denylist) are excluded and stay on passthrough.
  //    Registry-wide uniqueness is locked by a test. ──
  // anthropic
  { provider: 'anthropic', canonical_name: 'claude-opus-4-5-20251101', api_model_id: 'claude-opus-4-5-20251101', context_window: 200_000, auto_route: false, public: true },
  { provider: 'anthropic', canonical_name: 'claude-opus-4-6-20260205', api_model_id: 'claude-opus-4-6-20260205', context_window: 1_000_000, auto_route: false, public: true },
  { provider: 'anthropic', canonical_name: 'claude-opus-4-7-20260416', api_model_id: 'claude-opus-4-7-20260416', context_window: 1_000_000, auto_route: false, public: true },
  { provider: 'anthropic', canonical_name: 'claude-sonnet-4-5-20250929', api_model_id: 'claude-sonnet-4-5-20250929', context_window: 200_000, auto_route: false, public: true },
  // openai
  { provider: 'openai', canonical_name: 'gpt-4', api_model_id: 'gpt-4', context_window: 8_192, auto_route: false, public: true },
  { provider: 'openai', canonical_name: 'gpt-4.1-2025-04-14', api_model_id: 'gpt-4.1-2025-04-14', context_window: 1_047_576, auto_route: false, public: true },
  { provider: 'openai', canonical_name: 'gpt-4.1-mini-2025-04-14', api_model_id: 'gpt-4.1-mini-2025-04-14', context_window: 1_047_576, auto_route: false, public: true },
  { provider: 'openai', canonical_name: 'gpt-4.1-nano-2025-04-14', api_model_id: 'gpt-4.1-nano-2025-04-14', context_window: 1_047_576, auto_route: false, public: true },
  { provider: 'openai', canonical_name: 'gpt-5-2025-08-07', api_model_id: 'gpt-5-2025-08-07', context_window: 272_000, auto_route: false, public: true },
  { provider: 'openai', canonical_name: 'gpt-5-chat', api_model_id: 'gpt-5-chat', context_window: 128_000, auto_route: false, public: true },
  { provider: 'openai', canonical_name: 'gpt-5-chat-latest', api_model_id: 'gpt-5-chat-latest', context_window: 128_000, auto_route: false, public: true },
  { provider: 'openai', canonical_name: 'gpt-5-mini', api_model_id: 'gpt-5-mini', context_window: 272_000, auto_route: false, public: true },
  { provider: 'openai', canonical_name: 'gpt-5-mini-2025-08-07', api_model_id: 'gpt-5-mini-2025-08-07', context_window: 272_000, auto_route: false, public: true },
  { provider: 'openai', canonical_name: 'gpt-5-nano', api_model_id: 'gpt-5-nano', context_window: 272_000, auto_route: false, public: true },
  { provider: 'openai', canonical_name: 'gpt-5-nano-2025-08-07', api_model_id: 'gpt-5-nano-2025-08-07', context_window: 272_000, auto_route: false, public: true },
  { provider: 'openai', canonical_name: 'gpt-5-search-api', api_model_id: 'gpt-5-search-api', context_window: 272_000, auto_route: false, public: true },
  { provider: 'openai', canonical_name: 'gpt-5-search-api-2025-10-14', api_model_id: 'gpt-5-search-api-2025-10-14', context_window: 272_000, auto_route: false, public: true },
  { provider: 'openai', canonical_name: 'gpt-5.1', api_model_id: 'gpt-5.1', context_window: 272_000, auto_route: false, public: true },
  { provider: 'openai', canonical_name: 'gpt-5.1-2025-11-13', api_model_id: 'gpt-5.1-2025-11-13', context_window: 272_000, auto_route: false, public: true },
  { provider: 'openai', canonical_name: 'gpt-5.1-chat-latest', api_model_id: 'gpt-5.1-chat-latest', context_window: 128_000, auto_route: false, public: true },
  { provider: 'openai', canonical_name: 'gpt-5.2', api_model_id: 'gpt-5.2', context_window: 272_000, auto_route: false, public: true },
  { provider: 'openai', canonical_name: 'gpt-5.2-2025-12-11', api_model_id: 'gpt-5.2-2025-12-11', context_window: 272_000, auto_route: false, public: true },
  { provider: 'openai', canonical_name: 'gpt-5.2-chat-latest', api_model_id: 'gpt-5.2-chat-latest', context_window: 128_000, auto_route: false, public: true },
  { provider: 'openai', canonical_name: 'gpt-5.3-chat-latest', api_model_id: 'gpt-5.3-chat-latest', context_window: 128_000, auto_route: false, public: true },
  { provider: 'openai', canonical_name: 'gpt-5.4-2026-03-05', api_model_id: 'gpt-5.4-2026-03-05', context_window: 1_050_000, auto_route: false, public: true },
  { provider: 'openai', canonical_name: 'gpt-5.4-mini-2026-03-17', api_model_id: 'gpt-5.4-mini-2026-03-17', context_window: 272_000, auto_route: false, public: true },
  { provider: 'openai', canonical_name: 'gpt-5.4-nano-2026-03-17', api_model_id: 'gpt-5.4-nano-2026-03-17', context_window: 272_000, auto_route: false, public: true },
  { provider: 'openai', canonical_name: 'gpt-5.5-2026-04-23', api_model_id: 'gpt-5.5-2026-04-23', context_window: 1_050_000, auto_route: false, public: true },
  { provider: 'openai', canonical_name: 'o3-2025-04-16', api_model_id: 'o3-2025-04-16', context_window: 200_000, auto_route: false, public: true },
  { provider: 'openai', canonical_name: 'o3-mini', api_model_id: 'o3-mini', context_window: 200_000, auto_route: false, public: true },
  { provider: 'openai', canonical_name: 'o3-mini-2025-01-31', api_model_id: 'o3-mini-2025-01-31', context_window: 200_000, auto_route: false, public: true },
  { provider: 'openai', canonical_name: 'o4-mini-2025-04-16', api_model_id: 'o4-mini-2025-04-16', context_window: 200_000, auto_route: false, public: true },
];
