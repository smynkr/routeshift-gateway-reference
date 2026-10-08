import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockValidate = vi.fn();
vi.mock('../src/auth/api-key.js', () => ({ validateApiKey: (k: string) => mockValidate(k) }));
vi.mock('../src/routing/model-aliases.js', () => ({ resolveAlias: async (_t: string, m: string) => m }));
const mockBillingMode = vi.fn();
const mockReserveBudget = vi.fn();
const mockMarkBudget = vi.fn();
const mockSettleBudget = vi.fn();
const mockReleaseBudget = vi.fn();
const mockEstimateEmbedding = vi.fn();
const mockTeamTpmLimit = vi.fn();
const mockProviderKey = vi.fn();
const mockPreflight = vi.fn();
const mockDeduct = vi.fn();
const mockReserve = vi.fn();
const mockSettle = vi.fn();
const mockUnknownHold = vi.fn();
const mockCreditPricing = vi.fn();
const mockTopup = vi.fn();
const mockAudit = vi.fn();
const mockCost = vi.fn();
vi.mock('../src/billing/plan-limits.js', () => ({
  getTeamBillingMode: (...a: unknown[]) => mockBillingMode(...a),
  getTeamPlan: async () => 'growth',
  getPlanLimits: () => ({ creditsMarkupPercent: 0, fallbacksEnabled: true }),
}));
vi.mock('../src/billing/budget-reservations.js', () => ({
  reserveBudget: (...a: unknown[]) => mockReserveBudget(...a),
  markBudgetReservationDispatched: (...a: unknown[]) => mockMarkBudget(...a),
  settleBudgetReservation: (...a: unknown[]) => mockSettleBudget(...a),
  releaseBudgetReservation: (...a: unknown[]) => mockReleaseBudget(...a),
}));
vi.mock('../src/billing/budget-estimate.js', () => ({
  estimateEmbeddingBudget: (...a: unknown[]) => mockEstimateEmbedding(...a),
  utf8TokenUpperBound: (...a: unknown[]) => a[0].reduce((sum: number, item: string) => sum + Buffer.byteLength(item, 'utf8') + 1, 0),
}));
vi.mock('../src/rate-limit/team-tpm.js', () => ({ getTeamTpmLimit: (...a: unknown[]) => mockTeamTpmLimit(...a) }));
vi.mock('../src/billing/provider-key-crypto.js', () => ({ getDecryptedProviderKey: (...a: unknown[]) => mockProviderKey(...a) }));
vi.mock('../src/billing/credits.js', () => ({
  preFlightCreditCheck: (...a: unknown[]) => mockPreflight(...a),
  deductCredits: (...a: unknown[]) => mockDeduct(...a),
  reserveCredits: (...a: unknown[]) => mockReserve(...a),
  settleReservedCredits: (...a: unknown[]) => mockSettle(...a),
  settleReservedCreditsWithUnknownCostHold: (...a: unknown[]) => mockUnknownHold(...a),
  getCreditPricing: (...a: unknown[]) => mockCreditPricing(...a),
  checkAutoTopUpNeeded: (...a: unknown[]) => mockTopup(...a),
}));
vi.mock('../src/auth/audit-events.js', () => ({ recordAuditEvent: (...a: unknown[]) => mockAudit(...a) }));
vi.mock('../src/cost/calculator.js', () => ({ computeRequestCost: (...a: unknown[]) => mockCost(...a) }));
const logSpy = vi.fn();
vi.mock('../src/logging/logger.js', () => ({ logRequest: (r: unknown) => logSpy(r) }));
vi.mock('../src/observability/sentry.js', () => ({ captureException: vi.fn() }));

import { handleEmbeddingsRequest } from '../src/embeddings/handler.js';
import { _resetCooldowns, isCoolingDown } from '../src/billing/rate-limit-cooldown.js';
import { _resetKeyStats } from '../src/billing/key-stats.js';
import { rateLimiter } from '../src/rate-limit/limiter.js';

function makeReq(body: unknown, headers: Record<string, string> = { authorization: 'Bearer sk-proxy-x' }): IncomingMessage {
  const r = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
  (r as any).headers = headers; (r as any).method = 'POST'; (r as any).url = '/v1/embeddings';
  return r;
}
function makeRes(onEnd?: () => void) {
  let statusCode = 0; let body = ''; const headers: Record<string, string> = {};
  const res = Object.assign(new EventEmitter(), { setHeader(k: string, v: string) { headers[k] = v; }, writeHead(c: number, h?: Record<string, string>) { statusCode = c; Object.assign(headers, h ?? {}); return res; }, end(chunk?: string) { onEnd?.(); body = chunk ?? ''; res.emit('finish'); return res; } }) as unknown as ServerResponse;
  return { res, get statusCode() { return statusCode; }, get body() { return body; }, get headers() { return headers; } };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  _resetCooldowns();
  _resetKeyStats();
  mockValidate.mockReset(); logSpy.mockReset(); mockBillingMode.mockReset(); mockReserveBudget.mockReset(); mockMarkBudget.mockReset(); mockSettleBudget.mockReset(); mockReleaseBudget.mockReset(); mockEstimateEmbedding.mockReset();
  mockTeamTpmLimit.mockReset(); mockProviderKey.mockReset(); mockPreflight.mockReset(); mockDeduct.mockReset(); mockReserve.mockReset(); mockSettle.mockReset(); mockUnknownHold.mockReset(); mockCreditPricing.mockReset(); mockTopup.mockReset(); mockAudit.mockReset(); mockCost.mockReset();
  mockValidate.mockResolvedValue({ id: 'k1', teamId: 'team_a', allowedModels: null });
  mockBillingMode.mockResolvedValue('subscription');
  mockReserveBudget.mockResolvedValue({
    allowed: true,
    reservation: {
      requestId: 'budget-req',
      teamId: 'team_a',
      apiKeyId: 'k1',
      estimatedMicrocents: 1,
      reservedMicrocents: 1,
      dispatched: false,
      terminal: false,
    },
    warnings: [],
  });
  mockMarkBudget.mockResolvedValue({ marked: true, alreadyMarked: false });
  mockSettleBudget.mockResolvedValue(undefined);
  mockReleaseBudget.mockResolvedValue(undefined);
  mockEstimateEmbedding.mockResolvedValue({ estimatedMicrocents: 1 });
  mockTeamTpmLimit.mockResolvedValue(null);
  mockProviderKey.mockResolvedValue({ key: 'team-openai-key', metadata: {}, label: 'primary' });
  mockPreflight.mockResolvedValue({ allowed: true, balance: 1000, estimatedCost: 1 });
  mockDeduct.mockResolvedValue({ success: true, newBalance: 999, amountDeducted: 1 });
  mockReserve.mockResolvedValue({ success: true, newBalance: 999, amountDeducted: 1 });
  mockSettle.mockResolvedValue({ success: true, newBalance: 999, amountDeducted: 1 });
  mockUnknownHold.mockResolvedValue({ success: true, newBalance: 999, amountDeducted: 1, pendingHoldMicrocents: 1, amountRefunded: 0 });
  mockCreditPricing.mockResolvedValue({ input_cost_per_million: 1 });
  mockTopup.mockResolvedValue(undefined);
  mockCost.mockResolvedValue({ original_cost_microcents: 1, actual_cost_microcents: 1, savings_microcents: 0 });
  process.env.OPENAI_API_KEY = 'sk-platform';
  process.env.GOOGLE_API_KEY = 'g-platform';
});

it('401s when the API key is missing or invalid', async () => {
  const missing = makeRes();
  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: 'hi' }, {}), missing.res);
  expect(missing.statusCode).toBe(401);

  mockValidate.mockResolvedValue(null);
  const invalid = makeRes();
  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: 'hi' }), invalid.res);
  expect(invalid.statusCode).toBe(401);
});

it('403s a key without inference scope before upstream or billing work', async () => {
  mockValidate.mockResolvedValue({
    id: 'k1',
    teamId: 'team_a',
    allowedModels: null,
    metadata: { created_via: 'oauth_device', scope: 'read' },
  });
  const fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  const out = makeRes();

  await handleEmbeddingsRequest(
    makeReq({ model: 'text-embedding-3-small', input: 'hi' }),
    out.res,
  );

  expect(out.statusCode).toBe(403);
  expect(JSON.parse(out.body)).toEqual({
    error: {
      message: 'insufficient_scope: missing inference scope',
      code: 'insufficient_scope',
    },
  });
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(mockReserveBudget).not.toHaveBeenCalled();
  expect(mockPreflight).not.toHaveBeenCalled();
});

it('403s a preset-bound key before upstream or billing work (RSH-146)', async () => {
  // The preset binding is chat org policy; the embeddings surface is not
  // covered by it, so a bound key must fail closed instead of silently
  // serving billable embeddings outside the binding.
  mockValidate.mockResolvedValue({
    id: 'k1',
    teamId: 'team_a',
    allowedModels: null,
    presetSlug: 'org-policy',
    presetVersion: 3,
  });
  const fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  const out = makeRes();

  await handleEmbeddingsRequest(
    makeReq({ model: 'text-embedding-3-small', input: 'hi' }),
    out.res,
  );

  expect(out.statusCode).toBe(403);
  expect(JSON.parse(out.body)).toEqual({
    error: {
      message: 'This API key is bound to a preset (org-policy); the embeddings endpoint is not covered by the binding',
      code: 'key_preset_embeddings_denied',
    },
  });
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(mockReserveBudget).not.toHaveBeenCalled();
  expect(mockPreflight).not.toHaveBeenCalled();
});

it.each([
  null,
  { model: 'text-embedding-3-small', input: '' },
  { model: 'text-embedding-3-small', input: [] },
  { model: 'text-embedding-3-small', input: [null] },
  { model: 'text-embedding-3-small', input: [''] },
])('400s invalid embedding request body/input %#', async (body) => {
  const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy);
  const out = makeRes();
  await handleEmbeddingsRequest(makeReq(body), out.res);
  expect(out.statusCode).toBe(400);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('413s an oversized embedding batch', async () => {
  const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy);
  const out = makeRes();
  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: Array.from({ length: 2049 }, () => 'x') }), out.res);
  expect(out.statusCode).toBe(413);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('snapshots layer_identity_id from key metadata at request time (AXI-8)', async () => {
  mockValidate.mockResolvedValue({
    id: 'k1',
    teamId: 'team_a',
    allowedModels: null,
    metadata: { layer_identity_id: 'alice@example.com' },
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2], index: 0 }], usage: { prompt_tokens: 3, total_tokens: 3 } }) }));
  const out = makeRes();
  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: 'hi' }), out.res);
  expect(out.statusCode).toBe(200);
  expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
    request_kind: 'embedding',
    layer_identity_id: 'alice@example.com',
  }));
});

it('logs a null identity snapshot when the key carries none (AXI-8)', async () => {
  // Explicit rest stub: never inherit the identity-carrying keyInfo from a
  // neighboring test.
  mockValidate.mockReset();
  mockValidate.mockResolvedValue({ id: 'k1', teamId: 'team_a', allowedModels: null, metadata: {} });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2], index: 0 }], usage: { prompt_tokens: 3, total_tokens: 3 } }) }));
  const out = makeRes();
  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: 'hi' }), out.res);
  expect(out.statusCode).toBe(200);
  // null (not undefined/absent): the record flows to the writer, which stores
  // the '' sentinel so the row can never fall back to later key metadata.
  expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
    layer_identity_id: null,
  }));
});

it('returns OpenAI-shaped embeddings and logs request_kind=embedding', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2], index: 0 }], usage: { prompt_tokens: 3, total_tokens: 3 } }) }));
  const out = makeRes();
  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: 'hi' }), out.res);
  expect(out.statusCode).toBe(200);
  const json = JSON.parse(out.body);
  expect(json.object).toBe('list');
  expect(json.data[0].embedding).toEqual([0.1, 0.2]);
  expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
    request_kind: 'embedding',
    output_tokens: 0,
    billing_mode: 'subscription',
  }));
  const upstreamBody = JSON.parse((vi.mocked(global.fetch).mock.calls[0][1] as any).body);
  expect(upstreamBody).toEqual({ model: 'text-embedding-3-small', input: 'hi' });
});

it('uses a configured team provider key for embeddings in subscription mode', async () => {
  mockProviderKey.mockResolvedValueOnce({ key: 'team-openai-key', metadata: {}, label: 'primary' });
  const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ embedding: [0.1], index: 0 }], usage: { prompt_tokens: 3, total_tokens: 3 } }) });
  vi.stubGlobal('fetch', fetchSpy);
  const out = makeRes();

  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: 'hi' }), out.res);

  expect(out.statusCode).toBe(200);
  expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe('Bearer team-openai-key');
});

it('never subsidizes subscription embeddings with a platform provider key', async () => {
  mockProviderKey.mockResolvedValueOnce(null);
  const fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  const out = makeRes();

  await handleEmbeddingsRequest(
    makeReq({ model: 'text-embedding-3-small', input: 'hi' }),
    out.res,
  );

  expect(out.statusCode).toBe(503);
  expect(JSON.parse(out.body)).toEqual({
    error: {
      message: "openai requires a team-configured provider key. Save one via the dashboard's Provider Keys page.",
    },
  });
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('marks a labeled embeddings provider key as cooled down on upstream 429', async () => {
  mockProviderKey.mockResolvedValueOnce({ key: 'team-openai-key', metadata: {}, label: 'primary' });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: false,
    status: 429,
    text: async () => JSON.stringify({ error: { message: 'rate limited' } }),
  }));
  const out = makeRes();

  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: 'hi' }), out.res);

  expect(out.statusCode).toBe(429);
  expect(isCoolingDown('team_a', 'openai', 'primary')).toBe(true);
});

it('400s an unsupported model without calling upstream', async () => {
  const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy);
  const out = makeRes();
  await handleEmbeddingsRequest(makeReq({ model: 'gpt-5.4', input: 'hi' }), out.res);
  expect(out.statusCode).toBe(400);
  expect(JSON.parse(out.body).error.code).toBe('embeddings_unsupported');
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('403s a model not in the key allowlist', async () => {
  mockValidate.mockResolvedValue({ id: 'k1', teamId: 'team_a', allowedModels: ['text-embedding-3-large'] });
  const out = makeRes();
  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: 'hi' }), out.res);
  expect(out.statusCode).toBe(403);
});

it('429s with the shared rejection contract when the daily key cap throttles', async () => {
  mockReserveBudget.mockResolvedValue({
    allowed: false,
    kind: 'exceeded',
    statusCode: 429,
    scope: 'key',
    action: 'throttle',
    window: 'daily',
    resetAt: '2026-08-10T00:00:00.000Z',
    retryAfterSeconds: 45,
    message: 'Budget cap exceeded for daily window',
  });
  const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy);
  const out = makeRes();
  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: 'hi' }), out.res);
  expect(out.statusCode).toBe(429);
  expect(out.headers['Retry-After']).toBe('45');
  expect(JSON.parse(out.body).error).toEqual({
    message: 'Budget cap exceeded for daily window',
    window: 'daily',
    reset_at: '2026-08-10T00:00:00.000Z',
    scope: 'key',
    action: 'throttle',
    retry_after: 45,
  });
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(mockMarkBudget).not.toHaveBeenCalled();
});

it('402s when the team monthly cap blocks', async () => {
  mockReserveBudget.mockResolvedValue({
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
  const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy);
  const out = makeRes();
  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: 'hi' }), out.res);
  expect(out.statusCode).toBe(402);
  expect(JSON.parse(out.body).error.window).toBe('monthly');
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('503s with budget_estimate_unavailable when a hard cap has no pricing', async () => {
  mockReserveBudget.mockResolvedValue({
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
  const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy);
  const out = makeRes();
  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: 'hi' }), out.res);
  expect(out.statusCode).toBe(503);
  expect(JSON.parse(out.body).error.code).toBe('budget_estimate_unavailable');
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('503s when the reservation throws (embeddings fail closed)', async () => {
  mockReserveBudget.mockRejectedValue(new Error('budget down'));
  const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy);
  const out = makeRes();
  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: 'hi' }), out.res);
  expect(out.statusCode).toBe(503);
  expect(JSON.parse(out.body).error.message).toBe('Budget service unavailable');
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
    event_type: 'budget_exceeded',
    details: expect.objectContaining({ action: 'unavailable', request_kind: 'embedding' }),
  }));
});

it('estimates from the UTF-8 byte upper bound before any fetch', async () => {
  const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ embedding: [0.1], index: 0 }], usage: { prompt_tokens: 3, total_tokens: 3 } }) });
  vi.stubGlobal('fetch', fetchSpy);
  const out = makeRes();
  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: '你好世界' }), out.res);
  expect(mockEstimateEmbedding).toHaveBeenCalledWith({
    provider: 'openai',
    model: 'text-embedding-3-small',
    // 4 CJK chars × 3 bytes + 1 per-item overhead = 13, never Math.ceil(4/4)=1
    inputTokens: 13,
  });
  expect(mockReserveBudget.mock.invocationCallOrder[0]).toBeLessThan(fetchSpy.mock.invocationCallOrder[0]!);
});

it('marks dispatch before the fetch and settles the exact input cost on success', async () => {
  const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ embedding: [0.1], index: 0 }], usage: { prompt_tokens: 7, total_tokens: 7 } }) });
  vi.stubGlobal('fetch', fetchSpy);
  mockCost.mockResolvedValue({ original_cost_microcents: 2, actual_cost_microcents: 2, savings_microcents: 0 });
  const out = makeRes();
  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: 'hi there' }), out.res);
  expect(out.statusCode).toBe(200);
  expect(mockMarkBudget).toHaveBeenCalledTimes(1);
  expect(mockMarkBudget.mock.invocationCallOrder[0]).toBeLessThan(fetchSpy.mock.invocationCallOrder[0]!);
  expect(mockSettleBudget).toHaveBeenCalledWith(expect.objectContaining({
    actualMicrocents: 2,
    actualCostKnown: true,
  }));
});

it('aborts with 503 before the fetch when the dispatch mark fails', async () => {
  mockMarkBudget.mockResolvedValue({ marked: false, alreadyMarked: false });
  const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy);
  const out = makeRes();
  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: 'hi' }), out.res);
  expect(out.statusCode).toBe(503);
  expect(JSON.parse(out.body).error.message).toBe('Budget service unavailable');
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(mockReleaseBudget).toHaveBeenCalled();
});

it('releases the reservation on a known-zero upstream 4xx', async () => {
  const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'bad request' });
  vi.stubGlobal('fetch', fetchSpy);
  const out = makeRes();
  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: 'hi' }), out.res);
  expect(out.statusCode).toBe(400);
  expect(mockSettleBudget).toHaveBeenCalledWith(expect.objectContaining({
    actualMicrocents: 0,
    actualCostKnown: true,
    reasonCode: 'no_dispatch',
  }));
});

it('holds the unresolved remainder on an upstream 5xx', async () => {
  const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
  vi.stubGlobal('fetch', fetchSpy);
  const out = makeRes();
  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: 'hi' }), out.res);
  expect(out.statusCode).toBe(500);
  expect(mockSettleBudget).toHaveBeenCalledWith(expect.objectContaining({
    actualMicrocents: 0,
    actualCostKnown: false,
  }));
});

it('holds the unresolved remainder on a network rejection', async () => {
  const fetchSpy = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
  vi.stubGlobal('fetch', fetchSpy);
  const out = makeRes();
  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: 'hi' }), out.res);
  expect(out.statusCode).toBe(502);
  expect(mockSettleBudget).toHaveBeenCalledWith(expect.objectContaining({
    actualCostKnown: false,
    reasonCode: 'upstream_unknown',
  }));
});

it('429s when the team TPM cap is exceeded', async () => {
  mockValidate.mockResolvedValue({ id: 'k1', teamId: 'team_tpm', allowedModels: null });
  mockTeamTpmLimit.mockResolvedValue(1);
  const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy);
  const out = makeRes();
  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: '12345678' }), out.res);
  expect(out.statusCode).toBe(429);
  expect(out.headers['X-RouteShift-Reason']).toBe('team_tpm_exceeded');
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('releases the per-key TPM reservation when the team TPM cap rejects (RSH-60)', async () => {
  // Key carries a TPM override, so the per-key check books an estimate; the team
  // cap then rejects. The per-key reservation must be released (it was previously
  // left phantom-counting against the key's own window for the full 60s window).
  mockValidate.mockResolvedValue({ id: 'k1', teamId: 'team_tpm_release', allowedModels: null, rateLimitOverride: { tokens_per_minute: 100000 } });
  mockTeamTpmLimit.mockResolvedValue(1); // team cap of 1 token -> rejects an 8-char input
  const removeSpy = vi.spyOn(rateLimiter, 'removeRecord');
  const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy);
  const out = makeRes();
  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: '12345678' }), out.res);
  expect(out.statusCode).toBe(429);
  expect(out.headers['X-RouteShift-Reason']).toBe('team_tpm_exceeded');
  expect(fetchSpy).not.toHaveBeenCalled();
  // Released with the real (non-null) per-key recordId, not just a null no-op.
  expect(removeSpy.mock.calls.some(([id]) => typeof id === 'string' && id.length > 0)).toBe(true);
  removeSpy.mockRestore();
});

it('reserves credits before upstream fetch', async () => {
  const order: string[] = [];
  mockBillingMode.mockResolvedValue('credits');
  mockReserve.mockImplementation(async () => {
    order.push('reserve');
    return { success: true, newBalance: 999, amountDeducted: 1 };
  });
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
    order.push('fetch');
    return { ok: true, json: async () => ({ data: [{ embedding: [0.1], index: 0 }], usage: { prompt_tokens: 3, total_tokens: 3 } }) };
  }));
  const out = makeRes();
  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: 'hi' }), out.res);
  expect(out.statusCode).toBe(200);
  expect(order.slice(0, 2)).toEqual(['reserve', 'fetch']);
  expect(mockProviderKey).not.toHaveBeenCalled();
  expect((vi.mocked(global.fetch).mock.calls[0][1] as any).headers.Authorization).toBe('Bearer sk-platform');
  expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({ billing_mode: 'credits' }));
});

it('settles reserved credits before sending the success response', async () => {
  const order: string[] = [];
  mockBillingMode.mockResolvedValue('credits');
  mockSettle.mockImplementation(async () => {
    order.push('settle');
    return { success: true, newBalance: 999, amountDeducted: 1 };
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ embedding: [0.1], index: 0 }], usage: { prompt_tokens: 3, total_tokens: 3 } }) }));
  const out = makeRes(() => order.push('end'));
  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: 'hi' }), out.res);
  expect(out.statusCode).toBe(200);
  expect(mockSettle).toHaveBeenCalledWith('team_a', 1, 1, 0, expect.any(String), 'text-embedding-3-small embedding (3 tokens)');
  expect(mockDeduct).not.toHaveBeenCalled();
  expect(order).toEqual(['settle', 'end']);
});

it('402s without upstream fetch when embedding credit reservation fails', async () => {
  mockBillingMode.mockResolvedValue('credits');
  mockReserve.mockResolvedValueOnce({ success: false, newBalance: 7, amountDeducted: 0 });
  const fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  const out = makeRes();

  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: 'hi' }), out.res);

  expect(out.statusCode).toBe(402);
  expect(out.headers['X-RouteShift-Credits-Remaining']).toBe('7');
  expect(out.headers['X-RouteShift-Estimated-Cost']).toBe('1');
  expect(JSON.parse(out.body)).toEqual({ error: { message: 'Insufficient credits', code: 'credit_reservation_failed' } });
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('keeps a durable unknown-cost hold when upstream fetch rejects', async () => {
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mockBillingMode.mockResolvedValue('credits');
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
  const out = makeRes();

  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: 'hi' }), out.res);

  expect(out.statusCode).toBe(502);
  expect(mockUnknownHold).toHaveBeenCalledWith(
    'team_a',
    1,
    0,
    null,
    0,
    expect.any(String),
    'text-embedding-3-small embedding unknown-cost hold',
    'upstream_network_error',
    1,
  );
  expect(mockSettle).not.toHaveBeenCalled();
  expect(logSpy).toHaveBeenCalledTimes(1);
  expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
    request_kind: 'embedding', status_code: 502, error_type: 'upstream_network_error',
    actual_cost_microcents: 0, actual_cost_known: false, savings_microcents: 0, total_tokens: 0,
  }));
  errSpy.mockRestore();
});

it('keeps a durable unknown-cost hold for an upstream embedding 5xx', async () => {
  mockBillingMode.mockResolvedValue('credits');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: false,
    status: 503,
    text: async () => JSON.stringify({ error: { message: 'unavailable' } }),
  }));
  const out = makeRes();

  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: 'hi' }), out.res);

  expect(out.statusCode).toBe(503);
  expect(mockUnknownHold).toHaveBeenCalledWith(
    'team_a', 1, 0, null, 0, expect.any(String), expect.any(String), 'upstream_http_5xx', 1,
  );
  expect(mockSettle).not.toHaveBeenCalled();
  expect(logSpy).toHaveBeenCalledTimes(1);
  expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
    request_kind: 'embedding', status_code: 503, error_type: 'upstream_http_5xx',
    actual_cost_microcents: 0, actual_cost_known: false, savings_microcents: 0, total_tokens: 0,
  }));
});

it.each([400, 429])('releases the reservation for known-zero upstream embedding %i', async (status) => {
  mockBillingMode.mockResolvedValue('credits');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: async () => JSON.stringify({ error: { message: 'rejected' } }),
  }));
  const out = makeRes();

  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: 'hi' }), out.res);

  expect(out.statusCode).toBe(status);
  expect(mockUnknownHold).not.toHaveBeenCalled();
  expect(mockSettle).toHaveBeenCalledWith(
    'team_a', 1, 0, 0, expect.any(String), 'text-embedding-3-small embedding (reservation released)',
  );
  expect(logSpy).toHaveBeenCalledTimes(1);
  expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
    request_kind: 'embedding', status_code: status, error_type: 'upstream_http_error',
    actual_cost_microcents: 0, actual_cost_known: true, savings_microcents: 0,
  }));
});

it('keeps a durable unknown-cost hold when an accepted embedding response is malformed', async () => {
  mockBillingMode.mockResolvedValue('credits');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new Error('bad JSON'); } }));
  const out = makeRes();

  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: 'hi' }), out.res);

  expect(out.statusCode).toBe(502);
  expect(mockUnknownHold).toHaveBeenCalledWith(
    'team_a', 1, 0, null, 0, expect.any(String), expect.any(String), 'upstream_json_parse_error', 1,
  );
  expect(mockSettle).not.toHaveBeenCalled();
  expect(logSpy).toHaveBeenCalledTimes(1);
  expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
    status_code: 502, error_type: 'upstream_json_parse_error', actual_cost_known: false, total_tokens: 0,
  }));
});

it('keeps a durable unknown-cost hold when the accepted embedding payload fails adapter parsing', async () => {
  mockBillingMode.mockResolvedValue('credits');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: {} }) }));
  const out = makeRes();

  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: 'hi' }), out.res);

  expect(out.statusCode).toBe(502);
  expect(mockUnknownHold).toHaveBeenCalledWith(
    'team_a', 1, 0, null, 0, expect.any(String), expect.any(String), 'upstream_embedding_response_invalid', 1,
  );
  expect(mockSettle).not.toHaveBeenCalled();
  expect(logSpy).toHaveBeenCalledTimes(1);
  expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
    status_code: 502, error_type: 'upstream_embedding_response_invalid', actual_cost_known: false, total_tokens: 0,
  }));
});

it('keeps a durable unknown-cost hold when accepted embedding cost calculation fails', async () => {
  mockBillingMode.mockResolvedValue('credits');
  mockCost.mockRejectedValue(new Error('pricing lookup failed'));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: [{ embedding: [0.1], index: 0 }], usage: { prompt_tokens: 3, total_tokens: 3 } }),
  }));
  const out = makeRes();

  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: 'hi' }), out.res);

  expect(out.statusCode).toBe(502);
  expect(mockUnknownHold).toHaveBeenCalledWith(
    'team_a', 1, 0, null, 0, expect.any(String), expect.any(String), 'upstream_cost_calculation_failed', 1,
  );
  expect(mockSettle).not.toHaveBeenCalled();
  expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
    status_code: 502, error_type: 'upstream_cost_calculation_failed', actual_cost_known: false, total_tokens: 3,
  }));
});

it('fails closed with a durable hold when embedding pricing disappears after dispatch', async () => {
  mockBillingMode.mockResolvedValue('credits');
  mockCreditPricing.mockResolvedValue(null);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ embedding: [0.1], index: 0 }], usage: { prompt_tokens: 3, total_tokens: 3 } }) }));
  const out = makeRes();

  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: 'hi' }), out.res);

  expect(out.statusCode).toBe(503);
  expect(JSON.parse(out.body).error.code).toBe('missing_model_pricing');
  expect(mockUnknownHold).toHaveBeenCalledWith(
    'team_a', 1, 0, null, 0, expect.any(String), expect.any(String), 'missing_model_pricing_after_dispatch', 1,
  );
  expect(mockSettle).not.toHaveBeenCalled();
  expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
    status_code: 503, error_type: 'missing_model_pricing_after_dispatch', actual_cost_known: false, total_tokens: 0,
  }));
});

it('records a precise unknown-cost hold when post-dispatch pricing lookup fails', async () => {
  mockBillingMode.mockResolvedValue('credits');
  mockCreditPricing.mockRejectedValueOnce(new Error('pricing database unavailable'));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: [{ embedding: [0.1], index: 0 }], usage: { prompt_tokens: 3, total_tokens: 3 } }),
  }));
  const out = makeRes();

  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: 'hi' }), out.res);

  expect(out.statusCode).toBe(502);
  expect(mockUnknownHold).toHaveBeenCalledWith(
    'team_a', 1, 0, null, 0, expect.any(String), expect.any(String), 'post_dispatch_pricing_lookup_failed', 1,
  );
  expect(mockSettle).not.toHaveBeenCalled();
  expect(logSpy).toHaveBeenCalledTimes(1);
  expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
    status_code: 502, error_type: 'post_dispatch_pricing_lookup_failed', actual_cost_known: false, total_tokens: 0,
  }));
});

it('serves subscription embeddings with unknown pricing and records a qualified unknown cost', async () => {
  mockBillingMode.mockResolvedValue('subscription');
  mockCost.mockResolvedValue({
    original_cost_microcents: 10,
    actual_cost_microcents: 0,
    actual_cost_known: false,
    savings_microcents: 0,
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: [{ embedding: [0.1], index: 0 }], usage: { prompt_tokens: 3, total_tokens: 3 } }),
  }));
  const out = makeRes();

  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: 'hi' }), out.res);

  expect(out.statusCode).toBe(200);
  expect(mockUnknownHold).not.toHaveBeenCalled();
  expect(logSpy).toHaveBeenCalledTimes(1);
  expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
    status_code: 200, actual_cost_microcents: 0, actual_cost_known: false, savings_microcents: 0, total_tokens: 3,
  }));
});

it('releases a credit reservation for a pre-dispatch embedding adapter rejection', async () => {
  mockBillingMode.mockResolvedValue('credits');
  const fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  const out = makeRes();

  await handleEmbeddingsRequest(
    makeReq({ model: 'text-embedding-004', input: 'hi', dimensions: 256 }),
    out.res,
  );

  expect(out.statusCode).toBe(400);
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(mockUnknownHold).not.toHaveBeenCalled();
  expect(mockSettle).toHaveBeenCalledWith(
    'team_a', 1, 0, 0, expect.any(String), 'text-embedding-004 embedding (reservation released)',
  );
  expect(logSpy).not.toHaveBeenCalled();
});

it('bills batch embeddings by raw char count, not JSON.stringify length, when the provider omits usage', async () => {
  // Gemini-style: upstream omits token usage, so billing falls back to a char/4
  // estimate. It must count the raw input characters (8 -> ceil(8/4)=2), NOT
  // JSON.stringify(['aaaa','bbbb']).length (15 -> ceil(15/4)=4) which adds
  // quotes/commas/brackets and over-charges batch arrays.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      data: [{ embedding: [0.1], index: 0 }, { embedding: [0.2], index: 1 }],
      usage: {},
    }),
  }));
  const out = makeRes();
  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: ['aaaa', 'bbbb'] }), out.res);
  expect(out.statusCode).toBe(200);
  expect(JSON.parse(out.body).usage).toEqual({ prompt_tokens: 2, total_tokens: 2 });
  const costUsage = mockCost.mock.calls[0]?.[4] as { input_tokens?: number };
  expect(costUsage.input_tokens).toBe(2);
});

it('does not send embeddings success when final credit deduction fails', async () => {
  mockBillingMode.mockResolvedValue('credits');
  mockSettle.mockResolvedValueOnce({ success: false, newBalance: 7, amountDeducted: 1 });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ embedding: [0.1], index: 0 }], usage: { prompt_tokens: 3, total_tokens: 3 } }) }));
  const out = makeRes();

  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: 'hi' }), out.res);

  expect(out.statusCode).toBe(402);
  expect(JSON.parse(out.body)).toEqual({ error: { message: 'Insufficient credits', code: 'credit_deduction_failed' } });
  expect(mockDeduct).not.toHaveBeenCalled();
  expect(logSpy).not.toHaveBeenCalledWith(expect.objectContaining({ status_code: 200 }));
  // Provider work already completed at a known cost. Retain the durable
  // reservation for reconciliation; a second zero-cost settlement would
  // manufacture a refund for known spend.
  expect(mockSettle).toHaveBeenCalledTimes(1);
  expect(mockUnknownHold).not.toHaveBeenCalled();
  expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
    status_code: 402, error_type: 'credit_deduction_failed', actual_cost_microcents: 1, actual_cost_known: true,
  }));
});

it('logs known provider spend when exact embedding settlement is unavailable', async () => {
  mockBillingMode.mockResolvedValue('credits');
  mockSettle.mockRejectedValueOnce(new Error('credit database unavailable'));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: [{ embedding: [0.1], index: 0 }], usage: { prompt_tokens: 3, total_tokens: 3 } }),
  }));
  const out = makeRes();

  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-3-small', input: 'hi' }), out.res);

  expect(out.statusCode).toBe(503);
  expect(logSpy).toHaveBeenCalledTimes(1);
  expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
    status_code: 503, error_type: 'credit_deduction_unavailable',
    actual_cost_microcents: 1, actual_cost_known: true, savings_microcents: 0, total_tokens: 3,
  }));
  expect(mockUnknownHold).not.toHaveBeenCalled();
  expect(mockSettle).toHaveBeenCalledTimes(1);
  expect(mockSettle).toHaveBeenCalledWith(
    'team_a', 1, 1, 0, expect.any(String), 'text-embedding-3-small embedding (3 tokens)',
  );
});

it.each([
  { dimensions: 256 },
  { encoding_format: 'base64' },
])('400s unsupported Gemini embedding options %#', async (extra) => {
  const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy);
  const out = makeRes();
  await handleEmbeddingsRequest(makeReq({ model: 'text-embedding-004', input: 'hi', ...extra }), out.res);
  expect(out.statusCode).toBe(400);
  expect(JSON.parse(out.body).error.message).toBe('encoding_format/dimensions/user are not supported for this model');
  expect(fetchSpy).not.toHaveBeenCalled();
});
