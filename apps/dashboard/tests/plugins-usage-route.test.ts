import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_IDS, type PluginsUsageEnvelope } from '@/lib/plugins';

const h = vi.hoisted(() => ({
  member: { userId: 'user_1', teamId: 'team_1', role: 'admin' } as {
    userId: string;
    teamId: string;
    role: string;
  } | null,
  query: vi.fn(),
  demoActive: false,
}));

vi.mock('@/lib/rbac', () => ({
  requireTeamMembership: async () => h.member,
}));
vi.mock('@/lib/db', () => ({
  getPool: () => ({ query: h.query }),
}));
vi.mock('@/lib/demo', () => ({
  isDemoActive: async () => h.demoActive,
  getEffectiveTeamId: async (teamId: string | null | undefined) => (
    h.demoActive ? 'team_demo' : teamId ?? null
  ),
  DEMO_WRITE_BLOCKED_MESSAGE: 'Demo mode is read-only.',
}));

import { GET } from '@/app/api/plugins/usage/route';

// Aggregate queries without GROUP BY always return exactly one row in
// Postgres, so the default summary mock mirrors the real zero-fill shape
// (bigint cost arrives as a string, ::int counts arrive as numbers).
const SUMMARY_ROW = {
  total_runs: 6,
  requests_with_plugins: 4,
  total_plugin_cost_microcents: '15500000',
};

function mockPluginQueries(overrides: {
  summary?: unknown[];
  byPlugin?: unknown[];
  warnings?: unknown[];
} = {}) {
  const summary = overrides.summary ?? [SUMMARY_ROW];
  const byPlugin = overrides.byPlugin ?? [];
  const warnings = overrides.warnings ?? [];
  h.query.mockImplementation(async (sql: string) => {
    if (sql.includes('COUNT(DISTINCT request_id)')) return { rows: summary };
    if (sql.includes('GROUP BY plugin_id')) return { rows: byPlugin };
    if (sql.includes("status <> 'ok'")) return { rows: warnings };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
}

beforeEach(() => {
  h.member = { userId: 'user_1', teamId: 'team_1', role: 'admin' };
  h.demoActive = false;
  h.query.mockReset();
});

describe('GET /api/plugins/usage', () => {
  it('returns 401 without a team membership and never touches the pool', async () => {
    h.member = null;

    const res = await GET(new Request('https://app.test/api/plugins/usage'));

    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(h.query).not.toHaveBeenCalled();
  });

  it('returns the exact usage envelope with integer microcents for the default 7d period', async () => {
    mockPluginQueries({
      summary: [SUMMARY_ROW],
      byPlugin: [
        { plugin_id: 'web', runs: 4, ok: 3, warning: 1, error: 0, skipped: 0, cost_microcents: '14000000' },
        { plugin_id: 'file-parser', runs: 2, ok: 2, warning: 0, error: 0, skipped: 0, cost_microcents: '1500000' },
      ],
      warnings: [
        {
          plugin_id: 'web',
          status: 'warning',
          detail: 'web_search_no_results',
          cost_microcents: '250000',
          latency_ms: 812,
          created_at: new Date('2026-07-31T12:00:00Z'),
        },
      ],
    });

    const res = await GET(new Request('https://app.test/api/plugins/usage'));
    const payload: PluginsUsageEnvelope = await res.json();

    expect(res.status).toBe(200);
    // Team-scoped private read: never cacheable by any intermediary.
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(payload).toEqual({
      period: '7d',
      summary: {
        total_plugin_cost_microcents: 15500000,
        total_runs: 6,
        requests_with_plugins: 4,
        by_plugin: [
          { plugin_id: 'web', runs: 4, ok: 3, warning: 1, error: 0, skipped: 0, cost_microcents: 14000000 },
          { plugin_id: 'file-parser', runs: 2, ok: 2, warning: 0, error: 0, skipped: 0, cost_microcents: 1500000 },
        ],
      },
      recent_warnings: [
        {
          plugin_id: 'web',
          status: 'warning',
          detail: 'web_search_no_results',
          cost_microcents: 250000,
          latency_ms: 812,
          created_at: '2026-07-31T12:00:00.000Z',
        },
      ],
    });

    // Three team-scoped queries against plugin_runs: summary totals,
    // per-plugin rollup, and the recent-warnings feed. The warnings feed is
    // deliberately all-time (no created_at bind): the UI labels it as such.
    // The two windowed queries share ONE snapshot instant ($3, the same Date
    // object) so totals and the breakdown can never read-warp apart.
    expect(h.query).toHaveBeenCalledTimes(3);
    const sql = h.query.mock.calls.map((call) => String(call[0]));
    expect(sql.every((s) => s.includes('FROM plugin_runs') && s.includes('team_id = $1'))).toBe(true);
    expect(h.query.mock.calls[0]?.[1]?.[0]).toBe('team_1');
    expect(h.query.mock.calls[0]?.[1]?.[1]).toBe(168);
    expect(h.query.mock.calls[0]?.[1]?.[2]).toBeInstanceOf(Date);
    expect(h.query.mock.calls[1]?.[1]).toEqual(h.query.mock.calls[0]?.[1]);
    expect(h.query.mock.calls[2]?.[1]).toEqual(['team_1']);
    expect(sql[2]).toContain("status <> 'ok'");
    expect(sql[2]).toContain('LIMIT 20');
    expect(sql[2]).not.toContain('make_interval');
  });

  it.each([
    { period: '24h', hours: 24 },
    { period: '30d', hours: 720 },
  ])('maps period=$period to its whitelisted lookback hours', async ({ period, hours }) => {
    mockPluginQueries();

    const res = await GET(new Request(`https://app.test/api/plugins/usage?period=${period}`));
    const payload: PluginsUsageEnvelope = await res.json();

    expect(res.status).toBe(200);
    expect(payload.period).toBe(period);
    expect(h.query.mock.calls[0]?.[1]?.[0]).toBe('team_1');
    expect(h.query.mock.calls[0]?.[1]?.[1]).toBe(hours);
    expect(h.query.mock.calls[1]?.[1]?.[1]).toBe(hours);
  });

  it('falls back to 7d for a poison period param and never lets it reach SQL', async () => {
    mockPluginQueries();

    const res = await GET(new Request('https://app.test/api/plugins/usage?period=year%3BDROP'));
    const payload: PluginsUsageEnvelope = await res.json();

    expect(res.status).toBe(200);
    expect(payload.period).toBe('7d');
    expect(h.query.mock.calls[0]?.[1]?.[0]).toBe('team_1');
    expect(h.query.mock.calls[0]?.[1]?.[1]).toBe(168);
    for (const call of h.query.mock.calls) {
      expect(String(call[0])).not.toContain('year;DROP');
      expect(JSON.stringify(call[1])).not.toContain('year;DROP');
    }
  });

  it('ignores client-supplied team identifiers entirely', async () => {
    mockPluginQueries();

    const res = await GET(
      new Request('https://app.test/api/plugins/usage?team_id=team_evil&team=team_evil'),
    );

    expect(res.status).toBe(200);
    expect(h.query).toHaveBeenCalledTimes(3);
    // Only the membership-derived (or demo) team id may ever bind $1.
    expect(h.query.mock.calls.map((call) => call[1]?.[0])).toEqual([
      'team_1',
      'team_1',
      'team_1',
    ]);
    expect(JSON.stringify(h.query.mock.calls)).not.toContain('team_evil');
  });

  it('scopes every query to the demo team when demo mode is active', async () => {
    h.demoActive = true;
    mockPluginQueries();

    const res = await GET(new Request('https://app.test/api/plugins/usage'));

    expect(res.status).toBe(200);
    expect(h.query).toHaveBeenCalledTimes(3);
    expect(h.query.mock.calls.map((call) => call[1]?.[0])).toEqual([
      'team_demo',
      'team_demo',
      'team_demo',
    ]);
  });

  it('returns the flat 500 envelope with no-store when the pool throws', async () => {
    h.query.mockRejectedValue(new Error('db down'));

    const res = await GET(new Request('https://app.test/api/plugins/usage'));

    expect(res.status).toBe(500);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'Failed to load plugin usage' });
  });

  it('always returns both PLUGIN_IDS rows, zero-filled when a plugin has no runs', async () => {
    expect(PLUGIN_IDS).toEqual(['web', 'file-parser']);
    mockPluginQueries({
      summary: [{ total_runs: 3, requests_with_plugins: 2, total_plugin_cost_microcents: '7500000' }],
      byPlugin: [
        { plugin_id: 'web', runs: 3, ok: 2, warning: 0, error: 1, skipped: 0, cost_microcents: '7500000' },
      ],
    });

    const res = await GET(new Request('https://app.test/api/plugins/usage'));
    const payload: PluginsUsageEnvelope = await res.json();

    expect(res.status).toBe(200);
    expect(payload.summary.by_plugin).toEqual([
      { plugin_id: 'web', runs: 3, ok: 2, warning: 0, error: 1, skipped: 0, cost_microcents: 7500000 },
      { plugin_id: 'file-parser', runs: 0, ok: 0, warning: 0, error: 0, skipped: 0, cost_microcents: 0 },
    ]);
    expect(payload.summary.by_plugin.slice(0, PLUGIN_IDS.length).map((p) => p.plugin_id)).toEqual([...PLUGIN_IDS]);
    expect(payload.recent_warnings).toEqual([]);
  });

  it('unions plugin ids recorded in the table that are not in PLUGIN_IDS, so totals always equal the breakdown', async () => {
    // plugin_runs.plugin_id has no CHECK constraint (migration 047): a new
    // proxy plugin would otherwise inflate summary totals while vanishing
    // from the per-plugin table.
    mockPluginQueries({
      summary: [{ total_runs: 5, requests_with_plugins: 3, total_plugin_cost_microcents: '9000000' }],
      byPlugin: [
        { plugin_id: 'web', runs: 3, ok: 3, warning: 0, error: 0, skipped: 0, cost_microcents: '7500000' },
        { plugin_id: 'code-exec', runs: 2, ok: 1, warning: 0, error: 1, skipped: 0, cost_microcents: '1500000' },
      ],
    });

    const res = await GET(new Request('https://app.test/api/plugins/usage'));
    const payload: PluginsUsageEnvelope = await res.json();

    expect(res.status).toBe(200);
    expect(payload.summary.by_plugin).toEqual([
      { plugin_id: 'web', runs: 3, ok: 3, warning: 0, error: 0, skipped: 0, cost_microcents: 7500000 },
      { plugin_id: 'file-parser', runs: 0, ok: 0, warning: 0, error: 0, skipped: 0, cost_microcents: 0 },
      { plugin_id: 'code-exec', runs: 2, ok: 1, warning: 0, error: 1, skipped: 0, cost_microcents: 1500000 },
    ]);
    const lineItems = payload.summary.by_plugin.reduce((sum, row) => sum + row.cost_microcents, 0);
    expect(lineItems).toBe(payload.summary.total_plugin_cost_microcents);
  });
});
