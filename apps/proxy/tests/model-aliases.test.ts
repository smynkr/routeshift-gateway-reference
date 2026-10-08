// LAY-318: per-team model alias resolver.

import { describe, expect, it, beforeEach, vi } from 'vitest';

const mockQuery = vi.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>();
vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({ query: mockQuery }),
}));

import { resolveAlias, invalidateAliasCache } from '../src/routing/model-aliases.js';

beforeEach(() => {
  mockQuery.mockReset();
  invalidateAliasCache();
});

describe('resolveAlias', () => {
  it('returns the canonical name when an alias is registered', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ alias: 'myorg-gpt5', canonical_name: 'gpt-5' }],
    });
    expect(await resolveAlias('team_a', 'myorg-gpt5')).toBe('gpt-5');
  });

  it('returns the input unchanged when no alias matches', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await resolveAlias('team_a', 'gpt-5')).toBe('gpt-5');
  });

  it('caches the alias map per team — second call hits no DB', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ alias: 'myorg-gpt5', canonical_name: 'gpt-5' }],
    });
    await resolveAlias('team_a', 'myorg-gpt5');
    await resolveAlias('team_a', 'myorg-gpt5');
    await resolveAlias('team_a', 'unknown-model');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('invalidateAliasCache(teamId) forces a reload on next call', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ alias: 'myorg-gpt5', canonical_name: 'gpt-5' }],
      })
      .mockResolvedValueOnce({
        rows: [{ alias: 'myorg-gpt5', canonical_name: 'gpt-4.1' }],
      });
    expect(await resolveAlias('team_a', 'myorg-gpt5')).toBe('gpt-5');
    invalidateAliasCache('team_a');
    expect(await resolveAlias('team_a', 'myorg-gpt5')).toBe('gpt-4.1');
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('different teams have independent caches', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ alias: 'pet', canonical_name: 'gpt-5' }] })
      .mockResolvedValueOnce({ rows: [{ alias: 'pet', canonical_name: 'claude-opus-4-6' }] });
    expect(await resolveAlias('team_a', 'pet')).toBe('gpt-5');
    expect(await resolveAlias('team_b', 'pet')).toBe('claude-opus-4-6');
  });
});
