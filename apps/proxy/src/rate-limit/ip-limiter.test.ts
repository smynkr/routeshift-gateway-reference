import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { checkIpRateLimit, getTrustedClientIp, __resetIpRateLimitStore } from './ip-limiter.js';

function mockReq(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('getTrustedClientIp', () => {
  it('trusts CF-Connecting-IP when no edge secret is configured', () => {
    const req = mockReq({ 'cf-connecting-ip': '1.2.3.4' });
    expect(getTrustedClientIp(req)).toBe('1.2.3.4');
  });

  it('falls back to the rightmost X-Forwarded-For entry when no CF header is present', () => {
    const req = mockReq({ 'x-forwarded-for': '9.9.9.9, 10.0.0.1' });
    expect(getTrustedClientIp(req)).toBe('10.0.0.1');
  });

  it('rejects a malformed forwarded value instead of trusting it verbatim', () => {
    const req = mockReq({ 'x-forwarded-for': 'not-an-ip' });
    expect(getTrustedClientIp(req)).toBe('unknown');
  });

  it('returns unknown when nothing is present', () => {
    expect(getTrustedClientIp(mockReq({}))).toBe('unknown');
  });

  it('falls back to the socket remote address when no forwarding headers are present (RSH-100 review fix: Node IncomingMessage exposes it, unlike the Fetch Request the dashboard port came from)', () => {
    // A headerless direct-to-origin request must key on the real TCP peer, not
    // collapse every such client into one shared "unknown" bucket.
    const req = { headers: {}, socket: { remoteAddress: '198.51.100.23' } } as unknown as IncomingMessage;
    expect(getTrustedClientIp(req)).toBe('198.51.100.23');
  });
});

describe('getTrustedClientIp — trusted-edge gate (EDGE_SHARED_SECRET) closes the direct-origin bypass', () => {
  const SECRET = 's3cr3t-edge-value';

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('with the gate on, trusts cf-connecting-ip only when the edge marker matches', () => {
    vi.stubEnv('EDGE_SHARED_SECRET', SECRET);
    // Through Cloudflare: the Transform Rule has stamped the matching marker.
    const req = mockReq({
      'x-rsh-edge-secret': SECRET,
      'cf-connecting-ip': '203.0.113.7',
      'x-forwarded-for': '6.6.6.6, 9.9.9.9',
    });
    expect(getTrustedClientIp(req)).toBe('203.0.113.7');
  });

  it('with the gate on, a missing or wrong marker leaves cf-connecting-ip untrusted and falls back to XFF', () => {
    vi.stubEnv('EDGE_SHARED_SECRET', SECRET);
    // No marker (direct-to-origin) → cf-connecting-ip is NOT trusted; key on the
    // rightmost XFF entry our origin proxy stamped, not the forged CF header.
    const noMarker = mockReq({ 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '6.6.6.6, 203.0.113.9' });
    expect(getTrustedClientIp(noMarker)).toBe('203.0.113.9');

    // A wrong marker is treated the same as no marker.
    const wrongMarker = mockReq({
      'x-rsh-edge-secret': 'wrong',
      'cf-connecting-ip': '1.2.3.4',
      'x-forwarded-for': '6.6.6.6, 203.0.113.9',
    });
    expect(getTrustedClientIp(wrongMarker)).toBe('203.0.113.9');
  });

  it('with the gate on, a direct attacker rotating forged cf-connecting-ip cannot mint fresh buckets', () => {
    vi.stubEnv('EDGE_SHARED_SECRET', SECRET);
    __resetIpRateLimitStore();
    const opts = { limit: 3, windowMs: 60_000 };
    function attempt(forgedCf: string) {
      // Direct-to-origin: the real socket IP (203.0.113.50) is stamped as the
      // rightmost XFF by our origin proxy; the attacker rotates only the forged CF header.
      const req = mockReq({ 'cf-connecting-ip': forgedCf, 'x-forwarded-for': '6.6.6.6, 203.0.113.50' });
      return checkIpRateLimit(`oauth:token:${getTrustedClientIp(req)}`, opts);
    }
    expect(attempt('1.1.1.1').allowed).toBe(true);
    expect(attempt('2.2.2.2').allowed).toBe(true);
    expect(attempt('3.3.3.3').allowed).toBe(true);
    // 4th still maps to the one real-client bucket (203.0.113.50) → blocked.
    expect(attempt('4.4.4.4').allowed).toBe(false);
  });
});

describe('checkIpRateLimit', () => {
  beforeEach(() => {
    __resetIpRateLimitStore();
  });

  it('allows requests under the limit and blocks the one that exceeds it', () => {
    const opts = { limit: 2, windowMs: 60_000 };
    expect(checkIpRateLimit('1.2.3.4:test', opts).allowed).toBe(true);
    expect(checkIpRateLimit('1.2.3.4:test', opts).allowed).toBe(true);
    const third = checkIpRateLimit('1.2.3.4:test', opts);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSec).toBeGreaterThan(0);
  });

  it('keys buckets independently per key string', () => {
    const opts = { limit: 1, windowMs: 60_000 };
    expect(checkIpRateLimit('a', opts).allowed).toBe(true);
    expect(checkIpRateLimit('b', opts).allowed).toBe(true);
  });
});
