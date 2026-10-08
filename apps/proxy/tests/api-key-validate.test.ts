import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({ query: mocks.query }),
}));

import { clearKeyCache, hashApiKey, invalidateKeyCache, validateApiKey } from '../src/auth/api-key.js';

describe('validateApiKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearKeyCache();
    mocks.query.mockResolvedValue({ rows: [] });
  });

  it('returns null when API key is not found', async () => {
    const result = await validateApiKey('sk-proxy-live_team_deadbeef');

    expect(result).toBeNull();
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM api_keys'),
      [hashApiKey('sk-proxy-live_team_deadbeef')],
    );
  });

  it('returns mapped key info and caches successful lookups', async () => {
    const row = {
      id: 'k1',
      team_id: 'team_1',
      allowed_models: ['gpt-4o-mini'],
      rate_limit_override: { requests_per_minute: 60 },
    };
    mocks.query
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] }); // async last_used update

    const first = await validateApiKey('sk-proxy-live_team_cached');
    const second = await validateApiKey('sk-proxy-live_team_cached');

    expect(first).toEqual({
      id: 'k1',
      teamId: 'team_1',
      allowedModels: ['gpt-4o-mini'],
      rateLimitOverride: { requests_per_minute: 60 },
      // Rows without a metadata column normalize to {}.
      metadata: {},
      // RSH-146: unbound keys normalize to null preset fields.
      presetSlug: null,
      presetVersion: null,
    });
    expect(second).toEqual(first);

    // Only one SELECT call should happen; second call is cache hit.
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query).toHaveBeenNthCalledWith(
      2,
      'UPDATE api_keys SET last_used = now() WHERE id = $1',
      ['k1'],
    );
  });

  it('allows explicit cache invalidation', async () => {
    const key = 'sk-proxy-live_team_to_invalidate';
    const hash = hashApiKey(key);

    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: 'k1', team_id: 'team_1', allowed_models: null, rate_limit_override: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'k1', team_id: 'team_1', allowed_models: null, rate_limit_override: null }] })
      .mockResolvedValueOnce({ rows: [] });

    await validateApiKey(key);
    invalidateKeyCache(hash);
    await validateApiKey(key);

    // Two SELECT lookups because cache entry was invalidated between calls.
    expect(mocks.query).toHaveBeenCalledTimes(4);
  });

  it('logs when last_used update fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: 'k_err', team_id: 'team_1', allowed_models: null, rate_limit_override: null }] })
      .mockRejectedValueOnce(new Error('update failed'));

    await validateApiKey('sk-proxy-live_team_error');
    await Promise.resolve();

    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to update last_used for key:',
      'k_err',
      expect.any(Error),
    );

    errorSpy.mockRestore();
  });

  it('RSH-86: throws AuthInfrastructureError on DB connection failure (not false 401)', async () => {
    const { AuthInfrastructureError } = await import('../src/auth/api-key.js');
    // Simulate a DB connection failure during the SELECT query.
    mocks.query.mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));

    const promise = validateApiKey('sk-proxy-live_team_dbfail');
    await expect(promise).rejects.toThrow(AuthInfrastructureError);
  });
});
