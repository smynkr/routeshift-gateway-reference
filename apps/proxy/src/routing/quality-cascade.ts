// apps/proxy/src/routing/quality-cascade.ts
//
// RSH-72 Phase 2 — the non-streaming per-attempt executor. `executeAttempt`
// runs ONE provider attempt end-to-end and classifies it, without sending
// client bytes, settling final billing, or writing the response cache:
//
//   build → dispatch → buffer+parse once → normalize (CanonicalResponse +
//   ProviderOutcomeSignals) → compute actual microcent cost → run the pure
//   verifier when a gate is present → return an AttemptOutcome.
//
// The cascade executor (a follow-up slice) drives the primary + authorized
// fallback chain over these outcomes, reusing fallback.ts eligibility, budget,
// and circuit accounting. A deterministic quality rejection never trips the
// circuit (transport/HTTP availability only); refusal/safety/engine_error are
// terminal and stop the chain.
import type { CanonicalRequest, CanonicalResponse, EffectiveCatalogDefinition, TokenUsage } from '@routeshift/shared';
import {
  verifyResponse,
  requestedJsonFromResponseFormat,
  hasMultiAttemptBillingAck,
  type QualityGateConfig,
  type ProviderOutcomeSignals,
  type QualityReasonCode,
} from '@routeshift/shared';
import type { LLMProvider, ProviderRequest } from '../providers/types.js';
import { circuitBreaker } from './circuit-breaker.js';
import { estimateAttemptCostForBudget, estimateCanonicalInputTokens, type RetryBudget } from './fallback.js';
import { assessDispatchTarget, contextWindowForDispatchTarget } from './dispatch-eligibility.js';
export type AttemptOutcome =
  | {
      kind: 'verified';
      provider: string;
      model: string;
      canonical: CanonicalResponse;
      signals: ProviderOutcomeSignals;
      rawBody: unknown;
      usage: TokenUsage;
      reasoningCostMicrocents?: number | null;
      actualCostMicrocents: number;
      actualCostKnown: boolean;
    }
  | {
      kind: 'quality_rejected';
      provider: string;
      model: string;
      reasonCode: QualityReasonCode;
      checkIndex: number;
      signals: ProviderOutcomeSignals;
      usage: TokenUsage;
      reasoningCostMicrocents?: number | null;
      actualCostMicrocents: number;
      actualCostKnown: boolean;
    }
  | { kind: 'retryable_http'; provider: string; model: string; status: number; actualCostKnown: boolean }
  | { kind: 'transport_error'; provider: string; model: string; reasonCode: string; actualCostKnown?: boolean }
  | { kind: 'terminal'; provider: string; model: string; reasonCode: string; usage: TokenUsage; reasoningCostMicrocents?: number | null; actualCostMicrocents: number; actualCostKnown: boolean; statusCode: number };

/** Sanitized per-attempt audit row. No prompt/response/schema/credential. */
export interface AttemptAudit {
  attempt_index: number;
  provider: string;
  model: string;
  outcome: AttemptOutcome['kind'];
  reason_code: string | null;
  check_index: number | null;
  status_code: number | null;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens?: number;
  reasoning_cost_microcents?: number;
  actual_cost_microcents: number;
  /** False means actual_cost_microcents is only a lower bound, never known zero. */
  actual_cost_known: boolean;
  latency_ms: number;
  circuit_failure: boolean;
}


export interface ExecuteAttemptInput {
  provider: LLMProvider;
  providerId: string;
  model: string;
  canonical: CanonicalRequest;
  apiKey: string;
  metadata?: Record<string, unknown>;
  /** Absent gate => a parsed 200 is verified as-is (no verification). */
  gate: QualityGateConfig | undefined;
  /** Actual attempt cost in microcents from real usage. */
  computeCost: (usage: TokenUsage) => number | AttemptCost | Promise<number | AttemptCost>;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Internal lifecycle boundary: called after request construction, immediately before fetch. */
  onDispatchStart?: () => void;
}

export interface AttemptCost {
  actualCostMicrocents: number;
  actualCostKnown: boolean;
  reasoningCostMicrocents?: number | null;
}

const EMPTY_USAGE: TokenUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

function failedSignals(providerId: string): ProviderOutcomeSignals {
  return {
    provider: providerId,
    raw_stop_reason: null,
    refusal: null,
    safety_blocked: null,
    prompt_block_reason: null,
    provider_parse_status: 'failed',
    unknown_fields_present: false,
  };
}

// Signals for a successfully parsed body from an adapter that does not implement
// the optional parseOutcomeSignals. Parse status is 'parsed' (the body parsed);
// the outcome signals are simply unknown — NOT a parse failure.
function parsedSignals(providerId: string): ProviderOutcomeSignals {
  return {
    provider: providerId,
    raw_stop_reason: null,
    refusal: null,
    safety_blocked: null,
    prompt_block_reason: null,
    provider_parse_status: 'parsed',
    unknown_fields_present: false,
  };
}

export async function executeAttempt(input: ExecuteAttemptInput): Promise<AttemptOutcome> {
  const { provider, providerId, model, canonical, apiKey, metadata, gate, computeCost } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  const requestedJson = requestedJsonFromResponseFormat(canonical.response_format);

  // buildRequest can throw with actionable messages (Bedrock stream:true, Azure
  // missing resource_name) — a build failure is this attempt's transport error.
  let req: ProviderRequest;
  try {
    req = provider.buildRequest({ ...canonical, model }, apiKey, metadata);
  } catch (err) {
    return { kind: 'transport_error', provider: providerId, model, reasonCode: String(err) };
  }

  input.onDispatchStart?.();
  let res: Response;
  try {
    res = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body });
  } catch (err) {
    // Request construction failed before dispatch; a fetch rejection happens
    // after the provider may have accepted the paid request.
    return { kind: 'transport_error', provider: providerId, model, reasonCode: String(err), actualCostKnown: false };
  }

  // Non-2xx: hand the status to the cascade, which decides retryability +
  // circuit accounting (5xx/429 retryable + circuit failure; 4xx client fault).
  if (!res.ok) {
    // An upstream 5xx can be returned after the provider accepted and began a
    // billable request. Rate limits and client/configuration failures are exact
    // zero-spend outcomes, but a 5xx must remain an unknown-cost lower bound.
    return {
      kind: 'retryable_http',
      provider: providerId,
      model,
      status: res.status,
      actualCostKnown: res.status < 500,
    };
  }

  // Buffer + parse the body once, then normalize. Any failure — JSON.parse OR an
  // adapter parseResponse/parseOutcomeSignals throw on a malformed-schema 200 —
  // is a parse failure (provider_parse_status 'failed'); the verifier
  // short-circuits on that before inspecting the (placeholder) canonical. An
  // adapter without the optional parseOutcomeSignals gets parsed-status signals
  // (unknown outcomes), NOT a parse failure.
  let rawBody: unknown = null;
  let parsed = false;
  let signals: ProviderOutcomeSignals = failedSignals(providerId);
  let normalized: CanonicalResponse = { id: '', model, content: '', stop_reason: 'error', usage: EMPTY_USAGE };
  try {
    rawBody = JSON.parse(await res.text());
    signals = provider.parseOutcomeSignals ? provider.parseOutcomeSignals(rawBody) : parsedSignals(providerId);
    normalized = provider.parseResponse(rawBody);
    parsed = true;
  } catch {
    signals = failedSignals(providerId);
    normalized = { id: '', model, content: '', stop_reason: 'error', usage: EMPTY_USAGE };
  }
  const usage = normalized.usage;
  const computedCost = await computeCost(usage);
  // Numeric callbacks predate explicit unknown-cost tracking. They remain
  // supported for callers/tests that can only report exact measured cost.
  const computed: AttemptCost = typeof computedCost === 'number'
    ? { actualCostMicrocents: computedCost, actualCostKnown: true }
    : computedCost;
  // A parsed failure can still be fed EMPTY_USAGE into a perfectly valid
  // pricing function, which returns numeric zero. That is not evidence of a
  // free completion: the provider already accepted a 200 request.
  const actualCostMicrocents = computed.actualCostMicrocents;
  const actualCostKnown = parsed && computed.actualCostKnown;
  const reasoningCostMicrocents = computed.reasoningCostMicrocents;

  if (!gate) {
    if (!parsed) {
      return { kind: 'transport_error', provider: providerId, model, reasonCode: 'provider_response_parse_failed', actualCostKnown: false };
    }
    return { kind: 'verified', provider: providerId, model, canonical: normalized, signals, rawBody, usage, reasoningCostMicrocents, actualCostMicrocents, actualCostKnown };
  }

  const verdict = verifyResponse(gate, normalized, signals, { requested_json: requestedJson });
  switch (verdict.kind) {
    case 'pass':
      return { kind: 'verified', provider: providerId, model, canonical: normalized, signals, rawBody, usage, reasoningCostMicrocents, actualCostMicrocents, actualCostKnown };
    case 'reject':
      return { kind: 'quality_rejected', provider: providerId, model, reasonCode: verdict.code, checkIndex: verdict.check_index, signals, usage, reasoningCostMicrocents, actualCostMicrocents, actualCostKnown };
    case 'terminal':
      return { kind: 'terminal', provider: providerId, model, reasonCode: verdict.code, usage, reasoningCostMicrocents, actualCostMicrocents, actualCostKnown, statusCode: 200 };
    case 'engine_error':
      return { kind: 'terminal', provider: providerId, model, reasonCode: verdict.code, usage, reasoningCostMicrocents, actualCostMicrocents, actualCostKnown, statusCode: 200 };
    default:
      return { kind: 'terminal', provider: providerId, model, reasonCode: 'quality_gate_verifier_error', usage, reasoningCostMicrocents, actualCostMicrocents, actualCostKnown, statusCode: 200 };
  }
}

function reasoningAuditFields(
  usage: TokenUsage,
  reasoningCostMicrocents?: number | null,
): Pick<AttemptAudit, 'reasoning_tokens' | 'reasoning_cost_microcents'> {
  return {
    ...(usage.reasoning_tokens !== undefined ? { reasoning_tokens: usage.reasoning_tokens } : {}),
    ...(reasoningCostMicrocents !== undefined && reasoningCostMicrocents !== null
      ? { reasoning_cost_microcents: reasoningCostMicrocents }
      : {}),
  };
}

/** Build a sanitized audit row from an outcome (no prompt/response/schema/credential). */
export function auditFromOutcome(
  outcome: AttemptOutcome,
  attempt_index: number,
  latency_ms: number,
  circuit_failure: boolean,
): AttemptAudit {
  const base = {
    attempt_index,
    provider: outcome.provider,
    model: outcome.model,
    outcome: outcome.kind,
    latency_ms,
    circuit_failure,
  };
  switch (outcome.kind) {
    case 'verified':
      return {
        ...base,
        ...reasoningAuditFields(outcome.usage, outcome.reasoningCostMicrocents),
        reason_code: null,
        check_index: null,
        status_code: 200,
        input_tokens: outcome.usage.input_tokens,
        output_tokens: outcome.usage.output_tokens,
        actual_cost_microcents: outcome.actualCostMicrocents,
        actual_cost_known: outcome.actualCostKnown !== false,
      };
    case 'quality_rejected':
      return {
        ...base,
        ...reasoningAuditFields(outcome.usage, outcome.reasoningCostMicrocents),
        reason_code: outcome.reasonCode,
        check_index: outcome.checkIndex,
        status_code: 200,
        input_tokens: outcome.usage.input_tokens,
        output_tokens: outcome.usage.output_tokens,
        actual_cost_microcents: outcome.actualCostMicrocents,
        actual_cost_known: outcome.actualCostKnown !== false,
      };
    case 'retryable_http':
      return {
        ...base,
        reason_code: `HTTP ${outcome.status}`,
        check_index: null,
        status_code: outcome.status,
        input_tokens: 0,
        output_tokens: 0,
        actual_cost_microcents: 0,
        actual_cost_known: outcome.actualCostKnown,
      };
    case 'transport_error':
      return {
        ...base,
        reason_code: outcome.reasonCode,
        check_index: null,
        status_code: null,
        input_tokens: 0,
        output_tokens: 0,
        actual_cost_microcents: 0,
        actual_cost_known: outcome.actualCostKnown ?? true,
      };
    case 'terminal':
      return {
        ...base,
        ...reasoningAuditFields(outcome.usage, outcome.reasoningCostMicrocents),
        reason_code: outcome.reasonCode,
        check_index: null,
        status_code: outcome.statusCode,
        input_tokens: outcome.usage.input_tokens,
        output_tokens: outcome.usage.output_tokens,
        actual_cost_microcents: outcome.actualCostMicrocents,
        actual_cost_known: outcome.actualCostKnown !== false,
      };
    default:
      return {
        ...base,
        reason_code: null,
        check_index: null,
        status_code: null,
        input_tokens: 0,
        output_tokens: 0,
        actual_cost_microcents: 0,
        actual_cost_known: false,
      };
  }
}

// ---------------------------------------------------------------------------
// Cascade executor (Phase 2)
// ---------------------------------------------------------------------------

export interface CascadeCandidate {
  provider: string;
  model: string;
}

/** A candidate skipped before dispatch (eligibility/budget), sanitized. */
export interface CascadeSkip {
  provider: string;
  model: string;
  reason: string;
}

/** Credential selection supplied by the handler for a cascade candidate. */
export interface CascadeProviderConfig {
  key: string;
  metadata?: Record<string, unknown>;
  label?: string;
  selected_after_cooldown_skip?: boolean;
}

/**
 * Handler-owned credential observability for one actual upstream dispatch.
 * The routing executor deliberately treats the credential label as optional:
 * provider-key storage predates a non-empty-label constraint, and routing must
 * still be able to use those existing credentials.
 */
export interface CascadeAttemptIdentity {
  provider: string;
  model: string;
  credentialLabel?: string;
  selectedAfterCooldownSkip?: boolean;
}

function notifyAttemptObserver(
  event: 'start' | 'finish' | 'rate_limited',
  observer: ((identity: CascadeAttemptIdentity) => void) | undefined,
  identity: CascadeAttemptIdentity,
): void {
  if (!observer) return;
  try {
    observer(identity);
  } catch {
    // Observability must not alter paid routing/accounting. Do not include the
    // optional credential label or arbitrary observer error in logs.
    console.warn('Quality cascade attempt observer failed', {
      event,
      provider: identity.provider,
      model: identity.model,
    });
  }
}

export interface QualityCascadeInput {
  canonical: CanonicalRequest;
  gate: QualityGateConfig;
  /** Selected primary, then the already-filtered/authorized fallback chain. */
  primary: CascadeCandidate;
  /** Already-resolved primary credential; never reused for a fallback. */
  primaryConfig?: CascadeProviderConfig;
  fallbackChain: CascadeCandidate[];
  /** Effective dispatchable chat catalog for context/quarantine checks. */
  effectiveModels?: readonly EffectiveCatalogDefinition[];
  getProvider: (provider: string) => LLMProvider | undefined;
  /** Resolves fallback credentials only. */
  getProviderConfig: (
    provider: string,
  ) =>
    | Promise<CascadeProviderConfig | undefined>
    | CascadeProviderConfig
    | undefined;
  /** Actual attempt cost in microcents from real usage. */
  computeCost: (provider: string, model: string, usage: TokenUsage) => number | AttemptCost | Promise<number | AttemptCost>;
  budget?: RetryBudget;
  fetchImpl?: typeof fetch;
  /** Called immediately before each actual provider dispatch. */
  onAttemptStart?: (identity: CascadeAttemptIdentity) => void;
  /** Called exactly once after each actual provider dispatch settles. */
  onAttemptFinish?: (identity: CascadeAttemptIdentity) => void;
  /** Called only when an actual provider dispatch returns HTTP 429. */
  onAttemptRateLimited?: (identity: CascadeAttemptIdentity) => void;
}

/**
 * Sum the OBSERVED actual microcent cost of every dispatched attempt in an audit.
 *
 * The basis Phase 3 settles and computes savings against (RSH-134 §4.3/§4.4).
 * It is deliberately NOT the cascade's internal `cumulativeCostMicrocents`,
 * which is an *estimate* built from `estimateAttemptCostMicrocents` purely to
 * enforce the `RetryBudget` ceilings before dispatch, and which reads 0 for a
 * model with no catalog pricing. Settling an estimate would bill the customer
 * for a number no provider ever charged.
 *
 * Undispatched candidates never enter the audit at all — they land in `skips`.
 *
 * ## Known floor: this is observed cost, not proven spend
 *
 * It is a LOWER BOUND on what a cascade actually cost, and Phase 3 must not
 * treat it as exact before closing these two Phase-2 gaps:
 *
 *  1. A dispatched 200 whose body or adapter parse fails is normalized to
 *     `EMPTY_USAGE`, so it contributes 0 — but the provider already ran the
 *     completion and will bill for it. Not observing usage is not evidence that
 *     no charge was incurred.
 *  2. When `computeCost` throws, the cascade now stops and preserves the audit
 *     rather than discarding every prior attempt's known cost, but the throwing
 *     attempt's own cost is unknown and recorded as 0.
 *
 * `actual_cost_known` and the explicit unknown-attempt count carry that
 * distinction through settlement; a numeric aggregate alone is a lower bound.
 */
export function aggregateActualCostMicrocents(audit: AttemptAudit[]): number {
  return audit.reduce((sum, row) => sum + row.actual_cost_microcents, 0);
}

export function isAggregateActualCostKnown(audit: AttemptAudit[]): boolean {
  return audit.every((row) => row.actual_cost_known);
}

export function aggregateUnknownCostAttempts(audit: AttemptAudit[]): number {
  return audit.reduce((count, row) => count + (row.actual_cost_known ? 0 : 1), 0);
}

export type QualityCascadeResult =
  | {
      ok: true;
      outcome: Extract<AttemptOutcome, { kind: 'verified' }>;
      provider: LLMProvider;
      providerId: string;
      model: string;
      audit: AttemptAudit[];
      skips: CascadeSkip[];
      /** Actual spend across every dispatched attempt, not just the served one. */
      aggregateCostMicrocents: number;
      aggregateCostKnown: boolean;
      aggregateUnknownCostAttempts: number;
    }
  | {
      ok: false;
      reason: 'exhausted' | 'terminal';
      terminalReasonCode?: string;
      /** Upstream HTTP status when a non-retryable response ended the cascade. */
      terminalStatusCode?: number;
      audit: AttemptAudit[];
      skips: CascadeSkip[];
      /**
       * Actual spend across every dispatched attempt. Non-zero on a failed
       * cascade whenever an attempt reached a provider: rejected and terminal
       * attempts are real spend, and the caller must not treat `ok: false` as
       * free.
       */
      aggregateCostMicrocents: number;
      aggregateCostKnown: boolean;
      aggregateUnknownCostAttempts: number;
    };

/**
 * Drive the primary + authorized fallback chain through executeAttempt under a
 * quality gate. Mirrors fallback.ts eligibility/budget/circuit semantics, plus:
 * a deterministic quality rejection keeps the circuit successful but consumes
 * retry/cost budget and advances; refusal/safety/engine_error are terminal and
 * stop immediately; exhaustion yields the ordered sanitized audit + skips.
 */
export async function executeQualityCascade(input: QualityCascadeInput): Promise<QualityCascadeResult> {
  const {
    canonical, gate, primary, fallbackChain, getProvider, getProviderConfig, computeCost, budget, fetchImpl,
    onAttemptStart, onAttemptFinish, onAttemptRateLimited,
  } = input;
  const audit: AttemptAudit[] = [];
  const skips: CascadeSkip[] = [];

  // Fail closed on an unacknowledged gate, BEFORE any dispatch (RSH-134 §6 Q1).
  //
  // `validateQualityGateConfig` runs only on write, and `evaluator.ts` reads
  // stored rule actions straight through, so a gate persisted before
  // `multi_attempt_billing_ack` existed reaches here with the field absent. The
  // TypeScript literal type does not protect persisted JSON at runtime.
  //
  // This check lives in the executor rather than only in the caller so that no
  // future wiring can forget it: dispatching several paid attempts without an
  // acknowledgement is the exact thing the standing "never silently route
  // customer traffic to a new paid path" invariant forbids.
  if (!hasMultiAttemptBillingAck(gate)) {
    return {
      ok: false,
      reason: 'terminal',
      terminalReasonCode: 'quality_gate_billing_ack_required',
      audit,
      skips,
      aggregateCostMicrocents: 0,
      aggregateCostKnown: true,
      aggregateUnknownCostAttempts: 0,
    };
  }
  const candidates = [primary, ...fallbackChain];
  const tried = new Set<string>();
  const estimatedTokens = estimateCanonicalInputTokens(canonical);
  const maxRetries = budget?.maxRetries ?? Infinity;
  const hasMaxCost = budget?.maxCostMicrocents !== undefined;
  const maxCost = budget?.maxCostMicrocents ?? Infinity;
  const estInTokens = budget?.estimatedInputTokens ?? estimatedTokens;
  const estOutTokens = budget?.estimatedMaxOutputTokens ?? 4096;
  let retriesUsed = 0;
  // Keep the primary's reservation floor in max-cost accounting even if the
  // primary is skipped pre-dispatch. This matches credits admission and avoids
  // letting a skipped key/circuit unlock an unreserved expensive fallback.
  const primaryBudgetCost = await estimateAttemptCostForBudget(
    primary.provider, primary.model, estInTokens, estOutTokens, budget?.pricingResolver,
  );
  let cumulativeCostMicrocents = primaryBudgetCost ?? 0;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const key = `${candidate.provider}:${candidate.model}`;
    if (tried.has(key)) continue;
    tried.add(key);
    const isPrimary = i === 0;
    const skip = (reason: string) => skips.push({ provider: candidate.provider, model: candidate.model, reason });
    // Eligibility (all candidates): catalog quarantine/context, circuit,
    // provider, and credential. A primary eligibility failure is terminal;
    // silently falling through would turn an explicit invalid route into an
    // unrelated fallback.
    const eligibility = assessDispatchTarget(candidate.provider, candidate.model, input.effectiveModels);
    if (!eligibility.ok) {
      skip(eligibility.reason);
      if (isPrimary) {
        return {
          ok: false,
          reason: 'terminal',
          terminalReasonCode: 'model_not_dispatchable',
          audit,
          skips,
          aggregateCostMicrocents: aggregateActualCostMicrocents(audit),
          aggregateCostKnown: isAggregateActualCostKnown(audit),
          aggregateUnknownCostAttempts: aggregateUnknownCostAttempts(audit),
        };
      }
      continue;
    }
    const targetContext = contextWindowForDispatchTarget(
      candidate.provider,
      candidate.model,
      input.effectiveModels,
    );
    if (targetContext !== null && estimatedTokens > targetContext) {
      skip('Context window too small');
      if (isPrimary) {
        return {
          ok: false,
          reason: 'terminal',
          terminalReasonCode: 'context_window_exceeded',
          audit,
          skips,
          aggregateCostMicrocents: aggregateActualCostMicrocents(audit),
          aggregateCostKnown: isAggregateActualCostKnown(audit),
          aggregateUnknownCostAttempts: aggregateUnknownCostAttempts(audit),
        };
      }
      continue;
    }
    if (circuitBreaker.isOpen(candidate.provider, candidate.model)) {
      skip('Circuit breaker open');
      continue;
    }
    const provider = getProvider(candidate.provider);
    if (!provider) {
      skip('Unknown provider');
      continue;
    }
    let config: CascadeProviderConfig | undefined;
    if (isPrimary) {
      config = input.primaryConfig;
    } else {
      try {
        config = (await getProviderConfig(candidate.provider)) ?? undefined;
      } catch (err) {
        skip(String(err));
        continue;
      }
    }
    if (!config) {
      skip('No provider key configured');
      continue;
    }
    // Budget ceilings apply to fallbacks; the primary is always dispatched (its
    // estimated cost is counted, mirroring fallback.ts's unconditional primary cost).
    const attemptCost = await estimateAttemptCostForBudget(
      candidate.provider, candidate.model, estInTokens, estOutTokens, budget?.pricingResolver,
    );
    if (isPrimary && budget?.requireKnownPricing && attemptCost === null) {
      skip('Missing model pricing');
      return {
        ok: false, reason: 'terminal', terminalReasonCode: 'missing_model_pricing', audit, skips,
        aggregateCostMicrocents: aggregateActualCostMicrocents(audit),
        aggregateCostKnown: true, aggregateUnknownCostAttempts: 0,
      };
    }
    if (!isPrimary) {
      if (hasMaxCost && primaryBudgetCost === null) {
        skip('Retry budget exhausted (primary_unknown_pricing)');
        break;
      }
      if (retriesUsed >= maxRetries) {
        skip('Retry budget exhausted (max_retries)');
        break;
      }
      if (budget?.requireKnownPricing && attemptCost === null) {
        skip('Missing model pricing');
        continue;
      }
      if (hasMaxCost && attemptCost === null) {
        skip('Retry budget exhausted (unknown_pricing)');
        continue;
      }
      const projected = cumulativeCostMicrocents + (attemptCost ?? 0);
      if (projected > maxCost) {
        skip('Retry budget exhausted (max_cost_microcents)');
        break;
      }
      cumulativeCostMicrocents = projected;
      retriesUsed += 1;
    }

    const start = Date.now();
    let outcome: AttemptOutcome;
    let dispatchStarted = false;
    const identity: CascadeAttemptIdentity = {
      provider: candidate.provider,
      model: candidate.model,
      ...(typeof config.label === 'string' ? { credentialLabel: config.label } : {}),
      ...(config.selected_after_cooldown_skip === true ? { selectedAfterCooldownSkip: true } : {}),
    };
    try {
      try {
        outcome = await executeAttempt({
          provider,
          providerId: candidate.provider,
          model: candidate.model,
          canonical,
          apiKey: config.key,
          metadata: config.metadata,
          gate,
          computeCost: (usage) => computeCost(candidate.provider, candidate.model, usage),
          fetchImpl,
          onDispatchStart: () => {
            dispatchStarted = true;
            notifyAttemptObserver('start', onAttemptStart, identity);
          },
        });
      } finally {
        // Lifecycle effects belong to the handler, but the executor owns their
        // exact dispatch scope: every attempt that reached fetch finishes once
        // even when fetching, parsing, or pricing throws.
        if (dispatchStarted) {
          notifyAttemptObserver('finish', onAttemptFinish, identity);
        }
      }
    } catch (err) {
      // executeAttempt awaits `computeCost` outside any try/catch, so a pricing
      // lookup failure rejects here AFTER the provider has already run and
      // billed the completion. Letting that propagate would throw away the
      // whole `audit` array — including earlier attempts whose cost IS known —
      // and leave the caller nothing to settle. Preserve what we have.
      //
      // Stop the chain rather than advancing: an internal pricing error is not
      // a reason to spend the customer's money on another paid attempt.
      audit.push({
        attempt_index: i,
        provider: candidate.provider,
        model: candidate.model,
        outcome: 'terminal',
        reason_code: `quality_gate_attempt_executor_error: ${String(err)}`,
        check_index: null,
        status_code: null,
        input_tokens: 0,
        output_tokens: 0,
        // Unknown, not proven zero — see aggregateActualCostMicrocents' note on
        // this being a lower bound.
        actual_cost_microcents: 0,
        actual_cost_known: false,
        latency_ms: Date.now() - start,
        circuit_failure: false,
      });
      return {
        ok: false,
        reason: 'terminal',
        terminalReasonCode: 'quality_gate_attempt_executor_error',
        audit,
        skips,
        aggregateCostMicrocents: aggregateActualCostMicrocents(audit),
        aggregateCostKnown: false,
        aggregateUnknownCostAttempts: aggregateUnknownCostAttempts(audit),
      };
    }
    const latency = Date.now() - start;

    switch (outcome.kind) {
      case 'verified':
        circuitBreaker.recordSuccess(candidate.provider, candidate.model);
        audit.push(auditFromOutcome(outcome, i, latency, false));
        return {
          ok: true,
          outcome,
          provider,
          providerId: candidate.provider,
          model: candidate.model,
          audit,
          skips,
          aggregateCostMicrocents: aggregateActualCostMicrocents(audit),
          aggregateCostKnown: isAggregateActualCostKnown(audit),
          aggregateUnknownCostAttempts: aggregateUnknownCostAttempts(audit),
        };
      case 'quality_rejected':
        // Deterministic quality rejection: the provider transport was available,
        // so the circuit stays successful; the attempt still consumed budget.
        audit.push(auditFromOutcome(outcome, i, latency, false));
        continue;
      case 'retryable_http': {
        // executeAttempt labels EVERY non-2xx `retryable_http`; the retryability
        // decision is the cascade's. Mirror the ungated path exactly
        // (proxy-handler.ts's `status >= 500 || status === 429`, and the same
        // test in fallback.ts): only 5xx/429 earn another paid attempt.
        //
        // A 400/401/403/404 is a client or configuration fault that every
        // candidate would hit identically, so advancing would just buy a second
        // failure. Stop and surface the exact upstream status.
        const circuitFailure = outcome.status >= 500 || outcome.status === 429;
        audit.push(auditFromOutcome(outcome, i, latency, circuitFailure));
        // A credential-specific 429 is the only cascade outcome that places
        // this credential on cooldown. Quality rejections, parse failures,
        // transport errors, and non-429 HTTP outcomes are not rate limits.
        if (outcome.status === 429) {
          notifyAttemptObserver('rate_limited', onAttemptRateLimited, identity);
        }
        if (!circuitFailure) {
          return {
            ok: false,
            reason: 'terminal',
            terminalReasonCode: `HTTP ${outcome.status}`,
            terminalStatusCode: outcome.status,
            audit,
            skips,
            aggregateCostMicrocents: aggregateActualCostMicrocents(audit),
            aggregateCostKnown: isAggregateActualCostKnown(audit),
            aggregateUnknownCostAttempts: aggregateUnknownCostAttempts(audit),
          };
        }
        circuitBreaker.recordFailure(candidate.provider, candidate.model);
        continue;
      }
      case 'transport_error':
        circuitBreaker.recordFailure(candidate.provider, candidate.model);
        audit.push(auditFromOutcome(outcome, i, latency, true));
        continue;
      case 'terminal':
        audit.push(auditFromOutcome(outcome, i, latency, false));
        return {
          ok: false,
          reason: 'terminal',
          terminalReasonCode: outcome.reasonCode,
          audit,
          skips,
          aggregateCostMicrocents: aggregateActualCostMicrocents(audit),
          aggregateCostKnown: isAggregateActualCostKnown(audit),
          aggregateUnknownCostAttempts: aggregateUnknownCostAttempts(audit),
        };
      default:
        audit.push(auditFromOutcome(outcome, i, latency, false));
        continue;
    }
  }

  return {
    ok: false,
    reason: 'exhausted',
    audit,
    skips,
    aggregateCostMicrocents: aggregateActualCostMicrocents(audit),
    aggregateCostKnown: isAggregateActualCostKnown(audit),
    aggregateUnknownCostAttempts: aggregateUnknownCostAttempts(audit),
  };
}
