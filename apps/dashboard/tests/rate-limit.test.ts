import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkRateLimit,
  getClientIp,
  rateLimitedResponse,
  __resetRateLimitStore,
  __rateLimitStoreSize,
  __RATE_LIMIT_MAX_KEYS,
} from '@/lib/rate-limit';

describe('checkRateLimit', () => {
  beforeEach(() => {
    __resetRateLimitStore();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-13T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows exactly `limit` requests then blocks — the gate is not bypassable by hammering', () => {
    const opts = { limit: 5, windowMs: 60_000 };
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit('ip:1.2.3.4', opts).allowed).toBe(true);
    }
    // 6th within the window is blocked...
    const blocked = checkRateLimit('ip:1.2.3.4', opts);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);

    // ...and repeatedly hitting it stays blocked (a blocked hit is NOT recorded,
    // so it can't push the window forward to sneak through).
    for (let i = 0; i < 20; i++) {
      expect(checkRateLimit('ip:1.2.3.4', opts).allowed).toBe(false);
    }
  });

  it('isolates buckets per key', () => {
    const opts = { limit: 2, windowMs: 60_000 };
    expect(checkRateLimit('a', opts).allowed).toBe(true);
    expect(checkRateLimit('a', opts).allowed).toBe(true);
    expect(checkRateLimit('a', opts).allowed).toBe(false);
    // A different key has its own fresh budget.
    expect(checkRateLimit('b', opts).allowed).toBe(true);
    expect(checkRateLimit('b', opts).allowed).toBe(true);
    expect(checkRateLimit('b', opts).allowed).toBe(false);
  });

  it('frees the window after it elapses', () => {
    const opts = { limit: 1, windowMs: 60_000 };
    expect(checkRateLimit('ip:9', opts).allowed).toBe(true);
    expect(checkRateLimit('ip:9', opts).allowed).toBe(false);
    // Advance past the window — the old hit ages out and a new one is allowed.
    vi.advanceTimersByTime(60_001);
    expect(checkRateLimit('ip:9', opts).allowed).toBe(true);
  });

  it('reports Retry-After roughly equal to the remaining window', () => {
    const opts = { limit: 1, windowMs: 60_000 };
    checkRateLimit('ip:r', opts);
    vi.advanceTimersByTime(10_000); // 10s into the window
    const blocked = checkRateLimit('ip:r', opts);
    expect(blocked.allowed).toBe(false);
    // ~50s left; ceil → 50.
    expect(blocked.retryAfterSec).toBe(50);
  });
});

describe('getClientIp — must NOT be client-spoofable (the bucket key)', () => {
  it('prefers Cloudflare cf-connecting-ip and ignores a forged leading x-forwarded-for', () => {
    // Cloudflare fronts the app and sets cf-connecting-ip to the real client,
    // overwriting anything the client sends. A forged leading XFF must not win.
    const req = new Request('https://app.routeshift.io/api/oauth/token', {
      headers: {
        'x-forwarded-for': '6.6.6.6, 203.0.113.7', // attacker prepended 6.6.6.6
        'cf-connecting-ip': '203.0.113.7',
      },
    });
    expect(getClientIp(req)).toBe('203.0.113.7');
  });

  it('uses true-client-ip when cf-connecting-ip is absent (still over x-forwarded-for) [RSH-57]', () => {
    const req = new Request('https://x', {
      headers: { 'x-forwarded-for': '1.2.3.4', 'true-client-ip': '198.51.100.10' },
    });
    expect(getClientIp(req)).toBe('198.51.100.10');
  });

  it('when Cloudflare sets cf-connecting-ip, a rotated forged leading XFF maps to one bucket', () => {
    const opts = { limit: 3, windowMs: 60_000 };
    // Same real client (cf-connecting-ip), attacker rotates the forged first hop.
    function attempt(forged: string) {
      const req = new Request('https://app.routeshift.io/api/oauth/device/code', {
        headers: {
          'x-forwarded-for': `${forged}, 203.0.113.7`,
          'cf-connecting-ip': '203.0.113.7',
        },
      });
      return checkRateLimit(`oauth:device-code:${getClientIp(req)}`, opts);
    }
    expect(attempt('1.1.1.1').allowed).toBe(true);
    expect(attempt('2.2.2.2').allowed).toBe(true);
    expect(attempt('3.3.3.3').allowed).toBe(true);
    // 4th rotated-forgery still maps to the same real-client bucket → blocked.
    expect(attempt('4.4.4.4').allowed).toBe(false);
  });

  it('without Cloudflare, uses the RIGHTMOST (edge-stamped) XFF entry, not the forgeable leftmost', () => {
    // Reaching the Railway origin directly: the trusted edge appends the real
    // client as the last hop; the leftmost is whatever the client sent.
    const req = new Request('https://x', {
      headers: { 'x-forwarded-for': '6.6.6.6, 10.0.0.1, 203.0.113.7' },
    });
    expect(getClientIp(req)).toBe('203.0.113.7');
  });

  it('rejects malformed header values and falls through, then to "unknown"', () => {
    // A non-IP cf-connecting-ip must not become the bucket key.
    expect(
      getClientIp(
        new Request('https://x', {
          headers: { 'cf-connecting-ip': 'not-an-ip', 'x-forwarded-for': '198.51.100.9' },
        }),
      ),
    ).toBe('198.51.100.9');
    expect(
      getClientIp(new Request('https://x', { headers: { 'cf-connecting-ip': '198.51.100.9' } })),
    ).toBe('198.51.100.9');
    expect(getClientIp(new Request('https://x'))).toBe('unknown');
    expect(
      getClientIp(new Request('https://x', { headers: { 'x-forwarded-for': 'garbage, junk' } })),
    ).toBe('unknown');
  });

  it('strips a trailing :port so a rotating source port cannot mint per-request buckets', () => {
    // An edge that stamps "ip:port" must still key on the stable bare IP.
    expect(
      getClientIp(new Request('https://x', { headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.7:54321' } })),
    ).toBe('203.0.113.7');
    expect(
      getClientIp(new Request('https://x', { headers: { 'cf-connecting-ip': '[2001:db8::1]:443' } })),
    ).toBe('2001:db8::1');
  });

  it('rejects degenerate non-IP tokens (":", "1:2", "a:b:c", ".:.") rather than keying on them', () => {
    for (const junk of [':', '1:2', 'a:b:c', '.:.', '203.0.113.7:abc']) {
      expect(
        getClientIp(new Request('https://x', { headers: { 'cf-connecting-ip': junk } })),
      ).toBe('unknown');
    }
  });
});

describe('getClientIp — trusted-edge gate (EDGE_SHARED_SECRET) closes the direct-origin bypass', () => {
  const SECRET = 's3cr3t-edge-value';
  beforeEach(() => __resetRateLimitStore());
  afterEach(() => {
    delete process.env.EDGE_SHARED_SECRET;
  });

  it('with the gate on, trusts cf-connecting-ip only when the edge marker matches', () => {
    process.env.EDGE_SHARED_SECRET = SECRET;
    // Through Cloudflare: the Transform Rule has stamped the matching marker.
    expect(
      getClientIp(
        new Request('https://x', {
          headers: {
            'x-rsh-edge-secret': SECRET,
            'cf-connecting-ip': '203.0.113.7',
            'x-forwarded-for': '6.6.6.6, 9.9.9.9',
          },
        }),
      ),
    ).toBe('203.0.113.7');
  });

  it('with the gate on, a direct request forging cf-connecting-ip falls back to the edge-stamped rightmost XFF', () => {
    process.env.EDGE_SHARED_SECRET = SECRET;
    // No marker (direct-to-origin) → cf-connecting-ip is NOT trusted; key on the
    // rightmost XFF entry our origin proxy stamped, not the forged CF header.
    expect(
      getClientIp(
        new Request('https://x', {
          headers: { 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '6.6.6.6, 203.0.113.9' },
        }),
      ),
    ).toBe('203.0.113.9');
    // Wrong marker is treated the same as no marker.
    expect(
      getClientIp(
        new Request('https://x', {
          headers: {
            'x-rsh-edge-secret': 'wrong',
            'cf-connecting-ip': '1.2.3.4',
            'x-forwarded-for': '6.6.6.6, 203.0.113.9',
          },
        }),
      ),
    ).toBe('203.0.113.9');
  });

  it('with the gate on, a direct attacker rotating forged cf-connecting-ip cannot mint fresh buckets', () => {
    process.env.EDGE_SHARED_SECRET = SECRET;
    const opts = { limit: 3, windowMs: 60_000 };
    function attempt(forgedCf: string) {
      // Direct-to-origin: the real socket IP (203.0.113.50) is stamped as the
      // rightmost XFF by our origin proxy; the attacker rotates only the forged CF header.
      const req = new Request('https://x', {
        headers: { 'cf-connecting-ip': forgedCf, 'x-forwarded-for': '6.6.6.6, 203.0.113.50' },
      });
      return checkRateLimit(`oauth:token:${getClientIp(req)}`, opts);
    }
    expect(attempt('1.1.1.1').allowed).toBe(true);
    expect(attempt('2.2.2.2').allowed).toBe(true);
    expect(attempt('3.3.3.3').allowed).toBe(true);
    // 4th still maps to the one real-client bucket (203.0.113.50) → blocked.
    expect(attempt('4.4.4.4').allowed).toBe(false);
  });

  it('without the secret (default), preserves cf-connecting-ip-first behavior', () => {
    expect(
      getClientIp(
        new Request('https://x', {
          headers: { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '6.6.6.6, 9.9.9.9' },
        }),
      ),
    ).toBe('203.0.113.7');
  });
});

describe('rate-limit store stays bounded under a distinct-key flood', () => {
  it('never exceeds the hard key cap even when every request is a fresh IP', () => {
    const opts = { limit: 5, windowMs: 60_000 };
    // Flood well past the cap with distinct keys at the same instant (the worst
    // case: nothing ages out, so only the hard cap can bound the store).
    for (let i = 0; i < __RATE_LIMIT_MAX_KEYS + 500; i++) {
      checkRateLimit(`flood:${i}`, opts);
    }
    expect(__rateLimitStoreSize()).toBeLessThanOrEqual(__RATE_LIMIT_MAX_KEYS + 1);
  });
});

describe('rateLimitedResponse', () => {
  it('is a 429 carrying Retry-After and no-store', () => {
    const res = rateLimitedResponse({ allowed: false, remaining: 0, retryAfterSec: 42 });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});
