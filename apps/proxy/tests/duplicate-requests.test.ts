import { describe, it, expect, vi } from 'vitest';
import { duplicateRequestsRule } from '../src/optimize/rules/duplicate-requests.js';
import type { Pool } from 'pg';

function mockPool(rows: any[]): Pool {
  return { query: vi.fn().mockResolvedValue({ rows }) } as unknown as Pool;
}

const ctx = (pool: Pool) => ({ pool, teamId: 'team_a', lookbackDays: 7 });

describe('duplicate-requests rule', () => {
  it('returns null when no duplicate hash crosses the floor', async () => {
    // The HAVING clause filters below 50 server-side, so the test mirrors
    // that by returning an empty rowset.
    const pool = mockPool([]);
    expect(await duplicateRequestsRule.detect(ctx(pool))).toBeNull();
  });

  it('flags medium severity when 50 <= dup_count <= 200', async () => {
    const pool = mockPool([{
      message_hash: 'abc123def4567890',
      dup_count: '120',
      avg_cost_microcents: '5000',
      total_cost_microcents: '600000',
    }]);
    const finding = await duplicateRequestsRule.detect(ctx(pool));
    expect(finding).not.toBeNull();
    expect(finding!.severity).toBe('medium');
    expect(finding!.body_md).toContain('120');
    expect(finding!.body_md).toContain('24 hours');
    expect(finding!.fix_md).toContain('Response Cache');
  });

  it('flags high severity when dup_count > 200', async () => {
    const pool = mockPool([{
      message_hash: 'abc123def4567890',
      dup_count: '500',
      avg_cost_microcents: '5000',
      total_cost_microcents: '2500000',
    }]);
    const finding = await duplicateRequestsRule.detect(ctx(pool));
    expect(finding!.severity).toBe('high');
  });

  it('savings projected to monthly = avg_cost * (dups - 1) * 30', async () => {
    const pool = mockPool([{
      message_hash: 'abc123def4567890',
      dup_count: '100',
      avg_cost_microcents: '1000',
      total_cost_microcents: '100000',
    }]);
    const finding = await duplicateRequestsRule.detect(ctx(pool));
    // 1000 * 99 * 30 = 2_970_000 microcents
    expect(finding!.estimated_savings_microcents).toBe(2_970_000n);
  });

  it('renders per-request cost in USD with the canonical microcents divisor (not 1000x)', async () => {
    const pool = mockPool([{
      message_hash: 'abc123def4567890',
      dup_count: '100',
      avg_cost_microcents: '5000000', // 5,000,000 microcents = $0.05
      total_cost_microcents: '500000000',
    }]);
    const finding = await duplicateRequestsRule.detect(ctx(pool));
    expect(finding!.body_md).toContain('$0.050000 per request');
    expect(finding!.body_md).not.toContain('$50'); // the old 1/100_000 divisor
  });

  it('passes the 24-hour lookback to the query, not lookbackDays', async () => {
    const queryFn = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query: queryFn } as unknown as Pool;
    await duplicateRequestsRule.detect({ pool, teamId: 'team_a', lookbackDays: 7 });
    const params = queryFn.mock.calls[0][1];
    // params: [teamId, hours, floor]
    expect(params[1]).toBe(24);
    expect(params[2]).toBe(50);
  });
});
