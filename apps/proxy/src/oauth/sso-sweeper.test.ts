import { describe, expect, it, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
const connectMock = vi.fn(() => ({ query: queryMock, release: vi.fn() }));
vi.mock('../db/pool.js', () => ({ getPool: () => ({ connect: connectMock }) }));

const { invalidateKeyCacheMock } = vi.hoisted(() => ({ invalidateKeyCacheMock: vi.fn() }));
vi.mock('../auth/api-key.js', () => ({ invalidateKeyCache: invalidateKeyCacheMock }));

import { sweepExpiredSsoKeysAndStaleAuthorizations } from './sso-sweeper.js';

describe('sweepExpiredSsoKeysAndStaleAuthorizations', () => {
  beforeEach(() => {
    queryMock.mockReset();
    connectMock.mockClear();
    invalidateKeyCacheMock.mockReset();
  });

  it('revokes expired-but-unrevoked SSO keys and expires stale pending device_authorizations, then commits', async () => {
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ pg_try_advisory_xact_lock: true }] }) // lock acquired
      .mockResolvedValueOnce(undefined) // SAVEPOINT sso_keys_revoke
      .mockResolvedValueOnce({ rowCount: 2, rows: [{ key_hash: 'hash-one' }, { key_hash: 'hash-two' }] }) // UPDATE api_keys ... revoked
      .mockResolvedValueOnce(undefined) // RELEASE SAVEPOINT sso_keys_revoke
      .mockResolvedValueOnce(undefined) // SAVEPOINT sso_auth_expire
      .mockResolvedValueOnce({ rowCount: 3 }) // UPDATE device_authorizations ... expired
      .mockResolvedValueOnce(undefined) // RELEASE SAVEPOINT sso_auth_expire
      .mockResolvedValueOnce(undefined); // COMMIT

    const result = await sweepExpiredSsoKeysAndStaleAuthorizations();

    expect(result).toEqual({ keysRevoked: 2, authorizationsExpired: 3 });
    const sql = queryMock.mock.calls.map((c) => String(c[0]));
    expect(sql[0]).toContain('BEGIN');
    expect(sql[2]).toContain('SAVEPOINT sso_keys_revoke');
    expect(sql[3]).toContain('UPDATE api_keys');
    expect(sql[3]).toContain("issued_via' = 'sso_device_flow'");
    expect(sql[4]).toContain('RELEASE SAVEPOINT sso_keys_revoke');
    expect(sql[5]).toContain('SAVEPOINT sso_auth_expire');
    expect(sql[6]).toContain('UPDATE device_authorizations');
    expect(sql[6]).toContain("status IN ('pending', 'approved')");
    expect(sql[7]).toContain('RELEASE SAVEPOINT sso_auth_expire');
    expect(sql[8]).toContain('COMMIT');
    expect(sql[3]).toContain('RETURNING key_hash');
    expect(invalidateKeyCacheMock).toHaveBeenCalledTimes(2);
    expect(invalidateKeyCacheMock).toHaveBeenNthCalledWith(1, 'hash-one');
    expect(invalidateKeyCacheMock).toHaveBeenNthCalledWith(2, 'hash-two');
  });

  it('sweeps approved-but-abandoned rows too, not just pending ones -- an approved device_code past expires_at must not stay mintable forever', async () => {
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ pg_try_advisory_xact_lock: true }] }) // lock acquired
      .mockResolvedValueOnce(undefined) // SAVEPOINT sso_keys_revoke
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // UPDATE api_keys ... revoked
      .mockResolvedValueOnce(undefined) // RELEASE SAVEPOINT sso_keys_revoke
      .mockResolvedValueOnce(undefined) // SAVEPOINT sso_auth_expire
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE device_authorizations ... one approved row swept
      .mockResolvedValueOnce(undefined) // RELEASE SAVEPOINT sso_auth_expire
      .mockResolvedValueOnce(undefined); // COMMIT

    const result = await sweepExpiredSsoKeysAndStaleAuthorizations();

    expect(result).toEqual({ keysRevoked: 0, authorizationsExpired: 1 });
    const authUpdateCall = queryMock.mock.calls[6]!;
    const [sql, params] = authUpdateCall;
    expect(String(sql)).toContain('UPDATE device_authorizations');
    expect(String(sql)).toContain("status IN ('pending', 'approved')");
    expect(String(sql)).toContain('expires_at < now()');
    expect(params).toEqual([500]); // SWEEP_BATCH_LIMIT (not exported; kept in sync with sso-sweeper.ts)
  });

  it('rolls back and does nothing when the advisory lock is held by another replica', async () => {
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ pg_try_advisory_xact_lock: false }] }) // lock NOT acquired
      .mockResolvedValueOnce(undefined); // ROLLBACK

    const result = await sweepExpiredSsoKeysAndStaleAuthorizations();

    expect(result).toEqual({ keysRevoked: 0, authorizationsExpired: 0 });
    expect(queryMock).toHaveBeenCalledTimes(3);
    expect(String(queryMock.mock.calls[2]![0])).toContain('ROLLBACK');
  });

  it('rolls back and returns zeros on a connection-level error (lock query fails), without throwing', async () => {
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockRejectedValueOnce(new Error('connection reset')) // lock query fails
      .mockResolvedValueOnce(undefined); // ROLLBACK
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await sweepExpiredSsoKeysAndStaleAuthorizations();

    expect(result).toEqual({ keysRevoked: 0, authorizationsExpired: 0 });
  });

  it('isolates the two UPDATEs: a failure revoking SSO keys still lets the device_authorizations sweep run and commit', async () => {
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ pg_try_advisory_xact_lock: true }] }) // lock acquired
      .mockResolvedValueOnce(undefined) // SAVEPOINT sso_keys_revoke
      .mockRejectedValueOnce(new Error('lock timeout on api_keys')) // UPDATE api_keys fails
      .mockResolvedValueOnce(undefined) // ROLLBACK TO SAVEPOINT sso_keys_revoke
      .mockResolvedValueOnce(undefined) // SAVEPOINT sso_auth_expire
      .mockResolvedValueOnce({ rowCount: 3 }) // UPDATE device_authorizations succeeds
      .mockResolvedValueOnce(undefined) // RELEASE SAVEPOINT sso_auth_expire
      .mockResolvedValueOnce(undefined); // COMMIT
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await sweepExpiredSsoKeysAndStaleAuthorizations();

    // The failed api_keys UPDATE contributes 0, but the independent
    // device_authorizations UPDATE still ran and its result is returned --
    // the whole transaction still commits instead of being aborted.
    expect(result).toEqual({ keysRevoked: 0, authorizationsExpired: 3 });
    const sql = queryMock.mock.calls.map((c) => String(c[0]));
    expect(sql).toContain('ROLLBACK TO SAVEPOINT sso_keys_revoke');
    expect(sql[sql.length - 1]).toContain('COMMIT');
    expect(invalidateKeyCacheMock).not.toHaveBeenCalled();
  });

  it('isolates the two UPDATEs: a failure expiring device_authorizations does not lose the SSO key revocation result', async () => {
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ pg_try_advisory_xact_lock: true }] }) // lock acquired
      .mockResolvedValueOnce(undefined) // SAVEPOINT sso_keys_revoke
      .mockResolvedValueOnce({ rowCount: 5, rows: [{ key_hash: 'hash-one' }] }) // UPDATE api_keys succeeds
      .mockResolvedValueOnce(undefined) // RELEASE SAVEPOINT sso_keys_revoke
      .mockResolvedValueOnce(undefined) // SAVEPOINT sso_auth_expire
      .mockRejectedValueOnce(new Error('deadlock on device_authorizations')) // UPDATE fails
      .mockResolvedValueOnce(undefined) // ROLLBACK TO SAVEPOINT sso_auth_expire
      .mockResolvedValueOnce(undefined); // COMMIT
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await sweepExpiredSsoKeysAndStaleAuthorizations();

    expect(result).toEqual({ keysRevoked: 5, authorizationsExpired: 0 });
    const sql = queryMock.mock.calls.map((c) => String(c[0]));
    expect(sql).toContain('ROLLBACK TO SAVEPOINT sso_auth_expire');
    expect(sql[sql.length - 1]).toContain('COMMIT');
    expect(invalidateKeyCacheMock).toHaveBeenCalledWith('hash-one');
  });

  it('does not invalidate a key cache entry when the transaction cannot commit', async () => {
    queryMock
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ pg_try_advisory_xact_lock: true }] }) // lock acquired
      .mockResolvedValueOnce(undefined) // SAVEPOINT sso_keys_revoke
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ key_hash: 'hash-uncommitted' }] }) // UPDATE api_keys succeeds
      .mockResolvedValueOnce(undefined) // RELEASE SAVEPOINT sso_keys_revoke
      .mockResolvedValueOnce(undefined) // SAVEPOINT sso_auth_expire
      .mockResolvedValueOnce({ rowCount: 0 }) // UPDATE device_authorizations succeeds
      .mockResolvedValueOnce(undefined) // RELEASE SAVEPOINT sso_auth_expire
      .mockRejectedValueOnce(new Error('commit failed')) // COMMIT
      .mockResolvedValueOnce(undefined); // outer ROLLBACK
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await sweepExpiredSsoKeysAndStaleAuthorizations();

    expect(result).toEqual({ keysRevoked: 0, authorizationsExpired: 0 });
    expect(invalidateKeyCacheMock).not.toHaveBeenCalled();
    expect(String(queryMock.mock.calls.at(-1)?.[0])).toContain('ROLLBACK');
  });
});
