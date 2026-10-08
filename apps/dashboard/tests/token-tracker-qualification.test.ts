import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('@/lib/db', () => ({ getPool: () => ({ query: h.query }) }));
vi.mock('@/lib/rbac', () => ({ requireTeamMembership: async () => ({ teamId: 'team_1' }) }));
vi.mock('@/lib/demo', () => ({ getEffectiveTeamId: async (teamId: string) => teamId }));

import { GET } from '@/app/api/usage/token-tracker/route';

describe('token tracker cost qualification', () => {
  it('maps false and numeric-zero expensive rows as unknown', async () => {
    h.query.mockImplementation(async (sql: string) => {
      if (sql.includes('ORDER BY billed_cost_microcents')) {
        return {
          rows: [
            { id: 'unknown-false', actual_cost_known: false, actual_cost_microcents: '10', billed_cost_microcents: '10' },
            { id: 'unknown-zero', actual_cost_known: 0, actual_cost_microcents: '20', billed_cost_microcents: '20' },
          ],
        };
      }
      return { rows: [{}] };
    });

    const response = await GET(new Request('https://app.test/api/usage/token-tracker?period=24h'));
    expect(response.status).toBe(200);
    expect((await response.json()).expensive_requests).toEqual([
      expect.objectContaining({ id: 'unknown-false', actual_cost_known: false }),
      expect.objectContaining({ id: 'unknown-zero', actual_cost_known: false }),
    ]);
  });
});
