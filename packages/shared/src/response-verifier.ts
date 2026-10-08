/**
 * RSH-72 Phase 1 — pure response-quality verifier.
 *
 * A bounded, deterministic, opt-in gate that lets a team reject an otherwise
 * successful (HTTP 200) non-streaming response using a small DSL of explicit
 * checks. This module is PURE: no I/O, no clock, no randomness, no mutable
 * module state. Identical inputs always produce the identical verdict, so a
 * decision is replayable from sanitized config + normalized provider signals.
 *
 * This is the foundation the later quality-gated cascade (RSH-72 Phase 2/3) and
 * the RSH-85 shadow-routing comparison both consume. It is inert until wired in
 * by a later phase: nothing here changes serving behavior on its own.
 *
 * Design: docs/superpowers/specs/2026-07-13-rsh-72-quality-gated-cascade-design.md
 */
import type { CanonicalResponse, CanonicalResponseFormat, CanonicalToolCall, StopReason } from './types';

// ── Stable public reason codes ────────────────────────────────────────────────
// Exact codes flow through logs and UI. They must never be collapsed into a
// generic `fallback` / `bad_output` / `provider_error` bucket.
export const QUALITY_REASON_CODES = [
  'quality_gate_max_tokens',
  'quality_gate_empty_content',
  'quality_gate_invalid_json',
  'quality_gate_invalid_tool_call',
  'quality_gate_unknown_provider_signal',
  'quality_gate_provider_response_parse_failed',
  'quality_gate_exhausted',
  'quality_gate_streaming_unsupported',
  'quality_gate_streaming_bypassed',
  'quality_gate_refusal_terminal',
  'quality_gate_safety_terminal',
  'quality_gate_verifier_error',
  'quality_gate_credit_mode_unsupported',
  'quality_gate_cache_bypassed',
  'quality_gate_billing_ack_required',
] as const;
export type QualityReasonCode = (typeof QUALITY_REASON_CODES)[number];

/** v1 only supports rejecting `max_tokens` via the stop_reason check. Refusal and
 *  safety are terminal policy outcomes, never configurable retry values. */
export type StopReasonRejectValue = 'max_tokens';

// Exhaustive over StopReasonRejectValue: adding a new reject value without a map
// entry is a compile error, so a matched value can never collapse to a generic
// bucket (the 'never collapse reason codes' invariant).
const STOP_REASON_REJECT_CODES: Record<StopReasonRejectValue, QualityReasonCode> = {
  max_tokens: 'quality_gate_max_tokens',
};

// ── Bounds (defensive; the admin write-gate enforces these before storage) ────
export const QUALITY_GATE_MAX_CHECKS = 8;
export const QUALITY_GATE_MAX_CONFIG_BYTES = 8192;
export const QUALITY_GATE_MAX_REJECT_VALUES = 16;
export const QUALITY_GATE_MAX_MIN_CHARS = 1_000_000;

// ── Gate configuration DSL ────────────────────────────────────────────────────
export type QualityCheck =
  | { type: 'stop_reason'; reject: StopReasonRejectValue[] }
  | { type: 'nonempty_content'; min_chars: number; allow_tool_only?: boolean }
  | { type: 'json_parse'; when: 'response_format_json' }
  | { type: 'tool_call_shape'; require_json_arguments?: boolean };

export interface QualityGateConfig {
  version: 1;
  mode: 'cascade';
  on_stream: 'reject' | 'bypass';
  /** v1 must be 'reject'. A fail-open option would require a new contract review. */
  unknown_signal: 'reject';
  /**
   * RSH-134 §6 Q1 — required, and must be exactly `true`.
   *
   * A gated request may dispatch SEVERAL PAID provider attempts for one client
   * request. Every surface that can enable a gate states that cost consequence
   * at enablement time: the dashboard rule editor (RSH-154) presents it as an
   * explicit, unchecked-by-default checkbox, and the admin API rejects configs
   * with this exact error text. Making the acknowledgement a required field
   * means the cost consequence is stated where the gate is enabled, rather than
   * discovered on an invoice.
   *
   * Deliberately not defaulted and deliberately not a boolean: `false` and
   * absent are both rejected, so a config cannot acquire consent by omission.
   */
  multi_attempt_billing_ack: true;
  /** Non-empty, ordered, length <= QUALITY_GATE_MAX_CHECKS. First failure wins. */
  checks: QualityCheck[];
}

/**
 * True iff a gate carries a valid multi-attempt billing acknowledgement.
 *
 * The serve path MUST call this rather than trusting that a stored gate passed
 * today's write-gate. `validateQualityGateConfig` only runs on write, and gates
 * persisted before this field existed are still readable by
 * `evaluator.ts` — so a read-side check is the only thing that stops a
 * pre-existing config from cascading unacknowledged. Fail closed.
 */
export function hasMultiAttemptBillingAck(gate: QualityGateConfig | undefined): boolean {
  return (gate as { multi_attempt_billing_ack?: unknown } | undefined)?.multi_attempt_billing_ack === true;
}

/** A failed check ALWAYS carries its exact reason code. Discriminated on `passed`
 *  so a future check that forgets `code` on failure is a compile error — there is
 *  no fallback bucket a mislabel can hide in. */
export type CheckResult =
  | { check_index: number; check_type: QualityCheck['type']; passed: true }
  | { check_index: number; check_type: QualityCheck['type']; passed: false; code: QualityReasonCode };

export type VerificationResult =
  | { kind: 'pass'; checks: CheckResult[] }
  // check_index === -1 marks a non-check rejection (parse failure, unknown signal).
  | { kind: 'reject'; code: QualityReasonCode; check_index: number }
  | { kind: 'terminal'; code: 'quality_gate_refusal_terminal' | 'quality_gate_safety_terminal' }
  | { kind: 'engine_error'; code: 'quality_gate_verifier_error' };

// ── Lossless per-attempt provider signals ─────────────────────────────────────
// Beside the small client-facing CanonicalResponse. Unknown raw provider values
// stay exact and set unknown_fields_present; they never map silently to `end`.
export interface ProviderOutcomeSignals {
  provider: string;
  raw_stop_reason: string | null;
  refusal: boolean | null;
  safety_blocked: boolean | null;
  prompt_block_reason: string | null;
  provider_parse_status: 'parsed' | 'failed';
  unknown_fields_present: boolean;
}

/** What the verifier needs from the canonical request. */
export interface VerifierRequestContext {
  /** True iff response_format asked for JSON output (json | json_object | json_schema). */
  requested_json: boolean;
}

// ── Adapter signal-capability metadata ────────────────────────────────────────
// Analogous to capability flags in models.ts. Declares which signals a provider
// adapter can supply; a configured unsupported check fails loud. Finalized
// alongside the Phase-1 adapter-signal work.
export interface VerifierSignalCapabilities {
  provider: string;
  preserves_raw_stop_reason: boolean;
  preserves_refusal: boolean;
  preserves_safety_blocked: boolean;
  preserves_prompt_block_reason: boolean;
}

// Null-prototype registry: a lookup for 'toString'/'__proto__'/'constructor'/etc.
// yields undefined (no inherited Object.prototype members), so unknown providers
// always reach the fail-loud all-false fallback. Entries are frozen and returned
// as-is, so a caller cannot mutate module state (purity/determinism contract).
const VERIFIER_SIGNAL_CAPABILITIES_REGISTRY: Record<string, VerifierSignalCapabilities> = Object.assign(
  Object.create(null),
  {
    openai: Object.freeze({ provider: 'openai', preserves_raw_stop_reason: true, preserves_refusal: true, preserves_safety_blocked: true, preserves_prompt_block_reason: false }),
    anthropic: Object.freeze({ provider: 'anthropic', preserves_raw_stop_reason: true, preserves_refusal: true, preserves_safety_blocked: true, preserves_prompt_block_reason: false }),
    google: Object.freeze({ provider: 'google', preserves_raw_stop_reason: true, preserves_refusal: false, preserves_safety_blocked: true, preserves_prompt_block_reason: true }),
  },
);

/** Unknown providers report no capabilities (fail-loud default). */
export function getVerifierSignalCapabilities(provider: string): VerifierSignalCapabilities {
  const known = VERIFIER_SIGNAL_CAPABILITIES_REGISTRY[provider];
  if (known) return known;
  return Object.freeze({
    provider,
    preserves_raw_stop_reason: false,
    preserves_refusal: false,
    preserves_safety_blocked: false,
    preserves_prompt_block_reason: false,
  });
}

/** True iff the canonical request asked for JSON output. */
export function requestedJsonFromResponseFormat(format: CanonicalResponseFormat | undefined): boolean {
  if (!format) return false;
  return format.type === 'json' || format.type === 'json_object' || format.type === 'json_schema';
}

// ── Internal helpers (pure) ───────────────────────────────────────────────────
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** True iff every tool call has a non-empty id, function name, and argument
 *  string (and, when requireJson, arguments that parse as JSON). An empty or
 *  absent tool-call list is vacuously well-formed. */
function toolCallsWellFormed(toolCalls: CanonicalToolCall[] | undefined, requireJson: boolean): boolean {
  if (!Array.isArray(toolCalls)) return true;
  for (const call of toolCalls) {
    // A malformed payload may carry null/non-object items; treat as malformed
    // (-> reject) rather than letting `call.id` throw into the engine_error path.
    if (!call || typeof call !== 'object') return false;
    if (!isNonEmptyString(call.id)) return false;
    if (!isNonEmptyString(call.function?.name)) return false;
    if (!isNonEmptyString(call.function?.arguments)) return false;
    if (requireJson) {
      try {
        JSON.parse(call.function.arguments);
      } catch {
        return false;
      }
    }
  }
  return true;
}

function runCheck(
  check: QualityCheck,
  check_index: number,
  response: CanonicalResponse,
  context: VerifierRequestContext,
): CheckResult {
  switch (check.type) {
    case 'stop_reason': {
      if ((check.reject as readonly string[]).includes(response.stop_reason)) {
        // The .includes guard proves response.stop_reason is one of check.reject's
        // StopReasonRejectValue entries, so the exhaustive map always yields a code.
        const code = STOP_REASON_REJECT_CODES[response.stop_reason as StopReasonRejectValue];
        return { check_index, check_type: 'stop_reason', passed: false, code };
      }
      return { check_index, check_type: 'stop_reason', passed: true };
    }
    case 'nonempty_content': {
      // String.prototype.trim removes Unicode whitespace (Zs + line terminators).
      const trimmed = response.content.trim();
      if (trimmed.length >= check.min_chars) {
        return { check_index, check_type: 'nonempty_content', passed: true };
      }
      // When allow_tool_only is set, a tool-calling response passes even if its
      // content is below min_chars — tool calls routinely carry little/no prose.
      // Deliberately NOT restricted to empty content (that would over-reject valid
      // tool calls following a short preamble). Requires well-formed tool calls.
      if (
        check.allow_tool_only === true
        && Array.isArray(response.tool_calls)
        && response.tool_calls.length > 0
        && toolCallsWellFormed(response.tool_calls, false)
      ) {
        return { check_index, check_type: 'nonempty_content', passed: true };
      }
      return { check_index, check_type: 'nonempty_content', passed: false, code: 'quality_gate_empty_content' };
    }
    case 'json_parse': {
      if (check.when === 'response_format_json' && context.requested_json) {
        try {
          JSON.parse(response.content);
          return { check_index, check_type: 'json_parse', passed: true };
        } catch {
          return { check_index, check_type: 'json_parse', passed: false, code: 'quality_gate_invalid_json' };
        }
      }
      // Not a JSON request → check is skipped (passes).
      return { check_index, check_type: 'json_parse', passed: true };
    }
    case 'tool_call_shape': {
      if (toolCallsWellFormed(response.tool_calls, check.require_json_arguments === true)) {
        return { check_index, check_type: 'tool_call_shape', passed: true };
      }
      return { check_index, check_type: 'tool_call_shape', passed: false, code: 'quality_gate_invalid_tool_call' };
    }
  }
}

// ── The verifier ──────────────────────────────────────────────────────────────
/**
 * Evaluate a gated response. Precedence is fixed and deterministic:
 *   1. engine_error  — any thrown exception (a verifier defect must never cause a
 *                      cascade / spend storm; it is terminal, HTTP 502 upstream).
 *   2. provider_response_parse_failed — the body could not be parsed; nothing
 *                      downstream is trustworthy (reject → may cascade).
 *   3. refusal terminal — a positively-known refusal is a policy outcome; it does
 *                      not advance the chain (no cross-provider safety shopping).
 *   4. safety terminal — positively-known safety block, or normalized stop_reason
 *                      'safety'; terminal for the same reason.
 *   5. unknown_provider_signal — the adapter saw a raw outcome it could not
 *                      recognize; with unknown_signal='reject' (always, in v1) we
 *                      cannot trust the normalized result (reject → may cascade).
 *   6. configured checks in order; first failure wins.
 *   7. pass.
 */
export function verifyResponse(
  gate: QualityGateConfig,
  response: CanonicalResponse,
  signals: ProviderOutcomeSignals,
  context: VerifierRequestContext,
): VerificationResult {
  try {
    if (signals.provider_parse_status === 'failed') {
      return { kind: 'reject', code: 'quality_gate_provider_response_parse_failed', check_index: -1 };
    }
    if (signals.refusal === true) {
      return { kind: 'terminal', code: 'quality_gate_refusal_terminal' };
    }
    if (signals.safety_blocked === true || response.stop_reason === 'safety') {
      return { kind: 'terminal', code: 'quality_gate_safety_terminal' };
    }
    if (signals.unknown_fields_present === true) {
      return { kind: 'reject', code: 'quality_gate_unknown_provider_signal', check_index: -1 };
    }

    const checks: CheckResult[] = [];
    for (let i = 0; i < gate.checks.length; i++) {
      const result = runCheck(gate.checks[i], i, response, context);
      checks.push(result);
      if (!result.passed) {
        // `result` is narrowed to the `passed: false` variant, so `code` is present.
        return { kind: 'reject', code: result.code, check_index: i };
      }
    }
    return { kind: 'pass', checks };
  } catch {
    return { kind: 'engine_error', code: 'quality_gate_verifier_error' };
  }
}

// ── Strict config validation (admin write-gate) ───────────────────────────────
function utf8ByteLength(value: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).length;
  return value.length; // ASCII fallback if TextEncoder is unavailable
}

function validateCheck(check: unknown, index: number): string | null {
  if (typeof check !== 'object' || check === null || Array.isArray(check)) {
    return `quality_gate.checks[${index}] must be an object`;
  }
  const c = check as Record<string, unknown>;
  switch (c.type) {
    case 'stop_reason': {
      for (const k of Object.keys(c)) {
        if (k !== 'type' && k !== 'reject') return `quality_gate.checks[${index}] has unsupported field: ${k}`;
      }
      if (!Array.isArray(c.reject) || c.reject.length === 0) {
        return `quality_gate.checks[${index}].reject must be a non-empty array`;
      }
      if (c.reject.length > QUALITY_GATE_MAX_REJECT_VALUES) {
        return `quality_gate.checks[${index}].reject exceeds max ${QUALITY_GATE_MAX_REJECT_VALUES}`;
      }
      for (const v of c.reject) {
        if (v !== 'max_tokens') {
          return `quality_gate.checks[${index}].reject value '${String(v)}' is not supported in version 1 (only 'max_tokens')`;
        }
      }
      return null;
    }
    case 'nonempty_content': {
      for (const k of Object.keys(c)) {
        if (k !== 'type' && k !== 'min_chars' && k !== 'allow_tool_only') {
          return `quality_gate.checks[${index}] has unsupported field: ${k}`;
        }
      }
      if (
        typeof c.min_chars !== 'number'
        || !Number.isInteger(c.min_chars)
        || c.min_chars < 1
        || c.min_chars > QUALITY_GATE_MAX_MIN_CHARS
      ) {
        return `quality_gate.checks[${index}].min_chars must be an integer between 1 and ${QUALITY_GATE_MAX_MIN_CHARS}`;
      }
      if (c.allow_tool_only !== undefined && typeof c.allow_tool_only !== 'boolean') {
        return `quality_gate.checks[${index}].allow_tool_only must be a boolean`;
      }
      return null;
    }
    case 'json_parse': {
      for (const k of Object.keys(c)) {
        if (k !== 'type' && k !== 'when') return `quality_gate.checks[${index}] has unsupported field: ${k}`;
      }
      if (c.when !== 'response_format_json') {
        return `quality_gate.checks[${index}].when must be 'response_format_json'`;
      }
      return null;
    }
    case 'tool_call_shape': {
      for (const k of Object.keys(c)) {
        if (k !== 'type' && k !== 'require_json_arguments') {
          return `quality_gate.checks[${index}] has unsupported field: ${k}`;
        }
      }
      if (c.require_json_arguments !== undefined && typeof c.require_json_arguments !== 'boolean') {
        return `quality_gate.checks[${index}].require_json_arguments must be a boolean`;
      }
      return null;
    }
    default:
      return `quality_gate.checks[${index}] has unsupported type: ${String(c.type)}`;
  }
}

/**
 * Strictly validate an untrusted quality_gate value before it is stored. Returns
 * the typed config on success or a specific error string. Pure; does not mutate
 * the input. NOTE: "gate is only valid on a route action" is enforced by the
 * caller (admin rules), which knows the action type — not here.
 */
export function validateQualityGateConfig(
  input: unknown,
): { ok: true; config: QualityGateConfig } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: 'quality_gate must be an object' };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return { ok: false, error: 'quality_gate is not serializable' };
  }
  if (utf8ByteLength(serialized) > QUALITY_GATE_MAX_CONFIG_BYTES) {
    return { ok: false, error: `quality_gate exceeds ${QUALITY_GATE_MAX_CONFIG_BYTES} bytes` };
  }

  const gate = input as Record<string, unknown>;
  if (gate.version !== 1) return { ok: false, error: 'quality_gate.version must be 1' };
  if (gate.mode !== 'cascade') return { ok: false, error: "quality_gate.mode must be 'cascade'" };
  if (gate.on_stream !== 'reject' && gate.on_stream !== 'bypass') {
    return { ok: false, error: "quality_gate.on_stream must be 'reject' or 'bypass'" };
  }
  if (gate.unknown_signal !== 'reject') {
    return { ok: false, error: "quality_gate.unknown_signal must be 'reject' in version 1" };
  }
  // RSH-134 §6 Q1. Exactly `true` — `false`, absent, and truthy non-booleans all
  // fail, so consent can never be acquired by omission or coercion. The error
  // text states the cost consequence, because this rejection is the moment the
  // operator learns a gate can dispatch more than one paid attempt.
  if (gate.multi_attempt_billing_ack !== true) {
    return {
      ok: false,
      error:
        'quality_gate.multi_attempt_billing_ack must be true: a quality gate may dispatch several paid provider attempts for a single request, and each dispatched attempt is billable even when its output is rejected',
    };
  }
  for (const key of Object.keys(gate)) {
    if (
      key !== 'version' &&
      key !== 'mode' &&
      key !== 'on_stream' &&
      key !== 'unknown_signal' &&
      key !== 'multi_attempt_billing_ack' &&
      key !== 'checks'
    ) {
      return { ok: false, error: `quality_gate has unsupported field: ${key}` };
    }
  }
  if (!Array.isArray(gate.checks) || gate.checks.length === 0) {
    return { ok: false, error: 'quality_gate.checks must be a non-empty array' };
  }
  if (gate.checks.length > QUALITY_GATE_MAX_CHECKS) {
    return { ok: false, error: `quality_gate.checks exceeds max ${QUALITY_GATE_MAX_CHECKS}` };
  }
  for (let i = 0; i < gate.checks.length; i++) {
    const err = validateCheck(gate.checks[i], i);
    if (err) return { ok: false, error: err };
  }
  return { ok: true, config: input as QualityGateConfig };
}

// Re-export StopReason for callers that construct gate checks against it.
export type { StopReason };
