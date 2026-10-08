/**
 * RSH-136 — rolling quality derank from RSH-72 verifyResponse verdicts.
 *
 * The auto-router scores providers on price, context and latency — never on
 * output quality. This module turns persisted cascade verdicts (verified vs
 * quality_rejected per provider:model) into a bounded derank factor that the
 * router applies as a price-equivalent penalty.
 *
 * CONTRACT (ticket RSH-136 + no-silent-routing invariant):
 * - DERANKS, NEVER BLOCKS: the factor is in [0.3, 1.0] — a deranked model is
 *   penalized (up to 3.33x price-equivalent) but remains a legal candidate
 *   and stays in the fallback chain.
 * - NEVER SILENTLY REROUTES: opt-in per team (`quality_derank` on
 *   team_auto_route_settings, default FALSE — no on-by-default posture); the
 *   router records which verdicts moved a provider in
 *   AutoRouteMetadata.quality_derank.
 * - INSUFFICIENT DATA IS NOT A VERDICT: below QUALITY_DERANK_MIN_SAMPLES the
 *   factor is exactly 1.0, regardless of observed pass rate.
 * - PASS RATE FROM VERDICTS ONLY: verified and quality_rejected outcomes
 *   count; terminal (refusal/safety) outcomes are policy, not quality, and
 *   are excluded by the aggregation query.
 */

export interface QualityVerdictSignal {
  provider: string;
  model: string;
  /** Verified (passed the gate) attempts in the window. */
  verified: number;
  /** Quality-rejected attempts in the window. */
  rejected: number;
}

/** Minimum verdicts before a pass rate is meaningful; below this: no signal. */
export const QUALITY_DERANK_MIN_SAMPLES = 10;

/** Pass rate at or above which a provider:model is not deranked. */
export const QUALITY_DERANK_PASS_THRESHOLD = 0.9;

/**
 * Strongest penalty: the factor never goes below this (never zero, never a
 * block — a deranked model costs up to 1/0.3 ≈ 3.33x price-equivalent).
 */
export const QUALITY_DERANK_FACTOR_FLOOR = 0.3;

/**
 * Rolling-window length for the aggregation query (ms). Verdicts older than
 * this do not move the score.
 */
export const QUALITY_DERANK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Pure derank factor from raw verdict counts.
 *
 *   samples < MIN            → 1.0  (insufficient data is not a verdict)
 *   pass_rate >= THRESHOLD   → 1.0  (healthy)
 *   pass_rate < THRESHOLD    → linear 1.0 → FLOOR as the pass rate falls
 *                              from THRESHOLD to THRESHOLD - 0.4 (= 0.5);
 *                              below that the floor holds (bounded, never 0)
 */
export function qualityDerankFactor(verified: number, rejected: number): number {
  const samples = verified + rejected;
  if (samples < QUALITY_DERANK_MIN_SAMPLES) return 1;
  const passRate = verified / samples;
  if (passRate >= QUALITY_DERANK_PASS_THRESHOLD) return 1;
  const band = 0.4; // pass-rate span over which the penalty ramps to the floor
  const t = Math.min(1, Math.max(0, (QUALITY_DERANK_PASS_THRESHOLD - passRate) / band));
  return 1 - (1 - QUALITY_DERANK_FACTOR_FLOOR) * t;
}
