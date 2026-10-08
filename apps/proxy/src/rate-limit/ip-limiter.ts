// RSH-100: per-IP rate limiting for apps/proxy's unauthenticated SSO
// device-flow endpoints. Ported from apps/dashboard/lib/rate-limit.ts
// (getClientIp + checkRateLimit), adapted from the Fetch API's Request to
// Node's IncomingMessage since apps/proxy doesn't run on Next.js and
// dashboard code can't be imported cross-app. Trusted-IP-extraction
// semantics are unchanged from the dashboard version -- see that file's
// header comment for the full Cloudflare-topology rationale this mirrors.
//
// Single-instance by design, matching the existing project posture
// (apps/dashboard/lib/rate-limit.ts and apps/proxy/src/billing/
// rate-limit-cooldown.ts). apps/proxy runs as a single Railway service today;
// if it is ever scaled to multiple replicas this MUST move to a shared store
// (Redis) so a caller can't dodge the limit by hitting a different instance.
import { isIP } from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

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

export interface IpRateLimitOptions {
  limit: number;
  windowMs: number;
}

export interface IpRateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

function maybeSweep(now: number): void {
  if (store.size <= MAX_KEYS) return;
  if (now - lastSweepAt >= SWEEP_MIN_INTERVAL_MS) {
    lastSweepAt = now;
    for (const [key, hits] of store) {
      const last = hits[hits.length - 1];
      if (last === undefined || last < now - IDLE_MS) store.delete(key);
    }
  }
  while (store.size > MAX_KEYS) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

export function checkIpRateLimit(key: string, opts: IpRateLimitOptions): IpRateLimitResult {
  const now = Date.now();
  const windowStart = now - opts.windowMs;
  maybeSweep(now);

  const hits = (store.get(key) ?? []).filter((ts) => ts > windowStart);

  if (hits.length >= opts.limit) {
    store.set(key, hits);
    const oldest = hits[0]!;
    const retryAfterMs = oldest + opts.windowMs - now;
    return { allowed: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }

  hits.push(now);
  store.set(key, hits);
  return { allowed: true, remaining: opts.limit - hits.length, retryAfterSec: 0 };
}

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

function edgeMarkerValid(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Trusted client IP for apps/proxy's unauthenticated routes. Same trust
 * model as apps/dashboard/lib/rate-limit.ts getClientIp -- see that file
 * for the full Cloudflare-topology rationale (CF-Connecting-IP trusted
 * only when EDGE_SHARED_SECRET is unset or the edge marker matches;
 * otherwise falls back to the rightmost, edge-stamped X-Forwarded-For
 * entry, which the client can't spoof). */
export function getTrustedClientIp(req: IncomingMessage): string {
  const edgeSecret = process.env.EDGE_SHARED_SECRET;
  const cfTrusted = !edgeSecret || edgeMarkerValid(header(req, EDGE_MARKER_HEADER), edgeSecret);

  if (cfTrusted) {
    const cf = header(req, 'cf-connecting-ip');
    if (cf) {
      const ip = parseIp(cf);
      if (ip) return ip;
    }
    const trueClient = header(req, 'true-client-ip');
    if (trueClient) {
      const ip = parseIp(trueClient);
      if (ip) return ip;
    }
  }

  const fwd = header(req, 'x-forwarded-for');
  if (fwd) {
    const parts = fwd.split(',');
    for (let i = parts.length - 1; i >= 0; i--) {
      const ip = parseIp(parts[i]!);
      if (ip) return ip;
    }
  }

  if (cfTrusted) {
    const realIp = header(req, 'x-real-ip');
    if (realIp) {
      const ip = parseIp(realIp);
      if (ip) return ip;
    }
  }

  // Last resort: the actual TCP peer. Node's IncomingMessage exposes this
  // (the Fetch Request this trust model was ported from did not, hence the
  // original 'unknown' terminal). It is the real client only on a headerless
  // direct-to-origin path -- behind Cloudflare/Railway the header branches
  // above always win first -- but on that path it beats collapsing every
  // client into a single shared 'unknown' bucket, and unlike a header it
  // can't be forged by the client.
  const socketIp = req.socket?.remoteAddress;
  if (socketIp) {
    const ip = parseIp(socketIp);
    if (ip) return ip;
  }

  return 'unknown';
}

/** Test-only: reset the in-memory store between cases. */
export function __resetIpRateLimitStore(): void {
  store.clear();
  lastSweepAt = 0;
}
