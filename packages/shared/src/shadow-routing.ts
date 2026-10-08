/**
 * RSH-85 Phase 1 — pure shadow-routing contract.
 *
 * Deterministic eligibility and sampling for opt-in shadow experiments.
 * Every function here is pure: no I/O, no clock, no randomness. The executor,
 * queue, logger, and provider dispatch are Phase 2 and live elsewhere.
 *
 * Design: docs/superpowers/specs/2026-07-13-rsh-85-shadow-routing-design.md
 */

import { createHmac } from 'node:crypto';

type ShadowTimestamp = string | Date;

// ─── Experiment configuration ───────────────────────────────────────────────

/** The team-scoped shadow experiment resource (control-plane shape). */
export interface ShadowExperimentConfig {
  id: string;
  team_id: string;
  name: string;
  enabled: boolean;

  /** Source selector — eligible requests match this provider/model. */
  source_provider: string;
  source_model: string;

  /** Candidate — the shadow provider/model to compare against. */
  candidate_provider: string;
  candidate_model: string;

  /** Sampling rate in parts-per-million [0, 1_000_000]. */
  sample_rate_ppm: number;
  /** Immutable version tag for sampling determinism. */
  sampling_version: string;
  /** Identifies the HMAC key version (NOT the key itself). */
  shadow_sampling_key_version: string;

  /** PostgreSQL timestamptz values arrive from `pg` as Date instances. */
  starts_at: ShadowTimestamp | null;
  ends_at: ShadowTimestamp | null;
  max_samples: number;

  /** Execution bounds. */
  deadline_ms: number;
  max_concurrency: number;
  max_queue_count: number;
  max_queue_bytes: number;
  max_payload_bytes: number;

  /** v1: only 'platform_funded' is valid. */
  funding_mode: 'platform_funded';
  per_run_cap_microcents: number;
  aggregate_cap_microcents: number;

  /** RSH-72 verifier contract reference. */
  verifier_version: string;
  gate_fingerprint: string;

  created_at: string;
  updated_at: string;

  /** Candidate-provider consent and accountable approval, all required to enable. */
  consent_provider_ack: boolean;
  consent_region_ack: boolean;
  consent_privacy_ack: boolean;
  approved_by: string | null;
  approved_at: ShadowTimestamp | null;
}

// ─── Exact reason codes ─────────────────────────────────────────────────────

/**
 * Decision and skip reasons. Do NOT collapse these into generic buckets —
 * each names an exact gate so operators can tell "no experiment configured"
 * from "candidate key missing" from "payload too large".
 */
export type ShadowDecisionReason =
  | 'shadow_disabled'
  | 'shadow_no_active_experiment'
  | 'shadow_request_opted_out'
  | 'shadow_api_key_opted_out'
  | 'shadow_experiment_not_started'
  | 'shadow_experiment_expired'
  | 'shadow_invalid_current_time'
  | 'shadow_consent_missing'
  | 'shadow_consent_revoked'
  | 'shadow_team_mismatch'
  | 'shadow_source_mismatch'
  | 'shadow_not_sampled'
  | 'shadow_streaming_unsupported_v1'
  | 'shadow_cache_hit'
  | 'shadow_plugins_unsupported_v1'
  | 'shadow_tools_unsupported_v1'
  | 'shadow_multimodal_unsupported_v1'
  | 'shadow_candidate_same_as_primary'
  | 'shadow_candidate_disallowed_by_key'
  | 'shadow_candidate_capability_mismatch'
  | 'shadow_candidate_region_disallowed'
  | 'shadow_candidate_retention_disallowed'
  | 'shadow_candidate_provider_unavailable'
  | 'shadow_candidate_key_missing'
  | 'shadow_candidate_key_decrypt_failed'
  | 'shadow_candidate_pricing_missing'
  | 'shadow_budget_exhausted'
  | 'shadow_sample_limit_exhausted'
  | 'shadow_queue_full'
  | 'shadow_payload_too_large'
  | 'shadow_concurrency_limited';

/** Execution lifecycle reasons (Phase 2 executor telemetry). */
export type ShadowExecutionReason =
  | 'shadow_queued'
  | 'shadow_started'
  | 'shadow_completed'
  | 'shadow_timeout'
  | 'shadow_aborted_shutdown'
  | 'shadow_provider_network_error'
  | 'shadow_provider_http_error'
  | 'shadow_parse_error'
  | 'shadow_usage_missing'
  | 'shadow_verifier_unavailable'
  | 'shadow_verifier_failed';

// ─── Eligibility ────────────────────────────────────────────────────────────

/** Immutable inputs for the pure eligibility check. No mutable limits here —
 * those are checked by the authoritative admission step (Phase 2). */
export interface ShadowEligibilityInput {
  experiment: ShadowExperimentConfig | null;
  team_id: string;
  request_opted_out: boolean;
  api_key_opted_out: boolean;
  is_streaming: boolean;
  is_cache_hit: boolean;
  has_plugins: boolean;
  has_tools: boolean;
  has_multimodal: boolean;
  served_provider: string;
  served_model: string;
  /** null = unrestricted (key allows all models). */
  key_allowed_models: string[] | null;
  candidate_key_present: boolean;
  candidate_pricing_known: boolean;
  /** ISO timestamp — pure input, not Date.now(). */
  current_time: string;
  payload_bytes: number;
}

export interface ShadowEligibilityResult {
  eligible: boolean;
  reason: ShadowDecisionReason;
  experiment_id: string | null;
}

function parseShadowTimestamp(value: ShadowTimestamp): number {
  if (value instanceof Date) return value.getTime();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/.exec(value);
  if (!match) return Number.NaN;
  const [, year, month, day, hour, minute, second = '00', zone] = match;
  const [y, mo, d, h, mi, s] = [year, month, day, hour, minute, second].map(Number);
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return Number.NaN;
  const calendar = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (calendar.getUTCFullYear() !== y || calendar.getUTCMonth() !== mo - 1 || calendar.getUTCDate() !== d) {
    return Number.NaN;
  }
  if (zone !== 'Z') {
    const offset = /^[-+](\d{2}):?(\d{2})$/.exec(zone);
    if (!offset || Number(offset[1]) > 15 || Number(offset[2]) > 59) return Number.NaN;
  }
  return Date.parse(value);
}

/**
 * Pure eligibility check. Evaluates conditions in a fixed order; first
 * failure wins and returns its exact reason. Opt-out precedence: request
 * and API-key opt-out override team opt-in (checked before experiment state).
 *
 * Returns `eligible: true, reason: 'shadow_not_sampled'` when all gates pass —
 * sampling is the next decision, made by `computeShadowSampling`.
 */
export function evaluateShadowEligibility(input: ShadowEligibilityInput): ShadowEligibilityResult {
  const { experiment } = input;
  const notEligible = (reason: ShadowDecisionReason): ShadowEligibilityResult => ({
    eligible: false,
    reason,
    experiment_id: experiment?.id ?? null,
  });

  // 1. No experiment configured for this team.
  if (!experiment) return notEligible('shadow_no_active_experiment');

  // An experiment is never transferable across tenant contexts, even if an
  // upstream caller accidentally supplies the wrong cached configuration.
  if (experiment.team_id !== input.team_id) return notEligible('shadow_team_mismatch');

  // 2. Experiment exists but is disabled.
  if (!experiment.enabled) return notEligible('shadow_disabled');

  // 3-4. Opt-out precedence: request/key opt-out overrides team opt-in.
  if (input.request_opted_out) return notEligible('shadow_request_opted_out');
  if (input.api_key_opted_out) return notEligible('shadow_api_key_opted_out');

  // 5. A candidate provider needs explicit, accountable consent. This is
  // deliberately separate from enabled so incomplete control-plane records
  // cannot authorize a cross-provider prompt disclosure.
  if (
    !experiment.consent_provider_ack ||
    !experiment.consent_region_ack ||
    !experiment.consent_privacy_ack ||
    typeof experiment.approved_by !== 'string' ||
    experiment.approved_by.trim() === '' ||
    experiment.approved_at === null ||
    !Number.isFinite(parseShadowTimestamp(experiment.approved_at))
  ) {
    return notEligible('shadow_consent_missing');
  }

  // 6-7. Compare instants rather than lexicographical ISO strings. An invalid
  // caller clock has its own exact reason; malformed experiment windows fail
  // closed using their corresponding time-window reason.
  const now = parseShadowTimestamp(input.current_time);
  if (!Number.isFinite(now)) return notEligible('shadow_invalid_current_time');
  const startsAt = experiment.starts_at === null ? null : parseShadowTimestamp(experiment.starts_at);
  const endsAt = experiment.ends_at === null ? null : parseShadowTimestamp(experiment.ends_at);
  if (startsAt !== null && (!Number.isFinite(startsAt) || now < startsAt)) {
    return notEligible('shadow_experiment_not_started');
  }
  if (endsAt !== null && (!Number.isFinite(endsAt) || now >= endsAt)) {
    return notEligible('shadow_experiment_expired');
  }

  // 7. An experiment may only shadow its explicitly configured source.
  // Check this before request-modality gates so a misconfigured source is
  // observable even when the request is unsupported by Phase 1.
  if (
    experiment.source_provider !== input.served_provider ||
    experiment.source_model !== input.served_model
  ) {
    return notEligible('shadow_source_mismatch');
  }

  // 8-12. V1 modality gates.
  if (input.is_streaming) return notEligible('shadow_streaming_unsupported_v1');
  if (input.is_cache_hit) return notEligible('shadow_cache_hit');
  if (input.has_plugins) return notEligible('shadow_plugins_unsupported_v1');
  if (input.has_tools) return notEligible('shadow_tools_unsupported_v1');
  if (input.has_multimodal) return notEligible('shadow_multimodal_unsupported_v1');

  // 13. Candidate must differ from the served provider/model.
  if (
    experiment.candidate_provider === input.served_provider &&
    experiment.candidate_model === input.served_model
  ) {
    return notEligible('shadow_candidate_same_as_primary');
  }

  // 14. API-key model restrictions.
  if (input.key_allowed_models !== null && !input.key_allowed_models.includes(experiment.candidate_model)) {
    return notEligible('shadow_candidate_disallowed_by_key');
  }

  // 15-16. Candidate credential and pricing.
  if (!input.candidate_key_present) return notEligible('shadow_candidate_key_missing');
  if (!input.candidate_pricing_known) return notEligible('shadow_candidate_pricing_missing');

  // 17. Payload size.
  if (input.payload_bytes > experiment.max_payload_bytes) {
    return notEligible('shadow_payload_too_large');
  }

  // All gates pass — sampling decides next.
  return { eligible: true, reason: 'shadow_not_sampled', experiment_id: experiment.id };
}

// ─── Deterministic sampling ─────────────────────────────────────────────────

export interface ShadowSamplingInput {
  /** Resolved secret bytes for the key version (NOT the version identifier). */
  hmac_secret: Uint8Array;
  sampling_version: string;
  experiment_id: string;
  team_id: string;
  /** Server-generated request ID (client cannot choose its bucket). */
  request_id: string;
  sample_rate_ppm: number;
}

export interface ShadowSamplingResult {
  sampled: boolean;
  /** Bucket in [0, 999_999]. */
  bucket: number;
  sample_rate_ppm: number;
  sampling_version: string;
  experiment_id: string;
  team_id: string;
}

/**
 * Deterministic HMAC-SHA-256 sampling with domain-separated canonical encoding.
 *
 * Canonical encoding: each string field is length-prefixed (4-byte big-endian
 * uint32 of UTF-8 byte length, then the UTF-8 bytes) before concatenation.
 * This prevents any combination of field values from producing an ambiguous
 * or colliding message (e.g., version="ab",id="c" vs version="a",id="bc").
 *
 * The first 4 bytes of the HMAC digest are read as a big-endian uint32 and
 * mapped to a bucket in [0, 1_000_000) via modulo. `sampled = bucket < rate`.
 */
export function computeShadowSampling(input: ShadowSamplingInput): ShadowSamplingResult {
  const validRate = Number.isSafeInteger(input.sample_rate_ppm)
    && input.sample_rate_ppm >= 0
    && input.sample_rate_ppm <= 1_000_000;
  const message = canonicalEncode(
    input.sampling_version,
    input.experiment_id,
    input.team_id,
    input.request_id,
  );

  const digest = createHmac('sha256', input.hmac_secret).update(message).digest();

  // First 4 bytes as big-endian uint32.
  const value = digest.readUInt32BE(0);
  const bucket = value % 1_000_000;

  return {
    sampled: validRate && bucket < input.sample_rate_ppm,
    bucket,
    sample_rate_ppm: input.sample_rate_ppm,
    sampling_version: input.sampling_version,
    experiment_id: input.experiment_id,
    team_id: input.team_id,
  };
}

/**
 * Length-prefix canonical encoding. Each field is encoded as:
 *   [4-byte BE uint32 of UTF-8 byte length][UTF-8 bytes]
 * Fields are concatenated in order. No separator is needed because the
 * length prefix makes the encoding self-delimiting.
 */
function canonicalEncode(...fields: string[]): Buffer {
  const parts: Buffer[] = [];
  for (const field of fields) {
    const utf8 = Buffer.from(field, 'utf8');
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(utf8.length, 0);
    parts.push(prefix, utf8);
  }
  return Buffer.concat(parts);
}
