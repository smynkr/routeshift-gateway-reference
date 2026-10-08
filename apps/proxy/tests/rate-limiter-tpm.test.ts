import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RateLimiter } from '../src/rate-limit/limiter.js';

describe('RateLimiter.checkTpm', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({ requestsPerMinute: 100, windowMs: 60_000 });
  });

  it('allows when no TPM cap is set (undefined)', () => {
    const r = limiter.checkTpm('team_a', 100_000);
    expect(r.allowed).toBe(true);
    expect(r.recordId).toBeNull();
    expect(r.remaining).toBe(Infinity);
  });

  it('allows the first request under the cap and reports remaining', () => {
    const r = limiter.checkTpm('team_a', 1000, 5000);
    expect(r.allowed).toBe(true);
    expect(r.recordId).not.toBeNull();
    expect(r.remaining).toBe(4000);
  });

  it('rejects when the new request would push the windowed sum over the cap', () => {
    limiter.checkTpm('team_b', 4000, 5000);
    const r = limiter.checkTpm('team_b', 2000, 5000); // 4000 + 2000 = 6000 > 5000
    expect(r.allowed).toBe(false);
    expect(r.recordId).toBeNull();
    expect(r.remaining).toBe(1000); // 5000 - 4000 already used
  });

  it('does NOT count a rejected request against the running window', () => {
    limiter.checkTpm('team_c', 4000, 5000);
    limiter.checkTpm('team_c', 2000, 5000); // rejected
    // The next request with a smaller estimate should still see only 4000 used
    const r = limiter.checkTpm('team_c', 1000, 5000);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(0); // 5000 - 4000 - 1000 = 0
  });

  it('isolates token windows per team', () => {
    limiter.checkTpm('team_d1', 4500, 5000);
    const r = limiter.checkTpm('team_d2', 4500, 5000);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(500);
  });

  it('windows slide: tokens older than windowMs are not counted', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    limiter.checkTpm('team_e', 4000, 5000);

    vi.setSystemTime(now + 61_000);

    const r = limiter.checkTpm('team_e', 4000, 5000);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(1000);

    vi.useRealTimers();
  });

  it('a request exactly at the cap is allowed; the next one is not', () => {
    const r1 = limiter.checkTpm('team_f', 5000, 5000);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(0);

    const r2 = limiter.checkTpm('team_f', 1, 5000);
    expect(r2.allowed).toBe(false);
  });

  it('reconcile bumps a previous estimate to the actual; future checks see the actual', () => {
    const r = limiter.checkTpm('team_g', 1000, 10_000);
    expect(r.allowed).toBe(true);
    limiter.reconcileActualTokens(r.recordId, 8000);

    const r2 = limiter.checkTpm('team_g', 1000, 10_000);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1000); // 10000 - 8000 actual - 1000 estimate

    const r3 = limiter.checkTpm('team_g', 1001, 10_000);
    expect(r3.allowed).toBe(false);
  });

  it('reconcile after a rejected request is a no-op (recordId is null)', () => {
    limiter.checkTpm('team_h', 4000, 5000);
    const r = limiter.checkTpm('team_h', 2000, 5000); // rejected
    expect(r.allowed).toBe(false);
    expect(r.recordId).toBeNull();

    expect(() => limiter.reconcileActualTokens(r.recordId, 2500)).not.toThrow();

    const r2 = limiter.checkTpm('team_h', 1000, 5000);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(0);
  });

  it('removeRecord releases a per-key estimate when a later check rejects (RSH-60)', () => {
    // A per-key bucket passes and records an estimate, then the team-wide check
    // rejects — the per-key entry must be released, not left phantom-counting.
    const perKey = limiter.checkTpm('team_i:key_1', 3000, 5000);
    expect(perKey.allowed).toBe(true);
    expect(perKey.recordId).not.toBeNull();

    limiter.removeRecord(perKey.recordId);

    // The full cap is available again — the 3000 estimate was released.
    const next = limiter.checkTpm('team_i:key_1', 5000, 5000);
    expect(next.allowed).toBe(true);
    expect(next.remaining).toBe(0);
  });

  it('removeRecord no-ops on a null or unknown id', () => {
    expect(() => limiter.removeRecord(null)).not.toThrow();
    expect(() => limiter.removeRecord('nope')).not.toThrow();
  });

  it('removeRecord AFTER reconcile is a no-op — the success-path release must not drop reconciled tokens', () => {
    // The proxy hooks res.on('finish') to release reserved TPM estimates on every
    // request. On success it reconciles to the actual count first (which deletes the
    // record), so the later removeRecord must NOT erase the legitimately-counted usage.
    const r = limiter.checkTpm('team_j', 5000, 10000);
    limiter.reconcileActualTokens(r.recordId, 8000); // success: estimate 5000 -> actual 8000
    limiter.removeRecord(r.recordId);                // 'finish' fires afterwards — must no-op
    // The reconciled 8000 must still occupy the window: 8000 + 2001 > 10000 -> rejected.
    const next = limiter.checkTpm('team_j', 2001, 10000);
    expect(next.allowed).toBe(false);
  });

  it('reconcile downward (estimate over-counted) is honored', () => {
    const r = limiter.checkTpm('team_i', 5000, 5000);
    expect(r.allowed).toBe(true);
    limiter.reconcileActualTokens(r.recordId, 1000);

    const r2 = limiter.checkTpm('team_i', 3000, 5000);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1000); // 5000 - 1000 actual - 3000 estimate
  });

  it('resetMs reflects when the oldest window entry expires', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    limiter.checkTpm('team_j', 4000, 5000);

    vi.setSystemTime(now + 30_000);
    const r = limiter.checkTpm('team_j', 2000, 5000); // rejected
    expect(r.allowed).toBe(false);
    expect(r.resetMs).toBeGreaterThan(0);
    expect(r.resetMs).toBeLessThanOrEqual(30_000);

    vi.useRealTimers();
  });

  it('integrates with sweep timer: stale token windows and stale records are pruned', () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);

    let sweepCb: (() => void) | undefined;
    const setIntervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockImplementation((handler: TimerHandler) => {
        if (!sweepCb) sweepCb = handler as () => void;
        return { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
      });

    const sweepLimiter = new RateLimiter({ requestsPerMinute: 100, windowMs: 1_000 });
    const internals = sweepLimiter as unknown as {
      tokenWindows: Map<string, Array<{ at: number; tokens: number }>>;
      tokenRecords: Map<string, { teamId: string; entry: { at: number; tokens: number } }>;
    };
    const staleEntry = { at: 500, tokens: 100 };
    const activeEntry = { at: 1_500, tokens: 100 };
    internals.tokenWindows.set('stale', [staleEntry]);
    internals.tokenWindows.set('active', [activeEntry]);
    internals.tokenRecords.set('rid_stale', { teamId: 'stale', entry: staleEntry });
    internals.tokenRecords.set('rid_active', { teamId: 'active', entry: activeEntry });

    sweepCb?.();

    expect(internals.tokenWindows.has('stale')).toBe(false);
    expect(internals.tokenWindows.get('active')?.length).toBe(1);
    expect(internals.tokenRecords.has('rid_stale')).toBe(false);
    expect(internals.tokenRecords.has('rid_active')).toBe(true);

    setIntervalSpy.mockRestore();
    vi.useRealTimers();
  });
});
