// RTSH-1: the device-flow state machine + persistence, with the pg pool and
// clock injected so the whole thing is unit-testable without Next.js or a live
// database. Route handlers stay thin wrappers over these functions.

import { randomUUID } from 'node:crypto';
import type { Queryable } from './db-types';
import {
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEVICE_CODE_TTL_SECONDS,
  type DeviceCodeResponse,
  formatUserCode,
  generateDeviceCode,
  generateUserCode,
  hashDeviceCode,
  isExpired,
  isPolledTooSoon,
  normalizeUserCode,
} from './oauth-device';

export interface DeviceAuthRow {
  id: string;
  device_code_hash: string;
  user_code: string;
  client_id: string;
  client_name: string;
  scope: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  team_id: string | null;
  user_id: string | null;
  user_email: string | null;
  api_key_id: string | null;
  interval_seconds: number;
  last_polled_at: Date | null;
  approved_at: Date | null;
  expires_at: Date;
  created_at: Date;
}

export interface CreateDeviceAuthInput {
  clientId: string;
  clientName: string;
  scope: string;
}

/**
 * POST /oauth/device/code. Persists a new pending authorization and returns
 * the RFC 8628 response. The raw device_code is returned to the caller exactly
 * once here and never stored — only its hash is persisted.
 */
export async function createDeviceAuthorization(
  pool: Queryable,
  input: CreateDeviceAuthInput,
  baseUrl: string,
  now: Date = new Date(),
): Promise<DeviceCodeResponse> {
  const deviceCode = generateDeviceCode();
  const userCode = generateUserCode();
  const expiresAt = new Date(now.getTime() + DEVICE_CODE_TTL_SECONDS * 1000);
  const id = randomUUID();

  await pool.query(
    `INSERT INTO oauth_device_authorizations
       (id, device_code_hash, user_code, client_id, client_name, scope,
        status, interval_seconds, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)`,
    [
      id,
      hashDeviceCode(deviceCode),
      userCode,
      input.clientId,
      input.clientName,
      input.scope,
      DEFAULT_POLL_INTERVAL_SECONDS,
      expiresAt,
    ],
  );

  const trimmedBase = baseUrl.replace(/\/+$/, '');
  const verificationUri = `${trimmedBase}/device`;
  return {
    device_code: deviceCode,
    user_code: formatUserCode(userCode),
    verification_uri: verificationUri,
    verification_uri_complete: `${verificationUri}?user_code=${userCode}`,
    expires_in: DEVICE_CODE_TTL_SECONDS,
    interval: DEFAULT_POLL_INTERVAL_SECONDS,
  };
}

/** Look up a (still pending) authorization for the verification page. */
export async function getAuthorizationByUserCode(
  pool: Queryable,
  userCodeInput: string,
): Promise<DeviceAuthRow | null> {
  const userCode = normalizeUserCode(userCodeInput);
  if (!userCode) return null;
  const { rows } = await pool.query(
    `SELECT * FROM oauth_device_authorizations WHERE user_code = $1 LIMIT 1`,
    [userCode],
  );
  return (rows[0] as DeviceAuthRow) ?? null;
}

export type ApproveResult = 'approved' | 'not_found' | 'expired' | 'already_resolved';

/**
 * Mark a pending authorization approved and attach the approving identity.
 * Caller MUST have already authenticated the user and enforced the allowlist.
 * Minting is deferred to the token poll, so no secret is created here.
 */
export async function approveAuthorization(
  pool: Queryable,
  args: { userCodeInput: string; teamId: string; userId: string; userEmail: string },
  now: Date = new Date(),
): Promise<ApproveResult> {
  const row = await getAuthorizationByUserCode(pool, args.userCodeInput);
  if (!row) return 'not_found';
  if (row.status !== 'pending') return 'already_resolved';
  if (isExpired(new Date(row.expires_at), now)) {
    await markExpired(pool, row.id);
    return 'expired';
  }
  // Conditional update guards against a TOCTOU race with a concurrent
  // approve/deny on the same code.
  const { rowCount } = await pool.query(
    `UPDATE oauth_device_authorizations
        SET status = 'approved', team_id = $2, user_id = $3,
            user_email = $4, approved_at = $5
      WHERE id = $1 AND status = 'pending'`,
    [row.id, args.teamId, args.userId, args.userEmail, now],
  );
  return rowCount === 1 ? 'approved' : 'already_resolved';
}

export type DenyResult = 'denied' | 'not_found' | 'already_resolved';

export async function denyAuthorization(
  pool: Queryable,
  userCodeInput: string,
): Promise<DenyResult> {
  const row = await getAuthorizationByUserCode(pool, userCodeInput);
  if (!row) return 'not_found';
  if (row.status !== 'pending') return 'already_resolved';
  const { rowCount } = await pool.query(
    `UPDATE oauth_device_authorizations
        SET status = 'denied'
      WHERE id = $1 AND status = 'pending'`,
    [row.id],
  );
  return rowCount === 1 ? 'denied' : 'already_resolved';
}

export type TokenPollOutcome =
  | { status: 'authorization_pending' }
  | { status: 'slow_down' }
  | { status: 'expired_token' }
  | { status: 'access_denied' }
  | { status: 'ready_to_mint'; row: DeviceAuthRow }
  | { status: 'invalid_grant' };

/**
 * POST /oauth/token poll. Pure decision over current DB state; the caller is
 * responsible for the side-effecting mint when this returns `ready_to_mint`.
 * Records last_polled_at on every recognized poll so `slow_down` can be
 * detected on the next one.
 */
export async function pollToken(
  pool: Queryable,
  deviceCode: string,
  now: Date = new Date(),
): Promise<TokenPollOutcome> {
  const { rows } = await pool.query(
    `SELECT * FROM oauth_device_authorizations WHERE device_code_hash = $1 LIMIT 1`,
    [hashDeviceCode(deviceCode)],
  );
  const row = rows[0] as DeviceAuthRow | undefined;
  // Unknown device_code → invalid_grant (RFC 8628 §3.5).
  if (!row) return { status: 'invalid_grant' };

  // An explicit denial is a terminal user decision and takes precedence over
  // the window merely lapsing — report access_denied even if the row has since
  // passed its expires_at (RFC 8628 §3.5 distinguishes the two errors).
  if (row.status === 'denied') return { status: 'access_denied' };

  if (row.status === 'expired' || isExpired(new Date(row.expires_at), now)) {
    if (row.status !== 'expired') await markExpired(pool, row.id);
    return { status: 'expired_token' };
  }

  if (row.status === 'approved') {
    // Already redeemed once — a device_code is single-use.
    if (row.api_key_id) return { status: 'invalid_grant' };
    return { status: 'ready_to_mint', row };
  }

  // Still pending: enforce the polling cadence, then record this poll.
  const tooSoon = isPolledTooSoon(
    row.last_polled_at ? new Date(row.last_polled_at) : null,
    row.interval_seconds,
    now,
  );
  await pool.query(
    `UPDATE oauth_device_authorizations SET last_polled_at = $2 WHERE id = $1`,
    [row.id, now],
  );
  return tooSoon ? { status: 'slow_down' } : { status: 'authorization_pending' };
}

/**
 * Atomically claim the authorization for the key just minted. Returns true if
 * this caller won the claim; false means a concurrent poll already attached a
 * key (the caller should revoke the duplicate it minted). Also writes the
 * durable identity→key mapping.
 */
export async function attachMintedKey(
  pool: Queryable,
  authId: string,
  args: { apiKeyId: string; teamId: string; userId: string | null; email: string | null },
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE oauth_device_authorizations
        SET api_key_id = $2
      WHERE id = $1 AND status = 'approved' AND api_key_id IS NULL`,
    [authId, args.apiKeyId],
  );
  if (rowCount !== 1) return false;

  await pool.query(
    `INSERT INTO key_identities (api_key_id, team_id, user_id, email, created_via)
     VALUES ($1, $2, $3, $4, 'oauth_device')
     ON CONFLICT (api_key_id) DO NOTHING`,
    [args.apiKeyId, args.teamId, args.userId, args.email],
  );
  return true;
}

async function markExpired(pool: Queryable, id: string): Promise<void> {
  await pool.query(
    `UPDATE oauth_device_authorizations SET status = 'expired'
      WHERE id = $1 AND status = 'pending'`,
    [id],
  );
}
