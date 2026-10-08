'use client';

/**
 * RSH-154 — quality-gate editor for the routing rule form.
 *
 * Builds an `action.quality_gate` config for `route` rules. The proxy already
 * executes gates via the quality cascade (apps/proxy/src/routing/quality-cascade.ts);
 * before this surface existed, gates were configurable only through the raw
 * admin API. The proxy admin write-gate re-validates every stored gate with the
 * same `validateQualityGateConfig()` this editor ends on, so the client check
 * is fast feedback, not the trust boundary.
 *
 * Invariants preserved here:
 * - `multi_attempt_billing_ack` is an explicit, unchecked-by-default checkbox.
 *   It can never acquire consent by omission (RSH-134 §6 Q1).
 * - Exact reason codes and validator error strings are surfaced verbatim; they
 *   are never collapsed into a generic bucket.
 * - v1 fixed values (version 1, mode 'cascade', unknown_signal 'reject',
 *   stop_reason reject ['max_tokens'], json_parse when 'response_format_json')
 *   are built in, not user-configurable.
 */
import {
  QUALITY_GATE_MAX_CHECKS,
  QUALITY_GATE_MAX_MIN_CHARS,
  validateQualityGateConfig,
  type QualityCheck,
  type QualityGateConfig,
} from '@routeshift/shared';

// ── Draft model (UI-friendly state) ──────────────────────────────────────────

export type QualityCheckType = QualityCheck['type'];

export type QualityCheckDraft =
  | { type: 'stop_reason' }
  | { type: 'nonempty_content'; minChars: string; allowToolOnly: boolean }
  | { type: 'json_parse' }
  | { type: 'tool_call_shape'; requireJsonArguments: boolean };

export interface QualityGateDraft {
  onStream: 'reject' | 'bypass';
  checks: QualityCheckDraft[];
  billingAck: boolean;
}

export function defaultQualityGateDraft(): QualityGateDraft {
  return { onStream: 'reject', checks: [], billingAck: false };
}

export function newCheckDraft(type: QualityCheckType): QualityCheckDraft {
  switch (type) {
    case 'stop_reason':
      return { type: 'stop_reason' };
    case 'nonempty_content':
      return { type: 'nonempty_content', minChars: '1', allowToolOnly: false };
    case 'json_parse':
      return { type: 'json_parse' };
    case 'tool_call_shape':
      return { type: 'tool_call_shape', requireJsonArguments: false };
  }
}

// ── Pure draft → strict config mapping ───────────────────────────────────────

export type BuildQualityGateResult =
  | { ok: true; config: QualityGateConfig }
  | { ok: false; error: string };

/**
 * Map the editor draft onto a strict QualityGateConfig. Ends on the SAME
 * validator the proxy admin write-gate runs, so any config this function
 * accepts is storable; its error strings are the validator's exact strings.
 */
export function buildQualityGateConfig(draft: QualityGateDraft): BuildQualityGateResult {
  if (!draft.billingAck) {
    return {
      ok: false,
      error:
        'Confirm the billing acknowledgement: a quality gate may dispatch several paid provider attempts for a single request.',
    };
  }
  if (draft.checks.length === 0) {
    return { ok: false, error: 'Add at least one quality check before enabling the gate.' };
  }

  const checks: QualityCheck[] = [];
  for (let i = 0; i < draft.checks.length; i++) {
    const check = draft.checks[i];
    switch (check.type) {
      case 'stop_reason':
        // v1 supports exactly one reject value.
        checks.push({ type: 'stop_reason', reject: ['max_tokens'] });
        break;
      case 'nonempty_content': {
        const minChars = Number(check.minChars);
        if (
          check.minChars.trim() === '' ||
          !Number.isInteger(minChars) ||
          minChars < 1 ||
          minChars > QUALITY_GATE_MAX_MIN_CHARS
        ) {
          return {
            ok: false,
            error: `Check ${i + 1}: minimum characters must be a whole number between 1 and ${QUALITY_GATE_MAX_MIN_CHARS.toLocaleString()}.`,
          };
        }
        checks.push(
          check.allowToolOnly
            ? { type: 'nonempty_content', min_chars: minChars, allow_tool_only: true }
            : { type: 'nonempty_content', min_chars: minChars },
        );
        break;
      }
      case 'json_parse':
        checks.push({ type: 'json_parse', when: 'response_format_json' });
        break;
      case 'tool_call_shape':
        checks.push(
          check.requireJsonArguments
            ? { type: 'tool_call_shape', require_json_arguments: true }
            : { type: 'tool_call_shape' },
        );
        break;
    }
  }

  const candidate = {
    version: 1,
    mode: 'cascade',
    on_stream: draft.onStream,
    unknown_signal: 'reject',
    multi_attempt_billing_ack: true,
    checks,
  } satisfies QualityGateConfig;

  const validated = validateQualityGateConfig(candidate);
  if (!validated.ok) return { ok: false, error: validated.error };
  return { ok: true, config: validated.config };
}

// ── Option metadata ──────────────────────────────────────────────────────────

const CHECK_TYPE_OPTIONS: Array<{ value: QualityCheckType; label: string }> = [
  { value: 'stop_reason', label: 'Reject truncated output (max_tokens)' },
  { value: 'nonempty_content', label: 'Minimum content length' },
  { value: 'json_parse', label: 'Valid JSON for JSON-mode requests' },
  { value: 'tool_call_shape', label: 'Well-formed tool calls' },
];

// ── Component ────────────────────────────────────────────────────────────────

const inputClasses =
  'w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 text-sm text-white placeholder-neutral-600 outline-none transition-colors focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20';

const selectClasses =
  'w-full appearance-none bg-white/[0.05] border border-white/[0.1] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500/50 cursor-pointer';

/**
 * Reverse-map a stored QualityGateConfig onto the editor draft. Returns null
 * when the config uses features the v1 editor cannot represent (different
 * version/mode, unknown checks, non-canonical reject values) — the edit
 * surface must refuse loudly instead of silently dropping parts of the gate.
 */
export function qualityGateConfigToDraft(
  config: unknown,
): QualityGateDraft | null {
  const gate = config as {
    version?: unknown;
    mode?: unknown;
    on_stream?: unknown;
    unknown_signal?: unknown;
    multi_attempt_billing_ack?: unknown;
    checks?: unknown;
  } | null;
  if (
    !gate || typeof gate !== 'object' ||
    gate.version !== 1 || gate.mode !== 'cascade' ||
    (gate.on_stream !== 'reject' && gate.on_stream !== 'bypass') ||
    gate.unknown_signal !== 'reject' ||
    gate.multi_attempt_billing_ack !== true ||
    !Array.isArray(gate.checks)
  ) {
    return null;
  }
  // Strict schema: an unknown key on the gate or a check would be silently
  // dropped when the editor re-emits the config on save — refuse instead.
  const GATE_KEYS: Record<string, true> = {
    version: true, mode: true, on_stream: true, unknown_signal: true,
    multi_attempt_billing_ack: true, checks: true,
  };
  if (!Object.keys(gate).every((key) => GATE_KEYS[key])) return null;
  const CHECK_KEYS: Record<string, Record<string, true>> = {
    stop_reason: { type: true, reject: true },
    nonempty_content: { type: true, min_chars: true, allow_tool_only: true },
    json_parse: { type: true, when: true },
    tool_call_shape: { type: true, require_json_arguments: true },
  };
  const checks: QualityCheckDraft[] = [];
  for (const raw of gate.checks) {
    const check = raw as {
      type?: unknown;
      reject?: unknown;
      min_chars?: unknown;
      allow_tool_only?: unknown;
      when?: unknown;
      require_json_arguments?: unknown;
    } | null;
    if (!check || typeof check !== 'object') return null;
    const allowedKeys = typeof check.type === 'string' ? CHECK_KEYS[check.type] : undefined;
    if (!allowedKeys || !Object.keys(check).every((key) => allowedKeys[key])) return null;
    switch (check.type) {
      case 'stop_reason':
        // v1 supports exactly one reject value (max_tokens).
        if (!Array.isArray(check.reject) || check.reject.length !== 1 || check.reject[0] !== 'max_tokens') {
          return null;
        }
        checks.push({ type: 'stop_reason' });
        break;
      case 'nonempty_content':
        if (
          typeof check.min_chars !== 'number' || !Number.isInteger(check.min_chars) || check.min_chars < 1
        ) {
          return null;
        }
        checks.push({
          type: 'nonempty_content',
          minChars: String(check.min_chars),
          allowToolOnly: check.allow_tool_only === true,
        });
        break;
      case 'json_parse':
        if (check.when !== 'response_format_json') return null;
        checks.push({ type: 'json_parse' });
        break;
      case 'tool_call_shape':
        if (typeof check.require_json_arguments !== 'boolean' && check.require_json_arguments !== undefined) {
          return null;
        }
        checks.push({ type: 'tool_call_shape', requireJsonArguments: check.require_json_arguments === true });
        break;
      default:
        return null;
    }
  }
  return { onStream: gate.on_stream, checks, billingAck: true };
}

export interface QualityGateEditorProps {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  draft: QualityGateDraft;
  onDraftChange: (draft: QualityGateDraft) => void;
}

export function QualityGateEditor({ enabled, onEnabledChange, draft, onDraftChange }: QualityGateEditorProps) {
  function patchDraft(patch: Partial<QualityGateDraft>) {
    onDraftChange({ ...draft, ...patch });
  }

  function patchCheck(index: number, next: QualityCheckDraft) {
    const checks = [...draft.checks];
    checks[index] = next;
    patchDraft({ checks });
  }

  return (
    <div className="space-y-3 rounded-lg border border-white/[0.06] bg-white/[0.02] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <span className="text-sm font-medium text-neutral-300">Quality Gate</span>
          <p className="mt-1 text-xs text-neutral-500">
            Verify each non-streaming response before accepting it. A response that fails the checks
            cascades to the next candidate in the fallback chain.
          </p>
        </div>
        <button
          id="qualityGateEnabled"
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={enabled ? 'Disable quality gate' : 'Enable quality gate'}
          onClick={() => onEnabledChange(!enabled)}
          className="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 focus:outline-none"
          style={{ backgroundColor: enabled ? 'rgb(16 185 129 / 0.4)' : 'rgb(255 255 255 / 0.1)' }}
        >
          <span
            className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform duration-200 ${
              enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
            }`}
          />
        </button>
      </div>

      {enabled && (
        <div className="space-y-4">
          {/* Streaming behavior */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-neutral-400" htmlFor="qualityGateOnStream">
              Streaming requests
            </label>
            <select
              id="qualityGateOnStream"
              value={draft.onStream}
              onChange={(e) => patchDraft({ onStream: e.target.value === 'bypass' ? 'bypass' : 'reject' })}
              className={selectClasses}
            >
              <option value="reject">Reject — a cascade cannot replace bytes already streamed</option>
              <option value="bypass">Bypass — serve streaming responses unverified</option>
            </select>
          </div>

          {/* Checks */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-neutral-400">Checks (run in order, first failure wins)</label>
            <div className="space-y-2">
              {draft.checks.map((check, i) => (
                <div key={i} className="space-y-2 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                  <div className="flex items-center gap-2">
                    <select
                      aria-label={`Check ${i + 1} type`}
                      value={check.type}
                      onChange={(e) => patchCheck(i, newCheckDraft(e.target.value as QualityCheckType))}
                      className={selectClasses + ' flex-1'}
                    >
                      {CHECK_TYPE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      aria-label={`Remove check ${i + 1}`}
                      onClick={() => patchDraft({ checks: draft.checks.filter((_, idx) => idx !== i) })}
                      className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-2.5 py-2 text-xs text-neutral-500 hover:bg-white/[0.06] hover:text-red-400"
                    >
                      Remove
                    </button>
                  </div>

                  {check.type === 'stop_reason' && (
                    <p className="text-xs text-neutral-600">
                      Rejects responses whose stop reason is <span className="font-mono">max_tokens</span> —
                      the only stop reason configurable in gate version 1.
                    </p>
                  )}

                  {check.type === 'nonempty_content' && (
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="flex items-center gap-2">
                        <label className="text-xs text-neutral-500" htmlFor={`qualityGateMinChars-${i}`}>
                          Min characters
                        </label>
                        <input
                          id={`qualityGateMinChars-${i}`}
                          type="number"
                          min={1}
                          max={QUALITY_GATE_MAX_MIN_CHARS}
                          value={check.minChars}
                          onChange={(e) => patchCheck(i, { ...check, minChars: e.target.value })}
                          className={inputClasses + ' w-32'}
                        />
                      </div>
                      <label className="flex items-center gap-1.5 text-xs text-neutral-500">
                        <input
                          type="checkbox"
                          checked={check.allowToolOnly}
                          onChange={(e) => patchCheck(i, { ...check, allowToolOnly: e.target.checked })}
                          className="h-3.5 w-3.5 rounded border-white/[0.1] bg-white/[0.05] accent-emerald-500"
                        />
                        Allow tool-call-only responses
                      </label>
                    </div>
                  )}

                  {check.type === 'json_parse' && (
                    <p className="text-xs text-neutral-600">
                      Applies only when the request asked for JSON output; other requests skip this check.
                    </p>
                  )}

                  {check.type === 'tool_call_shape' && (
                    <label className="flex items-center gap-1.5 text-xs text-neutral-500">
                      <input
                        type="checkbox"
                        checked={check.requireJsonArguments}
                        onChange={(e) => patchCheck(i, { ...check, requireJsonArguments: e.target.checked })}
                        className="h-3.5 w-3.5 rounded border-white/[0.1] bg-white/[0.05] accent-emerald-500"
                      />
                      Require tool-call arguments to parse as JSON
                    </label>
                  )}
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => patchDraft({ checks: [...draft.checks, newCheckDraft('stop_reason')] })}
              disabled={draft.checks.length >= QUALITY_GATE_MAX_CHECKS}
              className="inline-flex items-center gap-1 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-xs font-medium text-neutral-400 transition-all hover:bg-white/[0.06] hover:text-neutral-300 disabled:cursor-not-allowed disabled:opacity-40"
            >
              + Add Check
            </button>
            {draft.checks.length === 0 && (
              <p className="text-xs text-neutral-600">No checks yet — a gate needs at least one.</p>
            )}
          </div>

          {/* Billing acknowledgement — deliberately unchecked by default. The gate
              type requires `multi_attempt_billing_ack: true` and rejects absent or
              false values, so consent can never be acquired by omission. */}
          <div className="space-y-1.5 rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-3">
            <label className="flex items-start gap-2 text-xs text-neutral-400">
              <input
                type="checkbox"
                aria-label="Acknowledge multi-attempt billing"
                checked={draft.billingAck}
                onChange={(e) => patchDraft({ billingAck: e.target.checked })}
                className="mt-0.5 h-3.5 w-3.5 rounded border-white/[0.1] bg-white/[0.05] accent-amber-500"
              />
              <span>
                I understand that a quality gate may dispatch <strong>several paid provider attempts</strong> for
                a single request, and each dispatched attempt is billable even when its output is rejected.
              </span>
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
