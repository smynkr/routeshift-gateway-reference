import { describe, expect, it, vi, beforeEach } from 'vitest';

// vi.hoisted (not a plain top-level const) so this is guaranteed initialized
// before vitest invokes the vi.mock factory below -- the factory references
// resolveIdpConfigByDomainMock directly as a property value, which vitest's
// mock-hoisting would otherwise evaluate ahead of a plain
// `const x = vi.fn()` declaration (TDZ ReferenceError). See
// apps/proxy/src/oauth/sso-connections.test.ts for the established pattern
// (this bug bit Tasks 8, 9, and 10 independently).
const { resolveIdpConfigByDomainMock } = vi.hoisted(() => ({
  resolveIdpConfigByDomainMock: vi.fn(),
}));

vi.mock('./sso-connections.js', () => ({ resolveIdpConfigByDomain: resolveIdpConfigByDomainMock }));

const queryMock = vi.fn();
const mockPool = { query: queryMock };

import {
  createSsoDeviceAuthorization,
  DomainNotRegisteredError,
  getAuthorizationByUserCode,
  bindOAuthState,
  getAuthorizationByOAuthState,
  approveAuthorization,
  denyAuthorization,
  pollDeviceToken,
} from './sso-device-service.js';

describe('createSsoDeviceAuthorization', () => {
  beforeEach(() => {
    queryMock.mockReset();
    resolveIdpConfigByDomainMock.mockReset();
  });

  it('resolves team via home-realm discovery and persists a pending row', async () => {
    resolveIdpConfigByDomainMock.mockResolvedValue({
      id: 'idp_abc', teamId: 'team-a', provider: 'okta', loginDomain: 'example.com',
      issuer: 'https://accounts.example.com', clientId: 'client-1', clientSecret: 'secret-1',
    });
    queryMock.mockResolvedValue({ rows: [] });

    const result = await createSsoDeviceAuthorization(mockPool as never, 'alice@example.com', 'https://app.routeshift.io');

    expect(result.idpConfig.teamId).toBe('team-a');
    expect(result.response.device_code).toBeTruthy();
    expect(result.response.user_code).toContain('-');
    expect(result.response.expires_in).toBe(600);
    const [sql, params] = queryMock.mock.calls[0]!;
    expect(String(sql)).toContain('INSERT INTO device_authorizations');
    expect(params).toContain('team-a');
    expect(params).toContain('idp_abc');
  });

  it('throws DomainNotRegisteredError for an unregistered domain, without hitting the DB', async () => {
    resolveIdpConfigByDomainMock.mockResolvedValue(null);

    await expect(
      createSsoDeviceAuthorization(mockPool as never, 'bob@unregistered.com', 'https://app.routeshift.io'),
    ).rejects.toThrow(DomainNotRegisteredError);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed email the same way as an unregistered domain (no distinguishing signal)', async () => {
    await expect(
      createSsoDeviceAuthorization(mockPool as never, 'not-an-email', 'https://app.routeshift.io'),
    ).rejects.toThrow(DomainNotRegisteredError);
    expect(resolveIdpConfigByDomainMock).not.toHaveBeenCalled();
  });

  it('retries user_code generation on a 23505 unique-constraint collision and succeeds on the second attempt', async () => {
    resolveIdpConfigByDomainMock.mockResolvedValue({
      id: 'idp_abc', teamId: 'team-a', provider: 'okta', loginDomain: 'example.com',
      issuer: 'https://accounts.example.com', clientId: 'client-1', clientSecret: 'secret-1',
    });
    const collision = Object.assign(
      new Error('duplicate key value violates unique constraint "idx_device_auth_user_code"'),
      { code: '23505' },
    );
    queryMock
      .mockRejectedValueOnce(collision)
      .mockResolvedValueOnce({ rows: [] });

    const result = await createSsoDeviceAuthorization(mockPool as never, 'alice@example.com', 'https://app.routeshift.io');

    expect(result.idpConfig.teamId).toBe('team-a');
    expect(result.response.device_code).toBeTruthy();
    expect(queryMock).toHaveBeenCalledTimes(2);
    // Both attempts were INSERTs; the retry regenerated a fresh user_code
    // (params[2]) rather than reusing the one that collided.
    const [firstSql, firstParams] = queryMock.mock.calls[0]!;
    const [secondSql, secondParams] = queryMock.mock.calls[1]!;
    expect(String(firstSql)).toContain('INSERT INTO device_authorizations');
    expect(String(secondSql)).toContain('INSERT INTO device_authorizations');
    expect(firstParams[2]).not.toBe(secondParams[2]);
  });

  it('rethrows a non-23505 error immediately, without retrying', async () => {
    resolveIdpConfigByDomainMock.mockResolvedValue({
      id: 'idp_abc', teamId: 'team-a', provider: 'okta', loginDomain: 'example.com',
      issuer: 'https://accounts.example.com', clientId: 'client-1', clientSecret: 'secret-1',
    });
    const dbError = new Error('connection reset');
    queryMock.mockRejectedValueOnce(dbError);

    await expect(
      createSsoDeviceAuthorization(mockPool as never, 'alice@example.com', 'https://app.routeshift.io'),
    ).rejects.toThrow('connection reset');
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});

describe('getAuthorizationByUserCode', () => {
  it('scopes the lookup to status=pending', async () => {
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [] });
    await getAuthorizationByUserCode(mockPool as never, 'ABCD1234');
    const [sql] = queryMock.mock.calls[0]!;
    expect(String(sql)).toContain("status = 'pending'");
  });
});

describe('bindOAuthState / getAuthorizationByOAuthState', () => {
  beforeEach(() => queryMock.mockReset());

  it('stamps a fresh state/nonce pair on a pending row, scoped to status=pending', async () => {
    queryMock.mockResolvedValue({ rowCount: 1 });
    const result = await bindOAuthState(mockPool as never, 'auth-1');
    expect(result).not.toBeNull();
    const { state, nonce } = result!;
    expect(state).toBeTruthy();
    expect(nonce).toBeTruthy();
    expect(state).not.toBe(nonce);
    const [sql, params] = queryMock.mock.calls[0]!;
    expect(String(sql)).toContain("status = 'pending'");
    expect(params).toContain('auth-1');
    expect(params).toContain(state);
    expect(params).toContain(nonce);
  });

  it('returns null (without persisting the generated state/nonce) when the row is not pending', async () => {
    queryMock.mockResolvedValue({ rowCount: 0 });
    const result = await bindOAuthState(mockPool as never, 'auth-1');
    expect(result).toBeNull();
    // The UPDATE was still attempted (no crash/exception) -- it's the
    // conditional WHERE clause that prevented the write from matching a row,
    // not a short-circuit before the query.
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0]!;
    expect(String(sql)).toContain("status = 'pending'");
    expect(params).toContain('auth-1');
  });

  it('looks up a row by oauth_state, scoped to status=pending', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await getAuthorizationByOAuthState(mockPool as never, 'state-abc');
    const [sql, params] = queryMock.mock.calls[0]!;
    expect(String(sql)).toContain('oauth_state = $1');
    expect(String(sql)).toContain("status = 'pending'");
    expect(params).toEqual(['state-abc']);
  });
});

describe('approveAuthorization / denyAuthorization', () => {
  beforeEach(() => queryMock.mockReset());

  it('approve stamps verified_email and transitions pending -> approved', async () => {
    queryMock.mockResolvedValue({ rowCount: 1 });
    const ok = await approveAuthorization(mockPool as never, 'auth-1', 'alice@example.com');
    expect(ok).toBe(true);
    const [sql, params] = queryMock.mock.calls[0]!;
    expect(String(sql)).toContain("status = 'approved'");
    expect(params).toContain('alice@example.com');
  });

  it('approve returns false when the row is not pending (TOCTOU race with a concurrent deny)', async () => {
    queryMock.mockResolvedValue({ rowCount: 0 });
    const ok = await approveAuthorization(mockPool as never, 'auth-1', 'alice@example.com');
    expect(ok).toBe(false);
  });

  it('deny transitions pending -> denied', async () => {
    queryMock.mockResolvedValue({ rowCount: 1 });
    const ok = await denyAuthorization(mockPool as never, 'auth-1');
    expect(ok).toBe(true);
    const [sql] = queryMock.mock.calls[0]!;
    expect(String(sql)).toContain("status = 'denied'");
  });

  it('deny returns false when the row is not pending', async () => {
    queryMock.mockResolvedValue({ rowCount: 0 });
    const ok = await denyAuthorization(mockPool as never, 'auth-1');
    expect(ok).toBe(false);
  });
});

describe('pollDeviceToken', () => {
  beforeEach(() => queryMock.mockReset());

  it('returns authorization_pending while status is pending and not yet due', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'auth-1', status: 'pending', expires_at: new Date(Date.now() + 60_000), last_polled_at: null, interval_seconds: 5, team_id: 't', verified_email: null }] })
      .mockResolvedValueOnce({}); // UPDATE last_polled_at
    const result = await pollDeviceToken(mockPool as never, 'device-code-raw');
    expect(result.status).toBe('authorization_pending');
  });

  it('returns slow_down when polled faster than interval_seconds', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'auth-1', status: 'pending', expires_at: new Date(Date.now() + 60_000), last_polled_at: new Date(), interval_seconds: 5, team_id: 't', verified_email: null }] })
      .mockResolvedValueOnce({});
    const result = await pollDeviceToken(mockPool as never, 'device-code-raw');
    expect(result.status).toBe('slow_down');
  });

  it('returns access_denied for a denied row', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'auth-1', status: 'denied', expires_at: new Date(Date.now() + 60_000) }] });
    const result = await pollDeviceToken(mockPool as never, 'device-code-raw');
    expect(result.status).toBe('access_denied');
  });

  it('returns expired_token for an expired row', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'auth-1', status: 'pending', expires_at: new Date(Date.now() - 1000) }] })
      .mockResolvedValueOnce({});
    const result = await pollDeviceToken(mockPool as never, 'device-code-raw');
    expect(result.status).toBe('expired_token');
  });

  it("guards the expiry UPDATE with a status predicate so it can't overwrite a concurrently-set 'consumed'/'denied' status (RSH-100 review fix)", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'auth-1', status: 'pending', expires_at: new Date(Date.now() - 1000) }] })
      .mockResolvedValueOnce({});
    await pollDeviceToken(mockPool as never, 'device-code-raw');
    const [updateSql] = queryMock.mock.calls[1]!;
    expect(String(updateSql)).toMatch(/SET status = 'expired'/);
    // Not a bare `WHERE id = $1`: must be scoped to states it may legitimately
    // supersede, like every sibling transition and the sweeper's expiry UPDATE.
    expect(String(updateSql)).toMatch(/status\s+IN\s*\(/i);
  });

  it('returns invalid_grant for an already-consumed row (replay defense)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'auth-1', status: 'consumed', expires_at: new Date(Date.now() + 60_000) }] });
    const result = await pollDeviceToken(mockPool as never, 'device-code-raw');
    expect(result.status).toBe('invalid_grant');
  });

  it('returns invalid_grant when no row matches the device_code hash at all', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const result = await pollDeviceToken(mockPool as never, 'device-code-raw');
    expect(result.status).toBe('invalid_grant');
  });

  it('returns ready_to_mint for an approved row still within expires_at', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'auth-1', status: 'approved', expires_at: new Date(Date.now() + 60_000), team_id: 'team-a', verified_email: 'alice@example.com' }],
    });
    const result = await pollDeviceToken(mockPool as never, 'device-code-raw');
    expect(result.status).toBe('ready_to_mint');
    if (result.status === 'ready_to_mint') {
      expect(result.row.verified_email).toBe('alice@example.com');
    }
  });

  it('returns expired_token (not ready_to_mint) for an approved row past its expires_at -- bounds the whole grant, not just the pre-approval phase', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [{ id: 'auth-1', status: 'approved', expires_at: new Date(Date.now() - 1000), team_id: 'team-a', verified_email: 'alice@example.com' }],
      })
      .mockResolvedValueOnce({}); // UPDATE status = 'expired'
    const result = await pollDeviceToken(mockPool as never, 'device-code-raw');
    expect(result.status).toBe('expired_token');
    const [sql, params] = queryMock.mock.calls[1]!;
    expect(String(sql)).toContain("status = 'expired'");
    expect(params).toEqual(['auth-1']);
  });

  it('only issues one query (no UPDATE) for a denied/consumed short-circuit, since neither should touch last_polled_at', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'auth-1', status: 'denied', expires_at: new Date(Date.now() + 60_000) }] });
    await pollDeviceToken(mockPool as never, 'device-code-raw');
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('only advances last_polled_at on an accepted poll, never on a rejected slow_down one -- otherwise a client polling marginally under interval_seconds could never accumulate a large enough gap and would get slow_down forever', async () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const rowBase = {
      id: 'auth-1', status: 'pending', expires_at: new Date(t0.getTime() + 600_000),
      interval_seconds: 5, team_id: 't', verified_email: null,
    };

    // Poll 1 @ t0: no prior last_polled_at -> accepted. UPDATE persists t0.
    queryMock.mockReset();
    queryMock
      .mockResolvedValueOnce({ rows: [{ ...rowBase, last_polled_at: null }] })
      .mockResolvedValueOnce({});
    const r1 = await pollDeviceToken(mockPool as never, 'device-code-raw', t0);
    expect(r1.status).toBe('authorization_pending');
    expect(queryMock).toHaveBeenCalledTimes(2);
    const [updateSql1, updateParams1] = queryMock.mock.calls[1]!;
    expect(String(updateSql1)).toContain('last_polled_at');
    expect(updateParams1).toEqual(['auth-1', t0]);

    // Poll 2 @ t0+4.9s: last_polled_at is still t0 (from poll 1) -> too soon,
    // rejected as slow_down. Under the OLD buggy code, this poll would have
    // unconditionally reset last_polled_at to t0+4.9s despite being rejected.
    // The fix requires: only ONE query (the SELECT) -- no UPDATE at all.
    const t1 = new Date(t0.getTime() + 4900);
    queryMock.mockReset();
    queryMock.mockResolvedValueOnce({ rows: [{ ...rowBase, last_polled_at: t0 }] });
    const r2 = await pollDeviceToken(mockPool as never, 'device-code-raw', t1);
    expect(r2.status).toBe('slow_down');
    expect(queryMock).toHaveBeenCalledTimes(1);

    // Poll 3 @ t0+9.8s: last_polled_at is STILL t0 (poll 2 must not have
    // touched it) -- 9.8s >= interval_seconds (5s), so under the FIXED
    // behavior this is accepted (authorization_pending). Under the OLD
    // buggy behavior, poll 2 would have reset last_polled_at to t0+4.9s,
    // making this poll's gap only 9.8-4.9=4.9s < 5s -- still slow_down,
    // i.e. a permanent lockout for a client polling this cadence.
    const t2 = new Date(t0.getTime() + 9800);
    queryMock.mockReset();
    queryMock
      .mockResolvedValueOnce({ rows: [{ ...rowBase, last_polled_at: t0 }] })
      .mockResolvedValueOnce({});
    const r3 = await pollDeviceToken(mockPool as never, 'device-code-raw', t2);
    expect(r3.status).toBe('authorization_pending');
    expect(queryMock).toHaveBeenCalledTimes(2);
  });
});
