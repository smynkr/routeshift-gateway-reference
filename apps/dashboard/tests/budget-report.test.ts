import { beforeEach, describe, expect, it, vi } from 'vitest';

// RSH-138: the dashboard report loader delegates all committed arithmetic and
// action precedence to @routeshift/shared's buildBudgetReport; these tests pin
// the DB→serializer wiring: period rows, qualification, and UTC reset
// serialization.

const h = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('@/lib/db', () => ({ getPool: () => ({ query: h.query }) }));

import { loadBudgetReport } from '@/lib/budget-report';

beforeEach(() => {
  h.query.mockReset();
});

const now = new Date('2026-08-09T12:00:00Z'); // Sunday — weekly window is 2026-08-03

function mockRows(config: unknown, periods: unknown[], unbounded: unknown[] = []) {
  h.query
    .mockResolvedValueOnce({ rows: config })
    .mockResolvedValueOnce({ rows: periods })
    .mockResolvedValueOnce({ rows: unbounded });
}

describe('loadBudgetReport', () => {
  it('returns three unconfigured windows with no ledger rows', async () => {
    mockRows([], [], []);
    const report = await loadBudgetReport('team_a', now);

    expect(report.windows).toHaveLength(3);
    expect(report.windows.map((w) => w.kind)).toEqual(['daily', 'weekly', 'monthly']);
    for (const w of report.windows) {
      expect(w.cap_usd).toBeNull();
      expect(w.committed_usd).toBe(0);
      expect(w.status).toBe('ok');
    }
    expect(report.windows[1].period_start).toBe('2026-08-03T00:00:00.000Z'); // ISO Monday
    expect(report.windows[0].reset_at).toBe('2026-08-10T00:00:00.000Z'); // next UTC midnight
    expect(report.actual_costs_qualified).toBe(true);
  });

  it('delegates committed arithmetic to the shared serializer', async () => {
    mockRows(
      [{ daily_usd_cap: '100.00000000', weekly_usd_cap: null, monthly_usd_cap: '500.00000000', alert_at_pct: 80, hard_cap_action: 'block' }],
      [
        {
          window_kind: 'daily',
          period_start: new Date('2026-08-09T00:00:00Z'),
          period_end: new Date('2026-08-10T00:00:00Z'),
          actual_microcents: '4000000000',
          reserved_microcents: '500000000',
          unknown_held_microcents: '100000000',
          unknown_cost_requests: '1',
        },
      ],
      [],
    );

    const report = await loadBudgetReport('team_a', now);

    const daily = report.windows.find((w) => w.kind === 'daily')!;
    expect(daily.cap_usd).toBe(100);
    expect(daily.known_spend_usd).toBe(40);
    expect(daily.reserved_usd).toBe(5);
    expect(daily.unknown_held_usd).toBe(1);
    // committed = actual + held + reserved = 40 + 1 + 5 = 46
    expect(daily.committed_usd).toBe(46);
    // unknown_cost_requests > 0 → not qualified (unknown history blocks
    // qualification, not the status — committed is still under the cap).
    expect(report.actual_costs_qualified).toBe(false);
    expect(daily.status).toBe('ok');
    expect(daily.unknown_cost_requests).toBe(1);
    // monthly has a cap but no ledger row → ok
    expect(report.windows.find((w) => w.kind === 'monthly')!.status).toBe('ok');
  });

  it('reports the hard-cap action as status when committed spend exceeds the cap', async () => {
    mockRows(
      [{ daily_usd_cap: '10.00000000', weekly_usd_cap: null, monthly_usd_cap: null, alert_at_pct: 80, hard_cap_action: 'throttle' }],
      [
        {
          window_kind: 'daily',
          period_start: new Date('2026-08-09T00:00:00Z'),
          period_end: new Date('2026-08-10T00:00:00Z'),
          actual_microcents: '1200000000',
          reserved_microcents: '0',
          unknown_held_microcents: '0',
          unknown_cost_requests: '0',
        },
      ],
      [],
    );

    const report = await loadBudgetReport('team_a', now);
    const daily = report.windows.find((w) => w.kind === 'daily')!;
    expect(daily.committed_usd).toBe(12);
    expect(daily.status).toBe('throttle');
    expect(daily.action).toBe('throttle');
  });

  it('flags unbounded unknown rows as not qualified', async () => {
    mockRows(
      [{ daily_usd_cap: '10.00000000', weekly_usd_cap: null, monthly_usd_cap: null, alert_at_pct: 80, hard_cap_action: 'block' }],
      [
        {
          window_kind: 'daily',
          period_start: new Date('2026-08-09T00:00:00Z'),
          period_end: new Date('2026-08-10T00:00:00Z'),
          actual_microcents: '0',
          reserved_microcents: '0',
          unknown_held_microcents: '500000000',
          unknown_cost_requests: '1',
        },
      ],
      [{ period_id: `team_a::daily:2026-08-09T00:00:00.000Z` }],
    );

    const report = await loadBudgetReport('team_a', now);
    expect(report.actual_costs_qualified).toBe(false);
    const daily = report.windows.find((w) => w.kind === 'daily')!;
    // unbounded unknown gates the hard cap → block status
    expect(daily.status).toBe('block');
    expect(daily.unknown_held_usd).toBe(5);
  });

  it('scopes all queries to the authenticated team', async () => {
    mockRows([], [], []);
    await loadBudgetReport('team_scoped', now);

    for (const call of h.query.mock.calls) {
      expect(String(call[0])).toContain('team_id = $1');
      expect((call[1] as unknown[])[0]).toBe('team_scoped');
    }
  });
});
