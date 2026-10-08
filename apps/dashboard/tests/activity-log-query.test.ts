import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('@/lib/db', () => ({
  getPool: () => ({ query: h.query }),
}));

import { getActivityLogById } from '@/lib/activity-log-query';

const baseRow = {
  id: 'req_1',
  timestamp: new Date('2026-08-08T12:00:00.000Z'),
  provider: 'openai',
  model_requested: 'gpt-5.5-pro',
  model_resolved: 'gpt-5.5',
  input_tokens: 100,
  output_tokens: 20,
  total_tokens: 120,
  original_cost_microcents: 500,
  actual_cost_microcents: 300,
  actual_cost_known: true,
  plugin_cost_microcents: 0,
  billed_cost_microcents: 300,
  savings_microcents: 200,
  total_latency_ms: 180,
  ttft_ms: 70,
  is_streaming: true,
  is_fallback: false,
  fallback_attempts: '[]',
  plugin_warnings: '[]',
  status_code: 200,
  error_type: null,
  cache_hit: false,
  activity_category: 'coding',
  session_id: 'sess_1',
  api_key_id: 'key_1',
};

beforeEach(() => {
  h.query.mockReset();
});

describe('getActivityLogById', () => {
  it('looks up a generation by ID and effective team', async () => {
    h.query.mockResolvedValueOnce({ rows: [baseRow] });

    const result = await getActivityLogById('req_1', 'team_a');

    expect(result).toMatchObject({
      id: 'req_1',
      timestamp: '2026-08-08T12:00:00.000Z',
      provider: 'openai',
      session_id: 'sess_1',
    });
    expect(h.query).toHaveBeenCalledWith(
      expect.stringContaining('id = $1 AND team_id = $2'),
      ['req_1', 'team_a'],
    );
  });

  it('returns null for an empty result without probing by ID alone', async () => {
    h.query.mockResolvedValueOnce({ rows: [] });

    await expect(getActivityLogById('missing', 'team_a')).resolves.toBeNull();
    expect(h.query.mock.calls[0]?.[0]).toContain('WHERE id = $1 AND team_id = $2');
    expect(h.query).toHaveBeenCalledTimes(1);
  });

  it('normalizes warning JSON and preserves unknown cost qualification', async () => {
    h.query.mockResolvedValueOnce({
      rows: [{
        ...baseRow,
        id: 'req_unknown',
        actual_cost_known: false,
        plugin_warnings: JSON.stringify([
          { plugin: 'web', code: 'skipped', reason: 'unconfigured', message: 'No backend' },
          { plugin: 'malformed' },
        ]),
      }],
    });

    const result = await getActivityLogById('req_unknown', 'team_a');

    expect(result?.actual_cost_known).toBe(false);
    expect(result?.plugin_warnings).toEqual([
      { plugin: 'web', code: 'skipped', reason: 'unconfigured', message: 'No backend' },
    ]);
  });
});
