import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const handleProxyRequest = vi.fn(async (_req: unknown, res: { writeHead: (code: number, h: Record<string, string>) => void; end: (body?: string) => void }) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  const handleMonthlyUsage = vi.fn(async (_req: unknown, res: { writeHead: (code: number, h: Record<string, string>) => void; end: (body?: string) => void }) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ month: '2026-03', records: [] }));
  });

  const handleUsageSavings = vi.fn(async (_req: unknown, res: { writeHead: (code: number, h: Record<string, string>) => void; end: (body?: string) => void }) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ month: '2026-03', team_id: 'team_123', savings_microcents: 123 }));
  });

  const handleTokenHygiene = vi.fn(async (_req: unknown, res: { writeHead: (code: number, h: Record<string, string>) => void; end: (body?: string) => void }) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ month: '2026-03', team_id: 'team_123', records: [] }));
  });

  const requireAdminAuth = vi.fn(() => true);
  const handleShadowExperiments = vi.fn(async (_req: unknown, res: { writeHead: (code: number, h: Record<string, string>) => void; end: (body?: string) => void }, teamId: string) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ team_id: teamId }));
  });
  const handleShadowExperimentById = vi.fn(async (_req: unknown, res: { writeHead: (code: number, h: Record<string, string>) => void; end: (body?: string) => void }, teamId: string, experimentId: string) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ team_id: teamId, id: experimentId }));
  });
  const handleCreateKey = vi.fn(async (_req: unknown, res: { writeHead: (code: number, h: Record<string, string>) => void; end: (body?: string) => void }) => {
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'k1' }));
  });
  const handleListKeys = vi.fn(async (_req: unknown, res: { writeHead: (code: number, h: Record<string, string>) => void; end: (body?: string) => void }) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([]));
  });
  const handleRevokeKey = vi.fn(async (_req: unknown, res: { writeHead: (code: number, h: Record<string, string>) => void; end: (body?: string) => void }) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ revoked: true }));
  });
  const handleCreateRule = vi.fn(async (_req: unknown, res: { writeHead: (code: number, h: Record<string, string>) => void; end: (body?: string) => void }) => {
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'r1' }));
  });
  const handleListRules = vi.fn(async (_req: unknown, res: { writeHead: (code: number, h: Record<string, string>) => void; end: (body?: string) => void }) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([]));
  });
  const handleUpdateRule = vi.fn(async (_req: unknown, res: { writeHead: (code: number, h: Record<string, string>) => void; end: (body?: string) => void }) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ updated: true }));
  });
  const handleDeleteRule = vi.fn(async (_req: unknown, res: { writeHead: (code: number, h: Record<string, string>) => void; end: (body?: string) => void }) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true }));
  });
  const invalidateKeyCache = vi.fn();
  const responseCache = {
    invalidateTeam: vi.fn(),
  };
  const invalidatePresetCache = vi.fn();
  const poolQuery = vi.fn().mockResolvedValue({ rows: [{ one: 1 }] });
  const getLoggerStats = vi.fn(() => ({
    postgres: null as { pending: number; dropped: number } | null,
    clickhouse: null as { pending: number; dropped: number } | null,
  }));
  const config = {
    corsOrigins: ['*'],
    databaseUrl: undefined as string | undefined,
  };

  return {
    handleProxyRequest,
    handleMonthlyUsage,
    handleUsageSavings,
    handleTokenHygiene,
    requireAdminAuth,
    handleShadowExperiments,
    handleShadowExperimentById,
    handleCreateKey,
    handleListKeys,
    handleRevokeKey,
    handleCreateRule,
    handleListRules,
    handleUpdateRule,
    handleDeleteRule,
    invalidateKeyCache,
    responseCache,
    invalidatePresetCache,
    poolQuery,
    getLoggerStats,
    config,
  };
});

vi.mock('../src/proxy-handler.js', () => ({
  handleProxyRequest: mocks.handleProxyRequest,
}));

vi.mock('../src/usage/monthly.js', () => ({
  handleMonthlyUsage: mocks.handleMonthlyUsage,
}));

vi.mock('../src/usage/savings.js', () => ({
  handleUsageSavings: mocks.handleUsageSavings,
}));

vi.mock('../src/usage/token-hygiene.js', () => ({
  handleTokenHygiene: mocks.handleTokenHygiene,
}));

vi.mock('../src/admin/auth.js', () => ({
  requireAdminAuth: mocks.requireAdminAuth,
}));

vi.mock('../src/admin/shadow-experiments.js', () => ({
  handleShadowExperiments: mocks.handleShadowExperiments,
  handleShadowExperimentById: mocks.handleShadowExperimentById,
}));

vi.mock('../src/admin/keys.js', () => ({
  handleCreateKey: mocks.handleCreateKey,
  handleListKeys: mocks.handleListKeys,
  handleRevokeKey: mocks.handleRevokeKey,
}));

vi.mock('../src/admin/rules.js', () => ({
  handleCreateRule: mocks.handleCreateRule,
  handleListRules: mocks.handleListRules,
  handleUpdateRule: mocks.handleUpdateRule,
  handleDeleteRule: mocks.handleDeleteRule,
}));

vi.mock('../src/billing/provider-key-crypto.js', () => ({
  invalidateKeyCache: mocks.invalidateKeyCache,
}));

vi.mock('../src/cache/response-cache.js', () => ({
  responseCache: mocks.responseCache,
}));

vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({ query: mocks.poolQuery }),
}));

vi.mock('../src/presets/resolver.js', () => ({
  invalidatePresetCache: mocks.invalidatePresetCache,
}));

vi.mock('../src/config.js', () => ({
  config: mocks.config,
}));

vi.mock('../src/logging/logger.js', () => ({
  getLoggerStats: mocks.getLoggerStats,
}));

import { createProxyServer } from '../src/server.js';

describe('proxy server routing', () => {
  let instance: ReturnType<typeof createProxyServer> | null = null;
  let baseUrl = '';

  beforeEach(async () => {
    mocks.handleProxyRequest.mockClear();
    mocks.handleMonthlyUsage.mockClear();
    mocks.handleUsageSavings.mockClear();
    mocks.handleTokenHygiene.mockClear();
    mocks.requireAdminAuth.mockClear();
    mocks.handleShadowExperiments.mockClear();
    mocks.handleShadowExperimentById.mockClear();
    mocks.handleCreateKey.mockClear();
    mocks.handleListKeys.mockClear();
    mocks.handleRevokeKey.mockClear();
    mocks.handleCreateRule.mockClear();
    mocks.handleListRules.mockClear();
    mocks.handleUpdateRule.mockClear();
    mocks.handleDeleteRule.mockClear();
    mocks.invalidateKeyCache.mockClear();
    mocks.responseCache.invalidateTeam.mockClear();
    mocks.invalidatePresetCache.mockClear();
    mocks.poolQuery.mockClear();
    mocks.getLoggerStats.mockReturnValue({ postgres: null, clickhouse: null });
    mocks.requireAdminAuth.mockReturnValue(true);
    mocks.config.databaseUrl = undefined;
    mocks.config.corsOrigins = ['*'];

    instance = createProxyServer(0);
    await instance.start();
    const address = instance.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP server address');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (instance) {
      await instance.stop();
    }
    instance = null;
  });

  it('routes GET /v1/usage/monthly to handleMonthlyUsage with admin auth', async () => {
    const response = await fetch(`${baseUrl}/v1/usage/monthly?month=2026-03`);

    expect(response.status).toBe(200);
    expect(mocks.requireAdminAuth).toHaveBeenCalledTimes(1);
    expect(mocks.handleMonthlyUsage).toHaveBeenCalledTimes(1);
  });

  it('routes GET /v1/usage/savings to handleUsageSavings with admin auth', async () => {
    const response = await fetch(`${baseUrl}/v1/usage/savings?team_id=team_123&month=2026-03`);

    expect(response.status).toBe(200);
    expect(mocks.requireAdminAuth).toHaveBeenCalledTimes(1);
    expect(mocks.handleUsageSavings).toHaveBeenCalledTimes(1);
  });

  it('routes GET /admin/usage/token-hygiene to handleTokenHygiene with admin auth', async () => {
    const response = await fetch(`${baseUrl}/admin/usage/token-hygiene?team_id=team_123&month=2026-03`);

    expect(response.status).toBe(200);
    expect(mocks.requireAdminAuth).toHaveBeenCalledTimes(1);
    expect(mocks.handleTokenHygiene).toHaveBeenCalledTimes(1);
  });

  it('routes globally authorized shadow collection requests for an explicit operator-selected team', async () => {
    const response = await fetch(`${baseUrl}/admin/shadow-experiments?team_id=team_123`);

    expect(response.status).toBe(200);
    expect(mocks.requireAdminAuth).toHaveBeenCalledTimes(1);
    expect(mocks.handleShadowExperiments).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'team_123');
  });

  it('routes shadow experiment item requests with the explicit operator-selected team', async () => {
    const response = await fetch(`${baseUrl}/admin/shadow-experiments/exp_123?team_id=team_123`, { method: 'DELETE' });

    expect(response.status).toBe(200);
    expect(mocks.handleShadowExperimentById).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'team_123', 'exp_123');
  });

  it.each(['*', 'null', 'undefined'])('rejects non-concrete team id %s before reaching the shadow handler', async (teamId) => {
    const response = await fetch(`${baseUrl}/admin/shadow-experiments?team_id=${teamId}`);

    expect(response.status).toBe(400);
    expect(mocks.handleShadowExperiments).not.toHaveBeenCalled();
  });

  it.each(['%20team_123', 'team_123%20', 'NULL', 'Undefined'])('rejects padded or sentinel-like operator team id %s', async (teamId) => {
    const response = await fetch(`${baseUrl}/admin/shadow-experiments?team_id=${teamId}`);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { message: 'team_id is required', code: 'invalid_team_id' },
    });
    expect(mocks.handleShadowExperiments).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only operator-selected team with a stable error code', async () => {
    const response = await fetch(`${baseUrl}/admin/shadow-experiments?team_id=%20%20`);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { message: 'team_id is required', code: 'invalid_team_id' },
    });
    expect(mocks.handleShadowExperiments).not.toHaveBeenCalled();
  });

  it('does not call usage handler when admin auth fails', async () => {
    mocks.requireAdminAuth.mockImplementationOnce((_req: unknown, res: { writeHead: (code: number, h: Record<string, string>) => void; end: (body?: string) => void }) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
      return false;
    });

    const response = await fetch(`${baseUrl}/v1/usage/monthly?month=2026-03`);

    expect(response.status).toBe(401);
    expect(mocks.requireAdminAuth).toHaveBeenCalledTimes(1);
    expect(mocks.handleMonthlyUsage).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown routes', async () => {
    const response = await fetch(`${baseUrl}/v1/unknown`);
    const payload = (await response.json()) as { error?: { message?: string } };

    expect(response.status).toBe(404);
    expect(payload.error?.message).toBe('Not found');
  });

  it('routes the exact public catalog manifest before model details and rejects deeper paths', async () => {
    const response = await fetch(`${baseUrl}/v1/models/catalog-manifest`);
    const payload = await response.json() as {
      schema_version?: number;
      generated_at?: string;
      source_hash?: string;
      recommendations?: Record<string, string>;
      models?: Array<{ id: string; routing?: string }>;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(payload).toMatchObject({
      schema_version: 1,
      generated_at: expect.any(String),
      source_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      recommendations: expect.objectContaining({ default: expect.any(String) }),
      models: expect.arrayContaining([
        expect.objectContaining({ id: 'gpt-5.6', routing: 'explicit_only' }),
      ]),
    });

    const deeper = await fetch(`${baseUrl}/v1/models/catalog-manifest/extra`);
    expect(deeper.status).toBe(404);
    await expect(deeper.json()).resolves.toEqual({ error: { message: 'Not found' } });
  });

  it('surfaces catalog freshness metadata without degrading a healthy proxy', async () => {
    const response = await fetch(`${baseUrl}/health`);
    const payload = await response.json() as {
      status: string;
      postgres: string;
      catalog_freshness?: {
        status: string;
        generated_at: string;
        age_seconds: number;
      };
    };

    expect(response.status).toBe(200);
    expect(payload.status).toBe('ok');
    expect(payload.catalog_freshness).toMatchObject({
      status: expect.stringMatching(/^(ok|degraded)$/),
      generated_at: expect.any(String),
      age_seconds: expect.any(Number),
    });
  });

  it('handles CORS preflight OPTIONS requests', async () => {
    const response = await fetch(`${baseUrl}/any-route`, { method: 'OPTIONS' });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, POST, PUT, PATCH, DELETE, OPTIONS');
  });

  it('reflects only configured CORS origins', async () => {
    mocks.config.corsOrigins = ['https://dashboard.routeshift.io'];

    const allowed = await fetch(`${baseUrl}/health`, {
      headers: { Origin: 'https://dashboard.routeshift.io' },
    });
    const denied = await fetch(`${baseUrl}/health`, {
      headers: { Origin: 'https://evil.example' },
    });

    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://dashboard.routeshift.io');
    expect(allowed.headers.get('vary')).toBe('Origin');
    expect(denied.status).toBe(403);
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it('routes POST /v1/chat/completions to proxy handler', async () => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [] }),
    });

    expect(response.status).toBe(200);
    expect(mocks.handleProxyRequest).toHaveBeenCalledTimes(1);
  });

  it('routes POST /admin/presets/invalidate to the preset cache invalidator', async () => {
    const response = await fetch(`${baseUrl}/admin/presets/invalidate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team_id: 'team_123' }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.requireAdminAuth).toHaveBeenCalledTimes(1);
    expect(mocks.invalidatePresetCache).toHaveBeenCalledWith('team_123');
    expect(payload).toEqual({ invalidated: true, team_id: 'team_123' });
  });

  it('routes POST /admin/provider-keys/invalidate to credential and response cache invalidators', async () => {
    const response = await fetch(`${baseUrl}/admin/provider-keys/invalidate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team_id: 'team_123', provider: 'openai' }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.requireAdminAuth).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateKeyCache).toHaveBeenCalledWith('team_123', 'openai');
    expect(mocks.responseCache.invalidateTeam).toHaveBeenCalledWith('team_123', 'openai');
    expect(payload).toEqual({ invalidated: true, team_id: 'team_123', provider: 'openai' });
  });

  it('returns ok health when database is not configured', async () => {
    const response = await fetch(`${baseUrl}/health`);
    const payload = (await response.json()) as {
      status: string;
      postgres: string;
      catalog_freshness: { status: string; generated_at: string; age_seconds: number };
    };

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      status: 'ok',
      postgres: 'not_configured',
      catalog_freshness: {
        status: expect.stringMatching(/^(ok|degraded)$/),
        generated_at: expect.any(String),
        age_seconds: expect.any(Number),
      },
    });
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it('returns degraded health when database check fails', async () => {
    mocks.config.databaseUrl = 'postgres://configured';
    mocks.poolQuery.mockRejectedValueOnce(new Error('db down'));

    const response = await fetch(`${baseUrl}/health`);
    const payload = (await response.json()) as {
      status: string;
      postgres: string;
      catalog_freshness: { status: string; generated_at: string; age_seconds: number };
    };

    expect(response.status).toBe(503);
    expect(payload).toMatchObject({
      status: 'degraded',
      postgres: 'error',
      catalog_freshness: {
        status: expect.stringMatching(/^(ok|degraded)$/),
        generated_at: expect.any(String),
        age_seconds: expect.any(Number),
      },
    });
    expect(mocks.poolQuery).toHaveBeenCalledWith('SELECT 1');
  });

  it('health surfaces log-buffer stats for configured sinks only (RSH-65)', async () => {
    mocks.getLoggerStats.mockReturnValue({
      postgres: { pending: 7, dropped: 2 },
      clickhouse: null, // sink not configured → omitted from the payload
    });

    const response = await fetch(`${baseUrl}/health`);
    const payload = (await response.json()) as {
      status: string;
      postgres: string;
      logging?: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(payload.logging).toEqual({ postgres: { pending: 7, dropped: 2 } });
    expect(payload.logging).not.toHaveProperty('clickhouse');
  });

  it('health omits the logging field entirely when no sink is configured (RSH-65)', async () => {
    // The catalog freshness contract is always present alongside DB health.
    const response = await fetch(`${baseUrl}/health`);
    const payload = (await response.json()) as Record<string, unknown>;

    expect(payload).toMatchObject({ status: 'ok', postgres: 'not_configured' });
    expect(payload).toHaveProperty('catalog_freshness');
    expect(payload).not.toHaveProperty('logging');
  });

  it('routes admin key and rule endpoints', async () => {
    const requests = [
      fetch(`${baseUrl}/admin/keys`, { method: 'POST', body: '{}' }),
      fetch(`${baseUrl}/admin/keys`, { method: 'GET' }),
      fetch(`${baseUrl}/admin/keys/key_1`, { method: 'DELETE' }),
      fetch(`${baseUrl}/admin/rules`, { method: 'POST', body: '{}' }),
      fetch(`${baseUrl}/admin/rules`, { method: 'GET' }),
      fetch(`${baseUrl}/admin/rules/rule_1`, { method: 'PATCH', body: '{}' }),
      fetch(`${baseUrl}/admin/rules/rule_1`, { method: 'DELETE' }),
    ];

    const responses = await Promise.all(requests);
    expect(responses.map((r) => r.status)).toEqual([201, 200, 200, 201, 200, 200, 200]);
    expect(mocks.requireAdminAuth).toHaveBeenCalledTimes(7);
    expect(mocks.handleCreateKey).toHaveBeenCalledTimes(1);
    expect(mocks.handleListKeys).toHaveBeenCalledTimes(1);
    expect(mocks.handleRevokeKey).toHaveBeenCalledTimes(1);
    expect(mocks.handleCreateRule).toHaveBeenCalledTimes(1);
    expect(mocks.handleListRules).toHaveBeenCalledTimes(1);
    expect(mocks.handleUpdateRule).toHaveBeenCalledTimes(1);
    expect(mocks.handleDeleteRule).toHaveBeenCalledTimes(1);
  });

  it('returns 500 for route handler exceptions', async () => {
    mocks.handleCreateKey.mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    const response = await fetch(`${baseUrl}/admin/keys`, { method: 'POST', body: '{}' });
    const payload = (await response.json()) as { error?: { message?: string } };

    expect(response.status).toBe(500);
    expect(payload.error?.message).toBe('Internal server error');
  });
});
