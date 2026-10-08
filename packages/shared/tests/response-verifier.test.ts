import { describe, expect, it } from 'vitest';
import {
  QUALITY_GATE_MAX_CHECKS,
  QUALITY_GATE_MAX_CONFIG_BYTES,
  getVerifierSignalCapabilities,
  hasMultiAttemptBillingAck,
  requestedJsonFromResponseFormat,
  validateQualityGateConfig,
  verifyResponse,
  type ProviderOutcomeSignals,
  type QualityGateConfig,
  type VerifierRequestContext,
} from '../src/response-verifier';
import type { CanonicalResponse, CanonicalResponseFormat, CanonicalToolCall } from '../src/types';
import type { TokenUsage } from '../src/token-usage';

const usage: TokenUsage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };

function response(overrides: Partial<CanonicalResponse> = {}): CanonicalResponse {
  return {
    id: 'resp_1',
    model: 'gpt-5.4',
    content: 'A complete, non-empty answer.',
    stop_reason: 'end',
    usage,
    ...overrides,
  };
}

function signals(overrides: Partial<ProviderOutcomeSignals> = {}): ProviderOutcomeSignals {
  return {
    provider: 'openai',
    raw_stop_reason: 'stop',
    refusal: null,
    safety_blocked: null,
    prompt_block_reason: null,
    provider_parse_status: 'parsed',
    unknown_fields_present: false,
    ...overrides,
  };
}

const ctx: VerifierRequestContext = { requested_json: false };

function gate(checks: QualityGateConfig['checks'], overrides: Partial<QualityGateConfig> = {}): QualityGateConfig {
  return { version: 1, mode: 'cascade', on_stream: 'reject', unknown_signal: 'reject', checks, ...overrides };
}

function toolCall(overrides: Partial<CanonicalToolCall> = {}): CanonicalToolCall {
  return { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' }, ...overrides };
}

describe('verifyResponse — pass behavior', () => {
  it('returns pass with one CheckResult per configured check when all pass', () => {
    const g = gate([
      { type: 'nonempty_content', min_chars: 1 },
      { type: 'tool_call_shape', require_json_arguments: true },
    ]);
    const result = verifyResponse(g, response(), signals(), ctx);
    expect(result.kind).toBe('pass');
    if (result.kind === 'pass') {
      expect(result.checks).toHaveLength(2);
      expect(result.checks.map((c) => c.check_type)).toEqual(['nonempty_content', 'tool_call_shape']);
      expect(result.checks.every((c) => c.passed)).toBe(true);
    }
  });
});

describe('verifyResponse — precedence', () => {
  it('provider parse failure rejects before any configured check', () => {
    const g = gate([{ type: 'nonempty_content', min_chars: 1 }]);
    const result = verifyResponse(g, response({ content: '' }), signals({ provider_parse_status: 'failed' }), ctx);
    expect(result).toEqual({ kind: 'reject', code: 'quality_gate_provider_response_parse_failed', check_index: -1 });
  });

  it('a known refusal is terminal and beats an unknown signal', () => {
    const g = gate([{ type: 'nonempty_content', min_chars: 1 }]);
    const result = verifyResponse(g, response(), signals({ refusal: true, unknown_fields_present: true }), ctx);
    expect(result).toEqual({ kind: 'terminal', code: 'quality_gate_refusal_terminal' });
  });

  it('a known safety block is terminal', () => {
    const g = gate([{ type: 'nonempty_content', min_chars: 1 }]);
    const result = verifyResponse(g, response(), signals({ safety_blocked: true }), ctx);
    expect(result).toEqual({ kind: 'terminal', code: 'quality_gate_safety_terminal' });
  });

  it("normalized stop_reason 'safety' is terminal even without an explicit signal", () => {
    const g = gate([{ type: 'nonempty_content', min_chars: 1 }]);
    const result = verifyResponse(g, response({ stop_reason: 'safety' }), signals(), ctx);
    expect(result).toEqual({ kind: 'terminal', code: 'quality_gate_safety_terminal' });
  });

  it('an unknown provider signal rejects (v1 unknown_signal=reject)', () => {
    const g = gate([{ type: 'nonempty_content', min_chars: 1 }]);
    const result = verifyResponse(g, response(), signals({ unknown_fields_present: true }), ctx);
    expect(result).toEqual({ kind: 'reject', code: 'quality_gate_unknown_provider_signal', check_index: -1 });
  });
});

describe('verifyResponse — stop_reason check', () => {
  it('rejects max_tokens with quality_gate_max_tokens', () => {
    const g = gate([{ type: 'stop_reason', reject: ['max_tokens'] }]);
    const result = verifyResponse(g, response({ stop_reason: 'max_tokens' }), signals({ raw_stop_reason: 'length' }), ctx);
    expect(result).toEqual({ kind: 'reject', code: 'quality_gate_max_tokens', check_index: 0 });
  });

  it('passes when stop_reason is not in the reject list', () => {
    const g = gate([{ type: 'stop_reason', reject: ['max_tokens'] }]);
    const result = verifyResponse(g, response({ stop_reason: 'end' }), signals(), ctx);
    expect(result.kind).toBe('pass');
  });
});

describe('verifyResponse — nonempty_content check', () => {
  it('treats Unicode-whitespace-only content as empty', () => {
    const g = gate([{ type: 'nonempty_content', min_chars: 1 }]);
    const result = verifyResponse(g, response({ content: '\u00A0\u2003\uFEFF\n' }), signals(), ctx);
    expect(result).toEqual({ kind: 'reject', code: 'quality_gate_empty_content', check_index: 0 });
  });

  it('passes content meeting min_chars after trimming', () => {
    const g = gate([{ type: 'nonempty_content', min_chars: 3 }]);
    const result = verifyResponse(g, response({ content: '  abc  ' }), signals(), ctx);
    expect(result.kind).toBe('pass');
  });

  it('tool-only output passes with allow_tool_only and a valid tool call', () => {
    const g = gate([{ type: 'nonempty_content', min_chars: 1, allow_tool_only: true }]);
    const result = verifyResponse(g, response({ content: '', tool_calls: [toolCall()] }), signals(), ctx);
    expect(result.kind).toBe('pass');
  });

  it('tool-only output is rejected without allow_tool_only', () => {
    const g = gate([{ type: 'nonempty_content', min_chars: 1 }]);
    const result = verifyResponse(g, response({ content: '', tool_calls: [toolCall()] }), signals(), ctx);
    expect(result).toEqual({ kind: 'reject', code: 'quality_gate_empty_content', check_index: 0 });
  });

  it('tool-only output is rejected when the tool call is malformed even with allow_tool_only', () => {
    const g = gate([{ type: 'nonempty_content', min_chars: 1, allow_tool_only: true }]);
    const bad = toolCall({ function: { name: 'get_weather', arguments: '' } });
    const result = verifyResponse(g, response({ content: '', tool_calls: [bad] }), signals(), ctx);
    expect(result).toEqual({ kind: 'reject', code: 'quality_gate_empty_content', check_index: 0 });
  });
});

describe('verifyResponse — json_parse check', () => {
  const jsonCtx: VerifierRequestContext = { requested_json: true };

  it('accepts valid JSON when the request asked for JSON', () => {
    const g = gate([{ type: 'json_parse', when: 'response_format_json' }]);
    const result = verifyResponse(g, response({ content: '{"ok":true}' }), signals(), jsonCtx);
    expect(result.kind).toBe('pass');
  });

  it('rejects invalid JSON when the request asked for JSON', () => {
    const g = gate([{ type: 'json_parse', when: 'response_format_json' }]);
    const result = verifyResponse(g, response({ content: '{not json' }), signals(), jsonCtx);
    expect(result).toEqual({ kind: 'reject', code: 'quality_gate_invalid_json', check_index: 0 });
  });

  it('is skipped (passes) when the request did not ask for JSON', () => {
    const g = gate([{ type: 'json_parse', when: 'response_format_json' }]);
    const result = verifyResponse(g, response({ content: '{not json' }), signals(), ctx);
    expect(result.kind).toBe('pass');
  });
});

describe('verifyResponse — tool_call_shape check', () => {
  it('passes when there are no tool calls (vacuous)', () => {
    const g = gate([{ type: 'tool_call_shape', require_json_arguments: true }]);
    const result = verifyResponse(g, response({ tool_calls: [] }), signals(), ctx);
    expect(result.kind).toBe('pass');
  });

  it('rejects a tool call with empty arguments', () => {
    const g = gate([{ type: 'tool_call_shape' }]);
    const bad = toolCall({ function: { name: 'f', arguments: '' } });
    const result = verifyResponse(g, response({ tool_calls: [bad] }), signals(), ctx);
    expect(result).toEqual({ kind: 'reject', code: 'quality_gate_invalid_tool_call', check_index: 0 });
  });

  it('rejects non-JSON arguments only when require_json_arguments is set', () => {
    const nonJson = toolCall({ function: { name: 'f', arguments: 'plain-text' } });
    const strict = gate([{ type: 'tool_call_shape', require_json_arguments: true }]);
    const lax = gate([{ type: 'tool_call_shape' }]);
    expect(verifyResponse(strict, response({ tool_calls: [nonJson] }), signals(), ctx)).toEqual({
      kind: 'reject',
      code: 'quality_gate_invalid_tool_call',
      check_index: 0,
    });
    expect(verifyResponse(lax, response({ tool_calls: [nonJson] }), signals(), ctx).kind).toBe('pass');
  });
});

describe('verifyResponse — determinism and engine safety', () => {
  it('first failure wins when multiple checks fail', () => {
    const g = gate([
      { type: 'nonempty_content', min_chars: 100 },
      { type: 'json_parse', when: 'response_format_json' },
    ]);
    const result = verifyResponse(g, response({ content: 'short' }), signals(), { requested_json: true });
    expect(result).toEqual({ kind: 'reject', code: 'quality_gate_empty_content', check_index: 0 });
  });

  it('produces the same verdict independent of provider name', () => {
    const g = gate([{ type: 'stop_reason', reject: ['max_tokens'] }]);
    const r = response({ stop_reason: 'max_tokens' });
    const a = verifyResponse(g, r, signals({ provider: 'openai', raw_stop_reason: 'length' }), ctx);
    const b = verifyResponse(g, r, signals({ provider: 'anthropic', raw_stop_reason: 'length' }), ctx);
    expect(a).toEqual(b);
  });

  it('an engine exception is engine_error, distinct from quality rejection', () => {
    const throwingResponse: CanonicalResponse = {
      id: 'x',
      model: 'm',
      stop_reason: 'end',
      usage,
      get content(): string {
        throw new Error('synthetic verifier input failure');
      },
    };
    const g = gate([{ type: 'nonempty_content', min_chars: 1 }]);
    const result = verifyResponse(g, throwingResponse, signals(), ctx);
    expect(result).toEqual({ kind: 'engine_error', code: 'quality_gate_verifier_error' });
  });
});

describe('validateQualityGateConfig', () => {
  const valid: QualityGateConfig = {
    version: 1,
    mode: 'cascade',
    on_stream: 'reject',
    unknown_signal: 'reject',
    multi_attempt_billing_ack: true,
    checks: [
      { type: 'stop_reason', reject: ['max_tokens'] },
      { type: 'nonempty_content', min_chars: 1, allow_tool_only: true },
      { type: 'json_parse', when: 'response_format_json' },
      { type: 'tool_call_shape', require_json_arguments: true },
    ],
  };

  it('accepts a valid config and round-trips it without mutation', () => {
    const snapshot = JSON.parse(JSON.stringify(valid));
    const result = validateQualityGateConfig(valid);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config).toEqual(snapshot);
    expect(valid).toEqual(snapshot); // input not mutated
  });

  const cases: Array<[string, unknown]> = [
    ['non-object', 'cascade'],
    ['null', null],
    ['array', []],
    ['wrong version', { ...valid, version: 2 }],
    ['wrong mode', { ...valid, mode: 'shadow' }],
    // Keeps multi_attempt_billing_ack so this case still fails on the MISSING
    // on_stream it names, not on the ack.
    ['missing on_stream', { version: 1, mode: 'cascade', unknown_signal: 'reject', multi_attempt_billing_ack: true, checks: valid.checks }],
    ['bad on_stream', { ...valid, on_stream: 'maybe' }],
    ['unknown_signal not reject', { ...valid, unknown_signal: 'allow' }],
    ['unknown top-level field', { ...valid, billing: 'customer' }],
    ['empty checks', { ...valid, checks: [] }],
    ['missing checks', { version: 1, mode: 'cascade', on_stream: 'reject', unknown_signal: 'reject', multi_attempt_billing_ack: true }],
    // RSH-134 §6 Q1 — consent cannot be acquired by omission or coercion.
    ['missing multi_attempt_billing_ack', { version: 1, mode: 'cascade', on_stream: 'reject', unknown_signal: 'reject', checks: valid.checks }],
    ['multi_attempt_billing_ack false', { ...valid, multi_attempt_billing_ack: false }],
    ['multi_attempt_billing_ack truthy string', { ...valid, multi_attempt_billing_ack: 'yes' }],
    ['multi_attempt_billing_ack truthy number', { ...valid, multi_attempt_billing_ack: 1 }],
    ['too many checks', { ...valid, checks: Array.from({ length: QUALITY_GATE_MAX_CHECKS + 1 }, () => ({ type: 'nonempty_content', min_chars: 1 })) }],
    ['unknown check type', { ...valid, checks: [{ type: 'llm_judge' }] }],
    ['unknown check field', { ...valid, checks: [{ type: 'nonempty_content', min_chars: 1, regex: '.*' }] }],
    ['stop_reason unsupported reject value', { ...valid, checks: [{ type: 'stop_reason', reject: ['refusal'] }] }],
    ['stop_reason empty reject', { ...valid, checks: [{ type: 'stop_reason', reject: [] }] }],
    ['nonempty_content zero min_chars', { ...valid, checks: [{ type: 'nonempty_content', min_chars: 0 }] }],
    ['nonempty_content non-integer min_chars', { ...valid, checks: [{ type: 'nonempty_content', min_chars: 1.5 }] }],
    ['json_parse wrong when', { ...valid, checks: [{ type: 'json_parse', when: 'always' }] }],
    ['tool_call_shape non-boolean flag', { ...valid, checks: [{ type: 'tool_call_shape', require_json_arguments: 'yes' }] }],
  ];

  it.each(cases)('rejects: %s', (_label, input) => {
    const result = validateQualityGateConfig(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });

  it('rejects an oversized config', () => {
    const huge = { ...valid, checks: [{ type: 'nonempty_content', min_chars: 1, allow_tool_only: true, padding: 'x'.repeat(QUALITY_GATE_MAX_CONFIG_BYTES) }] };
    const result = validateQualityGateConfig(huge);
    expect(result.ok).toBe(false);
  });

  // The rejection is the only moment an operator is told a gate costs more than
  // one attempt (quality_gate has no dashboard surface), so the message has to
  // say so rather than just naming the field.
  it('states the multi-attempt cost consequence when the ack is missing', () => {
    const { multi_attempt_billing_ack: _omitted, ...noAck } = valid;
    const result = validateQualityGateConfig(noAck);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('multi_attempt_billing_ack');
      expect(result.error).toMatch(/several paid provider attempts/i);
      expect(result.error).toMatch(/billable even when its output is rejected/i);
    }
  });
});

describe('hasMultiAttemptBillingAck (RSH-134 read-side gate)', () => {
  const base = {
    version: 1, mode: 'cascade', on_stream: 'reject', unknown_signal: 'reject',
    checks: [{ type: 'nonempty_content', min_chars: 1 }],
  } as unknown as QualityGateConfig;

  it('is true only for an exact boolean true', () => {
    expect(hasMultiAttemptBillingAck({ ...base, multi_attempt_billing_ack: true })).toBe(true);
  });

  it('is false for undefined gate', () => {
    expect(hasMultiAttemptBillingAck(undefined)).toBe(false);
  });

  // The case that matters: a gate persisted BEFORE the field existed. The write
  // gate never re-runs on read, so without this the stored config would cascade
  // unacknowledged.
  it('is false for a legacy gate stored without the field', () => {
    expect(hasMultiAttemptBillingAck(base)).toBe(false);
  });

  it.each([false, 'true', 1, {}, null])('is false for truthy/near-miss value %p', (value) => {
    expect(hasMultiAttemptBillingAck({ ...base, multi_attempt_billing_ack: value } as unknown as QualityGateConfig)).toBe(false);
  });
});

describe('getVerifierSignalCapabilities', () => {
  it('returns documented capabilities for known providers', () => {
    expect(getVerifierSignalCapabilities('openai').preserves_refusal).toBe(true);
    expect(getVerifierSignalCapabilities('anthropic').preserves_refusal).toBe(true);
    expect(getVerifierSignalCapabilities('google').preserves_prompt_block_reason).toBe(true);
    expect(getVerifierSignalCapabilities('google').preserves_refusal).toBe(false);
  });

  it('returns all-false for an unknown provider (fail-loud default)', () => {
    const caps = getVerifierSignalCapabilities('some-new-provider');
    expect(caps.provider).toBe('some-new-provider');
    expect(caps.preserves_raw_stop_reason).toBe(false);
    expect(caps.preserves_refusal).toBe(false);
    expect(caps.preserves_safety_blocked).toBe(false);
    expect(caps.preserves_prompt_block_reason).toBe(false);
  });
});

describe('requestedJsonFromResponseFormat', () => {
  const jsonFormats: CanonicalResponseFormat[] = [
    { type: 'json' },
    { type: 'json_object' },
    { type: 'json_schema', json_schema: { name: 'x', schema: {} } },
  ];
  it('is true for json/json_object/json_schema', () => {
    for (const f of jsonFormats) expect(requestedJsonFromResponseFormat(f)).toBe(true);
  });
  it('is false for text and undefined', () => {
    expect(requestedJsonFromResponseFormat({ type: 'text' })).toBe(false);
    expect(requestedJsonFromResponseFormat(undefined)).toBe(false);
  });
});
