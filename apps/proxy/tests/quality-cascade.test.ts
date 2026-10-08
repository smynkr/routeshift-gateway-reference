import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CanonicalRequest, CanonicalResponse, TokenUsage } from '@routeshift/shared';
import { ProxyError, type ProviderOutcomeSignals, type QualityGateConfig } from '@routeshift/shared';
import type { LLMProvider } from '../src/providers/types.js';
import {
  executeAttempt,
  auditFromOutcome,
  executeQualityCascade,
  aggregateActualCostMicrocents,
  isAggregateActualCostKnown,
  aggregateUnknownCostAttempts,
  type AttemptAudit,
  type AttemptOutcome,
} from '../src/routing/quality-cascade.js';

const circuitMock = vi.hoisted(() => ({
  isOpen: vi.fn(() => false),
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
}));
vi.mock('../src/routing/circuit-breaker.js', () => ({ circuitBreaker: circuitMock }));

const usage: TokenUsage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };

const okCanonical: CanonicalResponse = {
  id: 'r1', model: 'gpt-4.1', content: 'A complete answer.', stop_reason: 'end', usage,
};
const okSignals: ProviderOutcomeSignals = {
  provider: 'openai', raw_stop_reason: 'stop', refusal: null, safety_blocked: null,
  prompt_block_reason: null, provider_parse_status: 'parsed', unknown_fields_present: false,
};

const gate: QualityGateConfig = {
  version: 1, mode: 'cascade', on_stream: 'reject', unknown_signal: 'reject',
  multi_attempt_billing_ack: true,
  checks: [{ type: 'nonempty_content', min_chars: 1 }],
};

const canonical: CanonicalRequest = { model: 'gpt-4.1', messages: [], stream: false };
const computeCost = (u: TokenUsage) => u.output_tokens * 100;

function fakeProvider(canonicalResp: CanonicalResponse, signals: ProviderOutcomeSignals): LLMProvider {
  return {
    id: signals.provider,
    buildRequest: () => ({ url: 'http://fake.test/v1/chat', method: 'POST', headers: {}, body: '{}' }),
    parseResponse: () => canonicalResp,
    parseOutcomeSignals: () => signals,
    parseStreamChunk: () => null,
    extractUsage: () => canonicalResp.usage,
    normalizeError: (status: number) => new ProxyError('fake error', status, false, signals.provider),
  };
}

function fetchReturning(body: unknown, status = 200): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  })) as unknown as typeof fetch;
}

function fetchThrowing(err: Error): typeof fetch {
  return async () => { throw err; };
}

function run(overrides: Partial<Parameters<typeof executeAttempt>[0]> = {}) {
  return executeAttempt({
    provider: fakeProvider(okCanonical, okSignals),
    providerId: 'openai',
    model: 'gpt-4.1',
    canonical,
    apiKey: 'k',
    gate,
    computeCost,
    fetchImpl: fetchReturning({ ok: true }),
    ...overrides,
  });
}

describe('executeAttempt (RSH-72 Phase 2 per-attempt executor)', () => {
  it('returns verified for a 200 that passes the gate, with actual microcent cost', async () => {
    const outcome = await run();
    expect(outcome.kind).toBe('verified');
    if (outcome.kind === 'verified') {
      expect(outcome.actualCostMicrocents).toBe(500);
      expect(outcome.canonical.content).toBe('A complete answer.');
      expect(outcome.usage).toEqual(usage);
    }
  });

  it('returns quality_rejected (exact code + check index) when a check fails', async () => {
    const outcome = await run({ provider: fakeProvider({ ...okCanonical, content: '' }, okSignals) });
    expect(outcome.kind).toBe('quality_rejected');
    if (outcome.kind === 'quality_rejected') {
      expect(outcome.reasonCode).toBe('quality_gate_empty_content');
      expect(outcome.checkIndex).toBe(0);
      expect(outcome.actualCostMicrocents).toBe(500);
    }
  });

  it('marks a 5xx HTTP attempt as an unknown-cost retryable failure', async () => {
    const outcome = await run({ fetchImpl: fetchReturning({ error: 'upstream' }, 503) });
    expect(outcome).toEqual({
      kind: 'retryable_http', provider: 'openai', model: 'gpt-4.1', status: 503, actualCostKnown: false,
    });
  });

  it.each([429, 400])('keeps HTTP %i as an exact known-zero attempt', async (status) => {
    const outcome = await run({ fetchImpl: fetchReturning({ error: 'upstream' }, status) });
    expect(outcome).toEqual({
      kind: 'retryable_http', provider: 'openai', model: 'gpt-4.1', status, actualCostKnown: true,
    });
  });

  it('returns transport_error when fetch throws', async () => {
    const outcome = await run({ fetchImpl: fetchThrowing(new Error('network down')) });
    expect(outcome.kind).toBe('transport_error');
    if (outcome.kind === 'transport_error') {
      expect(outcome.reasonCode).toContain('network down');
      expect(outcome.actualCostKnown).toBe(false);
    }
  });

  it('returns transport_error when buildRequest throws', async () => {
    const provider = fakeProvider(okCanonical, okSignals);
    provider.buildRequest = () => { throw new Error('Bedrock requires stream:false'); };
    const outcome = await run({ provider, providerId: 'bedrock' });
    expect(outcome.kind).toBe('transport_error');
    if (outcome.kind === 'transport_error') expect(outcome.reasonCode).toContain('stream:false');
  });

  it('returns terminal refusal carrying usage + cost + 200 (real spend is audited)', async () => {
    const outcome = await run({ provider: fakeProvider(okCanonical, { ...okSignals, refusal: true }) });
    expect(outcome.kind).toBe('terminal');
    if (outcome.kind === 'terminal') {
      expect(outcome.reasonCode).toBe('quality_gate_refusal_terminal');
      expect(outcome.statusCode).toBe(200);
      expect(outcome.usage).toEqual(usage);
      expect(outcome.actualCostMicrocents).toBe(500);
    }
  });

  it('returns terminal safety for a safety-blocked signal', async () => {
    const outcome = await run({ provider: fakeProvider(okCanonical, { ...okSignals, safety_blocked: true }) });
    expect(outcome.kind).toBe('terminal');
    if (outcome.kind === 'terminal') expect(outcome.reasonCode).toBe('quality_gate_safety_terminal');
  });

  it('treats an unparseable 200 body as quality_rejected parse-failed when gated', async () => {
    const outcome = await run({ fetchImpl: fetchReturning('not valid json') });
    expect(outcome.kind).toBe('quality_rejected');
    if (outcome.kind === 'quality_rejected') {
      expect(outcome.reasonCode).toBe('quality_gate_provider_response_parse_failed');
      expect(outcome.checkIndex).toBe(-1);
      // Pricing EMPTY_USAGE at 0 is not proof the provider ran for free.
      expect(outcome.actualCostKnown).toBe(false);
    }
  });

  it('treats an unparseable 200 body as transport_error when NOT gated', async () => {
    const outcome = await run({ gate: undefined, fetchImpl: fetchReturning('not valid json') });
    expect(outcome.kind).toBe('transport_error');
    if (outcome.kind === 'transport_error') expect(outcome.reasonCode).toBe('provider_response_parse_failed');
  });

  it('returns verified for a parsed 200 when there is no gate', async () => {
    const outcome = await run({ gate: undefined });
    expect(outcome.kind).toBe('verified');
  });

  it('treats an adapter parseResponse throw on a 200 as quality_rejected parse-failed when gated', async () => {
    const throwing = fakeProvider(okCanonical, okSignals);
    throwing.parseResponse = () => { throw new TypeError('Cannot read properties of undefined'); };
    const outcome = await run({ provider: throwing });
    expect(outcome.kind).toBe('quality_rejected');
    if (outcome.kind === 'quality_rejected') {
      expect(outcome.reasonCode).toBe('quality_gate_provider_response_parse_failed');
      expect(outcome.checkIndex).toBe(-1);
    }
  });

  it('does not false-reject a parsed 200 from an adapter without parseOutcomeSignals', async () => {
    const noSignals = fakeProvider(okCanonical, okSignals);
    delete (noSignals as { parseOutcomeSignals?: unknown }).parseOutcomeSignals;
    const outcome = await run({ provider: noSignals });
    expect(outcome.kind).toBe('verified');
  });
});

describe('auditFromOutcome (sanitized attempt audit)', () => {
  it('builds a quality_rejected row with exact code, check index, 200 status, and cost', () => {
    const rejected: AttemptOutcome = {
      kind: 'quality_rejected', provider: 'openai', model: 'gpt-4.1',
      reasonCode: 'quality_gate_empty_content', checkIndex: 0,
      signals: okSignals,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      actualCostMicrocents: 500, actualCostKnown: true,
    };
    expect(auditFromOutcome(rejected, 1, 123, false)).toEqual({
      attempt_index: 1, provider: 'openai', model: 'gpt-4.1', outcome: 'quality_rejected',
      reason_code: 'quality_gate_empty_content', check_index: 0, status_code: 200,
      input_tokens: 10, output_tokens: 5, actual_cost_microcents: 500, actual_cost_known: true, latency_ms: 123, circuit_failure: false,
    });
  });

  it('preserves provider reasoning telemetry on the sanitized audit row', () => {
    const verified: AttemptOutcome = {
      kind: 'verified', provider: 'openai', model: 'o3',
      canonical: okCanonical, signals: okSignals, rawBody: {},
      usage: { input_tokens: 10, output_tokens: 5, reasoning_tokens: 7, total_tokens: 15 },
      actualCostMicrocents: 542, actualCostKnown: true,
    };

    expect(auditFromOutcome(verified, 0, 123, false)).toEqual(expect.objectContaining({
      reasoning_tokens: 7,
    }));
    expect(auditFromOutcome(verified, 0, 123, false).reasoning_cost_microcents).toBeUndefined();
  });

  it('builds a retryable row with transport code and zero cost', () => {
    const retryable: AttemptOutcome = {
      kind: 'retryable_http', provider: 'openai', model: 'gpt-4.1',
      status: 429, actualCostKnown: true,
    };
    const audit = auditFromOutcome(retryable, 2, 50, true);
    expect(audit.reason_code).toBe('HTTP 429');
    expect(audit.status_code).toBe(429);
    expect(audit.actual_cost_microcents).toBe(0);
    expect(audit.circuit_failure).toBe(true);
  });
  it('builds a terminal row that records the real usage, cost, and 200 status', () => {
    const terminal: AttemptOutcome = {
      kind: 'terminal', provider: 'anthropic', model: 'claude', reasonCode: 'quality_gate_refusal_terminal',
      usage, actualCostMicrocents: 500, actualCostKnown: true, statusCode: 200,
    };
    expect(auditFromOutcome(terminal, 0, 80, false)).toEqual({
      attempt_index: 0, provider: 'anthropic', model: 'claude', outcome: 'terminal',
      reason_code: 'quality_gate_refusal_terminal', check_index: null, status_code: 200,
      input_tokens: 10, output_tokens: 5, actual_cost_microcents: 500, actual_cost_known: true, latency_ms: 80, circuit_failure: false,
    });
  });
});

describe('executeQualityCascade (RSH-72 Phase 2 cascade)', () => {
  const emptyCanonical: CanonicalResponse = { ...okCanonical, content: '' };
  const refusalSignals: ProviderOutcomeSignals = { ...okSignals, refusal: true };
  const providers: Record<string, LLMProvider> = {
    openai: fakeProvider(okCanonical, okSignals),
    'openai-empty': fakeProvider(emptyCanonical, okSignals),
    'openai-refusal': fakeProvider(okCanonical, refusalSignals),
    anthropic: fakeProvider(okCanonical, { ...okSignals, provider: 'anthropic' }),
    'anthropic-empty': fakeProvider(emptyCanonical, { ...okSignals, provider: 'anthropic' }),
  };
  const getProvider = (id: string) => providers[id];
  const getProviderConfig = () => ({ key: 'k', metadata: {}, label: 'cascade-key' });
  const cascadeCost = (_p: string, _m: string, u: TokenUsage) => u.output_tokens * 100;
  const ok200 = fetchReturning({ ok: true });
  const lifecycle = {
    start: vi.fn(),
    finish: vi.fn(),
    rateLimited: vi.fn(),
  };

  function cascade(overrides: Partial<Parameters<typeof executeQualityCascade>[0]> = {}) {
    return executeQualityCascade({
      canonical,
      gate,
      primary: { provider: 'openai', model: 'gpt-4.1' },
      primaryConfig: getProviderConfig(),
      fallbackChain: [],
      getProvider,
      getProviderConfig,
      computeCost: cascadeCost,
      fetchImpl: ok200,
      onAttemptStart: lifecycle.start,
      onAttemptFinish: lifecycle.finish,
      onAttemptRateLimited: lifecycle.rateLimited,
      ...overrides,
    });
  }

  beforeEach(() => {
    circuitMock.isOpen.mockReturnValue(false);
    circuitMock.recordSuccess.mockClear();
    circuitMock.recordFailure.mockClear();
    lifecycle.start.mockClear();
    lifecycle.finish.mockClear();
    lifecycle.rateLimited.mockClear();
  });

  it.each([undefined, '', '   '])('dispatches with an optional runtime credential label %j', async (label) => {
    const fetchMock = vi.fn(fetchReturning({ ok: true }));
    const malformedConfig = { key: 'k', metadata: {}, label } as unknown as {
      key: string; metadata: Record<string, unknown>; label?: string;
    };

    const result = await cascade({
      primaryConfig: malformedConfig,
      fetchImpl: fetchMock,
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lifecycle.start).toHaveBeenCalledWith({
      provider: 'openai', model: 'gpt-4.1', ...(typeof label === 'string' ? { credentialLabel: label } : {}),
    });
    expect(lifecycle.finish).toHaveBeenCalledTimes(1);
    expect(lifecycle.rateLimited).not.toHaveBeenCalled();
  });

  it('does not emit a lifecycle pair when request construction fails before dispatch', async () => {
    const provider = fakeProvider(okCanonical, okSignals);
    provider.buildRequest = () => { throw new Error('request construction failed'); };
    const fetchMock = vi.fn(fetchReturning({ ok: true }));

    const result = await cascade({
      getProvider: () => provider,
      fetchImpl: fetchMock,
    });

    expect(result.ok).toBe(false);
    expect(result.audit).toMatchObject([{
      outcome: 'transport_error',
      reason_code: 'Error: request construction failed',
    }]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lifecycle.start).not.toHaveBeenCalled();
    expect(lifecycle.finish).not.toHaveBeenCalled();
    expect(lifecycle.rateLimited).not.toHaveBeenCalled();
  });

  it('serves a verified primary without dispatching fallbacks', async () => {
    const result = await cascade({ fallbackChain: [{ provider: 'anthropic', model: 'claude' }] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.providerId).toBe('openai');
      expect(result.audit).toHaveLength(1);
      expect(result.audit[0].outcome).toBe('verified');
    }
  });

  it('propagates primaryConfig selected_after_cooldown_skip to the real dispatch lifecycle', async () => {
    const result = await cascade({
      primaryConfig: { key: 'primary-key', metadata: {}, label: 'primary-label', selected_after_cooldown_skip: true },
    });

    expect(result.ok).toBe(true);
    expect(lifecycle.start).toHaveBeenCalledWith({
      provider: 'openai', model: 'gpt-4.1', credentialLabel: 'primary-label', selectedAfterCooldownSkip: true,
    });
  });

  it('does not consume primaryConfig when the primary is skipped, resolving a same-provider fallback fresh', async () => {
    const fallbackConfig = { key: 'fallback-key', metadata: {}, label: 'fallback-label', selected_after_cooldown_skip: true };
    const getFallbackConfig = vi.fn(() => fallbackConfig);
    circuitMock.isOpen.mockImplementation((provider: string, model: string) => provider === 'openai' && model === 'primary-model');

    const result = await cascade({
      primary: { provider: 'openai', model: 'primary-model' },
      primaryConfig: { key: 'primary-key', metadata: {}, label: 'primary-label' },
      fallbackChain: [{ provider: 'openai', model: 'fallback-model' }],
      getProviderConfig: getFallbackConfig,
    });

    expect(result.ok).toBe(true);
    expect(getFallbackConfig).toHaveBeenCalledTimes(1);
    expect(getFallbackConfig).toHaveBeenCalledWith('openai');
    expect(lifecycle.start).toHaveBeenCalledWith({
      provider: 'openai', model: 'fallback-model', credentialLabel: 'fallback-label', selectedAfterCooldownSkip: true,
    });
  });

  it('resolves a same-provider fallback fresh after the primary dispatches', async () => {
    const fallbackConfig = { key: 'fallback-key', metadata: {}, label: 'fallback-label', selected_after_cooldown_skip: true };
    const getFallbackConfig = vi.fn(() => fallbackConfig);
    let calls = 0;
    const flaky = ((...args: Parameters<typeof fetch>) => {
      calls += 1;
      return calls === 1
        ? fetchReturning({ error: 'unavailable' }, 503)(...args)
        : fetchReturning({ ok: true })(...args);
    }) as unknown as typeof fetch;

    const result = await cascade({
      primaryConfig: { key: 'primary-key', metadata: {}, label: 'primary-label' },
      fallbackChain: [{ provider: 'openai', model: 'fallback-model' }],
      getProviderConfig: getFallbackConfig,
      fetchImpl: flaky,
    });

    expect(result.ok).toBe(true);
    expect(getFallbackConfig).toHaveBeenCalledTimes(1);
    expect(getFallbackConfig).toHaveBeenCalledWith('openai');
    expect(lifecycle.start.mock.calls).toEqual([
      [{ provider: 'openai', model: 'gpt-4.1', credentialLabel: 'primary-label' }],
      [{ provider: 'openai', model: 'fallback-model', credentialLabel: 'fallback-label', selectedAfterCooldownSkip: true }],
    ]);
  });

  it('refuses an unpriced credits primary before any dispatch or fallback', async () => {
    const fetchImpl = vi.fn();
    const result = await cascade({
      fallbackChain: [{ provider: 'anthropic', model: 'claude' }],
      fetchImpl,
      budget: {
        maxRetries: 1,
        requireKnownPricing: true,
        pricingResolver: async () => null,
      },
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'terminal',
      terminalReasonCode: 'missing_model_pricing',
      audit: [],
      aggregateCostMicrocents: 0,
      aggregateUnknownCostAttempts: 0,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('marks a fetch-rejected cascade attempt as unknown-cost', async () => {
    const result = await cascade({ fetchImpl: fetchThrowing(new Error('connection reset')) });
    expect(result.ok).toBe(false);
    expect(result.audit).toMatchObject([{ outcome: 'transport_error', actual_cost_known: false }]);
    expect(result.aggregateUnknownCostAttempts).toBe(1);
    expect(result.aggregateCostKnown).toBe(false);
  });

  it('advances past a quality-rejected primary to a verified fallback', async () => {
    const result = await cascade({
      primary: { provider: 'openai-empty', model: 'gpt-4.1' },
      fallbackChain: [{ provider: 'anthropic', model: 'claude' }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.providerId).toBe('anthropic');
      expect(result.audit.map((a) => a.outcome)).toEqual(['quality_rejected', 'verified']);
      expect(result.audit[0].reason_code).toBe('quality_gate_empty_content');
    }
  });

  it('stops immediately on a terminal primary (refusal) without dispatching fallbacks', async () => {
    const result = await cascade({
      primary: { provider: 'openai-refusal', model: 'gpt-4.1' },
      fallbackChain: [{ provider: 'anthropic', model: 'claude' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('terminal');
      expect(result.terminalReasonCode).toBe('quality_gate_refusal_terminal');
      expect(result.audit).toHaveLength(1);
    }
  });

  it('returns exhausted with an ordered audit when every candidate is quality-rejected', async () => {
    const result = await cascade({
      primary: { provider: 'openai-empty', model: 'gpt-4.1' },
      fallbackChain: [{ provider: 'anthropic-empty', model: 'claude' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('exhausted');
      expect(result.audit.map((a) => a.outcome)).toEqual(['quality_rejected', 'quality_rejected']);
    }
  });

  it('does not trip the circuit on a deterministic quality rejection', async () => {
    await cascade({ primary: { provider: 'openai-empty', model: 'gpt-4.1' } });
    expect(circuitMock.recordFailure).not.toHaveBeenCalled();
  });

  // Mirrors the ungated path: only 5xx/429 earn another paid attempt. A client
  // fault would fail identically on every candidate, so advancing just buys a
  // second failure.
  it('stops on a non-retryable 4xx instead of paying for a fallback attempt', async () => {
    const result = await cascade({
      primary: { provider: 'openai', model: 'gpt-4.1' },
      fallbackChain: [{ provider: 'anthropic', model: 'claude' }],
      fetchImpl: fetchReturning({ error: 'bad request' }, 400),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('terminal');
      expect(result.terminalStatusCode).toBe(400);
      expect(result.terminalReasonCode).toBe('HTTP 400');
    }
    // Only the primary was dispatched.
    expect(result.audit).toHaveLength(1);
    // A client fault is not a provider availability failure.
    expect(circuitMock.recordFailure).not.toHaveBeenCalled();
  });

  it('still advances past a 429 to the fallback', async () => {
    let calls = 0;
    const flaky = ((...args: Parameters<typeof fetch>) => {
      calls += 1;
      return calls === 1
        ? fetchReturning({ error: 'slow down' }, 429)(...args)
        : fetchReturning({ ok: true })(...args);
    }) as unknown as typeof fetch;
    const result = await cascade({
      primary: { provider: 'openai', model: 'gpt-4.1' },
      fallbackChain: [{ provider: 'anthropic', model: 'claude' }],
      fetchImpl: flaky,
    });
    expect(result.ok).toBe(true);
    expect(circuitMock.recordFailure).toHaveBeenCalledWith('openai', 'gpt-4.1');
  });

  it('reports exactly the credential that returned 429 to the handler', async () => {
    let calls = 0;
    const flaky = ((...args: Parameters<typeof fetch>) => {
      calls += 1;
      return calls === 1
        ? fetchReturning({ error: 'slow down' }, 429)(...args)
        : fetchReturning({ ok: true })(...args);
    }) as unknown as typeof fetch;

    await cascade({
      primaryConfig: { key: 'k', metadata: {}, label: 'openai-credential' },
      fallbackChain: [{ provider: 'anthropic', model: 'claude' }],
      getProviderConfig: (provider) => ({ key: 'k', metadata: {}, label: `${provider}-credential` }),
      fetchImpl: flaky,
    });

    expect(lifecycle.rateLimited).toHaveBeenCalledTimes(1);
    expect(lifecycle.rateLimited).toHaveBeenCalledWith({
      provider: 'openai', model: 'gpt-4.1', credentialLabel: 'openai-credential',
    });
  });

  it.each([400, 401, 403, 404])('does not cool down a non-429 HTTP %i response', async (status) => {
    await cascade({ fetchImpl: fetchReturning({ error: 'client fault' }, status) });

    expect(lifecycle.rateLimited).not.toHaveBeenCalled();
  });

  it('contains throwing observers so routing and the remaining lifecycle continue', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const events: string[] = [];
    let calls = 0;
    const flaky = ((...args: Parameters<typeof fetch>) => {
      calls += 1;
      return calls === 1
        ? fetchReturning({ error: 'slow down' }, 429)(...args)
        : fetchReturning({ ok: true })(...args);
    }) as unknown as typeof fetch;

    const result = await cascade({
      fallbackChain: [{ provider: 'anthropic', model: 'claude' }],
      fetchImpl: flaky,
      onAttemptStart: () => { events.push('start'); throw new Error('observer failure'); },
      onAttemptFinish: () => { events.push('finish'); throw new Error('observer failure'); },
      onAttemptRateLimited: () => { events.push('rate_limited'); throw new Error('observer failure'); },
    });

    expect(result.ok).toBe(true);
    expect(events).toEqual(['start', 'finish', 'rate_limited', 'start', 'finish']);
    expect(warn).toHaveBeenCalledTimes(5);
    for (const [, detail] of warn.mock.calls) {
      expect(detail).not.toHaveProperty('credentialLabel');
    }
    warn.mockRestore();
  });

  // RSH-147/RSH-148: every actual gated dispatch emits one balanced lifecycle
  // pair. The handler can then own its credential-specific gauge safely.
  it.each([
    ['success', {}],
    ['provider error', { fetchImpl: fetchReturning({ error: 'unavailable' }, 503) }],
    ['timeout', { fetchImpl: fetchThrowing(new Error('upstream timeout')) }],
    ['parse failure', { fetchImpl: fetchReturning('not valid json') }],
    ['pricing failure', { computeCost: () => { throw new Error('pricing unavailable'); } }],
    ['quality rejection', { primary: { provider: 'openai-empty', model: 'gpt-4.1' } }],
  ] as const)('balances the dispatch lifecycle on %s without a rate-limit callback', async (_path, overrides) => {
    await cascade(overrides);

    const provider = 'primary' in overrides ? 'openai-empty' : 'openai';
    expect(lifecycle.start).toHaveBeenCalledTimes(1);
    expect(lifecycle.start).toHaveBeenCalledWith({ provider, model: 'gpt-4.1', credentialLabel: 'cascade-key' });
    expect(lifecycle.finish).toHaveBeenCalledTimes(1);
    expect(lifecycle.finish).toHaveBeenCalledWith({ provider, model: 'gpt-4.1', credentialLabel: 'cascade-key' });
    expect(lifecycle.start.mock.invocationCallOrder[0]).toBeLessThan(lifecycle.finish.mock.invocationCallOrder[0]);
    expect(lifecycle.rateLimited).not.toHaveBeenCalled();
  });

  it('finishes one attempt before starting the fallback lifecycle', async () => {
    let resolvePrimary!: (response: Response) => void;
    let resolveFallback!: (response: Response) => void;
    let fallbackStarted!: () => void;
    const fallbackStartedPromise = new Promise<void>((resolve) => { fallbackStarted = resolve; });
    let dispatches = 0;
    const pendingFetch = (() => {
      dispatches += 1;
      if (dispatches === 1) {
        return new Promise<Response>((resolve) => { resolvePrimary = resolve; });
      }
      fallbackStarted();
      return new Promise<Response>((resolve) => { resolveFallback = resolve; });
    }) as unknown as typeof fetch;

    const result = cascade({
      primary: { provider: 'openai-empty', model: 'gpt-4.1' },
      primaryConfig: { key: 'k', metadata: {}, label: 'openai-empty-credential' },
      fallbackChain: [{ provider: 'anthropic', model: 'claude' }],
      getProviderConfig: (provider) => ({ key: 'k', metadata: {}, label: `${provider}-credential` }),
      fetchImpl: pendingFetch,
    });

    await vi.waitFor(() => expect(lifecycle.start).toHaveBeenCalledWith({
      provider: 'openai-empty', model: 'gpt-4.1', credentialLabel: 'openai-empty-credential',
    }));
    resolvePrimary(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await fallbackStartedPromise;
    resolveFallback(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    expect((await result).ok).toBe(true);
    expect(dispatches).toBe(2);
    expect(lifecycle.start).toHaveBeenCalledTimes(2);
    expect(lifecycle.finish).toHaveBeenCalledTimes(2);
    expect(lifecycle.start.mock.calls).toEqual([
      [{ provider: 'openai-empty', model: 'gpt-4.1', credentialLabel: 'openai-empty-credential' }],
      [{ provider: 'anthropic', model: 'claude', credentialLabel: 'anthropic-credential' }],
    ]);
    expect(lifecycle.finish.mock.invocationCallOrder[0]).toBeLessThan(lifecycle.start.mock.invocationCallOrder[1]);
  });

  it('trips the circuit on a retryable 5xx', async () => {
    await cascade({ primary: { provider: 'openai', model: 'gpt-4.1' }, fetchImpl: fetchReturning({ error: 'x' }, 503) });
    expect(circuitMock.recordFailure).toHaveBeenCalledWith('openai', 'gpt-4.1');
  });

  it('skips a circuit-open primary and serves the fallback', async () => {
    circuitMock.isOpen.mockImplementation((p: string) => p === 'openai');
    const result = await cascade({ fallbackChain: [{ provider: 'anthropic', model: 'claude' }] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.providerId).toBe('anthropic');
      expect(result.skips.some((s) => s.provider === 'openai' && s.reason === 'Circuit breaker open')).toBe(true);
    }
  });
  it('skips a quarantined fallback before any provider dispatch', async () => {
    const fetchMock = vi.fn(fetchReturning({ ok: true }));

    const result = await cascade({
      primary: { provider: 'openai-empty', model: 'gpt-4.1' },
      fallbackChain: [{ provider: 'openai', model: 'gpt-5.6-cyber' }],
      fetchImpl: fetchMock,
    });

    expect(result.ok).toBe(false);
    expect(result.skips).toContainEqual({
      provider: 'openai',
      model: 'gpt-5.6-cyber',
      reason: 'unsupported_runtime_model:openai:gpt-5.6-cyber',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });


  // RSH-134 §6 Q1 — the executor itself fails closed, so no future caller can
  // forget the check. A gate persisted before the field existed reaches here
  // with it absent; the TypeScript literal does not protect stored JSON.
  describe('multi-attempt billing acknowledgement (fail-closed)', () => {
    const { multi_attempt_billing_ack: _omitted, ...legacyGate } = gate;

    it('refuses a legacy gate with no ack, dispatching nothing', async () => {
      const result = await cascade({
        gate: legacyGate as QualityGateConfig,
        fallbackChain: [{ provider: 'anthropic', model: 'claude' }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('terminal');
        expect(result.terminalReasonCode).toBe('quality_gate_billing_ack_required');
      }
      // Nothing was dispatched: no audit rows, no circuit accounting.
      expect(result.audit).toHaveLength(0);
      expect(circuitMock.recordSuccess).not.toHaveBeenCalled();
      expect(circuitMock.recordFailure).not.toHaveBeenCalled();
    });

    it.each([false, 'yes', 1, null])('refuses a non-true ack value %p', async (value) => {
      const result = await cascade({
        gate: { ...legacyGate, multi_attempt_billing_ack: value } as unknown as QualityGateConfig,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.terminalReasonCode).toBe('quality_gate_billing_ack_required');
    });

    it('proceeds normally when the ack is exactly true', async () => {
      const result = await cascade();
      expect(result.ok).toBe(true);
    });
  });

  it('honors the retry budget (maxRetries 0 = primary only)', async () => {
    const result = await cascade({
      primary: { provider: 'openai-empty', model: 'gpt-4.1' },
      fallbackChain: [{ provider: 'anthropic', model: 'claude' }],
      budget: { maxRetries: 0 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('exhausted');
      expect(result.audit).toHaveLength(1);
      expect(result.skips.some((s) => s.reason === 'Retry budget exhausted (max_retries)')).toBe(true);
    }
  });

  it('uses the billing pricing resolver for max-cost fallback gating', async () => {
    const pricingResolver = vi.fn(async (provider: string) => (
      provider === 'openai-empty'
        ? { input_per_million: 0, output_per_million: 0.1 }
        : { input_per_million: 0, output_per_million: 100 }
    ));
    const result = await cascade({
      primary: { provider: 'openai-empty', model: 'gpt-4.1' },
      fallbackChain: [{ provider: 'anthropic', model: 'claude' }],
      budget: {
        maxRetries: 1,
        maxCostMicrocents: 100,
        estimatedInputTokens: 0,
        estimatedMaxOutputTokens: 1,
        pricingResolver,
      },
    });
    expect(pricingResolver).toHaveBeenCalledWith('anthropic', 'claude');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.skips).toContainEqual(expect.objectContaining({
      provider: 'anthropic', reason: 'Retry budget exhausted (max_cost_microcents)',
    }));
  });

  it('does not dispatch a fallback under a max-cost ceiling when primary pricing is unknown', async () => {
    const result = await cascade({
      primary: { provider: 'openai-empty', model: 'gpt-4.1' },
      fallbackChain: [{ provider: 'anthropic', model: 'claude' }],
      budget: {
        maxRetries: 1, maxCostMicrocents: 100, estimatedInputTokens: 0, estimatedMaxOutputTokens: 1,
        pricingResolver: async (provider) => provider === 'openai-empty' ? null : { input_per_million: 0, output_per_million: 1 },
      },
    });
    expect(result.audit).toHaveLength(1);
    expect(result.skips).toContainEqual(expect.objectContaining({
      provider: 'anthropic', reason: 'Retry budget exhausted (primary_unknown_pricing)',
    }));
  });

  // RSH-134 step 1 — aggregate ACTUAL cost on the result. Each fake attempt that
  // reaches a provider yields output_tokens 5 * 100 = 500 microcents.
  describe('aggregateCostMicrocents (RSH-134)', () => {
    it('equals the single attempt cost when the primary verifies', async () => {
      const result = await cascade({ fallbackChain: [{ provider: 'anthropic', model: 'claude' }] });
      expect(result.aggregateCostMicrocents).toBe(500);
    });

    it('sums every dispatched attempt, not just the served one', async () => {
      const result = await cascade({
        primary: { provider: 'openai-empty', model: 'gpt-4.1' },
        fallbackChain: [{ provider: 'anthropic', model: 'claude' }],
      });
      expect(result.ok).toBe(true);
      // The served attempt alone cost 500; the rejected primary is real spend too.
      expect(result.aggregateCostMicrocents).toBe(1000);
      // Pin that it is the SUM of the audit and not the served attempt's cost:
      // asserting against aggregateActualCostMicrocents(result.audit) here would
      // be tautological (the executor computes it with that same function), so
      // sum the rows independently.
      let manual = 0;
      for (const row of result.audit) manual += row.actual_cost_microcents;
      expect(manual).toBe(1000);
      if (result.ok) expect(result.outcome.actualCostMicrocents).toBe(500);
    });

    it('is non-zero on an exhausted cascade — a failed cascade is not free', async () => {
      const result = await cascade({
        primary: { provider: 'openai-empty', model: 'gpt-4.1' },
        fallbackChain: [{ provider: 'anthropic-empty', model: 'claude' }],
      });
      expect(result.ok).toBe(false);
      expect(result.aggregateCostMicrocents).toBe(1000);
    });

    it('counts the dispatched attempt on a terminal cascade', async () => {
      const result = await cascade({
        primary: { provider: 'openai-refusal', model: 'gpt-4.1' },
        fallbackChain: [{ provider: 'anthropic', model: 'claude' }],
      });
      expect(result.ok).toBe(false);
      // Terminal stops the chain, so only the primary was dispatched and billed.
      expect(result.aggregateCostMicrocents).toBe(500);
    });

    it('records a 5xx as an unknown-cost lower-bound zero', async () => {
      const result = await cascade({
        primary: { provider: 'openai', model: 'gpt-4.1' },
        fetchImpl: fetchReturning({ error: 'x' }, 503),
      });
      expect(result.ok).toBe(false);
      expect(result.audit).toHaveLength(1);
      expect(result.aggregateCostMicrocents).toBe(0);
      expect(result.aggregateCostKnown).toBe(false);
      expect(result.aggregateUnknownCostAttempts).toBe(1);
      expect(result.audit[0]).toMatchObject({ actual_cost_microcents: 0, actual_cost_known: false });
    });

    it('reports ACTUAL cost, not the estimated budget figure the ceilings use', async () => {
      // The fake models carry no catalog pricing, so the cascade's internal
      // `cumulativeCostMicrocents` estimate is 0 for both attempts. The reported
      // aggregate must still be the real 1000 that computeCost produced —
      // settling the estimate would bill a number no provider charged.
      const result = await cascade({
        primary: { provider: 'openai-empty', model: 'gpt-4.1' },
        fallbackChain: [{ provider: 'anthropic', model: 'claude' }],
        budget: { maxRetries: 5 },
      });
      expect(result.ok).toBe(true);
      expect(result.aggregateCostMicrocents).toBe(1000);
    });

    // 3 of 4 gauntlet lanes flagged this: computeCost rejecting after a billed
    // dispatch used to reject the whole cascade, discarding every prior
    // attempt's known cost.
    it('preserves earlier attempts’ spend when computeCost throws mid-cascade', async () => {
      let calls = 0;
      const result = await cascade({
        primary: { provider: 'openai-empty', model: 'gpt-4.1' },
        fallbackChain: [{ provider: 'anthropic', model: 'claude' }],
        computeCost: (_p: string, _m: string, u: TokenUsage) => {
          calls += 1;
          if (calls === 2) throw new Error('pricing store unavailable');
          return u.output_tokens * 100;
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.terminalReasonCode).toBe('quality_gate_attempt_executor_error');
      // The first attempt's real 500 survives instead of being thrown away.
      expect(result.aggregateCostMicrocents).toBe(500);
      expect(result.audit).toHaveLength(2);
      expect(result.audit[1].reason_code).toContain('pricing store unavailable');
    });

    it('does not dispatch a further paid attempt after an executor error', async () => {
      let dispatches = 0;
      const counting = ((...args: Parameters<typeof fetch>) => {
        dispatches += 1;
        return fetchReturning({ ok: true })(...args);
      }) as unknown as typeof fetch;
      await cascade({
        primary: { provider: 'openai-empty', model: 'gpt-4.1' },
        fallbackChain: [
          { provider: 'anthropic', model: 'claude' },
          { provider: 'openai', model: 'gpt-4.1-mini' },
        ],
        fetchImpl: counting,
        computeCost: () => { throw new Error('pricing down'); },
      });
      // Only the primary was dispatched; an internal pricing error must not
      // spend more of the customer's money.
      expect(dispatches).toBe(1);
    });

    it('is 0 when the cascade is refused pre-dispatch for a missing billing ack', async () => {
      const { multi_attempt_billing_ack: _omitted, ...legacyGate } = gate;
      const result = await cascade({ gate: legacyGate as QualityGateConfig });
      expect(result.aggregateCostMicrocents).toBe(0);
    });

    it('never counts a skipped (undispatched) candidate', async () => {
      circuitMock.isOpen.mockImplementation((p: string) => p === 'openai');
      const result = await cascade({ fallbackChain: [{ provider: 'anthropic', model: 'claude' }] });
      expect(result.ok).toBe(true);
      expect(result.skips).toHaveLength(1);
      // Only the fallback was dispatched.
      expect(result.aggregateCostMicrocents).toBe(500);
    });
  });
});

describe('aggregateActualCostMicrocents (RSH-134 pure helper)', () => {
  const row = (actual_cost_microcents: number): AttemptAudit => ({
    attempt_index: 0, provider: 'p', model: 'm', outcome: 'verified', reason_code: null,
    check_index: null, status_code: 200, input_tokens: 0, output_tokens: 0,
    actual_cost_microcents, actual_cost_known: true, latency_ms: 0, circuit_failure: false,
  });

  it('is 0 for an empty audit', () => {
    expect(aggregateActualCostMicrocents([])).toBe(0);
  });

  it('sums every row', () => {
    expect(aggregateActualCostMicrocents([row(500), row(250), row(1)])).toBe(751);
  });

  // Addition alone cannot show a zero row participated (0 and "skipped" sum
  // identically), so assert the traversal instead: every row is visited exactly
  // once, including zero-cost ones.
  it('visits every row exactly once, including zero-cost rows', () => {
    const visits: number[] = [];
    const tracked = [0, 500, 0].map((cost, i) => ({
      ...row(cost),
      get actual_cost_microcents() {
        visits.push(i);
        return cost;
      },
    })) as AttemptAudit[];
    expect(aggregateActualCostMicrocents(tracked)).toBe(500);
    expect(visits).toEqual([0, 1, 2]);
  });

  it('stays an exact integer microcent sum (no float drift)', () => {
    const rows = Array.from({ length: 100 }, () => row(333));
    expect(aggregateActualCostMicrocents(rows)).toBe(33_300);
    expect(Number.isInteger(aggregateActualCostMicrocents(rows))).toBe(true);
  });

  it('distinguishes known zero from an unknown lower bound in mixed attempts', () => {
    const unknown = { ...row(0), actual_cost_known: false };
    const knownZero = row(0);
    expect(aggregateActualCostMicrocents([knownZero, unknown, row(500)])).toBe(500);
    expect(isAggregateActualCostKnown([knownZero, unknown, row(500)])).toBe(false);
    expect(isAggregateActualCostKnown([knownZero])).toBe(true);
    expect(aggregateUnknownCostAttempts([])).toBe(0);
    expect(aggregateUnknownCostAttempts([unknown])).toBe(1);
    expect(aggregateUnknownCostAttempts([unknown, { ...unknown, attempt_index: 1 }])).toBe(2);
  });
});
