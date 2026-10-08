#!/usr/bin/env tsx
/**
 * Legacy pure conversion helpers for LiteLLM pricing rows.
 *
 * The supported `sync-pricing` package command delegates to
 * `refresh-catalog`; this module deliberately performs no fetch or file write.
 * `catalog-refresh.ts` consumes these helpers while producing all generated
 * artifacts atomically.
 */

import {
  LITELLM_PROVIDER_MAP as PROVIDER_MAP,
  stripProviderPrefix,
  type LiteLLMEntry,
} from './litellm-source.js';
import { resolveCacheWritePolicy } from './cache-write-policy.js';

// LiteLLM can temporarily carry generated/speculative IDs before provider registries
// expose real models. Keep this denylist at generation time so stale models do
// not ship in the committed fallback table. claude-sonnet-4-7 was never shipped
// by Anthropic and should stay removed. claude-opus-4-7 is GA and hand-priced
// in cost-tables.ts (which wins on conflict), so it must NOT be denied here —
// listing it would silently drop the LiteLLM copy of an already-supported model.
const STALE_MODEL_PATTERNS: RegExp[] = [
  /(^|\.)claude-sonnet-4-7($|-)/,
];
const DISCONTINUED_MOONSHOT_PATTERNS: RegExp[] = [
  /^kimi-k2(?:[.-]|$)/i,
  /^kimi-latest(?:[.-]|$)/i,
  /^kimi-thinking-preview(?:[.-]|$)/i,
];

function isStaleGeneratedModel(provider: string, model: string): boolean {
  if (provider === 'moonshot') {
    return DISCONTINUED_MOONSHOT_PATTERNS.some((pattern) => pattern.test(model));
  }
  if (provider !== 'anthropic' && provider !== 'bedrock') return false;
  return STALE_MODEL_PATTERNS.some((pattern) => pattern.test(model));
}

// PROVIDER_MAP, LiteLLMEntry, the fetch, and stripProviderPrefix now live in
// litellm-source.ts (shared with detect-model-drift.ts).
//
// Providers that are subscription-based, token-plan based, or otherwise not
// tracked per-token by upstream community tables (e.g. `xiaomi`, `nvidia_nim`)
// must remain manual-only in cost-tables.ts.

export interface OutputEntry {
  provider: string;
  model: string;
  input_per_million: number;
  output_per_million: number;
  cache_read_per_million?: number;
  cache_write_per_million?: number;
  input_per_million_above_272k?: number;
  output_per_million_above_272k?: number;
  cache_read_per_million_above_272k?: number;
  cache_write_per_million_above_272k?: number;
}

export type OutputEntryResult =
  | { kind: 'entry'; entry: OutputEntry }
  | { kind: 'quarantine'; provider: string; model: string; reason: string };

export function toOutputEntryResult(modelKey: string, entry: LiteLLMEntry): OutputEntryResult | null {
  if (modelKey === 'sample_spec') return null;
  if (entry.mode && entry.mode !== 'chat') return null;
  const ourProvider = entry.litellm_provider ? PROVIDER_MAP[entry.litellm_provider] : undefined;
  if (!ourProvider) return null;

  const inCost = entry.input_cost_per_token;
  const outCost = entry.output_cost_per_token;
  if (typeof inCost !== 'number' || typeof outCost !== 'number') return null;
  if (inCost === 0 && outCost === 0) return null;

  // LiteLLM stores per-token USD; we store per-million USD for parity with
  // the hand-curated table.
  const model = stripProviderPrefix(modelKey);
  if (isStaleGeneratedModel(ourProvider, model)) return null;

  const policy = resolveCacheWritePolicy(ourProvider, model, entry);
  if (policy.kind === 'unknown') {
    return {
      kind: 'quarantine',
      provider: ourProvider,
      model,
      reason: policy.reason,
    };
  }

  const out: OutputEntry = {
    provider: ourProvider,
    model,
    input_per_million: round6(inCost * 1_000_000),
    output_per_million: round6(outCost * 1_000_000),
  };
  if (typeof entry.input_cost_per_token_above_272k_tokens === 'number') {
    out.input_per_million_above_272k = round6(entry.input_cost_per_token_above_272k_tokens * 1_000_000);
  }
  if (typeof entry.output_cost_per_token_above_272k_tokens === 'number') {
    out.output_per_million_above_272k = round6(entry.output_cost_per_token_above_272k_tokens * 1_000_000);
  }
  if (typeof entry.cache_read_input_token_cost === 'number') {
    out.cache_read_per_million = round6(entry.cache_read_input_token_cost * 1_000_000);
  }
  if (typeof entry.cache_read_input_token_cost_above_272k_tokens === 'number') {
    out.cache_read_per_million_above_272k = round6(entry.cache_read_input_token_cost_above_272k_tokens * 1_000_000);
  }

  if (policy.kind === 'rate') {
    out.cache_write_per_million = policy.perMillion;
  } else if (policy.kind === 'input_multiplier') {
    out.cache_write_per_million = round6(inCost * 1_000_000 * policy.multiplier);
    if (typeof entry.cache_creation_input_token_cost_above_272k_tokens === 'number') {
      out.cache_write_per_million_above_272k = round6(entry.cache_creation_input_token_cost_above_272k_tokens * 1_000_000);
    } else if (out.input_per_million_above_272k !== undefined) {
      out.cache_write_per_million_above_272k = round6(out.input_per_million_above_272k * policy.multiplier);
    }
  } else {
    // Non-billers: explicit 0 — an omitted write price would fall back to
    // the 1.25x write multiplier at request time.
    if (
      typeof entry.cache_creation_input_token_cost === 'number'
      && entry.cache_creation_input_token_cost > 0
      && out.cache_read_per_million === undefined
      && entry.input_cost_per_token !== 0
      && entry.cache_creation_input_token_cost / entry.input_cost_per_token < 1
    ) {
      out.cache_read_per_million = round6(entry.cache_creation_input_token_cost * 1_000_000);
    }
    out.cache_write_per_million = 0;
    if (typeof entry.cache_creation_input_token_cost_above_272k_tokens === 'number') {
      out.cache_write_per_million_above_272k = 0;
    }
  }
  return { kind: 'entry', entry: out };
}

/** Compatibility wrapper for the pricing-only generator. */
export function toOutputEntry(modelKey: string, entry: LiteLLMEntry): OutputEntry | null {
  const result = toOutputEntryResult(modelKey, entry);
  return result?.kind === 'entry' ? result.entry : null;
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
