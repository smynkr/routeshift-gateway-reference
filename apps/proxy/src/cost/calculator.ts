// apps/proxy/src/cost/calculator.ts
//
// Canonical baseline for `savings_microcents` (LAY-345 audit, 2026-04-29):
//
//   savings = original_cost - actual_cost
//
// where:
//   - original_cost  = cost of `modelRequested` priced by `providerRequested`,
//                      using the upstream's actual `usage`. This is "what you
//                      would have paid for the model you named."
//   - actual_cost    = cost of `modelResolved` priced by `providerResolved`,
//                      using the same `usage`. This is "what you actually
//                      paid for the model we used."
//
// This is an AUTO-ROUTER WIN metric. Cache savings, fallback resilience, and
// alias-driven routing are NOT first-class contributors:
//   - Cache hit with same model: original == actual → savings = 0.
//   - Fallback to a more expensive model: savings is negative; the Stripe
//     meter floors at 0 so the customer is never billed for negative
//     savings. Dashboards now match (LAY-345 fix).
//   - Aliases (`model_aliases`) pre-rewrite `rawBody.model` in proxy-handler
//     before this function is called, so the baseline reflects the alias's
//     CANONICAL TARGET, not the alias the customer typed.
//
// If you change the semantics, update LAY-345 and audit downstream:
//   - apps/proxy/src/billing/savings-reporter.ts (Stripe meter)
//   - apps/dashboard/app/api/billing/status/route.ts (period_savings_cents)
//   - apps/dashboard/app/api/metrics/{savings,overview,analytics}/route.ts
import type { TokenUsage } from '@routeshift/shared';
import { getModelPricing, selectModelPricing, calculateCostMicrocents } from '@routeshift/shared';
import { getDbPricing } from './pricing-db.js';
import { captureException } from '../observability/sentry.js';


// One Sentry alert per unpriced provider:model pair per process — a hot
// unpriced model would otherwise emit an event per request.
const alertedMissingPricing = new Set<string>();

export interface RequestCost {
  original_cost_microcents: number;
  actual_cost_microcents: number;
  /** False means the numeric value is a lower bound, not a known zero. */
  actual_cost_known: boolean;
  savings_microcents: number;
  /** Output-rate cost of provider-reported reasoning tokens; absent without telemetry. */
  reasoning_cost_microcents?: number | null;
}

/**
 * Internal-safe cost detail: exposes only calculated totals and whether each
 * total is exact. It deliberately does not return pricing records, sources, or
 * provider configuration, which could leak billing metadata to callers.
 */
export interface DetailedRequestCost extends RequestCost {
  /** False means original_cost_microcents is a lower bound, not a free request. */
  original_cost_known: boolean;
}

export async function computeRequestCostDetailed(
  modelRequested: string,
  providerRequested: string,
  modelResolved: string,
  providerResolved: string,
  usage: TokenUsage,
): Promise<DetailedRequestCost> {
  const originalPricing =
    (await getDbPricing(providerRequested, modelRequested)) ??
    getModelPricing(providerRequested, modelRequested);
  const actualPricing =
    (await getDbPricing(providerResolved, modelResolved)) ??
    getModelPricing(providerResolved, modelResolved);

  const originalCost = originalPricing
    ? calculateCostMicrocents(usage, originalPricing).total
    : 0;
  const actualCost = actualPricing
    ? calculateCostMicrocents(usage, actualPricing).total
    : 0;
  const reasoningCostMicrocents = usage.reasoning_tokens === undefined
    ? undefined
    : actualPricing
      ? Math.round(
        usage.reasoning_tokens
          * selectModelPricing(
            actualPricing,
            usage.input_tokens + (usage.cache_read_tokens ?? 0) + (usage.cache_write_tokens ?? 0),
          ).output_per_million
          * 100,
      )
      : null;


  // Only claim a savings delta when BOTH sides are priced. If a model has no
  // pricing, its cost defaults to 0, which would otherwise manufacture a
  // phantom positive saving (resolved unpriced -> savings = full original) that
  // feeds the savings-share meter, or a spurious negative (requested unpriced).
  // A missing price is "unknown", not "free" — emit 0 savings and warn so the
  // gap gets backfilled.
  const bothPriced = originalPricing !== null && actualPricing !== null;
  if (!bothPriced) {
    console.warn(
      `computeRequestCost: missing pricing (requested ${providerRequested}:${modelRequested} priced=${!!originalPricing}, ` +
        `resolved ${providerResolved}:${modelResolved} priced=${!!actualPricing}); savings forced to 0`,
    );
    // Outside credits mode nothing fails closed on a pricing gap — the request
    // is billed $0 (proxy-handler only rejects unpriced models for credits
    // teams). Alert loudly so the gap is backfilled instead of quietly giving
    // inference away.
    for (const [pricing, provider, model, side] of [
      [originalPricing, providerRequested, modelRequested, 'requested'],
      [actualPricing, providerResolved, modelResolved, 'resolved'],
    ] as const) {
      if (pricing) continue;
      const gap = `${provider}:${model}`;
      if (alertedMissingPricing.has(gap)) continue;
      alertedMissingPricing.add(gap);
      captureException(new Error(`missing_model_pricing: ${gap} bills $0 outside credits mode`), {
        level: 'error',
        tags: { component: 'cost-calculator', provider, model, pricing_side: side },
      });
    }
  }

  return {
    original_cost_microcents: originalCost,
    original_cost_known: originalPricing !== null,
    actual_cost_microcents: actualCost,
    actual_cost_known: actualPricing !== null,
    savings_microcents: bothPriced ? originalCost - actualCost : 0,
    ...(reasoningCostMicrocents !== undefined
      ? { reasoning_cost_microcents: reasoningCostMicrocents }
      : {}),
  };
}

/**
 * Backward-compatible request-cost API. New callers that need to distinguish
 * free zero-cost requests from missing original pricing should use
 * computeRequestCostDetailed instead.
 */
export async function computeRequestCost(
  modelRequested: string,
  providerRequested: string,
  modelResolved: string,
  providerResolved: string,
  usage: TokenUsage,
): Promise<RequestCost> {
  const { original_cost_known: _originalCostKnown, ...cost } = await computeRequestCostDetailed(
    modelRequested,
    providerRequested,
    modelResolved,
    providerResolved,
    usage,
  );
  return cost;
}
