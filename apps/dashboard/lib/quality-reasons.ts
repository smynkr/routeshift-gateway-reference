import { QUALITY_REASON_CODES, type QualityReasonCode } from '@routeshift/shared';

// Human labels for the RSH-72/RSH-134 quality-gate reason codes. Labels are
// ADDITIVE: UI surfaces show the exact raw code alongside (the 'never collapse
// reason codes' invariant). The Record is exhaustive over QualityReasonCode, so
// a new code added to @routeshift/shared is a compile error here until labeled.
const QUALITY_REASON_LABELS: Record<QualityReasonCode, string> = {
  quality_gate_max_tokens: 'Truncated (max_tokens)',
  quality_gate_empty_content: 'Empty or too-short content',
  quality_gate_invalid_json: 'Invalid JSON',
  quality_gate_invalid_tool_call: 'Malformed tool call',
  quality_gate_unknown_provider_signal: 'Unknown provider signal',
  quality_gate_provider_response_parse_failed: 'Provider response unparseable',
  quality_gate_exhausted: 'All candidates failed the gate',
  quality_gate_streaming_unsupported: 'Streaming refused (gate active)',
  quality_gate_streaming_bypassed: 'Streaming served unverified',
  quality_gate_refusal_terminal: 'Refusal (terminal)',
  quality_gate_safety_terminal: 'Safety block (terminal)',
  quality_gate_verifier_error: 'Verifier error',
  quality_gate_credit_mode_unsupported: 'Credit mode unsupported',
  quality_gate_cache_bypassed: 'Cache bypassed',
  quality_gate_billing_ack_required: 'Billing acknowledgement required',
};

export function qualityReasonLabel(code: string | null | undefined): string | null {
  // Guard BEFORE indexing: `code` comes from logged strings, and indexing a
  // plain object with e.g. 'constructor' would otherwise return an inherited
  // prototype function that React cannot render.
  if (!isQualityReasonCode(code)) return null;
  return QUALITY_REASON_LABELS[code];
}

export function isQualityReasonCode(code: string | null | undefined): code is QualityReasonCode {
  return typeof code === 'string' && (QUALITY_REASON_CODES as readonly string[]).includes(code);
}

// Structural view of a request-log row — keeps these pure predicates testable
// without importing the 'use client' activity page module. The index signature
// tolerates the extra attempt fields (provider/model/actual_cost_known) callers
// carry without forcing this module to know about them.
export interface CascadeLogView {
  error_type: string | null;
  fallback_attempts: Array<{ error: string } & Record<string, unknown>>;
}

export function isQualityCascadeLog(log: CascadeLogView): boolean {
  if (isQualityReasonCode(log.error_type)) return true;
  return log.fallback_attempts.some((attempt) => isQualityReasonCode(attempt.error));
}

// The proxy deliberately mixes quality rejections, provider failures and
// eligibility skips in one attempts list; the header may only claim "quality"
// when every rendered attempt is quality-classified.
export function cascadeAttemptsHeader(log: CascadeLogView): string {
  if (!isQualityCascadeLog(log)) return 'Fallback Attempts';
  const allQuality = log.fallback_attempts.every((attempt) => isQualityReasonCode(attempt.error));
  return allQuality ? 'Quality Cascade Attempts' : 'Cascade Attempts';
}
