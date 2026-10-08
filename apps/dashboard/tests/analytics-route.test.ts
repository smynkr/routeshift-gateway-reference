import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  member: { userId: 'user_1', teamId: 'team_1', role: 'admin' } as {
    userId: string;
    teamId: string;
    role: string;
  } | null,
  requireTeamMembership: vi.fn(),
  getEffectiveTeamId: vi.fn(),
  query: vi.fn(),
}));

vi.mock('@/lib/rbac', () => ({
  requireTeamMembership: h.requireTeamMembership,
}));
vi.mock('@/lib/demo', () => ({
  getEffectiveTeamId: h.getEffectiveTeamId,
}));
vi.mock('@/lib/db', () => ({
  getPool: () => ({ query: h.query }),
}));

import { GET } from '@/app/api/metrics/analytics/route';

const emptyRows = { rows: [] };

function seedAnalyticsQueries(reasoningRows: unknown[]) {
  h.query
    .mockResolvedValueOnce({
      rows: [{
        from: new Date('2026-08-19T12:00:00.000Z'),
        to: '2026-08-26T12:00:00.000Z',
      }],
    })
    .mockResolvedValueOnce({ rows: [{
      model: 'o1-mini',
      provider: 'openai',
      requests: '4',
      total_cost: '125000',
      billed_cost: '125000',
      total_savings: '0',
      unknown_cost_requests: '0',
      avg_latency_ms: '100',
      total_tokens: '500',
    }] })
    .mockResolvedValueOnce({ rows: [{
      provider: 'openai',
      requests: '4',
      total_cost: '125000',
      billed_cost: '125000',
      total_savings: '0',
      unknown_cost_requests: '0',
      avg_latency_ms: '100',
      p95_latency_ms: '150',
      error_rate: '0',
      cache_hits: '0',
    }] })
    .mockResolvedValueOnce({ rows: [{
      day: '2026-08-08',
      cost: '125000',
      billed_cost: '125000',
      original_cost: '125000',
      savings: '0',
      unknown_cost_requests: '0',
      requests: '4',
      cache_hits: '0',
    }] })
    .mockResolvedValueOnce(emptyRows)
    .mockResolvedValueOnce({ rows: [{ total: '4', hits: '0', cache_savings: '0' }] })
    .mockResolvedValueOnce({ rows: reasoningRows });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-26T12:00:00.000Z'));
  h.member = { userId: 'user_1', teamId: 'team_1', role: 'admin' };
  h.requireTeamMembership.mockReset().mockResolvedValue(h.member);
  h.getEffectiveTeamId.mockReset().mockImplementation(async (teamId: string | null | undefined) => teamId);
  h.query.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('analytics GET route', () => {
  it('aggregates reasoning by model with scoped period parameters and numeric mapping', async () => {
    seedAnalyticsQueries([
      {
        provider: 'openai',
        model: 'o1-mini',
        requests: 4,
        reasoning_token_requests: 2,
        reasoning_tokens: '100',
        output_tokens: '400',
        reasoning_output_share: '0.25',
        reasoning_cost_microcents: '125000',
        unknown_reasoning_cost_requests: 1,
      },
      {
        provider: 'anthropic',
        model: 'claude-3-7-sonnet',
        requests: '2',
        reasoning_token_requests: '0',
        reasoning_tokens: '0',
        output_tokens: '0',
        reasoning_output_share: null,
        reasoning_cost_microcents: '0',
        unknown_reasoning_cost_requests: '0',
      },
      {
        provider: 'google',
        model: 'gemini-2.5-pro',
        requests: '1',
        reasoning_token_requests: '1',
        reasoning_tokens: '0',
        output_tokens: '400',
        reasoning_output_share: '0',
        reasoning_cost_microcents: '0',
        unknown_reasoning_cost_requests: '0',
      },
    ]);

    const response = await GET(new Request('https://app.test/api/metrics/analytics'));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.range).toEqual({
      from: '2026-08-19T12:00:00.000Z',
      to: '2026-08-26T12:00:00.000Z',
    });
    expect(payload.reasoning_by_model).toEqual([
      {
        provider: 'openai',
        model: 'o1-mini',
        requests: 4,
        reasoning_token_requests: 2,
        reasoning_tokens: 100,
        output_tokens: 400,
        reasoning_output_share: 0.25,
        reasoning_cost_microcents: 125000,
        unknown_reasoning_cost_requests: 1,
      },
      {
        provider: 'anthropic',
        model: 'claude-3-7-sonnet',
        requests: 2,
        reasoning_token_requests: 0,
        reasoning_tokens: 0,
        output_tokens: 0,
        reasoning_output_share: null,
        reasoning_cost_microcents: 0,
        unknown_reasoning_cost_requests: 0,
      },
      {
        provider: 'google',
        model: 'gemini-2.5-pro',
        requests: 1,
        reasoning_token_requests: 1,
        reasoning_tokens: 0,
        output_tokens: 400,
        reasoning_output_share: 0,
        reasoning_cost_microcents: 0,
        unknown_reasoning_cost_requests: 0,
      },
    ]);
    const expectedParams = [
      'team_1',
      '2026-08-19T12:00:00.000Z',
      '2026-08-26T12:00:00.000Z',
    ];
    expect(h.query).toHaveBeenCalledTimes(7);
    const rangeAnchorCall = h.query.mock.calls[0];
    expect(rangeAnchorCall?.[0]).toContain('NOW()');
    expect(rangeAnchorCall?.[1]).toEqual([168]);
    for (const call of h.query.mock.calls.slice(1)) {
      expect(call[1]).toEqual(expectedParams);
      expect(call[0]).toContain('timestamp >= $2');
      expect(call[0]).toContain('timestamp <= $3');
      expect(call[0]).not.toContain('NOW()');
    }

    const reasoningCall = h.query.mock.calls[6];
    expect(reasoningCall?.[0]).toContain('team_id = $1');
    expect(reasoningCall?.[0]).toContain('COUNT(*)::int AS requests');
    expect(reasoningCall?.[0]).toContain('COUNT(reasoning_tokens)');
    expect(reasoningCall?.[0]).toContain('reasoning_cost_microcents IS NULL');
    expect(reasoningCall?.[0]).toContain('GROUP BY provider, model_resolved');
    expect(reasoningCall?.[0]).toContain('ORDER BY reasoning_tokens DESC, requests DESC');
    expect(h.requireTeamMembership).toHaveBeenCalledTimes(1);
    expect(h.getEffectiveTeamId).toHaveBeenCalledWith('team_1');
  });
  it('rejects an unsupported period before querying request logs', async () => {
    const response = await GET(new Request('https://app.test/api/metrics/analytics?period=90d'));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid period' });
    expect(h.query).not.toHaveBeenCalled();
  });

  it('keeps reasoning cost unknown when all reported reasoning rows lack pricing', async () => {
    seedAnalyticsQueries([
      {
        provider: 'openai',
        model: 'o1-mini',
        requests: 2,
        reasoning_token_requests: 2,
        reasoning_tokens: '100',
        output_tokens: '400',
        reasoning_output_share: '0.25',
        reasoning_cost_microcents: null,
        unknown_reasoning_cost_requests: 2,
      },
    ]);

    const response = await GET(new Request('https://app.test/api/metrics/analytics'));
    const payload = await response.json();
    const reasoningCall = h.query.mock.calls[6];

    expect(response.status).toBe(200);
    expect(payload.reasoning_by_model[0].reasoning_cost_microcents).toBeNull();
    expect(reasoningCall?.[0]).toContain('SUM(output_tokens) FILTER (WHERE reasoning_tokens IS NOT NULL)');
    expect(reasoningCall?.[0]).toContain('SUM(reasoning_cost_microcents)::bigint');
  });

  it('keeps unauthorized analytics requests out of the database', async () => {
    h.member = null;
    h.requireTeamMembership.mockResolvedValue(null);

    const response = await GET(new Request('https://app.test/api/metrics/analytics'));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expect(h.getEffectiveTeamId).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
  });
});
