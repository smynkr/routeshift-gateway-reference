// AXI-7 review round 1 regression pins.
//
// scoped-admin-read-routing.test.ts deliberately mocks the three read handlers
// to prove the auth gate + router dispatch shape. That leaves the ONE security
// property this PR's allowlist exposes unexercised end to end: the sessions
// window's SQL team_id predicate. Here the real handler runs against a mocked
// pool so a future regression deleting that predicate (or binding the wrong
// parameter position) fails this suite. The global-admin route-shape pins keep
// the router's per-key audit endpoint identical for both token classes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({ query: mocks.query }),
}));

import { createProxyServer, type ProxyServer } from '../src/server.js';

const SCOPED_TOKEN = 'team-a-scoped-token';
const TEAM_ID = 'team-a';
const KEY_ID = '123e4567-e89b-12d3-a456-426614174000';
const WINDOW_QUERY =
  '/admin/sessions/window?team_id=TEAM&from=2026-04-29T00:00:00Z&to=2026-04-29T23:59:59Z';

describe('scoped sessions window end to end (real handler, mocked pool)', () => {
  let app: ProxyServer | null = null;
  let baseUrl = '';

  beforeEach(async () => {
    vi.stubEnv('ADMIN_SECRET', 'global-admin-secret-123');
    vi.stubEnv('ADMIN_SCOPED_TOKENS', JSON.stringify({ [SCOPED_TOKEN]: [TEAM_ID] }));
    mocks.query.mockReset();
    mocks.query.mockResolvedValue({ rows: [] });

    app = createProxyServer(0);
    await app.start();
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind to a TCP port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (app) await app.stop();
    app = null;
    vi.unstubAllEnvs();
  });

  it('binds the scoped token team as the sessions-window SQL team_id predicate', async () => {
    const response = await fetch(`${baseUrl}${WINDOW_QUERY.replace('TEAM', TEAM_ID)}`, {
      headers: { Authorization: `Bearer ${SCOPED_TOKEN}` },
    });

    expect(response.status).toBe(200);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/team_id = \$3/);
    expect(params[2]).toBe(TEAM_ID);
  });

  it('never reaches the SQL layer for a foreign team', async () => {
    const response = await fetch(`${baseUrl}${WINDOW_QUERY.replace('TEAM', 'team-b')}`, {
      headers: { Authorization: `Bearer ${SCOPED_TOKEN}` },
    });

    expect(response.status).toBe(403);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('binds the team and UUID before any row lookup on the per-key audit feed', async () => {
    const response = await fetch(
      `${baseUrl}/admin/keys/${KEY_ID}/audit?team_id=${TEAM_ID}`,
      { headers: { Authorization: `Bearer ${SCOPED_TOKEN}` } },
    );

    expect(response.status).toBe(200);
    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/team_id = \$1 AND api_key_id = \$2/);
    expect(params[0]).toBe(TEAM_ID);
    expect(params[1]).toBe(KEY_ID);
  });
});

describe('global admin per-key audit route shape matches the scoped allowlist', () => {
  let app: ProxyServer | null = null;
  let baseUrl = '';

  beforeEach(async () => {
    vi.stubEnv('ADMIN_SECRET', 'global-admin-secret-123');
    mocks.query.mockReset();
    mocks.query.mockResolvedValue({ rows: [] });

    app = createProxyServer(0);
    await app.start();
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind to a TCP port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (app) await app.stop();
    app = null;
    vi.unstubAllEnvs();
  });

  it('serves the canonical per-key audit path', async () => {
    const response = await fetch(`${baseUrl}/admin/keys/${KEY_ID}/audit?team_id=${TEAM_ID}`, {
      headers: { Authorization: 'Bearer global-admin-secret-123' },
    });

    expect(response.status).toBe(200);
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it('404s the deeper per-key audit path for the global secret too', async () => {
    const response = await fetch(`${baseUrl}/admin/keys/${KEY_ID}/audit/extra?team_id=${TEAM_ID}`, {
      headers: { Authorization: 'Bearer global-admin-secret-123' },
    });

    expect(response.status).toBe(404);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
