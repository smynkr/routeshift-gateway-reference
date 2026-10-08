// apps/proxy/src/routing/fallback.ts
import type { CanonicalRequest, EffectiveCatalogDefinition, ModelPricing } from '@routeshift/shared';
import { calculateCostMicrocents, getModelPricing } from '@routeshift/shared';
import type { LLMProvider } from '../providers/types.js';
import { getProvider } from '../providers/registry.js';
import { circuitBreaker } from './circuit-breaker.js';
import type { ProviderKeyConfig } from '../billing/provider-key-crypto.js';
import { assessDispatchTarget, contextWindowForDispatchTarget } from './dispatch-eligibility.js';

export interface FallbackEntry {
  provider: string;
  model: string;
}

export interface FallbackSuccessResult {
  ok: true;
  response: Response;
  provider: LLMProvider;
  providerId: string;
  model: string;
  attempts: FallbackAttempt[];
  /** Numeric predecessor totals are lower bounds when this is false. */
  aggregateActualCostKnown?: boolean;
  aggregateActualCostMicrocents?: number;
  aggregateInputTokens?: number;
  aggregateOutputTokens?: number;
}

export interface FallbackExhaustedResult {
  ok: false;
  attempts: FallbackAttempt[];
}

export type FallbackResult = FallbackSuccessResult | FallbackExhaustedResult;

export interface FallbackAttempt {
  provider: string;
  model: string;
  error: string;
  /** False means a dispatched attempt may have provider spend we cannot price. */
  actual_cost_known?: boolean;
}

/**
 * LAY-321 retry budget. Caps how many fallback attempts a request can make
 * and (optionally) how much estimated cost the chain can rack up. Each
 * cap is its own short-circuit — both are inclusive bounds. When a max-cost
 * ceiling is present, unknown pricing is treated as not budgetable and skipped
 * explicitly rather than silently treating paid unknown models as free.
 */
export interface RetryBudget {
  /** Max fallback attempts after the primary fails. 0 = primary only, no fallbacks. */
  maxRetries: number;
  /** Optional cost ceiling in microcents. When the next attempt's estimated cost would push the cumulative estimate past this, stop. */
  maxCostMicrocents?: number;
  /** Token estimate used for cost projection. Caller already computes this for context-window checks. */
  estimatedInputTokens?: number;
  /** Caller-provided max-output token estimate. Defaults to 4096 if absent. */
  estimatedMaxOutputTokens?: number;
  /** Credits mode requires every RouteShift-funded attempt to be priced before dispatch. */
  requireKnownPricing?: boolean;
  /** Resolve DB-backed/static pricing under the caller's billing policy. */
  pricingResolver?: (provider: string, model: string) => Promise<ModelPricing | null>;
  /** Effective dispatchable chat catalog used for target context/quarantine checks. */
  effectiveModels?: readonly EffectiveCatalogDefinition[];
}

export interface CascadeReservationProjection {
  /** Raw provider microcents; plugin cost and plan markup are applied by billing. */
  costMicrocents: number;
  /** A potentially dispatchable target lacked a price, so credits must refuse. */
  missingPricing?: FallbackEntry;
}

/**
 * Conservative credits reservation for a quality cascade.
 *
 * This deliberately projects the reachable SET rather than the first N chain
 * positions: duplicate, context-window, circuit, and key/configuration skips
 * do not consume retry capacity, so a later target can still be dispatched.
 * A max-cost ceiling gates fallbacks only; the primary is already unavoidable.
 */
export async function projectQualityCascadeReservation(
  primary: FallbackEntry,
  chain: FallbackEntry[],
  canonical: CanonicalRequest,
  budget: RetryBudget,
): Promise<CascadeReservationProjection> {
  const estimatedInputTokens = budget.estimatedInputTokens ?? estimateCanonicalInputTokens(canonical);
  const estimatedMaxOutputTokens = budget.estimatedMaxOutputTokens ?? 4096;
  const primaryCost = await estimateAttemptCostForBudget(
    primary.provider, primary.model, estimatedInputTokens, estimatedMaxOutputTokens, budget.pricingResolver,
  );
  if (primaryCost === null) return { costMicrocents: 0, missingPricing: primary };

  if (budget.maxRetries === 0) return { costMicrocents: primaryCost };

  const seen = new Set([`${primary.provider}:${primary.model}`]);
  const contextTokens = estimateCanonicalInputTokens(canonical);
  const fallbackCosts: number[] = [];
  for (const candidate of chain) {
    const key = `${candidate.provider}:${candidate.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const eligibility = assessDispatchTarget(candidate.provider, candidate.model, budget.effectiveModels);
    if (!eligibility.ok) continue;
    const context = contextWindowForDispatchTarget(candidate.provider, candidate.model, budget.effectiveModels);
    if (context !== null && contextTokens > context) continue;
    // Circuit state is transient: it can close between admission and dispatch,
    // so excluding it here would under-reserve a later paid attempt.
    if (!getProvider(candidate.provider)) continue;

    const candidateCost = await estimateAttemptCostForBudget(
      candidate.provider, candidate.model, estimatedInputTokens, estimatedMaxOutputTokens, budget.pricingResolver,
    );
    // No fallback can start below the primary spend when it dispatches. If the
    // primary is skipped (key/circuit), this only over-reserves; it never
    // under-reserves a later dispatchable candidate.
    if (budget.maxCostMicrocents !== undefined && primaryCost + (candidateCost ?? 0) > budget.maxCostMicrocents) continue;
    if (candidateCost === null) return { costMicrocents: primaryCost, missingPricing: candidate };
    fallbackCosts.push(candidateCost);
  }
  return { costMicrocents: primaryCost + maximumExecutableFallbackCost(fallbackCosts, primaryCost, budget) };
}

/** Maximum raw fallback spend over the bounded retry path, not every option. */
function maximumExecutableFallbackCost(costs: number[], primaryCost: number, budget: RetryBudget): number {
  const maxRetries = Math.min(costs.length, budget.maxRetries);
  const capacity = budget.maxCostMicrocents === undefined
    ? Infinity
    : Math.max(0, budget.maxCostMicrocents - primaryCost);
  // Conservative O(n log n) bound: runtime can execute at most maxRetries
  // fallbacks. Capping the largest possible total by the ceiling may hold more
  // than one concrete ordered path, but can never under-reserve one.
  const largest = costs.filter((cost) => cost > 0).sort((a, b) => b - a)
    .slice(0, maxRetries).reduce((sum, cost) => sum + cost, 0);
  return Math.min(largest, capacity);
}

/**
 * Estimates cost in microcents for one (provider, model) attempt. Used by
 * the budget guard. Returns null if the model has no pricing data; callers
 * with a max-cost ceiling must treat that as an explicit skip.
 */
export function estimateAttemptCostMicrocents(
  provider: string,
  model: string,
  estimatedInputTokens: number,
  estimatedMaxOutputTokens: number,
): number | null {
  const pricing = getModelPricing(provider, model);
  if (!pricing) return null;
  return estimateCostFromPricing(pricing, estimatedInputTokens, estimatedMaxOutputTokens);
}

function estimateCostFromPricing(
  pricing: ModelPricing,
  estimatedInputTokens: number,
  estimatedMaxOutputTokens: number,
): number {
  return calculateCostMicrocents(
    {
      input_tokens: estimatedInputTokens,
      output_tokens: estimatedMaxOutputTokens,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    },
    pricing,
  ).total;
}

export async function estimateAttemptCostForBudget(
  provider: string,
  model: string,
  estimatedInputTokens: number,
  estimatedMaxOutputTokens: number,
  resolver?: RetryBudget['pricingResolver'],
): Promise<number | null> {
  if (!resolver) {
    return estimateAttemptCostMicrocents(provider, model, estimatedInputTokens, estimatedMaxOutputTokens);
  }
  try {
    const pricing = await resolver(provider, model);
    return pricing ? estimateCostFromPricing(pricing, estimatedInputTokens, estimatedMaxOutputTokens) : null;
  } catch {
    // Pricing uncertainty is never permission to spend a platform key.
    return null;
  }
}

type FallbackProviderConfig = ProviderKeyConfig | string;

export async function executeFallbackChain(
  chain: FallbackEntry[],
  canonical: CanonicalRequest,
  getProviderConfig: (provider: string) => Promise<FallbackProviderConfig | undefined> | FallbackProviderConfig | undefined,
  primaryError: FallbackAttempt,
  budget?: RetryBudget,
): Promise<FallbackResult> {
  const attempts = [primaryError];
  const tried = new Set<string>();
  tried.add(`${primaryError.provider}:${primaryError.model}`);

  // Estimate from the post-plugin canonical payload, including bounded native
  // PDFs. A raw short URL must never let a later fallback bypass its context
  // window or max-cost guard after the parser expands it to text.
  const estimatedTokens = estimateCanonicalInputTokens(canonical);

  // LAY-321: budget bookkeeping. retriesUsed is the count of fallbacks
  // we've actually dispatched (not the count of chain entries we walked —
  // skipped-for-context entries don't burn budget).
  const maxRetries = budget?.maxRetries ?? Infinity;
  const hasMaxCost = budget?.maxCostMicrocents !== undefined;
  const maxCost = budget?.maxCostMicrocents ?? Infinity;
  const estInTokens = budget?.estimatedInputTokens ?? estimatedTokens;
  const estOutTokens = budget?.estimatedMaxOutputTokens ?? 4096;
  let retriesUsed = 0;
  const primaryCost = await estimateAttemptCostForBudget(
    primaryError.provider,
    primaryError.model,
    estInTokens,
    estOutTokens,
    budget?.pricingResolver,
  );
  // A max-cost ceiling covers the entire request, including an already
  // dispatched primary. If its price cannot be determined, dispatching a
  // fallback would turn the caller's ceiling into an unverifiable lower bound.
  if (hasMaxCost && primaryCost === null) {
    attempts.push({
      provider: primaryError.provider,
      model: primaryError.model,
      error: 'Retry budget exhausted (primary_unknown_pricing)',
    });
    return { ok: false, attempts };
  }
  let cumulativeCostMicrocents = primaryCost ?? 0;

  for (const entry of chain) {
    const key = `${entry.provider}:${entry.model}`;
    if (tried.has(key)) continue;
    tried.add(key);

    const eligibility = assessDispatchTarget(entry.provider, entry.model, budget?.effectiveModels);
    if (!eligibility.ok) {
      attempts.push({ provider: entry.provider, model: entry.model, error: eligibility.reason });
      continue;
    }

    // Skip fallback if its effective catalog context window is too small.
    const targetContext = contextWindowForDispatchTarget(
      entry.provider,
      entry.model,
      budget?.effectiveModels,
    );
    if (targetContext !== null && estimatedTokens > targetContext) {
      attempts.push({ provider: entry.provider, model: entry.model, error: 'Context window too small' });
      continue;
    }

    // LAY-321: stop before the next dispatch if either cap is exhausted.
    // The "exhausted" attempts entry lets the caller see why we stopped.
    if (retriesUsed >= maxRetries) {
      attempts.push({ provider: entry.provider, model: entry.model, error: 'Retry budget exhausted (max_retries)' });
      break;
    }
    const attemptCost = await estimateAttemptCostForBudget(
      entry.provider,
      entry.model,
      estInTokens,
      estOutTokens,
      budget?.pricingResolver,
    );
    if (budget?.requireKnownPricing && attemptCost === null) {
      attempts.push({ provider: entry.provider, model: entry.model, error: 'Missing model pricing' });
      continue;
    }
    if (hasMaxCost && attemptCost === null) {
      attempts.push({ provider: entry.provider, model: entry.model, error: 'Retry budget exhausted (unknown_pricing)' });
      continue;
    }
    // RSH-55: an unknown-priced attempt (attemptCost null) contributes 0 to the
    // running total. This only reaches here when hasMaxCost is false (the
    // hasMaxCost+null case is skipped above), and cumulativeCostMicrocents is
    // only consulted against maxCost (Infinity when hasMaxCost is false) — so
    // the under-count is never observed. We deliberately do NOT fabricate an
    // estimate for unpriced models (that would invent cost data).
    const projected = cumulativeCostMicrocents + (attemptCost ?? 0);
    if (projected > maxCost) {
      attempts.push({ provider: entry.provider, model: entry.model, error: 'Retry budget exhausted (max_cost_microcents)' });
      break;
    }

    // Skip targets whose circuit is already open — the same breaker (keyed by
    // provider:model) the primary path consults. An open circuit means this
    // target is failing for others too, so don't pay its timeout again. This
    // is a pre-dispatch skip and does not consume a retry slot.
    if (circuitBreaker.isOpen(entry.provider, entry.model)) {
      attempts.push({ provider: entry.provider, model: entry.model, error: 'Circuit breaker open' });
      continue;
    }

    const provider = getProvider(entry.provider);
    if (!provider) {
      attempts.push({ provider: entry.provider, model: entry.model, error: 'Unknown provider' });
      continue;
    }

    let config: ProviderKeyConfig | undefined;
    try {
      const resolved = await getProviderConfig(entry.provider);
      config = typeof resolved === 'string'
        ? { key: resolved, metadata: {} }
        : resolved ?? undefined;
    } catch (err) {
      // resolveUpstreamConfig can throw ProviderKeyDecryptError. A single
      // bad key shouldn't abort the whole chain — record and try the next
      // entry.
      attempts.push({ provider: entry.provider, model: entry.model, error: String(err) });
      continue;
    }
    if (!config) {
      attempts.push({ provider: entry.provider, model: entry.model, error: 'No provider key configured' });
      continue;
    }

    // buildRequest can throw with actionable messages (e.g. Bedrock with
    // stream:true, Azure missing resource_name). Treat as this fallback
    // entry failing — record and try the next entry rather than aborting
    // the whole chain.
    let fallbackReq: { url: string; method: string; headers: Record<string, string>; body: string };
    try {
      fallbackReq = provider.buildRequest({ ...canonical, model: entry.model }, config.key, config.metadata);
    } catch (err) {
      attempts.push({ provider: entry.provider, model: entry.model, error: String(err) });
      continue;
    }

    try {
      // We're committed to dispatching — count it against the budget now,
      // before the network call, so a fetch that throws still consumed a
      // retry slot.
      retriesUsed += 1;
      cumulativeCostMicrocents = projected;

      const res = await fetch(fallbackReq.url, {
        method: fallbackReq.method,
        headers: fallbackReq.headers,
        body: fallbackReq.body,
      });

      if (res.ok) {
        circuitBreaker.recordSuccess(entry.provider, entry.model);
        return {
          ok: true,
          response: res,
          provider,
          providerId: entry.provider,
          model: entry.model,
          attempts,
          aggregateActualCostKnown: attempts.every((attempt) => attempt.actual_cost_known !== false),
          // Failed predecessor attempts expose no trustworthy usage/cost. Keep
          // their numeric totals at zero but pair them with known=false above.
          aggregateActualCostMicrocents: 0,
          aggregateInputTokens: 0,
          aggregateOutputTokens: 0,
        };
      }

      // Mirror the primary path: only retryable failures (5xx/429) feed the
      // breaker; a 4xx is a client/request fault, not a provider outage, and
      // must not trip the circuit for an otherwise-healthy target.
      if (res.status >= 500 || res.status === 429) {
        circuitBreaker.recordFailure(entry.provider, entry.model);
      }
      // A 5xx may follow a provider-side accepted, billable request. Preserve
      // the numeric zero as a lower bound, not a claim of exact zero spend.
      // 429 and non-retryable 4xx failures remain exact known-zero attempts.
      attempts.push({
        provider: entry.provider,
        model: entry.model,
        error: `HTTP ${res.status}`,
        actual_cost_known: res.status < 500,
      });
    } catch (err) {
      circuitBreaker.recordFailure(entry.provider, entry.model);
      attempts.push({ provider: entry.provider, model: entry.model, error: String(err), actual_cost_known: false });
    }
  }

  return { ok: false, attempts };
}

export function estimateCanonicalInputTokens(canonical: CanonicalRequest): number {
  return canonical.messages.reduce((sum, message) => sum + estimateContentTokens(message.content), 0)
    + estimateSystemPromptTokens(canonical.system_prompt);
}

function estimateSystemPromptTokens(systemPrompt: CanonicalRequest['system_prompt']): number {
  if (typeof systemPrompt === 'string') return Math.ceil(systemPrompt.length / 4);
  return Array.isArray(systemPrompt) ? Math.ceil(JSON.stringify(systemPrompt).length / 4) : 0;
}

function estimateContentTokens(content: CanonicalRequest['messages'][number]['content']): number {
  if (typeof content === 'string') return Math.ceil(content.length / 4);
  return content.reduce((sum, part) => {
    if (part.type === 'text') return sum + Math.ceil((part.text ?? '').length / 4);
    if (part.type === 'pdf') return sum + Math.ceil(part.pdf.data.length / 4);
    return sum;
  }, 0);
}
