/**
 * RSH-155 — shadow experiment types + pure helpers for the dashboard surface.
 *
 * The dashboard never talks to Postgres for shadow experiments; it forwards to
 * the proxy's existing admin API (`/admin/shadow-experiments`), which remains
 * the trust boundary. These helpers only:
 *   - describe the row shape the proxy returns (migration 050 + 052), and
 *   - mirror the proxy's validation ranges client-side for fast feedback.
 *
 * Truthfulness invariants preserved here:
 * - `deriveExperimentStatus` never invents a "running" state — there is no
 *   executor yet (RSH-85 Phase 2 is on hold), so a row is only ever killed,
 *   quarantined, enabled, or disabled.
 * - Enablement is permanently blocked server-side today; nothing in this file
 *   can produce `enabled: true`. The patch payload types it as `false` only.
 * - Validation ranges mirror `apps/proxy/src/admin/shadow-experiments.ts`
 *   exactly; they are fast feedback, not the trust boundary.
 */

// ── Constants ────────────────────────────────────────────────────────────────

/** One USD dollar = 100_000_000 microcents (micro = 1e-6, cents = 1e-2 USD). */
export const MICROCENTS_TO_USD = 100_000_000;

/** Postgres INTEGER ceiling; mirrors the proxy's POSTGRES_INTEGER_MAX. */
export const POSTGRES_INTEGER_MAX = 2_147_483_647;

/** Sample rate is stored as parts-per-million; 1_000_000 ppm = 100%. */
export const SAMPLE_RATE_MAX_PPM = 1_000_000;

/** ppm per whole percent: 1% = 10_000 ppm, so 50_000 ppm = 5%. */
export const PPM_PER_PERCENT = 10_000;

// ── Row shape (proxy admin API GET /admin/shadow-experiments) ────────────────

/**
 * A shadow experiment row exactly as the proxy returns it from
 * `shadow_experiments` (migration 050, bound-contract updates from 052).
 * Timestamps are ISO strings after JSON serialization; microcent caps are
 * numbers because the proxy's pg pool parses BIGINT (OID 20) to Number.
 */
export interface ShadowExperimentRow {
  id: string;
  team_id: string;
  name: string;
  enabled: boolean;

  // Source selector
  source_provider: string;
  source_model: string;

  // Candidate
  candidate_provider: string;
  candidate_model: string;

  // Sampling
  sample_rate_ppm: number;
  sampling_version: string;
  shadow_sampling_key_version: string;
  starts_at: string | null;
  ends_at: string | null;
  max_samples: number;

  // Execution bounds
  deadline_ms: number;
  max_concurrency: number;
  max_queue_count: number;
  max_queue_bytes: number;
  max_payload_bytes: number;

  // Funding (v1: platform_funded only)
  funding_mode: string;
  per_run_cap_microcents: number;
  aggregate_cap_microcents: number;

  // RSH-72 verifier reference
  verifier_version: string;
  gate_fingerprint: string;

  // Consent
  consent_provider_ack: boolean;
  consent_region_ack: boolean;
  consent_privacy_ack: boolean;
  approved_by: string | null;
  approved_at: string | null;

  // Lifecycle
  created_at: string;
  updated_at: string;
  created_by: string | null;
  disabled_reason: string | null;
  kill_switch_at: string | null;
}

// ── Create / patch payloads ──────────────────────────────────────────────────

/**
 * The 18 fields the proxy requires to create an experiment, plus the optional
 * window / attribution fields. `enabled` is intentionally absent — the proxy
 * forces it false server-side and there is no enable surface in v1.
 */
export interface CreateShadowExperimentPayload {
  name: string;
  source_provider: string;
  source_model: string;
  candidate_provider: string;
  candidate_model: string;
  sample_rate_ppm: number;
  sampling_version: string;
  shadow_sampling_key_version: string;
  verifier_version: string;
  gate_fingerprint: string;
  max_samples: number;
  deadline_ms: number;
  max_concurrency: number;
  max_queue_count: number;
  max_queue_bytes: number;
  max_payload_bytes: number;
  per_run_cap_microcents: number;
  aggregate_cap_microcents: number;
  starts_at?: string | null;
  ends_at?: string | null;
  created_by?: string | null;
  /** Only 'platform_funded' is accepted in v1; omitting is fine (INSERT hardcodes it). */
  funding_mode?: 'platform_funded';
}

/**
 * The proxy's mutable whitelist for PATCH. Every field is optional because a
 * patch sends only changed fields. `enabled` is typed `false` literally: the
 * proxy rejects `enabled: true` with 409 `shadow_enablement_unavailable`, and
 * the dashboard must never offer an enable toggle.
 *
 * Anything not listed is immutable after creation: sampling_version,
 * shadow_sampling_key_version, id, and team_id are rejected with 400
 * `immutable_field`; the remaining stored fields (route, verifier reference,
 * funding, consent) fall outside the whitelist and are rejected with 400
 * `invalid_field`.
 */
export interface PatchShadowExperimentPayload {
  name?: string;
  enabled?: false;
  sample_rate_ppm?: number;
  max_samples?: number;
  starts_at?: string | null;
  ends_at?: string | null;
  deadline_ms?: number;
  max_concurrency?: number;
  max_queue_count?: number;
  max_queue_bytes?: number;
  max_payload_bytes?: number;
  per_run_cap_microcents?: number;
  aggregate_cap_microcents?: number;
  disabled_reason?: string | null;
  kill_switch_at?: string | null;
}

// ── Status derivation ────────────────────────────────────────────────────────

export type ShadowExperimentStatus = 'killed' | 'quarantined' | 'enabled' | 'disabled';

function isSet(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Derive a truthful display status from a row. Precedence:
 *   kill_switch_at set → 'killed'
 *   else disabled_reason set → 'quarantined'
 *   else enabled → 'enabled'
 *   else → 'disabled'
 *
 * There is deliberately no 'running'/'active' state: no executor exists yet,
 * so even an enabled row has never executed a shadow run.
 */
export function deriveExperimentStatus(
  row: Pick<ShadowExperimentRow, 'enabled' | 'disabled_reason' | 'kill_switch_at'>,
): ShadowExperimentStatus {
  if (isSet(row.kill_switch_at)) return 'killed';
  if (isSet(row.disabled_reason)) return 'quarantined';
  if (row.enabled) return 'enabled';
  return 'disabled';
}

// ── ppm ↔ percent conversion ─────────────────────────────────────────────────

/** Convert parts-per-million to a percentage number (50_000 ppm → 5). */
export function ppmToPercent(ppm: number): number {
  return ppm / PPM_PER_PERCENT;
}

/** Convert a percentage number to parts-per-million (5 → 50_000 ppm). */
export function percentToPpm(percent: number): number {
  return Math.round(percent * PPM_PER_PERCENT);
}

/**
 * Display a stored ppm rate as a percent string, trimming trailing zeros
 * (50_000 → "5%", 12_500 → "1.25%", 0 → "0%").
 */
export function formatSampleRatePercent(ppm: number): string {
  const percent = ppmToPercent(ppm);
  const trimmed = parseFloat(percent.toFixed(4));
  return `${trimmed}%`;
}

// ── Microcent / USD formatting ───────────────────────────────────────────────

/**
 * Expand an INTEGER microcent amount to a plain decimal USD string — no `$`,
 * ≤ 8 fractional digits, trailing zeros trimmed, never scientific notation.
 * Exact BigInt math (no float division), so the result always satisfies
 * `isValidUsdAmountInput` for any stored integer in [0, MAX_SAFE_INTEGER]:
 * 1 → "0.00000001", 1_500_000 → "0.015", 200_000_000 → "2", 0 → "0".
 * Used to prefill the cap inputs so edit mode never bricks on a stored cap.
 */
export function microcentsToUsdInput(microcents: number): string {
  const total = BigInt(Math.max(0, Math.trunc(microcents)));
  const divisor = BigInt(MICROCENTS_TO_USD);
  const dollars = total / divisor;
  const remainder = total % divisor;
  if (remainder === BigInt(0)) return dollars.toString();
  const fraction = remainder.toString().padStart(8, '0').replace(/0+$/, '');
  return `${dollars.toString()}.${fraction}`;
}

/**
 * Format a microcent amount as USD by EXACT decimal expansion of the integer
 * value — never float division, never rounding. A cap must display exactly
 * what is stored: 1 microcent → "$0.00000001", 1_500_000 → "$0.015",
 * 200_000_000 → "$2", and zero → "$0.00" (a nonzero amount never renders as
 * $0.00). Fractional digits beyond the 8th microcent place are truncated,
 * trailing zeros trimmed. Negative input is a garbage-render guard: the proxy
 * floors caps at 0, so it displays as "$0.00".
 */
export function formatMicrocentsAsUsd(microcents: number): string {
  const total = Math.trunc(microcents);
  if (!Number.isFinite(total) || total <= 0) return '$0.00';
  return `$${microcentsToUsdInput(total)}`;
}

/**
 * Validate a USD amount as typed in the form, on the RAW INPUT STRING:
 * non-empty, decimal-only (no exponent/hex/sign), and at most 8 fractional
 * digits — the exact precision a microcent can represent. Float arithmetic is
 * never involved, so large amounts (≥ ~$128) that lose precision when
 * multiplied by 1e8 still validate correctly.
 */
export function isValidUsdAmountInput(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === '') return false;
  if (!/^\d+(\.\d{1,8})?$/.test(trimmed)) return false;
  return Number.isFinite(Number(trimmed));
}

/**
 * Convert a USD amount (as entered in the form) to microcents for submission,
 * EXACTLY via BigInt — no float multiply, so there is no ±1 drift near
 * MAX_SAFE_INTEGER. Splits the decimal string into integer + fraction, scales
 * the integer part by 1e8 and appends the fraction zero-padded to 8 digits.
 * Accepts a number or string; returns NaN for anything that is not a plain
 * non-negative decimal with ≤ 8 fractional digits, or that overflows the safe
 * integer range. Callers validate with `isValidUsdAmountInput` first, for
 * which the BigInt path always succeeds.
 */
export function usdToMicrocents(usd: number | string): number {
  const trimmed = String(usd).trim();
  if (!/^\d+(\.\d{1,8})?$/.test(trimmed)) return NaN;
  const [intPart, fracPart = ''] = trimmed.split('.');
  const microcents = BigInt(intPart) * BigInt(MICROCENTS_TO_USD) + BigInt(fracPart.padEnd(8, '0'));
  if (microcents > BigInt(Number.MAX_SAFE_INTEGER)) return NaN;
  return Number(microcents);
}

// ── Timestamp validation (mirrors the proxy exactly) ─────────────────────────

/**
 * Mirror of the proxy's `isOptionalTimestamp`: null/undefined are valid
 * (field omitted), a provided value must be an ISO-8601 timestamp WITH a
 * timezone designator (Z or ±hh:mm/±hhmm), a real calendar date, and a real
 * time-of-day. Client-side fast feedback; the proxy re-validates.
 */
export function isValidOptionalTimestamp(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second = '00', zone] = match;
  const numbers = [year, month, day, hour, minute, second].map(Number);
  const [y, mo, d, h, mi, s] = numbers;
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return false;
  const calendar = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (calendar.getUTCFullYear() !== y || calendar.getUTCMonth() !== mo - 1 || calendar.getUTCDate() !== d) return false;
  if (zone !== 'Z') {
    const offset = /^[-+](\d{2}):?(\d{2})$/.exec(zone);
    if (!offset || Number(offset[1]) > 15 || Number(offset[2]) > 59) return false;
  }
  return Number.isFinite(Date.parse(value));
}

// ── Execution-bound validation (mirrors the proxy exactly) ───────────────────

/**
 * The numeric bound fields the proxy validates, with their inclusive ranges.
 * Mirrors `apps/proxy/src/admin/shadow-experiments.ts`:
 *   - sample_rate_ppm ∈ [0, 1_000_000]
 *   - deadline_ms / max_concurrency / max_payload_bytes ∈ [1, 2_147_483_647]
 *   - max_samples / max_queue_count / max_queue_bytes ∈ [0, 2_147_483_647]
 *   - per_run / aggregate cap microcents ∈ [0, Number.MAX_SAFE_INTEGER]
 */
export const EXPERIMENT_BOUND_RANGES = {
  sample_rate_ppm: { min: 0, max: SAMPLE_RATE_MAX_PPM },
  deadline_ms: { min: 1, max: POSTGRES_INTEGER_MAX },
  max_concurrency: { min: 1, max: POSTGRES_INTEGER_MAX },
  max_payload_bytes: { min: 1, max: POSTGRES_INTEGER_MAX },
  max_samples: { min: 0, max: POSTGRES_INTEGER_MAX },
  max_queue_count: { min: 0, max: POSTGRES_INTEGER_MAX },
  max_queue_bytes: { min: 0, max: POSTGRES_INTEGER_MAX },
  per_run_cap_microcents: { min: 0, max: Number.MAX_SAFE_INTEGER },
  aggregate_cap_microcents: { min: 0, max: Number.MAX_SAFE_INTEGER },
} as const;

export type ExperimentBoundField = keyof typeof EXPERIMENT_BOUND_RANGES;

/** The subset of bounds a create/edit form collects as raw numbers. */
export type ExperimentBoundsInput = Partial<Record<ExperimentBoundField, number>>;

/**
 * Validate whichever bound fields are present, mirroring the proxy's ranges.
 * Returns a list of human-readable violations (empty = valid). Only present
 * fields are checked, so this serves both full-create and partial-patch
 * validation. The proxy remains the trust boundary; this is fast feedback.
 */
export function validateExperimentBounds(input: ExperimentBoundsInput): string[] {
  const errors: string[] = [];

  for (const [field, range] of Object.entries(EXPERIMENT_BOUND_RANGES)) {
    const value = input[field as ExperimentBoundField];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < range.min || value > range.max) {
      errors.push(
        `${field} must be a whole number between ${range.min.toLocaleString()} and ${range.max.toLocaleString()}.`,
      );
    }
  }

  const aggregate = input.aggregate_cap_microcents;
  const perRun = input.per_run_cap_microcents;
  if (aggregate !== undefined && perRun !== undefined && aggregate < perRun) {
    errors.push('aggregate_cap_microcents must be >= per_run_cap_microcents');
  }

  return errors;
}

// ── Proxy error envelope extraction ──────────────────────────────────────────

/**
 * Extract a `{ message, code }` pair from a proxy error response, verbatim.
 * Accepts both the object envelope `{ error: { message, code } }` and the
 * flat-string envelope `{ error: 'message' }` (older house routes). Falls back
 * to `fallbackMessage` with a null code when no usable message is present.
 * Exact reasons are never collapsed; shared by the list client and the editor.
 */
export function extractProxyError(
  payload: unknown,
  fallbackMessage: string,
): { message: string; code: string | null } {
  if (payload && typeof payload === 'object') {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === 'string' && error !== '') {
      return { message: error, code: null };
    }
    if (error && typeof error === 'object') {
      const message = (error as { message?: unknown }).message;
      const code = (error as { code?: unknown }).code;
      const extractedCode = typeof code === 'string' && code !== '' ? code : null;
      if (typeof message === 'string' && message !== '') {
        return { message, code: extractedCode };
      }
      // No usable message, but keep the code — it may be the only diagnostic.
      if (extractedCode !== null) {
        return { message: fallbackMessage, code: extractedCode };
      }
    }
  }
  return { message: fallbackMessage, code: null };
}
