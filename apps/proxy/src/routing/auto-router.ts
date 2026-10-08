// apps/proxy/src/routing/auto-router.ts
// OpenRouter-style auto-routing: intelligently pick the best model + fallback chain
// when no explicit routing rule matched.

import {
  MODEL_REGISTRY,
  getModelPricing,
  isValidCapabilityIndices,
  qualityDerankFactor,
  selectModelPricing,
  type CapabilityAxis,
  type CapabilityIndices,
  type EffectiveCatalogDefinition,
  type QualityVerdictSignal,
} from '@routeshift/shared';
import type { AutoRouteMetadata, RequestContext, RoutingDecision } from '@routeshift/shared';

export interface AutoRouteSettings {
  enabled: boolean;
  strategy: 'cheapest' | 'fastest' | 'balanced';
  max_fallbacks: number;
  /** RSH-136: opt-in rolling quality derank (default false — never on by
   *  default). The ROUTER consumes the fetched signals via AutoRouteOptions;
   *  this flag gates whether the handler fetches them. */
  quality_derank?: boolean;
}

interface ScoredModel {
  provider: string;
  model: string;
  context_window: number;
  input_price: number;
  output_price: number;
  score: number;
  latency_p95_ms?: number;
  latency_sample_count?: number;
}

export interface AutoRouteProviderSignal {
  provider: string;
  credential_available: boolean;
  unavailable_reason?: string;
  latency_p95_ms?: number;
  latency_sample_count?: number;
}
export interface AutoRouteOptions {
  /**
   * Effective dispatchable chat definitions. The handler injects the shared
   * catalog subset; the registry fallback preserves isolated unit-test and
   * legacy callers that supply their own MODEL_REGISTRY.
   */
  effectiveModels?: readonly EffectiveCatalogDefinition[];
  providerSignals?: AutoRouteProviderSignal[];
  /** RSH-136: rolling quality-verdict aggregates per provider:model (opt-in
   * via settings.quality_derank; the handler fetches them). Absent = no
   * deranking. */
  qualitySignals?: QualityVerdictSignal[];
}

/**
 * RSH-143: which capability axis a request exercises. Tools are agentic
 * workloads, code blocks are coding workloads, everything else falls back to
 * general intelligence. Structured output is schema-following, which is
 * closer to tool-use than to code editing — documented decision, pinned by
 * test. Deterministic and replayable.
 */
export function taskAxisFor(ctx: RequestContext): CapabilityAxis {
  if (ctx.has_tools || ctx.has_structured_output) return 'agentic';
  if (ctx.has_code_blocks) return 'coding';
  return 'intelligence';
}

/**
 * Capability bonus for the chosen axis: index/50 clamped to [1, 2] — 100 →
 * 2.0 (strong task fit), 50 → 1.0 (neutral), below 50 → 1.0 (no bonus).
 *
 * Deliberate design decisions, pinned by tests:
 * - BONUS ONLY. Absence (no indices) and verified-low are both 1.0: during
 *   partial curation, measuring a model can never hurt it relative to
 *   un-measured peers (no perverse incentive against honest data), and a low
 *   index is never a penalty — penalizing is deranking, RSH-136's job.
 * - Feeds the PRICE TERM as a divisor (effective price = price / factor),
 *   NOT a score multiplier: under the log-scored 'balanced' strategy a plain
 *   multiplier would exponentiate the price ratio and let a 1.9 factor
 *   overturn a 10x price gap (verified arithmetic, Opus round 1). With the
 *   divisor form each model's effective price is bounded to [0.3, 2]x its
 *   list price (capability [1,2] x derank [0.3,1]); the cross-candidate
 *   swing is therefore at most ~6.67x, all else equal — a model more than
 *   ~6.67x cheaper (or a fully-bonused peer against a deranked one within
 *   the band) wins on price.
 */
export function capabilityFactor(axis: CapabilityAxis, indices: CapabilityIndices | undefined): number {
  if (!indices || !isValidCapabilityIndices(indices)) return 1;
  const value = indices[axis];
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1; // partial set: missing axis = no signal
  return Math.min(2, Math.max(1, value / 50));
}

function throughputHeuristicScore(
  inputPrice: number,
  outputPrice: number,
  contextWindow: number,
): number {
  // Larger context window + lower price is a throughput/value heuristic, not
  // measured end-user latency. Used only when no latency signal is warm enough.
  const totalPrice = inputPrice + outputPrice;
  return Math.log(contextWindow + 1) * (1 / (totalPrice + 0.01));
}

/** Exported for the monotonicity property pin; the scoring contract. */
export function scoreModel(
  inputPrice: number,
  outputPrice: number,
  contextWindow: number,
  strategy: AutoRouteSettings['strategy'],
  isComplex: boolean,
  intelligenceTier: 1 | 2 | 3,
  priceDivisor: number,
): number {
  // RSH-143 + RSH-136: capability (bonus, [1,2]) and quality-derank
  // (penalty, [0.3,1]) combine into ONE price-equivalent divisor, NOT a
  // score multiplier. Multiplying a log-scaled base would exponentiate the
  // price ratio (1.9x factor overturning a 10x gap — verified); dividing the
  // price keeps the effect bounded (0.3x..2x price-equivalence) in every
  // strategy, so a >2x-cheaper model always wins, all else equal. The tier
  // penalty then applies to the divisor-adjusted base: capability/derank are
  // the fit signals, the tier penalty is the complex-task gate.
  let baseScore = 0;

  switch (strategy) {
    case 'cheapest': {
      // Lower price = higher score.  Add small constant to avoid div-by-zero.
      const totalPrice = (inputPrice + outputPrice) / priceDivisor;
      baseScore = 1 / (totalPrice + 0.001);
      break;
    }
    case 'fastest':
      baseScore = throughputHeuristicScore(inputPrice / priceDivisor, outputPrice / priceDivisor, contextWindow);
      break;
    case 'balanced':
    default: {
      // Favour models that are cheap relative to their context window.
      const totalPrice = (inputPrice + outputPrice) / priceDivisor;
      const value = contextWindow / (totalPrice + 0.01);
      baseScore = Math.log(value + 1);
      break;
    }
  }

  if (isComplex) {
    if (intelligenceTier === 1) {
      baseScore *= 0.0001; // Massive penalty for Lite/Nano models on complex tasks
    } else if (intelligenceTier === 2) {
      baseScore *= 0.1; // Moderate penalty for Mid-tier models
    }
  }

  return baseScore;
}

function providerSignalMap(signals: AutoRouteProviderSignal[] | undefined): Map<string, AutoRouteProviderSignal> | null {
  if (!signals) return null;
  return new Map(signals.map((signal) => [signal.provider, signal]));
}

function hasMeasuredLatency(candidate: ScoredModel): boolean {
  return candidate.latency_p95_ms !== undefined && Number.isFinite(candidate.latency_p95_ms);
}

/**
 * Whether the weighted SCORE actually decides candidate order. Under
 * 'fastest' with measured latency, measured-vs-measured pairs compare by p95
 * and measured always beats unmeasured — but every pair of UNMEASURED
 * candidates falls through to the score, so with >=2 unmeasured candidates
 * the capability-weighted score still orders part of the decision (incl. the
 * fallback chain) and the axis must be recorded (opus round 2).
 */
function scoreDecidesRouting(strategy: AutoRouteSettings['strategy'], candidates: ScoredModel[]): boolean {
  if (strategy !== 'fastest') return true;
  const unmeasured = candidates.filter((c) => !hasMeasuredLatency(c)).length;
  return unmeasured >= 2;
}

/**
 * RSH-136 explainability precision: under 'fastest' with partial latency, a
 * MEASURED candidate is ordered by latency presence, never by its (deranked)
 * score — reporting its derank would claim an influence it did not have.
 * Only score-ordered (unmeasured) candidates' deranks are reported; outside
 * 'fastest' every candidate is score-ordered.
 */
function scoreOrderedDeranks(
  strategy: AutoRouteSettings['strategy'],
  candidates: ScoredModel[],
  deranked: Array<{ provider: string; model: string; pass_rate: number; sample_count: number }>,
): Array<{ provider: string; model: string; pass_rate: number; sample_count: number }> {
  if (strategy !== 'fastest') return deranked;
  const measured = new Set(
    candidates.filter(hasMeasuredLatency).map((c) => `${c.provider}:${c.model}`),
  );
  return deranked.filter((d) => !measured.has(`${d.provider}:${d.model}`));
}

function latencyModeFor(candidates: ScoredModel[], strategy: AutoRouteSettings['strategy']): AutoRouteMetadata['latency_mode'] {
  if (strategy !== 'fastest') return 'not_applicable';
  const measured = candidates.filter(hasMeasuredLatency).length;
  if (measured === 0) return 'throughput_heuristic';
  if (measured === candidates.length) return 'latency_measured';
  return 'latency_measured_partial';
}

function compareCandidates(
  a: ScoredModel,
  b: ScoredModel,
  strategy: AutoRouteSettings['strategy'],
  latencyMode: AutoRouteMetadata['latency_mode'],
): number {
  if (strategy === 'fastest' && latencyMode !== 'throughput_heuristic') {
    const aMeasured = hasMeasuredLatency(a);
    const bMeasured = hasMeasuredLatency(b);
    if (aMeasured && bMeasured) {
      const latencyDelta = a.latency_p95_ms! - b.latency_p95_ms!;
      if (latencyDelta !== 0) return latencyDelta;
      return (a.input_price + a.output_price) - (b.input_price + b.output_price);
    }
    if (aMeasured !== bMeasured) return aMeasured ? -1 : 1;
  }
  return b.score - a.score;
}

export function buildAutoRouteDecision(
  ctx: RequestContext,
  settings: AutoRouteSettings,
  options: AutoRouteOptions = {},
): RoutingDecision {
  const signals = providerSignalMap(options.providerSignals);
  const providerSkips = new Map<string, { provider: string; reason: string }>();

  // If disabled, pass-through unchanged.
  if (!settings.enabled) {
    return {
      provider: ctx.provider_requested,
      model: ctx.model_requested,
      rule_id: null,
      tags: [],
      fallback_chain: [],
      is_default: true,
      max_output_tokens: ctx.max_output_tokens,
      auto_route: { provider_skips: [], latency_mode: 'not_applicable' },
    };
  }

  // Determine request complexity heuristics
  const isComplex = Boolean(
    ctx.has_tools ||
    ctx.has_structured_output ||
    ctx.has_code_blocks ||
    (ctx.estimated_input_tokens && ctx.estimated_input_tokens > 10000) ||
    ctx.reasoning_effort === 'high'
  );

  // RSH-143: the task axis drives capability weighting; recorded in metadata
  // only when at least one candidate actually carries sourced indices.
  const capabilityAxis = taskAxisFor(ctx);
  let capabilityApplied = false;
  // RSH-136: which candidates were deranked by verdicts (explainability —
  // an operator must see which verdicts moved a provider).
  const derankedCandidates: Array<{ provider: string; model: string; pass_rate: number; sample_count: number }> = [];
  // RSH-136: derank is opt-in at BOTH layers — the handler only fetches
  // signals when the setting is true, and the router refuses to apply
  // signals it is handed unless the setting says so (defense in depth: a
  // future caller cannot accidentally derank an opted-out team).
  const qualitySignals = settings.quality_derank === true && options.qualitySignals
    ? new Map(options.qualitySignals.map((s) => [`${s.provider}:${s.model}`, s]))
    : null;

  // Build candidates from the shared effective dispatchable chat catalog.
  const candidates: ScoredModel[] = [];
  const effectiveModels = options.effectiveModels ?? MODEL_REGISTRY;
  for (const m of effectiveModels) {
    if ('kind' in m) continue;
    if (m.auto_route === false) continue;

    // RSH-54: fail closed when no provider signals are available. Without
    // signal data we cannot confirm RouteShift holds a credential for any
    // provider, so treat every candidate as uncredentialed rather than routing
    // to a provider we may have no key for (which would 503 at dispatch).
    // Normal operation always passes signals, so this only guards the unsafe
    // no-signals default — auto-route then passes through to the requested model.
    if (!signals) {
      providerSkips.set(m.provider, {
        provider: m.provider,
        reason: 'no_auto_route_provider_signals',
      });
      continue;
    }
    const signal = signals.get(m.provider);
    if (!signal) {
      providerSkips.set(m.provider, {
        provider: m.provider,
        reason: 'missing_auto_route_provider_signal',
      });
      continue;
    }
    if (!signal.credential_available) {
      providerSkips.set(m.provider, {
        provider: m.provider,
        reason: signal.unavailable_reason ?? 'provider_not_credential_available',
      });
      continue;
    }

    const pricing = getModelPricing(m.provider, m.canonical_name);
    const rates = pricing
      ? selectModelPricing(pricing, ctx.estimated_input_tokens ?? 0)
      : null;
    const inputPrice = rates?.input_per_million ?? 9999;
    const outputPrice = rates?.output_per_million ?? 9999;

    // Skip models that can't fit the estimated input.
    if (ctx.estimated_input_tokens && m.context_window < ctx.estimated_input_tokens) {
      continue;
    }

    const capability = capabilityFactor(capabilityAxis, m.capability_indices);
    // Explainability: record the axis only when some candidate actually had
    // a VALID index ON that axis — an invalid set or a partial set missing
    // the axis contributes factor 1.0 (no weighting happened); a valid index
    // of exactly 50 also yields 1.0 but the axis WAS evaluated, so it counts.
    if (m.capability_indices && isValidCapabilityIndices(m.capability_indices)
      && typeof m.capability_indices[capabilityAxis] === 'number') {
      capabilityApplied = true;
    }

    // RSH-136: rolling quality derank (opt-in via settings.quality_derank —
    // the handler only supplies signals then). Insufficient data is not a
    // verdict (factor 1.0); a deranked model stays a legal candidate with a
    // bounded price penalty — never a block, never silent.
    const qualitySignal = qualitySignals?.get(`${m.provider}:${m.canonical_name}`);
    const derank = qualitySignal ? qualityDerankFactor(qualitySignal.verified, qualitySignal.rejected) : 1;
    if (derank < 1 && qualitySignal) {
      derankedCandidates.push({
        provider: m.provider,
        model: m.canonical_name,
        pass_rate: qualitySignal.verified / (qualitySignal.verified + qualitySignal.rejected),
        sample_count: qualitySignal.verified + qualitySignal.rejected,
      });
    }

    candidates.push({
      provider: m.provider,
      model: m.canonical_name,
      context_window: m.context_window,
      input_price: inputPrice,
      output_price: outputPrice,
      score: scoreModel(inputPrice, outputPrice, m.context_window, settings.strategy, isComplex, m.intelligence_tier ?? 2, capability * derank),
      latency_p95_ms: signal?.latency_p95_ms,
      latency_sample_count: signal?.latency_sample_count,
    });
  }

  // RSH-136 explainability: report only the deranks that could actually move
  // the decision (score-ordered candidates under fastest+partial); if the
  // filtered set is empty, emit NO quality_derank key at all — an empty
  // array would claim a derank pass happened when nothing was applied.
  const reportedDeranks = scoreDecidesRouting(settings.strategy, candidates)
    ? scoreOrderedDeranks(settings.strategy, candidates, derankedCandidates)
    : [];

  const metadata: AutoRouteMetadata = {
    provider_skips: [...providerSkips.values()],
    latency_mode: latencyModeFor(candidates, settings.strategy),
    ...(capabilityApplied && scoreDecidesRouting(settings.strategy, candidates) ? { capability_axis: capabilityAxis } : {}),
    ...(reportedDeranks.length > 0 ? { quality_derank: reportedDeranks } : {}),
  };

  if (candidates.length === 0) {
    // Nothing viable — pass through and let upstream fail gracefully.
    return {
      provider: ctx.provider_requested,
      model: ctx.model_requested,
      rule_id: null,
      tags: [],
      fallback_chain: [],
      is_default: true,
      max_output_tokens: ctx.max_output_tokens,
      auto_route: metadata,
      reasoning_effort: ctx.reasoning_effort,
      thinking_budget_tokens: ctx.thinking_budget_tokens,
    };
  }

  candidates.sort((a, b) => compareCandidates(a, b, settings.strategy, metadata.latency_mode));

  const primary = candidates[0];
  const fallback_chain = candidates
    .slice(1, 1 + Math.max(0, settings.max_fallbacks))
    .map((c) => ({ provider: c.provider, model: c.model }));

  return {
    provider: primary.provider,
    model: primary.model,
    rule_id: 'auto',
    tags: ['auto-routed', `auto-route:${metadata.latency_mode}`],
    fallback_chain,
    is_default: false,
    max_output_tokens: ctx.max_output_tokens,
    auto_route: metadata,
    reasoning_effort: ctx.reasoning_effort,
    thinking_budget_tokens: ctx.thinking_budget_tokens,
  };
}
