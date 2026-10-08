// RSH-100: periodic sweep closing two gaps confirmed during spec review
// (both verified against the real code, not assumed):
//
// 1. orphan-key-sweeper.ts only reaps oauth_device keys with no
//    key_identities row -- it has no expires_at condition and never
//    touches issued_via='sso_device_flow' rows. Without this, an expired
//    SSO key stays revoked_at IS NULL forever -- hygiene: keeps
//    admin-facing key state accurate and the identity index clean.
// 2. The status='pending' partial unique index on device_authorizations
//    .user_code (see migration 046) only stays correct if abandoned pending
//    rows leave 'pending'. This sweep also expires abandoned approved rows
//    before a stale authorization can remain mintable indefinitely.
//
// Structure mirrors orphan-key-sweeper.ts: advisory lock (a DIFFERENT lock
// id -- 6, since savings-reporter.ts uses 1, session-aggregator.ts uses 2,
// yield-correlator.ts uses 3, orphan-key-sweeper.ts uses 4, and
// optimize/engine.ts already uses 5), batch limit, one transaction.
import { getPool } from '../db/pool.js';
import { invalidateKeyCache } from '../auth/api-key.js';

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const SSO_SWEEP_LOCK_ID = 6;
const SWEEP_BATCH_LIMIT = 500;

let timer: ReturnType<typeof setInterval> | null = null;

export function startSsoSweeper(): void {
  setTimeout(() => {
    void sweepExpiredSsoKeysAndStaleAuthorizations();
  }, 10_000);
  timer = setInterval(() => {
    void sweepExpiredSsoKeysAndStaleAuthorizations();
  }, SWEEP_INTERVAL_MS);
  timer.unref();
  console.log('[sso-sweeper] started (5min interval)');
}

export function stopSsoSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export async function sweepExpiredSsoKeysAndStaleAuthorizations(): Promise<{
  keysRevoked: number;
  authorizationsExpired: number;
}> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const lock = await client.query<{ pg_try_advisory_xact_lock: boolean }>(
      'SELECT pg_try_advisory_xact_lock($1)',
      [SSO_SWEEP_LOCK_ID],
    );
    if (!lock.rows[0]?.pg_try_advisory_xact_lock) {
      await client.query('ROLLBACK');
      return { keysRevoked: 0, authorizationsExpired: 0 };
    }

    // Each UPDATE gets its own error boundary (via a SAVEPOINT) so a fault
    // in one table's cleanup can't starve the other. A plain try/catch
    // around each query is not enough on its own: once any statement in a
    // Postgres transaction errors, the whole transaction is aborted and
    // every later statement -- including the other UPDATE and the final
    // COMMIT -- is rejected until a ROLLBACK happens. The SAVEPOINT lets us
    // roll back just the failed UPDATE and keep the shared transaction (and
    // its advisory lock) usable for the other, independent job.
    let keysRevoked = 0;
    let revokedKeyHashes: string[] = [];
    try {
      await client.query('SAVEPOINT sso_keys_revoke');
      const keysRes = await client.query<{ key_hash: string }>(
        `
        UPDATE api_keys
        SET revoked_at = now()
        WHERE id IN (
          SELECT id FROM api_keys
          WHERE revoked_at IS NULL
            AND metadata->>'issued_via' = 'sso_device_flow'
            AND expires_at IS NOT NULL
            AND expires_at < now()
          LIMIT $1
        )
        RETURNING key_hash
        `,
        [SWEEP_BATCH_LIMIT],
      );
      keysRevoked = keysRes.rowCount ?? 0;
      revokedKeyHashes = keysRes.rows.map(({ key_hash }) => key_hash);
      await client.query('RELEASE SAVEPOINT sso_keys_revoke');
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT sso_keys_revoke');
      console.error('[sso-sweeper] error revoking expired SSO keys:', err);
    }

    let authorizationsExpired = 0;
    try {
      await client.query('SAVEPOINT sso_auth_expire');
      const authRes = await client.query(
        `
        UPDATE device_authorizations
        SET status = 'expired'
        WHERE id IN (
          SELECT id FROM device_authorizations
          WHERE status IN ('pending', 'approved')
            AND expires_at < now()
          LIMIT $1
        )
        `,
        [SWEEP_BATCH_LIMIT],
      );
      authorizationsExpired = authRes.rowCount ?? 0;
      await client.query('RELEASE SAVEPOINT sso_auth_expire');
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT sso_auth_expire');
      console.error('[sso-sweeper] error expiring stale device_authorizations:', err);
    }

    await client.query('COMMIT');
    for (const keyHash of revokedKeyHashes) invalidateKeyCache(keyHash);
    if (keysRevoked > 0 || authorizationsExpired > 0) {
      console.log(
        `[sso-sweeper] revoked ${keysRevoked} expired SSO key(s), expired ${authorizationsExpired} stale device authorization(s)`,
      );
    }
    return { keysRevoked, authorizationsExpired };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    console.error('[sso-sweeper] error:', err);
    return { keysRevoked: 0, authorizationsExpired: 0 };
  } finally {
    client.release();
  }
}
