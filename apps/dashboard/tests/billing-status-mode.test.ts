import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  member: { userId: 'user_1', teamId: 'team_1', role: 'admin' },
  query: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ getPool: () => ({ query: h.query }) }));
vi.mock('@/lib/rbac', () => ({
  requireTeamMembership: async () => h.member,
  hasRole: () => true,
}));
vi.mock('@/lib/demo', () => ({
  getEffectiveTeamId: async (teamId: string) => teamId,
  isDemoActive: async () => false,
}));

import { GET } from '@/app/api/billing/status/route';

describe('GET /api/billing/status fee basis', () => {
  beforeEach(() => {
    h.query.mockReset();
    h.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM subscriptions')) {
        return {
          rows: [{
            id: 'sub_1',
            plan: 'pro',
            status: 'active',
            current_period_start: new Date('2026-07-01T00:00:00Z'),
            current_period_end: new Date('2026-08-01T00:00:00Z'),
            cancel_at_period_end: false,
          }],
        };
      }
      if (sql.includes('FROM teams')) return { rows: [{ billing_mode: 'subscription' }] };
      if (sql.includes('SUM(GREATEST')) return { rows: [{ total_savings: '5000000' }] };
      if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
      return { rows: [] };
    });
  });

  it('counts only subscription logs in the period savings-share basis', async () => {
    const response = await GET(new Request('https://app.test/api/billing/status') as never);

    expect(response.status).toBe(200);
    const savingsCall = h.query.mock.calls.find(([sql]) => String(sql).includes('SUM(GREATEST'));
    expect(savingsCall).toBeDefined();
    expect(String(savingsCall?.[0])).toContain("billing_mode = 'subscription'");
    expect((await response.json()).period_savings_cents).toBe(5);
  });

  it('qualifies credits mode against unknown requests in the current UTC month', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-27T15:30:00Z'));
    h.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM subscriptions')) {
        return {
          rows: [{
            id: 'sub_lingering',
            plan: 'pro',
            status: 'active',
            current_period_start: new Date('2026-07-01T00:00:00Z'),
            current_period_end: new Date('2026-08-01T00:00:00Z'),
            cancel_at_period_end: false,
          }],
        };
      }
      if (sql.includes('FROM teams')) return { rows: [{ billing_mode: 'credits' }] };
      if (sql.includes('actual_cost_known = false')) return { rows: [{ unknown_cost_requests: 1 }] };
      if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
      return { rows: [] };
    });

    try {
      const response = await GET(new Request('https://app.test/api/billing/status') as never);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.billing_mode).toBe('credits');
      expect(body.period_savings_cents).toBe(0);
      expect(body.unknown_cost_requests).toBe(1);
      expect(body.actual_costs_qualified).toBe(false);

      const unknownCall = h.query.mock.calls.find(([sql]) => String(sql).includes('actual_cost_known = false'));
      expect(unknownCall).toBeDefined();
      expect(String(unknownCall?.[0])).toContain("billing_mode = 'credits'");
      expect(unknownCall?.[1]?.[1]).toEqual(new Date('2026-07-01T00:00:00Z'));
      expect(unknownCall?.[1]?.[2]).toEqual(new Date('2026-07-27T15:30:00Z'));
    } finally {
      vi.useRealTimers();
    }
  });
});
