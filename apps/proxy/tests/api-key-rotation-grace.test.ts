import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({ query: mocks.query }),
}));

import { clearKeyCache, validateApiKey } from '../src/auth/api-key.js';

describe('validateApiKey: rotation_grace_until predicate (LAY-339)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearKeyCache();
  });

  it('SELECT predicate filters out keys past the grace window', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await validateApiKey('sk-proxy-live_team_xxx');
    const sql = mocks.query.mock.calls[0]?.[0] as string;
    expect(sql).toContain('ak.rotation_grace_until IS NULL OR ak.rotation_grace_until > now()');
  });

  it('returns key info when no rotation in progress (column NULL — DB filter satisfies the OR branch)', async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [{ id: 'k1', team_id: 't1', allowed_models: null, rate_limit_override: null }],
      })
      .mockResolvedValueOnce({ rows: [] });
    const info = await validateApiKey('sk-proxy-live_team_active');
    expect(info?.id).toBe('k1');
  });
});
