import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MODEL_REGISTRY, PROVIDERS_WITHOUT_RUNTIME_ADAPTER } from '@routeshift/shared';
import { resolveProvider, estimateMessageTokens } from './proxy-handler.js';

const mockSessionsWindowQuery = vi.fn();
vi.mock('./db/pool.js', () => ({
  getPool: () => ({ query: mockSessionsWindowQuery }),
}));

import { handleSessionsWindow } from './admin/sessions.js';

const repoRoot = join(__dirname, '..', '..', '..');
const read = (path: string) => readFileSync(join(repoRoot, path), 'utf8');

function makeSessionsWindowReq(url: string): IncomingMessage {
  return { url, headers: {}, method: 'GET' } as unknown as IncomingMessage;
}

function makeSessionsWindowResponse(): {
  res: ServerResponse;
  captured: { statusCode: number; body: string };
} {
  const captured = { statusCode: 0, body: '' };
  return {
    res: {
      writeHead: (status: number) => { captured.statusCode = status; },
      end: (body?: string) => { captured.body = body ?? ''; },
    } as unknown as ServerResponse,
    captured,
  };
}

describe('audit finding regressions', () => {
  it('AXI-1 sessions-window scopes every query to a concrete team_id', async () => {
    const missing = makeSessionsWindowResponse();
    await handleSessionsWindow(
      makeSessionsWindowReq('/admin/sessions/window?from=2026-04-29T00:00:00Z&to=2026-04-29T23:59:59Z'),
      missing.res,
    );
    expect(missing.captured.statusCode).toBe(400);

    const wildcard = makeSessionsWindowResponse();
    await handleSessionsWindow(
      makeSessionsWindowReq('/admin/sessions/window?from=2026-04-29T00:00:00Z&to=2026-04-29T23:59:59Z&team_id=*'),
      wildcard.res,
    );
    expect(wildcard.captured.statusCode).toBe(400);

    mockSessionsWindowQuery.mockResolvedValueOnce({ rows: [] });
    const scoped = makeSessionsWindowResponse();
    await handleSessionsWindow(
      makeSessionsWindowReq('/admin/sessions/window?from=2026-04-29T00:00:00Z&to=2026-04-29T23:59:59Z&team_id=team_1'),
      scoped.res,
    );
    const [sql, params] = mockSessionsWindowQuery.mock.calls[0];
    expect(sql).toMatch(/team_id = \$3/);
    expect(params[2]).toBe('team_1');
  });

  it('routes exact GPT 5.4/5.5 canonical models with the provider declared by shared registry', () => {
    for (const model of ['gpt-5.4', 'gpt-5.5']) {
      const definition = MODEL_REGISTRY.find((entry) => entry.canonical_name === model);
      expect(definition?.provider).toBe('openai');
      expect(resolveProvider(model)).toBe(definition?.provider);
    }
  });

  it('keeps Cloudflare GLM-5.3 and NeuralWatt GLM-5.2 route identities separate', () => {
    expect(resolveProvider('@cf/zai-org/glm-5.3-flash')).toBe('cloudflare-workers-ai');
    expect(resolveProvider('glm-5.2')).toBe('neuralwatt');
    expect(resolveProvider('glm-5.2-fast')).toBe('neuralwatt');
  });

  it('estimateMessageTokens applies one char/4 heuristic across the TPM/routing/stream paths', () => {
    // The three call sites (per-key+team TPM reserve, routing estimated_input_tokens,
    // streaming under-report fallback) previously inlined three byte-identical reduces.
    // Lock the shared contract so a future edit can't let them silently diverge.
    expect(estimateMessageTokens(undefined)).toBe(0);
    expect(estimateMessageTokens([])).toBe(0);
    // ceil(len/4): 8 -> 2, 9 -> 3 (rounds up).
    expect(estimateMessageTokens([{ content: 'abcdefgh' }])).toBe(2);
    expect(estimateMessageTokens([{ content: 'abcdefghi' }])).toBe(3);
    // Counts text parts as well as strings; image-only parts remain 0.
    expect(
      estimateMessageTokens([
        { content: 'abcdefgh' }, // 2
        { content: [{ type: 'image_url' }] }, // 0 (non-string)
        {}, // 0 (absent)
        { content: 'abcd' }, // 1
      ]),
    ).toBe(3);

    // The handler must delegate all content shapes to one shared estimator so
    // raw/parsed file content cannot diverge across TPM and routing checks.
    const source = read('apps/proxy/src/proxy-handler.ts');
    expect(source).toContain('sum + estimateContentTokens(message?.content)');
    expect(source.split('function estimateContentTokens(').length - 1).toBe(1);
  });

  it('fallback-exhausted paths still log the distinct fallback_exhausted error_type', () => {
    // logFallbackExhaustedRequest was a field-for-field subset of
    // logTerminalFailureRequest; it was removed and its 3 call sites (circuit-open,
    // network error, retryable HTTP) now go through the shared helper. Preserve the
    // exact-reason invariant (AGENTS.md: never collapse skip/fallback/error reasons)
    // so the consolidation can't silently drop the 'fallback_exhausted' label.
    const source = read('apps/proxy/src/proxy-handler.ts');
    expect(source).not.toContain('function logFallbackExhaustedRequest');
    const fallbackErrorSites = source.split("errorType: 'fallback_exhausted'").length - 1;
    expect(fallbackErrorSites).toBe(3);
  });

  it('chat budget checks fail closed instead of swallowing budget-service errors', () => {
    const source = read('apps/proxy/src/proxy-handler.ts');
    // RSH-138: chat admission goes through the transactional reservation
    // lifecycle; reservation/database failures keep the 503 contract.
    expect(source).toContain('reserveBudget({');
    expect(source).toContain("request_kind: 'chat'");
    expect(source).toContain("message: 'Budget service unavailable'");
    expect(source).toContain('estimateChatBudget');
    expect(source).not.toContain('checkTeamBudget(teamId).catch(() => null)');
    expect(source).not.toContain('checkKeyBudget(teamId, keyInfo.id).catch(() => null)');
    expect(source).not.toContain('Promise.allSettled([\n    checkTeamBudget(teamId),');
  });

  it('cost exports and budget surfaces never present unknown provider spend as exact', () => {
    for (const path of [
      'apps/proxy/src/usage/monthly.ts',
      'apps/proxy/src/usage/savings.ts',
      'apps/proxy/src/usage/savings-series.ts',
      'apps/proxy/src/usage/by-model-day.ts',
      'apps/proxy/src/usage/by-identity.ts',
    ]) {
      const source = read(path);
      expect(source).toContain('unknown_cost_requests');
      expect(source).toContain('actual_costs_qualified');
      expect(source).toContain('actual_cost_known');
    }
    expect(read('apps/proxy/src/usage/monthly.ts'))
      .toContain('countIf(actual_cost_known = 0)');
    // RSH-138: the reservation ledger holds unresolved spend in
    // unknown_held_microcents with a recorded lower bound, never exact zero.
    const ledger = read('apps/proxy/src/billing/budget-reservations.ts');
    expect(ledger).toContain('unknown_cost_requests');
    expect(ledger).toContain('actual_cost_known');
    expect(ledger).toContain('unknown_held_microcents');
    expect(ledger).toContain('known_lower_bound_microcents');
    // The pure report serializer surfaces qualification to the dashboard.
    expect(read('packages/shared/src/budget-report.ts')).toContain('actualCostsQualified');
  });

  it('embeddings do not fall back to platform keys when a team provider key decrypt fails', () => {
    const source = read('apps/proxy/src/embeddings/handler.ts');
    expect(source).toContain("code: 'provider_key_decrypt_failed'");
    expect(source).toContain("Provider key for ${providerId} could not be decrypted");
    expect(source).not.toContain('apiKey = getPlatformEmbeddingKey(providerId);\n      if (!apiKey)');
  });

  it('adds a migration converting lingering tenant-scoped uuid team_id columns to text', () => {
    const migration = read('apps/proxy/src/db/migrations/037-team-id-text-consistency.sql');
    for (const table of ['model_aliases', 'team_budgets', 'team_provider_strategies', 'optimize_findings']) {
      expect(migration).toContain(`ALTER TABLE ${table}`);
      expect(migration).toContain('ALTER COLUMN team_id TYPE text USING team_id::text');
    }
  });

  it('session metrics and yield persistence are tenant-scoped by team_id plus session_id', () => {
    const migration = read('apps/proxy/src/db/migrations/038-session-metrics-tenant-scoped.sql');
    const aggregator = read('apps/proxy/src/observability/session-aggregator.ts');
    const correlator = read('apps/proxy/src/observability/yield-correlator.ts');

    expect(migration).toContain('PRIMARY KEY (team_id, session_id)');
    expect(migration).toContain('FOREIGN KEY (team_id, session_id)');
    expect(aggregator).toContain('LEFT JOIN session_metrics m ON m.team_id = r.team_id AND m.session_id = r.session_id');
    expect(aggregator).toContain('ON CONFLICT (team_id, session_id) DO UPDATE SET');
    expect(correlator).toContain('LEFT JOIN session_yield y ON y.team_id = m.team_id AND y.session_id = m.session_id');
    expect(correlator).toContain('ON CONFLICT (team_id, session_id) DO UPDATE SET');
  });

  it('gives every background job a distinct pg advisory lock id (no boot-race starvation)', () => {
    // optimize + yield-correlator both took pg_try_advisory_xact_lock(3). They
    // schedule their first run 30s after boot back-to-back, so the yield
    // correlator won the lock and optimize's failed try-lock rolled back —
    // skipping the first optimize scan for the full ~24h interval after every
    // deploy. Lock the ids apart so a future job can't silently collide again.
    const lockFiles = [
      'apps/proxy/src/observability/session-aggregator.ts',
      'apps/proxy/src/observability/yield-correlator.ts',
      'apps/proxy/src/oauth/orphan-key-sweeper.ts',
      'apps/proxy/src/optimize/engine.ts',
      'apps/proxy/src/oauth/sso-sweeper.ts',
    ];
    const ids = lockFiles.map((path) => {
      const match = read(path).match(/const \w*_LOCK_ID\s*=\s*(\d+)/);
      expect(match).not.toBeNull();
      return Number(match![1]);
    });
    // All five ids must be distinct.
    expect(new Set(ids).size).toBe(ids.length);
    // Specifically the collision that existed: optimize (last) vs yield correlator (second).
    expect(ids[3]).not.toBe(ids[1]);
  });

  it('translates tools AND structured output (response_format) for google instead of rejecting them', () => {
    // gemini.ts now translates tools/tool_choice, inbound functionCall/
    // functionResponse turns, AND response_format (structured output) via Gemini's
    // JSON-Schema-native fields. The capability guard that hard-rejected
    // response_format for google must therefore be gone — silently dropping the
    // contract is no longer the risk, because the adapter honors it.
    const gemini = read('apps/proxy/src/providers/gemini.ts');
    expect(gemini).toContain('functionDeclarations');
    expect(gemini).toContain('functionResponse');
    // Tool parameters use Gemini's lossless JSON-Schema field, not the OpenAPI
    // subset that 400s on additionalProperties/$ref.
    expect(gemini).toContain('parametersJsonSchema');
    // Structured output is translated: responseMimeType + responseJsonSchema.
    expect(gemini).toContain('responseMimeType');
    expect(gemini).toContain('responseJsonSchema');

    const handler = read('apps/proxy/src/proxy-handler.ts');
    // The google-only response_format capability guard is removed; response_format
    // is no longer rejected for google.
    expect(handler).not.toContain("unsupportedCaps.push('response_format')");
    expect(handler).not.toContain('responseFormatType');
  });

  it('parked (public:false) models never resolve to an unregistered runtime provider', () => {
    // meta/xai/deepseek/mistral are priced for planning but have no registered
    // provider adapter. Resolving an exact parked model to them makes a plain
    // request 400 "Unknown provider". They must fall through to a REGISTERED
    // provider or to '' (clean unknown-model error).
    // Single source: packages/shared/src/models.ts. When an adapter lands,
    // the provider leaves this set and this guard follows automatically.
    const UNREGISTERED = new Set<string>(PROVIDERS_WITHOUT_RUNTIME_ADAPTER);
    const parked = MODEL_REGISTRY.filter((m) => m.public === false);
    expect(parked.length).toBeGreaterThan(0);
    for (const m of parked) {
      expect(UNREGISTERED.has(resolveProvider(m.canonical_name))).toBe(false);
    }
    // Retired hosted Llama endpoints must not be resurrected from process env.
    process.env.TOGETHER_API_KEY = 'must-not-affect-pure-routing';
    expect(resolveProvider('llama-3.1-70b')).toBe('');
    delete process.env.TOGETHER_API_KEY;
    expect(resolveProvider('llama-3.1-70b')).toBe('');
    expect(resolveProvider('llama-4-maverick')).toBe('');
  });

  it('never caches a fallback response under the primary cache key (poisoning guard)', () => {
    // cacheKey is built from the PRIMARY provider/model; storing a fallback's
    // output under it would replay the degraded result for later healthy primary
    // requests. The cache `set` must be gated on `!is_fallback`.
    const source = read('apps/proxy/src/proxy-handler.ts');
    expect(source).toContain('if (!is_fallback) {');
    expect(source).not.toContain('if (cacheKey) {\n      responseCache.set(');
  });

  it('insufficient-credit preflight 402s re-arm the auto-topup queue so a low-balance team is not stranded', () => {
    // The auto-topup worker deletes a queue row before charging; on a transient
    // Stripe failure the row is gone, and the queue is otherwise only refilled by
    // a *successful* deduction — which a stranded low-balance team can't produce.
    // Each preflight 402 must therefore re-enqueue (idempotently) on the way out.
    // Keyed on `preflight.balance` to distinguish from the post-deduction calls.
    const chat = read('apps/proxy/src/proxy-handler.ts');
    const embeddings = read('apps/proxy/src/embeddings/handler.ts');
    expect(chat).toContain('checkAutoTopUpNeeded(teamId, preflight.balance)');
    expect(embeddings).toContain('checkAutoTopUpNeeded(teamId, preflight.balance)');
  });

  it('the live key-audit cursor validates a real date + uuid before the SQL cast', () => {
    // A syntactically-string-but-invalid cursor value (e.g. created_at:'nope')
    // passed the typeof check and made Postgres ::timestamptz/::uuid throw → 500.
    // Validate before binding so a malformed cursor is simply ignored.
    const source = read('apps/proxy/src/admin/keys.ts');
    expect(source).toContain('Number.isNaN(Date.parse(decoded.created_at))');
    expect(source).toContain('UUID_PATH_SEGMENT_RE.test(decoded.id)');
  });

  it('AXI-7: the UUID path-segment regex is declared once and shared, not duplicated', () => {
    // The scoped-admin gate (admin/auth.ts) and the key handlers (admin/keys.ts)
    // must agree byte-for-byte on what a canonical UUID path segment is. If the
    // copies ever drift, the gate could accept a keyId the handler rejects (or
    // vice versa) with no test catching it. Single source of truth: auth.ts
    // exports it; keys.ts imports it.
    const auth = read('apps/proxy/src/admin/auth.ts');
    const keys = read('apps/proxy/src/admin/keys.ts');
    expect(auth).toContain('export const UUID_PATH_SEGMENT_RE =');
    expect(keys).toContain("import { UUID_PATH_SEGMENT_RE } from './auth.js'");
    // keys.ts must not re-declare its own copy of the regex literal.
    expect(keys).not.toMatch(/^const UUID_RE =/m);
  });

  // ─── RSH-85 shadow-routing invariants ──────────────────────────────────────

  it('RSH-85 shadow admin API is disabled by default (env-gated, not opt-out)', () => {
    const source = read('apps/proxy/src/admin/shadow-experiments.ts');
    // The gate must be an explicit opt-IN: === 'true', not !== 'false'.
    expect(source).toContain("process.env.SHADOW_ROUTING_ENABLED === 'true'");
    // Every handler entry must check the gate before touching the DB.
    expect(source).toContain("error(res, 404, 'Shadow routing is not enabled', 'shadow_routing_disabled')");
  });

  it('RSH-85 shadow_experiments uses TEXT tenant IDs and composite PK (not uuid)', () => {
    const migration = read('apps/proxy/src/db/migrations/050-shadow-experiments.sql');
    expect(migration).not.toMatch(/team_id\s+uuid/i);
    const experimentTable = migration.match(/CREATE TABLE IF NOT EXISTS shadow_experiments \(([\s\S]*?)\n\);/);
    expect(experimentTable).not.toBeNull();
    const definition = experimentTable![1];
    // team_id must be TEXT, never uuid (RouteShift tenant-id invariant).
    expect(definition).toContain('team_id       TEXT NOT NULL');
    expect(definition).not.toMatch(/team_id\s+uuid/i);
    // Composite PK so shadow_runs FK can reference (team_id, id).
    expect(definition).toContain('PRIMARY KEY (team_id, id)');
    // funding_mode is constrained to platform_funded in v1.
    expect(definition).toContain("CHECK (funding_mode = 'platform_funded')");
  });

  it('RSH-85 schema removes implicit execution/spend defaults and quarantines legacy invalid bounds', () => {
    const migration = read('apps/proxy/src/db/migrations/052-shadow-experiment-bound-contract.sql');
    for (const column of [
      'max_samples', 'deadline_ms', 'max_concurrency', 'max_queue_count',
      'max_queue_bytes', 'max_payload_bytes', 'per_run_cap_microcents',
      'aggregate_cap_microcents',
    ]) {
      expect(migration).toContain(`ALTER COLUMN ${column} DROP DEFAULT`);
    }
    expect(migration).toContain('shadow_experiments_bound_contract');
    expect(migration).toContain('NOT VALID');
    expect(migration).not.toContain('VALIDATE CONSTRAINT shadow_experiments_bound_contract');
    expect(migration).toContain("disabled_reason = COALESCE(disabled_reason, 'invalid_execution_bound_contract')");
    expect(migration).toContain('aggregate_cap_microcents >= per_run_cap_microcents');
    expect(migration).toContain("relation.oid = 'shadow_experiments'::regclass");
    expect(migration).toContain('shadow_experiments_enablement_consent_contract');
    expect(migration).toContain('NOT enabled OR (');
    expect(migration).toContain('approved_by IS NOT NULL');
    expect(migration).toContain('btrim(approved_by) <> \'\'');
    expect(migration).toContain("'missing_enablement_consent_contract'");
    expect(migration).toContain('WHERE enabled');
    expect(migration).toContain('NOT COALESCE(');
    const boundQuarantine = migration.indexOf("disabled_reason = COALESCE(disabled_reason, 'invalid_execution_bound_contract')");
    const consentQuarantine = migration.indexOf("disabled_reason = 'missing_enablement_consent_contract'");
    expect(boundQuarantine).toBeGreaterThan(-1);
    expect(consentQuarantine).toBeGreaterThan(boundQuarantine);
    expect(migration).not.toMatch(/team_id\s+uuid/i);
  });

  it('RSH-85 sampling uses canonical length-prefix encoding, not string concatenation', () => {
    const source = read('packages/shared/src/shadow-routing.ts');
    // The HMAC message must use canonicalEncode (length-prefixed), not naive concat.
    expect(source).toContain('canonicalEncode(');
    expect(source).toContain('writeUInt32BE(utf8.length');
    // Must NOT use simple string concatenation for the HMAC message.
    expect(source).not.toMatch(/createHmac.*\+\s*input\./);
  });

  it('RSH-85 eligibility checks opt-out before experiment state (precedence invariant)', () => {
    const source = read('packages/shared/src/shadow-routing.ts');
    // In evaluateShadowEligibility, opt-out checks must appear before time-window checks.
    const optOutPos = source.indexOf('shadow_request_opted_out');
    const timePos = source.indexOf('shadow_experiment_not_started');
    expect(optOutPos).toBeGreaterThan(-1);
    expect(timePos).toBeGreaterThan(-1);
    expect(optOutPos).toBeLessThan(timePos);
  });
});
