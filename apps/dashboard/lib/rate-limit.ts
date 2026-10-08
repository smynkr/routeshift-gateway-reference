import { isIP } from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

/**
 * In-memory sliding-window rate limiter for dashboard API routes (RSH-52).
 *
 * Single-instance by design, matching the existing project posture
 * (apps/proxy/src/rate-limit/limiter.ts and apps/proxy/src/billing/
 * rate-limit-cooldown.ts: "in-memory by design — moves to Redis if/when we run
 * multi-replica"). The dashboard runs as a single Railway service today; if it
 * is ever scaled to multiple replicas this MUST move to a shared store (Redis)
 * so a caller can't dodge the limit by hitting a different instance.
 *
 * No timers: entries are cleaned lazily per-key on read, plus an opportunistic
 * sweep once the key count crosses a bound. That keeps it deterministic under
 * vitest fake timers and avoids a module-load setInterval.
 *
 * apps/proxy/src/rate-limit/ip-limiter.ts (RSH-100) is a ported sibling of
 * getClientIp/checkRateLimit for apps/proxy's unauthenticated SSO endpoints,
 * adapted to Node's IncomingMessage instead of Fetch's Request. The trust
 * logic is byte-identical -- a fix to the trust model here (or there) must be
 * mirrored in both files.
 */

const store = new Map<string, number[]>();

// Hard upper bound on distinct keys. Memory and per-request sweep cost stay
// bounded even under a flood of distinct IP keys, with no background timer.
const MAX_KEYS = 20_000;
// A key is prunable after this long with no hits. Kept just above the largest
// window in use (60s) so that under a fresh-key flood — the exact case this
// guards — keys actually age out instead of all looking "recent" forever.
const IDLE_MS = 120_000; // 2 min
// Throttle the O(n) idle scan so a sustained flood doesn't pay a full-Map walk
// on every request. The cheap hard cap below still runs every call.
const SWEEP_MIN_INTERVAL_MS = 1_000;
let lastSweepAt = 0;

export interface RateLimitOptions {
  /** Max requests allowed within the window. */
  limit: number;
  /** Sliding window length in ms. */
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Requests remaining in the current window (0 when blocked). */
  remaining: number;
  /** Seconds until the window frees up — use for the Retry-After header. */
  retryAfterSec: number;
}

function maybeSweep(now: number): void {
  if (store.size <= MAX_KEYS) return;
  // Throttled full idle scan: reclaim genuinely stale keys at most once/sec.
  if (now - lastSweepAt >= SWEEP_MIN_INTERVAL_MS) {
    lastSweepAt = now;
    for (const [key, hits] of store) {
      const last = hits[hits.length - 1];
      if (last === undefined || last < now - IDLE_MS) store.delete(key);
    }
  }
  // Hard cap, always: under an all-recent-keys flood the idle scan reclaims
  // nothing, so evict oldest-inserted keys (Map preserves insertion order) to
  // keep the store — and the per-request scan cost — strictly bounded. Each
  // request adds at most one key, so this evicts at most one per call (O(1))
  // once the cap is reached. An evicted attacker just gets a fresh budget,
  // which is acceptable under a flood; legitimate load never approaches the cap.
  while (store.size > MAX_KEYS) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/**
 * Record a hit for `key` and report whether it is within the limit. The hit is
 * only recorded when allowed, so a blocked caller cannot extend their own
 * window by hammering the endpoint.
 */
export function checkRateLimit(key: string, opts: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  const windowStart = now - opts.windowMs;
  maybeSweep(now);

  const hits = (store.get(key) ?? []).filter((ts) => ts > windowStart);

  if (hits.length >= opts.limit) {
    // Keep the filtered window so the next call doesn't re-walk stale entries.
    store.set(key, hits);
    const oldest = hits[0]!;
    const retryAfterMs = oldest + opts.windowMs - now;
    return { allowed: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }

  hits.push(now);
  store.set(key, hits);
  return { allowed: true, remaining: opts.limit - hits.length, retryAfterSec: 0 };
}

/**
 * Normalize a forwarded token to a bare, syntactically valid IP, or null. Strips
 * a trailing :port (both `1.2.3.4:443` and `[2001:db8::1]:443` bracket forms),
 * then validates with node:net's isIP. Rejecting non-IPs (incl. degenerate
 * tokens like ':' / '1:2' / 'ip:port') keeps the rate-limit bucket key stable
 * per client and stops a forged header smuggling an arbitrary key or
 * log-injection chars downstream.
 */
function parseIp(raw: string): string | null {
  let v = raw.trim();
  const bracket = v.match(/^\[([0-9a-fA-F:.]+)\](?::\d+)?$/);
  if (bracket) {
    v = bracket[1]!;
  } else {
    const v4WithPort = v.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
    if (v4WithPort) v = v4WithPort[1]!;
  }
  return isIP(v) !== 0 ? v : null;
}

const EDGE_MARKER_HEADER = 'x-rsh-edge-secret';

/** Constant-time compare of the edge marker (hash to a fixed length so the
 * secret's length never leaks via timing). */
function edgeMarkerValid(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Trusted client IP for unauthenticated routes, used as the rate-limit bucket
 * key — so it MUST NOT be client-spoofable, or the limit is free to dodge.
 *
 * Verified topology (2026-06-13): app.routeshift.io resolves to Cloudflare,
 * which fronts the Railway origin — i.e. client → Cloudflare → Railway → app.
 * Cloudflare sets `CF-Connecting-IP` to the real client and overwrites any
 * client-supplied value, so it is the trusted source on the CF path. We
 * deliberately do NOT read the FIRST hop of `X-Forwarded-For`: that entry is
 * fully client-forgeable (the edge only ever *appends* to XFF), so keying on it
 * would let an attacker mint a fresh bucket per request and bypass the limit.
 * The fallback walks `X-Forwarded-For` from the RIGHT — the rightmost entry is
 * the one stamped by our own origin proxy (Railway), which the client cannot
 * control. 'unknown' (one shared bucket — fail closed) when nothing is trusted.
 *
 * Trusted-edge gate (defense-in-depth, opt-in via EDGE_SHARED_SECRET):
 * `CF-Connecting-IP` / `True-Client-IP` are trustworthy ONLY for requests that
 * actually traversed Cloudflare; a request sent straight to the Railway origin
 * can forge them. When EDGE_SHARED_SECRET is set, we trust those CF headers only
 * if the request also carries a matching `x-rsh-edge-secret` marker — which a
 * Cloudflare Transform Rule injects (and overwrites) on the way in, so only
 * real CF traffic has it. A direct-to-origin request lacks the marker and falls
 * back to the rightmost XFF entry (its real, edge-stamped socket IP), which it
 * cannot spoof. When EDGE_SHARED_SECRET is UNSET (default) the gate is off and
 * CF headers are trusted directly (correct for the CF happy path, but leaves the
 * direct-origin path forgeable — see docs/runbooks/rate-limit-edge-trust.md).
 *
 * ⚠ Activation is two-sided: set EDGE_SHARED_SECRET *and* add the CF Transform
 * Rule together. Setting the env without the rule strips the marker from real
 * traffic → all CF clients collapse onto the CF egress IP (coarse buckets /
 * possible false 429s). It fails toward over-limiting, never toward a bypass.
 */
export function getClientIp(request: Request): string {
  const h = request.headers;

  // CF-set headers are only trusted when the request proves it came through our
  // CF edge (or the gate is disabled). See the trusted-edge gate note above.
  const edgeSecret = process.env.EDGE_SHARED_SECRET;
  const cfTrusted = !edgeSecret || edgeMarkerValid(h.get(EDGE_MARKER_HEADER), edgeSecret);

  // CF edge headers (set + overwritten by Cloudflare) are preferred over XFF —
  // but only when the request is proven to have come through our CF edge.
  if (cfTrusted) {
    const cf = h.get('cf-connecting-ip');
    if (cf) {
      const ip = parseIp(cf);
      if (ip) return ip;
    }
    const trueClient = h.get('true-client-ip');
    if (trueClient) {
      const ip = parseIp(trueClient);
      if (ip) return ip;
    }
  }

  const fwd = h.get('x-forwarded-for');
  if (fwd) {
    const parts = fwd.split(',');
    for (let i = parts.length - 1; i >= 0; i--) {
      const ip = parseIp(parts[i]!);
      if (ip) return ip;
    }
  }

  if (cfTrusted) {
    const realIp = h.get('x-real-ip');
    if (realIp) {
      const ip = parseIp(realIp);
      if (ip) return ip;
    }
  }

  return 'unknown';
}

/** Standard 429 response with Retry-After, for a blocked rate-limit result. */
export function rateLimitedResponse(result: RateLimitResult): NextResponse {
  return NextResponse.json(
    { error: 'rate_limited', error_description: 'Too many requests. Please slow down and retry.' },
    {
      status: 429,
      headers: {
        'Retry-After': String(result.retryAfterSec),
        'Cache-Control': 'no-store',
      },
    },
  );
}

/** Test-only: reset the in-memory store between cases. */
export function __resetRateLimitStore(): void {
  store.clear();
  lastSweepAt = 0;
}

/** Test-only: number of distinct keys held (to assert the store stays bounded). */
export function __rateLimitStoreSize(): number {
  return store.size;
}

/** Test-only: the hard cap on distinct keys. */
export const __RATE_LIMIT_MAX_KEYS = MAX_KEYS;
