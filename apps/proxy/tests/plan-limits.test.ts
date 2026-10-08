import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock DB pool
// ---------------------------------------------------------------------------
const mockQuery = vi.fn();

vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({ query: mockQuery }),
}));

import {
  checkLimit,
  getPlanLimits,
  getTeamPlan,
  getTeamBillingMode,
  invalidatePlanCache,
  invalidateBillingModeCache,
} from '../src/billing/plan-limits.js';

beforeEach(() => {
  mockQuery.mockReset();
  // Clear caches between tests
  invalidatePlanCache('team_1');
  invalidatePlanCache('team_2');
  invalidateBillingModeCache('team_1');
  invalidateBillingModeCache('team_2');
  // Ensure DATABASE_URL is set so we don't short-circuit to defaults
  process.env.DATABASE_URL = 'postgres://localhost/test';
});

// ---------------------------------------------------------------------------
// getPlanLimits
// ---------------------------------------------------------------------------
describe('getPlanLimits', () => {
  // LAY-344 Option A: single-tier model. Free = no active subscription,
  // unlimited features but 0% savings-share. Pro = active subscription,
  // unlimited features + 3% savings-share. Legacy slugs (starter /
  // growth / enterprise) are preserved as aliases of pro.
  it('returns correct limits for free plan', () => {
    const limits = getPlanLimits('free');
    expect(limits.maxKeys).toBe(Infinity);
    expect(limits.maxRules).toBe(Infinity);
    expect(limits.fallbacksEnabled).toBe(true);
    expect(limits.savingsSharePercent).toBe(0);
  });

  it('returns correct limits for pro plan', () => {
    const limits = getPlanLimits('pro');
    expect(limits.maxKeys).toBe(Infinity);
    expect(limits.maxRules).toBe(Infinity);
    expect(limits.fallbacksEnabled).toBe(true);
    expect(limits.savingsSharePercent).toBe(3);
    expect(limits.creditsMarkupPercent).toBe(3);
  });

  it.each(['starter', 'growth', 'enterprise'])(
    'legacy slug "%s" is identical to pro',
    (slug) => {
      expect(getPlanLimits(slug)).toEqual(getPlanLimits('pro'));
    },
  );

  it('falls back to free plan for unknown plan name', () => {
    const limits = getPlanLimits('nonexistent');
    expect(limits).toEqual(getPlanLimits('free'));
  });
});

// ---------------------------------------------------------------------------
// getTeamPlan
// ---------------------------------------------------------------------------
describe('getTeamPlan', () => {
  it('returns plan from DB on cache miss', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'growth' }] });

    const plan = await getTeamPlan('team_1');
    expect(plan).toBe('growth');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('returns cached plan on cache hit (no additional DB query)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ plan: 'starter' }] });

    const first = await getTeamPlan('team_2');
    expect(first).toBe('starter');

    const second = await getTeamPlan('team_2');
    expect(second).toBe('starter');
    // Only one DB call total
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('re-queries after invalidatePlanCache is called', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ plan: 'starter' }] })
      .mockResolvedValueOnce({ rows: [{ plan: 'growth' }] });

    const first = await getTeamPlan('team_1');
    expect(first).toBe('starter');

    invalidatePlanCache('team_1');
    const second = await getTeamPlan('team_1');
    expect(second).toBe('growth');
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('returns "free" when no DB row exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const plan = await getTeamPlan('team_1');
    expect(plan).toBe('free');
  });

  it('returns "free" when DATABASE_URL is not set', async () => {
    delete process.env.DATABASE_URL;

    const plan = await getTeamPlan('team_1');
    expect(plan).toBe('free');
    // Should not query DB
    expect(mockQuery).not.toHaveBeenCalled();

    // Restore for other tests
    process.env.DATABASE_URL = 'postgres://localhost/test';
  });
});

// ---------------------------------------------------------------------------
// getTeamBillingMode
// ---------------------------------------------------------------------------
describe('getTeamBillingMode', () => {
  it('returns billing mode from DB', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ billing_mode: 'credits' }] });

    const mode = await getTeamBillingMode('team_1');
    expect(mode).toBe('credits');
  });

  it('defaults to "subscription" when no row exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const mode = await getTeamBillingMode('team_1');
    expect(mode).toBe('subscription');
  });

  it('caches result and does not re-query DB', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ billing_mode: 'credits' }] });

    const first = await getTeamBillingMode('team_2');
    const second = await getTeamBillingMode('team_2');
    expect(first).toBe('credits');
    expect(second).toBe('credits');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('re-queries after invalidateBillingModeCache is called', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ billing_mode: 'credits' }] })
      .mockResolvedValueOnce({ rows: [{ billing_mode: 'subscription' }] });

    const first = await getTeamBillingMode('team_1');
    expect(first).toBe('credits');

    invalidateBillingModeCache('team_1');
    const second = await getTeamBillingMode('team_1');
    expect(second).toBe('subscription');
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('returns "subscription" when DATABASE_URL is not set', async () => {
    delete process.env.DATABASE_URL;

    const mode = await getTeamBillingMode('team_1');
    expect(mode).toBe('subscription');
    expect(mockQuery).not.toHaveBeenCalled();

    process.env.DATABASE_URL = 'postgres://localhost/test';
  });
});

describe('checkLimit', () => {
  // LAY-344 Option A: every plan (including free) has unlimited keys and
  // rules. checkLimit always returns allowed=true; only the resource
  // count + the SQL emitted are interesting now.
  it('counts keys and reports unlimited cap', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ plan: 'free' }] })
      .mockResolvedValueOnce({ rows: [{ count: 12 }] });

    const result = await checkLimit('team_1', 'keys');

    expect(result).toEqual({ allowed: true, current: 12, limit: Infinity });
    expect(mockQuery).toHaveBeenNthCalledWith(
      2,
      'SELECT COUNT(*)::int AS count FROM api_keys WHERE team_id = $1 AND revoked_at IS NULL',
      ['team_1'],
    );
  });

  it('counts rules and reports unlimited cap', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ plan: 'pro' }] })
      .mockResolvedValueOnce({ rows: [{ count: 25 }] });

    const result = await checkLimit('team_2', 'rules');

    expect(result).toEqual({ allowed: true, current: 25, limit: Infinity });
    expect(mockQuery).toHaveBeenNthCalledWith(
      2,
      'SELECT COUNT(*)::int AS count FROM routing_rules WHERE team_id = $1 AND enabled = true',
      ['team_2'],
    );
  });
});
