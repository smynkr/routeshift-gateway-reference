import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RateLimiter } from '../src/rate-limit/limiter.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({ requestsPerMinute: 5, windowMs: 60_000 });
  });

  it('allows requests under limit', () => {
    const result = limiter.check('team_a');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it('rejects requests over limit', () => {
    for (let i = 0; i < 5; i++) limiter.check('team_a');
    const result = limiter.check('team_a');
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('isolates per team', () => {
    for (let i = 0; i < 5; i++) limiter.check('team_a');
    const result = limiter.check('team_b');
    expect(result.allowed).toBe(true);
  });

  it('provides reset time', () => {
    limiter.check('team_a');
    const result = limiter.check('team_a');
    expect(result.resetMs).toBeGreaterThan(0);
    expect(result.resetMs).toBeLessThanOrEqual(60_000);
  });

  it('window sliding: requests allowed after window expires', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    // Exhaust the limit
    for (let i = 0; i < 5; i++) limiter.check('team_c');
    expect(limiter.check('team_c').allowed).toBe(false);

    // Advance time past the window (60s)
    vi.setSystemTime(now + 61_000);

    // Allowed again, and the first post-expiry call RECORDS the request (no free
    // pass): the stale bucket is reset to exactly this one request.
    const result = limiter.check('team_c');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4); // 5 rpm - 1 recorded

    // Second call records too.
    const result2 = limiter.check('team_c');
    expect(result2.allowed).toBe(true);
    expect(result2.remaining).toBe(3); // 5 rpm - 2 recorded

    vi.useRealTimers();
  });

  it('remaining count accuracy', () => {
    expect(limiter.check('team_d').remaining).toBe(4); // 5 - 1
    expect(limiter.check('team_d').remaining).toBe(3); // 5 - 2
    expect(limiter.check('team_d').remaining).toBe(2); // 5 - 3
    expect(limiter.check('team_d').remaining).toBe(1); // 5 - 4
    expect(limiter.check('team_d').remaining).toBe(0); // 5 - 5
    // Next request is rejected
    const result = limiter.check('team_d');
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('per-key override: custom RPM overrides default', () => {
    // Default is 5 RPM, override to 2
    const r1 = limiter.check('team_e', 2);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(1); // 2 - 1

    const r2 = limiter.check('team_e', 2);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(0); // 2 - 2

    // Third request should be rejected with override of 2
    const r3 = limiter.check('team_e', 2);
    expect(r3.allowed).toBe(false);
    expect(r3.remaining).toBe(0);
  });

  // LAY-336: bucket isolation when a key has its own override.
  describe('bucket isolation (LAY-336)', () => {
    it('a key with override on its own bucket does not starve siblings on the team default', () => {
      // Sibling — uses team default (5 RPM).
      for (let i = 0; i < 5; i++) {
        expect(limiter.check('team_x').allowed).toBe(true);
      }
      expect(limiter.check('team_x').allowed).toBe(false);

      // Override key — its own bucket (1000 RPM cap). Should not collide.
      const r = limiter.check('team_x:key_1', 1000);
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(999);
    });

    it('two keys with no override share the team-default bucket (regression guard)', () => {
      // Both calls use the team-default bucket id — same window.
      for (let i = 0; i < 5; i++) {
        expect(limiter.check('team_y').allowed).toBe(true);
      }
      expect(limiter.check('team_y').allowed).toBe(false);
    });
  });

  it('sweep interval prunes stale windows and keeps active ones', () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);

    let sweepCb: (() => void) | undefined;
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation((handler: TimerHandler) => {
      sweepCb = handler as () => void;
      return { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    });

    const sweepLimiter = new RateLimiter({ requestsPerMinute: 5, windowMs: 1_000 });
    const windows = sweepLimiter as unknown as { windows: Map<string, number[]> };
    windows.windows.set('stale', [500]);
    windows.windows.set('active', [1_500]);

    sweepCb?.();

    expect(windows.windows.has('stale')).toBe(false);
    expect(windows.windows.get('active')).toEqual([1_500]);

    setIntervalSpy.mockRestore();
    vi.useRealTimers();
  });
});
