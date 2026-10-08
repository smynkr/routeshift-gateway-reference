import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireAdminAuth } from './auth.js';

function mockReq(token: string | null, url: string, method = 'GET') {
  return {
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    socket: { localAddress: '10.0.0.1', remoteAddress: '10.0.0.2' },
  } as never;
}

function mockRes() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(code: number, headers: Record<string, string>) {
      this.statusCode = code;
      this.headers = headers;
    },
    end(chunk?: string) {
      this.body = chunk ?? '';
    },
  };
  return res;
}

describe('requireAdminAuth scoped tokens', () => {
  const keyId = '11111111-1111-1111-1111-111111111111';

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('allows the global ADMIN_SECRET to read any explicit team_id', () => {
    vi.stubEnv('ADMIN_SECRET', 'global-admin-secret-123');
    vi.stubEnv('ADMIN_SCOPED_TOKENS', JSON.stringify({ 'team-a-token-12345': ['team-a'] }));
    const res = mockRes();

    const ok = requireAdminAuth(mockReq('global-admin-secret-123', '/admin/usage/savings-series?team_id=team-b'), res as never);

    expect(ok).toBe(true);
    expect(res.statusCode).toBe(0);
  });

  it('allows the global ADMIN_SECRET to access a shadow route for an explicit concrete team', () => {
    vi.stubEnv('ADMIN_SECRET', 'global-admin-secret-123');
    vi.stubEnv('ADMIN_SCOPED_TOKENS', JSON.stringify({ 'team-a-token-12345': ['team-a'] }));
    const res = mockRes();

    const ok = requireAdminAuth(mockReq('global-admin-secret-123', '/admin/shadow-experiments?team_id=team-b'), res as never);

    expect(ok).toBe(true);
    expect(res.statusCode).toBe(0);
  });

  it('denies scoped admin tokens on shadow routes even for their own team', () => {
    vi.stubEnv('ADMIN_SECRET', 'global-admin-secret-123');
    vi.stubEnv('ADMIN_SCOPED_TOKENS', JSON.stringify({ 'team-a-token-12345': ['team-a'] }));
    const res = mockRes();

    const ok = requireAdminAuth(mockReq('team-a-token-12345', '/admin/shadow-experiments?team_id=team-a'), res as never);

    expect(ok).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: { message: 'Forbidden for scoped admin token on this endpoint' } });
  });

  it('allows a scoped admin token to read its own team_id', () => {
    vi.stubEnv('ADMIN_SECRET', 'global-admin-secret-123');
    vi.stubEnv('ADMIN_SCOPED_TOKENS', JSON.stringify({ 'team-a-token-12345': ['team-a'] }));
    const res = mockRes();

    const ok = requireAdminAuth(mockReq('team-a-token-12345', '/admin/usage/savings-series?team_id=team-a'), res as never);

    expect(ok).toBe(true);
    expect(res.statusCode).toBe(0);
  });

  it('denies a scoped admin token trying to read another team_id', () => {
    vi.stubEnv('ADMIN_SECRET', 'global-admin-secret-123');
    vi.stubEnv('ADMIN_SCOPED_TOKENS', JSON.stringify({ 'team-a-token-12345': ['team-a'] }));
    const res = mockRes();

    const ok = requireAdminAuth(mockReq('team-a-token-12345', '/admin/usage/savings-series?team_id=team-b'), res as never);

    expect(ok).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: { message: 'Forbidden for requested team_id' } });
  });

  it('denies scoped admin tokens on endpoints that ignore team_id even when the query includes an allowed team', () => {
    vi.stubEnv('ADMIN_SECRET', 'global-admin-secret-123');
    vi.stubEnv('ADMIN_SCOPED_TOKENS', JSON.stringify({ 'team-a-token-12345': ['team-a'] }));
    const res = mockRes();

    const ok = requireAdminAuth(mockReq('team-a-token-12345', '/v1/usage/monthly?team_id=team-a&month=2026-06'), res as never);

    expect(ok).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: { message: 'Forbidden for scoped admin token on this endpoint' } });
  });

  it('denies scoped admin tokens on JSON-body mutations instead of trusting a caller-supplied team header', () => {
    vi.stubEnv('ADMIN_SECRET', 'global-admin-secret-123');
    vi.stubEnv('ADMIN_SCOPED_TOKENS', JSON.stringify({ 'team-a-token-12345': ['team-a'] }));
    const res = mockRes();

    const ok = requireAdminAuth(
      {
        method: 'POST',
        url: '/admin/keys?team_id=team-a',
        headers: { authorization: 'Bearer team-a-token-12345', 'x-routeshift-team-id': 'team-a' },
        socket: { localAddress: '10.0.0.1', remoteAddress: '10.0.0.2' },
      } as never,
      res as never,
    );

    expect(ok).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: { message: 'Forbidden for scoped admin token on this endpoint' } });
  });

  it.each(['/admin/keys/audit', `/admin/keys/${keyId}/audit`, '/admin/sessions/window'])(
    'allows scoped admin reads on %s for the token team',
    (path) => {
      vi.stubEnv('ADMIN_SECRET', 'global-admin-secret-123');
      vi.stubEnv('ADMIN_SCOPED_TOKENS', JSON.stringify({ 'team-a-token-12345': ['team-a'] }));
      const res = mockRes();

      const ok = requireAdminAuth(mockReq('team-a-token-12345', `${path}?team_id=team-a`), res as never);

      expect(ok).toBe(true);
      expect(res.statusCode).toBe(0);
    },
  );

  it.each(['/admin/keys/audit', `/admin/keys/${keyId}/audit`, '/admin/sessions/window'])(
    'denies scoped admin reads on %s for a foreign, missing, or wildcard team',
    (path) => {
      for (const teamId of ['team-b', null, '*']) {
        vi.stubEnv('ADMIN_SECRET', 'global-admin-secret-123');
        vi.stubEnv('ADMIN_SCOPED_TOKENS', JSON.stringify({ 'team-a-token-12345': ['team-a'] }));
        const res = mockRes();
        const query = teamId === null ? '' : `?team_id=${encodeURIComponent(teamId)}`;

        const ok = requireAdminAuth(mockReq('team-a-token-12345', `${path}${query}`), res as never);

        expect(ok).toBe(false);
        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res.body)).toEqual({ error: { message: 'Forbidden for requested team_id' } });
      }
    },
  );

  it('denies POST on newly scoped read endpoints', () => {
    vi.stubEnv('ADMIN_SECRET', 'global-admin-secret-123');
    vi.stubEnv('ADMIN_SCOPED_TOKENS', JSON.stringify({ 'team-a-token-12345': ['team-a'] }));
    const res = mockRes();

    const ok = requireAdminAuth(mockReq('team-a-token-12345', '/admin/keys/audit?team_id=team-a', 'POST'), res as never);

    expect(ok).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it.each([
    '/admin/keys//audit',
    '/admin/keys/audit/extra',
    `/admin/keys/${keyId}/audit/extra`,
    `/admin/keys/${keyId}`,
    `/admin/keys/${keyId}/not-audit`,
    '/admin/sessions/window/extra',
    '/admin/keys/not-a-uuid/audit',
    '/admin/keys/%31%32%33e4567-e89b-12d3-a456-426614174000/audit',
    '/admin/keys/%2F/audit',
    '/admin/keys/%5C/audit',
    '/admin/keys/%252F/audit',
    '/admin/keys/%ZZ/audit',
    // AXI-7 review round 1: the gate judges the RAW request target (the same
    // string the router matches), so WHATWG normalization tricks can never be
    // authorized — dot-segments, backslash-as-slash, and fragments all fail
    // closed here instead of relying on handler re-validation.
    '/admin/keys/./audit',
    '/admin/keys/../keys/audit',
    '/admin\\keys\\audit',
    '/admin/keys\\audit',
    '/admin/sessions/window#frag',
  ])('denies malformed or deeper scoped-read lookalike %s', (path) => {
    vi.stubEnv('ADMIN_SECRET', 'global-admin-secret-123');
    vi.stubEnv('ADMIN_SCOPED_TOKENS', JSON.stringify({ 'team-a-token-12345': ['team-a'] }));
    const res = mockRes();

    const ok = requireAdminAuth(mockReq('team-a-token-12345', `${path}?team_id=team-a`), res as never);

    expect(ok).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it('rejects configured scoped admin tokens shorter than the admin minimum length', () => {
    vi.stubEnv('ADMIN_SECRET', 'global-admin-secret-123');
    vi.stubEnv('ADMIN_SCOPED_TOKENS', JSON.stringify({ a: ['team-a'] }));
    const res = mockRes();

    const ok = requireAdminAuth(mockReq('a', '/admin/usage/savings-series?team_id=team-a'), res as never);

    expect(ok).toBe(false);
    expect(res.statusCode).toBe(401);
  });
});
