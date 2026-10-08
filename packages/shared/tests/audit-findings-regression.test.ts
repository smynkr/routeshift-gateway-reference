import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProviderPreferences } from '../src/provider-preferences';
import {
  getVerifierSignalCapabilities,
  verifyResponse,
  type ProviderOutcomeSignals,
  type QualityGateConfig,
  type VerifierRequestContext,
} from '../src/response-verifier';
import type { CanonicalResponse, CanonicalToolCall } from '../src/types';
import type { TokenUsage } from '../src/token-usage';

const repoRoot = join(__dirname, '..', '..', '..');
const read = (path: string) => readFileSync(join(repoRoot, path), 'utf8');

describe('audit finding regressions', () => {
  it('rejects provider.sort=latency at parse/type boundary until deterministic latency ranking exists', () => {
    expect(parseProviderPreferences({ sort: 'latency' })).toEqual({ ok: false, reason: 'invalid_provider_prefs' });
  });

  it('compose healthcheck uses a real GET or server handles HEAD /health', () => {
    const compose = read('docker-compose.yml');
    const server = read('apps/proxy/src/server.ts');

    const composeUsesGet = compose.includes('wget -q -O /dev/null http://localhost:4000/health') ||
      compose.includes('wget", "-q", "-O", "/dev/null", "http://localhost:4000/health"');
    const serverHandlesHead = server.includes("(req.method === 'GET' || req.method === 'HEAD') && path === '/health'");

    expect(composeUsesGet || serverHandlesHead).toBe(true);
  });

  it('routeshift connect does not auto-configure unsupported Claude Code protocol after only warning', () => {
    const cli = read('packages/connect/src/cli.ts');
    const claudeTool = read('packages/connect/src/tools/claude-code.ts');

    expect(claudeTool).toContain("protocol: 'anthropic'");
    expect(cli).toContain('Claude Code support requires RouteShift Anthropic /v1/messages');
    expect(cli).not.toContain('real Claude Code traffic needs the');
  });
});

describe('RSH-72 response-verifier gauntlet regressions (PR #152)', () => {
  const usage: TokenUsage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };
  const mkResponse = (overrides: Partial<CanonicalResponse> = {}): CanonicalResponse => ({
    id: 'resp_1',
    model: 'gpt-5.4',
    content: 'A complete, non-empty answer.',
    stop_reason: 'end',
    usage,
    ...overrides,
  });
  const mkSignals = (overrides: Partial<ProviderOutcomeSignals> = {}): ProviderOutcomeSignals => ({
    provider: 'openai',
    raw_stop_reason: 'stop',
    refusal: null,
    safety_blocked: null,
    prompt_block_reason: null,
    provider_parse_status: 'parsed',
    unknown_fields_present: false,
    ...overrides,
  });
  const ctx: VerifierRequestContext = { requested_json: false };
  const gate = (checks: QualityGateConfig['checks']): QualityGateConfig => ({
    version: 1,
    mode: 'cascade',
    on_stream: 'reject',
    unknown_signal: 'reject',
    multi_attempt_billing_ack: true,
    checks,
  });
  const validToolCall: CanonicalToolCall = {
    id: 'call_1',
    type: 'function',
    function: { name: 'get_weather', arguments: '{"city":"SF"}' },
  };

  it('capability lookup for Object.prototype names returns the all-false fallback, not an inherited member', () => {
    for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
      const caps = getVerifierSignalCapabilities(name);
      expect(caps.provider).toBe(name);
      expect(caps.preserves_raw_stop_reason).toBe(false);
      expect(caps.preserves_refusal).toBe(false);
      expect(caps.preserves_safety_blocked).toBe(false);
      expect(caps.preserves_prompt_block_reason).toBe(false);
    }
  });

  it('capability entries are frozen so callers cannot mutate module state (purity preserved)', () => {
    const caps = getVerifierSignalCapabilities('google');
    expect(Object.isFrozen(caps)).toBe(true);
    expect(() => {
      caps.preserves_refusal = true;
    }).toThrow();
    expect(getVerifierSignalCapabilities('google').preserves_refusal).toBe(false);
  });

  it('a null item in tool_calls rejects as invalid_tool_call, not engine_error', () => {
    const result = verifyResponse(
      gate([{ type: 'tool_call_shape' }]),
      mkResponse({ tool_calls: [null as unknown as CanonicalToolCall] }),
      mkSignals(),
      ctx,
    );
    expect(result).toEqual({ kind: 'reject', code: 'quality_gate_invalid_tool_call', check_index: 0 });
  });

  it('a null tool-call item under allow_tool_only rejects as empty_content, not engine_error', () => {
    const result = verifyResponse(
      gate([{ type: 'nonempty_content', min_chars: 1, allow_tool_only: true }]),
      mkResponse({ content: '', tool_calls: [null as unknown as CanonicalToolCall] }),
      mkSignals(),
      ctx,
    );
    expect(result).toEqual({ kind: 'reject', code: 'quality_gate_empty_content', check_index: 0 });
  });

  it('allow_tool_only passes a tool-calling response below min_chars (deliberately not empty-content-only)', () => {
    const result = verifyResponse(
      gate([{ type: 'nonempty_content', min_chars: 100, allow_tool_only: true }]),
      mkResponse({ content: 'x', tool_calls: [validToolCall] }),
      mkSignals(),
      ctx,
    );
    expect(result.kind).toBe('pass');
  });
});
