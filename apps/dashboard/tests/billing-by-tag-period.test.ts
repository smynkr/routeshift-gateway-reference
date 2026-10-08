import { beforeEach, describe, expect, it, vi } from 'vitest';

// Regression for the by-tag positional-param collision: $2 is the tag key
// (a TEXT operand of metadata->>$2 / metadata ? $2), so the period's hours
// value must be referenced as $3. The previous code emitted `make_interval(
// hours => $2)`, which typed $2 as the tag text and 500-ed every non-mtd
// period (24h/7d/30d) while leaving the hours value at $3 unreferenced.

const h = vi.hoisted(() => ({
  member: { userId: 'user_1', teamId: 'real_team', role: 'admin' },
  query: vi.fn(),
}));

vi.mock('next/headers', () => ({
  // No demo cookie -> getEffectiveTeamId returns the real team id.
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock('@/lib/rbac', () => ({
  requireTeamMembership: async () => h.member,
  requireRole: async () => h.member,
}));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: h.query }) }));

import { GET } from '@/app/api/billing/by-tag/route';

/** Highest $N placeholder referenced in a SQL string. */
function maxPlaceholder(sql: string): number {
  const nums = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 0;
}

beforeEach(() => {
  vi.clearAllMocks();
  // First call = available-keys lookup; second = the per-tag aggregation.
  h.query.mockImplementation(async (sql: string) => {
    if (sql.includes('jsonb_object_keys')) return { rows: [{ k: 'customer_id' }] };
    return { rows: [{ tag_value: 'acme', keys: 1, requests: 2, input_tokens: 10, output_tokens: 5, cost_microcents: 700 }] };
  });
});

describe('GET /api/billing/by-tag period handling', () => {
  it('uses $3 for the hours interval (not $2, the tag key) on a 7d period and returns 200', async () => {
    const req = new Request('https://dash.test/api/billing/by-tag?key=customer_id&period=7d');
    const res = await GET(req);
    expect(res.status).toBe(200);

    const aggCall = h.query.mock.calls.find(([sql]) => (sql as string).includes('GROUP BY tag_value'));
    expect(aggCall).toBeDefined();
    const [sql, params] = aggCall as [string, unknown[]];

    // The interval must reference $3 (the hours), not $2 (the tag key).
    expect(sql).toContain('make_interval(hours => $3)');
    expect(sql).not.toContain('make_interval(hours => $2)');
    // $2 stays bound to the tag key as a text operand.
    expect(sql).toContain('metadata ? $2');
    // Billing attribution must include plugin charges rather than displaying
    // routing-only actual cost as customer spend.
    expect(sql).toContain('actual_cost_microcents + COALESCE(rl.plugin_cost_microcents, 0)');

    // params: [teamId, tagKey, hours]; 7d => 168 hours.
    expect(params).toEqual(['real_team', 'customer_id', 168]);
    // No placeholder may exceed the number of bound params (catches the class).
    expect(maxPlaceholder(sql)).toBeLessThanOrEqual(params.length);
  });

  it('maps each non-mtd period to the right hours value', async () => {
    for (const [period, hours] of [['24h', 24], ['7d', 168], ['30d', 720]] as const) {
      vi.clearAllMocks();
      h.query.mockImplementation(async (sql: string) =>
        sql.includes('jsonb_object_keys') ? { rows: [] } : { rows: [] },
      );
      const res = await GET(new Request(`https://dash.test/api/billing/by-tag?key=k&period=${period}`));
      expect(res.status).toBe(200);
      const aggCall = h.query.mock.calls.find(([sql]) => (sql as string).includes('GROUP BY tag_value'));
      expect((aggCall as [string, unknown[]])[1]).toEqual(['real_team', 'k', hours]);
    }
  });

  it('mtd (default) binds only teamId + tagKey and references no $3', async () => {
    const res = await GET(new Request('https://dash.test/api/billing/by-tag?key=customer_id'));
    expect(res.status).toBe(200);
    const aggCall = h.query.mock.calls.find(([sql]) => (sql as string).includes('GROUP BY tag_value'));
    const [sql, params] = aggCall as [string, unknown[]];
    expect(params).toEqual(['real_team', 'customer_id']);
    expect(sql).not.toContain('$3');
    expect(maxPlaceholder(sql)).toBeLessThanOrEqual(params.length);
  });

  it('reports a billed-spend total rather than a routing-only actual-cost total', async () => {
    const res = await GET(new Request('https://dash.test/api/billing/by-tag?key=customer_id'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      rows: [{ cost_microcents: 700 }],
      total_cost_microcents: 700,
    });
  });
});
