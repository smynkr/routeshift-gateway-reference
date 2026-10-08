// RSH-100: mint an SSO-issued key. One transaction: lock + validate the
// device_authorizations row (exactly-once consume guard), revoke any
// existing live SSO key for this (team, email), mint the new one via the
// SAME generateApiKey()+INSERT path admin/keys.ts already uses, mark the
// device_authorizations row consumed.
//
// The actual serialization of "one live key per identity" is the partial
// unique index added in migration 046 (idx_api_keys_one_live_sso_per_identity),
// not the SELECT below -- FOR UPDATE only locks rows that already exist, so
// it can't prevent two concurrent first-time logins from both seeing "no
// prior key" and both inserting. On a losing race (23505 on the INSERT),
// retry: the winner's row is now visible, revoke it, mint again. This
// mirrors "old key stops working, new key takes over" semantics from
// handleRotateKey, just triggered by re-login instead of an explicit
// rotate call.
//
// Empirically (real Postgres 15 repro, N concurrent first-time logins for
// the same identity), each contention round resolves exactly one
// contender -- so N-way contention needs up to N-1 retries in the worst
// case, not O(1). MAX_RETRIES is sized with headroom for that, and a small
// random backoff between attempts (not before the first) spreads retries
// out instead of hammering the shared connection pool (db/pool.ts max: 10)
// all at once.
import { randomUUID } from 'node:crypto';
import { getPool } from '../db/pool.js';
import { generateApiKey, invalidateKeyCache } from '../auth/api-key.js';
import { recordAuditEvent } from '../auth/audit-events.js';
import { SSO_KEY_TTL_HOURS } from './sso-device-flow.js';

const MAX_RETRIES = 6;

export interface MintSsoKeyInput {
  teamId: string;
  email: string;
  authorizationId: string;
}

export interface MintedSsoKey {
  id: string;
  key: string;
  prefix: string;
  expiresAt: Date;
}

// Thrown when the device_authorizations row backing this mint attempt isn't
// in a mintable state (missing, or status !== 'approved' -- e.g. already
// consumed by a prior mint, or denied/expired). This is the "consume
// exactly once" guard: a second mint call for the same authorizationId
// (retried HTTP request, caller-side race, future polling-endpoint bug)
// must never mint a second key. It is NOT a 23505 and must propagate
// immediately out of mintSsoKey without retrying -- an unconsumable
// authorization will never become consumable by trying again.
export class AuthorizationNotConsumableError extends Error {
  constructor(public readonly authorizationId: string, public readonly status: string) {
    super(`mintSsoKey: device_authorizations row ${authorizationId} is not consumable (status=${status})`);
    this.name = 'AuthorizationNotConsumableError';
  }
}

export async function mintSsoKey(input: MintSsoKeyInput): Promise<MintedSsoKey> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // Small random backoff between retries (not before the first
      // attempt) to reduce thundering-herd pressure on the shared,
      // process-wide connection pool when several contenders are all
      // retrying at once.
      await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 40));
    }
    const result = await tryMintOnce(input);
    if (result) return result;
    // 23505 on the INSERT: another concurrent login for the same identity
    // won the race between our SELECT and our INSERT. Loop and retry --
    // the next attempt's SELECT will see the winner's row and revoke it.
  }
  throw new Error(`mintSsoKey: exceeded ${MAX_RETRIES} retries against the one-live-key index for team=${input.teamId}`);
}

interface TryMintOutcome extends MintedSsoKey {
  priorKey?: { id: string; key_hash: string; key_prefix: string };
}

async function tryMintOnce(input: MintSsoKeyInput): Promise<MintedSsoKey | null> {
  const pool = getPool();
  const client = await pool.connect();
  let outcome: TryMintOutcome;
  try {
    await client.query('BEGIN');

    // Lock and validate the device_authorizations row FIRST, before any
    // key-minting work happens, so this actually gates the mint instead of
    // being an unchecked UPDATE at the end. FOR UPDATE within this same
    // transaction means a concurrent mintSsoKey call for the same
    // authorizationId blocks here until we COMMIT/ROLLBACK, at which point
    // it will see status='consumed' (or the row gone) and throw instead of
    // minting a second key.
    const { rows: authRows } = await client.query<{ status: string }>(
      `SELECT da.status
         FROM device_authorizations da
         JOIN teams t ON t.id = da.team_id
        WHERE da.id = $1 AND da.team_id = $2 AND t.is_suspended = false
        FOR UPDATE OF da, t`,
      [input.authorizationId, input.teamId],
    );
    const authRow = authRows[0];
    if (!authRow || authRow.status !== 'approved') {
      throw new AuthorizationNotConsumableError(input.authorizationId, authRow ? authRow.status : 'not found');
    }

    const { rows: priorRows } = await client.query<{ id: string; key_hash: string; key_prefix: string }>(
      `SELECT id, key_hash, key_prefix FROM api_keys
        WHERE team_id = $1 AND lower(metadata->>'email') = lower($2)
          AND metadata->>'issued_via' = 'sso_device_flow' AND revoked_at IS NULL
        FOR UPDATE`,
      [input.teamId, input.email],
    );
    const priorKey = priorRows[0];
    if (priorKey) {
      await client.query(`UPDATE api_keys SET revoked_at = now() WHERE id = $1`, [priorKey.id]);
    }

    const { key, hash, prefix } = generateApiKey(input.teamId, 'live');
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + SSO_KEY_TTL_HOURS * 60 * 60 * 1000);
    const metadata = { layer_identity_id: input.email, email: input.email, issued_via: 'sso_device_flow' };

    await client.query(
      `INSERT INTO api_keys (id, team_id, key_hash, key_prefix, name, environment, metadata, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'live', $6, $7)`,
      [id, input.teamId, hash, prefix, `SSO key (${input.email})`, metadata, expiresAt],
    );

    // The status='approved' predicate is redundant given the FOR UPDATE
    // lock+check above (same transaction), but kept as harmless
    // defense-in-depth.
    await client.query(
      `UPDATE device_authorizations SET status = 'consumed', consumed_at = now() WHERE id = $1 AND status = 'approved'`,
      [input.authorizationId],
    );

    await client.query('COMMIT');

    outcome = { id, key, prefix, expiresAt, priorKey };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    if (err instanceof AuthorizationNotConsumableError) {
      throw err; // never retry -- an unconsumable authorization stays unconsumable
    }
    if ((err as { code?: string }).code === '23505') {
      return null; // signal retry
    }
    throw err;
  } finally {
    client.release();
  }

  // Deliberately outside the try/catch-with-rollback above: neither call
  // can synchronously throw, but structurally keeping them out of the
  // rollback-catching block avoids a footgun where a future edit adds a
  // throwing call here and it gets misinterpreted as a mint failure.
  if (outcome.priorKey) {
    invalidateKeyCache(outcome.priorKey.key_hash);
    // Record the supersession so the prior key's revocation has an audit
    // trail: without this, an admin investigating why a running agent's key
    // suddenly stopped working finds no 'revoked' event and hunts for a
    // non-existent outage instead of the re-login that replaced it. Mirrors
    // the 'revoked' event the explicit revoke/rotate admin paths already emit.
    void recordAuditEvent({
      team_id: input.teamId,
      api_key_id: outcome.priorKey.id,
      key_prefix: outcome.priorKey.key_prefix,
      event_type: 'revoked',
      details: { email: input.email, reason: 'superseded_by_sso_reauth' },
    });
  }

  void recordAuditEvent({
    team_id: input.teamId,
    api_key_id: outcome.id,
    key_prefix: outcome.prefix,
    event_type: 'sso_issued',
    details: { email: input.email },
  });

  return { id: outcome.id, key: outcome.key, prefix: outcome.prefix, expiresAt: outcome.expiresAt };
}
