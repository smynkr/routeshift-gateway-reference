// RSH-100: pure primitives for the SSO device-authorization flow (RFC
// 8628). Modeled on apps/dashboard/lib/oauth-device.ts (the RTSH-1 flow's
// equivalent module) -- same alphabet, same TTL/cadence conventions --
// re-implemented here because apps/proxy can't import dashboard code.
// Kept side-effect-free so the security-critical bits (code generation,
// hashing, polling cadence) are unit-testable without a database.
import { createHash, randomBytes, randomInt } from 'node:crypto';

// Standard RFC 8628 window: long enough to switch to a browser and
// approve, short enough to bound how long an intercepted user_code works.
export const DEVICE_CODE_TTL_SECONDS = 600;

export const DEFAULT_POLL_INTERVAL_SECONDS = 5;

// Minted SSO keys are short-lived by design -- this is the entire point of
// the feature (self-expiring instead of admin-minted-and-forgotten).
export const SSO_KEY_TTL_HOURS = 8;

// Same confusable-free alphabet as the RTSH-1 flow: uppercase, no 0/1/I/O/U
// or other easily mis-keyed glyphs. 8 chars over 28 symbols ~= 38 bits --
// fine for a single-use code that also expires in 10 minutes.
export const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';
export const USER_CODE_LENGTH = 8;

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/** High-entropy bearer secret the client polls with. Never stored in clear. */
export function generateDeviceCode(): string {
  return randomBytes(32).toString('hex');
}

/** sha256 hex -- what's persisted for a device_code and compared against on poll. */
export function hashDeviceCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/** Canonical, compact, storable user_code (no separator). */
export function generateUserCode(): string {
  let code = '';
  for (let i = 0; i < USER_CODE_LENGTH; i++) {
    code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  }
  return code;
}

/** Human-facing rendering: AAAA-BBBB. The DB stores the compact form. */
export function formatUserCode(code: string): string {
  const c = normalizeUserCode(code);
  if (c.length <= 1) return c;
  const mid = Math.ceil(c.length / 2);
  return `${c.slice(0, mid)}-${c.slice(mid)}`;
}

/** Normalize arbitrary user input (any case, with/without separators or
 * surrounding whitespace) to the compact form used for DB lookup. */
export function normalizeUserCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** High-entropy, URL-safe token for OAuth `state` / OIDC `nonce` -- binds
 * a specific IdP callback to a specific pending device_authorizations row. */
export function generateOAuthState(): string {
  return randomBytes(32).toString('base64url');
}

export function isExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime();
}

/** RFC 8628 SS3.5: a client polling faster than `interval` gets `slow_down`. */
export function isPolledTooSoon(
  lastPolledAt: Date | null | undefined,
  intervalSeconds: number,
  now: Date = new Date(),
): boolean {
  if (!lastPolledAt) return false;
  return now.getTime() - lastPolledAt.getTime() < intervalSeconds * 1000;
}
