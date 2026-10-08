/**
 * RSH-140: admin identity-budget caps surface (mocked pool — SQL text and
 * param shapes are the contract under test).
 */
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../src/db/pool.js', () => ({ getPool: () => ({ query: mocks.query }) }));

import { handleGetIdentityBudget, handleListIdentityBudgets, handlePutIdentityBudget } from '../src/admin/identity-budgets.js';

function makeReq(body: unknown, url = '/admin/identity-budgets/one?team_id=team_1&identity_id=person-1') {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { url, headers: {} }) as never;
}

function makeRes() {
  const state = { statusCode: 0, body: '' };
  return {
    writeHead: (c: number) => { state.statusCode = c; },
    end: (b: string) => { state.body = b; },
    state,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('admin identity budgets (RSH-140)', () => {
  it('lists the team\'s identity caps', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ identity_id: 'person-1', daily_usd_cap: '1.00000000', weekly_usd_cap: null, monthly_usd_cap: null, cap_action: 'block', soft_alert_at_pct: 80, updated_at: new Date() }] });
    const res = makeRes() as { state: { statusCode: number; body: string } };
    await handleListIdentityBudgets(makeReq({}, '/admin/identity-budgets?team_id=team_1'), res);
    expect(res.state.statusCode).toBe(200);
    const [sql, params] = mocks.query.mock.calls[0];
    expect(sql).toContain('FROM identity_budget_caps WHERE team_id = $1');
    expect(params[0]).toBe('team_1');
  });

  it('rejects a missing identity_id', async () => {
    const res = makeRes() as { state: { statusCode: number; body: string } };
    await handleGetIdentityBudget(makeReq({}, '/admin/identity-budgets/one?team_id=team_1'), res);
    expect(res.state.statusCode).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('upserts identity caps with exact decimal parsing', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    const res = makeRes() as { state: { statusCode: number; body: string } };
    await handlePutIdentityBudget(makeReq({ daily_usd_cap: 0.07, weekly_usd_cap: 8.29, cap_action: 'block', soft_alert_at_pct: 80 }), res);
    expect(res.state.statusCode).toBe(200);
    const [sql, params] = mocks.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO identity_budget_caps');
    expect(sql).toContain('ON CONFLICT (team_id, identity_id) DO UPDATE');
    expect(sql).toMatch(/daily_usd_cap = \$3/);
    expect(sql).toMatch(/weekly_usd_cap = \$4/);
    expect(sql).toMatch(/cap_action = \$5/);
    expect(params[0]).toBe('team_1');
    expect(params[1]).toBe('person-1');
    // caps bind as their EXACT decimal spelling (numeric(20,8) stores it
    // verbatim; a float division round-trip can drop a microcent)
    expect(params[2]).toBe('0.07000000');
    expect(params[3]).toBe('8.29000000');
    expect(params[4]).toBe('block');
    const body = JSON.parse(res.state.body);
    expect(body.identity_id).toBe('person-1');
    expect(body.daily_usd_cap).toBe('0.07000000');
  });

  it('binds large exact caps without binary-float drift (microcent-exact)', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    const res = makeRes() as { state: { statusCode: number; body: string } };
    // 90063203.89700102 USD is NOT binary-float representable:
    // Number('90063203.89700102') * 1e8 round-trips to ...101 (one microcent
    // low). The PUT must bind the exact spelling.
    await handlePutIdentityBudget(makeReq({ daily_usd_cap: '90063203.89700102' }), res);
    expect(res.state.statusCode).toBe(200);
    const [, params] = mocks.query.mock.calls[0];
    expect(params[2]).toBe('90063203.89700102');
    const body = JSON.parse(res.state.body);
    expect(body.daily_usd_cap).toBe('90063203.89700102');
  });

  it('preserves unmentioned caps on a partial update (COALESCE to existing)', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    const res = makeRes() as { state: { statusCode: number; body: string } };
    // only daily mentioned → weekly/monthly params are null → COALESCE keeps
    // the stored values; cap_action also preserved
    await handlePutIdentityBudget(makeReq({ daily_usd_cap: 0.5 }), res);
    expect(res.state.statusCode).toBe(200);
    const [sql, params] = mocks.query.mock.calls[0];
    expect(params[2]).toBe('0.50000000');
    // absent fields are NOT in the SET clause at all (preserved, not cleared)
    expect(sql).not.toMatch(/weekly_usd_cap = /);
    expect(sql).not.toMatch(/monthly_usd_cap = /);
    expect(sql).not.toMatch(/cap_action = /);
    expect(sql).not.toMatch(/soft_alert_at_pct = /);
    expect(params.length).toBe(3); // team, identity, daily
  });

  it('rejects caps with more than 8 decimals', async () => {
    const res = makeRes() as { state: { statusCode: number; body: string } };
    await handlePutIdentityBudget(makeReq({ daily_usd_cap: 0.0712345678 }), res);
    expect(res.state.statusCode).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('null clears a cap; explicit null soft_alert accepted', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    const res = makeRes() as { state: { statusCode: number; body: string } };
    await handlePutIdentityBudget(makeReq({ daily_usd_cap: null, soft_alert_at_pct: null }), res);
    expect(res.state.statusCode).toBe(200);
    const [sql, params] = mocks.query.mock.calls[0];
    expect(sql).toMatch(/daily_usd_cap = \$3/);
    expect(params[2]).toBeNull(); // explicit null CLEARS daily
    expect(sql).toMatch(/soft_alert_at_pct = \$4/);
    expect(params[3]).toBeNull(); // explicit null accepted for soft_alert
  });

  it('rejects an invalid cap_action instead of silently downgrading to alert', async () => {
    const res = makeRes() as { state: { statusCode: number; body: string } };
    await handlePutIdentityBudget(makeReq({ daily_usd_cap: 0.5, cap_action: 'block ' }), res);
    expect(res.state.statusCode).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('accepts cap_action alert explicitly (alert-only is a valid posture)', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    const res = makeRes() as { state: { statusCode: number; body: string } };
    await handlePutIdentityBudget(makeReq({ daily_usd_cap: 0.5, cap_action: 'alert' }), res);
    expect(res.state.statusCode).toBe(200);
    const [, params] = mocks.query.mock.calls[0];
    expect(params[3]).toBe('alert');
  });
});
