import { beforeEach, describe, expect, it, vi } from 'vitest';

// RSH-60 + RSH-138: the budget upsert preserves each cap when its key is
// omitted, clears exactly the field an explicit null targets, and validates
// values before SQL. The upsert carries a supplied-flag + value pair per cap.

const h = vi.hoisted(() => ({ body: {} as Record<string, unknown>, query: vi.fn() }));

vi.mock('@/lib/db', () => ({ getPool: () => ({ query: h.query }) }));
vi.mock('@/lib/rbac', () => ({
  requireRole: async () => ({ teamId: 'team_1', userId: 'u1', role: 'admin' }),
  requireTeamMembership: async () => ({ teamId: 'team_1' }),
}));
vi.mock('@/lib/demo', () => ({
  DEMO_WRITE_BLOCKED_MESSAGE: 'demo',
  isDemoActive: async () => false,
  getEffectiveTeamId: async (t: string) => t,
}));
vi.mock('@/lib/request-json', () => ({ readJsonObject: async () => h.body }));
vi.mock('@/lib/budget-report', () => ({
  loadBudgetReport: async (teamId: string) => ({ teamId, windows: [], actual_costs_qualified: true }),
}));

import { PUT } from '@/app/api/billing/budget/route';

beforeEach(() => {
  h.query.mockReset().mockResolvedValue({ rows: [] });
});

function put() {
  return PUT(new Request('https://app.test/api/billing/budget', { method: 'PUT' }));
}

// Param layout: [teamId, dailySupplied, dailyVal, weeklySupplied, weeklyVal,
// monthlySupplied, monthlyVal, alertPct, action]
function upsert() {
  return h.query.mock.calls[0]!;
}

describe('budget PUT partial update (RSH-60 + RSH-138)', () => {
  it('preserves the existing caps when all three cap keys are omitted', async () => {
    h.body = { alert_at_pct: 90 };
    await put();

    const [sql, params] = upsert();
    expect(String(sql)).toContain('CASE WHEN $2 THEN $3 ELSE team_budgets.daily_usd_cap END');
    expect(String(sql)).toContain('CASE WHEN $4 THEN $5 ELSE team_budgets.weekly_usd_cap END');
    expect(String(sql)).toContain('CASE WHEN $6 THEN $7 ELSE team_budgets.monthly_usd_cap END');
    expect((params as unknown[])[1]).toBe(false); // daily not supplied
    expect((params as unknown[])[3]).toBe(false); // weekly not supplied
    expect((params as unknown[])[5]).toBe(false); // monthly not supplied
  });

  it('clears exactly one cap when that field is explicitly null', async () => {
    h.body = { daily_usd_cap: null };
    await put();

    const [sql, params] = upsert();
    expect(String(sql)).toContain('CASE WHEN $2 THEN $3 ELSE team_budgets.daily_usd_cap END');
    expect((params as unknown[])[1]).toBe(true); // daily supplied
    expect((params as unknown[])[2]).toBeNull(); // explicit null clears daily
    expect((params as unknown[])[3]).toBe(false); // weekly untouched
    expect((params as unknown[])[5]).toBe(false); // monthly untouched
  });

  it('validates to exact microcents but persists the USD spelling', async () => {
    h.body = { daily_usd_cap: 0.07, weekly_usd_cap: 8.29, monthly_usd_cap: 500 };
    await put();

    const params = upsert()[1] as unknown[];
    expect(params[1]).toBe(true);
    // numeric(20,8) USD columns: validation is exact microcents, persistence
    // is the USD decimal (the admission service re-parses exactly).
    expect(params[2]).toBeCloseTo(0.07, 10);
    expect(params[4]).toBeCloseTo(8.29, 10);
    expect(params[6]).toBe(500);
  });

  it('rejects a negative cap before any SQL', async () => {
    h.body = { weekly_usd_cap: -1 };
    const res = await put();

    expect(res.status).toBe(400);
    expect(h.query).not.toHaveBeenCalled();
  });

  it('rejects a sub-microcent cap before any SQL', async () => {
    h.body = { monthly_usd_cap: 0.000000001 };
    const res = await put();

    expect(res.status).toBe(400);
    expect(h.query).not.toHaveBeenCalled();
  });

  it('preserves alert and action fields when omitted', async () => {
    h.body = { monthly_usd_cap: 100 };
    await put();

    const [sql, params] = upsert();
    expect(String(sql)).toContain('alert_at_pct = COALESCE($8, team_budgets.alert_at_pct)');
    expect(String(sql)).toContain('hard_cap_action = COALESCE($9, team_budgets.hard_cap_action)');
    expect((params as unknown[])[7]).toBeNull(); // alert omitted
    expect((params as unknown[])[8]).toBeNull(); // action omitted
  });

  it('updates alert and action when explicitly supplied', async () => {
    h.body = { alert_at_pct: 85, hard_cap_action: 'throttle' };
    await put();

    const params = upsert()[1] as unknown[];
    expect(params[7]).toBe(85);
    expect(params[8]).toBe('throttle');
  });
});
