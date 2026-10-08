import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockQuery = vi.hoisted(() => vi.fn());

vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({ query: mockQuery }),
}));

describe('plan-limits cache sweep', () => {
  beforeEach(() => {
    vi.resetModules();
    mockQuery.mockReset();
    process.env.DATABASE_URL = 'postgres://localhost/test';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sweeps expired plan and billing mode cache entries', async () => {
    let sweep: (() => void) | undefined;
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation((handler: TimerHandler) => {
      sweep = handler as () => void;
      return { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    });

    const mod = await import('../src/billing/plan-limits.js');

    mockQuery
      .mockResolvedValueOnce({ rows: [{ plan: 'starter' }] })
      .mockResolvedValueOnce({ rows: [{ billing_mode: 'credits' }] })
      .mockResolvedValueOnce({ rows: [{ plan: 'growth' }] })
      .mockResolvedValueOnce({ rows: [{ billing_mode: 'subscription' }] });

    expect(await mod.getTeamPlan('team_sweep')).toBe('starter');
    expect(await mod.getTeamBillingMode('team_sweep')).toBe('credits');

    vi.spyOn(Date, 'now').mockReturnValue(99_999_999_999_999);
    sweep?.();

    expect(await mod.getTeamPlan('team_sweep')).toBe('growth');
    expect(await mod.getTeamBillingMode('team_sweep')).toBe('subscription');
    expect(mockQuery).toHaveBeenCalledTimes(4);
    expect(setIntervalSpy).toHaveBeenCalled();
  });
});
