// RSH-60 #16: reconciliation sweep for orphaned OAuth-device keys.
//
// The dashboard's /api/oauth/token mints the proxy key (POST /admin/keys) BEFORE
// recording it in key_identities (attachMintedKey). If the process dies or the
// 200 is lost between those two steps, the freshly minted key is live and
// full-access but has no key_identities row — invisible to the admin identity
// view and only cleaned up when its 30-day TTL lapses. Each failed delivery
// leaks one more. This periodic sweep revokes such orphans once they are older
// than the device-code TTL, bounding orphan lifetime to one sweep interval.
//
// Replica-safe via pg_try_advisory_xact_lock(ORPHAN_SWEEP_LOCK_ID) — distinct
// from savings(1), session-aggregator(2), optimize/yield(3).

import { getPool } from '../db/pool.js';

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// Comfortably past the 10-minute device-code TTL: any legitimate mint→attach
// completes within one request, so anything still unattached this long after
// creation is a genuine orphan, never an in-flight claim.
const ORPHAN_AGE_MIN = 15;
const ORPHAN_SWEEP_LOCK_ID = 4;
const SWEEP_BATCH_LIMIT = 500;

let timer: ReturnType<typeof setInterval> | null = null;

export function startOrphanKeySweeper(): void {
  // Defer the first run so startup migrations/other crons settle first.
  setTimeout(() => {
    void sweepOrphanedOAuthKeys();
  }, 10_000);
  timer = setInterval(() => {
    void sweepOrphanedOAuthKeys();
  }, SWEEP_INTERVAL_MS);
  timer.unref();
  console.log('[orphan-key-sweeper] started (5min interval)');
}

export function stopOrphanKeySweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Revoke OAuth-device-minted keys that were never attached to an identity and
 * are older than the device-code TTL. Uses the existing revoked_at lifecycle
 * (the single source of truth for key revocation), so a swept key stops
 * authenticating immediately. Returns the number revoked.
 */
export async function sweepOrphanedOAuthKeys(): Promise<{ revoked: number }> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const lock = await client.query<{ pg_try_advisory_xact_lock: boolean }>(
      'SELECT pg_try_advisory_xact_lock($1)',
      [ORPHAN_SWEEP_LOCK_ID],
    );
    if (!lock.rows[0]?.pg_try_advisory_xact_lock) {
      await client.query('ROLLBACK');
      return { revoked: 0 };
    }

    const res = await client.query<{ id: string }>(
      `
      UPDATE api_keys
      SET revoked_at = now()
      WHERE id IN (
        SELECT k.id
        FROM api_keys k
        LEFT JOIN key_identities ki ON ki.api_key_id = k.id
        WHERE k.revoked_at IS NULL
          AND k.metadata->>'created_via' = 'oauth_device'
          AND k.created_at < now() - make_interval(mins => $1)
          AND ki.api_key_id IS NULL
        LIMIT $2
      )
      RETURNING id
      `,
      [ORPHAN_AGE_MIN, SWEEP_BATCH_LIMIT],
    );

    await client.query('COMMIT');
    const revoked = res.rowCount ?? 0;
    if (revoked > 0) {
      console.log(`[orphan-key-sweeper] revoked ${revoked} orphaned oauth_device key(s)`);
    }
    return { revoked };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    console.error('[orphan-key-sweeper] error:', err);
    return { revoked: 0 };
  } finally {
    client.release();
  }
}
