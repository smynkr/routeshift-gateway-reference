import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  randomUUID: vi.fn(() => 'req_123'),
  validateApiKey: vi.fn(),
  config: {
    maxRequestBodyBytes: 1024,
  },
}));

const AuthInfrastructureError = vi.hoisted(() => {
  return class AuthInfrastructureError extends Error {
    cause?: unknown;
    constructor(message: string, cause?: unknown) {
      super(message);
      this.name = 'AuthInfrastructureError';
      this.cause = cause;
    }
  };
});

vi.mock('node:crypto', () => ({
  randomUUID: mocks.randomUUID,
}));

vi.mock('../src/config.js', () => ({
  config: mocks.config,
}));

vi.mock('../src/auth/api-key.js', () => ({
  validateApiKey: mocks.validateApiKey,
  AuthInfrastructureError,
}));

vi.mock('../src/providers/registry.js', () => ({
  getProvider: vi.fn(),
}));

vi.mock('../src/streaming/relay.js', () => ({
  relayStream: vi.fn(),
}));

vi.mock('../src/cost/calculator.js', () => ({
  computeRequestCost: vi.fn(),
}));

vi.mock('../src/logging/logger.js', () => ({
  logRequest: vi.fn(),
}));

vi.mock('../src/routing/rule-cache.js', () => ({
  getRulesForTeam: vi.fn(),
}));


vi.mock('../src/routing/fallback.js', () => ({
  executeFallbackChain: vi.fn(),
}));

vi.mock('../src/routing/circuit-breaker.js', () => ({
  circuitBreaker: {
    isOpen: vi.fn(() => false),
    recordFailure: vi.fn(),
    recordSuccess: vi.fn(),
  },
}));

vi.mock('../src/rate-limit/limiter.js', () => ({
  rateLimiter: {
    check: vi.fn(() => ({ allowed: true, remaining: 100, resetMs: 60000 })),
  },
}));

vi.mock('../src/billing/plan-limits.js', () => ({
  getTeamPlan: vi.fn(),
  getPlanLimits: vi.fn(),
  getTeamBillingMode: vi.fn(),
}));

vi.mock('../src/billing/credits.js', () => ({
  preFlightCreditCheck: vi.fn(),
  deductCredits: vi.fn(),
  reserveCredits: vi.fn(),
  settleReservedCredits: vi.fn(),
  checkAutoTopUpNeeded: vi.fn(),
  getCreditPricing: vi.fn(),
}));

vi.mock('../src/billing/provider-key-crypto.js', () => ({
  getDecryptedProviderKey: vi.fn(),
}));

vi.mock('../src/cache/response-cache.js', () => ({
  responseCache: {
    isCacheable: vi.fn(() => false),
    buildKey: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
  },
}));

vi.mock('../src/observability/sentry.js', () => ({ captureException: vi.fn() }));

import { handleProxyRequest, resolveProvider } from '../src/proxy-handler.js';
import { MODEL_REGISTRY, mergeCatalogDefinitions, type GeneratedCatalogModel } from '@routeshift/shared';

function makeReq(options: { body: Buffer; authHeader?: string }): IncomingMessage {
  const stream = Readable.from([options.body]);
  const headers: Record<string, string> = {};
  if (options.authHeader) headers.authorization = options.authHeader;

  return Object.assign(stream, {
    url: '/v1/chat/completions',
    method: 'POST',
    headers,
  }) as IncomingMessage;
}

function makeRes() {
  let statusCode = 0;
  let body = '';
  const headers: Record<string, string> = {};
  const res = Object.assign(new EventEmitter(), {
    setHeader(name: string, value: string) {
      headers[name] = value;
      return res;
    },
    writeHead(code: number, nextHeaders?: Record<string, string>) {
      statusCode = code;
      Object.assign(headers, nextHeaders ?? {});
      return res;
    },
    end(chunk?: string) {
      body = chunk ?? '';
      res.emit('finish');
      return res;
    },
  }) as unknown as ServerResponse;

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

describe('handleProxyRequest basic validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.config.maxRequestBodyBytes = 1024;
  });

  it('resolves explicit GPT 5.4/5.5 models according to the shared registry', () => {
    expect(resolveProvider('gpt-5.4')).toBe('openai');
    expect(resolveProvider('gpt-5.5')).toBe('openai');
    expect(resolveProvider('gpt-5')).toBe('openai');
  });

  it('blocks Responses-only GPT-5.6 Cyber from prefix fallback and catalog dispatch', () => {
    expect(resolveProvider('gpt-5.6-cyber')).toBe('');
  });

  it('resolves a generated model through an existing generic provider adapter', () => {
    const generated: GeneratedCatalogModel = {
      provider: 'qwen',
      canonical_name: 'qwen-generated-explicit',
      api_model_id: 'qwen-generated-explicit',
      context_window: 128_000,
      source: 'generated',
      public: true,
      explicit_only: true,
      auto_route: false,
      source_url: 'https://example.test/litellm.json',
      source_hash: 'fixture-hash',
      source_as_of: '2026-08-26T12:00:00.000Z',
    };
    const effective = mergeCatalogDefinitions([], [generated]);

    expect(resolveProvider(generated.canonical_name, effective)).toBe('qwen');
  });
  it('keeps OpenAI prefix resolution ahead of generated alternate-provider rows', () => {
    const generatedAlternate: GeneratedCatalogModel = {
      provider: 'azure',
      canonical_name: 'gpt-4o',
      api_model_id: 'gpt-4o',
      context_window: 128_000,
      source: 'generated',
      public: true,
      explicit_only: true,
      auto_route: false,
      source_url: 'https://example.test/litellm.json',
      source_hash: 'fixture-hash',
      source_as_of: '2026-08-26T12:00:00.000Z',
    };

    expect(resolveProvider('gpt-4o', [generatedAlternate])).toBe('openai');
    expect(resolveProvider('gpt-4o', [generatedAlternate])).not.toBe('azure');
  });


  it('parked (public: false) registry entries are never dispatchable', () => {
    // The catalog autopilot's entire safety story rests on this behavior:
    // auto-proposed entries carry public: false and MUST resolve to no provider.
    const parked = MODEL_REGISTRY.filter((m) => m.public === false);
    expect(parked.length).toBeGreaterThan(0);
    for (const m of parked) {
      expect(resolveProvider(m.canonical_name)).toBe('');
      if (m.api_model_id !== m.canonical_name) {
        expect(resolveProvider(m.api_model_id)).toBe('');
      }
    }
  });

  it('no parked entry shadows the prefix passthrough for unknown new models', () => {
    // resolveProvider dispatches UNKNOWN ids by prefix (gpt-*/o3*/o4* →
    // openai, claude-* → anthropic, gemini-* → google) so brand-new flagship
    // models work the day they ship. A parked entry with such an id would
    // install an exact match that revokes those working requests — the
    // autopilot filters passthrough-covered ids out of proposals
    // (propose-parked-models.ts), and this pin fails loudly if either side
    // drifts (opus, review round 4).
    const passthrough = (id: string) =>
      id.startsWith('gpt-') ||
      id === 'o3' ||
      id.startsWith('o3-') ||
      id === 'o4' ||
      id.startsWith('o4-') ||
      id.startsWith('claude-') ||
      id.startsWith('gemini-');
    const intentionallyDenied: Record<string, true> = {
      // Responses-only; resolveProvider has a separate exact-deny regression.
      'gpt-5.6-cyber': true,
    };
    const offenders = MODEL_REGISTRY.filter(
      (m) =>
        m.public === false &&
        !intentionallyDenied[m.canonical_name] &&
        (passthrough(m.canonical_name) || passthrough(m.api_model_id)),
    ).map((m) => m.canonical_name);
    expect(
      offenders,
      `parked entries shadowing the prefix passthrough (parking these revokes working requests): ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it.each([
    'gemini-2.5-flash-lite-preview-06-17',
    'gemini-2.5-flash-lite-preview-09-2025',
    'gemini-2.5-flash-preview-09-2025',
    'gemini-3-flash-preview',
    'gemini-3.1-flash-lite-preview',
    'gemini-3.1-pro-preview',
    'gemini-3.1-pro-preview-customtools',
  ])('blocks quarantined Google preview model %s instead of prefix dispatch', (model) => {
    expect(resolveProvider(model)).toBe('');
  });

  it('priced-onboarded covered ids resolve to their provider and never shadow unknown passthrough (RSH-167)', () => {
    // RSH-167: the drift cycle's prefix-covered ids land PUBLIC (auto_route:
    // false, public: true explicit) so they resolve to their provider
    // exactly — the same outcome the prefix passthrough gave — while
    // still-unknown siblings keep the prefix behavior. A future PR must not
    // flip these to parked. Table-driven over the FULL cohort so a provider
    // typo on any single id fails CI.
    const cohort: Array<[string, string]> = [
      ['claude-opus-4-5-20251101', 'anthropic'],
      ['claude-opus-4-6-20260205', 'anthropic'],
      ['claude-opus-4-7-20260416', 'anthropic'],
      ['claude-sonnet-4-5-20250929', 'anthropic'],
      ['gemini-2.5-flash-lite', 'google'],
      ['gemini-3.5-flash-lite', 'google'],
      ['gpt-4', 'openai'],
      ['gpt-4.1-2025-04-14', 'openai'],
      ['gpt-4.1-mini-2025-04-14', 'openai'],
      ['gpt-4.1-nano-2025-04-14', 'openai'],
      ['gpt-5-2025-08-07', 'openai'],
      ['gpt-5-chat', 'openai'],
      ['gpt-5-chat-latest', 'openai'],
      ['gpt-5-mini', 'openai'],
      ['gpt-5-mini-2025-08-07', 'openai'],
      ['gpt-5-nano', 'openai'],
      ['gpt-5-nano-2025-08-07', 'openai'],
      ['gpt-5-search-api', 'openai'],
      ['gpt-5-search-api-2025-10-14', 'openai'],
      ['gpt-5.1', 'openai'],
      ['gpt-5.1-2025-11-13', 'openai'],
      ['gpt-5.1-chat-latest', 'openai'],
      ['gpt-5.2', 'openai'],
      ['gpt-5.2-2025-12-11', 'openai'],
      ['gpt-5.2-chat-latest', 'openai'],
      ['gpt-5.3-chat-latest', 'openai'],
      ['gpt-5.4-2026-03-05', 'openai'],
      ['gpt-5.4-mini-2026-03-17', 'openai'],
      ['gpt-5.4-nano-2026-03-17', 'openai'],
      ['gpt-5.5-2026-04-23', 'openai'],
      ['gpt-5.6', 'openai'],
      ['gpt-5.6-luna', 'openai'],
      ['gpt-5.6-sol', 'openai'],
      ['gpt-5.6-terra', 'openai'],
      ['o3-2025-04-16', 'openai'],
      ['o3-mini', 'openai'],
      ['o3-mini-2025-01-31', 'openai'],
      ['o4-mini-2025-04-16', 'openai'],
    ];
    for (const [model, provider] of cohort) {
      expect(resolveProvider(model), `${model} must resolve to ${provider}`).toBe(provider);
    }
    // Still-unknown siblings keep the prefix passthrough for EVERY covered
    // prefix, including o3- / o4-.
    expect(resolveProvider('gpt-9.9-still-unknown')).toBe('openai');
    expect(resolveProvider('claude-9.9-still-unknown')).toBe('anthropic');
    expect(resolveProvider('gemini-9.9-still-unknown')).toBe('google');
    expect(resolveProvider('o3-9.9-still-unknown')).toBe('openai');
    expect(resolveProvider('o4-9.9-still-unknown')).toBe('openai');
  });

  it('unknown flagship-prefix models still dispatch via the prefix passthrough', () => {
    // The propose-side filter and the disjointness pin above mirror this
    // predicate; this pins the PROXY behavior itself so predicate-vs-code
    // drift fails loudly (nw-kimi, review round 5).
    expect(resolveProvider('gpt-9.9-definitely-unknown')).toBe('openai');
    expect(resolveProvider('o3-definitely-unknown')).toBe('openai');
    expect(resolveProvider('o4-definitely-unknown')).toBe('openai');
    expect(resolveProvider('claude-definitely-unknown-9')).toBe('anthropic');
    expect(resolveProvider('gemini-definitely-unknown-9')).toBe('google');
  });

  it('returns 413 when request body exceeds configured max size', async () => {
    mocks.config.maxRequestBodyBytes = 5;
    const out = makeRes();

    await handleProxyRequest(makeReq({ body: Buffer.from('{"model":"gpt-4o"}') }), out.res);

    expect(out.statusCode).toBe(413);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'Request body too large' } });
  });

  it('returns 400 for invalid JSON body', async () => {
    const out = makeRes();

    await handleProxyRequest(makeReq({ body: Buffer.from('{"model"') }), out.res);

    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'Invalid JSON in request body' } });
  });

  it('returns 401 when authorization header is missing', async () => {
    const out = makeRes();

    await handleProxyRequest(makeReq({ body: Buffer.from('{"model":"gpt-4o"}') }), out.res);

    expect(out.statusCode).toBe(401);
    expect(JSON.parse(out.body)).toEqual({
      error: { message: 'API key required. Use Authorization: Bearer sk-proxy-...' },
    });
  });

  it('returns 401 for invalid API key', async () => {
    mocks.validateApiKey.mockResolvedValueOnce(null);
    const out = makeRes();

    await handleProxyRequest(
      makeReq({
        body: Buffer.from('{"model":"gpt-4o"}'),
        authHeader: 'Bearer sk-proxy-invalid',
      }),
      out.res,
    );

    expect(out.statusCode).toBe(401);
    expect(mocks.validateApiKey).toHaveBeenCalledWith('sk-proxy-invalid');
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'Invalid API key' } });
  });

  it('RSH-86: returns 503 when validateApiKey throws AuthInfrastructureError (not false 401)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.validateApiKey.mockRejectedValueOnce(new AuthInfrastructureError('DB down', new Error('Connection terminated')));
    const out = makeRes();

    await handleProxyRequest(
      makeReq({
        body: Buffer.from('{"model":"gpt-4o"}'),
        authHeader: 'Bearer sk-proxy-live_team_dbdown',
      }),
      out.res,
    );

    expect(out.statusCode).toBe(503);
    expect(out.headers?.['Retry-After']).toBe('5');
    expect(JSON.parse(out.body)).toEqual({
      error: { message: 'Service temporarily unavailable', code: 'auth_infrastructure_error' },
    });
    consoleSpy.mockRestore();
  });
});
