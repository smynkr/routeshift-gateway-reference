import { describe, expect, it, vi, beforeEach } from 'vitest';

// vi.hoisted (not a plain top-level const) so this is guaranteed initialized
// before vitest invokes the vi.mock factories below -- the factories
// reference these, and vi.mock calls are hoisted above regular const
// declarations. See src/oauth/sso-device-service.test.ts for the same
// established pattern in this codebase.
const { queryMock, connectMock } = vi.hoisted(() => {
  const queryMock = vi.fn();
  const releaseMock = vi.fn();
  const connectMock = vi.fn(() => ({ query: queryMock, release: releaseMock }));
  return { queryMock, connectMock };
});
vi.mock('../db/pool.js', () => ({ getPool: () => ({ connect: connectMock }) }));

const { invalidateKeyCacheMock, generateApiKeyMock } = vi.hoisted(() => ({
  invalidateKeyCacheMock: vi.fn(),
  generateApiKeyMock: vi.fn(() => ({ key: 'sk-proxy-live_team_abc123', hash: 'hash-abc', prefix: 'sk-proxy-live_team' })),
}));
vi.mock('../auth/api-key.js', () => ({
  generateApiKey: generateApiKeyMock,
  invalidateKeyCache: invalidateKeyCacheMock,
}));

const { recordAuditEventMock } = vi.hoisted(() => ({ recordAuditEventMock: vi.fn() }));
vi.mock('../auth/audit-events.js', () => ({ recordAuditEvent: recordAuditEventMock }));

import { mintSsoKey, AuthorizationNotConsumableError } from './sso-key-mint.js';

describe('mintSsoKey', () => {
  beforeEach(() => {
    queryMock.mockReset();
    connectMock.mockClear();
    invalidateKeyCacheMock.mockReset();
    generateApiKeyMock.mockClear();
    recordAuditEventMock.mockReset();
  });

  it('when no prior live SSO key exists: mints, consumes the auth row, no revoke/invalidate calls', async () => {
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'approved' }] }) // SELECT device_authorizations FOR UPDATE -> approved
      .mockResolvedValueOnce({ rows: [] }) // SELECT prior live key -> none
      .mockResolvedValueOnce({ rows: [{ id: 'key-new' }] }) // INSERT api_keys
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE device_authorizations consumed
      .mockResolvedValueOnce(undefined); // COMMIT

    const result = await mintSsoKey({
      teamId: 'team-a', email: 'alice@example.com', authorizationId: 'auth-1',
    });

    expect(result.key).toBe('sk-proxy-live_team_abc123');
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(invalidateKeyCacheMock).not.toHaveBeenCalled();
    const consumeSql = String(queryMock.mock.calls[4]![0]);
    expect(consumeSql).toContain("status = 'consumed'");
  });

  it('when a prior live SSO key exists: revokes it, invalidates its cache entry, mints the new one', async () => {
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'approved' }] }) // SELECT device_authorizations FOR UPDATE -> approved
      .mockResolvedValueOnce({ rows: [{ id: 'key-old', key_hash: 'hash-old' }] }) // SELECT prior -> found
      .mockResolvedValueOnce(undefined) // UPDATE api_keys SET revoked_at
      .mockResolvedValueOnce({ rows: [{ id: 'key-new' }] }) // INSERT api_keys
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE device_authorizations consumed
      .mockResolvedValueOnce(undefined); // COMMIT

    await mintSsoKey({ teamId: 'team-a', email: 'alice@example.com', authorizationId: 'auth-1' });

    expect(invalidateKeyCacheMock).toHaveBeenCalledWith('hash-old');
    const revokeSql = String(queryMock.mock.calls[3]![0]);
    expect(revokeSql).toContain('revoked_at');
  });

  it('records a "revoked" audit event for the prior key it supersedes (RSH-100 review fix: the silent revoke had no audit trail)', async () => {
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'approved' }] }) // SELECT device_authorizations FOR UPDATE -> approved
      .mockResolvedValueOnce({ rows: [{ id: 'key-old', key_hash: 'hash-old', key_prefix: 'sk-proxy-live_old' }] }) // SELECT prior -> found
      .mockResolvedValueOnce(undefined) // UPDATE api_keys SET revoked_at
      .mockResolvedValueOnce({ rows: [{ id: 'key-new' }] }) // INSERT api_keys
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE device_authorizations consumed
      .mockResolvedValueOnce(undefined); // COMMIT

    await mintSsoKey({ teamId: 'team-a', email: 'alice@example.com', authorizationId: 'auth-1' });

    const events = recordAuditEventMock.mock.calls.map((c) => c[0]);
    const revoked = events.find((e) => e.event_type === 'revoked');
    expect(revoked).toBeDefined();
    expect(revoked).toMatchObject({ team_id: 'team-a', api_key_id: 'key-old', key_prefix: 'sk-proxy-live_old' });
    // The new key's issuance event is still recorded too.
    expect(events.some((e) => e.event_type === 'sso_issued')).toBe(true);
  });

  it('retries on a losing race against the one-live-key unique index (23505)', async () => {
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN (attempt 1)
      .mockResolvedValueOnce({ rows: [{ status: 'approved' }] }) // SELECT device_authorizations (attempt 1) -> approved
      .mockResolvedValueOnce({ rows: [] }) // SELECT prior -> none (attempt 1, raced)
      .mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505' })) // INSERT loses the race
      .mockResolvedValueOnce(undefined) // ROLLBACK
      .mockResolvedValueOnce(undefined) // BEGIN (attempt 2)
      .mockResolvedValueOnce({ rows: [{ status: 'approved' }] }) // SELECT device_authorizations (attempt 2) -> still approved
      .mockResolvedValueOnce({ rows: [{ id: 'key-winner', key_hash: 'hash-winner' }] }) // SELECT prior -> now sees the winner
      .mockResolvedValueOnce(undefined) // UPDATE api_keys revoke winner
      .mockResolvedValueOnce({ rows: [{ id: 'key-new' }] }) // INSERT succeeds
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE device_authorizations consumed
      .mockResolvedValueOnce(undefined); // COMMIT

    const result = await mintSsoKey({ teamId: 'team-a', email: 'alice@example.com', authorizationId: 'auth-1' });

    expect(result.key).toBe('sk-proxy-live_team_abc123');
    expect(invalidateKeyCacheMock).toHaveBeenCalledWith('hash-winner');
  });

  it('sets expires_at to SSO_KEY_TTL_HOURS from now and stamps metadata.issued_via', async () => {
    queryMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ status: 'approved' }] }) // SELECT device_authorizations FOR UPDATE -> approved
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'key-new' }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce(undefined);

    await mintSsoKey({ teamId: 'team-a', email: 'alice@example.com', authorizationId: 'auth-1' });

    const [, insertParams] = queryMock.mock.calls[3]!;
    const metadataParam = insertParams.find((p: unknown) => typeof p === 'object' && p !== null && 'issued_via' in (p as object));
    expect(metadataParam).toMatchObject({ issued_via: 'sso_device_flow', email: 'alice@example.com' });
  });

  it('exhausts all retries when every attempt loses the race (23505) and throws mentioning retry count + team id', async () => {
    const MAX_RETRIES = 6; // must match sso-key-mint.ts
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      queryMock
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [{ status: 'approved' }] }) // SELECT device_authorizations -> approved
        .mockResolvedValueOnce({ rows: [] }) // SELECT prior -> none
        // mockRejectedValueOnce (lazy) rather than mockResolvedValueOnce(Promise.reject(...))
        // (eager) -- eagerly constructing 6 rejected promises up front before
        // they're awaited trips Node's unhandled-rejection detector.
        .mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505' })) // INSERT loses the race
        .mockResolvedValueOnce(undefined); // ROLLBACK
    }

    await expect(
      mintSsoKey({ teamId: 'team-a', email: 'alice@example.com', authorizationId: 'auth-1' }),
    ).rejects.toThrow(
      `mintSsoKey: exceeded ${MAX_RETRIES} retries against the one-live-key index for team=team-a`,
    );
  });

  it('propagates a non-23505 DB error immediately without retrying or swallowing it', async () => {
    const dbError = new Error('connection lost');
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'approved' }] }) // SELECT device_authorizations -> approved
      .mockResolvedValueOnce({ rows: [] }) // SELECT prior -> none
      .mockRejectedValueOnce(dbError) // INSERT fails with a generic (non-23505) error
      .mockResolvedValueOnce(undefined); // ROLLBACK

    await expect(
      mintSsoKey({ teamId: 'team-a', email: 'alice@example.com', authorizationId: 'auth-1' }),
    ).rejects.toBe(dbError);

    // Only one attempt's worth of queries should have run -- no retry.
    expect(queryMock).toHaveBeenCalledTimes(5);
  });

  it('throws AuthorizationNotConsumableError and mints nothing when the authorization is already consumed', async () => {
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ status: 'consumed' }] }) // SELECT device_authorizations FOR UPDATE -> already consumed
      .mockResolvedValueOnce(undefined); // ROLLBACK

    await expect(
      mintSsoKey({ teamId: 'team-a', email: 'alice@example.com', authorizationId: 'auth-1' }),
    ).rejects.toThrow(AuthorizationNotConsumableError);

    expect(generateApiKeyMock).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledTimes(3); // BEGIN, SELECT, ROLLBACK -- never reached the api_keys SELECT/INSERT
  });

  it('throws AuthorizationNotConsumableError and mints nothing when the authorization id does not exist', async () => {
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT device_authorizations FOR UPDATE -> no rows
      .mockResolvedValueOnce(undefined); // ROLLBACK

    await expect(
      mintSsoKey({ teamId: 'team-a', email: 'alice@example.com', authorizationId: 'missing-auth' }),
    ).rejects.toThrow(/missing-auth/);

    expect(generateApiKeyMock).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledTimes(3);
  });

  it('fails closed when the team was suspended after approval and before minting', async () => {
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // JOIN teams filters the suspended team out
      .mockResolvedValueOnce(undefined); // ROLLBACK

    await expect(
      mintSsoKey({ teamId: 'team-suspended', email: 'alice@example.com', authorizationId: 'auth-1' }),
    ).rejects.toThrow(AuthorizationNotConsumableError);

    expect(generateApiKeyMock).not.toHaveBeenCalled();
    const [sql, params] = queryMock.mock.calls[1]!;
    expect(String(sql)).toContain('JOIN teams');
    expect(String(sql)).toContain('t.is_suspended = false');
    expect(String(sql)).toContain('FOR UPDATE OF da, t');
    expect(params).toEqual(['auth-1', 'team-suspended']);
  });
});
