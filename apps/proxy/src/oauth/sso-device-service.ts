// apps/proxy/src/oauth/sso-device-service.ts
// RSH-100: device_authorizations state machine. Pool and clock injected
// for unit-testability without a live database -- same shape as
// apps/dashboard/lib/oauth-device-service.ts, extended for home-realm
// discovery at creation (team_id is resolved here, not deferred to
// approval) and for oauth_state/nonce binding + the 'denied' status.
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { resolveIdpConfigByDomain, type ResolvedIdpConfig } from './sso-connections.js';
import {
  DEVICE_CODE_TTL_SECONDS,
  DEFAULT_POLL_INTERVAL_SECONDS,
  type DeviceCodeResponse,
  formatUserCode,
  generateDeviceCode,
  generateOAuthState,
  generateUserCode,
  hashDeviceCode,
  isExpired,
  isPolledTooSoon,
  normalizeUserCode,
} from './sso-device-flow.js';

type Queryable = Pool | PoolClient;

export class DomainNotRegisteredError extends Error {
  constructor() {
    super("your organization hasn't enabled RouteShift SSO login");
    this.name = 'DomainNotRegisteredError';
  }
}

// Deliberately returns null (never throws) for anything that isn't a
// plausible domain -- the caller maps both "malformed input" and "well-formed
// but unregistered domain" to the same DomainNotRegisteredError, so this
// can't be used to distinguish "your email is malformed" from "your domain
// isn't registered" (no enumeration signal).
function emailOrDomainToLoginDomain(emailOrDomain: string): string | null {
  const trimmed = emailOrDomain.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  const domain = at >= 0 ? trimmed.slice(at + 1) : trimmed;
  if (!domain || !domain.includes('.') || domain.includes('@')) return null;
  return domain;
}

export interface CreateSsoDeviceAuthResult {
  response: DeviceCodeResponse;
  idpConfig: ResolvedIdpConfig;
}

// user_code collisions against idx_device_auth_user_code (migration 046's
// partial unique index, WHERE status = 'pending') are astronomically
// unlikely -- 8 chars over a 29-symbol alphabet -- but not impossible, and
// an unhandled 23505 here would otherwise surface as an uncaught 500 to a
// legitimate user. Mirrors sso-key-mint.ts's mintSsoKey retry-on-collision
// posture. 3 attempts is plenty given the collision odds.
const MAX_USER_CODE_RETRIES = 3;

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/** POST /oauth/device/code. Resolves team_id via home-realm discovery
 * BEFORE issuing anything -- redirecting to the correct IdP requires
 * already knowing the team. Fails the same generic way for an
 * unregistered domain and a malformed email, so this can't be used to
 * enumerate which domains are registered. */
export async function createSsoDeviceAuthorization(
  pool: Queryable,
  emailOrDomain: string,
  baseUrl: string,
  now: Date = new Date(),
): Promise<CreateSsoDeviceAuthResult> {
  const loginDomain = emailOrDomainToLoginDomain(emailOrDomain);
  if (!loginDomain) throw new DomainNotRegisteredError();

  const idpConfig = await resolveIdpConfigByDomain(loginDomain);
  if (!idpConfig) throw new DomainNotRegisteredError();

  const expiresAt = new Date(now.getTime() + DEVICE_CODE_TTL_SECONDS * 1000);

  for (let attempt = 0; attempt < MAX_USER_CODE_RETRIES; attempt++) {
    // Regenerated on every attempt -- including device_code, for
    // consistency, even though only user_code can actually collide (device
    // code is a 32-byte random hex string, its hash is UNIQUE too but a
    // collision there is cryptographically negligible).
    const deviceCode = generateDeviceCode();
    const userCode = generateUserCode();
    const id = randomUUID();

    try {
      await pool.query(
        `INSERT INTO device_authorizations
           (id, device_code_hash, user_code, team_id, idp_config_id, status, interval_seconds, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)`,
        [id, hashDeviceCode(deviceCode), userCode, idpConfig.teamId, idpConfig.id, DEFAULT_POLL_INTERVAL_SECONDS, expiresAt],
      );
    } catch (err) {
      if (isUniqueViolation(err) && attempt < MAX_USER_CODE_RETRIES - 1) {
        continue; // regenerate and retry
      }
      throw err;
    }

    const trimmedBase = baseUrl.replace(/\/+$/, '');
    const verificationUri = `${trimmedBase}/oauth/device/verify`;
    return {
      idpConfig,
      response: {
        device_code: deviceCode,
        user_code: formatUserCode(userCode),
        verification_uri: verificationUri,
        verification_uri_complete: `${verificationUri}?user_code=${userCode}`,
        expires_in: DEVICE_CODE_TTL_SECONDS,
        interval: DEFAULT_POLL_INTERVAL_SECONDS,
      },
    };
  }
  throw new Error('createSsoDeviceAuthorization: exceeded retries generating a unique user_code');
}

export interface DeviceAuthRow {
  id: string;
  team_id: string;
  idp_config_id: string;
  status: 'pending' | 'approved' | 'denied' | 'consumed' | 'expired';
  verified_email: string | null;
  expires_at: Date;
  last_polled_at: Date | null;
  interval_seconds: number;
}

/** Look up a still-pending authorization for the verification page.
 * Scoped to status='pending' -- an abandoned row that's aged past its
 * expires_at but hasn't been swept yet must not be matched here (that's
 * what the sweeper's job is; this lookup doesn't re-check expires_at
 * itself, it just refuses to match anything not currently pending). */
export async function getAuthorizationByUserCode(pool: Queryable, userCodeInput: string): Promise<DeviceAuthRow | null> {
  const userCode = normalizeUserCode(userCodeInput);
  if (!userCode) return null;
  const { rows } = await pool.query(
    `SELECT id, team_id, idp_config_id, status, verified_email, expires_at, last_polled_at, interval_seconds
       FROM device_authorizations
      WHERE user_code = $1 AND status = 'pending'
      LIMIT 1`,
    [userCode],
  );
  return (rows[0] as DeviceAuthRow) ?? null;
}

/** Stamp oauth_state/oidc_nonce on a pending row right before redirecting
 * to the IdP, so the callback can be bound back to this exact row. Scoped
 * to status='pending' so a row that's already been denied/expired can't be
 * re-armed with a fresh state by a stale verify-page tab. Returns null (and
 * does NOT surface the generated state/nonce, which were never persisted)
 * if the row wasn't pending anymore -- consistent with approveAuthorization
 * / denyAuthorization below, which both check rowCount. */
export async function bindOAuthState(pool: Queryable, authId: string): Promise<{ state: string; nonce: string } | null> {
  const state = generateOAuthState();
  const nonce = generateOAuthState();
  const { rowCount } = await pool.query(
    `UPDATE device_authorizations SET oauth_state = $2, oidc_nonce = $3 WHERE id = $1 AND status = 'pending'`,
    [authId, state, nonce],
  );
  return (rowCount ?? 0) > 0 ? { state, nonce } : null;
}

export interface AuthByStateRow extends DeviceAuthRow {
  oidc_nonce: string | null;
}

/** Look up the pending row the IdP callback's `state` param claims to
 * belong to. Scoped to status='pending' so a replayed/late callback for an
 * already-approved, denied, or expired row can't be matched again. */
export async function getAuthorizationByOAuthState(pool: Queryable, state: string): Promise<AuthByStateRow | null> {
  const { rows } = await pool.query(
    `SELECT id, team_id, idp_config_id, status, verified_email, expires_at, last_polled_at, interval_seconds, oidc_nonce
       FROM device_authorizations
      WHERE oauth_state = $1 AND status = 'pending'
      LIMIT 1`,
    [state],
  );
  return (rows[0] as AuthByStateRow) ?? null;
}

/** Called after the IdP callback's ID token has been verified. Conditional
 * UPDATE (status='pending' in the WHERE) guards against a TOCTOU race with
 * a concurrent deny on the same row. Returns false if the row wasn't
 * pending anymore. */
export async function approveAuthorization(pool: Queryable, authId: string, verifiedEmail: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE device_authorizations
        SET status = 'approved', verified_email = $2
      WHERE id = $1 AND status = 'pending'`,
    [authId, verifiedEmail],
  );
  return (rowCount ?? 0) > 0;
}

/** Called when the employee explicitly rejects a mismatched code at
 * /oauth/device/verify. Conditional UPDATE for the same TOCTOU reason as
 * approveAuthorization above -- a concurrent approve on the same row wins
 * if it lands first. */
export async function denyAuthorization(pool: Queryable, authId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE device_authorizations SET status = 'denied' WHERE id = $1 AND status = 'pending'`,
    [authId],
  );
  return (rowCount ?? 0) > 0;
}

export type PollOutcome =
  | { status: 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied' | 'invalid_grant' }
  | { status: 'ready_to_mint'; row: DeviceAuthRow };

/** POST /oauth/device/token polling logic. Mirrors the RTSH-1 flow's
 * pollToken shape (apps/dashboard/lib/oauth-device-service.ts) with two
 * additions: 'denied' -> access_denied, and 'consumed' -> invalid_grant
 * (a device_code is single-use; a repeat poll after a successful mint
 * must not mint again -- this is the replay defense). Does NOT mint here;
 * minting + the one-live-key transaction is a separate task's job. */
export async function pollDeviceToken(pool: Queryable, deviceCode: string, now: Date = new Date()): Promise<PollOutcome> {
  const { rows } = await pool.query(
    `SELECT id, team_id, idp_config_id, status, verified_email, expires_at, last_polled_at, interval_seconds
       FROM device_authorizations
      WHERE device_code_hash = $1
      LIMIT 1`,
    [hashDeviceCode(deviceCode)],
  );
  const row = rows[0] as DeviceAuthRow | undefined;
  if (!row) return { status: 'invalid_grant' };

  // denied/consumed short-circuit before the expiry check and before ever
  // touching last_polled_at: neither status can transition to anything
  // else, so there's nothing left to update, and a replayed poll against a
  // consumed device_code must not mint a second key.
  if (row.status === 'denied') return { status: 'access_denied' };
  if (row.status === 'consumed') return { status: 'invalid_grant' };

  // expires_at bounds the WHOLE grant per RFC 8628 semantics, not just the
  // pre-approval phase -- an approved-but-unpolled row must not be mintable
  // indefinitely, so this check is unconditional (no row.status !== 'approved'
  // guard) and runs before the approved -> ready_to_mint branch below.
  if (isExpired(new Date(row.expires_at), now)) {
    // Status-guarded like every sibling transition (and the sweeper's expiry
    // UPDATE): the row was read with a plain unlocked SELECT above, so between
    // that read and this write a concurrent mint could have set 'consumed' (or
    // a deny set 'denied'). Only supersede a still-pending/approved row, so an
    // expiry write can't clobber a terminal state and corrupt the audit record.
    await pool.query(
      `UPDATE device_authorizations SET status = 'expired' WHERE id = $1 AND status IN ('pending', 'approved')`,
      [row.id],
    );
    return { status: 'expired_token' };
  }
  if (row.status === 'expired') return { status: 'expired_token' };

  if (row.status === 'approved') {
    return { status: 'ready_to_mint', row };
  }

  // Still pending: enforce cadence, record this poll -- but only when it's
  // actually accepted. If a rejected (too-soon) poll advanced last_polled_at
  // too, a client polling marginally under interval_seconds (e.g. clock
  // drift shaving a poll to 4.9s instead of 5s) would keep resetting the
  // window on every rejected attempt and could never accumulate a large
  // enough gap to ever get accepted -- a permanent slow_down lockout. Per
  // RFC 8628 SS3.5, only a genuinely-accepted poll should advance the clock.
  const tooSoon = isPolledTooSoon(row.last_polled_at ? new Date(row.last_polled_at) : null, row.interval_seconds, now);
  if (!tooSoon) {
    await pool.query(`UPDATE device_authorizations SET last_polled_at = $2 WHERE id = $1`, [row.id, now]);
  }
  return { status: tooSoon ? 'slow_down' : 'authorization_pending' };
}
