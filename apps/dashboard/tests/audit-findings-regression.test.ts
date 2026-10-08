import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  authSession: { user: { teamId: 'real_team' } },
  member: { userId: 'user_1', teamId: 'real_team', role: 'admin' },
  query: vi.fn(),
  fetch: vi.fn(),
  cookieValue: undefined as string | undefined,
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'rs_demo' && h.cookieValue !== undefined ? { value: h.cookieValue } : undefined,
  }),
}));

vi.mock('@/lib/auth', () => ({ auth: async () => h.authSession }));
vi.mock('@/lib/rbac', () => ({
  requireRole: async () => h.member,
  requireTeamMembership: async () => h.member,
}));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: h.query }) }));
vi.mock('@/lib/proxy', () => ({
  PROXY_URL: 'https://proxy.test',
  adminHeaders: (extra: Record<string, string> = {}) => ({ ...extra, Authorization: 'Bearer admin' }),
  assertAdminSecret: () => undefined,
}));

import { DEMO_TEAM_ID } from '@/lib/demo';
import { GET as usageGET } from '@/app/api/metrics/usage/route';
import { GET as savingsGET } from '@/app/api/metrics/savings/route';
import { GET as overviewGET } from '@/app/api/metrics/overview/route';
import { GET as oneShotGET } from '@/app/api/usage/one-shot/route';
import { POST as autoRoutePOST } from '@/app/api/auto-route/route';
import { GET as logsGET } from '@/app/api/logs/route';
import { POST as keysPOST } from '@/app/api/keys/route';
import { POST as rulesPOST } from '@/app/api/rules/route';
import { GET as keyAuditGET } from '@/app/api/keys/[id]/audit/route';

const repoRoot = join(__dirname, '..', '..', '..');
const read = (path: string) => readFileSync(join(repoRoot, path), 'utf8');

beforeEach(() => {
  h.query.mockReset();
  h.fetch.mockReset();
  h.cookieValue = undefined;
  vi.stubGlobal('fetch', h.fetch as unknown as typeof fetch);
  h.fetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubEnv('DEMO_MODE_ENABLED', '1');
});

describe('dashboard audit finding regressions', () => {
  it.each([
    ['usage', usageGET],
    ['savings', savingsGET],
    ['overview', overviewGET],
  ])('legacy %s metrics route uses demo team substitution for all team-scoped reads', async (_name, handler) => {
    h.cookieValue = '1';
    h.query.mockResolvedValue({
      rows: [{
        total_requests: 0,
        total_tokens: 0,
        avg_latency_ms: 0,
        p95_latency_ms: 0,
        p99_latency_ms: 0,
        models_used: 0,
        total_original_microcents: 0,
        total_actual_microcents: 0,
        total_savings_microcents: 0,
        total_cost_microcents: 0,
        error_rate: 0,
        count: 0,
        hour: new Date('2026-06-01T00:00:00Z'),
        requests: 0,
        model_resolved: 'gpt-5.5',
      }],
      rowCount: 1,
    });

    await handler(new Request('https://app.test/api/metrics/usage?period=24h'));

    expect(h.query.mock.calls.length).toBeGreaterThan(0);
    for (const call of h.query.mock.calls) {
      const params = (call[1] ?? []) as unknown[];
      expect(params[0]).toBe(DEMO_TEAM_ID);
      expect(params).not.toContain('real_team');
    }
  });

  it('usage metrics expose billed spend separately from routing-only actual cost', async () => {
    h.query
      .mockResolvedValueOnce({
        rows: [{
          total_requests: 2,
          total_tokens: 150,
          avg_latency_ms: 100,
          p95_latency_ms: 120,
          p99_latency_ms: 140,
          models_used: 0,
          actual_routing_cost_microcents: 300,
          billed_spend_microcents: 420,
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await usageGET(new Request('https://app.test/api/metrics/usage?period=24h'));
    expect(res.status).toBe(200);
    expect((await res.json()).summary).toMatchObject({
      actual_routing_cost_microcents: 300,
      billed_spend_microcents: 420,
    });
    expect(h.query.mock.calls.map((call) => String(call[0])).join('\n'))
      .toContain('actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)');
  });

  it('savings metrics expose billed plugin-inclusive spend without redefining routing savings', async () => {
    h.query
      .mockResolvedValueOnce({
        rows: [{
          total_original_microcents: 1_000_000_000,
          total_actual_microcents: 300_000_000,
          total_billed_spend_microcents: 420_000_000,
          total_savings_microcents: 700_000_000,
          total_requests: 2,
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await savingsGET(new Request('https://app.test/api/metrics/savings?period=24h'));
    expect(res.status).toBe(200);
    expect((await res.json()).summary).toMatchObject({
      actual_routing_cost_usd: 3,
      billed_spend_usd: 4.2,
      routing_savings_usd: 7,
    });
    expect(h.query.mock.calls.map((call) => String(call[0])).join('\n'))
      .toContain('actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)');
  });

  it('dashboard auto-route writes report partial success when proxy cache invalidation fails after commit', async () => {
    h.query.mockResolvedValue({ rows: [], rowCount: 1 });
    h.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'stale' }), { status: 503 }));

    const res = await autoRoutePOST(new Request('https://app.test/api/auto-route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, strategy: 'fastest', max_fallbacks: 1 }),
    }));

    expect(h.fetch).toHaveBeenCalledWith('https://proxy.test/admin/auto-route/invalidate', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ team_id: 'real_team' }),
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      enabled: true,
      strategy: 'fastest',
      max_fallbacks: 1,
      quality_derank: false,
      proxy_cache_invalidated: false,
      proxy_cache_error: 'proxy_cache_invalidation_failed',
      cache_ttl_seconds: 30,
    });
  });

  it('dashboard auto-route rejects malformed fallback settings before database or proxy writes', async () => {
    const res = await autoRoutePOST(new Request('https://app.test/api/auto-route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, strategy: 'balanced', max_fallbacks: 'many' }),
    }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'max_fallbacks must be an integer between 0 and 5' });
    expect(h.query).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('activity logs preserve exact fallback errors and plugin warning reasons for expanded rows', async () => {
    h.query
      .mockResolvedValueOnce({ rows: [{ total: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          id: 'req_1',
          timestamp: new Date('2026-06-05T12:00:00Z'),
          provider: 'openai',
          model_requested: 'gpt-5.5',
          model_resolved: 'gpt-5.5-mini',
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
          original_cost_microcents: 900,
          actual_cost_microcents: 300,
          actual_cost_known: false,
          plugin_cost_microcents: 120,
          billed_cost_microcents: 420,
          savings_microcents: 600,
          total_latency_ms: 1234,
          ttft_ms: 120,
          is_streaming: true,
          is_fallback: true,
          fallback_attempts: JSON.stringify([
            { provider: 'anthropic', model: 'claude-sonnet-4-5', error: 'provider_timeout: upstream took 30s' },
          ]),
          plugin_warnings: JSON.stringify([
            {
              plugin: 'web',
              code: 'optional_plugin_skipped',
              reason: 'plugin_backend_unconfigured',
              message: 'Web plugin skipped because no backend is configured.',
            },
          ]),
          status_code: 200,
          error_type: null,
          cache_hit: false,
          activity_category: 'coding',
          session_id: 'sess_1',
          api_key_id: 'key_1',
        }],
        rowCount: 1,
      });

    const res = await logsGET(new Request('https://app.test/api/logs?page=1&limit=50'));
    const body = await res.json();

    expect(body.logs[0].fallback_attempts[0]).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      error: 'provider_timeout: upstream took 30s',
    });
    expect(body.logs[0].plugin_warnings[0]).toEqual({
      plugin: 'web',
      code: 'optional_plugin_skipped',
      reason: 'plugin_backend_unconfigured',
      message: 'Web plugin skipped because no backend is configured.',
    });
    expect(body.logs[0].api_key_id).toBe('key_1');
    expect(body.logs[0].actual_cost_microcents).toBe(300);
    expect(body.logs[0].actual_cost_known).toBe(false);
    expect(body.logs[0].plugin_cost_microcents).toBe(120);
    expect(body.logs[0].billed_cost_microcents).toBe(420);

    const sql = h.query.mock.calls.map((call) => String(call[0])).join('\n');
    expect(sql).toContain('actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)');
  });

  it('activity logs preserve per-attempt cost certainty and exact quality reason codes (RSH-154)', async () => {
    h.query
      .mockResolvedValueOnce({ rows: [{ total: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          id: 'req_cascade',
          timestamp: new Date('2026-08-01T12:00:00Z'),
          provider: 'openai',
          model_requested: 'gpt-5.5-pro',
          model_resolved: 'gpt-5.5',
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
          original_cost_microcents: 900,
          actual_cost_microcents: 1_200,
          actual_cost_known: true,
          plugin_cost_microcents: 0,
          billed_cost_microcents: 1_200,
          savings_microcents: 0,
          total_latency_ms: 7_400,
          ttft_ms: null,
          is_streaming: false,
          is_fallback: true,
          fallback_attempts: JSON.stringify([
            { provider: 'openai', model: 'gpt-5.5-pro', error: 'quality_gate_empty_content', actual_cost_known: true },
            { provider: 'anthropic', model: 'claude-sonnet-4-6', error: 'HTTP 503', actual_cost_known: false },
            { provider: 'google', model: 'gemini-3-pro', error: 'Circuit breaker open' },
            { model: 'missing-provider', error: 'malformed row' },
          ]),
          plugin_warnings: '[]',
          status_code: 200,
          error_type: null,
          cache_hit: false,
          activity_category: 'coding',
          session_id: 'sess_cascade',
          api_key_id: 'key_1',
        }],
        rowCount: 1,
      });

    const res = await logsGET(new Request('https://app.test/api/logs?page=1&limit=50'));
    const body = await res.json();
    const attempts = body.logs[0].fallback_attempts;

    expect(attempts).toEqual([
      { provider: 'openai', model: 'gpt-5.5-pro', error: 'quality_gate_empty_content', actual_cost_known: true },
      { provider: 'anthropic', model: 'claude-sonnet-4-6', error: 'HTTP 503', actual_cost_known: false },
      { provider: 'google', model: 'gemini-3-pro', error: 'Circuit breaker open' },
    ]);
    expect(body.logs[0].error_type).toBeNull();
  });

  it('dashboard rule creation forwards action.quality_gate verbatim so the proxy write-gate decides (RSH-154)', async () => {
    const gate = {
      version: 1,
      mode: 'cascade',
      on_stream: 'reject',
      unknown_signal: 'reject',
      multi_attempt_billing_ack: true,
      checks: [{ type: 'stop_reason', reject: ['max_tokens'] }],
    };
    h.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 201 }));

    const res = await rulesPOST(new Request('https://app.test/api/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Gated route',
        priority: 100,
        action: { type: 'route', target_provider: 'openai', quality_gate: gate },
      }),
    }));

    expect(res.status).toBe(201);
    const requestBody = JSON.parse((h.fetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(requestBody.action.quality_gate).toEqual(gate);
    expect(requestBody.team_id).toBe('real_team');
  });

  it('quality-gate consent can never be acquired by omission (RSH-134 §6 Q1 / RSH-154)', async () => {
    // Behavioral: the default draft is unacknowledged and the builder refuses it.
    const { buildQualityGateConfig, defaultQualityGateDraft, newCheckDraft } = await import(
      '@/components/routing/quality-gate-editor'
    );
    expect(defaultQualityGateDraft().billingAck).toBe(false);
    const unacknowledged = buildQualityGateConfig({
      ...defaultQualityGateDraft(),
      checks: [newCheckDraft('stop_reason')],
    });
    expect(unacknowledged.ok).toBe(false);

    // Wiring: the form attaches a gate only via the builder's accepted result,
    // and the editor ends on the same validator the proxy write-gate runs.
    // (The form lives in components/routing/rule-form.tsx, shared by the new
    // and edit surfaces.)
    const page = read('apps/dashboard/components/routing/rule-form.tsx');
    expect(page).toContain('buildQualityGateConfig(qualityGateDraft)');
    expect(page).toContain('action.quality_gate = gateResult.config');
    // Exactly ONE attachment path: a second route onto action.quality_gate
    // (template/duplicate flow) that skips the builder would add an occurrence.
    expect(page.match(/action\.quality_gate\s*=/g)).toHaveLength(1);
    const editor = read('apps/dashboard/components/routing/quality-gate-editor.tsx');
    expect(editor).toContain('validateQualityGateConfig(candidate)');
  });

  it('activity expanded rows keep exact cascade reason codes and never collapse them into labels (RSH-154)', () => {
    const source = read('apps/dashboard/app/(dashboard)/activity/activity-client.tsx');
    // The raw code is still rendered verbatim; the human label is additive.
    expect(source).toContain('{attempt.error}');
    expect(source).toContain('qualityReasonLabel(attempt.error)');
    // Invariant: the label is conditionally additive — the raw code always
    // renders and the label only beside it when one exists (never a `??`
    // substitution that would collapse codes into labels).
    expect(source).toContain('{reasonLabel && <span');
    // Header claims "quality" only when every attempt is quality-classified.
    expect(source).toContain('cascadeAttemptsHeader(log)');
    const reasons = read('apps/dashboard/lib/quality-reasons.ts');
    expect(reasons).toContain("'Quality Cascade Attempts'");
    expect(reasons).toContain("'Cascade Attempts'");
  });

  it('customer-facing spend queries include plugin charges while routing cost and savings stay explicit', () => {
    const routes = [
      'apps/dashboard/app/api/billing/by-key/route.ts',
      'apps/dashboard/app/api/billing/by-tag/route.ts',
      'apps/dashboard/app/api/logs/route.ts',
      'apps/dashboard/app/api/metrics/analytics/route.ts',
      'apps/dashboard/app/api/metrics/overview/route.ts',
      'apps/dashboard/app/api/metrics/savings/route.ts',
      'apps/dashboard/app/api/metrics/usage/route.ts',
      'apps/dashboard/app/api/models/compare/route.ts',
      'apps/dashboard/app/api/usage/token-tracker/route.ts',
    ];
    const activityLog = read('apps/dashboard/lib/activity-log.ts');
    expect(read('apps/dashboard/app/api/logs/route.ts')).toContain('ACTIVITY_LOG_SELECT');
    expect(activityLog).toMatch(/actual_cost_microcents\s*\+\s*COALESCE\(plugin_cost_microcents, 0\)/);
    for (const path of routes) {
      const source = path.endsWith('logs/route.ts') ? activityLog : read(path);
      expect(source).toMatch(/actual_cost_microcents\s*\+\s*COALESCE\((?:rl\.)?plugin_cost_microcents, 0\)/);
    }

    const overview = read('apps/dashboard/app/(dashboard)/overview/page.tsx');
    const usage = read('apps/dashboard/app/(dashboard)/usage/page.tsx');
    const savings = read('apps/dashboard/app/(dashboard)/savings/page.tsx');
    for (const source of [overview, usage, savings]) {
      expect(source).toMatch(/actual_cost_microcents\s*\+\s*COALESCE\(plugin_cost_microcents, 0\)/);
    }

    const activity = read('apps/dashboard/app/(dashboard)/activity/activity-client.tsx');
    const analytics = read('apps/dashboard/app/(dashboard)/analytics/analytics-client.tsx');
    const tokens = read('apps/dashboard/app/(dashboard)/tokens/token-tracker-client.tsx');
    expect(activity).toContain('Billed spend');
    expect(activity).toContain('Routing savings');
    expect(analytics).toContain('Billed spend includes plugin charges; routing cost and savings exclude them.');
    expect(tokens).toContain('Total Billed Spend');
    expect(overview).toContain('Total Billed Spend');
    expect(overview).toContain('Routing Savings');
    expect(usage).toContain('billed_spend_usd');
    expect(savings).toContain('Total Billed Spend');
    expect(savings).toContain('Routing Cost Over Time');
  });

  it('one-shot and model-comparison efficiency labels expose plugin-inclusive session cost as billed spend', async () => {
    h.query
      .mockResolvedValueOnce({
        rows: [{ sessions: 1, edit_turns: 4, retry_turns: 1 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{
          model: 'gpt-5.5', sessions: 1, edit_turns: 4, retry_turns: 1,
          billed_cost_microcents: 450,
        }],
        rowCount: 1,
      });

    const response = await oneShotGET(new Request('https://app.test/api/usage/one-shot?period=24h'));
    expect(response.status).toBe(200);
    expect((await response.json()).by_model[0]).toMatchObject({
      billed_cost_microcents: 450,
      billed_cost_per_successful_edit_microcents: 150,
      unknown_cost_requests: 0,
      actual_costs_qualified: true,
    });

    const compareRoute = read('apps/dashboard/app/api/models/compare/route.ts');
    const compareClient = read('apps/dashboard/app/(dashboard)/models/compare/compare-client.tsx');
    const analytics = read('apps/dashboard/app/(dashboard)/analytics/analytics-client.tsx');
    expect(compareRoute).toContain('billed_cost_per_successful_edit_microcents');
    expect(compareRoute).toContain('SUM(unknown_cost_requests)');
    expect(compareRoute).toContain('billed_cost_per_successful_edit_qualified');
    expect(compareClient).toContain('Billed $/successful edit');
    expect(compareClient).not.toContain('Routing $/successful edit');
    expect(compareClient).toContain('data.a.billed_cost_per_successful_edit_microcents');
    expect(analytics).toContain('Billed $/successful edit');
    expect(analytics).toContain('unknown_cost_requests');
    expect(analytics).toContain('oneShot.by_model.reduce');
    expect(analytics).toContain('CostQualificationNotice');
  });

  it('activity deep links filter request logs by api key instead of landing on an unfiltered feed', async () => {
    h.query
      .mockResolvedValueOnce({ rows: [{ total: 0 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await logsGET(new Request('https://app.test/api/logs?page=1&limit=50&api_key_id=key_abc'));

    const sql = h.query.mock.calls.map((call) => String(call[0])).join('\n');
    expect(sql).toContain('api_key_id = $');
    expect(h.query.mock.calls[0]![1]).toContain('key_abc');

    const pageSource = read('apps/dashboard/app/(dashboard)/activity/page.tsx');
    const clientSource = read('apps/dashboard/app/(dashboard)/activity/activity-client.tsx');
    expect(pageSource).toContain('parseActivityFilters(await searchParams)');
    expect(clientSource).toContain('initialFilters = {}');
    expect(clientSource).toContain('serializeActivityFilters');
    expect(clientSource).toContain('Key {apiKeyId.slice(0, 12)}');
  });

  it('activity expanded row renders plugin warning reason and exposes a keyboard-operable expand control', () => {
    const source = read('apps/dashboard/app/(dashboard)/activity/activity-client.tsx');
    expect(source).toContain('warning.reason');
    expect(source).toContain("aria-label={`${isExpanded ? 'Collapse' : 'Expand'} request ${log.id}`}");
    expect(source).toContain('event.stopPropagation()');
  });

  it('activity marks unknown historical costs as observed lower bounds without reconciliation language', () => {
    const activity = read('apps/dashboard/app/(dashboard)/activity/activity-client.tsx');
    const activityLog = read('apps/dashboard/lib/activity-log.ts');
    expect(activityLog).toContain('actual_cost_known');
    expect(`${activity}\n${activityLog}`).toContain('Observed lower bound:');
    const notice = read('apps/dashboard/components/cost-qualification-notice.tsx');
    expect(notice).toContain('unknown historical cost');
    expect(notice).not.toContain('pending reconciliation');
  });

  it('server-rendered dashboard savings surfaces clamp negative savings consistently with API routes', () => {
    for (const path of [
      'apps/dashboard/app/(dashboard)/overview/page.tsx',
      'apps/dashboard/app/(dashboard)/savings/page.tsx',
    ]) {
      const source = read(path);
      expect(source).toContain('SUM(GREATEST(savings_microcents, 0))');
    }
  });

  it('auto-route settings are visibly read-only for non-editors and surface load/save errors', () => {
    const pageSource = read('apps/dashboard/app/(dashboard)/routing/page.tsx');
    const componentSource = read('apps/dashboard/components/routing/auto-route-settings.tsx');
    expect(pageSource).toContain('canEdit={canManageRules}');
    expect(pageSource).toContain('Demo mode — auto-routing settings are read-only.');
    expect(componentSource).toContain('readOnlyReason');
    expect(componentSource).toContain('setError(extractAutoRouteError');
    expect(componentSource).toContain('proxy_cache_invalidated');
    expect(componentSource).toContain('disabled={disabled}');
  });

  it('auth entry forms keep visible contrast and browser-friendly input semantics', () => {
    const layout = read('apps/dashboard/app/(auth)/layout.tsx');
    // The page.tsx files are server wrappers (metadata + Suspense); the form
    // markup lives in the sibling client components.
    const login = read('apps/dashboard/app/(auth)/login/login-form.tsx');
    const register = read('apps/dashboard/app/(auth)/register/register-form.tsx');
    expect(layout).toContain('Back to home');
    for (const source of [login, register]) {
      expect(source).toContain('border-white/[0.14] bg-zinc-950/85');
      expect(source).toContain('role="alert"');
      expect(source).toContain('name="email"');
      expect(source).toContain('autoComplete="email"');
      expect(source).toContain('name="password"');
    }
    expect(login).toContain('autoComplete="current-password"');
    expect(register).toContain('autoComplete="new-password"');
    expect(register).toContain('autoComplete="organization"');
  });

  it('demo mode blocks direct settings and billing mutations instead of writing the live workspace', async () => {
    h.cookieValue = '1';

    const keyRes = await keysPOST(new Request('https://app.test/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Production' }),
    }));
    const ruleRes = await rulesPOST(new Request('https://app.test/api/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Route expensive traffic' }),
    }));

    expect(keyRes.status).toBe(403);
    expect(ruleRes.status).toBe(403);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('dashboard key creation injects session team and actor instead of trusting client body values', async () => {
    h.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 201 }));

    const res = await keysPOST(new Request('https://app.test/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Production', team_id: 'attacker_team' }),
    }));

    expect(res.status).toBe(201);
    expect(h.fetch).toHaveBeenCalledWith('https://proxy.test/admin/keys', expect.objectContaining({
      method: 'POST',
    }));
    const requestBody = JSON.parse((h.fetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(requestBody).toEqual({
      name: 'Production',
      team_id: 'real_team',
      actor_user_id: 'user_1',
    });
  });

  it('dashboard key creation rejects invalid JSON as a client error before proxy writes', async () => {
    const res = await keysPOST(new Request('https://app.test/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { message: 'Invalid JSON body' } });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('dashboard rule creation injects session team and preserves proxy error payload/status', async () => {
    h.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'exact proxy reason' } }), { status: 409 }));

    const res = await rulesPOST(new Request('https://app.test/api/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Route expensive traffic', team_id: 'attacker_team' }),
    }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { message: 'exact proxy reason' } });
    const requestBody = JSON.parse((h.fetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(requestBody.team_id).toBe('real_team');
  });

  it('per-key audit route encodes id and injects the trusted team_id, defeating cross-tenant query-param pollution (IDOR)', async () => {
    // A crafted id smuggles a victim team_id ahead of the trusted one so the
    // proxy (which reads the FIRST team_id) would scope to another tenant.
    const craftedId = 'victim_key/audit?team_id=victim_team&_=';

    await keyAuditGET(
      new Request('https://app.test/api/keys/x/audit?limit=50'),
      { params: Promise.resolve({ id: craftedId }) },
    );

    expect(h.fetch).toHaveBeenCalledTimes(1);
    const calledUrl = new URL(h.fetch.mock.calls[0]![0] as string);
    // The proxy will read the trusted team only — the injected victim never
    // appears as a query parameter at all.
    expect(calledUrl.searchParams.getAll('team_id')).toEqual(['real_team']);
    // The crafted id is confined to one percent-encoded path segment.
    expect(calledUrl.pathname).toBe(`/admin/keys/${encodeURIComponent(craftedId)}/audit`);
  });

  it('model-alias route treats non-2xx proxy invalidation as write failure instead of reporting success with stale proxy cache', () => {
    const source = read('apps/dashboard/app/api/model-aliases/route.ts');
    expect(source).toContain('if (!res.ok)');
    expect(source).toContain('proxy_cache_invalidation_failed');
  });

  it('model-alias UI checks DELETE res.ok and refetches on server-side failures', () => {
    const source = read('apps/dashboard/components/settings/model-aliases-section.tsx');
    expect(source).toContain('if (!res.ok)');
    expect(source).toContain('Failed to delete alias.');
    expect(source).toContain('void fetchAliases()');
  });

  it('production Stripe billing routes require an app URL instead of falling back to localhost', () => {
    const appOrigin = read('apps/dashboard/lib/app-origin.ts');
    const checkout = read('apps/dashboard/app/api/billing/checkout/route.ts');
    const portal = read('apps/dashboard/app/api/billing/portal/route.ts');
    const creditsPurchase = read('apps/dashboard/app/api/credits/purchase/route.ts');
    const invitations = read('apps/dashboard/app/api/invitations/route.ts');
    expect(appOrigin).toContain('NEXT_PUBLIC_APP_URL is required');
    expect(checkout).not.toContain("?? 'http://localhost:3000'");
    expect(portal).not.toContain("?? 'http://localhost:3000'");
    expect(creditsPurchase).not.toContain("?? 'http://localhost:3000'");
    expect(invitations).not.toContain("http://localhost:3000");
    expect(checkout).toContain('getRequiredAppOrigin');
    expect(portal).toContain('getRequiredAppOrigin');
    expect(creditsPurchase).toContain('getRequiredAppOrigin');
    expect(creditsPurchase).toContain("payment_intent_data: { metadata: { type: 'credits', team_id: teamId } }");
    expect(invitations).toContain('getRequiredAppOrigin');
  });

  it('billing status and auto-topup GET routes are read-only and do not sync draft payment methods', () => {
    const status = read('apps/dashboard/app/api/billing/status/route.ts');
    const autoTopup = read('apps/dashboard/app/api/credits/auto-topup/route.ts');
    expect(status).not.toContain('syncDraftAutoTopUpPaymentMethod');
    expect(autoTopup).not.toContain('syncDraftAutoTopUpPaymentMethod');
    expect(existsSync(join(repoRoot, 'apps/dashboard/lib/auto-topup.ts'))).toBe(false);
  });

  it('RSH-96 keeps public fee claims aligned with BYOK and credits billing', () => {
    const landing = [
      read('apps/dashboard/components/marketing/pricing-proof.tsx'),
      read('apps/dashboard/components/marketing/landing-faq.tsx'),
    ].join('\n');
    const comparison = read('apps/dashboard/app/compare/openrouter/page.tsx');
    const comparisonMetadata = read('apps/dashboard/app/compare/openrouter/layout.tsx');
    const modeToggle = read('apps/dashboard/components/settings/billing-mode-toggle.tsx');
    const billingPage = read('apps/dashboard/app/(dashboard)/billing/billing-client.tsx');

    expect(landing).toContain('provider spend has 0% markup');
    expect(landing).toContain('Missing provider credentials fail closed; BYOK never falls back to a RouteShift-funded key.');
    expect(landing).toContain('Active paid plans use the savings-share formula above: 3% of positive measured savings');
    expect(landing).toContain('provider-plus-plugin cost + 3% credits markup');
    expect(landing).not.toContain('Platform fee (5.5% of $20k traffic)');
    expect(landing).not.toContain('at zero cost — no upstream call needed');
    expect(modeToggle).toContain('3% of measured savings');
    expect(modeToggle).toContain('provider cost plus a 3% credits markup');
    expect(billingPage).toContain('Current Period BYOK Savings');
    expect(billingPage).toContain('subscription/BYOK requests only');
    expect(comparison).toContain('BYOK above included allowance');
    expect(comparison).toContain('5% of equivalent cost');
    expect(comparison).toContain('5.5% purchase fee');
    expect(comparison).toContain('credits still add 3%');
    expect(comparison).toContain('400+ models');
    expect(comparison).toContain('70+ providers');
    expect(comparison).not.toContain('5.5% of all API spend');
    expect(comparison).not.toContain('$1,375/mo');
    expect(comparison).not.toContain('300+ models');
    expect(comparison).not.toContain("openrouter: '60+'");
    expect(comparisonMetadata).not.toContain('flat rate plus savings share');
  });

  it('RSH-144 de-stales /compare/openrouter against OpenRouter features shipped through 2026-07-25', () => {
    const comparison = read('apps/dashboard/app/compare/openrouter/page.tsx');

    // Extract one comparison row by feature name so each assertion is pinned to
    // its own row's cells. A page-wide `toContain` is too weak here: a
    // single-cell revert elsewhere leaves it green, which is exactly how an
    // earlier version of this block let 5 of 5 targeted reverts pass.
    const rowFor = (feature: string): string => {
      const start = comparison.indexOf(`feature: '${feature}'`);
      expect(start, `missing comparison row: ${feature}`).toBeGreaterThan(-1);
      const rest = comparison.slice(start);
      return rest.slice(0, rest.indexOf('},'));
    };

    // Response caching: OpenRouter shipped it 2026-04-30 with broader
    // eligibility and $0-on-hit billing. RouteShift's cache is narrower AND
    // bills the hit at full cost, so the winner flips against us. Both cells
    // are locked — locking only OpenRouter's would let the RouteShift cell
    // silently revert to the old flattering wording.
    const caching = rowFor('Response caching');
    expect(caching).toContain("winner: 'openrouter'");
    expect(caching).toContain('$0 billed on a cache hit');
    expect(caching).toMatch(/bills the cache hit at full cost/);
    expect(caching).not.toContain("openrouter: 'Not available'");

    // Smart routing: Auto Exacto (2026-03-12), presets (2026-06-16) and
    // performance-index filtering (2026-07-07) all shipped, so "basic" is
    // stale and the row is at best a tie.
    const routing = rowFor('Smart routing engine');
    expect(routing).toContain('Auto Exacto adaptive quality routing');
    expect(routing).toContain("winner: 'tie'");
    expect(comparison).not.toContain('Basic model selection');

    // Analytics rows: OpenRouter's Analytics API (2026-06-11) and Classifiers
    // (2026-07-24) are real. Assert the specific OpenRouter cells, because the
    // strings they replaced ('Basic usage tracking', 'Not applicable') could
    // both be restored while a page-wide guard stayed green.
    expect(rowFor('Cost analytics')).toContain('Analytics API');
    expect(rowFor('Cost analytics')).not.toContain('Basic usage tracking');
    expect(rowFor('Cache hit analytics')).not.toContain("openrouter: 'Not applicable'");

    // A Guardrails row must exist and describe both sides truthfully.
    // RSH-139/152 shipped pre-dispatch PII/injection scanning with a
    // team-configurable pattern catalog, so 'Not available' became false and
    // was removed. OpenRouter's per-key/member/workspace scoping is still
    // broader than RouteShift's team-level config, so the row stays conceded.
    const guardrails = rowFor('Guardrails (prompt-injection / DLP)');
    expect(guardrails).toContain('Prompt-injection detection + built-in PII/DLP scanning');
    expect(guardrails).toContain('Pre-dispatch scanning');
    expect(guardrails).toContain('pattern catalog');
    expect(guardrails).not.toContain("routeshift: 'Not available'");
    expect(guardrails).toContain("winner: 'openrouter'");

    // The buyer-decision list must not re-sell the feature the table concedes.
    // The page previously told readers to choose RouteShift because "You need
    // response caching to eliminate redundant API calls" while the caching row
    // above now names OpenRouter the winner — and "eliminate" is the same
    // zero-cost overclaim shape RSH-96 already audits against on the landing
    // page (see the assertion above in this file).
    expect(comparison).not.toMatch(/response caching to eliminate/i);
  });

  it('2026-08-26 truthfulness pass: /rankings uses deterministic effective-catalog views', () => {
    const comparison = read('apps/dashboard/app/compare/openrouter/page.tsx');
    const rankings = read('apps/dashboard/app/rankings/page.tsx');
    const rankingsMetadata = read('apps/dashboard/app/rankings/layout.tsx');

    // Shipped RouteShift features must be credited in the comparison table:
    // auto-route + versioned presets + quality gates (verified in
    // auto-route-settings.tsx, presets/version-history-drawer.tsx,
    // packages/shared/src/response-verifier.ts), the LLM classifier
    // (classifier-config-section.tsx), and pre-dispatch guardrails.
    expect(comparison).toContain('auto-routing strategies (cheapest/fastest/balanced)');
    expect(comparison).toContain('versioned presets with history');
    expect(comparison).toContain('response quality gates');
    expect(comparison).toContain('LLM classifier that tags sampled, PII-stripped requests across custom dimensions');

    // Time-sensitive OpenRouter fee numbers point readers to the source of truth
    // instead of claiming a stale fixed as-of date.
    expect(comparison).toContain('verify current terms below');

    // Stale metadata comment removed; metadata comes from layout.tsx.
    expect(comparison).not.toContain('generateMetadata in a separate file');

    // Brand mark in the navbar instead of the generic Zap icon — both pages
    // render the shared MarketingNav, which carries the mark.
    const marketingNav = read('apps/dashboard/components/marketing/marketing-nav.tsx');
    expect(marketingNav).toContain('/brand/routeshift-mark.svg');
    expect(comparison).toContain('<MarketingNav />');
    expect(rankings).toContain('<MarketingNav />');

    // Rankings are generated from the same effective public catalog as
    // /v1/models. No editorial popularity/user/trend claims survive.
    expect(rankings).toContain('buildModelsList(null)');
    expect(rankings).toContain('CATALOG_FRESHNESS_MANIFEST.generated_at');
    expect(rankings).toContain("from '@/lib/model-rankings'");
    expect(rankings).not.toMatch(/GPT-5\.5/i);
    expect(rankings).not.toContain('rankedApps');
    expect(rankings).not.toContain('rankedAgents');
    expect(rankings).not.toContain('popularity');
    expect(rankings).not.toContain('trendDelta');
    expect(rankings).not.toMatch(/\busers\b/i);
    expect(rankingsMetadata).not.toMatch(/apps|agents|popular|trend/i);
  });

  it('comparison outbound anchors are explicit and safe if added later', () => {
    const comparison = read('apps/dashboard/app/compare/openrouter/page.tsx');
    const outboundAnchors = [
      ...comparison.matchAll(
        /<a\b[^>]*href\s*=\s*(?:"https?:\/\/[^"]+"|'https?:\/\/[^']+'|\{`https?:\/\/[^`]+`\})[^>]*>/gi,
      ),
    ].map(([anchor]) => anchor);

    for (const anchor of outboundAnchors) {
      expect(anchor).toContain('target="_blank"');
      expect(anchor).toContain('rel="noopener noreferrer"');
    }
  });

  it('dashboard fail-closed states stay visible instead of rendering false-empty data', () => {
    const demoBanner = read('apps/dashboard/components/demo-provenance-banner.tsx');
    const analytics = read('apps/dashboard/app/(dashboard)/analytics/analytics-client.tsx');
    const settings = read('apps/dashboard/app/(dashboard)/settings/page.tsx');
    const billingStatus = read('apps/dashboard/app/api/billing/status/route.ts');
    const billingPage = read('apps/dashboard/app/(dashboard)/billing/billing-client.tsx');
    const sidebar = read('apps/dashboard/components/sidebar-nav.tsx');

    expect(demoBanner).toContain('Sample data status unavailable');
    expect(demoBanner).toContain("setProvenance('unverified')");
    expect(analytics).toContain('secondaryWarnings');
    expect(analytics).toContain('One-shot metrics');
    expect(analytics).toContain('unavailable (${res.status})');
    expect(analytics).toContain('Token hygiene');
    expect(settings).toContain('teamDataError');
    expect(settings).toContain('Team settings could not be loaded.');
    expect(billingStatus).toContain('billing_status_unavailable');
    expect(billingStatus).toContain('can_manage_billing');
    expect(billingPage).toContain('canEdit={canManageBilling && !demoActive}');
    expect(sidebar).toContain('Billing status unavailable');
  });

  it('key-management dialogs and mutations are mobile-safe and surface failures inline', () => {
    for (const path of [
      'apps/dashboard/components/keys/create-key-dialog.tsx',
      'apps/dashboard/components/keys/edit-key-dialog.tsx',
      'apps/dashboard/components/keys/rotate-key-button.tsx',
    ]) {
      const source = read(path);
      expect(source).toContain('w-[calc(100vw-2rem)]');
    }

    const createDialog = read('apps/dashboard/components/keys/create-key-dialog.tsx');
    const editDialog = read('apps/dashboard/components/keys/edit-key-dialog.tsx');
    const rotateDialog = read('apps/dashboard/components/keys/rotate-key-button.tsx');
    const loadBalancing = read('apps/dashboard/components/settings/provider-load-balancing.tsx');
    const memberActions = read('apps/dashboard/components/team/member-actions.tsx');
    const revokeKey = read('apps/dashboard/components/keys/revoke-key-button.tsx');
    const pendingInvitations = read('apps/dashboard/components/team/pending-invitations.tsx');
    const ruleActions = read('apps/dashboard/components/routing/rule-actions.tsx');

    expect(createDialog).toContain('sm:grid-cols-2');
    expect(editDialog).toContain('sm:grid-cols-2');
    expect(rotateDialog).toContain('sm:flex-row');
    expect(loadBalancing).toContain('Network error — could not update strategy');
    expect(loadBalancing).toContain('Network error — could not add key');
    expect(memberActions).toContain('readMutationError');
    expect(memberActions).toContain('Network error — could not remove member');
    expect(memberActions).not.toContain('alert(');
    expect(revokeKey).toContain('Network error — could not revoke key');
    expect(revokeKey).not.toContain('alert(');
    expect(pendingInvitations).toContain('Network error — could not cancel invitation');
    expect(pendingInvitations).not.toContain('alert(');
    expect(ruleActions).toContain('readRuleError');
    expect(ruleActions).toContain('Network error — could not delete rule');
    expect(ruleActions).not.toContain('alert(');
  });

  it('auth, telemetry, and provider-key probes do not hide operational drift', () => {
    const auth = read('apps/dashboard/lib/auth.ts');
    // Error-message strings live in the client form components (page.tsx files
    // are server wrappers).
    const login = read('apps/dashboard/app/(auth)/login/login-form.tsx');
    const register = read('apps/dashboard/app/(auth)/register/register-form.tsx');
    const clientSentry = read('apps/dashboard/instrumentation-client.ts');
    const serverSentry = read('apps/dashboard/sentry.server.config.ts');
    const edgeSentry = read('apps/dashboard/sentry.edge.config.ts');
    const nextConfig = read('apps/dashboard/next.config.ts');
    const providerTest = read('apps/dashboard/app/api/provider-keys/[provider]/test/route.ts');

    expect(auth).toContain('AuthBackendUnavailableError');
    expect(login).toContain('Authentication service is unavailable');
    expect(register).toContain('authentication service is unavailable');
    for (const source of [clientSentry, serverSentry, edgeSentry]) {
      expect(source).toContain('sendDefaultPii: false');
      expect(source).not.toContain('sendDefaultPii: true');
    }
    expect(serverSentry).toContain('includeLocalVariables: process.env.NODE_ENV === "development"');
    expect(nextConfig).toContain('https://api2.amplitude.com');
    expect(nextConfig).toContain('https://api-js.mixpanel.com');
    expect(providerTest).toContain('ANTHROPIC_KEY_TEST_MODEL');
    expect(providerTest).toContain('MODEL_REGISTRY.find');
    expect(providerTest).not.toContain('claude-haiku-4-5-20251022');
  });

  it('yield dashboard joins session metrics by both team and session id', () => {
    const source = read('apps/dashboard/app/(dashboard)/yield/page.tsx');
    expect(source).toContain('JOIN session_metrics m ON m.team_id = y.team_id AND m.session_id = y.session_id');
  });

  it('provider-key writes fail when proxy cache invalidation returns non-2xx', () => {
    for (const path of [
      'apps/dashboard/app/api/provider-keys/[provider]/route.ts',
      'apps/dashboard/app/api/provider-keys/[provider]/[label]/route.ts',
      'apps/dashboard/app/api/provider-keys/[provider]/strategy/route.ts',
    ]) {
      const source = read(path);
      expect(source).toContain('if (!res.ok)');
      expect(source).toContain('proxy_cache_invalidation_failed');
      expect(source).toContain('proxy_cache_invalidated: false');
    }
  });

  it('team-scoped dashboard API routes re-check live membership instead of trusting the session team', () => {
    for (const path of [
      'apps/dashboard/app/api/models/compare/route.ts',
      'apps/dashboard/app/api/optimize/findings/route.ts',
      'apps/dashboard/app/api/team/rate-limits/route.ts',
      'apps/dashboard/app/api/billing/redeem/route.ts',
      'apps/dashboard/app/api/keys/[id]/audit/route.ts',
    ]) {
      const source = read(path);
      expect(source).toContain('requireTeamMembership');
      expect(source).not.toContain('const session = await auth()');
      expect(source).not.toContain('(session.user as');
    }
  });

  it('dismissing a team-wide optimize finding requires admin, not bare membership', () => {
    // Dismissal is a team-wide, irreversible write (the engine never re-opens a
    // dismissed finding and there is no un-dismiss path), so it must be gated on
    // admin like every other team-state mutation — not left open to any member,
    // who could otherwise permanently hide savings advice from admins/owners.
    const source = read('apps/dashboard/app/api/optimize/findings/route.ts');
    // The PATCH (mutating) handler must claim admin.
    expect(source).toContain("await requireRole('admin')");
    // The mutation must NOT be reachable behind only requireTeamMembership.
    const patchBody = source.slice(source.indexOf('export async function PATCH'));
    expect(patchBody).toContain("await requireRole('admin')");
    expect(patchBody).not.toContain('await requireTeamMembership()');
  });

  it('stripe duplicate-event branch does not double-release the pg client, and recovery selects teams.id', () => {
    const source = read('apps/dashboard/app/api/webhooks/stripe/route.ts');
    // The duplicate branch must NOT manually release — the finally releases once;
    // a second release throws on pg-pool and a throwing finally turns the 200
    // duplicate-ACK into a 500.
    expect(source).not.toContain("client.release();\n      return NextResponse.json({ received: true, duplicate: true });");
    // The out-of-order subscription recovery must select the real PK (teams.id),
    // not the nonexistent teams.team_id column (which 500s on Postgres).
    expect(source).toContain('SELECT id AS team_id FROM teams');
    expect(source).not.toContain('SELECT team_id FROM teams');
  });

  it('preset write APIs enforce the demo-mode read-only guard like rule writes', () => {
    const collection = read('apps/dashboard/app/api/presets/route.ts');
    const item = read('apps/dashboard/app/api/presets/[slug]/route.ts');
    expect(collection).toContain('isDemoActive');
    expect(item).toContain('isDemoActive');
  });

  it('dashboard pagination defaults NaN page/limit instead of passing NaN into SQL LIMIT/OFFSET', () => {
    for (const path of [
      'apps/dashboard/app/api/logs/route.ts',
      'apps/dashboard/app/api/credits/transactions/route.ts',
    ]) {
      const source = read(path);
      expect(source).toContain('Number.isFinite(rawPage)');
      expect(source).toContain('Number.isFinite(rawLimit)');
    }
  });

  it('minimax provider-key test probes the registered model id, not the removed one', () => {
    const source = read('apps/dashboard/app/api/provider-keys/[provider]/test/route.ts');
    expect(source).toContain("model: 'MiniMax-M2'");
    expect(source).not.toContain("model: 'MiniMax-M2.7'");
  });

  it('cost aggregates preserve lower bounds and expose reconciliation qualification', () => {
    for (const path of [
      'apps/dashboard/app/api/metrics/overview/route.ts',
      'apps/dashboard/app/api/metrics/usage/route.ts',
      'apps/dashboard/app/api/metrics/savings/route.ts',
      'apps/dashboard/app/api/metrics/analytics/route.ts',
      'apps/dashboard/app/api/billing/by-key/route.ts',
      'apps/dashboard/app/api/billing/by-tag/route.ts',
      'apps/dashboard/app/api/models/compare/route.ts',
      'apps/dashboard/app/api/usage/token-tracker/route.ts',
    ]) {
      const source = read(path);
      expect(source).toContain('COUNT(*) FILTER (WHERE');
      expect(source).toContain('actual_cost_known = false');
      expect(source).toContain('unknown_cost_requests');
      expect(source).toContain('actual_costs_qualified');
    }
    // RSH-138: the budget route delegates qualification to the shared report
    // loader — the pure serializer is the single arithmetic implementation.
    const budgetLoader = read('apps/dashboard/lib/budget-report.ts');
    expect(budgetLoader).toContain('unknown_cost_requests');
    expect(budgetLoader).toContain('actual_costs_qualified');
    expect(budgetLoader).toContain('buildBudgetReport');
    expect(read('apps/dashboard/app/api/billing/budget/route.ts')).toContain('loadBudgetReport');
    expect(read('apps/dashboard/app/api/metrics/savings/route.ts'))
      .toContain('FILTER (WHERE actual_cost_known = true)');
    expect(read('apps/dashboard/components/cost-qualification-notice.tsx'))
      .toContain('observed lower bounds');
    expect(read('apps/dashboard/app/(dashboard)/tokens/token-tracker-client.tsx'))
      .toContain('CostQualificationNotice');
    for (const path of [
      'apps/dashboard/app/(dashboard)/overview/page.tsx',
      'apps/dashboard/app/(dashboard)/savings/page.tsx',
      'apps/dashboard/app/(dashboard)/usage/page.tsx',
    ]) {
      const source = read(path);
      expect(source).toContain('actual_cost_known = false');
      expect(source).toContain('unknown_cost_requests');
      expect(source).toContain('CostQualificationNotice');
    }
    expect(read('apps/dashboard/components/billing/monthly-budget-settings.tsx'))
      .toContain('observed lower bounds');
    expect(read('apps/dashboard/app/(dashboard)/models/compare/compare-client.tsx'))
      .toContain('CostQualificationNotice');
    const yieldPage = read('apps/dashboard/app/(dashboard)/yield/page.tsx');
    expect(yieldPage).toContain('SUM(m.unknown_cost_requests)');
    expect(yieldPage).toContain('CostQualificationNotice');
    expect(yieldPage).toContain("' (lower bound)'");
  });

  it('unknown budget costs raise an alert without converting a below-cap balance into a hard action', () => {
    // RSH-138: status precedence lives in the shared buildBudgetReport
    // serializer (unknown history lowers qualification; it never forces a
    // hard action below the cap). The dashboard delegates instead of
    // reimplementing threshold arithmetic.
    const loader = read('apps/dashboard/lib/budget-report.ts');
    expect(loader).toContain('buildBudgetReport');
    expect(read('packages/shared/src/budget-report.ts')).toContain('alertThresholdReached');
    const breakdown = read('apps/dashboard/components/billing/spend-breakdown.tsx');
    expect(breakdown).toContain('unknownCostRequests');
    expect(breakdown).toContain('lower bound');
    expect(read('apps/dashboard/app/(dashboard)/overview/page.tsx'))
      .toContain("Observed lower bound; {budget.unknown_cost_requests} request{budget.unknown_cost_requests === 1 ? '' : 's'} have unknown historical cost.");
  });

  it('shadow-experiments swap demo reads via getEffectiveTeamId but write the real team directly', () => {
    const collection = read('apps/dashboard/app/api/shadow-experiments/route.ts');
    const item = read('apps/dashboard/app/api/shadow-experiments/[id]/route.ts');
    expect(collection).toContain('getEffectiveTeamId');
    expect(collection).toContain('isDemoActive');
    expect(collection).toContain('DEMO_WRITE_BLOCKED_MESSAGE');
    expect(item).toContain('isDemoActive');
    expect(item).toContain('DEMO_WRITE_BLOCKED_MESSAGE');
    expect(item).toContain("method: 'PATCH'");
    expect(item).toContain("method: 'DELETE'");
    // The write paths (PATCH + DELETE) target the caller's real team directly
    // and never consult the demo-read swap — no check-then-act window. Round 2
    // split each handler into a pre-fetch try and a fetch try, so the real-team
    // assignment is now `teamId = user.teamId;` into a pre-declared binding.
    expect(item).not.toContain('getEffectiveTeamId');
    expect(item.match(/teamId = user\.teamId;/g)).toHaveLength(2);
  });
});
