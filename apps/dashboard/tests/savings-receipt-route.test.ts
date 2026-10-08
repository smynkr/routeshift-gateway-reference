import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  member: { userId: 'user_1', teamId: 'team_1', role: 'admin' } as { userId: string; teamId: string; role: string } | null,
  requireTeamMembership: vi.fn(),
  getEffectiveTeamId: vi.fn(),
  isDemoActive: vi.fn(),
  query: vi.fn(),
}));

vi.mock('@/lib/rbac', () => ({ requireTeamMembership: h.requireTeamMembership }));
vi.mock('@/lib/demo', () => ({ getEffectiveTeamId: h.getEffectiveTeamId, isDemoActive: h.isDemoActive }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: h.query }) }));

import { GET } from '@/app/api/metrics/savings-receipt/route';
import { buildSavingsReceiptCsv, escapeCsv, parseReceiptMonth } from '@/lib/savings-receipt';

beforeEach(() => {
  h.member = { userId: 'user_1', teamId: 'team_1', role: 'admin' };
  h.requireTeamMembership.mockReset().mockResolvedValue(h.member);
  h.getEffectiveTeamId.mockReset().mockImplementation(async (teamId: string) => teamId);
  h.isDemoActive.mockReset().mockResolvedValue(false);
  h.query.mockReset();
});

describe('savings receipt helpers', () => {
  it('parses strict UTC months and rejects malformed values', () => {
    expect(parseReceiptMonth('2026-08')).toMatchObject({ label: 'August 2026' });
    expect(parseReceiptMonth('2026-13')).toBeNull();
    expect(parseReceiptMonth('2026-8')).toBeNull();
    expect(parseReceiptMonth(null)).toBeNull();
  });

  it('escapes CSV values and converts microcents without exposing raw rows', () => {
    expect(escapeCsv('model, "quoted"\nvalue')).toBe('"model, ""quoted""\nvalue"');
    expect(escapeCsv('=HYPERLINK("https://evil.example")')).toBe(`"'=HYPERLINK(""https://evil.example"")"`);
    expect(escapeCsv('+SUM(A1:A2)')).toBe("'+SUM(A1:A2)");
    expect(buildSavingsReceiptCsv(
      {
        month: 'August 2026',
        totalRequests: 2,
        totalOriginalMicrocents: '200000000',
        totalActualMicrocents: '100000000',
        totalBilledMicrocents: '100000000',
        totalSavingsMicrocents: '100000000',
        unknownCostRequests: 1,
        actualCostsQualified: false,
      },
      [{ day: '2026-08-01', originalMicrocents: '200000000', actualMicrocents: '100000000', savingsMicrocents: '100000000', requests: 2, unknownCostRequests: 1 }],
      [{ provider: 'openai,"inc', model: 'gpt-5.4', requests: 2, savingsMicrocents: '100000000' }],
    )).toContain('actual_costs_qualified,false');
    expect(buildSavingsReceiptCsv(
      { month: 'August 2026', totalRequests: 1, totalOriginalMicrocents: '100000000', totalActualMicrocents: '100000000', totalBilledMicrocents: '100000000', totalSavingsMicrocents: '0', unknownCostRequests: 0, actualCostsQualified: true },
      [],
      [],
    )).toContain('total_original_usd,$1.00');
    expect(buildSavingsReceiptCsv(
      { month: 'August 2026', totalRequests: 1, totalOriginalMicrocents: '400000', totalActualMicrocents: '400000', totalBilledMicrocents: '400000', totalSavingsMicrocents: '400000', unknownCostRequests: 0, actualCostsQualified: true },
      [],
      [],
    )).toContain('total_savings_usd,$0.0040');
  });
});

describe('savings receipt GET route', () => {
  it('returns a scoped CSV receipt with no-store headers and qualified-cost metadata', async () => {
    h.query
      .mockResolvedValueOnce({ rows: [{ total_requests: '2', total_original_microcents: '200000000', total_actual_microcents: '100000000', total_billed_microcents: '100000000', total_savings_microcents: '100000000', unknown_cost_requests: '1' }] })
      .mockResolvedValueOnce({ rows: [{ day: '2026-08-01', original_microcents: '200000000', actual_microcents: '100000000', savings_microcents: '100000000', requests: '2', unknown_cost_requests: '1' }] })
      .mockResolvedValueOnce({ rows: [{ provider: 'openai', model: 'gpt-5.4', requests: '2', savings_microcents: '100000000' }] });

    const response = await GET(new Request('https://app.test/api/metrics/savings-receipt?month=2026-08'));
    const csv = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="savings-receipt-2026-08.csv"');
    expect(csv).toContain('actual_costs_qualified,false');
    expect(csv).toContain('total_savings_usd,$1.00');
    expect(csv).not.toContain('request_id');
    expect(h.query).toHaveBeenCalledTimes(3);
    for (const [sql, params] of h.query.mock.calls) {
      expect(sql).toContain('team_id = $1');
      expect(sql).toContain('timestamp >= $2');
      expect(sql).toContain('timestamp < $3');
      expect(params).toEqual(['team_1', new Date(Date.UTC(2026, 7, 1)), new Date(Date.UTC(2026, 8, 1))]);
    }
  });

  it('marks demo receipts in both the CSV summary and filename', async () => {
    h.isDemoActive.mockResolvedValue(true);
    h.query
      .mockResolvedValueOnce({ rows: [{ total_requests: '0', total_original_microcents: '0', total_actual_microcents: '0', total_billed_microcents: '0', total_savings_microcents: '0', unknown_cost_requests: '0' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const response = await GET(new Request('https://app.test/api/metrics/savings-receipt?month=2026-08'));

    expect(response.headers.get('content-disposition')).toBe('attachment; filename="demo-savings-receipt-2026-08.csv"');
    expect(await response.text()).toContain('summary,is_demo,true');
  });

  it('rejects unauthorized and invalid-month requests before querying', async () => {
    h.member = null;
    h.requireTeamMembership.mockResolvedValue(null);
    const unauthorized = await GET(new Request('https://app.test/api/metrics/savings-receipt?month=2026-08'));
    expect(unauthorized.status).toBe(401);
    expect(h.query).not.toHaveBeenCalled();

    h.member = { userId: 'user_1', teamId: 'team_1', role: 'admin' };
    h.requireTeamMembership.mockResolvedValue(h.member);
    for (const month of ['', '2026-13', 'not-a-month']) {
      const response = await GET(new Request(`https://app.test/api/metrics/savings-receipt${month ? `?month=${month}` : ''}`));
      expect(response.status).toBe(400);
    }
    expect(h.query).not.toHaveBeenCalled();
  });
});
