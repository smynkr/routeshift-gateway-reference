import type { LiteLLMEntry } from './litellm-source.js';

export type CacheWritePolicy =
  | { kind: 'rate'; perMillion: number }
  | { kind: 'input_multiplier'; multiplier: 1.25 }
  | { kind: 'not_billed' }
  | { kind: 'unknown'; reason: string };

/**
 * Providers reviewed as using cache-hit/cache-miss pricing without a
 * separately billed cache-write token class. Keep this an explicit allowlist:
 * an unmapped or newly introduced provider must not silently inherit a
 * zero-write assumption.
 */
const REVIEWED_NO_WRITE_PROVIDERS: Record<string, true> = {
  openai: true,
  azure: true,
  google: true,
  minimax: true,
  moonshot: true,
  deepseek: true,
  zai: true,
  qwen: true,
  together: true,
  groq: true,
  meta: true,
  mistral: true,
  xai: true,
};

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Resolve the reviewed cache-write semantics for one normalized model row.
 * The provider is the canonical RouteShift provider id and model is the
 * provider-stripped model id.
 */
export function resolveCacheWritePolicy(
  provider: string,
  model: string,
  entry: LiteLLMEntry,
): CacheWritePolicy {
  const lower = model.toLowerCase();
  const normalized = lower.slice(lower.lastIndexOf('/') + 1);
  const gpt56 = /(^|\.)openai\.gpt-5\.6(?:-|$)|^gpt-5\.6(?:-|$)/.test(normalized);
  if (provider === 'azure' && gpt56) {
    return { kind: 'unknown', reason: 'azure_gpt_5_6_cache_write_policy_unverified' };
  }
  if ((provider === 'openai' || provider === 'bedrock') && gpt56) {
    return { kind: 'input_multiplier', multiplier: 1.25 };
  }
  if (provider === 'qwen' && normalized === 'qwen3.8-max') {
    return { kind: 'input_multiplier', multiplier: 1.25 };
  }
  if (provider === 'bedrock' && lower.includes('openai.') && !gpt56) {
    return { kind: 'not_billed' };
  }
  if (provider === 'anthropic' || (provider === 'bedrock' && lower.includes('anthropic.'))) {
    const rate = entry.cache_creation_input_token_cost;
    return typeof rate === 'number'
      ? { kind: 'rate', perMillion: round6(rate * 1_000_000) }
      : { kind: 'input_multiplier', multiplier: 1.25 };
  }
  if (provider === 'bedrock') {
    const rate = entry.cache_creation_input_token_cost;
    return typeof rate === 'number'
      ? { kind: 'rate', perMillion: round6(rate * 1_000_000) }
      : { kind: 'unknown', reason: `unreviewed_cache_write_policy:${provider}:${model}` };
  }
  if (REVIEWED_NO_WRITE_PROVIDERS[provider]) return { kind: 'not_billed' };
  return { kind: 'unknown', reason: `unreviewed_cache_write_policy:${provider}:${model}` };
}
