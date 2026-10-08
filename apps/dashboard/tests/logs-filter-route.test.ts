import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  query: vi.fn(),
  member: { userId: 'user_1', teamId: 'team_1', role: 'admin' },
}));

vi.mock('@/lib/rbac', () => ({
  requireTeamMembership: () => Promise.resolve(h.member),
}));
vi.mock('@/lib/demo', () => ({
  getEffectiveTeamId: (teamId: string) => Promise.resolve(teamId),
}));
vi.mock('@/lib/db', () => ({
  getPool: () => ({ query: h.query }),
}));

import { GET } from '@/app/api/logs/route';

beforeEach(() => {
  h.query.mockReset()
    .mockResolvedValueOnce({ rows: [{ total: 0 }] })
    .mockResolvedValueOnce({ rows: [] });
});

describe('logs exact resolved-model filter', () => {
  it('keeps manual substring matching separate from an exact resolved-model predicate', async () => {
    const response = await GET(new Request(
      'https://app.test/api/logs?provider=openai&model=gpt-5&resolved_model=%20gpt-5.4%20&page=1&limit=50',
    ));

    expect(response.status).toBe(200);
    const [countSql, countParams] = h.query.mock.calls[0]!;
    expect(countSql).toContain('model_requested ILIKE $3');
    expect(countSql).toContain('model_resolved = $4');
    expect(countSql).toContain('model_resolved ILIKE $3');
    expect(countParams).toEqual(['team_1', 'openai', '%gpt-5%', 'gpt-5.4']);
  });

  it('omits blank exact resolved-model values without querying a filter', async () => {
    const response = await GET(new Request('https://app.test/api/logs?resolved_model=%20%20%20'));

    expect(response.status).toBe(200);
    expect(h.query.mock.calls[0]?.[1]).toEqual(['team_1']);
    expect(String(h.query.mock.calls[0]?.[0])).not.toContain('model_resolved = $2');
  });

  it('rejects an oversized exact resolved-model value before querying', async () => {
    const response = await GET(new Request(`https://app.test/api/logs?resolved_model=${'x'.repeat(201)}`));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid activity filters' });
    expect(h.query).not.toHaveBeenCalled();
  });

  it('treats blank recognized filters as omitted and still queries unfiltered logs', async () => {
    const response = await GET(new Request(
      'https://app.test/api/logs?provider=%20%20&model=%20%20&resolved_model=%20%20&status=%20%20&category=%20%20&api_key_id=%20%20&session=%20%20&from=%20%20&to=%20%20',
    ));

    expect(response.status).toBe(200);
    expect(h.query.mock.calls[0]?.[1]).toEqual(['team_1']);
    expect(h.query.mock.calls[0]?.[0]).toBe('SELECT COUNT(*)::int AS total FROM request_logs WHERE team_id = $1');
  });

  it('normalizes valid filters and honors the first duplicate value', async () => {
    const response = await GET(new Request(
      'https://app.test/api/logs?provider=openai&provider=anthropic&model=%20gpt-5%20&resolved_model=%20gpt-5.4%20&status=error&category=%20coding%20&api_key_id=%20key_1%20&session=%20sess_1%20&from=2026-08-20T00:00:00Z&to=2026-08-26T00:00:00Z&page=2&limit=20',
    ));

    expect(response.status).toBe(200);
    const [countSql, countParams] = h.query.mock.calls[0]!;
    expect(countSql).toContain('provider = $2');
    expect(countSql).toContain('model_requested ILIKE $3');
    expect(countSql).toContain('model_resolved = $4');
    expect(countSql).toContain('activity_category = $5');
    expect(countSql).toContain('api_key_id = $6');
    expect(countSql).toContain('session_id = $7');
    expect(countSql).toContain('timestamp >= $8');
    expect(countSql).toContain('timestamp <= $9');
    expect(countParams).toEqual([
      'team_1',
      'openai',
      '%gpt-5%',
      'gpt-5.4',
      'coding',
      'key_1',
      'sess_1',
      '2026-08-20T00:00:00.000Z',
      '2026-08-26T00:00:00.000Z',
    ]);
  });

  it('rejects poison, oversized, invalid, and reversed filters before SQL construction', async () => {
    const params = new URLSearchParams({
      provider: 'poison',
      model: 'x'.repeat(201),
      resolved_model: 'x'.repeat(201),
      status: '500',
      category: 'poison',
      api_key_id: 'x'.repeat(257),
      session: 'x'.repeat(257),
      from: '2026-08-27T00:00:00Z',
      to: '2026-08-26T00:00:00Z',
    });
    const response = await GET(new Request(`https://app.test/api/logs?${params}`));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid activity filters' });
    expect(h.query).not.toHaveBeenCalled();
  });
});
