import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';

const MIN_ADMIN_SECRET_LENGTH = 16;
export const UUID_PATH_SEGMENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sendAdminMisconfigured(res: ServerResponse, message = 'ADMIN_SECRET is not configured'): boolean {
  res.writeHead(500, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message } }));
  return false;
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function isLocalRequest(req: IncomingMessage): boolean {
  return isLoopbackAddress(req.socket.localAddress) && isLoopbackAddress(req.socket.remoteAddress);
}

export function requireAdminAuth(req: IncomingMessage, res: ServerResponse): boolean {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    if (
      process.env.NODE_ENV === 'development' &&
      process.env.ALLOW_UNAUTHENTICATED_ADMIN_DEV === 'true' &&
      isLocalRequest(req)
    ) {
      // A forwarding header means the request traversed a (potentially
      // same-host) reverse proxy, so the raw socket address is no longer
      // trustworthy and isLocalRequest() is spoofable. Refuse the bypass.
      if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers['forwarded']) {
        return sendAdminMisconfigured(res);
      }
      return true;
    }

    return sendAdminMisconfigured(res);
  }

  if (adminSecret.length < MIN_ADMIN_SECRET_LENGTH) {
    return sendAdminMisconfigured(res, `ADMIN_SECRET must be at least ${MIN_ADMIN_SECRET_LENGTH} characters`);
  }

  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
    return false;
  }

  // Back-compat: the global ADMIN_SECRET remains an unrestricted admin token.
  if (timingSafeCompare(token, adminSecret)) return true;

  const scoped = getScopedAdminToken(token);
  if (!scoped) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
    return false;
  }

  const requestedTeamId = getRequestedTeamId(req);
  if (!isScopedAdminEndpointAllowed(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Forbidden for scoped admin token on this endpoint' } }));
    return false;
  }
  if (!requestedTeamId || requestedTeamId === '*' || !scoped.teamIds.includes(requestedTeamId)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Forbidden for requested team_id' } }));
    return false;
  }
  return true;
}

interface ScopedAdminToken {
  teamIds: string[];
}

function getScopedAdminToken(token: string): ScopedAdminToken | null {
  const raw = process.env.ADMIN_SCOPED_TOKENS;
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Misconfigured ADMIN_SCOPED_TOKENS would otherwise silently disable every
    // scoped-admin token with only a generic "Unauthorized" — log so it's diagnosable.
    console.error('[admin-auth] failed to parse ADMIN_SCOPED_TOKENS as JSON:', err);
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  for (const [candidate, teams] of Object.entries(parsed as Record<string, unknown>)) {
    if (candidate.length < MIN_ADMIN_SECRET_LENGTH) continue;
    if (!timingSafeCompare(token, candidate)) continue;
    if (!Array.isArray(teams) || !teams.every((team) => typeof team === 'string' && team.length > 0)) {
      return null;
    }
    return { teamIds: teams };
  }
  return null;
}

function getRequestedTeamId(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? '/', 'http://localhost');
  return url.searchParams.get('team_id');
}

// The router (server.ts `parseUrl`) matches the RAW request target: it splits
// on '?' and '/' with no WHATWG normalization. The scoped allowlist MUST judge
// that same string — `new URL().pathname` resolves dot-segments and maps '\'
// to '/', so a WHATWG gate can authorize a normalized path the router then
// dispatches (or 404s) under different rules. Deciding allow/deny about the
// identical string the router dispatches keeps gate and route in lockstep;
// anything non-canonical fails closed at the gate instead of relying on
// handler re-validation to catch the divergence.
function isScopedAdminEndpointAllowed(req: IncomingMessage): boolean {
  const method = req.method ?? 'GET';
  if (method !== 'GET') return false;
  const path = (req.url ?? '/').split('?')[0];
  if (path === '/admin/keys/audit' || path === '/admin/sessions/window') {
    return true;
  }

  // Per-key audit is the only parameterized scoped-admin endpoint. Keep the
  // id to exactly one canonical, unencoded UUID path segment; in particular,
  // reject encoded values and anything that would fail PostgreSQL's UUID cast
  // before the request can reach the handler. Split WITHOUT filtering empty
  // segments so '//', leading/trailing slashes, and deeper lookalikes never
  // collapse onto the canonical shape.
  const segments = path.split('/');
  if (segments.length === 5 && segments[1] === 'admin' && segments[2] === 'keys' && segments[4] === 'audit') {
    return UUID_PATH_SEGMENT_RE.test(segments[3] ?? '');
  }

  return new Set([
    '/v1/usage/savings',
    '/admin/usage/token-hygiene',
    '/admin/usage/by-identity',
    '/admin/optimize/findings',
    '/admin/usage/savings-series',
    '/admin/usage/by-model-day',
    '/admin/keys',
    '/admin/rules',
    '/admin/auto-route',
    '/admin/team/rate-limits',
    // RSH-140: per-identity budget caps are READ-only for scoped tokens
    // (the GET-only gate above denies every write; team/key cap surfaces
    // have no scoped GET today, so identity-cap visibility is a superset —
    // intentional: operators with scoped tokens can inspect the per-person
    // ceilings their teams enforce. Writes stay ADMIN_SECRET-only).
    '/admin/identity-budgets',
    '/admin/identity-budgets/one',
  ]).has(path);
}

/** Constant-time string comparison to prevent timing attacks.
 *
 * Hashing both inputs to fixed-length SHA-256 digests means the comparison
 * runs in constant time regardless of input length, which avoids leaking
 * the secret length via timing of a length-mismatch shortcut. */
function timingSafeCompare(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf-8').digest();
  const digestB = createHash('sha256').update(b, 'utf-8').digest();
  return timingSafeEqual(digestA, digestB);
}
