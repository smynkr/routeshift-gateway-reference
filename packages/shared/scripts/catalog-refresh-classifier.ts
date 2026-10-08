import type {
  CatalogCachePolicyDecision,
  CatalogPriceDelta,
  CatalogRefreshPrevious,
  CatalogRefreshProposal,
  CatalogRefreshRecord,
  CatalogRefreshVerdict,
} from './catalog-refresh-types.js';

const MAX_SAFE_DELTA = 0.25;
const DELTA_EPSILON_FACTOR = 16;

function exceedsSafeDelta(delta: number): boolean {
  const magnitude = Math.abs(delta);
  const tolerance = Number.EPSILON * Math.max(1, magnitude, MAX_SAFE_DELTA) * DELTA_EPSILON_FACTOR;
  return magnitude - MAX_SAFE_DELTA > tolerance;
}

function appendUnique(target: string[], reason: string): void {
  if (!target.includes(reason)) target.push(reason);
}

function recordReason(record: { provider: string; model: string; reason?: string }, fallback: string): string {
  return record.reason ?? `${fallback}:${record.provider}:${record.model}`;
}

function classifyPriceDeltas(
  deltas: CatalogRefreshProposal['priceDeltas'],
  invalid: string[],
  review: string[],
): void {
  const fields: ReadonlyArray<{
    field: keyof CatalogPriceDelta;
    previous: keyof CatalogPriceDelta;
    next: keyof CatalogPriceDelta;
  }> = [
    { field: 'input', previous: 'previous_input', next: 'next_input' },
    { field: 'output', previous: 'previous_output', next: 'next_output' },
    { field: 'input_above_272k', previous: 'previous_input_above_272k', next: 'next_input_above_272k' },
    { field: 'output_above_272k', previous: 'previous_output_above_272k', next: 'next_output_above_272k' },
    { field: 'cache_read_above_272k', previous: 'previous_cache_read_above_272k', next: 'next_cache_read_above_272k' },
    { field: 'cache_write_above_272k', previous: 'previous_cache_write_above_272k', next: 'next_cache_write_above_272k' },
  ];
  for (const delta of deltas) {
    for (const { field, previous: previousField, next: nextField } of fields) {
      const previous = delta[previousField];
      const next = delta[nextField];
      const suppliedDelta = delta[field];
      if (previous === undefined && next === undefined && suppliedDelta === undefined) continue;

      if (previous !== undefined || next !== undefined) {
        if (previous === undefined || next === undefined) {
          appendUnique(review, `price_delta_missing_bound:${delta.provider}:${delta.model}:${field}`);
          continue;
        }
        if (!Number.isFinite(previous) || !Number.isFinite(next)) {
          appendUnique(invalid, `invalid_price:${delta.provider}:${delta.model}:${field}`);
          continue;
        }
        if (previous < 0 || next < 0) {
          appendUnique(invalid, `invalid_price:${delta.provider}:${delta.model}:${field}`);
          continue;
        }
        if (previous === 0 || next === 0) {
          if (previous !== next) {
            appendUnique(review, `price_zero_transition:${delta.provider}:${delta.model}:${field}`);
          }
          continue;
        }
        const ratio = Math.abs(next - previous) / previous;
        if (!Number.isFinite(ratio)) {
          appendUnique(review, `price_delta_not_finite:${delta.provider}:${delta.model}:${field}`);
        } else if (exceedsSafeDelta(ratio)) {
          appendUnique(review, `price_delta_over_25_percent:${delta.provider}:${delta.model}:${field}`);
        }
        continue;
      }

      if (!Number.isFinite(suppliedDelta)) {
        appendUnique(review, `price_delta_not_finite:${delta.provider}:${delta.model}:${field}`);
      } else if (exceedsSafeDelta(suppliedDelta)) {
        appendUnique(review, `price_delta_over_25_percent:${delta.provider}:${delta.model}:${field}`);
      }
    }
  }
}

function classifyContextDeltas(
  deltas: CatalogRefreshProposal['contextDeltas'],
  invalid: string[],
  review: string[],
): void {
  for (const delta of deltas) {
    if (!Number.isFinite(delta.previous) || !Number.isFinite(delta.next) || delta.previous <= 0 || delta.next <= 0) {
      appendUnique(invalid, `invalid_context_window:${delta.provider}:${delta.model}`);
      continue;
    }
    const ratio = Math.abs(delta.next - delta.previous) / delta.previous;
    if (!Number.isFinite(ratio)) {
      appendUnique(review, `context_delta_not_finite:${delta.provider}:${delta.model}`);
    } else if (exceedsSafeDelta(ratio)) {
      appendUnique(review, `context_delta_over_25_percent:${delta.provider}:${delta.model}`);
    }
  }
}

function previousQuarantines(previous: CatalogRefreshPrevious | undefined): readonly CatalogRefreshRecord[] {
  return previous?.quarantined ?? previous?.quarantined_records ?? [];
}

function previousCachePolicies(previous: CatalogRefreshPrevious | undefined): readonly CatalogCachePolicyDecision[] {
  return previous?.cachePolicies ?? previous?.cache_policy ?? [];
}

function sameQuarantine(
  current: CatalogRefreshRecord,
  prior: CatalogRefreshRecord,
): boolean {
  return current.provider === prior.provider
    && current.model === prior.model
    && current.reason === prior.reason
    && (prior.kind === undefined || current.kind === prior.kind);
}

function sameCachePolicy(
  current: CatalogCachePolicyDecision,
  prior: CatalogCachePolicyDecision,
): boolean {
  return current.provider === prior.provider
    && current.model === prior.model
    && current.kind === prior.kind
    && current.reason === prior.reason
    && current.per_million === prior.per_million
    && current.rule_version === prior.rule_version;
}

function isBaselineQuarantine(
  record: CatalogRefreshRecord,
  previous: CatalogRefreshPrevious | undefined,
): boolean {
  return previousQuarantines(previous).some((prior) => sameQuarantine(record, prior));
}

function isBaselineUnknownPolicy(
  decision: CatalogCachePolicyDecision,
  previous: CatalogRefreshPrevious | undefined,
): boolean {
  return decision.kind === 'unknown'
    && previousCachePolicies(previous).some((prior) => sameCachePolicy(decision, prior));
}

function isBaselineReason(reason: string, previous: CatalogRefreshPrevious | undefined): boolean {
  return previousQuarantines(previous).some((prior) => (
    (prior.reason ?? `quarantined_record:${prior.provider}:${prior.model}`) === reason
  )) || previousCachePolicies(previous).some((prior) => (
    prior.kind === 'unknown' && (prior.reason ?? `unknown_cache_write_policy:${prior.provider}:${prior.model}`) === reason
  ));
}

/** Classify a complete in-memory proposal; invalid always outranks review. */
export function classifyCatalogRefresh(
  proposal: CatalogRefreshProposal,
  previous?: CatalogRefreshPrevious,
): CatalogRefreshVerdict {
  const invalid: string[] = [];
  const review: string[] = [];

  for (const reason of proposal.invalidReasons ?? []) appendUnique(invalid, reason);
  for (const reason of proposal.reviewReasons ?? []) {
    if (!isBaselineReason(reason, previous)) appendUnique(review, reason);
  }

  for (const record of proposal.removed ?? []) {
    appendUnique(review, recordReason(record, 'model_removed'));
  }
  for (const record of proposal.quarantined ?? []) {
    if (!isBaselineQuarantine(record, previous)) {
      appendUnique(review, recordReason(record, 'quarantined_record'));
    }
  }
  for (const record of proposal.added ?? []) {
    appendUnique(review, recordReason(record, 'missing_second_source_evidence'));
  }

  classifyPriceDeltas(proposal.priceDeltas ?? [], invalid, review);
  classifyContextDeltas(proposal.contextDeltas ?? [], invalid, review);

  for (const decision of proposal.cachePolicies ?? []) {
    if (decision.kind === 'unknown' && !isBaselineUnknownPolicy(decision, previous)) {
      appendUnique(
        review,
        decision.reason ?? `unknown_cache_write_policy:${decision.provider}:${decision.model}`,
      );
    }
  }

  if (invalid.length > 0) return { kind: 'invalid', reasons: [...invalid, ...review] };
  if (review.length > 0) return { kind: 'review_required', reasons: review };
  return { kind: 'safe', reasons: [] };
}
