// RTSH-1: pure primitives for the OAuth 2.0 Device Authorization Grant
// (RFC 8628). Kept side-effect-free and runtime-agnostic so the
// security-critical bits (code generation, hashing, polling cadence) are
// unit-testable without the Next.js request runtime or a database.
//
// apps/proxy/src/oauth/sso-device-flow.ts (RSH-100) is a ported sibling of
// this module's code/hash/format primitives, adapted for apps/proxy since
// dashboard code can't be imported cross-app. The generation/hashing/expiry
// logic is intentionally identical -- a fix to either must be mirrored in
// both.

import { createHash, randomBytes, randomInt } from 'node:crypto';

// A device_code is valid for 10 minutes — long enough to switch to a browser,
// sign in, and approve; short enough to bound the window an intercepted
// user_code is useful.
export const DEVICE_CODE_TTL_SECONDS = 600;

// Minimum seconds the client must wait between token polls. Echoed to the
// client as `interval`; polling faster earns a `slow_down`.
export const DEFAULT_POLL_INTERVAL_SECONDS = 5;

// user_code alphabet: uppercase, with 0/1/I/O/U and other easily-confused
// glyphs removed so a human reading it off one screen and typing it into
// another rarely mis-keys. 8 chars over a 28-symbol alphabet ≈ 38 bits —
// fine for a single-use code that also expires in 10 minutes.
export const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';
export const USER_CODE_LENGTH = 8;

// Device-flow clients may request only capabilities the consent UI and proxy
// both enforce. Keep the order stable so persisted grants, consent copy, and
// token responses all describe the same canonical scope.
export const SUPPORTED_DEVICE_SCOPES = ['inference', 'read'] as const;
export const DEVICE_SCOPE_MAX_LENGTH = 200;

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

// Minted keys are short-lived by default so a Revoke stays effective even
// after the key has been written into several tool configs. Operators can
// widen the window with OAUTH_DEVICE_KEY_TTL_HOURS; the default is 30 days.
export function mintedKeyTtlHours(): number {
  const raw = process.env.OAUTH_DEVICE_KEY_TTL_HOURS;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : 720;
}

/** High-entropy bearer secret the client polls with. Never stored in clear. */
export function generateDeviceCode(): string {
  return randomBytes(32).toString('hex');
}

/** sha256 hex — what we persist for a device_code and compare polls against. */
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

/**
 * Normalize arbitrary user input (any case, with or without separators or
 * surrounding whitespace) to the compact form used for DB lookup. We do NOT
 * remap confusable glyphs — the alphabet already excludes them — so an input
 * containing an excluded char simply won't match any stored code.
 */
export function normalizeUserCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Split a space/comma-delimited scope string into a clean list of scopes. */
export function parseScopes(scope: string | null | undefined): string[] {
  if (!scope) return [];
  return scope.split(/[\s,]+/).filter(Boolean);
}

export type NormalizeDeviceScopeResult =
  | { ok: true; scope: string }
  | { ok: false };

/**
 * Validate and canonicalize a device authorization request's scope.
 *
 * Omitted or whitespace-only scope defaults to inference-only. An explicit
 * non-empty value must contain only supported tokens; separators-only input
 * is invalid rather than another spelling of omission.
 */
export function normalizeDeviceScope(
  requestedScope: string | null | undefined,
): NormalizeDeviceScopeResult {
  if (requestedScope === null || requestedScope === undefined) {
    return { ok: true, scope: 'inference' };
  }
  if (requestedScope.length > DEVICE_SCOPE_MAX_LENGTH) return { ok: false };
  if (requestedScope.trim() === '') return { ok: true, scope: 'inference' };

  const requested = parseScopes(requestedScope);
  if (requested.length === 0) return { ok: false };

  const supported = new Set<string>(SUPPORTED_DEVICE_SCOPES);
  if (requested.some((scope) => !supported.has(scope))) return { ok: false };

  const unique = new Set(requested);
  return {
    ok: true,
    scope: SUPPORTED_DEVICE_SCOPES.filter((scope) => unique.has(scope)).join(' '),
  };
}

export function isExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime();
}

/**
 * RFC 8628 §3.5: a client polling faster than `interval` must be told to
 * `slow_down`. Returns true when the gap since the previous poll is under the
 * permitted interval. A first poll (no prior timestamp) is never too soon.
 */
export function isPolledTooSoon(
  lastPolledAt: Date | null | undefined,
  intervalSeconds: number,
  now: Date = new Date(),
): boolean {
  if (!lastPolledAt) return false;
  return now.getTime() - lastPolledAt.getTime() < intervalSeconds * 1000;
}
