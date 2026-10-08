import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const respond = (name: string) => vi.fn(async (_req: unknown, res: {
    writeHead: (status: number, headers: Record<string, string>) => void;
    end: (body?: string) => void;
  }) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ handler: name }));
  });

  return {
    handleListTeamAudit: respond('team-audit'),
    handleListKeyAudit: respond('key-audit'),
    handleSessionsWindow: respond('sessions-window'),
  };
});

vi.mock('../src/admin/keys.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/admin/keys.js')>()),
  handleListTeamAudit: mocks.handleListTeamAudit,
  handleListKeyAudit: mocks.handleListKeyAudit,
}));

vi.mock('../src/admin/sessions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/admin/sessions.js')>()),
  handleSessionsWindow: mocks.handleSessionsWindow,
}));

import { createProxyServer } from '../src/server.js';

const SCOPED_TOKEN = 'team-a-scoped-token';
const TEAM_ID = 'team-a';
const KEY_ID = '123e4567-e89b-12d3-a456-426614174000';

function handlerCallCount(): number {
  return mocks.handleListTeamAudit.mock.calls.length +
    mocks.handleListKeyAudit.mock.calls.length +
    mocks.handleSessionsWindow.mock.calls.length;
}

describe('scoped admin read routes', () => {
  let app: ReturnType<typeof createProxyServer> | null = null;
  let baseUrl = '';

  beforeEach(async () => {
    vi.stubEnv('ADMIN_SECRET', 'global-admin-secret-123');
    vi.stubEnv('ADMIN_SCOPED_TOKENS', JSON.stringify({ [SCOPED_TOKEN]: [TEAM_ID] }));
    mocks.handleListTeamAudit.mockClear();
    mocks.handleListKeyAudit.mockClear();
    mocks.handleSessionsWindow.mockClear();

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

  async function scopedRequest(path: string, method = 'GET'): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${SCOPED_TOKEN}` },
    });
  }

  it('routes a same-team scoped token to the canonical team audit handler', async () => {
    const response = await scopedRequest(`/admin/keys/audit?team_id=${TEAM_ID}`);

    expect(response.status).toBe(200);
    expect(mocks.handleListTeamAudit).toHaveBeenCalledTimes(1);
    expect(handlerCallCount()).toBe(1);
  });

  it('routes a same-team scoped token to the canonical per-key audit handler', async () => {
    const response = await scopedRequest(`/admin/keys/${KEY_ID}/audit?team_id=${TEAM_ID}`);

    expect(response.status).toBe(200);
    expect(mocks.handleListKeyAudit).toHaveBeenCalledWith(expect.anything(), expect.anything(), KEY_ID);
    expect(handlerCallCount()).toBe(1);
  });

  it('routes a same-team scoped token to the canonical sessions-window handler', async () => {
    const response = await scopedRequest(`/admin/sessions/window?team_id=${TEAM_ID}`);

    expect(response.status).toBe(200);
    expect(mocks.handleSessionsWindow).toHaveBeenCalledTimes(1);
    expect(handlerCallCount()).toBe(1);
  });

  it.each([
    '/admin/keys/audit',
    `/admin/keys/${KEY_ID}/audit`,
    '/admin/sessions/window',
  ])('does not reach a read handler for a foreign team on %s', async (path) => {
    const response = await scopedRequest(`${path}?team_id=team-b`);

    expect(response.status).toBe(403);
    expect(handlerCallCount()).toBe(0);
  });

  it.each([
    '/admin/keys/audit',
    `/admin/keys/${KEY_ID}/audit`,
    '/admin/sessions/window',
  ])('does not reach a read handler without a team_id on %s', async (path) => {
    const response = await scopedRequest(path);

    expect(response.status).toBe(403);
    expect(handlerCallCount()).toBe(0);
  });

  it.each([
    '/admin/keys/audit',
    `/admin/keys/${KEY_ID}/audit`,
    '/admin/sessions/window',
  ])('does not reach a read handler for a wildcard team on %s', async (path) => {
    const response = await scopedRequest(`${path}?team_id=*`);

    expect(response.status).toBe(403);
    expect(handlerCallCount()).toBe(0);
  });

  it.each([
    ['/admin/keys/audit', 'POST', 404],
    [`/admin/keys/${KEY_ID}/audit`, 'POST', 404],
    ['/admin/sessions/window', 'POST', 404],
    ['/admin/keys/audit', 'DELETE', 403],
  ])('does not reach a read handler for non-GET %s', async (path, method, expectedStatus) => {
    const response = await scopedRequest(`${path}?team_id=${TEAM_ID}`, method);

    expect(response.status).toBe(expectedStatus);
    expect(handlerCallCount()).toBe(0);
  });

  it.each([
    ['/admin/keys/audit/extra', 404],
    // Deeper per-key paths are 404'd by the ROUTER (!segments[4]) before the
    // auth gate runs — identical contract for both token classes.
    [`/admin/keys/${KEY_ID}/audit/extra`, 404],
    ['/admin/keys/%31%32%33e4567-e89b-12d3-a456-426614174000/audit', 403],
    ['/admin/keys/%2F/audit', 403],
    ['/admin/keys/%5C/audit', 403],
    ['/admin/keys/audit/', 403],
    [`/admin/keys/${KEY_ID}/audit/`, 403],
    ['/admin//keys//audit', 403],
    ['/admin/sessions/window/extra', 404],
  ])('does not reach a read handler for non-canonical scoped path %s', async (path, expectedStatus) => {
    const response = await scopedRequest(`${path}?team_id=${TEAM_ID}`);

    expect(response.status).toBe(expectedStatus);
    expect(handlerCallCount()).toBe(0);
  });
});
