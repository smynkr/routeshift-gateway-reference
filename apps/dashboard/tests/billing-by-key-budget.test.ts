import { beforeEach, describe, expect, it, vi } from 'vitest';

// RSH-138: /api/billing/by-key attaches daily/weekly/monthly window status per
// key via the shared serializer, stays no-store, and never merges unknown
// spend into an exact-looking total.

const h = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('@/lib/db', () => ({ getPool: () => ({ query: h.query }) }));
vi.mock('@/lib/rbac', () => ({ requireTeamMembership: async () => ({ teamId: 'team_1' }) }));
vi.mock('@/lib/demo', () => ({ getEffectiveTeamId: async (t: string) => t }));

import { getBudgetWindows } from '@routeshift/shared';
import { GET } from '@/app/api/billing/by-key/route';

beforeEach(() => {
  h.query.mockReset();
});

const baseSpendRows = [{
  api_key_id: 'key_1',
  key_prefix: 'sk-proxy-live_ab',
  name: 'main',
  metadata: {},
  requests: 3,
  input_tokens: 100,
  output_tokens: 50,
  cost_microcents: '120',
  unknown_cost_requests: 1,
}];

function mockQueries() {
  // 1: spend aggregation, 2: api_keys caps, 3: budget_period_usage,
  // 4: key-scoped unbounded unknown rows
  h.query
    .mockResolvedValueOnce({ rows: baseSpendRows })
    .mockResolvedValueOnce({
      rows: [{ id: 'key_1', daily_usd_cap: '10.00000000', weekly_usd_cap: null, monthly_usd_cap: '100.00000000', cap_action: 'block', soft_alert_at_pct: 80 }],
    })
    .mockResolvedValueOnce({
      rows: [{
        api_key_id: 'key_1',
        window_kind: 'daily',
        period_start: new Date('2026-08-09T00:00:00Z'),
        period_end: new Date('2026-08-10T00:00:00Z'),
        actual_microcents: '1000000000',
        reserved_microcents: '0',
        unknown_held_microcents: '500000000',
        unknown_cost_requests: '1',
      }],
    })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ exists: false }] })
    .mockResolvedValueOnce({ rows: [{ hard_cap_action: 'block', has_cap: true }] })
    // RSH-140: identity caps, identity periods, identity unbounded
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] });
}

describe('billing by-key window status (RSH-138)', () => {
  it('attaches per-key window status and stays no-store', async () => {
    mockQueries();
    const res = await GET(new Request('https://app.test/api/billing/by-key'));

    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const data = await res.json();
    const row = data.rows[0];
    // daily: cap $10, committed $15 (10 actual + 5 held) → block status; the
    // unknown $5 is surfaced as a lower bound, not exact spend.
    const daily = row.budget_windows.find((w: { kind: string }) => w.kind === 'daily');
    expect(daily.cap_usd).toBe(10);
    expect(daily.committed_usd).toBe(15);
    expect(daily.unknown_held_usd).toBe(5);
    expect(daily.status).toBe('block');
    // reset_at derives from the real UTC window arithmetic, never a fixture
    expect(daily.reset_at).toBe(getBudgetWindows(new Date())[0].resetAt);
    // monthly has a cap but no ledger → ok, unconfigured weekly → no cap
    expect(row.budget_windows.find((w: { kind: string }) => w.kind === 'monthly').status).toBe('ok');
    expect(row.budget_windows.find((w: { kind: string }) => w.kind === 'weekly').cap_usd).toBeNull();
    // unknown cost never lands in the exact spend total
    expect(row.cost_microcents).toBe(120);
    expect(data.actual_costs_qualified).toBe(false);
  });

  it('keeps rows without caps free of fabricated status', async () => {
    h.query
      .mockResolvedValueOnce({ rows: baseSpendRows })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ exists: false }] })
      .mockResolvedValueOnce({ rows: [{ hard_cap_action: 'block', has_cap: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await GET(new Request('https://app.test/api/billing/by-key'));

    const data = await res.json();
    const row = data.rows[0];
    for (const w of row.budget_windows) {
      expect(w.cap_usd).toBeNull();
      expect(w.status).toBe('ok');
      expect(w.committed_usd).toBe(0);
    }
  });

  it('attaches identity windows for keys carrying layer_identity_id (RSH-140)', async () => {
    h.query
      .mockResolvedValueOnce({ rows: [{
        ...baseSpendRows[0],
        metadata: { layer_identity_id: 'person-1' },
      }] })
      .mockResolvedValueOnce({ rows: [] }) // api_keys caps
      .mockResolvedValueOnce({ rows: [] }) // key periods
      .mockResolvedValueOnce({ rows: [] }) // key unbounded
      .mockResolvedValueOnce({ rows: [{ exists: false }] }) // team unbounded
      .mockResolvedValueOnce({ rows: [{ hard_cap_action: 'block', has_cap: true }] }) // team budget
      .mockResolvedValueOnce({ rows: [{ identity_id: 'person-1', daily_usd_cap: '5.00000000', weekly_usd_cap: null, monthly_usd_cap: null, cap_action: 'block', soft_alert_at_pct: 80 }] }) // identity caps
      .mockResolvedValueOnce({ rows: [{
        identity_id: 'person-1',
        window_kind: 'daily',
        period_start: new Date('2026-08-09T00:00:00Z'),
        period_end: new Date('2026-08-10T00:00:00Z'),
        actual_microcents: '0',
        reserved_microcents: '400000000',
        unknown_held_microcents: '0',
        unknown_cost_requests: '0',
      }] }) // identity periods
      .mockResolvedValueOnce({ rows: [] }); // identity unbounded
    const res = await GET(new Request('https://app.test/api/billing/by-key'));
    expect(res.status).toBe(200);
    const data = await res.json();
    const row = data.rows[0];
    expect(row.identity_windows).not.toBeNull();
    expect(row.identity_windows.identity_id).toBe('person-1');
    const daily = row.identity_windows.windows.find((w: { kind: string }) => w.kind === 'daily');
    expect(daily.cap_usd).toBe(5);
    expect(daily.committed_usd).toBe(4);
  });
});
