import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const provider = {
    id: 'openai',
    buildRequest: vi.fn(() => ({
      url: 'https://upstream.example/v1',
      method: 'POST',
      headers: { Authorization: 'Bearer upstream' },
      body: JSON.stringify({ ok: true }),
    })),
    parseResponse: vi.fn(() => ({
      id: 'resp_1',
      content: [{ type: 'output_text', text: 'hello' }],
      stop_reason: 'stop',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    })),
    parseStreamChunk: vi.fn(),
    extractUsage: vi.fn(() => ({ input_tokens: 12, output_tokens: 8, total_tokens: 20 })),
    normalizeError: vi.fn((_status: number, _body: unknown) => ({
      type: 'upstream_error',
      message: 'Upstream failed',
      retryable: false,
    })),
  };

  return {
    config: { maxRequestBodyBytes: 1024 },
    validateApiKey: vi.fn(),
    rateCheck: vi.fn(() => ({ allowed: true, remaining: 77, resetMs: 30000 })),
    tpmCheck: vi.fn(() => ({ allowed: true, recordId: null, currentTokens: 0, remaining: Infinity, resetMs: 0 })),
    updateTpmEstimate: vi.fn(() => ({ allowed: true, recordId: null, currentTokens: 0, remaining: Infinity, resetMs: 0 })),
    reconcileTokens: vi.fn(),
    removeTpmRecord: vi.fn(),
    getRulesForTeam: vi.fn(async () => []),
    evaluateRules: vi.fn(() => ({ provider: 'openai', model: 'gpt-4o-mini', fallback_chain: [] })),
    getAutoRouteSettings: vi.fn(async () => ({ enabled: false, strategy: 'balanced' as const, max_fallbacks: 0 })),
    getAutoRouteProviderSignals: vi.fn(async () => []),
    getProvider: vi.fn((providerId?: string) => (providerId ? provider : undefined)),
    getTeamBillingMode: vi.fn(async () => 'subscription'),
    getTeamPlan: vi.fn(async () => 'growth'),
    getPlanLimits: vi.fn(() => ({
      maxKeys: 50,
      maxRules: Infinity,
      fallbacksEnabled: true,
      savingsSharePercent: 3,
      creditsMarkupPercent: 3.5,
    })),
    reserveBudget: vi.fn(async () => ({
      allowed: true,
      reservation: {
        requestId: 'budget-req',
        teamId: 'team_1',
        apiKeyId: null,
        estimatedMicrocents: 100,
        reservedMicrocents: 100,
        dispatched: false,
        terminal: false,
      },
      warnings: [],
    })),
    adjustBudgetReservation: vi.fn(async (input: { reservation: Record<string, unknown> }) => ({
      allowed: true,
      reservation: input.reservation,
      warnings: [],
    })),
    markBudgetReservationDispatched: vi.fn(async () => ({ marked: true, alreadyMarked: false })),
    refreshBudgetReservationLease: vi.fn(async () => ({ refreshed: true })),
    settleBudgetReservation: vi.fn(async () => {}),
    releaseBudgetReservation: vi.fn(async () => {}),
    estimateChatBudget: vi.fn(async () => ({ estimatedMicrocents: 100 })),
    getDecryptedProviderKey: vi.fn(async () => ({
      key: 'team-upstream-key',
      metadata: {},
      label: 'primary',
    })),
    preFlightCreditCheck: vi.fn(async () => ({ allowed: true, balance: 100000, estimatedCost: 100 })),
    deductCredits: vi.fn(async () => ({ success: true, newBalance: 99900 })),
    reserveCredits: vi.fn(async () => ({ success: true, newBalance: 99900, amountDeducted: 100 })),
    heartbeatCreditReservation: vi.fn(async () => {}),
    settleReservedCredits: vi.fn(async () => ({ success: true, newBalance: 99920, amountDeducted: 80 })),
    settleReservedCreditsWithUnknownCostHold: vi.fn(async () => ({
      success: true,
      newBalance: 99900,
      amountDeducted: 100,
      pendingHoldMicrocents: 50,
      amountRefunded: 0,
    })),
    checkAutoTopUpNeeded: vi.fn(async () => {}),
    responseCache: {
      isCacheable: vi.fn(() => false),
      buildKey: vi.fn(() => 'cache-key'),
      get: vi.fn(() => null),
      set: vi.fn(),
    },
    resolvePreset: vi.fn(),
    computeRequestCost: vi.fn(async () => ({
      original_cost_microcents: 100,
      actual_cost_microcents: 80,
      actual_cost_known: true,
      savings_microcents: 20,
    })),
    computeRequestCostDetailed: vi.fn(async () => ({
      original_cost_microcents: 100,
      original_cost_known: true,
      actual_cost_microcents: 80,
      actual_cost_known: true,
      savings_microcents: 20,
    })),
    logRequest: vi.fn(),
    captureException: vi.fn(),
    relayStream: vi.fn(async () => ({ chunks: [], ttft_ms: 123 })),
    getCreditPricing: vi.fn(async () => ({
      model: 'gpt-4o-mini',
      input_per_million: 0.15,
      output_per_million: 0.6,
    })),
    applyMarkupMicrocents: vi.fn((cost: number, markup: number) => Math.ceil((cost * (100 + markup)) / 100 - 1e-9)),
    executeFallbackChain: vi.fn(async () => null),
    estimateAttemptCostMicrocents: vi.fn(() => 100),
    estimateAttemptCostForBudget: vi.fn(async () => 100),
    projectQualityCascadeReservation: vi.fn(async () => ({ costMicrocents: 100 })),
    executeQualityCascade: vi.fn(),
    circuitBreaker: {
      isOpen: vi.fn(() => false),
      recordFailure: vi.fn(),
      recordSuccess: vi.fn(),
    },
    fetchMock: vi.fn(),
    hasEnabledProviderKey: vi.fn(async () => true),
    markCooldown: vi.fn(),
    incrementInFlight: vi.fn(),
    decrementInFlight: vi.fn(),
    captureAiGeneration: vi.fn(),
  };
});

// The handler fans out to several DB-backed collaborators that aren't mocked
// individually (resolveAlias, getAutoRouteSettings). getPool()
// fails closed without DATABASE_URL, so stub it with an empty-rows query — each
// of those collaborators then falls back to its permissive default (no alias,
// no budget cap, auto-route disabled), which is the contract these flow tests
// assume.
vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({ query: async () => ({ rows: [] }) }),
}));
vi.mock('../src/config.js', () => ({ config: mocks.config }));
vi.mock('../src/auth/api-key.js', () => ({ validateApiKey: mocks.validateApiKey }));
vi.mock('../src/rate-limit/limiter.js', () => ({
  rateLimiter: {
    check: mocks.rateCheck,
    checkTpm: mocks.tpmCheck,
    updateTpmEstimate: mocks.updateTpmEstimate,
    reconcileActualTokens: mocks.reconcileTokens,
    removeRecord: mocks.removeTpmRecord,
  },
}));
vi.mock('../src/routing/rule-cache.js', () => ({ getRulesForTeam: mocks.getRulesForTeam }));
vi.mock('../src/admin/auto-route.js', () => ({ getAutoRouteSettings: mocks.getAutoRouteSettings }));
vi.mock('../src/routing/auto-route-availability.js', () => ({ getAutoRouteProviderSignals: mocks.getAutoRouteProviderSignals }));
vi.mock('@routeshift/shared', async () => {
  const actual = await vi.importActual<typeof import('@routeshift/shared')>('@routeshift/shared');
  return {
    ...actual,
    EFFECTIVE_DISPATCHABLE_CHAT_MODELS: actual.EFFECTIVE_DISPATCHABLE_CHAT_MODELS ?? actual.MODEL_REGISTRY,
    evaluateRules: mocks.evaluateRules,
  };
});
vi.mock('../src/providers/registry.js', () => ({ getProvider: mocks.getProvider }));
vi.mock('../src/billing/plan-limits.js', () => ({
  getTeamBillingMode: mocks.getTeamBillingMode,
  getTeamPlan: mocks.getTeamPlan,
  getPlanLimits: mocks.getPlanLimits,
}));
vi.mock('../src/billing/budget-reservations.js', () => ({
  reserveBudget: mocks.reserveBudget,
  adjustBudgetReservation: mocks.adjustBudgetReservation,
  markBudgetReservationDispatched: mocks.markBudgetReservationDispatched,
  refreshBudgetReservationLease: mocks.refreshBudgetReservationLease,
  settleBudgetReservation: mocks.settleBudgetReservation,
  releaseBudgetReservation: mocks.releaseBudgetReservation,
}));
vi.mock('../src/billing/budget-estimate.js', () => ({
  estimateChatBudget: mocks.estimateChatBudget,
}));
vi.mock('../src/billing/provider-key-crypto.js', () => ({
  getDecryptedProviderKey: mocks.getDecryptedProviderKey,
  hasEnabledProviderKey: mocks.hasEnabledProviderKey,
}));
vi.mock('../src/billing/rate-limit-cooldown.js', () => ({ markCooldown: mocks.markCooldown }));
vi.mock('../src/billing/key-stats.js', () => ({
  incrementInFlight: mocks.incrementInFlight,
  decrementInFlight: mocks.decrementInFlight,
  recordLatency: vi.fn(),
}));
vi.mock('../src/billing/credits.js', () => ({
  preFlightCreditCheck: mocks.preFlightCreditCheck,
  deductCredits: mocks.deductCredits,
  reserveCredits: mocks.reserveCredits,
  heartbeatCreditReservation: mocks.heartbeatCreditReservation,
  settleReservedCredits: mocks.settleReservedCredits,
  settleReservedCreditsWithUnknownCostHold: mocks.settleReservedCreditsWithUnknownCostHold,
  checkAutoTopUpNeeded: mocks.checkAutoTopUpNeeded,
  getCreditPricing: mocks.getCreditPricing,
  applyMarkupMicrocents: mocks.applyMarkupMicrocents,
}));
vi.mock('../src/cache/response-cache.js', () => ({ responseCache: mocks.responseCache }));
vi.mock('../src/presets/resolver.js', () => ({ resolvePreset: mocks.resolvePreset }));
vi.mock('../src/cost/calculator.js', () => ({
  computeRequestCost: mocks.computeRequestCost,
  computeRequestCostDetailed: mocks.computeRequestCostDetailed,
}));
vi.mock('../src/logging/logger.js', () => ({ logRequest: mocks.logRequest }));
vi.mock('../src/streaming/relay.js', () => ({ relayStream: mocks.relayStream }));
vi.mock('../src/routing/fallback.js', () => ({
  executeFallbackChain: mocks.executeFallbackChain,
  estimateAttemptCostMicrocents: mocks.estimateAttemptCostMicrocents,
  estimateAttemptCostForBudget: mocks.estimateAttemptCostForBudget,
  projectQualityCascadeReservation: mocks.projectQualityCascadeReservation,
}));
vi.mock('../src/routing/quality-cascade.js', () => ({ executeQualityCascade: mocks.executeQualityCascade }));
vi.mock('../src/routing/circuit-breaker.js', () => ({ circuitBreaker: mocks.circuitBreaker }));
vi.mock('../src/observability/sentry.js', () => ({ captureException: mocks.captureException }));
vi.mock('../src/observability/posthog.js', async () => {
  const actual = await vi.importActual<typeof import('../src/observability/posthog.js')>('../src/observability/posthog.js');
  return {
    ...actual,
    captureAiGeneration: mocks.captureAiGeneration,
  };
});
import { handleProxyRequest } from '../src/proxy-handler.js';
import { EFFECTIVE_DISPATCHABLE_CHAT_MODELS, RouteBlockedError } from '@routeshift/shared';

// Both suites below replace the process-global fetch implementation. Restore it
// after every case so real-HTTP tests sharing this worker retain native fetch.
afterEach(() => {
  vi.unstubAllGlobals();
});

function makeReq(body: unknown, auth = 'Bearer sk-proxy-valid'): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]);
  return Object.assign(stream, {
    url: '/v1/chat/completions',
    method: 'POST',
    headers: { authorization: auth, host: 'localhost' },
  }) as IncomingMessage;
}

function makeRes() {
  let statusCode = 0;
  let body = '';
  const headers: Record<string, string> = {};
  // Real ServerResponse is an EventEmitter and fires 'finish' once the response
  // is fully sent — the handler hooks 'finish' to release reserved TPM estimates.
  const res = Object.assign(new EventEmitter(), {
    headersSent: false,
    setHeader(name: string, value: string) {
      headers[name] = value;
      return res;
    },
    writeHead(code: number, nextHeaders?: Record<string, string>) {
      statusCode = code;
      Object.assign(headers, nextHeaders ?? {});
      res.headersSent = true;
      return res;
    },
    end(chunk?: string) {
      body = chunk ?? '';
      res.headersSent = true;
      res.emit('finish');
      return res;
    },
  }) as unknown as ServerResponse & { headersSent: boolean };

  return {
    res,
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
    get headers() {
      return headers;
    },
  };
}

describe('handleProxyRequest flow behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = 'platform-key';
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.TOGETHER_API_KEY;
    delete process.env.GROQ_API_KEY;
    mocks.validateApiKey.mockResolvedValue({
      id: 'key_1',
      teamId: 'team_1',
      allowedModels: null,
      rateLimitOverride: null,
    });
    mocks.fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: 'up_1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', mocks.fetchMock as unknown as typeof fetch);
    mocks.getAutoRouteSettings.mockResolvedValue({ enabled: false, strategy: 'balanced', max_fallbacks: 0 });
    mocks.getAutoRouteProviderSignals.mockResolvedValue([]);
    mocks.getCreditPricing.mockResolvedValue({
      provider: 'openai',
      model: 'gpt-4o-mini',
      input_per_million: 0.15,
      output_per_million: 0.6,
    });
    mocks.hasEnabledProviderKey.mockResolvedValue(true);
    mocks.getDecryptedProviderKey.mockResolvedValue({
      key: 'team-upstream-key',
      metadata: {},
      label: 'primary',
    });
  });
  it('passes the effective dispatchable chat catalog to rule evaluation', async () => {
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(mocks.evaluateRules).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ model_requested: 'gpt-4o-mini' }),
      EFFECTIVE_DISPATCHABLE_CHAT_MODELS,
    );
  });


  it('rejects a key without inference scope before preset or upstream work', async () => {
    mocks.validateApiKey.mockResolvedValueOnce({
      id: 'key_1',
      teamId: 'team_1',
      allowedModels: null,
      rateLimitOverride: null,
      metadata: { created_via: 'oauth_device', scope: 'read' },
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: '@preset/private', messages: [] }), out.res);

    expect(out.statusCode).toBe(403);
    expect(JSON.parse(out.body)).toEqual({
      error: {
        message: 'insufficient_scope: missing inference scope',
        code: 'insufficient_scope',
      },
    });
    expect(mocks.resolvePreset).not.toHaveBeenCalled();
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('returns 403 when requested model is not in API key allowlist', async () => {
    mocks.validateApiKey.mockResolvedValueOnce({
      id: 'key_1',
      teamId: 'team_1',
      allowedModels: ['gpt-4o'],
      rateLimitOverride: null,
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(403);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'Model is not permitted for this API key' } });
  });

  it('never subsidizes subscription traffic with a platform provider key', async () => {
    mocks.getDecryptedProviderKey.mockResolvedValueOnce(null);
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(503);
    expect(JSON.parse(out.body)).toEqual({
      error: {
        message: "openai requires a team-configured provider key. Save one via the dashboard's Provider Keys page.",
      },
    });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('does not make a provider preference eligible from a platform key in subscription mode', async () => {
    mocks.hasEnabledProviderKey.mockResolvedValue(false);
    const out = makeRes();

    await handleProxyRequest(
      makeReq({
        model: 'gpt-4o-mini',
        provider: { order: ['openai'] },
        messages: [],
      }),
      out.res,
    );

    expect(out.statusCode).toBe(422);
    expect(JSON.parse(out.body)).toEqual({
      error: {
        message: 'No credential-configured provider is available for requested provider preferences',
        code: 'selected_provider_missing_credentials',
      },
    });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('uses platform credentials directly in credits mode without reading a team key', async () => {
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(200);
    expect(mocks.getDecryptedProviderKey).not.toHaveBeenCalled();
    expect(mocks.getProvider('openai')!.buildRequest).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-4o-mini' }),
      'platform-key',
      {},
    );
  });

  it('returns 403 when routed model is not in API key allowlist', async () => {
    mocks.validateApiKey.mockResolvedValueOnce({
      id: 'key_1',
      teamId: 'team_1',
      allowedModels: ['gpt-4o'],
      rateLimitOverride: null,
      metadata: {},
    });
    mocks.evaluateRules.mockReturnValueOnce({
      provider: 'openai',
      model: 'gpt-4o-mini',
      fallback_chain: [],
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o', messages: [] }), out.res);

    expect(out.statusCode).toBe(403);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'Model gpt-4o-mini is not permitted for this API key' } });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('releases reserved per-key + team TPM estimates when a request is rejected after reservation (RSH-60 generalized)', async () => {
    // Both TPM checks reserve an estimate (key has a TPM override AND the team has a cap).
    mocks.tpmCheck
      .mockReturnValueOnce({ allowed: true, recordId: 'rec_key', currentTokens: 0, remaining: 1000, resetMs: 60000 })
      .mockReturnValueOnce({ allowed: true, recordId: 'rec_team', currentTokens: 0, remaining: 1000, resetMs: 60000 });
    // Force a rejection that returns AFTER the reservation: routed model not allowed.
    mocks.validateApiKey.mockResolvedValueOnce({
      id: 'key_1',
      teamId: 'team_1',
      allowedModels: ['gpt-4o'],
      rateLimitOverride: { tokens_per_minute: 1000 },
      metadata: {},
    });
    mocks.evaluateRules.mockReturnValueOnce({ provider: 'openai', model: 'gpt-4o-mini', fallback_chain: [] });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o', messages: [] }), out.res);

    expect(out.statusCode).toBe(403);
    expect(mocks.fetchMock).not.toHaveBeenCalled();
    // The phantom estimates must be released once the response finishes, or they
    // linger in the 60s window and falsely throttle the next request.
    expect(mocks.removeTpmRecord).toHaveBeenCalledWith('rec_key');
    expect(mocks.removeTpmRecord).toHaveBeenCalledWith('rec_team');
  });

  it('filters fallback models outside the API key allowlist without blocking an allowed primary', async () => {
    mocks.validateApiKey.mockResolvedValueOnce({
      id: 'key_1',
      teamId: 'team_1',
      allowedModels: ['gpt-4o'],
      rateLimitOverride: null,
      metadata: {},
    });
    mocks.evaluateRules.mockReturnValueOnce({
      provider: 'openai',
      model: 'gpt-4o',
      fallback_chain: [{ provider: 'anthropic', model: 'claude-haiku-4-5' }],
    });
    mocks.fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'transient' } }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o', messages: [] }), out.res);

    expect(out.statusCode).toBe(503);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'Upstream failed' } });
    expect(mocks.executeFallbackChain).not.toHaveBeenCalled();
  });

  it('returns 400 when model is missing', async () => {
    const out = makeRes();

    await handleProxyRequest(makeReq({ messages: [] }), out.res);

    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body)).toEqual({
      error: { message: 'model field is required and must be a string', code: 'invalid_model' },
    });
  });

  it('returns 400 when messages is not an array', async () => {
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: 'bad' }), out.res);

    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'messages must be an array' } });
  });

  it('returns invalid_plugin at the proxy boundary for malformed plugin fields', async () => {
    const out = makeRes();

    await handleProxyRequest(makeReq({
      model: 'gpt-4o-mini',
      messages: [],
      plugins: { id: 'web', required: true },
    }), out.res);

    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body)).toEqual({
      error: { message: 'plugins must be an array', code: 'invalid_plugin' },
    });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('skips optional :online plugin requests with exact warning metadata when no backend is configured', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.evaluateRules.mockImplementationOnce((_rules, ctx) => ({
      provider: 'openai',
      model: ctx.model_requested,
      fallback_chain: [],
    }));
    const out = makeRes();

    await handleProxyRequest(makeReq({
      model: 'gpt-4o-mini:online',
      messages: [{ role: 'user', content: 'latest AI policy news' }],
    }), out.res);

    const expectedWarning = {
      plugin: 'web',
      code: 'plugin_backend_not_configured',
      reason: 'No backend configured for plugin web',
      message: 'Plugin web skipped: No backend configured for plugin web',
    };
    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.body).warnings).toEqual([expectedWarning]);
    expect(mocks.evaluateRules).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({
      model_requested: 'gpt-4o-mini',
    }), expect.any(Array));
    expect(mocks.getProvider('openai').buildRequest).toHaveBeenCalledTimes(1);
    expect(mocks.fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.responseCache.isCacheable).not.toHaveBeenCalled();
    expect(mocks.responseCache.get).not.toHaveBeenCalled();
    expect(mocks.responseCache.set).not.toHaveBeenCalled();
    expect(out.headers['X-RouteShift-Plugin-Warning']).toBe('plugin_backend_not_configured');
    expect(out.headers['X-RouteShift-Plugin-Skip-Reason']).toBe(expectedWarning.message);
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      status_code: 200,
      plugin_warnings: [expectedWarning],
      plugin_runs: [{
        plugin: 'web',
        status: 'warning',
        costMicrocents: 0,
        latencyMs: expect.any(Number),
        detail: 'plugin_backend_not_configured',
      }],
    }));
    expect(warnSpy).toHaveBeenCalledWith(JSON.stringify({
      event: 'routeshift_plugin_skipped',
      ...expectedWarning,
    }));
    warnSpy.mockRestore();
  });

  it('reserves a web-plugin-inclusive estimate before search and settles provider plus plugin cost once', async () => {
    const previousExaKey = process.env.EXA_API_KEY;
    const previousSurcharge = process.env.WEB_SEARCH_SURCHARGE_MICROCENTS;
    process.env.EXA_API_KEY = 'test-exa-key';
    process.env.WEB_SEARCH_SURCHARGE_MICROCENTS = '500000';
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    mocks.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      results: [{ title: 'RouteShift', url: 'https://example.com/routeshift', highlights: ['plugin result'] }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const out = makeRes();

    try {
      await handleProxyRequest(makeReq({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'RouteShift launch news' }],
        plugins: [{ id: 'web' }],
      }), out.res);

      expect(out.statusCode).toBe(200);
      expect(mocks.preFlightCreditCheck.mock.calls[0]!.slice(-1)).toEqual([500_000]);
      expect(mocks.preFlightCreditCheck.mock.calls[1]!.slice(-2)).toEqual([500_000, 100]);
      expect(mocks.reserveCredits).toHaveBeenCalledTimes(1);
      expect(mocks.reserveCredits.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.fetchMock.mock.invocationCallOrder[0]!,
      );
      expect(mocks.settleReservedCredits).toHaveBeenCalledWith(
        'team_1',
        100,
        500_080,
        3.5,
        expect.any(String),
        expect.stringContaining('gpt-4o-mini'),
      );
      expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
        actual_cost_microcents: 80,
        plugin_cost_microcents: 500_000,
        plugin_runs: [{
          plugin: 'web',
          status: 'ok',
          costMicrocents: 500_000,
          latencyMs: expect.any(Number),
        }],
      }));
    } finally {
      if (previousExaKey === undefined) delete process.env.EXA_API_KEY;
      else process.env.EXA_API_KEY = previousExaKey;
      if (previousSurcharge === undefined) delete process.env.WEB_SEARCH_SURCHARGE_MICROCENTS;
      else process.env.WEB_SEARCH_SURCHARGE_MICROCENTS = previousSurcharge;
    }
  });

  it('rejects a pre-plugin budget admission without any upstream or plugin call', async () => {
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    mocks.reserveBudget.mockResolvedValueOnce({
      allowed: false,
      kind: 'exceeded',
      statusCode: 429,
      scope: 'key',
      action: 'throttle',
      window: 'weekly',
      resetAt: '2026-08-10T00:00:00.000Z',
      retryAfterSeconds: 61,
      message: 'Budget cap exceeded for weekly window',
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(429);
    expect(out.headers['Retry-After']).toBe('61');
    expect(JSON.parse(out.body).error).toEqual({
      message: 'Budget cap exceeded for weekly window',
      window: 'weekly',
      reset_at: '2026-08-10T00:00:00.000Z',
      scope: 'key',
      action: 'throttle',
      retry_after: 61,
    });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
    expect(mocks.getProvider('openai').buildRequest).not.toHaveBeenCalled();
    expect(mocks.settleBudgetReservation).not.toHaveBeenCalled();
    // The independent credits reservation is released by the outer cleanup.
    expect(mocks.settleReservedCredits).toHaveBeenCalled();
  });

  it('returns 402 with a block action and no upstream call when the team cap blocks', async () => {
    mocks.reserveBudget.mockResolvedValueOnce({
      allowed: false,
      kind: 'exceeded',
      statusCode: 402,
      scope: 'team',
      action: 'block',
      window: 'monthly',
      resetAt: '2026-09-01T00:00:00.000Z',
      retryAfterSeconds: null,
      message: 'Budget cap exceeded for monthly window',
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(402);
    expect(out.headers['Retry-After']).toBeUndefined();
    expect(JSON.parse(out.body).error).toEqual({
      message: 'Budget cap exceeded for monthly window',
      window: 'monthly',
      reset_at: '2026-09-01T00:00:00.000Z',
      scope: 'team',
      action: 'block',
      retry_after: null,
    });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed with 503 budget_estimate_unavailable when a hard cap has no pricing', async () => {
    mocks.reserveBudget.mockResolvedValueOnce({
      allowed: false,
      kind: 'estimate_unavailable',
      statusCode: 503,
      scope: 'team',
      action: 'throttle',
      window: 'daily',
      resetAt: '2026-08-10T00:00:00.000Z',
      retryAfterSeconds: 3600,
      message: 'Estimated cost unavailable and a hard budget cap is active',
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(503);
    expect(JSON.parse(out.body)).toEqual({
      error: {
        message: 'Estimated cost unavailable and a hard budget cap is active',
        code: 'budget_estimate_unavailable',
      },
    });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the 503 Budget service unavailable contract when reservation fails', async () => {
    mocks.reserveBudget.mockRejectedValueOnce(new Error('db down'));
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(503);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'Budget service unavailable' } });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('admits alert-only unknown pricing and serves the request', async () => {
    mocks.reserveBudget.mockResolvedValueOnce({
      allowed: true,
      reservation: {
        requestId: 'budget-req',
        teamId: 'team_1',
        apiKeyId: 'key_1',
        estimatedMicrocents: 0,
        reservedMicrocents: 0,
        dispatched: false,
        terminal: false,
      },
      warnings: ['unknown_pricing'],
    });
    mocks.estimateChatBudget.mockResolvedValueOnce({ estimatedMicrocents: null, missingPricing: { provider: 'openai', model: 'gpt-4o-mini' } });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(200);
    expect(mocks.fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.settleBudgetReservation).toHaveBeenCalledWith(expect.objectContaining({
      actualCostKnown: true,
    }));
  });

  it('reserves both team and key scopes in one admission', async () => {
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(mocks.reserveBudget).toHaveBeenCalledWith({
      requestId: expect.any(String),
      teamId: 'team_1',
      apiKeyId: 'key_1',
      identityId: null, // RSH-140: default key mock carries no layer_identity_id
      estimate: { estimatedMicrocents: 100 },
    });
    expect(out.statusCode).toBe(200);
  });

  it('aborts with 503 before any external call when the dispatch mark fails', async () => {
    mocks.markBudgetReservationDispatched.mockResolvedValueOnce({ marked: false, alreadyMarked: false });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(503);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'Budget service unavailable' } });
    // The mark fences the first provider fetch; no upstream call may start.
    expect(mocks.fetchMock).not.toHaveBeenCalled();
    // Mark failed before dispatch: the finally releases the pending reservation.
    expect(mocks.releaseBudgetReservation).toHaveBeenCalled();
  });

  it('settles the exact served cost on a successful response', async () => {
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(200);
    expect(mocks.markBudgetReservationDispatched).toHaveBeenCalledTimes(1);
    expect(mocks.settleBudgetReservation).toHaveBeenCalledWith(expect.objectContaining({
      actualMicrocents: 80, // computeRequestCost mock: actual_cost_microcents 80
      actualCostKnown: true,
    }));
    expect(mocks.releaseBudgetReservation).not.toHaveBeenCalled();
  });

  it('settles the measured cached served-path cost on a cache hit', async () => {
    mocks.responseCache.isCacheable.mockReturnValueOnce(true);
    mocks.responseCache.buildKey.mockReturnValueOnce('cache-key');
    mocks.responseCache.get.mockReturnValueOnce({
      model: 'gpt-4o-mini',
      provider: 'openai',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      body: { id: 'cached_1' },
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(200);
    expect(out.headers['X-RouteShift-Cache']).toBe('HIT');
    expect(mocks.fetchMock).not.toHaveBeenCalled();
    // A cache hit is still subject to the reservation: settle, never release.
    expect(mocks.settleBudgetReservation).toHaveBeenCalledWith(expect.objectContaining({
      actualMicrocents: 80,
      actualCostKnown: true,
      reasonCode: 'cache_hit',
    }));
    expect(mocks.releaseBudgetReservation).not.toHaveBeenCalled();
  });

  it('settles the aggregate cost when a circuit-open fallback serves the request', async () => {
    mocks.circuitBreaker.isOpen.mockReturnValueOnce(true);
    mocks.evaluateRules.mockReturnValueOnce({
      provider: 'openai',
      model: 'gpt-4o-mini',
      fallback_chain: [{ provider: 'openai', model: 'gpt-4o-mini' }],
    });
    mocks.executeFallbackChain.mockResolvedValueOnce({
      ok: true,
      response: new Response(JSON.stringify({ id: 'fallback_1' }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      provider: mocks.getProvider('openai'),
      providerId: 'openai',
      model: 'gpt-4o-mini',
      attempts: [{ provider: 'openai', model: 'gpt-4o-mini', error: 'Circuit breaker open', actual_cost_known: true }],
      aggregateActualCostKnown: true,
      aggregateActualCostMicrocents: 40,
      aggregateInputTokens: 5,
      aggregateOutputTokens: 3,
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(200);
    // prior attempts (40) + served (80) + plugin (0) = 120
    expect(mocks.settleBudgetReservation).toHaveBeenCalledWith(expect.objectContaining({
      actualMicrocents: 120,
      actualCostKnown: true,
    }));
  });

  it('releases the reservation on a no-dispatch upstream-config failure', async () => {
    mocks.getDecryptedProviderKey.mockResolvedValueOnce(null);
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(503);
    expect(mocks.fetchMock).not.toHaveBeenCalled();
    // Exact settlement with the measured (zero) plugin cost frees the capacity.
    expect(mocks.settleBudgetReservation).toHaveBeenCalledWith(expect.objectContaining({
      actualMicrocents: 0,
      actualCostKnown: true,
      reasonCode: 'no_dispatch',
    }));
  });

  it('holds the unresolved remainder on an upstream 5xx with no fallback', async () => {
    mocks.fetchMock.mockResolvedValueOnce(
      new Response('upstream exploded', { status: 500 }),
    );
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(500);
    expect(mocks.settleBudgetReservation).toHaveBeenCalledWith(expect.objectContaining({
      actualMicrocents: 0,
      actualCostKnown: false,
    }));
  });

  it('holds the unresolved remainder when the stream heartbeat fails', async () => {
    mocks.relayStream.mockResolvedValueOnce({
      chunks: [],
      ttft_ms: 42,
      statusCode: 200,
      streamError: 'credit_reservation_heartbeat_failed',
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }), out.res);

    expect(mocks.settleBudgetReservation).toHaveBeenCalledWith(expect.objectContaining({
      actualCostKnown: false,
      reasonCode: 'stream_heartbeat_failure',
    }));
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      is_streaming: true,
      error_type: 'credit_reservation_heartbeat_failed',
    }));
  });

  it('rejects a post-plugin budget adjustment before provider dispatch while retaining the paid plugin surcharge', async () => {
    const previousExaKey = process.env.EXA_API_KEY;
    const previousSurcharge = process.env.WEB_SEARCH_SURCHARGE_MICROCENTS;
    process.env.EXA_API_KEY = 'test-exa-key';
    process.env.WEB_SEARCH_SURCHARGE_MICROCENTS = '500000';
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    mocks.adjustBudgetReservation.mockResolvedValueOnce({
      allowed: false,
      kind: 'exceeded',
      statusCode: 429,
      scope: 'team',
      action: 'throttle',
      window: 'daily',
      resetAt: '2026-08-10T00:00:00.000Z',
      retryAfterSeconds: 60,
      message: 'Budget cap exceeded for daily window',
    });
    mocks.tpmCheck
      .mockReturnValueOnce({ allowed: true, recordId: 'rec_key', currentTokens: 0, remaining: 1000, resetMs: 60_000 })
      .mockReturnValueOnce({ allowed: true, recordId: 'rec_team', currentTokens: 0, remaining: 1000, resetMs: 60_000 });
    mocks.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      results: [{ title: 'RouteShift', url: 'https://example.com/routeshift', highlights: ['plugin result'] }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const out = makeRes();

    try {
      await handleProxyRequest(makeReq({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'RouteShift launch news' }],
        plugins: [{ id: 'web' }],
      }), out.res);

      expect(out.statusCode).toBe(429);
      expect(out.headers['Retry-After']).toBe('60');
      expect(JSON.parse(out.body).error).toEqual({
        message: 'Budget cap exceeded for daily window',
        window: 'daily',
        reset_at: '2026-08-10T00:00:00.000Z',
        scope: 'team',
        action: 'throttle',
        retry_after: 60,
      });
      // Paid plugin only; no provider fetch after the adjustment rejection.
      expect(mocks.fetchMock).toHaveBeenCalledTimes(1);
      expect(mocks.getProvider('openai').buildRequest).not.toHaveBeenCalled();
      // Exactly one settle with the measured plugin fee; never a separate release.
      expect(mocks.settleBudgetReservation).toHaveBeenCalledTimes(1);
      expect(mocks.settleBudgetReservation).toHaveBeenCalledWith(expect.objectContaining({
        actualMicrocents: 500_000,
        actualCostKnown: true,
        reasonCode: 'adjustment_reject',
      }));
      expect(mocks.releaseBudgetReservation).not.toHaveBeenCalled();
      expect(mocks.removeTpmRecord).toHaveBeenCalledWith('rec_key');
      expect(mocks.removeTpmRecord).toHaveBeenCalledWith('rec_team');
      expect(mocks.settleReservedCredits).toHaveBeenCalledWith(
        'team_1', 100, 500_000, 3.5, expect.any(String), expect.stringContaining('plugin surcharge settled'),
      );
    } finally {
      if (previousExaKey === undefined) delete process.env.EXA_API_KEY;
      else process.env.EXA_API_KEY = previousExaKey;
      if (previousSurcharge === undefined) delete process.env.WEB_SEARCH_SURCHARGE_MICROCENTS;
      else process.env.WEB_SEARCH_SURCHARGE_MICROCENTS = previousSurcharge;
    }
  });

  it('reports the full post-plugin cascade reservation in an insufficient-credit response', async () => {
    const previousExaKey = process.env.EXA_API_KEY;
    const previousSurcharge = process.env.WEB_SEARCH_SURCHARGE_MICROCENTS;
    process.env.EXA_API_KEY = 'test-exa-key';
    process.env.WEB_SEARCH_SURCHARGE_MICROCENTS = '500000';
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    mocks.evaluateRules.mockReturnValueOnce({
      provider: 'openai',
      model: 'gpt-4o-mini',
      fallback_chain: [{ provider: 'anthropic', model: 'claude-haiku-4-5' }],
      quality_gate: {
        version: 1,
        mode: 'cascade',
        on_stream: 'reject',
        unknown_signal: 'reject',
        multi_attempt_billing_ack: true,
        checks: [{ type: 'nonempty_content', min_chars: 1 }],
      },
    });
    mocks.preFlightCreditCheck
      .mockResolvedValueOnce({ allowed: true, balance: 1_000_000, estimatedCost: 100 })
      .mockResolvedValueOnce({ allowed: false, balance: 100, estimatedCost: 200 });
    mocks.projectQualityCascadeReservation
      .mockResolvedValueOnce({ costMicrocents: 100 })
      .mockResolvedValueOnce({ costMicrocents: 5_000 });
    mocks.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      results: [{ title: 'RouteShift', url: 'https://example.com/routeshift', highlights: ['plugin result'] }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const out = makeRes();

    try {
      await handleProxyRequest(makeReq({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'RouteShift launch news' }],
        plugins: [{ id: 'web' }],
      }), out.res);

      expect(out.statusCode).toBe(402);
      expect(out.headers['X-RouteShift-Estimated-Cost']).toBe('522675');
      expect(mocks.getProvider('openai').buildRequest).not.toHaveBeenCalled();
    } finally {
      if (previousExaKey === undefined) delete process.env.EXA_API_KEY;
      else process.env.EXA_API_KEY = previousExaKey;
      if (previousSurcharge === undefined) delete process.env.WEB_SEARCH_SURCHARGE_MICROCENTS;
      else process.env.WEB_SEARCH_SURCHARGE_MICROCENTS = previousSurcharge;
    }
  });

  it('identifies the exact unpriced cascade candidate after plugin augmentation', async () => {
    const previousExaKey = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = 'test-exa-key';
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    mocks.evaluateRules.mockReturnValueOnce({
      provider: 'openai',
      model: 'gpt-4o-mini',
      fallback_chain: [{ provider: 'anthropic', model: 'claude-haiku-4-5' }],
      quality_gate: {
        version: 1,
        mode: 'cascade',
        on_stream: 'reject',
        unknown_signal: 'reject',
        multi_attempt_billing_ack: true,
        checks: [{ type: 'nonempty_content', min_chars: 1 }],
      },
    });
    mocks.preFlightCreditCheck
      .mockResolvedValueOnce({ allowed: true, balance: 1_000_000, estimatedCost: 100 })
      .mockResolvedValueOnce({ allowed: true, balance: 999_900, estimatedCost: 100 });
    mocks.projectQualityCascadeReservation
      .mockResolvedValueOnce({ costMicrocents: 100 })
      .mockResolvedValueOnce({
        costMicrocents: 100,
        missingPricing: { provider: 'anthropic', model: 'claude-haiku-4-5' },
      });
    mocks.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      results: [{ title: 'RouteShift', url: 'https://example.com/routeshift', highlights: ['plugin result'] }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const out = makeRes();

    try {
      await handleProxyRequest(makeReq({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'RouteShift launch news' }],
        plugins: [{ id: 'web' }],
      }), out.res);

      expect(out.statusCode).toBe(503);
      expect(JSON.parse(out.body)).toEqual({
        error: {
          message: expect.stringContaining('anthropic:claude-haiku-4-5'),
          code: 'quality_gate_unpriced_candidate',
        },
      });
      expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'anthropic',
        model_resolved: 'claude-haiku-4-5',
        error_type: 'quality_gate_unpriced_candidate',
      }));
      expect(mocks.getProvider('openai').buildRequest).not.toHaveBeenCalled();
    } finally {
      if (previousExaKey === undefined) delete process.env.EXA_API_KEY;
      else process.env.EXA_API_KEY = previousExaKey;
    }
  });

  it('releases a pre-plugin credit reservation after required plugin failure without upstream dispatch', async () => {
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const out = makeRes();

    try {
      await handleProxyRequest(makeReq({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'latest AI policy news' }],
        plugins: [{ id: 'web', required: true }],
      }), out.res);

      expect(out.statusCode).toBe(502);
      expect(mocks.fetchMock).not.toHaveBeenCalled();
      expect(mocks.settleReservedCredits).toHaveBeenCalledWith(
        'team_1', 100, 0, 3.5, expect.any(String), expect.stringContaining('reservation released'),
      );
      expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
        billing_mode: 'credits',
        plugin_cost_microcents: 0,
        plugin_runs: [expect.objectContaining({
          plugin: 'web', status: 'error', costMicrocents: 0, detail: 'plugin_backend_not_configured',
        })],
      }));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('fails closed for required web plugin requests when no backend is configured', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const out = makeRes();

    await handleProxyRequest(makeReq({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'latest AI policy news' }],
      plugins: [{ id: 'web', required: true, max_results: 5, search_prompt: 'EU AI Act updates' }],
    }), out.res);

    expect(out.statusCode).toBe(502);
    expect(JSON.parse(out.body)).toEqual({
      error: {
        message: 'Required plugin web failed: No backend configured for plugin web',
        code: 'plugin_required_failed',
        plugin: 'web',
        reason: 'No backend configured for plugin web',
      },
    });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
    expect(mocks.responseCache.isCacheable).not.toHaveBeenCalled();
    expect(mocks.responseCache.get).not.toHaveBeenCalled();
    expect(mocks.responseCache.set).not.toHaveBeenCalled();
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      status_code: 502,
      error_type: 'plugin_required_failed',
      fallback_attempts: [],
      plugin_warnings: [{
        plugin: 'web',
        code: 'plugin_required_failed',
        reason: 'No backend configured for plugin web',
        message: 'Required plugin web failed: No backend configured for plugin web',
      }],
    }));
    expect(warnSpy).toHaveBeenCalledWith(JSON.stringify({
      event: 'routeshift_plugin_required_failed',
      plugin: 'web',
      code: 'plugin_required_failed',
      reason: 'No backend configured for plugin web',
      message: 'Required plugin web failed: No backend configured for plugin web',
    }));
    warnSpy.mockRestore();
  });

  it('returns 502 for a required oversized file and never builds an upstream request', async () => {
    const previousMaxBytes = process.env.PLUGIN_MAX_FILE_BYTES;
    process.env.PLUGIN_MAX_FILE_BYTES = '4';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const out = makeRes();
    const fileData = Buffer.alloc(5, 1).toString('base64');

    try {
      await handleProxyRequest(makeReq({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content: [{ type: 'input_file', filename: 'too-large.pdf', file_data: fileData }],
        }],
        plugins: [{ id: 'file-parser', required: true }],
      }), out.res);

      expect(out.statusCode).toBe(502);
      expect(JSON.parse(out.body)).toEqual({
        error: {
          message: 'Required plugin file-parser failed: file_too_large',
          code: 'plugin_required_failed',
          plugin: 'file-parser',
          reason: 'file_too_large',
        },
      });
      expect(out.body).not.toContain(fileData);
      expect(mocks.getProvider('openai').buildRequest).not.toHaveBeenCalled();
      expect(mocks.fetchMock).not.toHaveBeenCalled();
      expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
        status_code: 502,
        error_type: 'plugin_required_failed',
        plugin_warnings: [{
          plugin: 'file-parser',
          code: 'plugin_required_failed',
          reason: 'file_too_large',
          message: 'Required plugin file-parser failed: file_too_large',
        }],
      }));
      expect(warnSpy).toHaveBeenCalledWith(JSON.stringify({
        event: 'routeshift_plugin_required_failed',
        plugin: 'file-parser',
        code: 'plugin_required_failed',
        reason: 'file_too_large',
        message: 'Required plugin file-parser failed: file_too_large',
      }));
    } finally {
      warnSpy.mockRestore();
      if (previousMaxBytes === undefined) delete process.env.PLUGIN_MAX_FILE_BYTES;
      else process.env.PLUGIN_MAX_FILE_BYTES = previousMaxBytes;
    }
  });

  it('implicitly extracts a base64 PDF and strips its raw file body before upstream dispatch', async () => {
    const previousMaxRequestBodyBytes = mocks.config.maxRequestBodyBytes;
    mocks.config.maxRequestBodyBytes = 100_000;
    const out = makeRes();
    const fileData = readFileSync(
      new URL('./fixtures/routeshift-file-parser.pdf.base64', import.meta.url),
      'utf8',
    ).trim();

    try {
      await handleProxyRequest(makeReq({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content: [{
            type: 'input_file',
            filename: 'routeshift-file-parser-fixture.pdf',
            file_data: `data:application/pdf;base64,${fileData}`,
          }],
        }],
      }), out.res);

      expect(out.statusCode).toBe(200);
      const canonical = mocks.getProvider('openai').buildRequest.mock.calls[0]?.[0] as {
        messages: Array<{ content: Array<{ type: string; text?: string }> }>;
      };
      expect(canonical.messages[0].content).toEqual([{
        type: 'text',
        text: expect.stringContaining('RouteShift PDF fixture text'),
      }]);
      expect(JSON.stringify(canonical)).not.toContain(fileData);
      expect(JSON.stringify(canonical)).not.toContain('file_data');
      expect(mocks.responseCache.isCacheable).not.toHaveBeenCalled();
    } finally {
      mocks.config.maxRequestBodyBytes = previousMaxRequestBodyBytes;
    }
  });

  it('extracts a system-role PDF before canonicalization so raw file data never reaches an adapter', async () => {
    const previousMaxRequestBodyBytes = mocks.config.maxRequestBodyBytes;
    mocks.config.maxRequestBodyBytes = 100_000;
    const out = makeRes();
    const fileData = readFileSync(
      new URL('./fixtures/routeshift-file-parser.pdf.base64', import.meta.url),
      'utf8',
    ).trim();

    try {
      await handleProxyRequest(makeReq({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: [
              { type: 'text', text: 'Base policy', cache_control: { type: 'ephemeral', ttl: '1h' } },
              {
                type: 'input_file',
                filename: 'routeshift-file-parser-fixture.pdf',
                file_data: `data:application/pdf;base64,${fileData}`,
              },
            ],
          },
          { role: 'user', content: 'summarize the document' },
        ],
      }), out.res);

      expect(out.statusCode).toBe(200);
      const canonical = mocks.getProvider('openai').buildRequest.mock.calls[0]?.[0] as {
        system_prompt?: Array<Record<string, unknown>>;
        messages: unknown[];
      };
      expect(canonical.system_prompt).toEqual([
        { type: 'text', text: 'Base policy', cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: '[Extracted from routeshift-file-parser-fixture.pdf]\nRouteShift PDF fixture text' },
      ]);
      expect(JSON.stringify(canonical)).not.toContain(fileData);
      expect(JSON.stringify(canonical)).not.toContain('file_data');
    } finally {
      mocks.config.maxRequestBodyBytes = previousMaxRequestBodyBytes;
    }
  });

  it('extracts a top-level system_prompt PDF before canonicalization', async () => {
    const previousMaxRequestBodyBytes = mocks.config.maxRequestBodyBytes;
    mocks.config.maxRequestBodyBytes = 100_000;
    const fileData = readFileSync(
      new URL('./fixtures/routeshift-file-parser.pdf.base64', import.meta.url),
      'utf8',
    ).trim();
    const out = makeRes();

    try {
      await handleProxyRequest(makeReq({
        model: 'gpt-4o-mini',
        system_prompt: [{
          type: 'input_file',
          filename: 'routeshift-file-parser-fixture.pdf',
          file_data: `data:application/pdf;base64,${fileData}`,
        }],
        messages: [{ role: 'user', content: 'summarize the document' }],
      }), out.res);

      expect(out.statusCode).toBe(200);
      const canonical = mocks.getProvider('openai').buildRequest.mock.calls[0]?.[0] as {
        system_prompt?: Array<Record<string, unknown>>;
      };
      expect(canonical.system_prompt).toEqual([{
        type: 'text',
        text: '[Extracted from routeshift-file-parser-fixture.pdf]\nRouteShift PDF fixture text',
      }]);
      expect(JSON.stringify(canonical)).not.toContain(fileData);
      expect(JSON.stringify(canonical)).not.toContain('file_data');
    } finally {
      mocks.config.maxRequestBodyBytes = previousMaxRequestBodyBytes;
    }
  });

  it('extracts a top-level system PDF before canonicalization', async () => {
    const previousMaxRequestBodyBytes = mocks.config.maxRequestBodyBytes;
    mocks.config.maxRequestBodyBytes = 100_000;
    const fileData = readFileSync(
      new URL('./fixtures/routeshift-file-parser.pdf.base64', import.meta.url),
      'utf8',
    ).trim();
    const out = makeRes();

    try {
      await handleProxyRequest(makeReq({
        model: 'gpt-4o-mini',
        system: [{
          type: 'input_file',
          filename: 'routeshift-file-parser-fixture.pdf',
          file_data: `data:application/pdf;base64,${fileData}`,
        }],
        messages: [{ role: 'user', content: 'summarize the document' }],
      }), out.res);

      expect(out.statusCode).toBe(200);
      const canonical = mocks.getProvider('openai').buildRequest.mock.calls[0]?.[0] as {
        system_prompt?: Array<Record<string, unknown>>;
      };
      expect(canonical.system_prompt).toEqual([{
        type: 'text',
        text: '[Extracted from routeshift-file-parser-fixture.pdf]\nRouteShift PDF fixture text',
      }]);
      expect(JSON.stringify(canonical)).not.toContain(fileData);
      expect(JSON.stringify(canonical)).not.toContain('file_data');
    } finally {
      mocks.config.maxRequestBodyBytes = previousMaxRequestBodyBytes;
    }
  });

  it('charges the effective structured system_prompt cache-control TTL', async () => {
    mocks.evaluateRules.mockReturnValueOnce({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      fallback_chain: [],
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({
      model: 'gpt-4o-mini',
      system_prompt: [{
        type: 'text',
        text: 'Stable policy',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      }],
      messages: [{ role: 'user', content: 'hello' }],
    }), out.res);

    expect(out.statusCode).toBe(200);
    expect(mocks.computeRequestCostDetailed.mock.calls[0]?.[4]).toMatchObject({ cache_write_ttl: '1h' });
  });

  it('keeps an implicit user PDF in canonical native form only for the routed Anthropic target', async () => {
    const previousMaxRequestBodyBytes = mocks.config.maxRequestBodyBytes;
    mocks.config.maxRequestBodyBytes = 100_000;
    const fileData = readFileSync(
      new URL('./fixtures/routeshift-file-parser.pdf.base64', import.meta.url),
      'utf8',
    ).trim();
    mocks.evaluateRules.mockReturnValueOnce({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      fallback_chain: [],
    });
    const out = makeRes();

    try {
      await handleProxyRequest(makeReq({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content: [{
            type: 'input_file',
            filename: 'routeshift-file-parser-fixture.pdf',
            file_data: `data:application/pdf;base64,${fileData}`,
          }],
        }],
      }), out.res);

      expect(out.statusCode).toBe(200);
      const canonical = mocks.getProvider('anthropic').buildRequest.mock.calls[0]?.[0] as {
        messages: Array<{ content: unknown }>;
      };
      expect(canonical.messages[0].content).toEqual([{
        type: 'pdf',
        pdf: {
          media_type: 'application/pdf',
          data: fileData,
          filename: 'routeshift-file-parser-fixture.pdf',
        },
      }]);
    } finally {
      mocks.config.maxRequestBodyBytes = previousMaxRequestBodyBytes;
    }
  });

  it('re-checks canonical file text against TPM before any upstream dispatch', async () => {
    const previousMaxRequestBodyBytes = mocks.config.maxRequestBodyBytes;
    mocks.config.maxRequestBodyBytes = 100_000;
    const fileData = readFileSync(
      new URL('./fixtures/routeshift-file-parser.pdf.base64', import.meta.url),
      'utf8',
    ).trim();
    mocks.validateApiKey.mockResolvedValueOnce({
      id: 'key_1',
      teamId: 'team_1',
      allowedModels: null,
      rateLimitOverride: { tokens_per_minute: 100 },
      metadata: {},
    });
    mocks.tpmCheck.mockReturnValueOnce({
      allowed: true,
      recordId: 'rec_key',
      currentTokens: 0,
      remaining: 90,
      resetMs: 60_000,
    });
    mocks.tpmCheck.mockReturnValueOnce({
      allowed: true,
      recordId: null,
      currentTokens: 0,
      remaining: Infinity,
      resetMs: 0,
    });
    mocks.updateTpmEstimate.mockReturnValueOnce({
      allowed: false,
      recordId: null,
      currentTokens: 99,
      remaining: 1,
      resetMs: 60_000,
    });
    const out = makeRes();

    try {
      await handleProxyRequest(makeReq({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content: [{
            type: 'input_file',
            filename: 'routeshift-file-parser-fixture.pdf',
            file_data: `data:application/pdf;base64,${fileData}`,
          }],
        }],
      }), out.res);

      expect(out.statusCode).toBe(429);
      expect(out.headers['X-RouteShift-Reason']).toBe('post_plugin_tpm_exceeded');
      expect(mocks.updateTpmEstimate).toHaveBeenCalledWith('rec_key', expect.any(Number), 100);
      expect(mocks.getProvider('openai').buildRequest).not.toHaveBeenCalled();
      expect(mocks.fetchMock).not.toHaveBeenCalled();
    } finally {
      mocks.config.maxRequestBodyBytes = previousMaxRequestBodyBytes;
    }
  });

  it('does not invent a file-parser backend warning when an explicit parser has no file parts', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const out = makeRes();

    await handleProxyRequest(makeReq({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'summarize these inputs' }],
      plugins: [
        { id: 'web', max_results: 3, search_prompt: 'RouteShift launch news' },
        { id: 'file-parser' },
      ],
    }), out.res);

    const expectedWarnings = [{
      plugin: 'web',
      code: 'plugin_backend_not_configured',
      reason: 'No backend configured for plugin web',
      message: 'Plugin web skipped: No backend configured for plugin web',
    }];
    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.body).warnings).toEqual(expectedWarnings);
    expect(mocks.fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.responseCache.isCacheable).not.toHaveBeenCalled();
    expect(mocks.responseCache.get).not.toHaveBeenCalled();
    expect(mocks.responseCache.set).not.toHaveBeenCalled();
    expect(out.headers['X-RouteShift-Plugin-Warning']).toBe('plugin_backend_not_configured');
    expect(out.headers['X-RouteShift-Plugin-Skip-Reason']).toBe(expectedWarnings.map((warning) => warning.message).join(' | '));
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      status_code: 200,
      plugin_warnings: expectedWarnings,
    }));
    for (const warning of expectedWarnings) {
      expect(warnSpy).toHaveBeenCalledWith(JSON.stringify({
        event: 'routeshift_plugin_skipped',
        ...warning,
      }));
    }
    warnSpy.mockRestore();
  });

  it('returns 403 when route evaluator blocks request', async () => {
    mocks.evaluateRules.mockImplementationOnce(() => {
      throw new RouteBlockedError('Blocked by policy');
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(403);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'Blocked by policy' } });
  });

  it('adds semantic tags before rule evaluation so tag-conditioned rules can route, when opted in', async () => {
    const { evaluateRules } = await vi.importActual<typeof import('@routeshift/shared')>(
      '@routeshift/shared',
    );
    mocks.getRulesForTeam.mockResolvedValueOnce([{
      id: 'semantic-coding-route',
      team_id: 'team_1',
      name: 'Route coding prompts',
      priority: 100,
      enabled: true,
      condition: { tags: ['coding'] },
      action: { type: 'route', target_provider: 'openai', target_model: 'gpt-4o' },
    }]);
    mocks.evaluateRules.mockImplementationOnce(evaluateRules);
    const out = makeRes();
    const prior = process.env.ROUTESHIFT_SEMANTIC_TAGS;
    process.env.ROUTESHIFT_SEMANTIC_TAGS = '1';

    try {
      await handleProxyRequest(makeReq({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Please debug this TypeScript function.' }],
      }), out.res);
    } finally {
      if (prior === undefined) delete process.env.ROUTESHIFT_SEMANTIC_TAGS;
      else process.env.ROUTESHIFT_SEMANTIC_TAGS = prior;
    }

    expect(out.statusCode).toBe(200);
    expect(mocks.evaluateRules).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({
      tags: ['coding'],
    }), expect.any(Array));
    expect(out.headers['X-RouteShift-Model']).toBe('gpt-4o');
  });

  it('does not add semantic tags when ROUTESHIFT_SEMANTIC_TAGS is unset (opt-in, off by default)', async () => {
    const { evaluateRules } = await vi.importActual<typeof import('@routeshift/shared')>(
      '@routeshift/shared',
    );
    mocks.getRulesForTeam.mockResolvedValueOnce([{
      id: 'semantic-coding-route',
      team_id: 'team_1',
      name: 'Route coding prompts',
      priority: 100,
      enabled: true,
      condition: { tags: ['coding'] },
      action: { type: 'route', target_provider: 'openai', target_model: 'gpt-4o' },
    }]);
    mocks.evaluateRules.mockImplementationOnce(evaluateRules);
    const out = makeRes();
    const prior = process.env.ROUTESHIFT_SEMANTIC_TAGS;
    delete process.env.ROUTESHIFT_SEMANTIC_TAGS;

    try {
      await handleProxyRequest(makeReq({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Please debug this TypeScript function.' }],
      }), out.res);
    } finally {
      if (prior !== undefined) process.env.ROUTESHIFT_SEMANTIC_TAGS = prior;
    }

    expect(mocks.evaluateRules).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({
      tags: [],
    }), expect.any(Array));
    expect(out.headers['X-RouteShift-Model']).not.toBe('gpt-4o');
  });

  it('RSH-73: does not classify on assistant-authored content, only the user\'s own message', async () => {
    const { evaluateRules } = await vi.importActual<typeof import('@routeshift/shared')>(
      '@routeshift/shared',
    );
    mocks.getRulesForTeam.mockResolvedValueOnce([{
      id: 'semantic-coding-route',
      team_id: 'team_1',
      name: 'Route coding prompts',
      priority: 100,
      enabled: true,
      condition: { tags: ['coding'] },
      action: { type: 'route', target_provider: 'openai', target_model: 'gpt-4o' },
    }]);
    mocks.evaluateRules.mockImplementationOnce(evaluateRules);
    const out = makeRes();
    const prior = process.env.ROUTESHIFT_SEMANTIC_TAGS;
    process.env.ROUTESHIFT_SEMANTIC_TAGS = '1';

    try {
      await handleProxyRequest(makeReq({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'assistant', content: 'Sure, I can help debug this TypeScript function.' },
          { role: 'user', content: 'Thanks, what time is it?' },
        ],
      }), out.res);
    } finally {
      if (prior === undefined) delete process.env.ROUTESHIFT_SEMANTIC_TAGS;
      else process.env.ROUTESHIFT_SEMANTIC_TAGS = prior;
    }

    expect(mocks.evaluateRules).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({
      tags: [],
    }), expect.any(Array));
    expect(out.headers['X-RouteShift-Model']).not.toBe('gpt-4o');
  });

  it('RSH-73: does not classify on system_prompt (e.g. a preset-injected role prompt)', async () => {
    const { evaluateRules } = await vi.importActual<typeof import('@routeshift/shared')>(
      '@routeshift/shared',
    );
    mocks.getRulesForTeam.mockResolvedValueOnce([{
      id: 'semantic-coding-route',
      team_id: 'team_1',
      name: 'Route coding prompts',
      priority: 100,
      enabled: true,
      condition: { tags: ['coding'] },
      action: { type: 'route', target_provider: 'openai', target_model: 'gpt-4o' },
    }]);
    mocks.evaluateRules.mockImplementationOnce(evaluateRules);
    const out = makeRes();
    const prior = process.env.ROUTESHIFT_SEMANTIC_TAGS;
    process.env.ROUTESHIFT_SEMANTIC_TAGS = '1';

    try {
      await handleProxyRequest(makeReq({
        model: 'gpt-4o-mini',
        system_prompt: 'You are a TypeScript coding assistant. Always debug carefully.',
        messages: [{ role: 'user', content: 'What time is it?' }],
      }), out.res);
    } finally {
      if (prior === undefined) delete process.env.ROUTESHIFT_SEMANTIC_TAGS;
      else process.env.ROUTESHIFT_SEMANTIC_TAGS = prior;
    }

    expect(mocks.evaluateRules).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({
      tags: [],
    }), expect.any(Array));
    expect(out.headers['X-RouteShift-Model']).not.toBe('gpt-4o');
  });

  it('rethrows unexpected rule evaluation errors', async () => {
    mocks.evaluateRules.mockImplementationOnce(() => {
      throw new Error('rule engine exploded');
    });

    await expect(
      handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), makeRes().res),
    ).rejects.toThrow('rule engine exploded');
  });

  it('returns 400 when provider cannot be resolved', async () => {
    mocks.evaluateRules.mockReturnValueOnce({ provider: '', model: 'unknown-model', fallback_chain: [] });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'unknown-model', messages: [] }), out.res);

    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'Unknown provider for the requested model' } });
  });

  it('refuses a quarantined rule target before provider dispatch', async () => {
    mocks.evaluateRules.mockReturnValueOnce({
      provider: 'openai',
      model: 'gpt-5.6-cyber',
      fallback_chain: [],
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-5.4', messages: [] }), out.res);

    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body)).toMatchObject({
      error: {
        code: 'model_not_dispatchable',
        reason: 'unsupported_runtime_model:openai:gpt-5.6-cyber',
      },
    });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
    expect(mocks.getProvider('openai')!.buildRequest).not.toHaveBeenCalled();
  });
  it('refuses a directly requested quarantined model before provider dispatch', async () => {
    mocks.evaluateRules.mockImplementationOnce((_rules, ctx) => ({
      provider: ctx.provider_requested,
      model: ctx.model_requested,
      fallback_chain: [],
    }));
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-5.6-cyber', messages: [] }), out.res);

    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body)).toMatchObject({
      error: {
        code: 'model_not_dispatchable',
        reason: 'unsupported_runtime_model:openai:gpt-5.6-cyber',
      },
    });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });


  it('returns normalized upstream error when provider responds non-OK without fallback', async () => {
    mocks.fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'nope' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(500);
    expect(mocks.circuitBreaker.recordFailure).toHaveBeenCalledWith('openai', 'gpt-4o-mini');
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'Upstream failed' } });
  });
  it('does not invent reasoning telemetry on terminal upstream failure', async () => {
    mocks.fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'nope' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    const logged = mocks.logRequest.mock.calls[0]?.[0] as {
      reasoning_tokens?: number | null;
      reasoning_cost_microcents?: number | null;
    };
    expect(logged.reasoning_tokens).toBeUndefined();
    expect(logged.reasoning_cost_microcents).toBeUndefined();
  });
  it('does not invent zero reasoning telemetry on non-stream success', async () => {
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      reasoning_tokens: undefined,
    }));
  });

  it('logs reasoning telemetry on non-stream success', async () => {
    const provider = mocks.getProvider('openai');
    if (!provider) throw new Error('openai provider mock missing');
    provider.parseResponse.mockReturnValueOnce({
      id: 'resp_reasoning_non_stream',
      content: [{ type: 'output_text', text: 'hello' }],
      stop_reason: 'stop',
      usage: { input_tokens: 10, output_tokens: 5, reasoning_tokens: 7, total_tokens: 15 },
    });
    mocks.computeRequestCostDetailed.mockResolvedValueOnce({
      original_cost_microcents: 100,
      original_cost_known: true,
      actual_cost_microcents: 80,
      actual_cost_known: true,
      reasoning_cost_microcents: 42,
      savings_microcents: 20,
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'think' }] }), out.res);

    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      reasoning_tokens: 7,
      reasoning_cost_microcents: 42,
    }));
  });

  it('uses fallback response when retryable upstream error occurs', async () => {
    mocks.evaluateRules.mockReturnValueOnce({
      provider: 'openai',
      model: 'gpt-4o-mini',
      fallback_chain: [{ provider: 'openai', model: 'gpt-4o-mini' }],
    });
    mocks.fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'transient' } }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    mocks.executeFallbackChain.mockResolvedValueOnce({
      ok: true,
      response: new Response(JSON.stringify({ id: 'fallback_http' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
      provider: mocks.getProvider('openai'),
      providerId: 'openai',
      model: 'gpt-4o-mini',
      attempts: [],
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(200);
    // Foreign-shaped bodies are normalized to OpenAI shape; the original
    // upstream (fallback) body is preserved under `raw`.
    expect(JSON.parse(out.body).raw).toEqual({ id: 'fallback_http' });
    expect(JSON.parse(out.body).object).toBe('chat.completion');
    expect(mocks.circuitBreaker.recordFailure).toHaveBeenCalledWith('openai', 'gpt-4o-mini');
  });

  it('retains credits and logs unknown cost when a retryable fallback succeeds after an ambiguous predecessor', async () => {
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    mocks.evaluateRules.mockReturnValueOnce({
      provider: 'openai', model: 'gpt-4o-mini',
      fallback_chain: [{ provider: 'anthropic', model: 'claude-3-5-sonnet' }],
    });
    mocks.fetchMock.mockResolvedValueOnce(new Response('busy', { status: 503 }));
    const fallbackProvider = mocks.getProvider('anthropic');
    if (!fallbackProvider) throw new Error('anthropic provider mock missing');
    fallbackProvider.parseResponse.mockReturnValueOnce({
      id: 'fallback_unknown_retryable',
      content: [{ type: 'output_text', text: 'hello' }],
      stop_reason: 'stop',
      usage: { input_tokens: 10, output_tokens: 5, reasoning_tokens: 7, total_tokens: 15 },
    });
    mocks.executeFallbackChain.mockResolvedValueOnce({
      ok: true,
      response: new Response(JSON.stringify({ id: 'fallback_unknown_retryable' }), { status: 200 }),
      provider: mocks.getProvider('anthropic'), providerId: 'anthropic', model: 'claude-3-5-sonnet',
      attempts: [{ provider: 'anthropic', model: 'claude-3-5-sonnet', error: 'network reset', actual_cost_known: false }],
      aggregateActualCostKnown: false,
      aggregateActualCostMicrocents: 0,
      aggregateInputTokens: 0,
      aggregateOutputTokens: 0,
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(200);
    expect(mocks.reserveCredits).toHaveBeenCalled();
    expect(mocks.settleReservedCredits).not.toHaveBeenCalled();
    expect(mocks.settleReservedCreditsWithUnknownCostHold).toHaveBeenCalledWith(
      'team_1',
      100,
      80,
      100,
      3.5,
      expect.any(String),
      expect.stringContaining('unknown-cost hold'),
      'served_response_cost_lower_bound',
      1,
    );
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      actual_cost_known: false,
      reasoning_tokens: null,
      fallback_attempts: [expect.objectContaining({ actual_cost_known: false })],
    }));
  });

  it('creates one durable hold for every ambiguous attempt when a retryable fallback exhausts', async () => {
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    mocks.evaluateRules.mockReturnValueOnce({
      provider: 'openai', model: 'gpt-4o-mini',
      fallback_chain: [{ provider: 'anthropic', model: 'claude-3-5-sonnet' }],
    });
    mocks.fetchMock.mockResolvedValueOnce(new Response('busy', { status: 503 }));
    mocks.executeFallbackChain.mockResolvedValueOnce({
      ok: false,
      attempts: [
        { provider: 'openai', model: 'gpt-4o-mini', error: 'HTTP 503', actual_cost_known: false },
        { provider: 'anthropic', model: 'claude-3-5-sonnet', error: 'network reset', actual_cost_known: false },
      ],
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(503);
    expect(mocks.settleReservedCredits).not.toHaveBeenCalled();
    expect(mocks.settleReservedCreditsWithUnknownCostHold).toHaveBeenCalledWith(
      'team_1',
      100,
      0,
      200,
      3.5,
      expect.any(String),
      expect.stringContaining('unknown-cost hold'),
      'fallback_exhausted',
      2,
    );
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      error_type: 'fallback_exhausted', actual_cost_known: false, actual_cost_microcents: 0,
    }));
  });

  it('handles non-json upstream errors', async () => {
    mocks.fetchMock.mockResolvedValueOnce(
      new Response('plain text error', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(400);
    expect(mocks.getProvider('openai').normalizeError).toHaveBeenCalledWith(400, { message: 'plain text error' });
  });

  it('persists a bounded unknown-cost hold for a no-fallback upstream 5xx', async () => {
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    mocks.fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ error: 'provider failed after acceptance' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    ));
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(503);
    expect(mocks.settleReservedCreditsWithUnknownCostHold).toHaveBeenCalledWith(
      'team_1',
      100,
      0,
      100,
      3.5,
      expect.any(String),
      expect.stringContaining('unknown-cost hold'),
      'upstream_http_5xx',
      1,
    );
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      error_type: 'upstream_http_error',
      actual_cost_known: false,
    }));
  });

  it.each([400, 429])('keeps upstream HTTP %s as known-zero without an unknown-cost hold', async (status) => {
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    mocks.fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ error: 'request not accepted' }),
      { status, headers: { 'Content-Type': 'application/json' } },
    ));
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(status);
    expect(mocks.settleReservedCreditsWithUnknownCostHold).not.toHaveBeenCalled();
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      error_type: 'upstream_http_error',
      actual_cost_known: true,
    }));
  });

  it('returns 200 and logs request on successful non-stream response', async () => {
    mocks.fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'up_2', choices: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }), out.res);

    expect(out.statusCode).toBe(200);
    expect(out.headers['X-RouteShift-Model']).toBe('gpt-4o-mini');
    expect(mocks.circuitBreaker.recordSuccess).toHaveBeenCalledWith('openai', 'gpt-4o-mini');
    expect(mocks.logRequest).toHaveBeenCalledTimes(1);
  });

  it('handles non-string message content when estimating input tokens', async () => {
    const out = makeRes();

    await handleProxyRequest(
      makeReq({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: { type: 'input_text', text: 'hello' } }],
      }),
      out.res,
    );

    expect(out.statusCode).toBe(200);
    expect(mocks.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stores cache on cacheable success response', async () => {
    mocks.responseCache.isCacheable.mockReturnValue(true);
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

    expect(out.statusCode).toBe(200);
    expect(out.headers['X-RouteShift-Cache']).toBe('MISS');
    expect(mocks.responseCache.set).toHaveBeenCalledTimes(1);
  });

  it('expands model @preset refs before validation and lets explicit request fields override defaults', async () => {
    mocks.resolvePreset.mockResolvedValueOnce({
      model: 'gpt-5.4',
      params: { temperature: 0.2, max_tokens: 1024, top_p: 0.8 },
      system_prompt: 'You are concise.',
      provider_prefs: { data_collection: 'deny' },
    });
    mocks.evaluateRules.mockImplementationOnce((_rules, ctx) => ({
      provider: 'openai',
      model: ctx.model_requested,
      fallback_chain: [],
    }));
    const out = makeRes();

    await handleProxyRequest(makeReq({
      model: '@preset/support-bot',
      temperature: 0.9,
      messages: [{ role: 'user', content: 'hi' }],
    }), out.res);

    expect(out.statusCode).toBe(200);
    expect(mocks.resolvePreset).toHaveBeenCalledWith('team_1', 'support-bot');
    const azureProvider = mocks.getProvider('azure');
    expect(azureProvider).toBeDefined();
    expect(azureProvider!.buildRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.4',
        temperature: 0.9,
        max_output_tokens: 1024,
        system_prompt: 'You are concise.',
        provider_params: { top_p: 0.8 },
      }),
      'team-upstream-key',
      {},
    );
  });

  it('rejects provider params that the routed provider cannot honor', async () => {
    mocks.evaluateRules.mockReturnValueOnce({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      fallback_chain: [],
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'hi' }],
      frequency_penalty: 0.4,
    }), out.res);

    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body)).toEqual({
      error: {
        message: 'Unsupported request parameter(s) for anthropic: frequency_penalty',
        code: 'unsupported_provider_params',
        unsupported_params: ['frequency_penalty'],
      },
    });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      status_code: 400,
      error_type: 'unsupported_provider_params',
    }));
  });

  it('fail-closes preset provider preferences when no eligible provider remains', async () => {
    mocks.resolvePreset.mockResolvedValueOnce({
      model: 'gpt-5.4',
      params: {},
      system_prompt: null,
      provider_prefs: { allow: ['anthropic'], data_collection: 'deny' },
    });
    mocks.evaluateRules.mockImplementationOnce((_rules, ctx) => ({
      provider: 'openai',
      model: ctx.model_requested,
      fallback_chain: [],
    }));
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: '@preset/zdr-only', messages: [] }), out.res);

    expect(out.statusCode).toBe(422);
    expect(JSON.parse(out.body)).toEqual({
      error: {
        message: 'No eligible provider for requested provider preferences',
        code: 'no_eligible_provider',
      },
    });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('fail-closes preset data residency preferences while no endpoint declares jurisdiction evidence', async () => {
    mocks.resolvePreset.mockResolvedValueOnce({
      model: 'gpt-5.4',
      params: {},
      system_prompt: null,
      provider_prefs: { data_residency: ['EU-DE'] },
    });
    mocks.evaluateRules.mockImplementationOnce((_rules, ctx) => ({
      provider: 'openai',
      model: ctx.model_requested,
      fallback_chain: [],
    }));
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: '@preset/eu-only', messages: [] }), out.res);

    expect(out.statusCode).toBe(422);
    expect(JSON.parse(out.body)).toEqual({
      error: {
        message: 'No eligible provider has verified endpoint jurisdiction evidence for requested data residency',
        code: 'no_eligible_provider_residency',
      },
    });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('applies a KEY-BOUND preset on every request, pinning the model (RSH-146)', async () => {
    mocks.validateApiKey.mockResolvedValueOnce({
      id: 'key_1',
      teamId: 'team_1',
      allowedModels: ['gpt-5.4'],
      rateLimitOverride: null,
      presetSlug: 'support-bot',
      presetVersion: 2,
    });
    mocks.resolvePreset.mockResolvedValueOnce({
      model: 'gpt-5.4',
      params: { temperature: 0.2, max_tokens: 1024 },
      system_prompt: 'You are concise.',
      provider_prefs: { data_collection: 'deny' },
    });
    mocks.evaluateRules.mockImplementationOnce((_rules, ctx) => ({
      provider: 'openai',
      model: ctx.model_requested,
      fallback_chain: [],
    }));
    const out = makeRes();

    // the request names a DIFFERENT model — the binding must pin gpt-5.4
    await handleProxyRequest(makeReq({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] }), out.res);

    expect(out.statusCode).toBe(200);
    expect(mocks.resolvePreset).toHaveBeenCalledWith('team_1', 'support-bot@2');
    const azureProvider = mocks.getProvider('azure');
    expect(azureProvider!.buildRequest).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5.4', temperature: 0.2, max_output_tokens: 1024 }),
      'team-upstream-key',
      {},
    );
  });

  it('rejects a request-level preset on a key-bound key with key_preset_conflict (RSH-146)', async () => {
    mocks.validateApiKey.mockResolvedValueOnce({
      id: 'key_1',
      teamId: 'team_1',
      allowedModels: null,
      rateLimitOverride: null,
      presetSlug: 'support-bot',
      presetVersion: null,
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: '@preset/other', messages: [] }), out.res);

    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body)).toEqual({
      error: { message: 'This API key is bound to a preset; request-level presets are not allowed', code: 'key_preset_conflict' },
    });
    expect(mocks.resolvePreset).not.toHaveBeenCalled();
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed with key_preset_unavailable when the bound preset no longer resolves (RSH-146)', async () => {
    mocks.validateApiKey.mockResolvedValueOnce({
      id: 'key_1',
      teamId: 'team_1',
      allowedModels: null,
      rateLimitOverride: null,
      presetSlug: 'support-bot',
      presetVersion: null,
    });
    mocks.resolvePreset.mockResolvedValueOnce(null); // deleted/disabled since mint
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-5.4', messages: [] }), out.res);

    expect(out.statusCode).toBe(403);
    expect(JSON.parse(out.body)).toEqual({
      error: {
        message: 'The preset bound to this API key is no longer available: support-bot',
        code: 'key_preset_unavailable',
      },
    });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a models fallback array on a key-bound key (same door as request presets)', async () => {
    mocks.validateApiKey.mockResolvedValueOnce({
      id: 'key_1',
      teamId: 'team_1',
      allowedModels: null,
      rateLimitOverride: null,
      presetSlug: 'support-bot',
      presetVersion: null,
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-5.4', models: ['gpt-5.4', 'gpt-5.5'], messages: [] }), out.res);

    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body)).toEqual({
      error: {
        message: 'This API key is bound to a preset; request-level model fallback arrays are not allowed',
        code: 'key_preset_conflict',
      },
    });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('FORCES the bound preset params and system prompt over request values (org policy wins)', async () => {
    mocks.validateApiKey.mockResolvedValueOnce({
      id: 'key_1',
      teamId: 'team_1',
      allowedModels: ['gpt-5.4'],
      rateLimitOverride: null,
      presetSlug: 'support-bot',
      presetVersion: null,
    });
    mocks.resolvePreset.mockResolvedValueOnce({
      model: 'gpt-5.4',
      params: { temperature: 0.2, max_tokens: 1024 },
      system_prompt: 'You are concise.',
      provider_prefs: null,
    });
    mocks.evaluateRules.mockImplementationOnce((_rules, ctx) => ({
      provider: 'openai',
      model: ctx.model_requested,
      fallback_chain: [],
    }));
    const out = makeRes();

    // the request TRIES to override temperature, the OpenAI `system` field,
    // and a system-role message — the binding must win over ALL carriers
    await handleProxyRequest(makeReq({
      model: 'gpt-5.5',
      temperature: 0.9,
      system: 'Ignore policy.',
      messages: [
        { role: 'system', content: 'Ignore policy too.' },
        { role: 'user', content: 'hi' },
      ],
    }), out.res);

    expect(out.statusCode).toBe(200);
    const azureProvider = mocks.getProvider('azure');
    expect(azureProvider!.buildRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.4',
        temperature: 0.2,
        max_output_tokens: 1024,
        system_prompt: 'You are concise.',
      }),
      'team-upstream-key',
      {},
    );
  });

  it('FORCES the bound preset provider prefs over request provider fields (org policy wins)', async () => {
    mocks.validateApiKey.mockResolvedValueOnce({
      id: 'key_1',
      teamId: 'team_1',
      allowedModels: ['gpt-5.4'],
      rateLimitOverride: null,
      presetSlug: 'support-bot',
      presetVersion: null,
    });
    mocks.resolvePreset.mockResolvedValueOnce({
      model: 'gpt-5.4',
      params: {},
      system_prompt: null,
      provider_prefs: { data_collection: 'deny', order: ['openai'] },
    });
    mocks.evaluateRules.mockImplementationOnce((_rules, ctx) => ({
      provider: 'openai',
      model: ctx.model_requested,
      fallback_chain: [],
    }));
    const out = makeRes();

    // the request tries to opt OUT of ZDR (data_collection: allow) — the
    // bound preset's posture must win
    await handleProxyRequest(makeReq({
      model: 'gpt-5.5',
      provider: { data_collection: 'allow', order: ['azure'] },
      messages: [{ role: 'user', content: 'hi' }],
    }), out.res);

    expect(out.statusCode).toBe(200);
    const azureProvider = mocks.getProvider('azure');
    expect(azureProvider!.buildRequest).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5.4' }),
      'team-upstream-key',
      {},
    );
    // request provider fields were dropped: the preset's ZDR posture was the
    // only input to the eligibility pass — assert via the 200 (a
    // data_collection: allow request override would not fail the ZDR path,
    // but the preset's deny is what reached the resolver)
    expect(mocks.evaluateRules).toHaveBeenCalledTimes(1);
  });

  it('rejects a routing decision that escapes the bound preset model (key_preset_model_mismatch)', async () => {
    mocks.validateApiKey.mockResolvedValueOnce({
      id: 'key_1',
      teamId: 'team_1',
      allowedModels: null, // no allowlist — the pin must hold on its own
      rateLimitOverride: null,
      presetSlug: 'support-bot',
      presetVersion: null,
    });
    mocks.resolvePreset.mockResolvedValueOnce({
      model: 'gpt-5.4',
      params: {},
      system_prompt: null,
      provider_prefs: null,
    });
    // a RULE routes to a different model — the binding must reject it
    mocks.evaluateRules.mockReturnValueOnce({
      provider: 'openai',
      model: 'gpt-5.5',
      fallback_chain: [{ provider: 'anthropic', model: 'claude-opus-4-8' }],
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-5.4', messages: [] }), out.res);

    expect(out.statusCode).toBe(403);
    expect(JSON.parse(out.body)).toEqual({
      error: {
        message: "This API key's preset pins model gpt-5.4; routing selected gpt-5.5",
        code: 'key_preset_model_mismatch',
      },
    });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('keeps preset-carried residency when an inline override adds unrelated provider prefs', async () => {
    mocks.resolvePreset.mockResolvedValueOnce({
      model: 'gpt-5.4',
      params: {},
      system_prompt: null,
      provider_prefs: { data_residency: ['EU-DE'] },
    });
    mocks.evaluateRules.mockImplementationOnce((_rules, ctx) => ({
      provider: 'openai',
      model: ctx.model_requested,
      fallback_chain: [],
    }));
    const out = makeRes();

    await handleProxyRequest(makeReq({
      model: '@preset/eu-only',
      provider: { order: ['azure'] },
      messages: [],
    }), out.res);

    expect(out.statusCode).toBe(422);
    expect(JSON.parse(out.body)).toMatchObject({
      error: { code: 'no_eligible_provider_residency' },
    });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('lets a well-formed inline residency list replace the preset one (field-level merge precedence) and rejects erase attempts', async () => {
    mocks.resolvePreset.mockResolvedValue({
      model: 'gpt-5.4',
      params: {},
      system_prompt: null,
      provider_prefs: { data_residency: ['EU-DE'] },
    });
    mocks.evaluateRules.mockImplementation((_rules, ctx) => ({
      provider: 'openai',
      model: ctx.model_requested,
      fallback_chain: [],
    }));

    // RSH-164 review round: the openai US evidence claim was withdrawn (a
    // "default" processing location is not a strict region guarantee), so
    // even a well-formed inline US list replaces the preset EU-DE but still
    // fails closed — no endpoint carries residency evidence yet.
    const replaced = makeRes();
    await handleProxyRequest(makeReq({
      model: '@preset/eu-only',
      provider: { data_residency: ['US'] },
      messages: [],
    }), replaced.res);
    expect(replaced.statusCode).toBe(422);
    expect(JSON.parse(replaced.body)).toMatchObject({ error: { code: 'no_eligible_provider_residency' } });
    expect(mocks.fetchMock).not.toHaveBeenCalled();

    for (const erase of [[], null, Array(17).fill('EU')]) {
      const out = makeRes();
      await handleProxyRequest(makeReq({
        model: '@preset/eu-only',
        provider: { data_residency: erase },
        messages: [],
      }), out.res);
      expect(out.statusCode).toBe(400);
      expect(JSON.parse(out.body)).toMatchObject({ error: { code: 'invalid_provider_prefs' } });
      expect(mocks.fetchMock).not.toHaveBeenCalled();
    }
  });

  it('merges preset provider defaults with an inline provider override field by field', async () => {
    mocks.resolvePreset.mockResolvedValueOnce({
      model: 'gpt-5.4',
      params: {},
      system_prompt: null,
      provider_prefs: { allow: ['anthropic'], data_collection: 'deny' },
    });
    mocks.evaluateRules.mockImplementationOnce((_rules, ctx) => ({
      provider: 'openai',
      model: ctx.model_requested,
      fallback_chain: [],
    }));
    const out = makeRes();

    await handleProxyRequest(makeReq({
      model: '@preset/zdr-only',
      provider: { sort: 'price' },
      messages: [],
    }), out.res);

    expect(out.statusCode).toBe(422);
    expect(JSON.parse(out.body)).toEqual({
      error: {
        message: 'No eligible provider for requested provider preferences',
        code: 'no_eligible_provider',
      },
    });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('rejects malformed persisted preset provider preferences before dispatch', async () => {
    mocks.resolvePreset.mockResolvedValueOnce({
      model: 'gpt-5.4',
      params: {},
      system_prompt: null,
      provider_prefs: ['not-a-provider-preferences-object'],
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: '@preset/malformed-prefs', messages: [] }), out.res);

    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body)).toEqual({
      error: { message: 'Invalid provider preferences', code: 'invalid_provider_prefs' },
    });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('rejects malformed direct provider preferences before upstream dispatch', async () => {
    const out = makeRes();

    await handleProxyRequest(makeReq({
      model: 'gpt-5.4',
      provider: { allow: ['evil-provider'] },
      messages: [],
    }), out.res);

    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body)).toEqual({
      error: { message: 'Invalid provider preferences', code: 'invalid_provider_prefs' },
    });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the canonical model when provider preferences choose an alternate endpoint', async () => {
    mocks.evaluateRules.mockImplementationOnce((_rules, ctx) => ({
      provider: 'openai',
      model: ctx.model_requested,
      fallback_chain: [],
    }));
    const out = makeRes();

    await handleProxyRequest(makeReq({
      model: 'gpt-5.4',
      provider: { order: ['azure'] },
      messages: [],
    }), out.res);

    expect(out.statusCode).toBe(200);
    const azureProvider = mocks.getProvider('azure');
    expect(azureProvider).toBeDefined();
    expect(azureProvider!.buildRequest).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5.4' }),
      'team-upstream-key',
      {},
    );
  });

  it('preserves configured fallbacks unless provider prefs explicitly disable them', async () => {
    mocks.evaluateRules.mockImplementationOnce((_rules, ctx) => ({
      provider: 'openai',
      model: ctx.model_requested,
      fallback_chain: [{ provider: 'anthropic', model: 'claude-haiku-4-5' }],
    }));
    mocks.fetchMock.mockRejectedValueOnce(new Error('network down'));
    mocks.executeFallbackChain.mockResolvedValueOnce({
      ok: true,
      response: new Response(JSON.stringify({ id: 'fallback_provider_prefs' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
      provider: mocks.getProvider('anthropic'),
      providerId: 'anthropic',
      model: 'claude-haiku-4-5',
      attempts: [],
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({
      model: 'gpt-5.4',
      provider: { data_collection: 'allow' },
      messages: [],
    }), out.res);

    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.body).raw).toEqual({ id: 'fallback_provider_prefs' });
    expect(mocks.executeFallbackChain).toHaveBeenCalledWith(
      [{ provider: 'anthropic', model: 'claude-haiku-4-5' }],
      expect.any(Object),
      expect.any(Function),
      expect.objectContaining({ provider: 'openai', model: 'gpt-5.4' }),
      expect.any(Object),
    );
  });

  it('filters configured fallbacks by provider constraints', async () => {
    mocks.evaluateRules.mockImplementationOnce((_rules, ctx) => ({
      provider: 'openai',
      model: ctx.model_requested,
      fallback_chain: [
        { provider: 'openai', model: 'gpt-5.4' },
        { provider: 'azure', model: 'gpt-5.4' },
      ],
    }));
    mocks.fetchMock.mockRejectedValueOnce(new Error('network down'));
    mocks.executeFallbackChain.mockResolvedValueOnce({
      ok: true,
      response: new Response(JSON.stringify({ id: 'azure_fallback' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
      provider: mocks.getProvider('azure'),
      providerId: 'azure',
      model: 'gpt-5.4',
      attempts: [],
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({
      model: 'gpt-5.4',
      provider: { allow: ['azure'] },
      messages: [],
    }), out.res);

    expect(out.statusCode).toBe(200);
    expect(mocks.executeFallbackChain).toHaveBeenCalledWith(
      [{ provider: 'azure', model: 'gpt-5.4' }],
      expect.any(Object),
      expect.any(Function),
      expect.objectContaining({ provider: 'azure', model: 'gpt-5.4' }),
      expect.any(Object),
    );
  });

  it('keeps sort-only preferences from changing the routed provider', async () => {
    mocks.evaluateRules.mockImplementationOnce((_rules, ctx) => ({
      provider: 'azure',
      model: ctx.model_requested,
      fallback_chain: [],
    }));
    const out = makeRes();

    await handleProxyRequest(makeReq({
      model: 'gpt-5.4',
      provider: { sort: 'price' },
      messages: [],
    }), out.res);

    expect(out.statusCode).toBe(200);
    const azureProvider = mocks.getProvider('azure');
    expect(azureProvider).toBeDefined();
    expect(azureProvider!.buildRequest).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5.4' }),
      'team-upstream-key',
      {},
    );
  });

  it('uses provider.sort=price to pick the cheapest deterministic endpoint', async () => {
    mocks.evaluateRules.mockImplementationOnce((_rules, ctx) => ({
      provider: 'openai',
      model: ctx.model_requested,
      fallback_chain: [],
    }));
    const out = makeRes();

    await handleProxyRequest(makeReq({
      model: 'gpt-5.5-pro',
      provider: { sort: 'price' },
      messages: [],
    }), out.res);

    expect(out.statusCode).toBe(200);
    expect(out.headers['X-RouteShift-Provider']).toBe('azure');
    expect(out.headers['X-RouteShift-Model']).toBe('gpt-5.5-pro');
  });

  it('does not pick a cheaper provider when that provider has no dispatch credentials', async () => {
    mocks.hasEnabledProviderKey.mockImplementation(async (_teamId: string, provider: string) => provider !== 'azure');
    mocks.evaluateRules.mockImplementationOnce((_rules, ctx) => ({
      provider: 'openai',
      model: ctx.model_requested,
      fallback_chain: [],
    }));
    const out = makeRes();

    await handleProxyRequest(makeReq({
      model: 'gpt-5.5-pro',
      provider: { sort: 'price' },
      messages: [],
    }), out.res);

    expect(out.statusCode).toBe(200);
    expect(out.headers['X-RouteShift-Provider']).toBe('openai');
    expect(mocks.getProvider('openai')!.buildRequest).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5.5-pro' }),
      'team-upstream-key',
      {},
    );
  });

  it('prefers provider over legacy provider_preferences when both are present', async () => {
    mocks.evaluateRules.mockImplementationOnce((_rules, ctx) => ({
      provider: 'openai',
      model: ctx.model_requested,
      fallback_chain: [],
    }));
    const out = makeRes();

    await handleProxyRequest(makeReq({
      model: 'gpt-5.5-pro',
      provider: { allow: ['openai'] },
      provider_preferences: { allow: ['azure'] },
      messages: [],
    }), out.res);

    expect(out.statusCode).toBe(200);
    expect(out.headers['X-RouteShift-Provider']).toBe('openai');
    expect(mocks.getProvider('openai')!.buildRequest).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5.5-pro' }),
      'team-upstream-key',
      {},
    );
  });

  it('feeds credential availability signals into auto-route before upstream dispatch', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    mocks.evaluateRules.mockReturnValueOnce({
      provider: 'openai',
      model: 'gpt-5',
      fallback_chain: [],
      is_default: true,
    });
    mocks.getAutoRouteSettings.mockResolvedValueOnce({ enabled: true, strategy: 'balanced', max_fallbacks: 0 });
    mocks.getAutoRouteProviderSignals.mockResolvedValueOnce([
      { provider: 'openai', credential_available: false, unavailable_reason: 'missing_platform_provider_key_for_credits_billing' },
      { provider: 'google', credential_available: true },
    ]);
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-5', messages: [] }), out.res);

    expect(out.statusCode).toBe(200);
    expect(mocks.getAutoRouteProviderSignals).toHaveBeenCalledWith('team_1', 'subscription');
    expect(out.headers['X-RouteShift-Provider']).toBe('google');
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('auto_route_provider_skips'));
    infoSpy.mockRestore();
  });

  it('maps :floor to provider.sort=price and strips the suffix before upstream dispatch', async () => {
    mocks.evaluateRules.mockImplementationOnce((_rules, ctx) => ({
      provider: 'openai',
      model: ctx.model_requested,
      fallback_chain: [],
    }));
    const out = makeRes();

    await handleProxyRequest(makeReq({
      model: 'gpt-5.5-pro:floor',
      messages: [],
    }), out.res);

    expect(out.statusCode).toBe(200);
    expect(out.headers['X-RouteShift-Provider']).toBe('azure');
    expect(out.headers['X-RouteShift-Model']).toBe('gpt-5.5-pro');
    expect(mocks.getProvider('azure')!.buildRequest).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5.5-pro' }),
      'team-upstream-key',
      {},
    );
  });

  it('maps :nitro to deterministic throughput sorting and strips the suffix', async () => {
    mocks.evaluateRules.mockImplementationOnce((_rules, ctx) => ({
      provider: 'openai',
      model: ctx.model_requested,
      fallback_chain: [],
    }));
    const out = makeRes();

    await handleProxyRequest(makeReq({
      model: 'gpt-5.4:nitro',
      messages: [],
    }), out.res);

    expect(out.statusCode).toBe(200);
    expect(out.headers['X-RouteShift-Provider']).toBe('openai');
    expect(out.headers['X-RouteShift-Model']).toBe('gpt-5.4');
  });

  it('rejects unsupported provider.sort values before routing instead of pretending they applied', async () => {
    const out = makeRes();

    await handleProxyRequest(makeReq({
      model: 'gpt-5.4',
      provider: { sort: 'latency' },
      messages: [],
    }), out.res);

    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body)).toEqual({
      error: {
        message: 'Invalid provider preferences',
        code: 'invalid_provider_prefs',
      },
    });
    expect(mocks.evaluateRules).not.toHaveBeenCalled();
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('only disables fallbacks for allow_fallbacks=false without changing the primary provider', async () => {
    mocks.evaluateRules.mockImplementationOnce((_rules, ctx) => ({
      provider: 'azure',
      model: ctx.model_requested,
      fallback_chain: [{ provider: 'openai', model: 'gpt-5.4' }],
    }));
    mocks.fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'azure_primary' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const out = makeRes();

    await handleProxyRequest(makeReq({
      model: 'gpt-5.4',
      provider: { allow_fallbacks: false },
      messages: [],
    }), out.res);

    expect(out.statusCode).toBe(200);
    const azureProvider = mocks.getProvider('azure');
    expect(azureProvider).toBeDefined();
    expect(azureProvider!.buildRequest).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5.4' }),
      'team-upstream-key',
      {},
    );
    expect(mocks.executeFallbackChain).not.toHaveBeenCalled();
  });

  it('validates models[] shape before routing', async () => {
    const out = makeRes();

    await handleProxyRequest(makeReq({
      model: 'gpt-5.4',
      models: ['other-model'],
      messages: [],
    }), out.res);

    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body)).toEqual({
      error: { message: 'models[0] must match model when both are provided', code: 'invalid_models' },
    });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('rejects disallowed explicit models[] entries instead of silently dropping them', async () => {
    mocks.validateApiKey.mockResolvedValueOnce({
      id: 'key_1',
      teamId: 'team_1',
      allowedModels: ['gpt-5.4'],
      rateLimitOverride: null,
      metadata: {},
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({
      models: ['gpt-5.4', 'claude-haiku-4-5'],
      messages: [],
    }), out.res);

    expect(out.statusCode).toBe(403);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'Model is not permitted for this API key' } });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('uses models[] as the ordered fallback chain instead of rule fallbacks', async () => {
    mocks.evaluateRules.mockImplementationOnce((_rules, ctx) => ({
      provider: 'azure',
      model: ctx.model_requested,
      fallback_chain: [{ provider: 'openai', model: 'rule-fallback-should-not-run' }],
    }));
    mocks.fetchMock.mockRejectedValueOnce(new Error('primary down'));
    mocks.executeFallbackChain.mockResolvedValueOnce({
      ok: true,
      response: new Response(JSON.stringify({ id: 'explicit_fallback' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
      provider: mocks.getProvider('anthropic'),
      providerId: 'anthropic',
      model: 'claude-haiku-4-5',
      attempts: [],
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({
      models: ['gpt-5.4', 'claude-haiku-4-5'],
      messages: [],
    }), out.res);

    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.body).raw).toEqual({ id: 'explicit_fallback' });
    expect(mocks.executeFallbackChain).toHaveBeenCalledWith(
      [{ provider: 'anthropic', model: 'claude-haiku-4-5' }],
      expect.any(Object),
      expect.any(Function),
      expect.objectContaining({ provider: 'azure', model: 'gpt-5.4' }),
      expect.any(Object),
    );
  });

  it('rejects a platform-only explicit fallback in subscription mode', async () => {
    process.env.ANTHROPIC_API_KEY = 'anthropic-platform-key';
    mocks.hasEnabledProviderKey.mockImplementation(async (_teamId: string, provider: string) => (
      provider === 'openai'
    ));
    const out = makeRes();

    await handleProxyRequest(makeReq({
      models: ['gpt-4o-mini', 'claude-haiku-4-5'],
      messages: [],
    }), out.res);

    expect(out.statusCode).toBe(422);
    expect(JSON.parse(out.body)).toEqual({
      error: {
        message: 'No credential-configured provider is available for requested provider preferences',
        code: 'selected_provider_missing_credentials',
      },
    });
    expect(mocks.getDecryptedProviderKey).not.toHaveBeenCalled();
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('keeps explicit provider overrides ahead of fallback model suffixes', async () => {
    mocks.evaluateRules.mockImplementationOnce((_rules, ctx) => ({
      provider: 'openai',
      model: ctx.model_requested,
      fallback_chain: [],
    }));
    mocks.fetchMock.mockRejectedValueOnce(new Error('primary down'));
    mocks.executeFallbackChain.mockResolvedValueOnce({
      ok: true,
      response: new Response(JSON.stringify({ id: 'explicit_precedence_fallback' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
      provider: mocks.getProvider('openai'),
      providerId: 'openai',
      model: 'gpt-5.5-pro',
      attempts: [],
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({
      model: 'gpt-5.5-pro',
      models: ['gpt-5.5-pro', 'gpt-5.5-pro:floor'],
      provider: { sort: 'throughput' },
      messages: [],
    }), out.res);

    expect(out.statusCode).toBe(200);
    expect(mocks.executeFallbackChain).toHaveBeenCalledWith(
      [{ provider: 'openai', model: 'gpt-5.5-pro' }],
      expect.any(Object),
      expect.any(Function),
      expect.objectContaining({ provider: 'openai', model: 'gpt-5.5-pro' }),
      expect.any(Object),
    );
  });

  it('honors allow_fallbacks=false for explicit models[] chains', async () => {
    mocks.evaluateRules.mockImplementationOnce((_rules, ctx) => ({
      provider: 'azure',
      model: ctx.model_requested,
      fallback_chain: [],
    }));
    mocks.fetchMock.mockRejectedValueOnce(new Error('primary down'));
    const out = makeRes();

    await handleProxyRequest(makeReq({
      models: ['gpt-5.4', 'claude-haiku-4-5'],
      provider: { allow_fallbacks: false },
      messages: [],
    }), out.res);

    expect(out.statusCode).toBe(502);
    expect(mocks.executeFallbackChain).not.toHaveBeenCalled();
  });

  it('returns an identical 404 for unknown or cross-team preset refs', async () => {
    mocks.resolvePreset.mockResolvedValueOnce(null);
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: '@preset/support-bot', messages: [] }), out.res);

    expect(out.statusCode).toBe(404);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'Preset not found', code: 'preset_not_found' } });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('returns 502 when upstream request throws without fallback', async () => {
    mocks.fetchMock.mockRejectedValueOnce(new Error('network down'));
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(502);
    expect(mocks.circuitBreaker.recordFailure).toHaveBeenCalledWith('openai', 'gpt-4o-mini');
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'Upstream request failed' } });
  });

  it('uses fallback response when upstream request throws', async () => {
    mocks.evaluateRules.mockReturnValueOnce({
      provider: 'openai',
      model: 'gpt-4o-mini',
      fallback_chain: [{ provider: 'anthropic', model: 'claude-haiku-4-5' }],
    });
    mocks.fetchMock.mockRejectedValueOnce(new Error('network down'));
    mocks.executeFallbackChain.mockResolvedValueOnce({
      ok: true,
      response: new Response(JSON.stringify({ id: 'fallback_network' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
      provider: mocks.getProvider('anthropic'),
      providerId: 'anthropic',
      model: 'claude-haiku-4-5',
      attempts: [],
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.body).raw).toEqual({ id: 'fallback_network' });
    expect(JSON.parse(out.body).object).toBe('chat.completion');
    expect(mocks.executeFallbackChain).toHaveBeenCalledTimes(1);
  });

  it('retains credits and logs an unknown lower bound when a post-acceptance primary fetch rejects before fallback succeeds', async () => {
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    mocks.evaluateRules.mockReturnValueOnce({
      provider: 'openai', model: 'gpt-4o-mini',
      fallback_chain: [{ provider: 'anthropic', model: 'claude-haiku-4-5' }],
    });
    mocks.fetchMock.mockRejectedValueOnce(new Error('connection reset'));
    mocks.executeFallbackChain.mockResolvedValueOnce({
      ok: true,
      response: new Response(JSON.stringify({ id: 'fallback_unknown_primary' }), { status: 200 }),
      provider: mocks.getProvider('anthropic'), providerId: 'anthropic', model: 'claude-haiku-4-5',
      attempts: [{ provider: 'openai', model: 'gpt-4o-mini', error: 'Network error: connection reset', actual_cost_known: false }],
      aggregateActualCostKnown: false,
      aggregateActualCostMicrocents: 0,
      aggregateInputTokens: 0,
      aggregateOutputTokens: 0,
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(200);
    expect(mocks.reserveCredits).toHaveBeenCalled();
    expect(mocks.settleReservedCredits).not.toHaveBeenCalled();
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      actual_cost_known: false,
      fallback_attempts: [expect.objectContaining({ actual_cost_known: false })],
    }));
  });

  it('does not expose a platform credential to subscription fallback dispatch', async () => {
    process.env.ANTHROPIC_API_KEY = 'anthropic-platform-key';
    mocks.evaluateRules.mockReturnValueOnce({
      provider: 'openai',
      model: 'gpt-4o-mini',
      fallback_chain: [{ provider: 'anthropic', model: 'claude-haiku-4-5' }],
    });
    mocks.getDecryptedProviderKey
      .mockResolvedValueOnce({ key: 'team-openai-key', metadata: {}, label: 'primary' })
      .mockResolvedValueOnce(null);
    mocks.fetchMock.mockRejectedValueOnce(new Error('network down'));
    let fallbackConfig: unknown = 'not-called';
    mocks.executeFallbackChain.mockImplementationOnce(async (
      _chain: unknown,
      _canonical: unknown,
      getProviderConfig: (provider: string) => Promise<unknown>,
    ) => {
      fallbackConfig = await getProviderConfig('anthropic');
      return { ok: false, attempts: [] };
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(502);
    expect(fallbackConfig).toBeUndefined();
  });

  it('requires known pricing on every credits-funded fallback attempt', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    mocks.evaluateRules.mockReturnValueOnce({
      provider: 'openai',
      model: 'gpt-4o-mini',
      fallback_chain: [{ provider: 'anthropic', model: 'claude-haiku-4-5' }],
    });
    mocks.fetchMock.mockRejectedValueOnce(new Error('network down'));
    mocks.executeFallbackChain.mockResolvedValueOnce({ ok: false, attempts: [] });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(502);
    expect(mocks.executeFallbackChain).toHaveBeenCalledWith(
      [{ provider: 'anthropic', model: 'claude-haiku-4-5' }],
      expect.any(Object),
      expect.any(Function),
      expect.objectContaining({ provider: 'openai', model: 'gpt-4o-mini' }),
      expect.objectContaining({
        requireKnownPricing: true,
        pricingResolver: mocks.getCreditPricing,
      }),
    );
    errSpy.mockRestore();
  });

  it('uses DB-aware pricing for subscription fallback max-cost without requiring known pricing', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.evaluateRules.mockReturnValueOnce({
      provider: 'openai', model: 'gpt-4o-mini',
      fallback_chain: [{ provider: 'anthropic', model: 'claude-haiku-4-5' }],
    });
    mocks.fetchMock.mockRejectedValueOnce(new Error('network down'));
    mocks.executeFallbackChain.mockResolvedValueOnce({ ok: false, attempts: [] });
    const out = makeRes();

    await handleProxyRequest(makeReq({
      model: 'gpt-4o-mini', messages: [], routeshift: { max_cost_microcents: 100 },
    }), out.res);

    const budget = mocks.executeFallbackChain.mock.calls[0]?.[4];
    expect(budget).toEqual(expect.objectContaining({ pricingResolver: mocks.getCreditPricing }));
    expect(budget?.requireKnownPricing).not.toBe(true);
    errSpy.mockRestore();
  });

  it('returns 429 when rate limit is exceeded', async () => {
    mocks.rateCheck.mockReturnValueOnce({ allowed: false, remaining: 0, resetMs: 12000 });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(429);
    expect(out.headers['Retry-After']).toBe('12');
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'Rate limit exceeded' } });
  });

  it('returns 402 when credit preflight check fails', async () => {
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    mocks.preFlightCreditCheck.mockResolvedValueOnce({ allowed: false, balance: 10, estimatedCost: 500 });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }), out.res);

    expect(out.statusCode).toBe(402);
    expect(out.headers['X-RouteShift-Credits-Remaining']).toBe('10');
    expect(out.headers['X-RouteShift-Estimated-Cost']).toBe('500');
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('returns 503 when credits mode has no pricing for the routed model', async () => {
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    mocks.preFlightCreditCheck.mockResolvedValueOnce({
      allowed: false,
      balance: 0,
      estimatedCost: 0,
      reason: 'missing_pricing',
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }), out.res);

    expect(out.statusCode).toBe(503);
    expect(JSON.parse(out.body)).toEqual({
      error: {
        message: 'Credits billing is unavailable for openai:gpt-4o-mini because pricing is not configured',
        code: 'missing_model_pricing',
      },
    });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      status_code: 503,
      error_type: 'missing_model_pricing',
      billing_mode: 'credits',
    }));
  });

  it('returns cached response when cache entry exists', async () => {
    mocks.responseCache.isCacheable.mockReturnValueOnce(true);
    mocks.responseCache.get.mockReturnValueOnce({
      body: { id: 'cached_1' },
      usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
      provider: 'openai',
      model: 'gpt-4o-mini',
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(200);
    expect(out.headers['X-RouteShift-Cache']).toBe('HIT');
    expect(mocks.fetchMock).not.toHaveBeenCalled();
    expect(mocks.logRequest).toHaveBeenCalledTimes(1);
  });
  it('retains reasoning tokens in a cache-hit log row', async () => {
    mocks.responseCache.isCacheable.mockReturnValueOnce(true);
    mocks.responseCache.get.mockReturnValueOnce({
      body: { id: 'cached_reasoning' },
      usage: { input_tokens: 3, output_tokens: 4, reasoning_tokens: 3, total_tokens: 7 },
      provider: 'openai',
      model: 'gpt-4o-mini',
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      cache_hit: true,
      reasoning_tokens: 3,
    }));
  });

  it('settles reserved credits on cache hit in credits mode', async () => {
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    mocks.responseCache.isCacheable.mockReturnValueOnce(true);
    mocks.responseCache.get.mockReturnValueOnce({
      body: { id: 'cached_credits' },
      usage: { input_tokens: 5, output_tokens: 6, total_tokens: 11 },
      provider: 'openai',
      model: 'gpt-4o-mini',
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(200);
    expect(mocks.reserveCredits).toHaveBeenCalledWith(
      'team_1', 100, expect.any(String), 'gpt-4o-mini preflight', 3.5,
    );
    expect(mocks.settleReservedCredits).toHaveBeenCalledWith(
      'team_1',
      100,
      80,
      3.5,
      expect.any(String),
      'cache hit: gpt-4o-mini',
    );
    expect(mocks.deductCredits).not.toHaveBeenCalled();
    expect(mocks.checkAutoTopUpNeeded).toHaveBeenCalledTimes(1);
  });

  it('does not return a cached credits response when credit deduction fails', async () => {
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    mocks.settleReservedCredits.mockResolvedValueOnce({ success: false, newBalance: 4, amountDeducted: 100 });
    mocks.responseCache.isCacheable.mockReturnValueOnce(true);
    mocks.responseCache.get.mockReturnValueOnce({
      body: { id: 'cached_credits' },
      usage: { input_tokens: 5, output_tokens: 6, total_tokens: 11 },
      provider: 'openai',
      model: 'gpt-4o-mini',
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(402);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'Insufficient credits', code: 'credit_deduction_failed' } });
    expect(out.headers['X-RouteShift-Cache']).toBeUndefined();
    expect(mocks.fetchMock).not.toHaveBeenCalled();
    expect(mocks.deductCredits).not.toHaveBeenCalled();
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      status_code: 402,
      error_type: 'credit_deduction_failed',
    }));
  });

  it('returns 503 when circuit breaker is open and no fallback succeeds', async () => {
    mocks.circuitBreaker.isOpen.mockReturnValueOnce(true);
    mocks.evaluateRules.mockReturnValueOnce({
      provider: 'openai',
      model: 'gpt-4o-mini',
      fallback_chain: [{ provider: 'anthropic', model: 'claude-3-5-sonnet' }],
    });
    mocks.executeFallbackChain.mockResolvedValueOnce({ ok: false, attempts: [] });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(503);
    expect(JSON.parse(out.body)).toEqual({
      error: {
        message: 'Service temporarily unavailable for gpt-4o-mini',
        code: 'fallback_exhausted',
        fallback_attempts: [],
      },
    });
  });

  it('retains credits and records a lower bound when a circuit-open fallback exhausts after an ambiguous dispatch', async () => {
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    mocks.circuitBreaker.isOpen.mockReturnValueOnce(true);
    mocks.evaluateRules.mockReturnValueOnce({
      provider: 'openai', model: 'gpt-4o-mini',
      fallback_chain: [{ provider: 'anthropic', model: 'claude-3-5-sonnet' }],
    });
    mocks.executeFallbackChain.mockResolvedValueOnce({
      ok: false,
      attempts: [{ provider: 'anthropic', model: 'claude-3-5-sonnet', error: 'network reset', actual_cost_known: false }],
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(503);
    expect(mocks.settleReservedCredits).not.toHaveBeenCalled();
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      error_type: 'fallback_exhausted', actual_cost_known: false, actual_cost_microcents: 0,
    }));
  });

  it('returns 503 when fallback feature is disabled by plan', async () => {
    mocks.getPlanLimits.mockReturnValueOnce({
      maxKeys: 50,
      maxRules: Infinity,
      fallbacksEnabled: false,
      savingsSharePercent: 3,
      creditsMarkupPercent: 3.5,
    });
    mocks.circuitBreaker.isOpen.mockReturnValueOnce(true);
    mocks.evaluateRules.mockReturnValueOnce({
      provider: 'openai',
      model: 'gpt-4o-mini',
      fallback_chain: [{ provider: 'anthropic', model: 'claude-3-5-sonnet' }],
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(503);
    expect(mocks.executeFallbackChain).not.toHaveBeenCalled();
  });

  it('uses fallback response when circuit breaker is open and fallback succeeds', async () => {
    mocks.circuitBreaker.isOpen.mockReturnValueOnce(true);
    mocks.evaluateRules.mockReturnValueOnce({
      provider: 'openai',
      model: 'gpt-4o-mini',
      fallback_chain: [{ provider: 'openai', model: 'gpt-4o-mini' }],
    });
    mocks.executeFallbackChain.mockResolvedValueOnce({
      ok: true,
      response: new Response(JSON.stringify({ id: 'fallback' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
      provider: mocks.getProvider('openai'),
      providerId: 'openai',
      model: 'gpt-4o-mini',
      attempts: [],
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.body).raw).toEqual({ id: 'fallback' });
    expect(JSON.parse(out.body).object).toBe('chat.completion');
    expect(out.headers['X-RateLimit-Remaining']).toBe('77');
  });

  it('retains credits and logs unknown cost when a circuit-open fallback succeeds after an ambiguous predecessor', async () => {
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    mocks.circuitBreaker.isOpen.mockReturnValueOnce(true);
    mocks.evaluateRules.mockReturnValueOnce({
      provider: 'openai', model: 'gpt-4o-mini',
      fallback_chain: [{ provider: 'anthropic', model: 'claude-3-5-sonnet' }],
    });
    mocks.executeFallbackChain.mockResolvedValueOnce({
      ok: true,
      response: new Response(JSON.stringify({ id: 'fallback_unknown_circuit' }), { status: 200 }),
      provider: mocks.getProvider('anthropic'), providerId: 'anthropic', model: 'claude-3-5-sonnet',
      attempts: [{ provider: 'anthropic', model: 'claude-3-5-sonnet', error: 'network reset', actual_cost_known: false }],
      aggregateActualCostKnown: false,
      aggregateActualCostMicrocents: 0,
      aggregateInputTokens: 0,
      aggregateOutputTokens: 0,
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    expect(out.statusCode).toBe(200);
    expect(mocks.reserveCredits).toHaveBeenCalled();
    expect(mocks.settleReservedCredits).not.toHaveBeenCalled();
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      actual_cost_known: false,

      fallback_attempts: [expect.objectContaining({ actual_cost_known: false })],
    }));
  });

  it('handles streaming success path with relay', async () => {
    mocks.fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));
    const out = makeRes();

    await handleProxyRequest(
      makeReq({ model: 'gpt-4o-mini', stream: true, messages: [{ role: 'user', content: 'stream me' }] }),
      out.res,
    );

    expect(mocks.relayStream).toHaveBeenCalledTimes(1);
    // RSH-138: an active budget reservation now supplies a composed lease
    // (credit + budget refresh) even in subscription mode.
    expect(mocks.relayStream).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ intervalMs: 5 * 60 * 1000, refresh: expect.any(Function) }),
    );
    expect(mocks.logRequest).toHaveBeenCalledTimes(1);
    const logged = mocks.logRequest.mock.calls[0]?.[0] as { is_streaming?: boolean };
    expect(logged.is_streaming).toBe(true);
  });

  it('logs reasoning telemetry on streaming success', async () => {
    const provider = mocks.getProvider('openai');
    if (!provider) throw new Error('openai provider mock missing');
    provider.extractUsage.mockReturnValueOnce({
      input_tokens: 12,
      output_tokens: 8,
      reasoning_tokens: 7,
      total_tokens: 20,
    });
    mocks.computeRequestCost.mockResolvedValueOnce({
      original_cost_microcents: 100,
      original_cost_known: true,
      actual_cost_microcents: 80,
      actual_cost_known: true,
      reasoning_cost_microcents: 42,
      savings_microcents: 20,
    });
    mocks.relayStream.mockResolvedValueOnce({
      chunks: [],
      ttft_ms: 123,
      statusCode: 200,
      clientAborted: false,
    });
    const out = makeRes();

    await handleProxyRequest(
      makeReq({ model: 'gpt-4o-mini', stream: true, messages: [{ role: 'user', content: 'think' }] }),
      out.res,
    );

    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      reasoning_tokens: 7,
      reasoning_cost_microcents: 42,
    }));
  });

  it('estimates streaming input tokens when the provider reports none (Groq/Qwen)', async () => {
    // Providers with streaming_usage:false never emit a usage chunk, so
    // extractUsage returns input_tokens=0. The handler must fall back to a
    // char/4 estimate so the input is not billed/logged as zero.
    mocks.fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));
    const providerMock = mocks.getProvider('openai') as NonNullable<ReturnType<typeof mocks.getProvider>>;
    providerMock.extractUsage.mockReturnValueOnce({ input_tokens: 0, output_tokens: 8, total_tokens: 8 });
    const out = makeRes();

    await handleProxyRequest(
      // "stream me" is 9 chars -> ceil(9/4) = 3 estimated input tokens.
      makeReq({ model: 'gpt-4o-mini', stream: true, messages: [{ role: 'user', content: 'stream me' }] }),
      out.res,
    );

    const logged = mocks.logRequest.mock.calls[0]?.[0] as { input_tokens?: number; total_tokens?: number };
    expect(logged.input_tokens).toBe(3);
    expect(logged.total_tokens).toBe(11);
    // The estimate must also feed TPM reconciliation and the cost computation.
    expect(mocks.reconcileTokens).toHaveBeenCalledWith(expect.anything(), 3);
    const costUsage = mocks.computeRequestCost.mock.calls[0]?.[4] as { input_tokens?: number };
    expect(costUsage.input_tokens).toBe(3);
  });

  it('keeps actually-consumed tokens charged to TPM when post-response cost computation fails', async () => {
    // Regression (Codex review of PR #62, P2): a throw AFTER the upstream
    // returns 200 — e.g. a pricing-DB outage inside computeRequestCost — must
    // NOT release the request's actual input tokens from the rolling TPM
    // window. The non-stream success path reconciles the pre-flight estimate to
    // the upstream's actual input_tokens BEFORE cost runs, and the response
    // catch no longer zeroes the estimate; otherwise a sustained accounting
    // outage would let a tenant bypass per-key/team TPM caps via repeated
    // post-200 failures.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.computeRequestCostDetailed.mockRejectedValueOnce(new Error('pricing db down'));
    const out = makeRes();

    await handleProxyRequest(
      makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
      out.res,
    );

    // provider.parseResponse reports 10 actual input tokens, so the estimate is
    // reconciled to 10 before the (failing) cost computation.
    expect(mocks.reconcileTokens).toHaveBeenCalledWith(expect.anything(), 10);
    // It must never be released to 0 on this post-200 processing-failure path.
    expect(mocks.reconcileTokens).not.toHaveBeenCalledWith(expect.anything(), 0);
    expect(out.statusCode).toBe(502);
    errSpy.mockRestore();
  });

  it('keeps provider-reported streaming input tokens unchanged', async () => {
    // When the provider DOES report usage, the estimate fallback must not fire.
    mocks.fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));
    const out = makeRes();

    await handleProxyRequest(
      makeReq({ model: 'gpt-4o-mini', stream: true, messages: [{ role: 'user', content: 'stream me' }] }),
      out.res,
    );

    // default extractUsage mock => input_tokens: 12 (not the char/4 estimate).
    const logged = mocks.logRequest.mock.calls[0]?.[0] as { input_tokens?: number };
    expect(logged.input_tokens).toBe(12);
  });

  it('reserves credits before upstream fetch in credits mode', async () => {
    const order: string[] = [];
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    mocks.reserveCredits.mockImplementationOnce(async () => {
      order.push('reserve');
      return { success: true, newBalance: 99900, amountDeducted: 100 };
    });
    mocks.fetchMock.mockImplementationOnce(async () => {
      order.push('fetch');
      return new Response(JSON.stringify({ id: 'up_order' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const out = makeRes();

    await handleProxyRequest(
      makeReq({ model: 'gpt-4o-mini', stream: false, messages: [{ role: 'user', content: 'bill me' }] }),
      out.res,
    );

    expect(out.statusCode).toBe(200);
    expect(order.slice(0, 2)).toEqual(['reserve', 'fetch']);
  });

  it('402s without upstream fetch when credit reservation fails after preflight', async () => {
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    mocks.reserveCredits.mockResolvedValueOnce({ success: false, newBalance: 4, amountDeducted: 0 });
    const out = makeRes();

    await handleProxyRequest(
      makeReq({ model: 'gpt-4o-mini', stream: false, messages: [{ role: 'user', content: 'bill me' }] }),
      out.res,
    );

    expect(out.statusCode).toBe(402);
    expect(out.headers['X-RouteShift-Credits-Remaining']).toBe('4');
    expect(out.headers['X-RouteShift-Estimated-Cost']).toBe('100');
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'Insufficient credits', code: 'credit_reservation_failed' } });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      status_code: 402,
      error_type: 'credit_reservation_failed',
    }));
  });

  it('retains the credit reservation when upstream dispatch may have been accepted but fetch rejects', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    mocks.fetchMock.mockRejectedValueOnce(new Error('network down'));
    const out = makeRes();

    await handleProxyRequest(
      makeReq({ model: 'gpt-4o-mini', stream: false, messages: [{ role: 'user', content: 'bill me' }] }),
      out.res,
    );

    expect(out.statusCode).toBe(502);
    expect(mocks.settleReservedCredits).not.toHaveBeenCalled();
    expect(mocks.settleReservedCreditsWithUnknownCostHold).toHaveBeenCalledOnce();
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({ actual_cost_known: false }));
    errSpy.mockRestore();
  });

  it('never releases an ambiguous reservation when the durable hold write fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    mocks.fetchMock.mockRejectedValueOnce(new Error('network down'));
    mocks.settleReservedCreditsWithUnknownCostHold.mockRejectedValueOnce(new Error('postgres down'));
    const out = makeRes();

    await handleProxyRequest(
      makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'bill me' }] }),
      out.res,
    );

    expect(out.statusCode).toBe(502);
    expect(mocks.settleReservedCreditsWithUnknownCostHold).toHaveBeenCalledOnce();
    expect(mocks.settleReservedCredits).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('settles reserved credits after non-stream success in credits mode', async () => {
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    const out = makeRes();

    await handleProxyRequest(
      makeReq({ model: 'gpt-4o-mini', stream: false, messages: [{ role: 'user', content: 'bill me' }] }),
      out.res,
    );

    expect(out.statusCode).toBe(200);
    expect(mocks.settleReservedCredits).toHaveBeenCalledWith(
      'team_1',
      100,
      80,
      3.5,
      expect.any(String),
      'gpt-4o-mini (15 tokens)',
    );
    expect(mocks.deductCredits).not.toHaveBeenCalled();
    expect(mocks.checkAutoTopUpNeeded).toHaveBeenCalledTimes(1);
  });

  it('retains a dispatched non-stream reservation when exact settlement returns false', async () => {
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    mocks.settleReservedCredits.mockResolvedValueOnce({ success: false, newBalance: 3, amountDeducted: 100 });
    const out = makeRes();

    await handleProxyRequest(
      makeReq({ model: 'gpt-4o-mini', stream: false, messages: [{ role: 'user', content: 'bill me' }] }),
      out.res,
    );

    expect(out.statusCode).toBe(402);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'Insufficient credits', code: 'credit_deduction_failed' } });
    expect(mocks.responseCache.set).not.toHaveBeenCalled();
    expect(mocks.deductCredits).not.toHaveBeenCalled();
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      status_code: 402,
      error_type: 'credit_deduction_failed',
      actual_cost_known: true,
      actual_cost_microcents: 80,
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    }));
    // The provider already served known paid work. A second, zero-cost call
    // here would refund that spend through the outer finally.
    expect(mocks.settleReservedCredits).toHaveBeenCalledTimes(1);
    expect(mocks.settleReservedCredits).toHaveBeenCalledWith(
      'team_1',
      100,
      80,
      3.5,
      expect.any(String),
      'gpt-4o-mini (15 tokens)',
    );
  });

  it('settles reserved credits after streaming success in credits mode', async () => {
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    mocks.fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));
    const out = makeRes();

    await handleProxyRequest(
      makeReq({ model: 'gpt-4o-mini', stream: true, messages: [{ role: 'user', content: 'stream me' }] }),
      out.res,
    );

    expect(mocks.reserveCredits).toHaveBeenCalledWith(
      'team_1', 100, expect.any(String), 'gpt-4o-mini preflight', 3.5,
    );
    expect(mocks.settleReservedCredits).toHaveBeenCalledWith(
      'team_1',
      100,
      80,
      3.5,
      expect.any(String),
      'gpt-4o-mini (20 tokens)',
    );
    expect(mocks.deductCredits).not.toHaveBeenCalled();
    expect(mocks.checkAutoTopUpNeeded).toHaveBeenCalledTimes(1);
  });

  it('retains credits on a malformed non-stream 200 instead of refunding unknown spend', async () => {
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    mocks.fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }));
    const out = makeRes();
    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);
    expect(out.statusCode).toBe(502);
    expect(mocks.settleReservedCredits).not.toHaveBeenCalled();
    expect(mocks.settleReservedCreditsWithUnknownCostHold).toHaveBeenCalledOnce();
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      error_type: 'upstream_response_cost_unknown',
      actual_cost_known: false,
    }));
  });

  it('keeps exact response cost qualified when final credit settlement throws', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    mocks.settleReservedCredits.mockRejectedValueOnce(new Error('settlement database unavailable'));
    const out = makeRes();

    await handleProxyRequest(
      makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'bill me' }] }),
      out.res,
    );

    expect(out.statusCode).toBe(502);
    expect(mocks.settleReservedCredits).toHaveBeenCalledOnce();
    expect(mocks.settleReservedCreditsWithUnknownCostHold).not.toHaveBeenCalled();
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'settlement database unavailable' }),
      expect.objectContaining({
        tags: { source: 'credit_settlement', handler: 'known_response_cost_failure' },
      }),
    );
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      error_type: 'upstream_response_error',
      actual_cost_known: true,
      actual_cost_microcents: 80,
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    }));
    errSpy.mockRestore();
  });

  it('creates an unknown-cost hold when pricing disappears after provider dispatch', async () => {
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    mocks.getCreditPricing.mockResolvedValueOnce(null);
    const out = makeRes();

    await handleProxyRequest(
      makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'bill me' }] }),
      out.res,
    );

    expect(out.statusCode).toBe(503);
    expect(mocks.settleReservedCreditsWithUnknownCostHold).toHaveBeenCalledWith(
      'team_1',
      100,
      0,
      100,
      3.5,
      expect.any(String),
      expect.stringContaining('pricing-gap unknown-cost hold'),
      'missing_model_pricing_after_dispatch',
      1,
    );
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      error_type: 'missing_model_pricing',
      actual_cost_known: false,
    }));
  });

  it('returns malformed non-stream 200 as 502 for subscriptions without credit side effects', async () => {
    mocks.fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }));
    const out = makeRes();
    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);
    expect(out.statusCode).toBe(502);
    expect(mocks.reserveCredits).not.toHaveBeenCalled();
    expect(mocks.settleReservedCredits).not.toHaveBeenCalled();
  });

  it('retains credits when a delivered stream has no reliable usage', async () => {
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    mocks.fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));
    const providerMock = mocks.getProvider('openai') as NonNullable<ReturnType<typeof mocks.getProvider>>;
    providerMock.extractUsage.mockReturnValueOnce({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });
    const out = makeRes();
    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', stream: true, messages: [] }), out.res);
    expect(mocks.relayStream).toHaveBeenCalledOnce();
    expect(mocks.relayStream).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ intervalMs: 5 * 60_000, refresh: expect.any(Function) }),
    );
    const lease = mocks.relayStream.mock.calls[0]?.[3] as { refresh: () => Promise<void> };
    await lease.refresh();
    expect(mocks.heartbeatCreditReservation).toHaveBeenCalledWith('team_1', expect.any(String));
    expect(mocks.settleReservedCredits).not.toHaveBeenCalled();
    expect(mocks.settleReservedCreditsWithUnknownCostHold).toHaveBeenCalledWith(
      'team_1', 100, 0, 100, 3.5, expect.any(String),
      'gpt-4o-mini streaming unknown-cost hold', 'stream_usage_unknown', 1,
    );
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      error_type: 'stream_usage_unknown',
      actual_cost_known: false,
      savings_microcents: 0,
    }));
    // Billing/usage uncertainty must not mark successful LLM delivery as an AI generation error
    expect(mocks.captureAiGeneration).toHaveBeenCalledWith(expect.objectContaining({
      stream: true,
      isError: false,
      error: undefined,
    }));
  });

  it('retains credits when a streaming fallback follows an unknown primary dispatch', async () => {
    const provider = mocks.getProvider('openai');
    if (!provider) throw new Error('openai provider mock missing');
    provider.extractUsage.mockReturnValueOnce({
      input_tokens: 12,
      output_tokens: 8,
      reasoning_tokens: 7,
      total_tokens: 20,
    });
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    mocks.evaluateRules.mockReturnValueOnce({
      provider: 'openai', model: 'gpt-4o-mini',
      fallback_chain: [{ provider: 'anthropic', model: 'claude-haiku-4-5' }],
    });
    mocks.fetchMock.mockRejectedValueOnce(new Error('connection reset'));
    mocks.executeFallbackChain.mockResolvedValueOnce({
      ok: true,
      response: new Response('', { status: 200 }),
      provider: mocks.getProvider('anthropic'), providerId: 'anthropic', model: 'claude-haiku-4-5',
      attempts: [{ provider: 'openai', model: 'gpt-4o-mini', error: 'Network error: connection reset', actual_cost_known: false }],
      aggregateActualCostKnown: false,
      aggregateActualCostMicrocents: 0,
      aggregateInputTokens: 0,
      aggregateOutputTokens: 0,
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', stream: true, messages: [] }), out.res);

    expect(mocks.relayStream).toHaveBeenCalledOnce();
    expect(mocks.settleReservedCredits).not.toHaveBeenCalled();
    expect(mocks.settleReservedCreditsWithUnknownCostHold).toHaveBeenCalledWith(
      'team_1', 100, 80, 100, 3.5, expect.any(String),
      'claude-haiku-4-5 streaming unknown-cost hold', 'stream_usage_unknown', 1,
    );
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      actual_cost_known: false,
      error_type: 'stream_usage_unknown',
      reasoning_tokens: null,
    }));
  });

  it('retains an unknown-cost hold when the streaming reservation heartbeat fails', async () => {
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    mocks.relayStream.mockResolvedValueOnce({
      chunks: [], ttft_ms: 123, statusCode: 200, clientAborted: false,
      streamError: 'credit_reservation_heartbeat_failed',
    });
    mocks.fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', stream: true, messages: [] }), out.res);

    expect(mocks.settleReservedCredits).not.toHaveBeenCalled();
    expect(mocks.settleReservedCreditsWithUnknownCostHold).toHaveBeenCalledWith(
      'team_1', 100, 80, 100, 3.5, expect.any(String),
      'gpt-4o-mini streaming unknown-cost hold', 'credit_reservation_heartbeat_failed', 1,
    );
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      error_type: 'credit_reservation_heartbeat_failed', actual_cost_known: false,
    }));
    // Actual relay stream failure is properly flagged as an AI generation error
    expect(mocks.captureAiGeneration).toHaveBeenCalledWith(expect.objectContaining({
      stream: true,
      isError: true,
      error: 'credit_reservation_heartbeat_failed',
    }));
  });

  it('does not release the reservation when streaming credit settlement fails after delivery', async () => {
    // Unlike non-stream/cache-hit, relayStream() has already sent the full
    // response body to the client by the time settlement runs — a failed
    // settle here must NOT fall through to the finally release (that would
    // refund a reservation for content the customer already received).
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    mocks.settleReservedCredits.mockResolvedValueOnce({ success: false, newBalance: 3, amountDeducted: 100 });
    mocks.fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));
    const out = makeRes();

    await handleProxyRequest(
      makeReq({ model: 'gpt-4o-mini', stream: true, messages: [{ role: 'user', content: 'stream me' }] }),
      out.res,
    );
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      error_type: 'credit_deduction_failed',
    }));
    // Post-delivery settlement failure does not mark delivered stream as AI error
    expect(mocks.captureAiGeneration).toHaveBeenCalledWith(expect.objectContaining({
      stream: true,
      isError: false,
      error: undefined,
    }));
    errSpy.mockRestore();
  });

  it('suppresses PostHog generation capture on streaming response with 502 and no chunks', async () => {
    mocks.captureAiGeneration.mockClear();
    mocks.relayStream.mockImplementationOnce(async (_upstream, res) => {
      res.writeHead(502);
      res.end('upstream 502 no body');
      return {
        chunks: [],
        ttft_ms: null,
        statusCode: 502,
        clientAborted: false,
        streamError: undefined,
      };
    });
    mocks.fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));
    const out = makeRes();
    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', stream: true, messages: [] }), out.res);
    expect(mocks.captureAiGeneration).not.toHaveBeenCalled();
  });

  it('suppresses PostHog generation capture when early upstream fetch returns 502 without body', async () => {
    mocks.captureAiGeneration.mockClear();
    mocks.fetchMock.mockResolvedValueOnce(new Response('Upstream Gateway Error', { status: 502 }));
    const out = makeRes();
    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', stream: true, messages: [] }), out.res);
    expect(mocks.captureAiGeneration).not.toHaveBeenCalled();
    expect(out.statusCode).toBe(502);
  });
  it('does not release the reservation when streaming credit settlement throws after delivery', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    mocks.settleReservedCredits.mockRejectedValueOnce(new Error('settlement database unavailable'));
    mocks.fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));
    const out = makeRes();
    mocks.relayStream.mockImplementationOnce(async (_upstream, res) => {
      res.writeHead(200);
      res.end('stream delivered');
      return { chunks: [], ttft_ms: 123, statusCode: 200, clientAborted: false };
    });

    await handleProxyRequest(
      makeReq({ model: 'gpt-4o-mini', stream: true, messages: [{ role: 'user', content: 'stream me' }] }),
      out.res,
    );

    expect(mocks.relayStream).toHaveBeenCalledTimes(1);
    // The thrown settle must not trigger the finally path's zero-cost release.
    expect(mocks.settleReservedCredits).toHaveBeenCalledTimes(1);
    expect(mocks.settleReservedCreditsWithUnknownCostHold).not.toHaveBeenCalled();
    expect(mocks.captureException).toHaveBeenCalledOnce();
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'settlement database unavailable' }),
      expect.objectContaining({ tags: { source: 'credit_settlement', handler: 'stream' } }),
    );
    expect(mocks.logRequest).toHaveBeenCalledTimes(1);
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      actual_cost_known: true,
      actual_cost_microcents: 80,
      input_tokens: 12,
      output_tokens: 8,
      total_tokens: 20,
      error_type: 'credit_deduction_failed',
    }));
    expect(out.statusCode).toBe(200);
    expect(out.body).toBe('stream delivered');
    errSpy.mockRestore();
  });

  it('blocks streaming credits responses before upstream fetch when reservation fails', async () => {
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    mocks.reserveCredits.mockResolvedValueOnce({ success: false, newBalance: 2, amountDeducted: 0 });
    mocks.fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));
    const out = makeRes();

    await handleProxyRequest(
      makeReq({ model: 'gpt-4o-mini', stream: true, messages: [{ role: 'user', content: 'stream me' }] }),
      out.res,
    );

    expect(out.statusCode).toBe(402);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'Insufficient credits', code: 'credit_reservation_failed' } });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
    expect(mocks.relayStream).not.toHaveBeenCalled();
    expect(mocks.settleReservedCredits).not.toHaveBeenCalled();
    expect(mocks.checkAutoTopUpNeeded).toHaveBeenCalledTimes(1);
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      status_code: 402,
      error_type: 'credit_reservation_failed',
      is_streaming: true,
    }));
  });

  it('returns 503 when no upstream key can be resolved', async () => {
    delete process.env.OPENAI_API_KEY;
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [] }), out.res);

    // A missing provider key is a configuration error (service-not-yet-configured),
    // not a server fault — the handler returns 503 with a hint, not 500.
    expect(out.statusCode).toBe(503);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'No API key configured for openai' } });
  });
});

// ─── RSH-134 §3 — quality-gated cascade wiring ─────────────────────────────
//
// These cover the WIRING: which requests reach the cascade, which are refused
// pre-dispatch and with what exact reason, what gets logged, and that an
// ungated request is untouched. Verifier/cascade semantics themselves are unit
// tested in quality-cascade.test.ts, so executeQualityCascade is mocked here the
// same way executeFallbackChain already is.
describe('handleProxyRequest quality-gate wiring (RSH-134)', () => {
  const gate = {
    version: 1 as const,
    mode: 'cascade' as const,
    on_stream: 'reject' as const,
    unknown_signal: 'reject' as const,
    multi_attempt_billing_ack: true as const,
    checks: [{ type: 'nonempty_content' as const, min_chars: 1 }],
  };

  function routeWithGate(overrides: Record<string, unknown> = {}) {
    mocks.evaluateRules.mockReturnValue({
      provider: 'openai',
      model: 'gpt-4o-mini',
      fallback_chain: [],
      quality_gate: gate,
      ...overrides,
    });
  }

  function cascadeServed(
    audit: Array<Record<string, unknown>>,
    usage: { input_tokens: number; output_tokens: number; reasoning_tokens?: number; total_tokens: number } = {
      input_tokens: 10, output_tokens: 5, total_tokens: 15,
    },
  ) {
    mocks.executeQualityCascade.mockResolvedValue({
      ok: true,
      outcome: {
        kind: 'verified',
        provider: 'openai',
        model: 'gpt-4o-mini',
        rawBody: { id: 'up_cascade' },
        usage,
        actualCostMicrocents: 80,
      },
      provider: mocks.getProvider('openai'),
      providerId: 'openai',
      model: 'gpt-4o-mini',
      audit,
      skips: [],
      aggregateCostMicrocents: audit.reduce((s, r) => s + (r.actual_cost_microcents as number), 0),
      aggregateCostKnown: true,
      aggregateUnknownCostAttempts: 0,
    });
  }

  const auditRow = (i: number, outcome: string, reason: string | null, cost: number) => ({
    attempt_index: i, provider: 'openai', model: 'gpt-4o-mini', outcome,
    reason_code: reason, check_index: null, status_code: 200,
    input_tokens: 10, output_tokens: 5, actual_cost_microcents: cost,
    latency_ms: 12, circuit_failure: false,
  });

  beforeEach(() => {
    // Same baseline the flow-behavior suite establishes; this describe is a
    // sibling of it, so it does not inherit that beforeEach.
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = 'platform-key';
    delete process.env.ANTHROPIC_API_KEY;
    mocks.validateApiKey.mockResolvedValue({
      id: 'key_1',
      teamId: 'team_1',
      allowedModels: null,
      rateLimitOverride: null,
    });
    // mockReset, not just clearAllMocks: this describe runs after ~90 tests
    // that queue mockResolvedValueOnce responses, and clearAllMocks does NOT
    // drain an unconsumed once-queue. Without this, the first request here
    // silently receives a leftover Response whose body was already read and
    // fails with "Unexpected end of JSON input".
    mocks.fetchMock.mockReset();
    mocks.fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: 'up_1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', mocks.fetchMock as unknown as typeof fetch);
    mocks.getAutoRouteSettings.mockResolvedValue({ enabled: false, strategy: 'balanced', max_fallbacks: 0 });
    mocks.getAutoRouteProviderSignals.mockResolvedValue([]);
    mocks.getTeamBillingMode.mockReset();
    mocks.getTeamBillingMode.mockResolvedValue('subscription');
    mocks.getCreditPricing.mockResolvedValue({
      provider: 'openai', model: 'gpt-4o-mini', input_per_million: 0.15, output_per_million: 0.6,
    });
    mocks.hasEnabledProviderKey.mockResolvedValue(true);
    mocks.getDecryptedProviderKey.mockResolvedValue({
      key: 'team-upstream-key', metadata: {}, label: 'primary',
    });
    // Cache is ON for this suite so the gated-bypass assertion is meaningful:
    // if isCacheable returned false the bypass test would pass vacuously.
    mocks.responseCache.isCacheable.mockReturnValue(true);
    mocks.responseCache.get.mockReturnValue(null);
  });

  it('does not enter the gated branch and still uses the cache when no gate is configured', async () => {
    mocks.evaluateRules.mockReturnValue({ provider: 'openai', model: 'gpt-4o-mini', fallback_chain: [] });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

    expect(mocks.executeQualityCascade).not.toHaveBeenCalled();
    expect(out.statusCode).toBe(200);
    // The ungated path still consults the cache.
    expect(mocks.responseCache.get).toHaveBeenCalled();
  });

  it('routes a gated non-streaming subscription request through the cascade', async () => {
    routeWithGate();
    cascadeServed([auditRow(0, 'verified', null, 80)]);
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

    expect(mocks.executeQualityCascade).toHaveBeenCalledTimes(1);
    expect(out.statusCode).toBe(200);
    expect(out.headers['X-RouteShift-Quality-Gate']).toBe('PASS');
    expect(out.headers['X-RouteShift-Quality-Attempts']).toBe('1');
  });
  it('fails closed when a served cascade omits predecessor reasoning telemetry', async () => {
    routeWithGate();
    cascadeServed([
      { ...auditRow(0, 'quality_rejected', 'quality_gate_empty_content', 80), reasoning_tokens: 7, reasoning_cost_microcents: 10 },
      auditRow(1, 'verified', null, 80),
    ]);
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      reasoning_tokens: null,
      reasoning_cost_microcents: null,
    }));
  });

  it('persists reasoning telemetry from failed quality-cascade attempts', async () => {
    routeWithGate();
    mocks.executeQualityCascade.mockResolvedValue({
      ok: false,
      reason: 'exhausted',
      audit: [{
        ...auditRow(0, 'quality_rejected', 'quality_gate_empty_content', 80),
        reasoning_tokens: 7,
        reasoning_cost_microcents: 10,
      }],
      skips: [],
      aggregateCostMicrocents: 80,
      aggregateUnknownCostAttempts: 0,
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      reasoning_tokens: 7,
      reasoning_cost_microcents: 10,
    }));
  });


  it.each(['max_tokens', 'max_completion_tokens'] as const)(
    'uses %s as the quality reservation output ceiling and never lowers the larger primary preflight',
    async (outputField) => {
      mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
      mocks.preFlightCreditCheck.mockResolvedValueOnce({ allowed: true, balance: 100_000, estimatedCost: 1_000 });
      mocks.reserveCredits.mockResolvedValueOnce({ success: true, newBalance: 99_000, amountDeducted: 1_000 });
      mocks.projectQualityCascadeReservation.mockResolvedValueOnce({ costMicrocents: 100 });
      routeWithGate();
      cascadeServed([auditRow(0, 'verified', null, 80)]);
      const out = makeRes();

      await handleProxyRequest(makeReq({
        model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }], [outputField]: 8_192,
      }), out.res);

      expect(mocks.projectQualityCascadeReservation).toHaveBeenCalledWith(
        expect.any(Object), expect.any(Array), expect.any(Object),
        expect.objectContaining({ estimatedMaxOutputTokens: 8_192 }),
      );
      expect(mocks.reserveCredits).toHaveBeenCalledWith(
        'team_1', 1_000, expect.any(String), expect.stringContaining('quality-gated worst-case'), 3.5,
      );
    },
  );

  it('keeps an optional selected label dispatchable and scopes effects only when present', async () => {
    routeWithGate();
    cascadeServed([auditRow(0, 'verified', null, 80)]);
    mocks.getDecryptedProviderKey.mockResolvedValue({
      key: 'team-upstream-key', metadata: {}, label: '',
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

    const cascadeInput = mocks.executeQualityCascade.mock.calls[0]?.[0] as {
      primaryConfig: unknown;
      onAttemptStart: (identity: { provider: string; model: string; credentialLabel?: string }) => void;
      onAttemptFinish: (identity: { provider: string; model: string; credentialLabel?: string }) => void;
      onAttemptRateLimited: (identity: { provider: string; model: string; credentialLabel?: string }) => void;
    };
    expect(cascadeInput.primaryConfig).toEqual({
      key: 'team-upstream-key', metadata: {}, label: '',
    });
    cascadeInput.onAttemptStart({ provider: 'openai', model: 'gpt-4o-mini' });
    cascadeInput.onAttemptFinish({ provider: 'openai', model: 'gpt-4o-mini' });
    cascadeInput.onAttemptRateLimited({ provider: 'openai', model: 'gpt-4o-mini' });
    expect(mocks.incrementInFlight).not.toHaveBeenCalled();
    expect(mocks.decrementInFlight).not.toHaveBeenCalled();
    expect(mocks.markCooldown).not.toHaveBeenCalled();

    cascadeInput.onAttemptStart({ provider: 'openai', model: 'gpt-4o-mini', credentialLabel: 'primary' });
    cascadeInput.onAttemptFinish({ provider: 'openai', model: 'gpt-4o-mini', credentialLabel: 'primary' });
    cascadeInput.onAttemptRateLimited({ provider: 'openai', model: 'gpt-4o-mini', credentialLabel: 'primary' });
    expect(mocks.incrementInFlight).toHaveBeenCalledWith('team_1', 'openai', 'primary');
    expect(mocks.decrementInFlight).toHaveBeenCalledWith('team_1', 'openai', 'primary');
    expect(mocks.markCooldown).toHaveBeenCalledWith('team_1', 'openai', 'primary');
  });

  it('reuses the pre-resolved gated primary and does not log its cooled-skip flag before dispatch', async () => {
    routeWithGate();
    mocks.getDecryptedProviderKey.mockResolvedValue({
      key: 'team-upstream-key', metadata: {}, label: 'primary', selected_after_cooldown_skip: true,
    });
    mocks.executeQualityCascade.mockImplementation(async (input: {
      primaryConfig: unknown;
    }) => {
      expect(input.primaryConfig).toEqual({
        key: 'team-upstream-key', metadata: {}, label: 'primary', selected_after_cooldown_skip: true,
      });
      return {
        ok: true,
        outcome: {
          kind: 'verified', provider: 'openai', model: 'gpt-4o-mini', rawBody: { id: 'up_cascade' },
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, actualCostMicrocents: 80,
        },
        provider: mocks.getProvider('openai'), providerId: 'openai', model: 'gpt-4o-mini',
        audit: [auditRow(0, 'verified', null, 80)], skips: [], aggregateCostMicrocents: 80,
      };
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

    expect(mocks.getDecryptedProviderKey).toHaveBeenCalledTimes(1);
    expect(mocks.getDecryptedProviderKey).toHaveBeenCalledWith('team_1', 'openai');
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({ rate_limited: false }));
  });

  it('logs the pre-resolved primary cooled-skip flag only when the cascade starts its dispatch', async () => {
    routeWithGate();
    mocks.getDecryptedProviderKey.mockResolvedValue({
      key: 'team-upstream-key', metadata: {}, label: 'primary', selected_after_cooldown_skip: true,
    });
    mocks.executeQualityCascade.mockImplementation(async (input: {
      primaryConfig: { selected_after_cooldown_skip?: boolean };
      onAttemptStart: (identity: { provider: string; model: string; selectedAfterCooldownSkip?: boolean }) => void;
    }) => {
      input.onAttemptStart({
        provider: 'openai', model: 'gpt-4o-mini', selectedAfterCooldownSkip: input.primaryConfig.selected_after_cooldown_skip,
      });
      return {
        ok: true,
        outcome: {
          kind: 'verified', provider: 'openai', model: 'gpt-4o-mini', rawBody: { id: 'up_cascade' },
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, actualCostMicrocents: 80,
        },
        provider: mocks.getProvider('openai'), providerId: 'openai', model: 'gpt-4o-mini',
        audit: [auditRow(0, 'verified', null, 80)], skips: [], aggregateCostMicrocents: 80,
      };
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

    expect(mocks.getDecryptedProviderKey).toHaveBeenCalledTimes(1);
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({ rate_limited: true }));
  });

  it('logs rate_limited when a dispatched cascade candidate was selected after a cooled credential skip', async () => {
    routeWithGate({ fallback_chain: [{ provider: 'anthropic', model: 'claude' }] });
    mocks.getDecryptedProviderKey.mockImplementation(async (_teamId: string, provider: string) => ({
      key: `${provider}-key`, metadata: {}, label: `${provider}-label`,
      selected_after_cooldown_skip: provider === 'anthropic',
    }));
    mocks.executeQualityCascade.mockImplementation(async (input: {
      getProviderConfig: (provider: string) => Promise<unknown>;
      onAttemptStart: (identity: { provider: string; model: string; selectedAfterCooldownSkip?: boolean }) => void;
    }) => {
      const config = await input.getProviderConfig('anthropic') as { selected_after_cooldown_skip?: boolean };
      input.onAttemptStart({
        provider: 'anthropic', model: 'claude',
        selectedAfterCooldownSkip: config.selected_after_cooldown_skip,
      });
      return {
        ok: true,
        outcome: {
          kind: 'verified', provider: 'anthropic', model: 'claude', rawBody: { id: 'up_cascade' },
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, actualCostMicrocents: 80,
        },
        provider: mocks.getProvider('anthropic'), providerId: 'anthropic', model: 'claude',
        audit: [auditRow(1, 'verified', null, 80)], skips: [], aggregateCostMicrocents: 80,
      };
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

    expect(out.statusCode).toBe(200);
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({ rate_limited: true }));
  });

  it('does not log rate_limited when a cooled-skip config is considered but never dispatched', async () => {
    routeWithGate({ fallback_chain: [{ provider: 'anthropic', model: 'claude' }] });
    mocks.getDecryptedProviderKey.mockImplementation(async (_teamId: string, provider: string) => ({
      key: `${provider}-key`, metadata: {}, label: `${provider}-label`,
      selected_after_cooldown_skip: provider === 'anthropic',
    }));
    mocks.executeQualityCascade.mockImplementation(async (input: {
      getProviderConfig: (provider: string) => Promise<unknown>;
    }) => {
      await input.getProviderConfig('anthropic');
      return {
        ok: true,
        outcome: {
          kind: 'verified', provider: 'openai', model: 'gpt-4o-mini', rawBody: { id: 'up_cascade' },
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, actualCostMicrocents: 80,
        },
        provider: mocks.getProvider('openai'), providerId: 'openai', model: 'gpt-4o-mini',
        audit: [auditRow(0, 'verified', null, 80)], skips: [{ provider: 'anthropic', model: 'claude', reason: 'Retry budget exhausted (max_cost_microcents)' }], aggregateCostMicrocents: 80,
      };
    });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

    expect(out.statusCode).toBe(200);
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({ rate_limited: false }));
  });

  it('serves after a mid-chain 429 and logs the request as rate_limited', async () => {
    routeWithGate({ fallback_chain: [{ provider: 'anthropic', model: 'claude' }] });
    cascadeServed([
      { ...auditRow(0, 'retryable_http', 'HTTP 429', 0), status_code: 429 },
      auditRow(1, 'verified', null, 80),
    ]);
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

    expect(out.statusCode).toBe(200);
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({ rate_limited: true }));
  });

  it('bypasses cache lookup AND cache fill for a gated request (§3.3)', async () => {
    routeWithGate();
    cascadeServed([auditRow(0, 'verified', null, 80)]);
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

    // A cached entry could otherwise be served without verification.
    expect(mocks.responseCache.get).not.toHaveBeenCalled();
    expect(mocks.responseCache.set).not.toHaveBeenCalled();
  });

  it('writes exactly ONE request_logs row for a multi-attempt cascade (§3.4)', async () => {
    routeWithGate();
    cascadeServed([
      auditRow(0, 'quality_rejected', 'quality_gate_empty_content', 80),
      auditRow(1, 'verified', null, 80),
    ]);
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

    // N attempts must not become N rows or every request count, budget and
    // dashboard aggregate is corrupted.
    expect(mocks.logRequest).toHaveBeenCalledTimes(1);
  });

  it('preserves the exact per-attempt reason code in fallback_attempts', async () => {
    routeWithGate();
    cascadeServed([
      auditRow(0, 'quality_rejected', 'quality_gate_empty_content', 80),
      auditRow(1, 'verified', null, 80),
    ]);
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

    const row = mocks.logRequest.mock.calls[0][0];
    // A quality rejection stays distinguishable from a provider failure.
    expect(row.fallback_attempts).toEqual([
      expect.objectContaining({ error: 'quality_gate_empty_content' }),
    ]);
    expect(row.is_fallback).toBe(true);
  });

  it('logs the rejected attempt’s spend on a SUCCESSFUL cascade, not just the served one', async () => {
    routeWithGate();
    cascadeServed([
      auditRow(0, 'quality_rejected', 'quality_gate_empty_content', 80),
      auditRow(1, 'verified', null, 80),
    ]);
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

    const row = mocks.logRequest.mock.calls[0][0];
    // computeRequestCost prices only the served attempt (mocked at 80µ¢). The
    // rejected attempt cost another 80µ¢ that the provider really billed, so
    // the row must carry 160 — otherwise that spend is invisible and the
    // savings-share meter bills against a cost the customer never incurred.
    expect(row.actual_cost_microcents).toBe(160);
    // savings = original − actual, so the prior spend must SHRINK reported
    // savings (mock: original 100, served actual 80 ⇒ 20; minus 80 ⇒ −60).
    expect(row.savings_microcents).toBe(-60);
    // Tokens aggregate too: served 10/5 plus the rejected attempt's 10/5.
    expect(row.input_tokens).toBe(20);
    expect(row.output_tokens).toBe(10);
  });
  it('aggregates reasoning tokens and cost across cascade attempts', async () => {
    routeWithGate();
    mocks.computeRequestCostDetailed.mockResolvedValueOnce({
      original_cost_microcents: 100,
      original_cost_known: true,
      actual_cost_microcents: 80,
      actual_cost_known: true,
      reasoning_cost_microcents: 42,
      savings_microcents: 20,
    });
    cascadeServed([
      { ...auditRow(0, 'quality_rejected', 'quality_gate_empty_content', 80), reasoning_tokens: 3, reasoning_cost_microcents: 11 },
      { ...auditRow(1, 'verified', null, 80), reasoning_tokens: 7, reasoning_cost_microcents: 42 },
    ], { input_tokens: 10, output_tokens: 5, reasoning_tokens: 7, total_tokens: 15 });
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      reasoning_tokens: 10,
      reasoning_cost_microcents: 53,
      total_tokens: 30,
    }));
  });


  it('logs aggregate usage when exact settlement fails after a successful cascade', async () => {
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    mocks.settleReservedCredits.mockResolvedValueOnce({ success: false, newBalance: 3, amountDeducted: 100 });
    routeWithGate();
    cascadeServed([
      auditRow(0, 'quality_rejected', 'quality_gate_empty_content', 80),
      auditRow(1, 'verified', null, 80),
    ]);
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

    expect(out.statusCode).toBe(402);
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      error_type: 'credit_deduction_failed',
      actual_cost_known: true,
      actual_cost_microcents: 160,
      input_tokens: 20,
      output_tokens: 10,
      total_tokens: 30,
    }));
  });

  it('keeps observed aggregate tokens when served-response pricing rejects', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    mocks.computeRequestCostDetailed.mockRejectedValueOnce(new Error('pricing database unavailable'));
    routeWithGate();
    cascadeServed([
      auditRow(0, 'quality_rejected', 'quality_gate_empty_content', 80),
      auditRow(1, 'verified', null, 80),
    ]);
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

    expect(out.statusCode).toBe(502);
    expect(mocks.settleReservedCredits).not.toHaveBeenCalled();
    expect(mocks.settleReservedCreditsWithUnknownCostHold).toHaveBeenCalledWith(
      'team_1', 100, 80, 100, 3.5, expect.any(String),
      'gpt-4o-mini response-processing unknown-cost hold', 'upstream_response_cost_unknown', 1,
    );
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      actual_cost_known: false,
      actual_cost_microcents: 80,
      input_tokens: 20,
      output_tokens: 10,
      total_tokens: 30,
    }));
    errSpy.mockRestore();
  });

  it('preserves valid savings when a priced free served model follows a paid attempt', async () => {
    mocks.computeRequestCostDetailed.mockResolvedValueOnce({
      original_cost_microcents: 100,
      original_cost_known: true,
      actual_cost_microcents: 0,
      actual_cost_known: true,
      savings_microcents: 100,
    });
    routeWithGate();
    cascadeServed([
      auditRow(0, 'quality_rejected', 'quality_gate_empty_content', 20),
      auditRow(1, 'verified', null, 0),
    ]);
    const out = makeRes();

    await handleProxyRequest(makeReq({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hello' }],
    }), out.res);

    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      actual_cost_microcents: 20,
      actual_cost_known: true,
      savings_microcents: 80,
    }));
  });

  it('never turns a pricing-gap savings of 0 into a phantom negative', async () => {
    // computeRequestCost forces savings to 0 when either side lacks pricing,
    // and reports that side's cost as 0. Folding prior spend into savings there
    // would invent a negative saving out of an unknown price.
    mocks.computeRequestCostDetailed.mockResolvedValueOnce({
      original_cost_microcents: 0,
      original_cost_known: false,
      actual_cost_microcents: 0,
      actual_cost_known: true,
      savings_microcents: 0,
    });
    routeWithGate();
    cascadeServed([
      auditRow(0, 'quality_rejected', 'quality_gate_empty_content', 80),
      auditRow(1, 'verified', null, 0),
    ]);
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

    const row = mocks.logRequest.mock.calls[0][0];
    // Real spend still aggregates — it happened regardless of pricing coverage.
    expect(row.actual_cost_microcents).toBe(80);
    // But savings stays the deliberate 0, not -80.
    expect(row.savings_microcents).toBe(0);
  });

  it('serves a valid cascade response while retaining credits when a prior attempt cost is unknown', async () => {
    mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
    mocks.computeRequestCostDetailed.mockResolvedValueOnce({
      original_cost_microcents: 100,
      original_cost_known: true,
      actual_cost_microcents: 0,
      actual_cost_known: false,
      savings_microcents: 0,
    });
    routeWithGate();
    cascadeServed([
      { ...auditRow(0, 'quality_rejected', 'quality_gate_empty_content', 0), actual_cost_known: false },
      auditRow(1, 'verified', null, 0),
    ]);
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

    expect(out.statusCode).toBe(200);
    expect(mocks.reserveCredits).toHaveBeenCalled();
    expect(mocks.settleReservedCredits).not.toHaveBeenCalled();
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
      actual_cost_microcents: 0,
      actual_cost_known: false,
      savings_microcents: 0,
      fallback_attempts: [expect.objectContaining({ actual_cost_known: false })],
    }));
  });

  it('reconciles TPM against all dispatched cascade input, not only the served attempt', async () => {
    routeWithGate();
    cascadeServed([
      auditRow(0, 'quality_rejected', 'quality_gate_empty_content', 80),
      auditRow(1, 'verified', null, 80),
    ]);
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

    expect(out.statusCode).toBe(200);
    expect(mocks.reconcileTokens).toHaveBeenCalledWith(expect.anything(), 20);
    // Aggregate request logs already include both attempts; retain that
    // invariant alongside TPM reconciliation.
    expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({ input_tokens: 20, total_tokens: 30 }));
  });

  it('does not alter cost when the primary serves (no prior attempts)', async () => {
    routeWithGate();
    cascadeServed([auditRow(0, 'verified', null, 80)]);
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

    const row = mocks.logRequest.mock.calls[0][0];
    expect(row.actual_cost_microcents).toBe(80);
    expect(row.savings_microcents).toBe(20);
    expect(row.input_tokens).toBe(10);
  });

  it('counts prior spend by position, so a repeated attempt_index cannot erase it', async () => {
    // The executor assigns `attempt_index: i` from its candidate loop, so
    // indices are unique today and this audit is not one it currently emits.
    // That is exactly the point: the money arithmetic must not silently inherit
    // an invariant enforced in a different file. The previous value filter
    // (`row.attempt_index !== servedIndex`) drops BOTH rows here and reports the
    // rejected attempt's real 80µ¢ of provider spend as 0 — understating cost,
    // overstating savings, and overcharging the 3% share.
    routeWithGate();
    cascadeServed([
      auditRow(0, 'quality_rejected', 'quality_gate_empty_content', 80),
      auditRow(0, 'verified', null, 80),
    ]);
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

    const row = mocks.logRequest.mock.calls[0][0];
    expect(row.actual_cost_microcents).toBe(160);
    expect(row.savings_microcents).toBe(-60);
    // The rejected attempt also survives in the audit array instead of being
    // filtered out alongside the served row that shares its index.
    expect(row.fallback_attempts).toEqual([
      { provider: 'openai', model: 'gpt-4o-mini', error: 'quality_gate_empty_content' },
    ]);
  });

  it('flags is_fallback when a skipped primary means the served attempt is not index 0', async () => {
    // A candidate skipped before dispatch (circuit open, no credential) still
    // consumes its candidate index, so the first DISPATCHED attempt is index 1
    // and never appears in the audit. is_fallback must therefore be true even
    // though the audit holds exactly one row — the primary did not serve.
    routeWithGate();
    cascadeServed([auditRow(1, 'verified', null, 80)]);
    const out = makeRes();

    await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

    const row = mocks.logRequest.mock.calls[0][0];
    expect(row.is_fallback).toBe(true);
    // Nothing else was dispatched, so there is no prior spend to fold in.
    expect(row.actual_cost_microcents).toBe(80);
  });

  describe('pre-dispatch refusals (§3.2) — never silently downgraded', () => {
    it('refuses a streaming gated request with on_stream=reject', async () => {
      routeWithGate();
      const out = makeRes();

      await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }], stream: true }), out.res);

      expect(out.statusCode).toBe(400);
      expect(JSON.parse(out.body).error.code).toBe('quality_gate_streaming_unsupported');
      // Refused BEFORE dispatch: neither the cascade nor the ungated path ran.
      expect(mocks.executeQualityCascade).not.toHaveBeenCalled();
      expect(mocks.fetchMock).not.toHaveBeenCalled();
      expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
        status_code: 400,
        error_type: 'quality_gate_streaming_unsupported',
      }));
    });

    it('serves streaming ungated when the customer configured on_stream=bypass', async () => {
      routeWithGate({ quality_gate: { ...gate, on_stream: 'bypass' } });
      const out = makeRes();

      await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }], stream: true }), out.res);

      // An explicit configured opt-out, not a silent downgrade: the request is
      // relayed as a normal stream. relayStream writes the bytes itself, so
      // there is no writeHead status to assert here.
      expect(mocks.executeQualityCascade).not.toHaveBeenCalled();
      expect(mocks.relayStream).toHaveBeenCalledTimes(1);
      expect(out.statusCode).not.toBe(400);
    });

    it('admits credit-funded gated traffic with worst-case reservation (Phase 3)', async () => {
      mocks.getTeamBillingMode.mockResolvedValue('credits');
      routeWithGate();
      cascadeServed([auditRow(0, 'verified', null, 80)]);
      const out = makeRes();

      await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

      expect(out.statusCode).not.toBe(503);
      expect(mocks.reserveCredits).toHaveBeenCalled();
      expect(mocks.executeQualityCascade).toHaveBeenCalled();
    });

    // The write validator requires on_stream, but it runs only on write. A gate
    // stored before the field existed must NOT fall through to being served
    // unverified — testing `=== 'reject'` instead of `!== 'bypass'` fails open.
    it.each([undefined, null, 'maybe'])('refuses streaming for a gate whose on_stream is %p', async (value) => {
      const { on_stream: _dropped, ...rest } = gate;
      routeWithGate({ quality_gate: value === undefined ? rest : { ...rest, on_stream: value } });
      const out = makeRes();

      await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], stream: true }), out.res);

      expect(out.statusCode).toBe(400);
      expect(JSON.parse(out.body).error.code).toBe('quality_gate_streaming_unsupported');
      expect(mocks.relayStream).not.toHaveBeenCalled();
      expect(mocks.fetchMock).not.toHaveBeenCalled();
    });

    it('refuses a gate persisted before the billing ack existed', async () => {
      const { multi_attempt_billing_ack: _omitted, ...legacyGate } = gate;
      routeWithGate({ quality_gate: legacyGate });
      const out = makeRes();

      await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

      expect(out.statusCode).toBe(400);
      expect(JSON.parse(out.body).error.code).toBe('quality_gate_billing_ack_required');
      expect(mocks.executeQualityCascade).not.toHaveBeenCalled();
      expect(mocks.fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('failed cascade', () => {
    it('logs rate_limited when a 429 exhausts the cascade', async () => {
      routeWithGate();
      mocks.executeQualityCascade.mockResolvedValue({
        ok: false, reason: 'exhausted', skips: [], aggregateCostMicrocents: 0,
        audit: [{ ...auditRow(0, 'retryable_http', 'HTTP 429', 0), status_code: 429 }],
      });
      const out = makeRes();

      await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

      expect(out.statusCode).toBe(502);
      expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({ rate_limited: true }));
    });

    it('retains known cascade spend when aggregate settlement returns false', async () => {
      mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
      routeWithGate();
      mocks.executeQualityCascade.mockResolvedValue({
        ok: false,
        reason: 'exhausted',
        audit: [auditRow(0, 'quality_rejected', 'quality_gate_empty_content', 80)],
        skips: [],
        aggregateCostMicrocents: 80,
        aggregateUnknownCostAttempts: 0,
      });
      mocks.settleReservedCredits.mockResolvedValueOnce({ success: false, newBalance: 3, amountDeducted: 100 });
      const out = makeRes();

      await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

      expect(out.statusCode).toBe(502);
      // The failed cascade dispatched paid work; finally must not make a
      // second zero-cost settlement that releases the reservation.
      expect(mocks.settleReservedCredits).toHaveBeenCalledTimes(1);
      expect(mocks.settleReservedCredits).toHaveBeenCalledWith(
        'team_1',
        100,
        80,
        3.5,
        expect.any(String),
        'gpt-4o-mini quality cascade failed (1 attempts, aggregate settlement)',
      );
    });

    it('retains known cascade spend when aggregate settlement throws', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
      routeWithGate();
      mocks.executeQualityCascade.mockResolvedValue({
        ok: false,
        reason: 'exhausted',
        audit: [auditRow(0, 'quality_rejected', 'quality_gate_empty_content', 80)],
        skips: [],
        aggregateCostMicrocents: 80,
        aggregateUnknownCostAttempts: 0,
      });
      mocks.settleReservedCredits.mockRejectedValueOnce(new Error('settlement database unavailable'));
      const out = makeRes();

      await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

      expect(out.statusCode).toBe(502);
      expect(mocks.settleReservedCredits).toHaveBeenCalledTimes(1);
      errSpy.mockRestore();
    });

    it('settles known cascade spend and holds each unknown attempt in credits mode', async () => {
      mocks.getTeamBillingMode.mockResolvedValueOnce('credits');
      routeWithGate();
      mocks.executeQualityCascade.mockResolvedValue({
        ok: false,
        reason: 'exhausted',
        audit: [
          auditRow(0, 'quality_rejected', 'quality_gate_empty_content', 80),
          { ...auditRow(1, 'retryable_http', 'HTTP 503', 0), actual_cost_known: false },
        ],
        skips: [],
        aggregateCostMicrocents: 80,
        aggregateUnknownCostAttempts: 1,
      });
      const out = makeRes();

      await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

      expect(out.statusCode).toBe(502);
      expect(mocks.settleReservedCredits).not.toHaveBeenCalled();
      expect(mocks.settleReservedCreditsWithUnknownCostHold).toHaveBeenCalledWith(
        'team_1',
        100,
        80,
        100,
        3.5,
        expect.any(String),
        expect.stringContaining('quality cascade unknown-cost hold'),
        'quality_gate_exhausted',
        1,
      );
    });

    it('logs the AGGREGATE spend, not 0 — dispatched attempts are real spend', async () => {
      routeWithGate();
      mocks.executeQualityCascade.mockResolvedValue({
        ok: false,
        reason: 'exhausted',
        audit: [
          auditRow(0, 'quality_rejected', 'quality_gate_empty_content', 80),
          auditRow(1, 'quality_rejected', 'quality_gate_empty_content', 120),
        ],
        skips: [],
        aggregateCostMicrocents: 200,
        aggregateUnknownCostAttempts: 1,
      });
      const out = makeRes();

      await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

      expect(out.statusCode).toBe(502);
      expect(JSON.parse(out.body).error.code).toBe('quality_gate_exhausted');
      expect(mocks.logRequest).toHaveBeenCalledTimes(1);
      const row = mocks.logRequest.mock.calls[0][0];
      // The invariant: a rejected-but-dispatched attempt is not free.
      expect(row.actual_cost_microcents).toBe(200);
      expect(row.input_tokens).toBe(20);
      expect(row.output_tokens).toBe(10);
      expect(row.actual_cost_known).toBe(false);
    });

    it('reconciles consumed tokens instead of releasing the TPM reservation', async () => {
      routeWithGate();
      mocks.executeQualityCascade.mockResolvedValue({
        ok: false, reason: 'exhausted', skips: [], aggregateCostMicrocents: 200,
        audit: [
          auditRow(0, 'quality_rejected', 'quality_gate_empty_content', 80),
          auditRow(1, 'quality_rejected', 'quality_gate_empty_content', 120),
        ],
      });
      const out = makeRes();

      await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

      // Those tokens were really burned upstream. Releasing the estimate would
      // hand back capacity a team already used, letting it bypass its TPM cap
      // by failing gates.
      expect(mocks.reconcileTokens).toHaveBeenCalledWith(expect.anything(), 20);
    });

    it('preserves exact pre-dispatch skip reasons alongside attempt reasons', async () => {
      routeWithGate();
      mocks.executeQualityCascade.mockResolvedValue({
        ok: false, reason: 'exhausted', aggregateCostMicrocents: 80,
        audit: [auditRow(0, 'quality_rejected', 'quality_gate_empty_content', 80)],
        skips: [{ provider: 'anthropic', model: 'claude', reason: 'Circuit breaker open' }],
      });
      const out = makeRes();

      await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

      const row = mocks.logRequest.mock.calls[0][0];
      // An operator must be able to tell "no fallback configured" from
      // "fallback skipped: circuit open".
      expect(row.fallback_attempts).toEqual([
        expect.objectContaining({ error: 'quality_gate_empty_content' }),
        expect.objectContaining({ provider: 'anthropic', error: 'Circuit breaker open' }),
      ]);
    });

    it('passes a non-retryable upstream status through instead of a blanket 502', async () => {
      routeWithGate();
      mocks.executeQualityCascade.mockResolvedValue({
        ok: false, reason: 'terminal', terminalReasonCode: 'HTTP 400', terminalStatusCode: 400,
        audit: [auditRow(0, 'retryable_http', 'HTTP 400', 0)], skips: [], aggregateCostMicrocents: 0,
      });
      const out = makeRes();

      await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

      expect(out.statusCode).toBe(400);
    });

    it('maps an upstream 401 to 502 so it is not read as the caller’s key failing', async () => {
      routeWithGate();
      mocks.executeQualityCascade.mockResolvedValue({
        ok: false, reason: 'terminal', terminalReasonCode: 'HTTP 401', terminalStatusCode: 401,
        audit: [auditRow(0, 'retryable_http', 'HTTP 401', 0)], skips: [], aggregateCostMicrocents: 0,
      });
      const out = makeRes();

      await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

      expect(out.statusCode).toBe(502);
    });

    it('maps a cascade pricing gap to 503 service unavailable', async () => {
      routeWithGate();
      mocks.executeQualityCascade.mockResolvedValue({
        ok: false,
        reason: 'terminal',
        terminalReasonCode: 'missing_model_pricing',
        audit: [{
          ...auditRow(0, 'terminal', 'missing_model_pricing', 0),
          actual_cost_known: false,
        }],
        skips: [],
        aggregateCostMicrocents: 0,
        aggregateUnknownCostAttempts: 1,
      });
      const out = makeRes();

      await handleProxyRequest(makeReq({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hello' }],
      }), out.res);

      expect(out.statusCode).toBe(503);
      expect(JSON.parse(out.body).error.code).toBe('missing_model_pricing');
    });

    it('surfaces a terminal reason code exactly rather than a generic bucket', async () => {
      routeWithGate();
      mocks.executeQualityCascade.mockResolvedValue({
        ok: false,
        reason: 'terminal',
        terminalReasonCode: 'quality_gate_refusal_terminal',
        audit: [auditRow(0, 'terminal', 'quality_gate_refusal_terminal', 80)],
        skips: [],
        aggregateCostMicrocents: 80,
      });
      const out = makeRes();

      await handleProxyRequest(makeReq({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] }), out.res);

      expect(JSON.parse(out.body).error.code).toBe('quality_gate_refusal_terminal');
      expect(mocks.logRequest).toHaveBeenCalledWith(expect.objectContaining({
        error_type: 'quality_gate_refusal_terminal',
        actual_cost_microcents: 80,
      }));
    });
  });
});
